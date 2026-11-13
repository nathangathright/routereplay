import { useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { LabelState, Pulse } from '../../shared/timeline/evaluate';
import { FLAP_DURATION, FLAP_STAGGER, PANEL_H, PANEL_W, PULSE_SECONDS, type Rect } from '../../shared/timeline/labels';
import { LABEL_FONT_FAMILY } from './assets';

/*
 * Airport labels as the offline renderer draws them (routereplay `scene_overlays.py`): split-flap panels of three
 * cards that turn over from blank when a label appears, a ringed dot on each airport with a faint leader line to its
 * panel, and a ring that grows from an airport on arrival. Sizes are pixels of a 1080-pixel short side (see
 * src/shared/timeline/labels.ts), scaled to the screen's. Panels are drawn over everything; the markers, leaders, and
 * pulses are drawn over the ground, clouds, and route but under the aircraft, as the offline renderer restores the
 * aircraft over them.
 */

const CARD_W = 66;
const CARD_H = 108;
const CARD_GAP = 5;
const PANEL_PAD = 6;
const HALF = CARD_H / 2;
/** All three cards have turned this long after a label appears. */
const FLAP_END = FLAP_DURATION + 2 * FLAP_STAGGER;
/** Barlow Condensed SemiBold at this size and width matches the offline renderer's DIN Condensed Bold at 100 px. */
const FLAP_FONT = `600 103px ${LABEL_FONT_FAMILY}, sans-serif`;
const FLAP_FONT_WIDTH = 0.88;
/** The accent once the aircraft has arrived; a pale blue-grey before. */
const REACHED = 'rgb(255, 169, 116)';
const AHEAD = 'rgb(171, 200, 206)';

// --- Split-flap panel, drawn in the panel's pixels (220 × 120) whatever the canvas resolution. ---

const rgb = (s: number) => `rgb(${s}, ${s + 1}, ${s + 2})`;

/** One card face (`flap_face`): dark painted metal, lighter on the upper leaf, with the letter if any. */
function drawFace(c: CanvasRenderingContext2D, letter: string) {
  c.beginPath();
  c.roundRect(0, 0, CARD_W, CARD_H, 4);
  c.fillStyle = 'rgb(16, 17, 18)';
  c.fill();
  c.beginPath();
  c.roundRect(0.5, 0.5, CARD_W - 1, CARD_H - 1, 3.5);
  c.lineWidth = 1;
  c.strokeStyle = 'rgb(67, 69, 70)';
  c.stroke();
  const upper = c.createLinearGradient(0, 2, 0, HALF);
  upper.addColorStop(0, rgb(43 - (15 * 2) / HALF));
  upper.addColorStop(1, rgb(28));
  c.fillStyle = upper;
  c.fillRect(2, 2, CARD_W - 4, HALF - 2);
  const lower = c.createLinearGradient(0, HALF, 0, CARD_H - 2);
  lower.addColorStop(0, rgb(26));
  lower.addColorStop(1, rgb(26 - (5 * (HALF - 2)) / HALF));
  c.fillStyle = lower;
  c.fillRect(2, HALF, CARD_W - 4, HALF - 2);
  if (!letter) return;
  c.save();
  c.font = FLAP_FONT;
  const m = c.measureText(letter);
  // Centre the ink, not the advance, as the offline renderer centres the glyph's bounding box.
  c.translate(CARD_W / 2, HALF);
  c.scale(FLAP_FONT_WIDTH, 1);
  c.fillStyle = 'rgb(248, 247, 241)';
  c.fillText(
    letter,
    -(m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2,
    (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2,
  );
  c.restore();
}

/** Draw a face squeezed into rows [y, y + h) of the card, from its rows [from, from + HALF). */
function drawLeaf(c: CanvasRenderingContext2D, letter: string, from: number, y: number, h: number) {
  c.save();
  c.beginPath();
  c.rect(0, y, CARD_W, h);
  c.clip();
  c.translate(0, y);
  c.scale(1, h / HALF);
  c.translate(0, -from);
  drawFace(c, letter);
  c.restore();
}

/**
 * One card `elapsed` seconds into its flip (`flap_card`): a rigid upper leaf falls about the centre axle. Its back
 * carries the incoming letter's lower half, so no unrelated letters appear.
 */
function drawCard(c: CanvasRenderingContext2D, letter: string, elapsed: number) {
  if (elapsed <= 0) drawFace(c, '');
  else if (elapsed >= FLAP_DURATION) drawFace(c, letter);
  else {
    const u = elapsed / FLAP_DURATION;
    const angle = Math.PI * (0.55 * u + 0.45 * u * u);
    const cos = Math.cos(angle);
    drawFace(c, '');
    drawLeaf(c, letter, 0, 0, HALF);
    const h = Math.max(1 / 3, HALF * Math.abs(cos));
    const y = cos >= 0 ? HALF - h : HALF;
    // The moving leaf's cast shadow, under it.
    const shadowY = cos >= 0 ? HALF + h * 0.35 : HALF + h;
    c.fillStyle = 'rgba(0, 0, 0, 0.941)';
    c.fillRect(2, shadowY, CARD_W - 4, Math.min(CARD_H, shadowY + 5) - shadowY);
    if (cos >= 0) drawLeaf(c, '', 0, y, h);
    else drawLeaf(c, letter, HALF, y, h);
    c.fillStyle = `rgba(0, 0, 0, ${Math.round(105 * Math.sin(angle)) / 255})`;
    c.fillRect(0, y, CARD_W, h);
    c.fillStyle = 'rgba(79, 80, 79, 0.902)';
    c.fillRect(2, cos >= 0 ? y : y + h - 1, CARD_W - 4, 1);
  }
  // The gap between the leaves and the hinge pins at each side.
  c.fillStyle = 'rgb(3, 4, 5)';
  c.fillRect(0, HALF - 0.5, CARD_W, 1);
  for (const x of [1, CARD_W - 3]) {
    c.beginPath();
    c.roundRect(x, HALF - 6, 2, 12, 1);
    c.fillStyle = 'rgb(94, 97, 97)';
    c.fill();
    c.fillStyle = 'rgb(161, 162, 159)';
    c.fillRect(x, HALF - 4, 1 / 3, 7);
  }
}

/** The whole panel (`split_flap_panel`) `age` seconds after the label appeared; cards start 0.11 s apart. */
function drawPanel(c: CanvasRenderingContext2D, code: string, age: number) {
  c.clearRect(0, 0, PANEL_W, PANEL_H);
  c.beginPath();
  c.roundRect(0, 0, PANEL_W, PANEL_H, 7);
  c.fillStyle = 'rgba(6, 8, 10, 0.98)';
  c.fill();
  c.beginPath();
  c.roundRect(0.5, 0.5, PANEL_W - 1, PANEL_H - 1, 6.5);
  c.lineWidth = 1;
  c.strokeStyle = 'rgb(66, 73, 76)';
  c.stroke();
  [...code].forEach((letter, j) => {
    c.save();
    c.translate(PANEL_PAD + j * (CARD_W + CARD_GAP), PANEL_PAD);
    drawCard(c, letter, age - j * FLAP_STAGGER);
    c.restore();
  });
}

/** One visit's panel texture, at the screen's resolution, redrawn only while its cards are turning. */
class FlapTexture {
  readonly canvas = document.createElement('canvas');
  texture: THREE.CanvasTexture | null = null;
  private drawn = '';

  update(code: string, age: number, pxPerRef: number): THREE.CanvasTexture {
    const w = Math.max(1, Math.round(PANEL_W * pxPerRef));
    const h = Math.max(1, Math.round(PANEL_H * pxPerRef));
    if (!this.texture || this.canvas.width !== w || this.canvas.height !== h) {
      this.texture?.dispose();
      this.canvas.width = w;
      this.canvas.height = h;
      this.texture = new THREE.CanvasTexture(this.canvas);
      this.texture.colorSpace = THREE.SRGBColorSpace;
      this.texture.premultiplyAlpha = true;
      this.drawn = '';
    }
    const key = `${code}|${age < FLAP_END ? age : 'done'}`;
    if (key !== this.drawn) {
      const c = this.canvas.getContext('2d')!;
      c.setTransform(w / PANEL_W, 0, 0, h / PANEL_H, 0, 0);
      drawPanel(c, code, Math.min(age, FLAP_END));
      this.texture.needsUpdate = true;
      this.drawn = key;
    }
    return this.texture;
  }

  dispose() {
    this.texture?.dispose();
  }
}

// --- Screen-space drawing: positions arrive in drawing-buffer pixels from the bottom left. ---

const panelVertex = /* glsl */ `
uniform vec4 rect;
uniform vec2 buffer;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(mix(rect.xy, rect.zw, uv) / buffer * 2.0 - 1.0, 0.0, 1.0);
}
`;

const panelFragment = /* glsl */ `
uniform sampler2D map;
uniform float opacity;
varying vec2 vUv;
void main() {
  // Premultiplied; fade after encoding, so a fading panel blends as the offline renderer's does.
  gl_FragColor = texture2D(map, vUv);
  #include <colorspace_fragment>
  gl_FragColor *= opacity;
}
`;

/**
 * A dot, ring, or line around the segment a–b, by its distance from it. Depth is that of the ground (just above
 * radius 1) under each pixel, so only the aircraft, which stands above it, hides the shape.
 */
const shapeVertex = /* glsl */ `
uniform vec2 a;
uniform vec2 b;
uniform float extent;
uniform vec2 buffer;
varying vec2 vPx;
void main() {
  vec2 d = b - a;
  float len = length(d);
  vec2 dir = len > 1e-3 ? d / len : vec2(1.0, 0.0);
  vec2 p = a + dir * ((position.x + 0.5) * (len + 2.0 * extent) - extent) + vec2(-dir.y, dir.x) * position.y * 2.0 * extent;
  vPx = p;
  gl_Position = vec4(p / buffer * 2.0 - 1.0, 0.0, 1.0);
}
`;

const shapeFragment = /* glsl */ `
uniform vec2 a;
uniform vec2 b;
uniform vec2 buffer;
uniform vec3 color;
uniform float fillRadius;
uniform float ringRadius;
uniform float ringHalf;
uniform float ringAlpha;
uniform float opacity;
uniform vec4 view;
varying vec2 vPx;
void main() {
  vec2 pa = vPx - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  float dist = length(pa - ba * h);
  float fill = clamp(fillRadius + 0.5 - dist, 0.0, 1.0);
  float ring = ringAlpha * clamp(ringHalf + 0.5 - abs(dist - ringRadius), 0.0, 1.0);
  float alpha = (fill + ring) * opacity;
  if (alpha <= 0.002) discard;
  // view: camera distance, tan of the half field of view across and up, and the projection's depth terms.
  vec2 ndc = gl_FragCoord.xy / buffer * 2.0 - 1.0;
  vec3 ray = normalize(vec3(ndc.x * view.y, ndc.y * view.z, -1.0));
  float bq = -view.x * ray.z;
  float disc = bq * bq - (view.x * view.x - 1.0002 * 1.0002);
  if (disc > 0.0) {
    float z = (bq - sqrt(disc)) * ray.z;
    gl_FragDepth = 0.5 * (projectionDepth.x * z + projectionDepth.y) / -z + 0.5;
  } else {
    gl_FragDepth = 0.0;
  }
  gl_FragColor = vec4(color, alpha);
  #include <colorspace_fragment>
}
`;

interface Shared {
  buffer: { value: THREE.Vector2 };
  view: { value: THREE.Vector4 };
  projectionDepth: { value: THREE.Vector2 };
}

function shapeMaterial(shared: Shared): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...shared,
      a: { value: new THREE.Vector2() },
      b: { value: new THREE.Vector2() },
      extent: { value: 1 },
      color: { value: new THREE.Color() },
      fillRadius: { value: 0 },
      ringRadius: { value: 0 },
      ringHalf: { value: 0 },
      ringAlpha: { value: 0 },
      opacity: { value: 1 },
    },
    vertexShader: shapeVertex,
    fragmentShader: `uniform vec2 projectionDepth;\n${shapeFragment}`,
    transparent: true,
    depthWrite: false,
  });
}

