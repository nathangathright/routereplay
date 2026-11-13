import * as THREE from 'three';
import type { SurfaceMode } from '../../shared/scene/constants';
import { Part, type V3, loft } from './airframe';

/**
 * Procedural train, bus, car, and ferry models in the aircraft library's style (airframe.ts): rounded sections
 * lofted along the body, original geometry, no model files. The camera looks straight down, so the plan view
 * carries the identity: a chain of cars behind a pointed locomotive, a long flat roof with a roof pod, a short
 * body with a glass cabin between hood and boot, a hull with a pointed bow under stepped white decks.
 *
 * Built in fractions of the frame's short side (JourneyScene scales every model by one number, so they keep
 * their sizes relative to each other), nose toward +z, x toward the vehicle's left, y up from the ground.
 * Colours are baked into the vertices, so each body is one draw call.
 */

const COLOR = {
  /** The aircraft's paint (Aircraft.tsx), so the fleet matches. */
  white: '#f3f5f8',
  grey: '#9aa4b2',
  gold: '#ffc76b',
  glass: '#1a2330',
  dark: '#3a4250',
  red: '#d9473a',
  navy: '#23344f',
  deck: '#6f7b89',
} as const;
type Paint = keyof typeof COLOR;

/** A cross-section at `z`: half width `hw` at the bottom and `top` at the roof, from height y0 to y1. */
interface Station {
  z: number;
  hw: number;
  top?: number;
  y0: number;
  y1: number;
}

const ARC = [0, Math.PI / 4, Math.PI / 2];

/** A rounded-box section: twelve points, its four edges rounded by r. */
function ring(s: Station, r: number): V3[] {
  const top = s.top ?? s.hw;
  const rc = Math.max(1e-7, Math.min(r, 0.45 * (s.y1 - s.y0), 0.9 * Math.min(s.hw, top)));
  // Round the section from the bottom left: up the left side, across the roof, down the right side.
  const corners: [number, number, number][] = [
    [-(s.hw - rc), s.y0 + rc, 1.5 * Math.PI],
    [-(top - rc), s.y1 - rc, Math.PI],
    [top - rc, s.y1 - rc, Math.PI / 2],
    [s.hw - rc, s.y0 + rc, 0],
  ];
  const out: V3[] = [];
  for (const [cx, cy, a0] of corners) for (const a of ARC) out.push([cx + rc * Math.cos(a0 - a), cy + rc * Math.sin(a0 - a), s.z]);
  return out;
}

const block = (stations: Station[], r: number) => loft(stations.map((s) => ring(s, r)), true);

/** Plan-view stations from z0 to z1 at half width hw, the rear and front corners rounded: [z, half width]. */
function plan(z0: number, z1: number, hw: number, rear: number, front: number): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k <= 3; k++) {
    const a = Math.PI - (k / 3) * (Math.PI / 2);
    out.push([z0 + rear + rear * Math.cos(a), Math.max(0.08 * hw, hw - rear + rear * Math.sin(a))]);
  }
  for (let k = 1; k <= 3; k++) {
    const a = Math.PI / 2 - (k / 3) * (Math.PI / 2);
    out.push([z1 - front + front * Math.cos(a), Math.max(0.08 * hw, hw - front + front * Math.sin(a))]);
  }
  return out;
}

/** A box with rounded corners in plan and in section. */
function slab(z0: number, z1: number, hw: number, y0: number, y1: number, opts: { rear?: number; front?: number; r?: number; top?: number } = {}): Part {
  const rear = opts.rear ?? 0.25 * hw;
  const front = opts.front ?? rear;
  const shrink = (opts.top ?? hw) / hw;
  return block(
    plan(z0, z1, hw, rear, front).map(([z, w]) => ({ z, hw: w, top: w * shrink, y0, y1 })),
    opts.r ?? 0.15 * (y1 - y0),
  );
}

interface Lamp {
  at: V3;
  color: V3;
  /** Point diameter as a fraction of the frame's short side. */
  size: number;
}

