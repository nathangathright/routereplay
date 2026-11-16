/**
 * The light on the aircraft and the train, bus, car, and ferry models: worked out once a frame on the CPU from the
 * same Sun, Moon, air, and clouds as the rest of the scene, and handed to their paint (craftPaint.ts) as a few
 * directional lights and a two-colour sky.
 *
 * - **Sunlight** through the same air as the cloud tops (airLight.ts), at the craft's real height in the air's
 *   units, and cut off by the planet with a finite solar disc. Golden near sunset, then gone.
 * - **Sky and ground fill:** clear skylight from above, at the Sun's elevation; from below, what the craft flies
 *   over: a lit cloud deck, dark sea, or the day map's ground, with the haze in between.
 * - **Under the cloud deck** (cloudCrossing.ts), by the craft's altitude: direct light is dimmed as the ground's is under
 *   the same cloud, the clear sky above gives way to the deck's grey base, and what lies below is the ground, not the
 *   deck's top. The deck's veil over the craft is drawn by Clouds.tsx; `veil` here is its average, for the craft's lamps.
 * - **Moonlight** at its real phase and distance, 4000× real as on the globe.
 * - **A night rig** after the offline renderer's aircraft-only cinematic lights (routereplay aircraft_night.py):
 *   a cool key and a weaker fill that fade in from 2° to 12° after sunset, the key from the Moon when it is up and
 *   bright enough, otherwise from a fixed upper-left side of the frame, so a plane never disappears at night.
 *
 * Everything is a function of the craft's place, the physical time, and the frame's clouds: nothing carries over
 * from the frame before. Units are scene-linear, in which a white surface facing the full Sun reads 1.
 */
import type * as THREE from 'three';
import { type Vec3, cross, dot, normalize, smoothstep } from '../../shared/geo/vec';
import { CLOUD_GRID } from '../../shared/weather/gfs';
import { AIR_SPREAD, H_R, type RGB, SUN_ABOVE_AIR, airAboveAlbedo, clearSkyLight, columnToLight, extinction, lightThroughAir, verticalTransmittance } from './airLight';
import { submersion, veilStrength } from './cloudCrossing';
import type { SkyLights } from './lighting';

const DEG = Math.PI / 180;

export type { RGB };

/** One model time step of the cloud layer: cloud opacity (R) and the 700 hPa wind (RG), on the 1° grid. */
interface WeatherFields {
  cloud: THREE.DataTexture;
  wind: THREE.DataTexture;
}

/** The cloud layer drawn this frame: Clouds.tsx's CloudFrame, and the radius of its tops (CLOUD_RADIUS). */
export interface CloudsBelow {
  frame: { a: WeatherFields; b: WeatherFields; blend: number; presence: number; ageA: number; ageB: number };
  top: number;
  /** The high layer's radius (CIRRUS_RADIUS), when it is drawn: it adds to the light from below once a craft is over it. */
  cirrus?: number;
}

export interface CraftLight {
  /** Up at the craft (unit vector, Earth frame). */
  up: Vec3;
  /** Sunlight on the craft (what a white surface facing it reads) and the direction it comes from. */
  sun: RGB;
  sunDir: Vec3;
  /** Moonlight on the craft, at its phase and distance and 4000× real (lighting.ts). */
  moon: RGB;
  moonDir: Vec3;
  /** The night rig's key and fill. */
  key: RGB;
  keyDir: Vec3;
  /**
   * How much the night key shades the craft with its own shadow, 0–1. It comes in over the 1.5° after the Sun has
   * set for the craft, so a craft never needs two shadow maps at once.
   */
  keyShadow: number;
  fill: RGB;
  fillDir: Vec3;
  /** Light from the sky above and from what lies below: what a white surface facing straight up or down reads. */
  sky: RGB;
  ground: RGB;
  /** Navigation lights and lamps: 0 by day, 1 from 12° after sunset (they start at 2°). */
  lamps: number;
  /** How far under the cloud deck's top the craft is, 0–1 (cloudCrossing.ts submersion); 0 without clouds. */
  submersion: number;
  /** How much deck lies over the craft: its submersion × the deck's mean opacity over it (0–0.95). */
  overhead: number;
  /**
   * How much of the craft the deck's veil hides, on average over it (the veil itself follows the deck's lobes). For what
   * draws as graphics over the veil and can't be veiled pixel by pixel: lamps, propeller discs, a vehicle's shadow.
   */
  veil: number;
}

