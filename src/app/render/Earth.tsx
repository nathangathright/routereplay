import { useMemo } from 'react';
import * as THREE from 'three';
import type { Vec3 } from '../../shared/geo/vec';
import type { EarthTextures } from './assets';
import { CLOUD_GLSL, CLOUD_RADIUS, type CloudFrame, cloudUniforms, setCloudUniforms } from './Clouds';
import { AIR_GLSL, ATMOSPHERE_TOP, CITY_GLSL, LIGHT_GLSL, type SkyLights, lightUniforms, setLightUniforms } from './lighting';
import { NIGHT_DETAIL_GLSL, type NightDetailTextures, nightDetailUniforms, setNightDetailUniforms } from './nightDetail';
import { PLANE_SHADOW_GLSL, type ShadowCaster, planeShadowUniforms, setPlaneShadowUniforms } from './planeShadow';

export { ATMOSPHERE_TOP };

const earthVertex = /* glsl */ `
uniform vec3 sunDir;
uniform vec3 moonDir;
varying vec2 vUv;
varying vec3 vNormalL;
varying vec3 vNormalW;
varying vec3 vPosW;
varying vec3 vSunW;
varying vec3 vMoonW;
void main() {
  vUv = uv;
  vNormalL = normal;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vSunW = normalize(mat3(modelMatrix) * sunDir);
  vMoonW = normalize(mat3(modelMatrix) * moonDir);
  vec4 world = modelMatrix * vec4(position, 1.0);
  vPosW = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const earthFragment = /* glsl */ `
uniform sampler2D dayMap;
uniform sampler2D nightMap;
uniform sampler2D waterMap;
varying vec2 vUv;
varying vec3 vNormalL;
varying vec3 vNormalW;
varying vec3 vPosW;
varying vec3 vSunW;
varying vec3 vMoonW;
${LIGHT_GLSL}
${AIR_GLSL}
${CITY_GLSL}
${CLOUD_GLSL}
${NIGHT_DETAIL_GLSL}
${PLANE_SHADOW_GLSL}

// Sun glint on open water: a rough-water GGX lobe with Schlick Fresnel and Smith masking, as in the
// offline renderer (routereplay surfacelighting.py). Roughness and gain are cinematic, not measured.
float glint(vec3 N, vec3 V, vec3 L) {
  float nl = clamp(dot(N, L), 0.0, 1.0);
  float nv = clamp(dot(N, V), 0.0, 1.0);
  vec3 H = normalize(L + V);
  float nh = clamp(dot(N, H), 0.0, 1.0);
  float lh = clamp(dot(H, L), 0.0, 1.0);
  const float a2 = 0.0081; // alpha = 0.3^2
  float d = nh * nh * (a2 - 1.0) + 1.0;
  float distribution = a2 / (3.14159265 * d * d);
  float fresnel = 0.02 + 0.98 * pow(1.0 - lh, 5.0);
  float gl = 2.0 * nl / (nl + sqrt(a2 + (1.0 - a2) * nl * nl) + 1e-7);
  float gv = 2.0 * nv / (nv + sqrt(a2 + (1.0 - a2) * nv * nv) + 1e-7);
  return fresnel * distribution * gl * gv / (4.0 * nl * nv + 1e-6) * nl * (450.0 / 255.0);
}

// How much of an even sky the same rough water reflects toward a viewer at cosine nv from the vertical: the
// glint's lobe integrated over the sky, fitted to within 0.01. 2 % looking straight down, 5 % at 60°, 19 % at
// 75°, 38 % at grazing.
float skyReflectance(float nv) {
  float k = 2.29 * pow(1.0 - nv, 5.41);
  return 0.02 + 0.539 * k / (1.0 + k);
}