const HEADLIGHT: V3 = [1, 0.9, 0.72];
const TAIL: V3 = [1, 0.05, 0.02];
const WINDOW: V3 = [0.95, 0.62, 0.3];

/** One rigid body: a whole bus, or one car of a train. */
export interface VehicleBody {
  geometry: THREE.BufferGeometry;
  /** Lights after dark: points with `color` and `aSize` (fraction of the short side). */
  lamps: THREE.BufferGeometry;
  /** A soft dark patch on the ground under the body (RGBA vertex colours), as the marker's halo was. */
  shadow: THREE.BufferGeometry;
  /** Nose to tail, as a fraction of the frame's short side. */
  length: number;
}

export interface VehicleModel {
  /** From the front: a train's locomotive, then its cars. */
  bodies: VehicleBody[];
  /** Space between bodies, as a fraction of the short side. */
  gap: number;
  /** Overall width, as a fraction of the short side. */
  width: number;
}

/** Merge coloured parts into one geometry, each part wound outward. */
function merge(parts: [Part, Paint][]): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const c = new THREE.Color();
  for (const [part, paint] of parts) {
    c.set(COLOR[paint]);
    const base = positions.length / 3;
    positions.push(...part.p);
    for (let k = 0; k < part.p.length; k += 3) colors.push(c.r, c.g, c.b);
    const v = (k: number): V3 => [part.p[3 * k]!, part.p[3 * k + 1]!, part.p[3 * k + 2]!];
    let volume = 0;
    for (let k = 0; k < part.i.length; k += 3) {
      const [p, q, r] = [v(part.i[k]!), v(part.i[k + 1]!), v(part.i[k + 2]!)];
      volume += p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0]);
    }
    for (let k = 0; k < part.i.length; k += 3) {
      const [p, q, r] = [part.i[k]!, part.i[k + 1]!, part.i[k + 2]!];
      if (volume >= 0) indices.push(base + p, base + q, base + r);
      else indices.push(base + p, base + r, base + q);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

function lampGeometry(lamps: Lamp[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(lamps.flatMap((l) => l.at), 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(lamps.flatMap((l) => l.color), 3));
  g.setAttribute('aSize', new THREE.Float32BufferAttribute(lamps.map((l) => l.size), 1));
  return g;
}

/** How far the shadow reaches beyond the body, and how dark it is under it. */
const SHADOW_MARGIN = 0.006;
const SHADOW_ALPHA = 0.5;
const SHADOW_COLOR = new THREE.Color('#080c16');

/**
 * A soft shadow under a body: dark over its footprint, fading to nothing SHADOW_MARGIN beyond it. It keeps a
 * small vehicle legible over bright ground and cloud, and darkens the gaps between a train's cars.
 */
function shadowGeometry(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  geometry.computeBoundingBox();
  const { min, max } = geometry.boundingBox!;
  const m = SHADOW_MARGIN;
  const xs = [min.x - m, min.x, max.x, max.x + m];
  const zs = [min.z - m, min.z, max.z, max.z + m];
  const positions: number[] = [];
  const colors: number[] = [];
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) {
      positions.push(xs[i]!, 0, zs[j]!);
      const inside = i > 0 && i < 3 && j > 0 && j < 3;
      colors.push(SHADOW_COLOR.r, SHADOW_COLOR.g, SHADOW_COLOR.b, inside ? SHADOW_ALPHA : 0);
    }
  }
  const index: number[] = [];
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 3; i++) {
      const a = j * 4 + i;
      index.push(a, a + 4, a + 1, a + 1, a + 4, a + 5);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
  g.setIndex(index);
  return g;
}

function body(parts: [Part, Paint][], lamps: Lamp[], length: number): VehicleBody {
  const geometry = merge(parts);
  return { geometry, lamps: lampGeometry(lamps), shadow: shadowGeometry(geometry), length };
}