/**
 * The display height is the real one × 12 (CRUISE_DISPLAY in evaluate.ts), so planes stand clear of the ground;
 * the drawn air's heights are spread 7.2×. Light is taken at the craft's real height in the air's units, which puts
 * a plane at cruise 1.4 scale heights up, as at 11 km. At its display height it would sit above nine-tenths of the
 * air and stay nearly white until the cloud deck below it had gone dark.
 */
const AIR_HEIGHT = AIR_SPREAD / 12;
/**
 * Single scattering leaves the clear sky about 37 % as bright as the offline renderer's aircraft sky (routereplay
 * aircraft_blender.py: luminance 0.13 by day), which stands in for the light scattered more than once. This brings
 * it there.
 */
const SKY_GAIN = 2.7;
/**
 * Light scattered more than once also whitens the sky: real clear skylight is about 12,000 K, where single
 * scattering alone gives a deep blue. Keeping this much of its colour gives about that, (0.11, 0.13, 0.18) at noon,
 * so shaded paint is cool but a midday frame looks as it did under the old white ambient light.
 */
const SKY_SATURATION = 0.3;
/** Light a deck of thick cloud reflects, for the light it throws up at a plane (the drawn deck is brighter still). */
const CLOUD_ALBEDO = 0.75;
/** Share of direct light a deck of opacity 1 keeps off what lies under it: the ground's own rule (Earth.tsx cloudShadow). */
const DECK_DIRECT_LOSS = 0.54;
/** Ground where the day map can't be read (before it loads, or outside a browser): grey-green land. */
const DEFAULT_ALBEDO: RGB = [0.08, 0.1, 0.07];

/** The night rig at strength 1 (routereplay's style.aircraft_night_light): key and fill, as a white surface facing them reads. */
const RIG_KEY: RGB = [0.12, 0.14, 0.18];
const RIG_FILL: RGB = [0.025, 0.03, 0.04];
/**
 * Where they come from, in the frame's terms (x right, y up the screen, z toward a camera looking straight down):
 * the key from high on the left, toward the bottom of the frame, and the fill from high on the right.
 */
const RIG_KEY_FROM: Vec3 = normalize([-0.48, -0.36, 0.8]);
const RIG_FILL_FROM: Vec3 = normalize([0.6, 0.2, Math.sqrt(0.6)]);
/** The key turns toward the Moon as its elevation's sine reaches 0.25 and its light 10 % of a full Moon's. */
const MOON_HIGH = 0.25;
const MOON_BRIGHT = 0.001;
/** The night key's shadow comes in over this much of the Sun's descent below the craft's horizon, after sunset. */
const KEY_SHADOW_IN = 1.5 * DEG;
/** The Sun's angular radius. */
const SUN_RADIUS = ((0.533 / 2) * Math.PI) / 180;

const mix3 = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const scale3 = (a: RGB, s: number): RGB => [a[0] * s, a[1] * s, a[2] * s];
const add3 = (a: RGB, b: RGB): RGB => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul3 = (a: RGB, b: RGB): RGB => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
const max3 = (a: RGB) => Math.max(a[0], a[1], a[2]);

/**
 * One channel of a grid texture (the cloud and wind fields: 360 × 181, rows from 90°N, columns from 0° east),
 * bilinear. The number of channels comes from the data, so more fields can share a texture. `missing` stands in
 * when the channel isn't there.
 */
function gridSample(texture: THREE.DataTexture, lon: number, lat: number, channel: number, missing: number): number {
  const data = texture.image.data as Uint8Array | undefined;
  const { nx, ny } = CLOUD_GRID;
  const channels = data ? Math.floor(data.length / (nx * ny)) : 0;
  if (!data || channel >= channels) return missing;
  const x = ((lon % 360) + 360) % 360;
  const y = Math.min(ny - 1, Math.max(0, 90 - lat));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const y1 = Math.min(ny - 1, y0 + 1);
  const at = (xi: number, yi: number) => data[(yi * nx + (xi % nx)) * channels + channel]!;
  return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y1) * (1 - fx) + at(x0 + 1, y1) * fx) * fy;
}

const latLon = (n: Vec3) => ({ lat: Math.asin(Math.max(-1, Math.min(1, n[1]))) / DEG, lon: Math.atan2(-n[2], n[0]) / DEG });