function panelMaterial(shared: Shared): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { buffer: shared.buffer, rect: { value: new THREE.Vector4() }, map: { value: null }, opacity: { value: 1 } },
    vertexShader: panelVertex,
    fragmentShader: panelFragment,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });
}

/** Per visit: its panel texture and materials, kept while the scene lives. */
interface VisitDrawing {
  flap: FlapTexture;
  panel: THREE.ShaderMaterial;
  leader: THREE.ShaderMaterial;
  marker: THREE.ShaderMaterial;
}

const quad = new THREE.PlaneGeometry(1, 1);

export function Labels({ labels, pulses }: { labels: LabelState[]; pulses: Pulse[] }) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  useThree((s) => s.size);
  const shared = useMemo<Shared>(
    () => ({ buffer: { value: new THREE.Vector2() }, view: { value: new THREE.Vector4() }, projectionDepth: { value: new THREE.Vector2() } }),
    [],
  );
  const visits = useMemo(() => new Map<number, VisitDrawing>(), []);
  const pulseMaterials = useMemo<THREE.ShaderMaterial[]>(() => [], []);
  useEffect(
    () => () => {
      for (const v of visits.values()) {
        v.flap.dispose();
        v.panel.dispose();
        v.leader.dispose();
        v.marker.dispose();
      }
      for (const m of pulseMaterials) m.dispose();
    },
    [visits, pulseMaterials],
  );

  const buffer = gl.getDrawingBufferSize(shared.buffer.value);
  const k = Math.min(buffer.x, buffer.y) / 1080;
  const tanY = Math.tan((camera.fov * Math.PI) / 360);
  shared.view.value.set(camera.position.length(), tanY * camera.aspect, tanY, 0);
  const e = camera.projectionMatrix.elements;
  shared.projectionDepth.value.set(e[10]!, e[14]!);
  // Frame-centre pixels (y down, 1080-pixel short side) to drawing-buffer pixels (y up).
  const px = (x: number, y: number) => new THREE.Vector2(buffer.x / 2 + x * k, buffer.y / 2 - y * k);

  const ringed = (m: THREE.ShaderMaterial, x: number, y: number, color: string) => {
    const at = px(x, y);
    m.uniforms.a!.value.copy(at);
    m.uniforms.b!.value.copy(at);
    (m.uniforms.color!.value as THREE.Color).set(color);
  };

  const meshes: React.ReactNode[] = [];
  for (const l of labels) {
    let v = visits.get(l.index);
    if (!v) {
      v = { flap: new FlapTexture(), panel: panelMaterial(shared), leader: shapeMaterial(shared), marker: shapeMaterial(shared) };
      visits.set(l.index, v);
    }
    if (l.marker) {
      const color = l.marker.reached ? REACHED : AHEAD;
      const edge = clampToRect(l.marker, l.panel);
      const lm = v.leader;
      lm.uniforms.a!.value.copy(px(l.marker.x, l.marker.y));
      lm.uniforms.b!.value.copy(px(edge.x, edge.y));
      (lm.uniforms.color!.value as THREE.Color).set(color);
      lm.uniforms.fillRadius!.value = 0.5 * k;
      lm.uniforms.extent!.value = 1 + k;
      lm.uniforms.opacity!.value = (90 / 255) * l.opacity;
      ringed(v.marker, l.marker.x, l.marker.y, color);
      v.marker.uniforms.fillRadius!.value = 6.5 * k;
      v.marker.uniforms.ringRadius!.value = 12.5 * k;
      v.marker.uniforms.ringHalf!.value = k;
      v.marker.uniforms.ringAlpha!.value = 160 / 255;
      v.marker.uniforms.extent!.value = 14 * k + 1;
      if (l.opacity > 0) meshes.push(<mesh key={`l${l.index}`} geometry={quad} material={lm} renderOrder={5} frustumCulled={false} />);
      meshes.push(<mesh key={`m${l.index}`} geometry={quad} material={v.marker} renderOrder={6} frustumCulled={false} />);
    }
    if (l.opacity > 0) {
      const p = v.panel;
      p.uniforms.map!.value = v.flap.update(l.code, l.age, k);
      p.uniforms.opacity!.value = l.opacity;
      // Whole device pixels, so a full-size panel maps its texture one to one.
      const x0 = Math.round(buffer.x / 2 + l.panel.x * k);
      const y1 = Math.round(buffer.y / 2 - l.panel.y * k);
      const w = Math.round(l.panel.w * k);
      const h = Math.round(l.panel.h * k);
      p.uniforms.rect!.value.set(x0, y1 - h, x0 + w, y1);
      meshes.push(<mesh key={`p${l.index}`} geometry={quad} material={p} renderOrder={20} frustumCulled={false} />);
    }
  }
  pulses.forEach((pulse, i) => {
    let m = pulseMaterials[i];
    if (!m) pulseMaterials.push((m = shapeMaterial(shared)));
    const r = 14 + 29 * pulse.age;
    ringed(m, pulse.x, pulse.y, REACHED);
    m.uniforms.ringRadius!.value = (r - 1) * k;
    m.uniforms.ringHalf!.value = 1.5 * k;
    m.uniforms.ringAlpha!.value = (180 / 255) * (1 - pulse.age / PULSE_SECONDS);
    m.uniforms.extent!.value = (r + 1) * k + 1;
    meshes.push(<mesh key={`r${i}`} geometry={quad} material={m} renderOrder={7} frustumCulled={false} />);
  });
  return <group>{meshes}</group>;
}

/** The point of a panel nearest the airport, where its leader line ends. */
function clampToRect(p: { x: number; y: number }, r: Rect): { x: number; y: number } {
  return { x: Math.min(Math.max(p.x, r.x), r.x + r.w), y: Math.min(Math.max(p.y, r.y), r.y + r.h) };
}