/** A row of window lights along both sides. */
function windows(z0: number, z1: number, x: number, y: number, n: number, size: number): Lamp[] {
  const out: Lamp[] = [];
  for (let k = 0; k < n; k++) {
    const z = z0 + ((k + 0.5) / n) * (z1 - z0);
    out.push({ at: [x, y, z], color: WINDOW, size }, { at: [-x, y, z], color: WINDOW, size });
  }
  return out;
}

/**
 * A family car, 2.2 times as long as it is wide: a red body with a dark glass cabin between bonnet and boot,
 * and a red roof in the middle of the glass. Headlights and tail lights after dark.
 */
function car(): VehicleModel {
  const L = 0.04;
  const W = 0.0182;
  const hw = W / 2;
  const z = (u: number) => -L / 2 + u * L;
  // Waist height along the body: the bonnet slopes down to the nose, the boot a little toward the tail.
  const waist = (u: number) => (u > 0.72 ? 0.19 - 0.045 * ((u - 0.72) / 0.28) : u < 0.1 ? 0.165 + 0.025 * (u / 0.1) : 0.19) * L;
  const shell = block(
    plan(z(0), z(1), hw, 0.35 * hw, 0.45 * hw).map(([zz, w]) => ({ z: zz, hw: w, top: 0.95 * w, y0: 0.03 * L, y1: waist((zz + L / 2) / L) })),
    0.05 * L,
  );
  // The cabin rises from the waist: rear window, roof, windscreen.
  const cabin = block(
    [
      [0.2, 0.18],
      [0.33, 0.31],
      [0.55, 0.31],
      [0.7, 0.18],
    ].map(([u, y]) => ({ z: z(u!), hw: 0.9 * hw, top: 0.72 * hw, y0: 0.15 * L, y1: y! * L })),
    0.02 * L,
  );
  const roof = slab(z(0.345), z(0.535), 0.69 * hw, 0.29 * L, 0.322 * L, { rear: 0.2 * hw, r: 0.012 * L });
  const lamps: Lamp[] = [
    { at: [0.62 * hw, 0.15 * L, z(1) + 0.004 * L], color: HEADLIGHT, size: 0.009 },
    { at: [-0.62 * hw, 0.15 * L, z(1) + 0.004 * L], color: HEADLIGHT, size: 0.009 },
    { at: [0.7 * hw, 0.16 * L, z(0) - 0.004 * L], color: TAIL, size: 0.007 },
    { at: [-0.7 * hw, 0.16 * L, z(0) - 0.004 * L], color: TAIL, size: 0.007 },
  ];
  return { bodies: [body([[shell, 'red'], [cabin, 'glass'], [roof, 'red']], lamps, L)], gap: 0, width: W };
}

/**
 * A coach, 3.3 times as long as it is wide: a long flat white roof over a dark band of windows that wraps
 * round a deep windscreen, with a gold air-conditioning pod. Window lights along both sides after dark.
 */
function bus(): VehicleModel {
  const L = 0.052;
  const W = 0.0158;
  const hw = W / 2;
  const z = (u: number) => -L / 2 + u * L;
  const lower = slab(z(0), z(1), hw, 0.025 * L, 0.15 * L, { rear: 0.22 * hw, front: 0.3 * hw, r: 0.02 * L });
  const band = slab(z(0), z(1), hw, 0.145 * L, 0.235 * L, { rear: 0.22 * hw, front: 0.3 * hw, r: 0.004 * L, top: 0.97 * hw });
  const roof = slab(z(0.012), z(0.925), 0.93 * hw, 0.23 * L, 0.262 * L, { rear: 0.22 * hw, front: 0.2 * hw, r: 0.02 * L });
  const pod = slab(z(0.3), z(0.6), 0.55 * hw, 0.255 * L, 0.29 * L, { rear: 0.4 * hw, r: 0.015 * L });
  const lamps: Lamp[] = [
    { at: [0.7 * hw, 0.08 * L, z(1) + 0.003 * L], color: HEADLIGHT, size: 0.009 },
    { at: [-0.7 * hw, 0.08 * L, z(1) + 0.003 * L], color: HEADLIGHT, size: 0.009 },
    { at: [0.75 * hw, 0.1 * L, z(0) - 0.003 * L], color: TAIL, size: 0.007 },
    { at: [-0.75 * hw, 0.1 * L, z(0) - 0.003 * L], color: TAIL, size: 0.007 },
    ...windows(z(0.08), z(0.88), 1.02 * hw, 0.19 * L, 5, 0.0065),
  ];
  return {
    bodies: [body([[lower, 'white'], [band, 'glass'], [roof, 'white'], [pod, 'gold']], lamps, L)],
    gap: 0,
    width: W,
  };
}