/** Where air at n would be after drifting with the wind (m/s east and north) for the given seconds. */
function drift(n: Vec3, east: number, north: number, seconds: number): Vec3 {
  const e = cross([0, 1, 0], n);
  const l = Math.hypot(e[0], e[1], e[2]);
  if (l < 1e-4) return n;
  const eastward: Vec3 = [e[0] / l, e[1] / l, e[2] / l];
  const northward = cross(n, eastward);
  const k = seconds / 6.371e6;
  return normalize([
    n[0] + (eastward[0] * east + northward[0] * north) * k,
    n[1] + (eastward[1] * east + northward[1] * north) * k,
    n[2] + (eastward[2] * east + northward[2] * north) * k,
  ]);
}

/**
 * The model's cloud opacity over the unit vector n, as CLOUD_GLSL's cloudOpacity works it out: each model field
 * carried along its own wind, blended. The ground's cloud shadows use this (Earth.tsx cloudShadow).
 */
export function cloudWaterAt(frame: CloudsBelow['frame'], n: Vec3): number {
  const field = (step: WeatherFields, seconds: number) => {
    const { lat, lon } = latLon(n);
    // The cloud field's first channel is the deck's opacity, and the wind's first two the 700 hPa wind.
    const east = (gridSample(step.wind, lon, lat, 0, 128) - 128) * 0.6;
    const north = (gridSample(step.wind, lon, lat, 1, 128) - 128) * 0.6;
    const at = latLon(drift(n, east, north, seconds));
    return gridSample(step.cloud, at.lon, at.lat, 0, 0) / 255;
  };
  return (field(frame.a, -frame.ageA) * (1 - frame.blend) + field(frame.b, frame.ageB) * frame.blend) * frame.presence;
}

/**
 * The cloud layer's opacity over the unit vector n, as the cloud shader works it out (cloudWaterAt, then the deck's
 * density with its billow noise at its mean).
 */
export function cloudCoverAt(frame: CloudsBelow['frame'], n: Vec3): number {
  return smoothstep(0.04, 0.9, cloudWaterAt(frame, n)) * 0.95;
}

/** The 250 hPa wind as Clouds.tsx stores it: m/s per step of the wind texture's B and A channels. */
const JET_STEP = 1.2;

/**
 * The high layer's opacity over the unit vector n, as the cloud shader works it out (CLOUD_GLSL cirrusOpacity): the
 * cloud field's second channel, carried along the 250 hPa wind. Zero where a step has no high layer.
 */
export function cirrusCoverAt(frame: CloudsBelow['frame'], n: Vec3): number {
  const field = (step: WeatherFields, seconds: number) => {
    const { lat, lon } = latLon(n);
    const east = (gridSample(step.wind, lon, lat, 2, 128) - 128) * JET_STEP;
    const north = (gridSample(step.wind, lon, lat, 3, 128) - 128) * JET_STEP;
    const at = latLon(drift(n, east, north, seconds));
    return gridSample(step.cloud, at.lon, at.lat, 1, 0) / 255;
  };
  return (field(frame.a, -frame.ageA) * (1 - frame.blend) + field(frame.b, frame.ageB) * frame.blend) * frame.presence;
}

export interface CraftLightInput {
  /** Unit vector of the ground under the craft. */
  ground: Vec3;
  /** Display altitude above the ground, Earth radii (0 when parked or on a surface leg). */
  altitude: number;
  lights: SkyLights;
  /**
   * The camera, Earth frame: its position and up the frame. The night rig's directions are set in the frame's terms,
   * as the offline renderer's are; its camera looks straight down at the craft, as the journey's does.
   */
  eye: Vec3;
  screenUp: Vec3;
  /** The ground's colour (linear) under a unit vector: the day map's (dayAlbedo.ts). */
  albedo?: ((n: Vec3) => RGB) | null;
  /** The cloud layer drawn this frame, if any. */
  clouds?: CloudsBelow | null;
}

/** airAboveAlbedo() for a cloud deck at this radius, worked out once per radius. */
const deckReturns = new Map<number, RGB>();
function deckReturn(radius: number): RGB {
  let v = deckReturns.get(radius);
  if (!v) {
    v = airAboveAlbedo(radius);
    deckReturns.set(radius, v);
  }
  return v;
}