// Skylight arriving at the ground point n from direction r: single scattering by air and haze along r, lit by
// sunlight whose own path to the ground has optical depth sunTau. Closed form for a flat, evenly mixed
// atmosphere: light scattered at a fraction t of the way down reaches the ground dimmed by
// e^-(t sunTau + (1 - t) viewTau). Blue overhead, paler toward the horizon, and orange toward a low Sun. Night
// is left to the terminator fade, as for the rest of the ground.
vec3 skyRadiance(vec3 n, vec3 r, vec3 s, vec3 sunTau) {
  vec2 col = columnUp(n, r);
  vec3 x = extinction(col) - sunTau;
  vec3 along = mix((1.0 - exp(-x)) / x, 1.0 - 0.5 * x, lessThan(abs(x), vec3(1e-3)));
  float c = dot(r, s);
  return SOLAR_RADIANCE * (BETA_R * col.x * airPhase(c) + BETA_M * col.y * hazePhase(c)) * exp(-sunTau) * along;
}

// Cloud between this ground point g and a light in direction s: where the beam crosses the cloud layer.
// Direct light keeps at least 46 % under thick cloud, as in routereplay's cloud_shadow.
float cloudShadow(vec3 g, vec3 s) {
  float gs = dot(g, s);
  vec3 shell = normalize(g + s * (-gs + sqrt(gs * gs + ${(CLOUD_RADIUS * CLOUD_RADIUS - 1).toFixed(6)})));
  return 1.0 - 0.54 * cloudOpacity(shell, false);
}

// The ground's normal tilted by its relief, from NOAA ETOPO 2022 heights exaggerated 12× as in the offline renderer
// (scripts/build-textures.py stores the normal's east and north components). g is the sphere's normal in the Earth's
// frame, +Y north. Only the ground's Lambert shading uses it: the terminator, air, cloud shadows, and water keep g.
uniform sampler2D reliefMap;
vec3 reliefNormal(vec3 g, vec2 uv) {
  vec2 en = (texture2D(reliefMap, uv).rg * 255.0 - 128.0) / 127.0;
  vec3 east = vec3(g.z, 0.0, -g.x) / max(length(g.xz), 1e-6);
  vec3 north = cross(g, east);
  return normalize(en.x * east + en.y * north + sqrt(max(1.0 - dot(en, en), 0.0)) * g);
}

// The global night map's light level. Where the map is magnified, bilinear sampling draws its texel grid as soft
// squares, so it is sampled through a cubic B-spline there; where it is minified, its mipmaps serve. The two blend
// over the last halving of magnification.
float globalLevel(vec2 uv) {
  vec2 size = vec2(textureSize(nightMap, 0));
  vec2 dx = dFdx(uv * size);
  vec2 dy = dFdy(uv * size);
  float lod = 0.5 * log2(max(dot(dx, dx), dot(dy, dy)));
  float smoothed = cubicSample(nightMap, uv, size, 0.0).r;
  return mix(smoothed, texture2D(nightMap, uv).r, smoothstep(-1.0, 0.0, lod));
}

// Night-side floor: a trace of the map so coasts still read (routereplay render.py, its lunar-mode level).
const vec3 NIGHT_FLOOR = vec3(0.00061, 0.00182, 0.00368);
// The orange band of civil twilight along the terminator.
const vec3 TWILIGHT = vec3(0.0075, 0.0030, 0.0009);