/**
 * A short passenger train: a locomotive with a sloping gold nose and dark windscreen, and three white cars with
 * a grey roof ridge, joined by dark gangways. Each car is its own body, placed on the route behind the one in
 * front, so the train bends with the line. A headlight and lit windows after dark.
 */
function train(): VehicleModel {
  const W = 0.0096;
  const hw = W / 2;
  const gap = 0.0022;

  const LL = 0.028;
  const lz = (u: number) => -LL / 2 + u * LL;
  const nose = 0.7;
  const main = block(
    plan(lz(0), lz(nose), hw, 0.3 * hw, 0).map(([z, w]) => ({ z, hw: w, top: 0.94 * w, y0: 0.035 * LL, y1: 0.21 * LL })),
    0.04 * LL,
  );
  // The nose narrows and slopes down to the coupler; gold, with the windscreen across its upper slope.
  const noseAt = (t: number): Station => ({
    z: lz(nose + t * (1 - nose)),
    hw: hw * (1 - 0.45 * t * t),
    top: 0.94 * hw * (1 - 0.5 * t * t),
    y0: 0.035 * LL,
    y1: (0.21 - 0.1 * t ** 1.5) * LL,
  });
  const span = (a: number, b: number) => block([0, 0.25, 0.5, 0.75, 1].map((k) => noseAt(a + k * (b - a))), 0.04 * LL);
  const roofBox = (u0: number, u1: number) => slab(lz(u0), lz(u1), 0.5 * hw, 0.2 * LL, 0.235 * LL, { r: 0.01 * LL });
  const loco = body(
    [
      [main, 'white'],
      [span(0, 0.3), 'gold'],
      [span(0.3, 0.65), 'glass'],
      [span(0.65, 1), 'gold'],
      [roofBox(0.12, 0.32), 'grey'],
      [roofBox(0.4, 0.58), 'grey'],
    ],
    [
      { at: [0.28 * hw, 0.08 * LL, lz(1) + 0.004 * LL], color: HEADLIGHT, size: 0.009 },
      { at: [-0.28 * hw, 0.08 * LL, lz(1) + 0.004 * LL], color: HEADLIGHT, size: 0.009 },
    ],
    LL,
  );

  const CL = 0.024;
  const cz = (u: number) => -CL / 2 + u * CL;
  const round = { rear: 0.3 * hw, front: 0.3 * hw };
  const gangway = (z0: number, z1: number) => slab(z0, z1, 0.55 * hw, 0.04 * CL, 0.19 * CL, { rear: 0, r: 0.01 * CL });
  const coach = body(
    [
      [slab(cz(0), cz(1), hw, 0.035 * CL, 0.15 * CL, { ...round, r: 0.02 * CL }), 'white'],
      [slab(cz(0), cz(1), hw, 0.145 * CL, 0.2 * CL, { ...round, r: 0.004 * CL, top: 0.97 * hw }), 'glass'],
      [slab(cz(0.005), cz(0.995), 0.93 * hw, 0.195 * CL, 0.225 * CL, { ...round, r: 0.015 * CL }), 'white'],
      [slab(cz(0.08), cz(0.92), 0.3 * hw, 0.22 * CL, 0.236 * CL, { r: 0.006 * CL }), 'grey'],
      [gangway(cz(1) - 0.02 * CL, cz(1) + gap / 2), 'dark'],
      [gangway(cz(0) - gap / 2, cz(0) + 0.02 * CL), 'dark'],
    ],
    windows(cz(0.1), cz(0.9), 1.02 * hw, 0.17 * CL, 3, 0.0065),
    CL,
  );
  return { bodies: [loco, coach, coach, coach], gap, width: W };
}

