import * as THREE from 'three';
import { AIRCRAFT_FAMILIES, type AircraftType, type Airframe, type Family, type Wingtip, airframe } from '../../shared/scene/aircraft';

/**
 * Procedural aircraft models built from each type's dimensions (src/shared/scene/aircraft.ts): a lofted
 * fuselage, airfoil-section wings and tail surfaces, nacelles turned on a lathe, and the type's wingtip device.
 * Original geometry, no model files. The camera mostly looks straight down, so the plan view gets the care:
 * span, sweep, chord, tail and engine placement.
 *
 * Built in metres with x toward the left wingtip, y up, and `aft` measured back from the nose, then scaled so
 * every model is one unit long, nose toward +z and centred on the fuselage midpoint.
 */

const DEG = Math.PI / 180;
type V3 = [number, number, number];

/** One closed piece of surface. Winding is fixed when parts are merged, so builders needn't track it. */
class Part {
  readonly p: number[] = [];
  readonly i: number[] = [];
  add(v: V3): number {
    this.p.push(v[0], v[1], v[2]);
    return this.p.length / 3 - 1;
  }
  tri(a: number, b: number, c: number) {
    this.i.push(a, b, c);
  }
  mirrored(): Part {
    const m = new Part();
    for (let k = 0; k < this.p.length; k += 3) m.p.push(-this.p[k]!, this.p[k + 1]!, this.p[k + 2]!);
    m.i.push(...this.i);
    return m;
  }
}

/**
 * Join rings of equal length into a surface. `wrap`: each ring is a closed loop. Caps close both ends with a
 * fan, wound to agree with the sides.
 */
function loft(rings: V3[][], wrap: boolean): Part {
  const part = new Part();
  const n = rings[0]!.length;
  const ids = rings.map((r) => r.map((v) => part.add(v)));
  for (let k = 0; k + 1 < ids.length; k++) {
    const a = ids[k]!;
    const b = ids[k + 1]!;
    for (let j = 0; j < (wrap ? n : n - 1); j++) {
      const j1 = (j + 1) % n;
      part.tri(a[j]!, b[j]!, b[j1]!);
      part.tri(a[j]!, b[j1]!, a[j1]!);
    }
  }
  const cap = (ring: number[], verts: V3[], end: boolean) => {
    const c = verts.reduce<V3>((s, v) => [s[0] + v[0] / n, s[1] + v[1] / n, s[2] + v[2] / n], [0, 0, 0]);
    const ci = part.add(c);
    for (let j = 0; j < n; j++) {
      const j1 = (j + 1) % n;
      if (end) part.tri(ci, ring[j1]!, ring[j]!);
      else part.tri(ci, ring[j]!, ring[j1]!);
    }
  };
  cap(ids[0]!, rings[0]!, false);
  cap(ids[ids.length - 1]!, rings[rings.length - 1]!, true);
  return part;
}

/** A surface of revolution about the axis through (x, y) parallel to the fuselage. Profile: [aft, radius]. */
function lathe(x: number, y: number, profile: [number, number][], segments = 20): Part {
  const rings = profile.map(([aft, r]) =>
    Array.from({ length: segments }, (_, j): V3 => {
      const a = (2 * Math.PI * j) / segments;
      return [x + r * Math.cos(a), y + r * Math.sin(a), aft];
    }),
  );
  return loft(rings, true);
}

interface Section {
  /** Leading edge: x, y, aft. */
  le: V3;
  chord: number;
  /** Thickness ÷ chord. */
  tc: number;
  /** Direction of the section's upper surface in the x–y plane. */
  up: [number, number];
  camber?: number;
}

const CHORD_POINTS = Array.from({ length: 9 }, (_, i) => (1 - Math.cos((Math.PI * i) / 8)) / 2);

/** NACA four-digit half-thickness for unit thickness, closed at the trailing edge. */
const halfThickness = (x: number) =>
  5 * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);

