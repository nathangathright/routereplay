import * as THREE from 'three';
import { Part, type V3, loft } from './airframe';

/**
 * A procedural air-traffic-control tower in the style of the aircraft and vehicle models (airframe.ts,
 * vehicles.ts): original geometry, no model files. The camera looks almost straight down, so the plan view
 * carries it: a low base building, a slim shaft, and on top a cab of sloping glass (a dark ring from above) under
 * a round roof with a beacon at its centre. The roof is painted separately so it can show whether the aircraft
 * has reached the airport. A shadow cast away from the Sun (Tower.tsx) shows the shaft's height.
 *
 * Built in fractions of the frame's short side (Tower.tsx keeps it a constant size on screen), x east, y up,
 * z south. Colours are baked into the vertices, so each material is one draw call.
 */

const COLOR = {
  /** Base building and shaft: pale concrete, a little warmer than the aircraft's white. */
  concrete: '#d9dde3',
  base: '#aab3bf',
  gallery: '#7f8a99',
  gold: '#ffc76b',
} as const;
type Paint = keyof typeof COLOR;

/** Heights and radii, as fractions of the short side. */
export const TOWER = {
  base: { x0: -0.0312, x1: 0.0108, z0: -0.0108, z1: 0.0108, y1: 0.0048 },
  shaft: { r: 0.00504, y0: 0.0036, y1: 0.0288 },
  gallery: { r: 0.01776, y0: 0.0282, y1: 0.0306 },
  glass: { r0: 0.0168, r1: 0.01296, y0: 0.0306, y1: 0.0378 },
  roof: { r: 0.01176, y0: 0.0378, y1: 0.03984 },
  mast: { r: 0.00108, y0: 0.03984, y1: 0.0432 },
  beacon: { r: 0.00252, y0: 0.0426, y1: 0.0474 },
  height: 0.0474,
} as const;

/** A regular n-gon prism or frustum about the y axis, from radius r0 at y0 to r1 at y1. */
function frustum(n: number, r0: number, y0: number, r1: number, y1: number, turn = 0): Part {
  const ring = (r: number, y: number) =>
    Array.from({ length: n }, (_, j): V3 => {
      const a = turn + (2 * Math.PI * j) / n;
      return [r * Math.cos(a), y, r * Math.sin(a)];
    });
  return loft([ring(r0, y0), ring(r1, y1)], true);
}

/** A box from (x0, y0, z0) to (x1, y1, z1). */
function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Part {
  const rect = (y: number): V3[] => [
    [x0, y, z0],
    [x1, y, z0],
    [x1, y, z1],
    [x0, y, z1],
  ];
  return loft([rect(y0), rect(y1)], true);
}

/** Merge coloured parts into one geometry, each part wound outward (as vehicles.ts does). */
function merge(parts: [Part, Paint | null][]): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const c = new THREE.Color();
  for (const [part, paint] of parts) {
    c.set(paint ? COLOR[paint] : '#ffffff');
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

/** Lamp kinds: steady, and the two colours of the rotating airport beacon, which flash alternately. */
export const LAMP = { steady: 0, beaconWhite: 1, beaconGreen: 2 } as const;

export interface TowerModel {
  /** Base building, shaft, gallery, mast, and beacon housing. */
  body: THREE.BufferGeometry;
  /** The cab's sloping glass. */
  glass: THREE.BufferGeometry;
  /** The cab roof, painted to show whether the aircraft has reached the airport. */
  roof: THREE.BufferGeometry;
  /** Lights after dark: points with `color`, `aSize` (fraction of the short side), and `aKind` (LAMP). */
  lamps: THREE.BufferGeometry;
}

function build(): TowerModel {
  const T = TOWER;
  const body = merge([
    [box(T.base.x0, T.base.x1, 0, T.base.y1, T.base.z0, T.base.z1), 'base'],
    [frustum(16, T.shaft.r, T.shaft.y0, T.shaft.r, T.shaft.y1), 'concrete'],
    [frustum(20, T.gallery.r, T.gallery.y0, T.gallery.r, T.gallery.y1), 'gallery'],
    [frustum(8, T.mast.r, T.mast.y0, T.mast.r, T.mast.y1), 'gallery'],
    [frustum(12, T.beacon.r, T.beacon.y0, 0.7 * T.beacon.r, T.beacon.y1), 'gold'],
  ]);
  // Ten panes, the roof turned to sit on their corners.
  const glass = merge([[frustum(10, T.glass.r0, T.glass.y0, T.glass.r1, T.glass.y1), null]]);
  const roof = merge([[frustum(10, T.roof.r, T.roof.y0, 0.92 * T.roof.r, T.roof.y1), null]]);
  // Warm light through each pane, just outside the glass, and the beacon on top.
  const lamps: { at: V3; color: V3; size: number; kind: number }[] = [];
  const mid = (T.glass.y0 + T.glass.y1) / 2;
  const r = (T.glass.r0 + T.glass.r1) / 2 + 0.0012;
  for (let j = 0; j < 10; j++) {
    const a = (2 * Math.PI * (j + 0.5)) / 10;
    lamps.push({ at: [r * Math.cos(a), mid, r * Math.sin(a)], color: [0.8, 0.62, 0.4], size: 0.0055, kind: LAMP.steady });
  }
  lamps.push({ at: [0, T.beacon.y1, 0], color: [1, 1, 1], size: 0.018, kind: LAMP.beaconWhite });
  lamps.push({ at: [0, T.beacon.y1, 0], color: [0.15, 1, 0.35], size: 0.018, kind: LAMP.beaconGreen });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(lamps.flatMap((l) => l.at), 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(lamps.flatMap((l) => l.color), 3));
  g.setAttribute('aSize', new THREE.Float32BufferAttribute(lamps.map((l) => l.size), 1));
  g.setAttribute('aKind', new THREE.Float32BufferAttribute(lamps.map((l) => l.kind), 1));
  return { body, glass, roof, lamps: g };
}

let model: TowerModel | null = null;

/** The tower model, built on first use and kept for the life of the page (each tower owns only materials). */
export function towerModel(): TowerModel {
  return (model ??= build());
}
