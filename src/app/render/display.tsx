import { useFrame, useThree } from '@react-three/fiber';
import { type ReactNode, createContext, useContext, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { jitterPattern } from './jitter';
import { sceneFromDisplay } from './toneMap';

export { SCENE_FROM_DISPLAY_GLSL } from './toneMap';

/*
 * The frame is drawn in two kinds of light, as in the offline renderer (routereplay radiometry.py):
 *
 * - Scene light: the stars, the Moon, the ground, clouds, air, and aircraft. Everything with an opaque material is
 *   drawn into a half-float target in linear light, where layers blend as light does: clouds over the ground, and the
 *   air's in-scattered light added over what its transmittance lets through, colour by colour. One exposure, one
 *   per-channel Reinhard shoulder, and the sRGB encoding then turn it into the frame (the tone-map pass).
 * - Graphics: labels, markers, route lines, the Sun's disc and glare, the vehicles, the aircraft's lamps and propeller
 *   discs, and the homepage's button. Everything with a transparent material is drawn after the tone-map pass, straight
 *   into the frame (where three.js still tone maps the materials that ask for it, as before), as the offline
 *   renderer adds labels and routes after its display transform. The tone-map pass restores the scene's depth, so the
 *   aircraft still hides markers and routes, and the Earth still hides the setting Sun.
 *
 * That split is three.js's own: it draws every opaque object before every transparent one, so the order of the two
 * lists, and so every depth relationship, is what it was when each layer was tone mapped on its own.
 *
 * Without colour-renderable half floats (EXT_color_buffer_float) the frame is drawn as before: straight to the
 * canvas, each layer tone mapped before blending, and the air's transmittance as one grey value.
 *
 * With `samples` above 1 (exports, and previews asked for it with ?samples), the scene light is drawn that many
 * times at the same moment with sub-pixel camera offsets (jitter.ts). Each is tone mapped and added, at 1/N, into
 * one more half-float target; that average is encoded once. The centre sample is drawn last, so its depth is the one
 * restored for the graphics, which are drawn once, unjittered. One sample is the path above, unchanged.
 */

/** True inside a frame drawn in linear light. */
const LinearContext = createContext(false);

/** Whether this canvas's scene is drawn in linear light and tone mapped once (otherwise each layer is). */
export function useLinearScene(): boolean {
  return useContext(LinearContext);
}

/**
 * Shader defines for scene light drawn in this canvas: LINEAR_SCENE in linear light. The air and clouds take some of
 * their light from it (AIR_GLSL's SUN_ABOVE_AIR, the clouds' brightness), since drawn straight to the frame they keep
 * the values they were tuned with there.
 */
export function sceneDefines(linear: boolean): Record<string, string> {
  return linear ? { LINEAR_SCENE: '' } : {};
}

/**
 * Samples for the scene's half-float target, or null when the context can't render half floats. Matches the canvas's
 * own antialiasing (4 samples where the format allows), so edges look as they did on the canvas.
 */
function linearSamples(renderer: THREE.WebGLRenderer): number | null {
  // ?display-referred draws the frame the old way, for comparisons.
  if (new URLSearchParams(location.search).has('display-referred')) return null;
  const gl = renderer.getContext();
  if (!(gl instanceof WebGL2RenderingContext)) return null;
  if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) return null;
  let samples = 0;
  if (gl.getContextAttributes()?.antialias) {
    const supported = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA16F, gl.SAMPLES) as Int32Array | null;
    samples = Math.min(4, supported?.[0] ?? 0);
  }
  // Confirm the format is complete here, rather than trusting the extension alone.
  const fb = gl.createFramebuffer();
  const rb = gl.createRenderbuffer();
  const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  const previousRb = gl.getParameter(gl.RENDERBUFFER_BINDING) as WebGLRenderbuffer | null;
  gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
  if (samples > 0) gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA16F, 4, 4);
  else gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA16F, 4, 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
  const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
  gl.bindRenderbuffer(gl.RENDERBUFFER, previousRb);
  gl.deleteFramebuffer(fb);
  gl.deleteRenderbuffer(rb);
  while (gl.getError() !== gl.NO_ERROR); // a refused format leaves an error behind; three.js checks for its own
  return complete ? samples : null;
}