void main() {
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vPosW);
  // Light is measured in the Earth's own frame, so day and night stay on the ground however the globe is turned.
  vec3 g = normalize(vNormalL);
  vec3 s = normalize(sunDir);
  float mu = dot(g, s);
  vec3 albedo = texture2D(dayMap, vUv).rgb;
  float water = texture2D(waterMap, vUv).r;
  vec3 n = normalize(mix(reliefNormal(g, vUv), g, water));

  // Day: Lambert ground with a little skylight, reddened as the Sun gets low, shadowed by cloud and aircraft.
  vec3 sun = groundLight(g, s);
  float shadow = cloudShadow(g, s) * planeShadow(g);
  float viewDepth = max(dot(N, V), 0.0);
  vec3 day = albedo * (0.035 + 0.965 * max(dot(n, s), 0.0) * shadow) * sun;
  // Water also mirrors the sky, more of it toward the limb: what it reflects replaces light from below the
  // surface. The sky's light needs no cloud shadow; past the terminator band the day side isn't drawn.
  if (water > 0.0 && mu > -0.105) {
    vec3 sky = skyRadiance(N, reflect(-V, N), normalize(vSunW), extinction(columnToLight(g, s)));
    day = mix(day, sky, water * skyReflectance(viewDepth));
  }
  day += vec3(1.0, 0.96, 0.86) * glint(N, V, normalize(vSunW)) * water * shadow * sun;
  vec3 night = (albedo * 0.0036 + NIGHT_FLOOR) * (0.72 + 0.28 * viewDepth);
  vec3 color = mix(night, day, smoothstep(0.0, 1.0, (mu + 0.105) / 0.21));

  // Moonlight: the same ground and water response, at the Moon's phase and through the same air and cloud.
  float mm = dot(g, moonDir);
  if (moonlight > 0.0 && mm > -0.05) {
    vec3 moon = moonlight * groundLight(g, moonDir) * cloudShadow(g, moonDir);
    color += (0.965 * albedo * max(dot(n, moonDir), 0.0) + glint(N, V, normalize(vMoonW)) * water) * moon;
  }

  color += exp(-pow(mu / 0.065, 2.0)) * TWILIGHT;
  // City light from the global night map, or the full-resolution tiles where the camera is close.
  float spread = length(cameraPosition - vPosW) / max(viewDepth, 1e-3);
  color += cityLights(g, nightLevel(vUv, globalLevel(vUv), spread));

  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const atmosphereVertex = /* glsl */ `
varying vec3 vPos;
varying vec3 vCamera;
void main() {
  vPos = position;
  // The camera in the Earth's own frame, where the planet is a unit sphere at the origin.
  vCamera = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Single scattering by air (Rayleigh) and haze (Mie) with the offline renderer's constants (routereplay
 * atmosphere.py): heights spread 7.2× with extinction divided by 7.2, so vertical optical depth stays
 * physical; Henyey–Greenstein haze with g = 0.76; sunlight reddened by its path and blocked by the Earth with
 * a finite solar disc; and the same bounded secondary-scattering term. Lengths are in Earth radii.
 *
 * Each step's optical depth is exact: the Chapman function gives the column from a point to space, and a
 * segment is the difference of two columns taken looking up. So 8 steps per pixel suffice for the light.
 */
const atmosphereFragment = /* glsl */ `
uniform vec3 sunDir;
varying vec3 vPos;
varying vec3 vCamera;
${AIR_GLSL}
${PLANE_SHADOW_GLSL}

void main() {
  vec3 ro = vCamera;
  vec3 rd = normalize(vPos - vCamera);
  vec3 s = normalize(sunDir);
  vec2 shell = sphere(ro, rd, TOP);
  if (shell.y <= 0.0) discard;
  float t0 = max(shell.x, 0.0);
  float t1 = shell.y;
  vec2 ground = sphere(ro, rd, 1.0);
  if (ground.y > ground.x && ground.x > 0.0) t1 = min(t1, ground.x);
  // Split the path at its lowest point, so every column is taken looking up.
  float tLow = clamp(-dot(ro, rd), t0, t1);

  float mu = dot(rd, s);
  float phaseR = airPhase(mu);
  float phaseM = hazePhase(mu);
  const float SECONDARY = 0.38 / (1.0 - 0.38);

  vec3 light = vec3(0.0);
  vec3 tau = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    bool descending = i < 4;
    float a = descending ? mix(t0, tLow, float(i) / 4.0) : mix(tLow, t1, float(i - 4) / 4.0);
    float b = descending ? mix(t0, tLow, float(i + 1) / 4.0) : mix(tLow, t1, float(i - 3) / 4.0);
    if (b <= a) continue;
    vec3 pa = ro + rd * a;
    vec3 pb = ro + rd * b;
    vec2 col = descending ? columnUp(pb, -rd) - columnUp(pa, -rd) : columnUp(pa, rd) - columnUp(pb, rd);
    col = max(col, vec2(0.0));
    vec3 segment = extinction(col);
    vec3 p = ro + rd * (0.5 * (a + b));
    vec3 viewed = exp(-(tau + 0.5 * segment));
    // Sunlight reaching p: reddened along its path, and cut off by the Earth.
    float visible = discVisible(p, s);
    vec3 sunTau = visible > 0.0 ? extinction(columnToLight(p, s)) : vec3(8.0);
    vec3 sun = exp(-sunTau) * visible;
    vec3 single = sun * (BETA_R * col.x * phaseR + BETA_M * col.y * phaseM);
    // Light scattered more than once lingers briefly past the terminator, gone by ~10° of solar depression.
    float cosine = dot(p, s) / length(p);
    float hemisphere = smoothstep(0.0, 1.0, clamp((cosine + 0.18) / 0.30, 0.0, 1.0));
    vec3 secondary = (BETA_R * col.x + BETA_M * col.y) / (4.0 * PI) * SECONDARY * (1.0 - exp(-min(sunTau, vec3(8.0)))) * hemisphere;
    light += viewed * (single + secondary);
    tau += segment;
  }
  light *= SOLAR_RADIANCE;
  // The air over an aircraft's shadow is shaded with it (a stylized shadow volume), so the shadow shows through
  // the haze instead of being washed out by it.
  if (ground.y > ground.x && ground.x > 0.0) light *= planeShadow(normalize(ro + rd * ground.x));
  // What lies behind (ground, clouds, stars) shows through the air's transmittance.
  vec3 through = exp(-tau);
  float cover = 1.0 - dot(through, vec3(0.2126, 0.7152, 0.0722));
  gl_FragColor = vec4(light, cover);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * `lights`: the Sun, Moon, and clock in the Earth's own frame (see vec.ts), whatever the Earth's parent rotation.
 * `clouds`: the cloud layer's current frame, for cloud shadows on the ground.
 * `detail`: a journey's full-resolution city lights near its airports (nightDetail.ts), or none.
 * `shadows`: the aircraft that shade the ground (see planeShadow.ts).
 */