/** The light on a craft this frame. */
export function craftLight({ ground, altitude, lights, eye, screenUp, albedo = null, clouds = null }: CraftLightInput): CraftLight {
  const up = normalize(ground);
  const sunDir = lights.sun;
  const moonDir = lights.moon;
  const r = 1 + altitude * AIR_HEIGHT;
  const at: Vec3 = [up[0] * r, up[1] * r, up[2] * r];

  // How far under the deck's top the craft is, by its altitude, not its icon's geometry (cloudCrossing.ts).
  const under = clouds ? submersion(altitude, clouds.top - 1) : 0;
  // Direct light under the deck keeps what the ground's keeps under the same cloud: at least 46 %, taken where the
  // light crosses the deck's top on its way down to the craft.
  const throughDeck = (s: Vec3) => {
    if (!clouds || under <= 0) return 1;
    const h = 1 + altitude;
    const ps = h * dot(up, s);
    const t = -ps + Math.sqrt(Math.max(0, ps * ps - h * h + clouds.top * clouds.top));
    const crossing = normalize([up[0] * h + s[0] * t, up[1] * h + s[1] * t, up[2] * h + s[2] * t]);
    return 1 - DECK_DIRECT_LOSS * under * cloudWaterAt(clouds.frame, crossing);
  };
  const sunKept = throughDeck(sunDir);
  const moonKept = throughDeck(moonDir);

  // Direct light, reddened along its path to the craft and cut off by the planet.
  const clearSun = lightThroughAir(at, sunDir);
  const clearMoon = scale3(lightThroughAir(at, moonDir), lights.moonlight);
  const sun = scale3(clearSun, sunKept);
  const moon = scale3(clearMoon, moonKept);

  // Skylight at the Sun's elevation, on the ground below: a plane at cruise has little air above it, and in this
  // scene's stretched heights its shaded paint would go almost black.
  const sunHeight = dot(up, sunDir);
  const single = scale3(clearSkyLight(Math.asin(Math.max(-1, Math.min(1, sunHeight)))), SKY_GAIN);
  const clearSky = mix3([luminance(single), luminance(single), luminance(single)], single, SKY_SATURATION);

  // What lies below: the cloud deck over the ground, each lit by the Sun, Moon, and sky. A craft above the deck sees
  // its top; one under it sees the ground (below).
  // A craft above the high layer sees it too, over the deck; it reflects like the deck per unit of opacity.
  const overCirrus = clouds?.cirrus ? smoothstep(clouds.cirrus - 0.0004, clouds.cirrus + 0.0004, 1 + altitude) : 0;
  const deckCover = clouds ? cloudCoverAt(clouds.frame, up) : 0;
  const overhead = under * deckCover;
  // Under the deck its grey base takes the clear sky's place, at the sky's own luminance, and passes on diffusely the
  // share of the direct light it took away that it doesn't reflect (1 − CLOUD_ALBEDO).
  const level = (light: RGB, s: Vec3) => luminance(light) * Math.max(0, dot(up, s));
  const passed = (level(clearSun, sunDir) * (1 - sunKept) + level(clearMoon, moonDir) * (1 - moonKept)) * (1 - CLOUD_ALBEDO);
  const base = luminance(clearSky) * overhead + passed;
  const sky = overhead > 0 || passed > 0 ? add3(scale3(clearSky, 1 - overhead), [base, base, base]) : clearSky;
  const highCover = clouds && overCirrus > 0 ? cirrusCoverAt(clouds.frame, up) * overCirrus : 0;
  const cover = 1 - (1 - deckCover) * (1 - highCover);
  const colour = albedo?.(up) ?? DEFAULT_ALBEDO;
  const direct = (s: Vec3, light: RGB) => scale3(light, Math.max(0, dot(up, s)));
  const onGround = add3(direct(sunDir, lightThroughAir(up, sunDir)), direct(moonDir, scale3(lightThroughAir(up, moonDir), lights.moonlight)));
  // Cloud keeps at least 46 % of the direct light off the ground below it, as the ground's own shading does.
  const surface = mul3(colour, add3(scale3(onGround, 1 - DECK_DIRECT_LOSS * cover), clearSky));
  let below = surface;
  if (clouds && cover > 0) {
    const radius = clouds.top;
    const top: Vec3 = [up[0] * radius, up[1] * radius, up[2] * radius];
    // The deck's light as the cloud shader has it: reddened by the air above it, catching light a little past its
    // horizon, and gone once the planet hides the light from its top.
    const deckLight = (s: Vec3) => {
      const altitudeOfLight = Math.asin(Math.max(-1, Math.min(1, dot(up, s))));
      const lit = smoothstep(-Math.acos(1 / radius), 0.01, altitudeOfLight);
      const level = Math.min(1, Math.max(0, (dot(up, s) + 0.15) / 1.15));
      return scale3(extinction(columnToLight(top, s)).map((t, i) => Math.exp(-t) * SUN_ABOVE_AIR[i]!) as RGB, lit * level);
    };
    // As in the cloud shader, the air above the deck sends part of its light back down onto it.
    const returned = deckReturn(radius);
    const reflected = scale3(add3(add3(deckLight(sunDir), scale3(deckLight(moonDir), lights.moonlight)), clearSky), CLOUD_ALBEDO);
    const deck: RGB = [0, 1, 2].map((i) => reflected[i]! / (1 - returned[i]! * CLOUD_ALBEDO)) as RGB;
    below = mix3(surface, deck, cover * (1 - under));
  }
  // Seen from above, the haze between the craft and the ground dims what is below and adds its own glow.
  const between = verticalTransmittance(1, Math.max(1, r));
  const haze = 1 - Math.exp(-(r - 1) / H_R);
  const groundFill = add3(mul3(below, between), scale3(clearSky, haze));

  // The night rig. Its directions are in the frame's terms: x right, y up the screen, z toward the camera, which
  // looks down on the craft. Seen from straight above, as journeys are, z is up; the homepage's planes are seen at an
  // angle, and the rig still lights the side the camera sees.
  const shown = 1 + altitude;
  const z = normalize([eye[0] - up[0] * shown, eye[1] - up[1] * shown, eye[2] - up[2] * shown], up);
  const y = normalize(subtractAlong(screenUp, z), northAt(z));
  const x = cross(y, z);
  const fromFrame = (v: Vec3): Vec3 => normalize([
    x[0] * v[0] + y[0] * v[1] + z[0] * v[2],
    x[1] * v[0] + y[1] * v[1] + z[1] * v[2],
    x[2] * v[0] + y[2] * v[1] + z[2] * v[2],
  ]);
  const night = 1 - smoothstep(Math.sin(-12 * DEG), Math.sin(-2 * DEG), sunHeight);
  // The key comes from the Moon only when it is well up and gives useful light; its light then adds to the key.
  const moonInFrame: Vec3 = [dot(moonDir, x), dot(moonDir, y), dot(moonDir, z)];
  const confidence = smoothstep(0, MOON_HIGH, dot(moonDir, up)) * smoothstep(0, MOON_BRIGHT, max3(moon));
  const keyFrom = normalize([
    RIG_KEY_FROM[0] + (moonInFrame[0] - RIG_KEY_FROM[0]) * confidence,
    RIG_KEY_FROM[1] + (moonInFrame[1] - RIG_KEY_FROM[1]) * confidence,
    RIG_KEY_FROM[2] + (moonInFrame[2] - RIG_KEY_FROM[2]) * confidence,
  ]);

  // How far the Sun's disc has sunk below the limb, as seen from the craft (0 while any of it shows).
  const sunk = -(Math.asin(Math.max(-1, Math.min(1, dot(up, sunDir)))) + Math.acos(1 / r)) - SUN_RADIUS;

  return {
    up,
    sun,
    sunDir,
    moon,
    moonDir,
    key: scale3(RIG_KEY, night),
    keyDir: fromFrame(keyFrom),
    keyShadow: smoothstep(0, KEY_SHADOW_IN, sunk),
    fill: scale3(RIG_FILL, night),
    fillDir: fromFrame(RIG_FILL_FROM),
    sky,
    ground: groundFill,
    lamps: night,
    submersion: under,
    overhead,
    veil: (veilStrength(under) * deckCover) / 0.95,
  };
}

function subtractAlong(v: Vec3, n: Vec3): Vec3 {
  const d = dot(v, n);
  return [v[0] - n[0] * d, v[1] - n[1] * d, v[2] - n[2] * d];
}

/** North along the ground at n (east at the poles). */
function northAt(n: Vec3): Vec3 {
  return normalize(subtractAlong([0, 1, 0], n), [1, 0, 0]);
}

/** What a level white surface on the craft reads: each light by its height above the horizon, and the sky. */
export function levelLight(light: CraftLight): RGB {
  let out: RGB = [...light.sky];
  for (const [c, d] of [
    [light.sun, light.sunDir],
    [light.moon, light.moonDir],
    [light.key, light.keyDir],
    [light.fill, light.fillDir],
  ] as const) {
    out = add3(out, scale3(c, Math.max(0, dot(d, light.up))));
  }
  return out;
}

/** Luminance of a linear colour. */
export const luminance = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