/** A section's outline from the upper trailing edge, round the leading edge, to the lower trailing edge. */
function airfoil(s: Section): V3[] {
  const at = (x: number, side: number): V3 => {
    const off = (4 * (s.camber ?? 0) * x * (1 - x) + side * s.tc * halfThickness(x)) * s.chord;
    return [s.le[0] + s.up[0] * off, s.le[1] + s.up[1] * off, s.le[2] + x * s.chord];
  };
  const out: V3[] = [];
  for (let i = CHORD_POINTS.length - 1; i >= 0; i--) out.push(at(CHORD_POINTS[i]!, 1));
  for (let i = 1; i < CHORD_POINTS.length; i++) out.push(at(CHORD_POINTS[i]!, -1));
  return out;
}

const surface = (sections: Section[]) => loft(sections.map(airfoil), false);

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Fuselage cross-section at `aft` metres behind the nose: half width, top and bottom heights, upper-deck rise. */
function bodyProfile(a: Airframe, f: Family) {
  const L = a.length;
  const w = a.bodyWidth / 2;
  // A 747's quoted height includes its upper deck; the main deck below it is close to round.
  const main = a.upperDeck ? Math.min(a.bodyHeight, a.bodyWidth * 1.06) : a.bodyHeight;
  const h = main / 2;
  const rise = a.bodyHeight - main;
  const nose = Math.min(f.body.nose * a.bodyWidth, 0.3 * L);
  const tail = Math.min(f.body.tail * a.bodyWidth, 0.4 * L);
  return {
    nose,
    tail,
    at(aft: number) {
      let hw = w;
      let top = h;
      let bottom = -h;
      if (aft < nose) {
        const t = Math.max(0, aft / nose);
        const r = Math.max(0.01, (1 - (1 - t) ** 3) ** 0.7);
        // The nose sits low: the windscreen slopes up to the crown.
        const droop = -0.18 * h * (1 - t) ** 2;
        hw = w * r;
        top = droop + h * r;
        bottom = droop - h * r;
      } else if (aft > L - tail) {
        // The tail cone narrows and its underside sweeps up toward the crown.
        const t = Math.min(1, (aft - (L - tail)) / tail);
        hw = w * Math.max(0.01, 1 - t ** 1.6);
        top = h * (1 - 0.49 * t ** 1.3);
        bottom = Math.min(top - 0.02 * h, h * (-1 + 1.49 * t ** 1.6));
      }
      const deck = a.upperDeck ? rise * smooth(0, 1.6 * nose, aft) * (1 - smooth(a.upperDeck - 0.1 * L, a.upperDeck + 0.02 * L, aft)) : 0;
      return { hw, top, bottom, deck };
    },
  };
}

function fuselage(a: Airframe, body: ReturnType<typeof bodyProfile>): Part {
  const L = a.length;
  const stations: number[] = [];
  for (let k = 0; k <= 14; k++) stations.push(body.nose * (k / 14) ** 1.6);
  const mid = Math.max(2, Math.ceil((L - body.nose - body.tail) / (L / 30)));
  for (let k = 1; k < mid; k++) stations.push(lerp(body.nose, L - body.tail, k / mid));
  for (let k = 0; k <= 14; k++) stations.push(L - body.tail + body.tail * (k / 14));
  const N = 32;
  const rings = stations.map((aft) => {
    const s = body.at(aft);
    const cy = (s.top + s.bottom) / 2;
    const hh = (s.top - s.bottom) / 2;
    return Array.from({ length: N }, (_, j): V3 => {
      const th = (2 * Math.PI * j) / N;
      const sin = Math.sin(th);
      // An upper deck is a narrower bulge on the crown.
      const lift = sin > 0 ? s.deck * sin ** 4 : 0;
      const pinch = sin > 0 && s.deck > 0 ? 1 - 0.25 * (s.deck / a.bodyHeight) * sin * sin : 1;
      return [s.hw * Math.cos(th) * pinch, cy + hh * sin + lift, aft];
    });
  });
  return loft(rings, true);
}

interface WingtipShape {
  /** Height as a fraction of span; cant outward from vertical, and leading-edge sweep, in degrees. */
  height: number;
  cant: number;
  sweep: number;
  /** Radius of the curve joining the wing, as a fraction of the height (0: a sharp joint). */
  blend: number;
  /** Root and tip chords as fractions of the wing's tip chord. */
  root: number;
  tip: number;
}