export function Earth({
  textures,
  lights,
  segments,
  clouds = null,
  detail = null,
  shadows = [],
}: {
  textures: EarthTextures;
  lights: SkyLights;
  segments: number;
  clouds?: CloudFrame | null;
  detail?: NightDetailTextures | null;
  shadows?: readonly ShadowCaster[];
}) {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          dayMap: { value: textures.day },
          nightMap: { value: textures.night },
          waterMap: { value: textures.water },
          reliefMap: { value: textures.relief },
          ...cloudUniforms(),
          ...lightUniforms(),
          ...nightDetailUniforms(),
          ...planeShadowUniforms(),
        },
        vertexShader: earthVertex,
        fragmentShader: earthFragment,
      }),
    [textures],
  );
  setLightUniforms(material.uniforms, lights);
  setCloudUniforms(material.uniforms, clouds);
  setNightDetailUniforms(material.uniforms, detail, (textures.night.image as HTMLImageElement).width);
  setPlaneShadowUniforms(material.uniforms, shadows, lights.sun);
  return (
    <mesh material={material} renderOrder={0}>
      <sphereGeometry args={[1, segments, Math.round(segments / 2)]} />
    </mesh>
  );
}

/**
 * The air around the Earth, drawn over the ground, clouds, and sky behind it (and under planes, routes, and
 * labels): blue by day, white toward the limb, red where sunlight grazes through the terminator, with the
 * Earth's shadow cast on it, and the aircraft's (`shadows`, see planeShadow.ts). `sun` is in the Earth's own frame.
 */
export function Atmosphere({ sun, segments, shadows = [] }: { sun: Vec3; segments: number; shadows?: readonly ShadowCaster[] }) {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { sunDir: { value: new THREE.Vector3() }, ...planeShadowUniforms() },
        vertexShader: atmosphereVertex,
        fragmentShader: atmosphereFragment,
        side: THREE.BackSide,
        // Drawn over the ground and clouds wherever the air is, so it ignores their depth; premultiplied:
        // in-scattered light plus what shows through.
        depthTest: false,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
      }),
    [],
  );
  (material.uniforms.sunDir!.value as THREE.Vector3).set(sun[0], sun[1], sun[2]);
  setPlaneShadowUniforms(material.uniforms, shadows, sun);
  return (
    <mesh material={material} renderOrder={0.75}>
      <sphereGeometry args={[ATMOSPHERE_TOP, segments, Math.round(segments / 2)]} />
    </mesh>
  );
}