/**
 * A ro-ro ferry, 3.8 times as long as it is wide: a navy hull with a pointed bow, a grey open deck fore and aft,
 * a white deckhouse with a rounded front, a bridge deck whose dark windows face forward, and a gold funnel.
 * Navigation lights (red to port, green to starboard, white mast and stern) and deck lights after dark. Its
 * wake is drawn by Vehicle.tsx along the route behind it.
 */
function ferry(): VehicleModel {
  const L = 0.054;
  const W = 0.0144;
  const hw = W / 2;
  const z = (u: number) => -L / 2 + u * L;
  // Hull half width along the length: a square transom, parallel sides, then a rounded, pointed bow.
  const beam = (u: number) => hw * (u < 0.04 ? 0.9 + 2.5 * u : u <= 0.6 ? 1 : Math.max(0.06, Math.sqrt(1 - ((u - 0.6) / 0.4) ** 2)));
  const HULL = [0, 0.04, 0.3, 0.6, 0.7, 0.8, 0.88, 0.94, 0.98, 1];
  const sheer = (u: number) => (0.05 + 0.012 * Math.max(0, (u - 0.6) / 0.4) ** 2) * L;
  const hull = block(
    HULL.map((u) => ({ z: z(u), hw: beam(u), y0: 0, y1: sheer(u) })),
    0.012 * L,
  );
  const deck = block(
    HULL.slice(1, -1).map((u) => ({ z: z(u), hw: 0.88 * beam(u), y0: sheer(u) - 0.006 * L, y1: sheer(u) + 0.003 * L })),
    0.002 * L,
  );
  const house = slab(z(0.1), z(0.76), 0.82 * hw, 0.05 * L, 0.105 * L, { rear: 0.15 * hw, front: 0.75 * hw, r: 0.008 * L });
  const bridge = slab(z(0.3), z(0.73), 0.72 * hw, 0.1 * L, 0.126 * L, { rear: 0.15 * hw, front: 0.65 * hw, r: 0.003 * L });
  const bridgeRoof = slab(z(0.305), z(0.69), 0.68 * hw, 0.122 * L, 0.14 * L, { rear: 0.15 * hw, front: 0.55 * hw, r: 0.006 * L });
  const funnel = slab(z(0.34), z(0.46), 0.3 * hw, 0.13 * L, 0.19 * L, { rear: 0.3 * hw, r: 0.01 * L, top: 0.27 * hw });
  const lamps: Lamp[] = [
    { at: [0, 0.2 * L, z(0.64)], color: [1, 1, 1], size: 0.007 },
    { at: [0.76 * hw, 0.13 * L, z(0.66)], color: [0.95, 0.03, 0.02], size: 0.007 },
    { at: [-0.76 * hw, 0.13 * L, z(0.66)], color: [0.03, 0.8, 0.12], size: 0.007 },
    { at: [0, 0.07 * L, z(0) - 0.003 * L], color: [1, 1, 1], size: 0.006 },
    ...windows(z(0.14), z(0.7), 0.86 * hw, 0.085 * L, 5, 0.006),
  ];
  return {
    bodies: [
      body(
        [
          [hull, 'navy'],
          [deck, 'deck'],
          [house, 'white'],
          [bridge, 'glass'],
          [bridgeRoof, 'white'],
          [funnel, 'gold'],
        ],
        lamps,
        L,
      ),
    ],
    gap: 0,
    width: W,
  };
}

const BUILDERS: Record<SurfaceMode, () => VehicleModel> = { train, bus, car, ferry };
const models = new Map<SurfaceMode, VehicleModel>();

/** The model for a mode, built on first use and kept for the life of the page (vehicles own only materials). */
export function vehicleModel(mode: SurfaceMode): VehicleModel {
  let m = models.get(mode);
  if (!m) {
    m = BUILDERS[mode]();
    models.set(mode, m);
  }
  return m;
}