const WINGLETS: Partial<Record<Wingtip, { upper: WingtipShape; lower?: WingtipShape }>> = {
  blended: { upper: { height: 0.068, cant: 15, sweep: 38, blend: 0.3, root: 1, tip: 0.35 } },
  sharklet: { upper: { height: 0.068, cant: 10, sweep: 45, blend: 0.45, root: 1, tip: 0.3 } },
  canted: { upper: { height: 0.032, cant: 29, sweep: 55, blend: 0, root: 0.75, tip: 0.35 } },
  curved: { upper: { height: 0.055, cant: 12, sweep: 50, blend: 0.7, root: 1, tip: 0.25 } },
  split: {
    upper: { height: 0.065, cant: 10, sweep: 45, blend: 0.25, root: 0.85, tip: 0.3 },
    lower: { height: 0.03, cant: 45, sweep: 45, blend: 0, root: 0.6, tip: 0.3 },
  },
};

/** How far a winglet reaches sideways beyond the wing tip, in metres. */
function wingletReach(w: WingtipShape, span: number): number {
  const h = w.height * span;
  const end = (90 - w.cant) * DEG;
  const r = w.blend * h;
  const straight = Math.max(0, (h - r * (1 - Math.cos(end))) / Math.sin(end));
  return r * Math.sin(end) + straight * Math.cos(end);
}

/** A winglet rising (or, `down`, falling) from the tip section: a blended curve, then a straight blade. */
function winglet(tip: Section, w: WingtipShape, span: number, down: boolean): Part {
  const h = w.height * span;
  const end = (90 - w.cant) * DEG;
  const r = w.blend * h;
  const straight = Math.max(0, (h - r * (1 - Math.cos(end))) / Math.sin(end));
  const v = down ? -1 : 1;
  const path: { x: number; y: number; phi: number }[] = [];
  const steps = r > 0 ? 6 : 1;
  for (let k = 0; k <= steps; k++) {
    const phi = r > 0 ? (end * k) / steps : k === 0 ? 0 : end;
    if (r > 0) path.push({ x: r * Math.sin(phi), y: v * r * (1 - Math.cos(phi)), phi });
    else path.push({ x: 0, y: 0, phi });
  }
  const last = path[path.length - 1]!;
  path.push({ x: last.x + straight * Math.cos(end), y: last.y + v * straight * Math.sin(end), phi: end });
  const c = tip.chord;
  return surface(
    path.map(({ x, y, phi }) => {
      const q = Math.abs(y) / h;
      const chord = c * lerp(w.root, w.tip, q);
      return {
        le: [tip.le[0] + x, tip.le[1] + y, tip.le[2] + (c - chord) * 0.15 + Math.abs(y) * Math.tan(w.sweep * DEG)],
        chord,
        tc: 0.09,
        up: [-v * Math.sin(phi), Math.cos(phi)],
      };
    }),
  );
}

export interface AirframeModel {
  geometry: THREE.BufferGeometry;
  /**
   * Navigation lights as points: red on the left wingtip, green on the right, white on the tail, and a red
   * beacon on the crown (`aBeacon` 1) that flashes. Colours and rhythm follow the offline renderer.
   */
  lampGeometry: THREE.BufferGeometry;
  /** Distance from the model's origin down to its lowest point, model units. */
  bottom: number;
}

/** Material slots of the merged geometry. */
export const SLOT = { body: 0, trim: 1, tail: 2, prop: 3 } as const;