/**
 * For display-referred things drawn among the scene's light (the stars and the Moon, behind the air): the uniform that
 * SCENE_FROM_DISPLAY_GLSL reads, kept current by displayReferred(). They then come out of the tone-map pass with the
 * display values they had when they skipped tone mapping, and are dimmed only by the air in front of them.
 */
export function sceneFromDisplayUniforms(): Record<string, THREE.IUniform> {
  return { displayExposure: { value: 0 } };
}

/** Keep a material's `displayExposure` current: the frame's exposure while it draws into linear light, else 0. */
export function displayReferred<M extends THREE.ShaderMaterial>(material: M): M {
  material.onBeforeRender = (renderer) => {
    material.uniforms.displayExposure!.value = renderer.getRenderTarget() ? Math.max(renderer.toneMappingExposure, 1e-3) : 0;
  };
  return material;
}

/** Linear light to the frame: exposure, per-channel Reinhard, and sRGB (three.js's own chunks), plus the depth. */
const toneMapVertex = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const toneMapFragment = /* glsl */ `
uniform sampler2D light;
uniform sampler2D depth;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  gl_FragColor = vec4(texelFetch(light, p, 0).rgb, 1.0);
  gl_FragDepth = texelFetch(depth, p, 0).r;
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** One triangle covering the frame. */
function fullScreenTriangle(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  return g;
}

interface Pipeline {
  target: THREE.WebGLRenderTarget;
  quad: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  quadCamera: THREE.Camera;
  dispose(): void;
}

function createPipeline(samples: number): Pipeline {
  const target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    samples,
    depthBuffer: true,
    depthTexture: new THREE.DepthTexture(1, 1),
    // The tone-map pass reads the resolved depth; nothing reads the multisampled one afterwards.
    resolveDepthBuffer: true,
    storeMultisampledDepthBuffer: false,
  });
  target.texture.minFilter = target.texture.magFilter = THREE.NearestFilter;
  target.texture.generateMipmaps = false;
  const material = new THREE.ShaderMaterial({
    uniforms: { light: { value: target.texture }, depth: { value: target.depthTexture } },
    vertexShader: toneMapVertex,
    fragmentShader: toneMapFragment,
    // Writes every pixel's depth, so the graphics drawn next are hidden where the scene is in front of them.
    depthFunc: THREE.AlwaysDepth,
    depthWrite: true,
  });
  const quad = new THREE.Mesh(fullScreenTriangle(), material);
  quad.frustumCulled = false;
  return {
    target,
    quad,
    quadCamera: new THREE.Camera(),
    dispose() {
      target.depthTexture?.dispose();
      target.dispose();
      quad.geometry.dispose();
      material.dispose();
    },
  };
}

/**
 * One jittered sample of scene light, tone mapped (three.js's Reinhard, as tonemapping_fragment applies it) and
 * weighted 1/N, added into the average. Still linear display values: the sRGB encoding comes once, after.
 */
const accumulateFragment = /* glsl */ `
uniform sampler2D light;
uniform float exposure;
uniform float weight;
void main() {
  vec3 c = texelFetch(light, ivec2(gl_FragCoord.xy), 0).rgb * exposure;
  gl_FragColor = vec4(weight * clamp(c / (vec3(1.0) + c), 0.0, 1.0), weight);
}
`;

/** The average of the samples to the frame: the sRGB encoding, and the centre sample's depth. */
const encodeFragment = /* glsl */ `
uniform sampler2D display;
uniform sampler2D depth;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  gl_FragColor = vec4(texelFetch(display, p, 0).rgb, 1.0);
  gl_FragDepth = texelFetch(depth, p, 0).r;
  #include <colorspace_fragment>
}
`;

interface Accumulation {
  target: THREE.WebGLRenderTarget;
  accumulate: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  encode: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  dispose(): void;
}

/** The average's half-float target (one more, the size of the frame, without depth or multisampling) and its passes. */
function createAccumulation(pipeline: Pipeline): Accumulation {
  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false });
  target.texture.minFilter = target.texture.magFilter = THREE.NearestFilter;
  target.texture.generateMipmaps = false;
  const geometry = fullScreenTriangle();
  const accumulateMaterial = new THREE.ShaderMaterial({
    uniforms: { light: { value: pipeline.target.texture }, exposure: { value: 1 }, weight: { value: 1 } },
    vertexShader: toneMapVertex,
    fragmentShader: accumulateFragment,
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneFactor,
    toneMapped: false,
  });
  const encodeMaterial = new THREE.ShaderMaterial({
    uniforms: { display: { value: target.texture }, depth: { value: pipeline.target.depthTexture } },
    vertexShader: toneMapVertex,
    fragmentShader: encodeFragment,
    depthFunc: THREE.AlwaysDepth,
    depthWrite: true,
    // Already tone mapped, sample by sample.
    toneMapped: false,
  });
  const accumulate = new THREE.Mesh(geometry, accumulateMaterial);
  const encode = new THREE.Mesh(geometry, encodeMaterial);
  accumulate.frustumCulled = encode.frustumCulled = false;
  return {
    target,
    accumulate,
    encode,
    dispose() {
      target.dispose();
      geometry.dispose();
      accumulateMaterial.dispose();
      encodeMaterial.dispose();
    },
  };
}

/**
 * Show only scene light (opaque materials) or only graphics (transparent ones) on the next render, by material
 * visibility; `restore` puts every material back as it was.
 */
class Split {
  private readonly saved = new Map<THREE.Material, boolean>();

  show(scene: THREE.Scene, graphics: boolean): void {
    scene.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (!m) return;
      for (const material of Array.isArray(m) ? m : [m]) {
        let visible = this.saved.get(material);
        if (visible === undefined) this.saved.set(material, (visible = material.visible));
        material.visible = visible && material.transparent === graphics;
      }
    });
  }

  restore(): void {
    for (const [material, visible] of this.saved) material.visible = visible;
    this.saved.clear();
  }
}

interface Tools {
  split: Split;
  size: THREE.Vector2;
  clear: THREE.Color;
  black: THREE.Color;
  projection: THREE.Matrix4;
  inverse: THREE.Matrix4;
}

/**
 * The scene light drawn once per offset, with the image shifted by that many pixels, each tone mapped and added at
 * 1/N into the average; then the average encoded into the canvas with the last (centre) sample's depth.
 */
function drawSamples(
  tools: Tools,
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  { target, quadCamera }: Pipeline,
  { target: average, accumulate, encode }: Accumulation,
  offsets: readonly (readonly [number, number])[],
  exposure: number,
) {
  const { x: width, y: height } = tools.size;
  if (average.width !== width || average.height !== height) average.setSize(width, height);
  const u = accumulate.material.uniforms;
  u.exposure!.value = exposure;
  u.weight!.value = 1 / offsets.length;
  renderer.setRenderTarget(average);
  renderer.setClearColor(tools.black, 0);
  renderer.clear(true, false, false);
  tools.split.show(scene, false);
  const projection = tools.projection.copy(camera.projectionMatrix);
  const inverse = tools.inverse.copy(camera.projectionMatrixInverse);
  const matrices = scene.matrixWorldAutoUpdate;
  const shadows = renderer.shadowMap.autoUpdate;
  try {
    for (const [x, y] of offsets) {
      // Shift the image by (x, y) pixels: a translation in clip space, after the projection.
      camera.projectionMatrix.makeTranslation((2 * x) / width, (2 * y) / height, 0).multiply(projection);
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      renderer.setRenderTarget(target);
      renderer.setClearColor(tools.clear, 1);
      renderer.clear(true, true, true);
      renderer.render(scene, camera);
      // The world matrices and shadow maps are the same for every sample: the first one updated them.
      scene.matrixWorldAutoUpdate = false;
      renderer.shadowMap.autoUpdate = false;
      renderer.setRenderTarget(average);
      renderer.render(accumulate, quadCamera);
    }
  } finally {
    camera.projectionMatrix.copy(projection);
    camera.projectionMatrixInverse.copy(inverse);
    scene.matrixWorldAutoUpdate = matrices;
    renderer.shadowMap.autoUpdate = shadows;
  }
  // Encode the average into the canvas, with the centre sample's depth (drawn last).
  renderer.setRenderTarget(null);
  renderer.clear(true, true, true);
  renderer.render(encode, quadCamera);
}

/**
 * Draws its children's scene in linear light and tone maps it once (see above). `background` is the empty sky's
 * display colour, which stays the same at every exposure. `samples`: jittered samples of the scene light per frame
 * (1 draws it once). Takes over the canvas's rendering, so it must be the only component that renders.
 */
export function LinearDisplay({ background, samples = 1, children }: { background: string; samples?: number; children: ReactNode }) {
  const gl = useThree((s) => s.gl);
  const msaa = useMemo(() => linearSamples(gl), [gl]);
  const pipeline = useMemo(() => (msaa === null ? null : createPipeline(msaa)), [msaa]);
  useEffect(() => () => pipeline?.dispose(), [pipeline]);
  // Jittered samples need the half-float target; without it the frame is drawn once, as before.
  const jittered = pipeline !== null && samples > 1;
  const jitter = useMemo(() => jitterPattern(jittered ? samples : 1), [jittered, samples]);
  const accumulation = useMemo(() => (pipeline && jittered ? createAccumulation(pipeline) : null), [pipeline, jittered]);
  useEffect(() => () => accumulation?.dispose(), [accumulation]);
  const sky = useMemo(() => new THREE.Color(background), [background]);
  const tools = useMemo<Tools>(
    () => ({
      split: new Split(),
      size: new THREE.Vector2(),
      clear: new THREE.Color(),
      black: new THREE.Color(0, 0, 0),
      projection: new THREE.Matrix4(),
      inverse: new THREE.Matrix4(),
    }),
    [],
  );

  useFrame(({ gl: renderer, scene, camera }) => {
    const background = scene.background;
    const autoClear = renderer.autoClear;
    scene.background = null;
    renderer.autoClear = false;
    try {
      if (!pipeline) {
        // Each layer tone mapped on its own, straight to the canvas.
        renderer.setRenderTarget(null);
        renderer.setClearColor(sky, 1);
        renderer.clear(true, true, true);
        renderer.render(scene, camera);
        return;
      }
      const { target, quad, quadCamera } = pipeline;
      renderer.getDrawingBufferSize(tools.size);
      if (target.width !== tools.size.x || target.height !== tools.size.y) target.setSize(tools.size.x, tools.size.y);

      // Scene light. The empty sky is cleared to the light that tone maps back to its display colour (three.js keeps
      // colours linear, and clears a render target with the linear value).
      const exposure = Math.max(renderer.toneMappingExposure, 1e-3);
      const light = (display: number) => sceneFromDisplay(display, exposure);
      if (accumulation) {
        tools.clear.setRGB(light(sky.r), light(sky.g), light(sky.b), THREE.LinearSRGBColorSpace);
        drawSamples(tools, renderer, scene, camera, pipeline, accumulation, jitter, exposure);
      } else {
        renderer.setRenderTarget(target);
        renderer.setClearColor(tools.clear.setRGB(light(sky.r), light(sky.g), light(sky.b), THREE.LinearSRGBColorSpace), 1);
        renderer.clear(true, true, true);
        tools.split.show(scene, false);
        renderer.render(scene, camera);

        // Tone map into the canvas, with the scene's depth.
        renderer.setRenderTarget(null);
        renderer.clear(true, true, true);
        renderer.render(quad, quadCamera);
      }

      // Graphics, over the tone-mapped frame. The scene pass already updated the world matrices and any shadow maps.
      tools.split.show(scene, true);
      const matrices = scene.matrixWorldAutoUpdate;
      const shadows = renderer.shadowMap.autoUpdate;
      scene.matrixWorldAutoUpdate = false;
      renderer.shadowMap.autoUpdate = false;
      try {
        renderer.render(scene, camera);
      } finally {
        scene.matrixWorldAutoUpdate = matrices;
        renderer.shadowMap.autoUpdate = shadows;
      }
    } finally {
      tools.split.restore();
      scene.background = background;
      renderer.autoClear = autoClear;
    }
  }, 1);

  return <LinearContext.Provider value={pipeline !== null}>{children}</LinearContext.Provider>;
}