function build(type: AircraftType): AirframeModel {
  const a = airframe(type);
  const f = AIRCRAFT_FAMILIES[a.family];
  const L = a.length;
  const parts: Part[][] = [[], [], [], []];
  const both = (slot: number, p: Part) => parts[slot]!.push(p, p.mirrored());

  const body = bodyProfile(a, f);
  parts[SLOT.body]!.push(fuselage(a, body));

  // Wing: a reference trapezoid matching the published area, sweep, and span, reshaped inboard of the kink.
  const tips = WINGLETS[a.wingtip];
  const semi = a.span / 2 - (tips ? wingletReach(tips.upper, a.span) : 0);
  const taper = f.wing.taper;
  const rootChord = a.wingArea / (semi * (1 + taper));
  const tipChord = taper * rootChord;
  const tanSweep = Math.tan(a.sweep * DEG);
  const macY = ((semi / 3) * (1 + 2 * taper)) / (1 + taper);
  const quarter0 = f.wing.at * L - macY * tanSweep;
  const chordAt = (x: number) => lerp(rootChord, tipChord, x / semi);
  const leRef = (x: number) => quarter0 + x * tanSweep - chordAt(x) / 4;
  const kink = f.wing.kink * semi;
  const edges = (x: number): [number, number] => {
    if (x < kink) {
      const te = leRef(kink) + chordAt(kink);
      return [f.wing.planform === 'rectangular' ? leRef(kink) : leRef(x), te];
    }
    return [leRef(x), leRef(x) + chordAt(x)];
  };
  const dihedral = f.wing.dihedral * DEG;
  const wingRoot = f.wing.mount === 'low' ? -0.28 * a.bodyHeight : 0.42 * a.bodyHeight;
  const wingY = (x: number) => wingRoot + x * Math.tan(dihedral);
  const wingUp: [number, number] = [-Math.sin(dihedral), Math.cos(dihedral)];
  const section = (x: number, le: number, te: number): Section => ({
    le: [x, wingY(x), le],
    chord: te - le,
    tc: lerp(f.wing.thickness[0], f.wing.thickness[1], x / semi),
    up: wingUp,
    camber: 0.02,
  });
  const wingX = [0, kink];
  if (a.wingtip === 'raked') wingX.push(0.9 * semi);
  wingX.push(semi);
  const wing = wingX.map((x) => {
    const [le, te] = edges(x);
    if (a.wingtip === 'raked' && x === semi) {
      // The raked tip: the leading edge sweeps back to a short tip chord.
      return section(x, te - 0.3 * tipChord, te);
    }
    return section(x, le, te);
  });
  both(SLOT.body, surface(wing));
  const tip = wing[wing.length - 1]!;
  if (tips) {
    both(SLOT.body, winglet(tip, tips.upper, a.span, false));
    if (tips.lower) both(SLOT.body, winglet(tip, tips.lower, a.span, true));
  } else if (a.wingtip === 'fence') {
    const h = 0.015 * a.span;
    const c = tip.chord;
    const [x, y, le] = tip.le;
    both(
      SLOT.body,
      surface([
        { le: [x, y - h, le + 0.2 * c], chord: 0.6 * c, tc: 0.06, up: [1, 0] },
        { le: [x, y, le - 0.25 * c], chord: 1.3 * c, tc: 0.06, up: [1, 0] },
        { le: [x, y + h, le + 0.2 * c], chord: 0.6 * c, tc: 0.06, up: [1, 0] },
      ]),
    );
  }

  // Fin: its tip at the overall height above the ground, with a dorsal fillet where it meets the fuselage.
  const finTE = f.fin.at * L;
  const finTop = a.height - f.body.belly - a.bodyHeight / 2;
  let finRoot = body.at(finTE - 0.1 * L).top;
  let finHeight = finTop - finRoot;
  let finChord = f.fin.chord * finHeight;
  finRoot = body.at(finTE - finChord / 2).top;
  finHeight = finTop - finRoot;
  finChord = f.fin.chord * finHeight;
  const finLE = finTE - finChord;
  const finSweep = Math.tan(f.fin.sweep * DEG);
  const finTipChord = f.fin.taper * finChord;
  const finTipLE = finLE + finHeight * finSweep;
  const finTEAt = (y: number) => lerp(finTE, finTipLE + finTipChord, (y - finRoot) / finHeight);
  const finSection = (y: number, le: number, tc: number): Section => ({ le: [0, y, le], chord: finTEAt(y) - le, tc, up: [1, 0] });
  const embed = 0.12 * a.bodyHeight;
  const fin = [
    finSection(finRoot - embed, finLE - 0.5 * finChord, 0.08),
    finSection(finRoot + 0.12 * finHeight, finLE + 0.12 * finHeight * finSweep, 0.11),
    finSection(finTop, finTipLE, 0.09),
  ];

  // Tailplane: on the tail cone, or across the top of the fin.
  const tailSemi = a.tailplaneSpan / 2;
  const tailRoot = f.tailplane.chord * tailSemi;
  const tailLE = f.tailplane.tTail ? finTipLE + 0.05 * finTipChord : f.tailplane.at * L;
  const tailY = f.tailplane.tTail
    ? finTop
    : (() => {
        const s = body.at(tailLE + tailRoot / 2);
        return (s.top + s.bottom) / 2 + 0.1 * (s.top - s.bottom);
      })();
  const tailDihedral = f.tailplane.dihedral * DEG;
  const tailUp: [number, number] = [-Math.sin(tailDihedral), Math.cos(tailDihedral)];
  const tailplane: Section[] = [
    { le: [0, tailY, tailLE], chord: tailRoot, tc: 0.1, up: tailUp },
    {
      le: [tailSemi, tailY + tailSemi * Math.tan(tailDihedral), tailLE + tailSemi * Math.tan(f.tailplane.sweep * DEG)],
      chord: f.tailplane.taper * tailRoot,
      tc: 0.09,
      up: tailUp,
    },
  ];
  // The published length is the overall length: a T-tail that would reach past the tail cone moves forward.
  const overhang = Math.max(0, ...[...fin, ...tailplane].map((sec) => sec.le[2] + sec.chord - L));
  for (const sec of [...fin, ...tailplane]) sec.le[2] -= overhang;
  parts[SLOT.tail]!.push(surface(fin));
  both(SLOT.body, surface(tailplane));

  // Engines.
  const D = a.engineDiameter;
  const length = f.nacelle * D;
  a.engines.forEach((x, i) => {
    const inlet = a.inlet?.[i];
    if (f.engines === 'prop') {
      const [le] = edges(x);
      const r = 0.15 * D;
      const y = wingY(x) - 0.5 * r;
      // The propeller turns a little behind the spinner's tip.
      const start = inlet !== undefined ? inlet - 0.05 * length : le - 0.3 * length;
      const profile: [number, number][] = [
        [0, 0.01], [0.012, 0.35], [0.035, 0.6], [0.05, 0.72], [0.055, 0.85], [0.1, 1], [0.45, 1], [0.7, 0.8], [0.9, 0.45], [1, 0.05],
      ];
      both(SLOT.trim, lathe(x, y, profile.map(([t, k]) => [start + t * length, k * r])));
      const disc = new Part();
      const centre = disc.add([x, y, start + 0.05 * length]);
      const rim = Array.from({ length: 40 }, (_, j) => {
        const th = (2 * Math.PI * j) / 40;
        return disc.add([x + (D / 2) * Math.cos(th), y + (D / 2) * Math.sin(th), start + 0.05 * length]);
      });
      rim.forEach((v, j) => disc.tri(centre, v, rim[(j + 1) % rim.length]!));
      both(SLOT.prop, disc);
    } else {
      const rear = f.engines === 'rear';
      const [le, te] = edges(x);
      const chord = te - le;
      const lip = inlet ?? (rear ? 0.7 * L : le - 0.62 * length);
      const y = rear ? 0.2 * a.bodyHeight : wingY(x) - 0.06 * chord - 0.46 * D;
      const profile: [number, number][] = [
        [0.06, 0.005], [0.045, 0.37], [0, 0.42], [0.02, 0.475], [0.08, 0.5], [0.3, 0.5], [0.55, 0.47], [0.66, 0.42],
        [0.66, 0.31], [0.8, 0.28], [0.9, 0.2], [0.9, 0.13], [1.03, 0.005],
      ];
      both(SLOT.trim, lathe(x, y, profile.map(([t, k]) => [lip + t * length, k * D])));
      if (rear) {
        // A short horizontal pylon from the fuselage side.
        const pylon = 0.5 * length;
        both(
          SLOT.body,
          surface([
            { le: [0.3 * a.bodyWidth, y, lip + 0.3 * length], chord: pylon, tc: (0.12 * D) / pylon, up: [0, 1] },
            { le: [x - 0.3 * D, y, lip + 0.3 * length], chord: pylon, tc: (0.12 * D) / pylon, up: [0, 1] },
          ]),
        );
      } else {
        const bottomChord = 0.6 * length;
        const topChord = Math.max(0.7 * length, 0.5 * chord);
        both(
          SLOT.body,
          surface([
            { le: [x, y + 0.4 * D, lip + 0.3 * length], chord: bottomChord, tc: (0.14 * D) / bottomChord, up: [1, 0] },
            { le: [x, wingY(x), Math.min(le - 0.05 * chord, lip + 0.35 * length)], chord: topChord, tc: (0.14 * D) / topChord, up: [1, 0] },
          ]),
        );
      }
    }
  });

  // Merge each material's parts, scaled to unit length with the nose toward +z, and wound outward.
  const positions: number[] = [];
  const indices: number[] = [];
  const geometry = new THREE.BufferGeometry();
  let minY = 0;
  parts.forEach((list, slot) => {
    const start = indices.length;
    for (const part of list) {
      const base = positions.length / 3;
      const pts: V3[] = [];
      for (let k = 0; k < part.p.length; k += 3) {
        const v: V3 = [part.p[k]! / L, part.p[k + 1]! / L, (L / 2 - part.p[k + 2]!) / L];
        pts.push(v);
        positions.push(...v);
        minY = Math.min(minY, v[1]);
      }
      let volume = 0;
      for (let k = 0; k < part.i.length; k += 3) {
        const [p, q, r] = [pts[part.i[k]!]!, pts[part.i[k + 1]!]!, pts[part.i[k + 2]!]!];
        volume += p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0]);
      }
      for (let k = 0; k < part.i.length; k += 3) {
        const [p, q, r] = [part.i[k]!, part.i[k + 1]!, part.i[k + 2]!];
        if (volume >= 0) indices.push(base + p, base + q, base + r);
        else indices.push(base + p, base + r, base + q);
      }
    }
    if (indices.length > start) geometry.addGroup(start, indices.length - start, slot);
  });
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const model = (v: V3): V3 => [v[0] / L, v[1] / L, (L / 2 - v[2]) / L];
  const tipLamp: V3 = [tip.le[0], tip.le[1], tip.le[2] + 0.1 * tip.chord];
  const tail = body.at(L);
  const crown = body.at(0.45 * L);
  const lamps: { at: V3; color: V3; beacon?: true }[] = [
    { at: model(tipLamp), color: [0.9, 0.008, 0.003] },
    { at: model([-tipLamp[0], tipLamp[1], tipLamp[2]]), color: [0.006, 0.75, 0.08] },
    { at: model([0, (tail.top + tail.bottom) / 2, L]), color: [1, 1, 1] },
    { at: model([0, crown.top + crown.deck + 0.05 * a.bodyHeight, 0.45 * L]), color: [0.9, 0.02, 0.01], beacon: true },
  ];
  const lampGeometry = new THREE.BufferGeometry();
  lampGeometry.setAttribute('position', new THREE.Float32BufferAttribute(lamps.flatMap((l) => l.at), 3));
  lampGeometry.setAttribute('color', new THREE.Float32BufferAttribute(lamps.flatMap((l) => l.color), 3));
  lampGeometry.setAttribute('aBeacon', new THREE.Float32BufferAttribute(lamps.map((l) => (l.beacon ? 1 : 0)), 1));
  return { geometry, lampGeometry, bottom: -minY };
}

const models = new Map<AircraftType, AirframeModel>();

/**
 * The model for a type, built on first use and kept for the life of the page: planes share geometry and own
 * only their materials, so retiring a plane leaks nothing (React Three Fiber never disposes a <primitive>).
 */
export function airframeModel(type: AircraftType): AirframeModel {
  let m = models.get(type);
  if (!m) {
    m = build(type);
    models.set(type, m);
  }
  return m;
}
