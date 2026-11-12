/**
 * Aircraft types a leg can name, keyed by ICAO type designator (ICAO Doc 8643), with the dimensions the
 * renderer builds each model from. Changing the set of designators changes the public contract: update the
 * agent docs and tests together.
 *
 * Overall dimensions are published figures (sources in docs/aircraft.md). Each family's shape (where the wing
 * sits, its taper, the nose and tail proportions) is estimated from three-view drawings. Models are drawn the
 * same length on screen, so proportions, not size, tell types apart.
 */

export type Wingtip =
  /** No device. */
  | 'plain'
  /** Small plates above and below the tip (A320ceo, A380). */
  | 'fence'
  /** An upturned winglet blended into the tip (737NG, 757, 767, E-Jets, CRJ). */
  | 'blended'
  /** Airbus's large blended winglet (A320neo, A330neo). */
  | 'sharklet'
  /** A straight winglet canted outward from a sharp joint (747-400, A330ceo). */
  | 'canted'
  /** A winglet curving smoothly up out of the wing (A350). */
  | 'curved'
  /** An upper and a lower blade (737 MAX). */
  | 'split'
  /** The tip sweeps back more steeply, with no winglet (787, 777-300ER, 747-8). */
  | 'raked';

export type FamilyId =
  | 'a220'
  | 'a320'
  | 'b737'
  | 'b757'
  | 'b767'
  | 'b777'
  | 'b787'
  | 'a330'
  | 'a350'
  | 'b747'
  | 'a380'
  | 'ejet'
  | 'crj'
  | 'atr'
  | 'dash8';

/** Shape shared by a family, estimated from three-view drawings. Lengths are fractions or multiples as noted. */
export interface Family {
  /** Where the engines are: under the wing, on the rear fuselage, or turboprops on a high wing. */
  engines: 'wing' | 'rear' | 'prop';
  wing: {
    mount: 'low' | 'high';
    /** Quarter-chord point of the mean aerodynamic chord, as a fraction of length aft of the nose. */
    at: number;
    /** Tip chord ÷ root chord of the reference wing. */
    taper: number;
    /**
     * Fraction of the semi-span inside which the wing changes shape: the trailing edge runs straight across
     * (swept jets), or the whole wing keeps a constant chord (turboprops).
     */
    kink: number;
    planform: 'yehudi' | 'rectangular';
    /** Degrees. */
    dihedral: number;
    /** Thickness ÷ chord at the root and the tip. */
    thickness: [number, number];
  };
  body: {
    /** Nose and tail cone lengths in fuselage widths. */
    nose: number;
    tail: number;
    /** Ground to the bottom of the fuselage in metres, which places the fin tip given the overall height. */
    belly: number;
  };
  tailplane: {
    /** Root leading edge as a fraction of length aft of the nose; a T-tail sits on top of the fin instead. */
    at: number;
    tTail: boolean;
    /** Root chord ÷ semi-span. */
    chord: number;
    /** Leading-edge sweep, degrees. */
    sweep: number;
    taper: number;
    dihedral: number;
  };
  fin: {
    /** Root trailing edge as a fraction of length aft of the nose. */
    at: number;
    /** Root chord ÷ fin height. */
    chord: number;
    /** Leading-edge sweep, degrees. */
    sweep: number;
    taper: number;
  };
  /** Nacelle length in nacelle diameters (turboprops: in propeller diameters). */
  nacelle: number;
}

export interface Airframe {
  name: string;
  family: FamilyId;
  /** Overall length, span (including the wingtip device), and height, metres. */
  length: number;
  span: number;
  height: number;
  /** Maximum external fuselage width and height, metres. */
  bodyWidth: number;
  bodyHeight: number;
  /** Reference wing area (m²) and quarter-chord sweep (degrees). */
  wingArea: number;
  sweep: number;
  tailplaneSpan: number;
  /** Lateral offsets of the engine centrelines on one side, metres. */
  engines: number[];
  /** Nacelle maximum diameter, or propeller diameter for turboprops, metres. */
  engineDiameter: number;
  /**
   * Engine inlet lip (turboprops: the propeller plane) aft of the nose, metres, one for each entry in `engines`,
   * where a drawing gives it.
   */
  inlet?: number[];
  wingtip: Wingtip;
  /** Where a raised upper deck ends, metres aft of the nose (747). */
  upperDeck?: number;
}

export const AIRCRAFT_FAMILIES: Record<FamilyId, Family> = {
  a220: {
    engines: 'wing',
    wing: { mount: 'low', at: 0.48, taper: 0.25, kink: 0.3, planform: 'yehudi', dihedral: 5, thickness: [0.14, 0.1] },
    body: { nose: 1.9, tail: 3.1, belly: 1.3 },
    tailplane: { at: 0.845, tTail: false, chord: 0.55, sweep: 35, taper: 0.35, dihedral: 6 },
    fin: { at: 0.95, chord: 0.85, sweep: 40, taper: 0.35 },
    nacelle: 1.7,
  },
  a320: {
    engines: 'wing',
    wing: { mount: 'low', at: 0.465, taper: 0.24, kink: 0.37, planform: 'yehudi', dihedral: 5, thickness: [0.14, 0.1] },
    body: { nose: 1.65, tail: 3.0, belly: 1.45 },
    tailplane: { at: 0.85, tTail: false, chord: 0.6, sweep: 34, taper: 0.32, dihedral: 6 },
    fin: { at: 0.955, chord: 0.9, sweep: 38, taper: 0.32 },
    nacelle: 1.75,
  },
  b737: {
    engines: 'wing',
    wing: { mount: 'low', at: 0.47, taper: 0.24, kink: 0.33, planform: 'yehudi', dihedral: 6, thickness: [0.14, 0.1] },
    body: { nose: 1.85, tail: 2.85, belly: 1.0 },
    tailplane: { at: 0.86, tTail: false, chord: 0.55, sweep: 38, taper: 0.33, dihedral: 7 },
    fin: { at: 0.945, chord: 0.7, sweep: 36, taper: 0.3 },
    nacelle: 1.9,
  },
  b757: {
    engines: 'wing',
    wing: { mount: 'low', at: 0.47, taper: 0.24, kink: 0.33, planform: 'yehudi', dihedral: 5, thickness: [0.14, 0.1] },
    body: { nose: 2.0, tail: 2.9, belly: 1.5 },
    tailplane: { at: 0.855, tTail: false, chord: 0.5, sweep: 35, taper: 0.3, dihedral: 7 },
    fin: { at: 0.95, chord: 0.75, sweep: 39, taper: 0.3 },
    nacelle: 1.8,
  },
  b767: {
    engines: 'wing',
    wing: { mount: 'low', at: 0.455, taper: 0.23, kink: 0.34, planform: 'yehudi', dihedral: 6, thickness: [0.14, 0.1] },
    body: { nose: 1.7, tail: 3.1, belly: 1.9 },
    tailplane: { at: 0.84, tTail: false, chord: 0.5, sweep: 37, taper: 0.3, dihedral: 7 },
    fin: { at: 0.955, chord: 0.8, sweep: 40, taper: 0.32 },
    nacelle: 1.75,
  },
  b777: {
    engines: 'wing',
    wing: { mount: 'low', at: 0.455, taper: 0.17, kink: 0.32, planform: 'yehudi', dihedral: 6, thickness: [0.14, 0.1] },
    body: { nose: 1.55, tail: 3.1, belly: 2.3 },
    tailplane: { at: 0.835, tTail: false, chord: 0.55, sweep: 36, taper: 0.3, dihedral: 7 },
    fin: { at: 0.955, chord: 0.85, sweep: 40, taper: 0.32 },
    nacelle: 1.7,
  },
  b787: {
    engines: 'wing',
    wing: { mount: 'low', at: 0.445, taper: 0.18, kink: 0.3, planform: 'yehudi', dihedral: 6.5, thickness: [0.14, 0.1] },
    body: { nose: 1.35, tail: 3.2, belly: 2.2 },
    tailplane: { at: 0.79, tTail: false, chord: 0.55, sweep: 36, taper: 0.35, dihedral: 7 },
    fin: { at: 0.96, chord: 0.9, sweep: 40, taper: 0.32 },
    nacelle: 1.7,
  },
  a330: {
    engines: 'wing',
    wing: { mount: 'low', at: 0.455, taper: 0.22, kink: 0.33, planform: 'yehudi', dihedral: 5.5, thickness: [0.14, 0.1] },
    body: { nose: 1.6, tail: 3.1, belly: 2.2 },
    tailplane: { at: 0.83, tTail: false, chord: 0.55, sweep: 34, taper: 0.32, dihedral: 6 },
    fin: { at: 0.955, chord: 0.9, sweep: 42, taper: 0.35 },
    nacelle: 1.65,
  },
  a350: {
    engines: 'wing',
    wing: { mount: 'low', at: 0.455, taper: 0.2, kink: 0.3, planform: 'yehudi', dihedral: 5, thickness: [0.14, 0.1] },
    body: { nose: 1.45, tail: 3.2, belly: 2.3 },
    tailplane: { at: 0.83, tTail: false, chord: 0.55, sweep: 36, taper: 0.33, dihedral: 6 },
    fin: { at: 0.96, chord: 0.9, sweep: 40, taper: 0.33 },
    nacelle: 1.65,
  },
  b747: {
    engines: 'wing',
    wing: { mount: 'low', at: 0.45, taper: 0.26, kink: 0.3, planform: 'yehudi', dihedral: 7, thickness: [0.14, 0.1] },
    body: { nose: 1.55, tail: 3.0, belly: 2.3 },
    tailplane: { at: 0.845, tTail: false, chord: 0.55, sweep: 38, taper: 0.3, dihedral: 7 },
    fin: { at: 0.955, chord: 0.85, sweep: 45, taper: 0.35 },
    nacelle: 1.75,
  },
  a380: {
    engines: 'wing',
    wing: { mount: 'low', at: 0.46, taper: 0.21, kink: 0.3, planform: 'yehudi', dihedral: 5.6, thickness: [0.14, 0.1] },
    body: { nose: 1.25, tail: 3.0, belly: 2.0 },
    tailplane: { at: 0.83, tTail: false, chord: 0.55, sweep: 35, taper: 0.33, dihedral: 6 },
    fin: { at: 0.955, chord: 0.9, sweep: 42, taper: 0.35 },
    nacelle: 1.6,
  },
  ejet: {
    engines: 'wing',
    wing: { mount: 'low', at: 0.475, taper: 0.28, kink: 0.3, planform: 'yehudi', dihedral: 5, thickness: [0.14, 0.1] },
    body: { nose: 2.0, tail: 3.0, belly: 1.0 },
    tailplane: { at: 0.855, tTail: false, chord: 0.6, sweep: 32, taper: 0.4, dihedral: 6 },
    fin: { at: 0.955, chord: 0.85, sweep: 40, taper: 0.35 },
    nacelle: 1.8,
  },
  crj: {
    engines: 'rear',
    wing: { mount: 'low', at: 0.55, taper: 0.3, kink: 0.2, planform: 'yehudi', dihedral: 3, thickness: [0.13, 0.1] },
    body: { nose: 2.3, tail: 3.0, belly: 0.4 },
    tailplane: { at: 0, tTail: true, chord: 0.55, sweep: 35, taper: 0.4, dihedral: -2 },
    fin: { at: 0.975, chord: 1.1, sweep: 45, taper: 0.7 },
    nacelle: 2.5,
  },
  atr: {
    engines: 'prop',
    wing: { mount: 'high', at: 0.48, taper: 0.55, kink: 0.4, planform: 'rectangular', dihedral: 2.5, thickness: [0.18, 0.13] },
    body: { nose: 1.6, tail: 3.5, belly: 0.9 },
    tailplane: { at: 0, tTail: true, chord: 0.7, sweep: 10, taper: 0.6, dihedral: 0 },
    fin: { at: 0.975, chord: 1.2, sweep: 35, taper: 0.6 },
    nacelle: 1.9,
  },
  dash8: {
    engines: 'prop',
    wing: { mount: 'high', at: 0.47, taper: 0.5, kink: 0.38, planform: 'rectangular', dihedral: 2, thickness: [0.18, 0.13] },
    body: { nose: 2.1, tail: 3.5, belly: 1.3 },
    tailplane: { at: 0, tTail: true, chord: 0.65, sweep: 12, taper: 0.6, dihedral: 0 },
    fin: { at: 0.975, chord: 1.1, sweep: 35, taper: 0.6 },
    nacelle: 2.3,
  },
};

/**
 * One row per designator, from docs/aircraft-sources.json (manufacturers' airport planning documents first;
 * estimates are marked there and in docs/aircraft.md).
 */
export const AIRCRAFT_TYPES = {
  BCS1: { name: 'Airbus A220-100', family: 'a220', length: 34.98, span: 35.1, height: 11.78, bodyWidth: 3.5, bodyHeight: 3.72, wingArea: 112.3, sweep: 27, tailplaneSpan: 12.26, engines: [4.9], engineDiameter: 2.4, inlet: [10.03], wingtip: 'blended' },
  BCS3: { name: 'Airbus A220-300', family: 'a220', length: 38.69, span: 35.1, height: 11.73, bodyWidth: 3.5, bodyHeight: 3.72, wingArea: 112.3, sweep: 27, tailplaneSpan: 12.26, engines: [4.94], engineDiameter: 2.4, inlet: [12.17], wingtip: 'blended' },
  A318: { name: 'Airbus A318', family: 'a320', length: 31.45, span: 34.1, height: 12.89, bodyWidth: 3.95, bodyHeight: 4.14, wingArea: 122.4, sweep: 25, tailplaneSpan: 12.45, engines: [5.75], engineDiameter: 2, inlet: [8.81], wingtip: 'fence' },
  A319: { name: 'Airbus A319', family: 'a320', length: 33.84, span: 34.1, height: 12.11, bodyWidth: 3.95, bodyHeight: 4.14, wingArea: 124, sweep: 25, tailplaneSpan: 12.45, engines: [5.75], engineDiameter: 2, inlet: [9.59], wingtip: 'fence' },
  A320: { name: 'Airbus A320', family: 'a320', length: 37.57, span: 34.1, height: 12.08, bodyWidth: 3.95, bodyHeight: 4.14, wingArea: 124, sweep: 25, tailplaneSpan: 12.45, engines: [5.75], engineDiameter: 2, inlet: [11.19], wingtip: 'fence' },
  A321: { name: 'Airbus A321', family: 'a320', length: 44.51, span: 35.8, height: 12.1, bodyWidth: 3.95, bodyHeight: 4.14, wingArea: 128, sweep: 25, tailplaneSpan: 12.45, engines: [5.75], engineDiameter: 2, inlet: [15.46], wingtip: 'sharklet' },
  A19N: { name: 'Airbus A319neo', family: 'a320', length: 33.84, span: 35.8, height: 12.11, bodyWidth: 3.95, bodyHeight: 4.14, wingArea: 124, sweep: 25, tailplaneSpan: 12.45, engines: [5.75], engineDiameter: 2.7, inlet: [9.54], wingtip: 'sharklet' },
  A20N: { name: 'Airbus A320neo', family: 'a320', length: 37.57, span: 35.8, height: 12.08, bodyWidth: 3.95, bodyHeight: 4.14, wingArea: 124, sweep: 25, tailplaneSpan: 12.45, engines: [5.75], engineDiameter: 2.7, inlet: [11.14], wingtip: 'sharklet' },
  A21N: { name: 'Airbus A321neo', family: 'a320', length: 44.51, span: 35.8, height: 12.1, bodyWidth: 3.95, bodyHeight: 4.14, wingArea: 128, sweep: 25, tailplaneSpan: 12.45, engines: [5.75], engineDiameter: 2.7, inlet: [15.4], wingtip: 'sharklet' },
  B736: { name: 'Boeing 737-600', family: 'b737', length: 31.24, span: 34.32, height: 12.57, bodyWidth: 3.76, bodyHeight: 4.01, wingArea: 124.6, sweep: 25, tailplaneSpan: 14.35, engines: [4.83], engineDiameter: 2.3, inlet: [8.84], wingtip: 'plain' },
  B737: { name: 'Boeing 737-700', family: 'b737', length: 33.63, span: 35.79, height: 12.57, bodyWidth: 3.76, bodyHeight: 4.01, wingArea: 124.6, sweep: 25, tailplaneSpan: 14.35, engines: [4.83], engineDiameter: 2.3, inlet: [10.36], wingtip: 'blended' },
  B738: { name: 'Boeing 737-800', family: 'b737', length: 39.47, span: 35.79, height: 12.55, bodyWidth: 3.76, bodyHeight: 4.01, wingArea: 124.6, sweep: 25, tailplaneSpan: 14.35, engines: [4.83], engineDiameter: 2.3, inlet: [13.36], wingtip: 'blended' },
  B739: { name: 'Boeing 737-900ER', family: 'b737', length: 42.11, span: 35.79, height: 12.55, bodyWidth: 3.76, bodyHeight: 4.01, wingArea: 124.6, sweep: 25, tailplaneSpan: 14.35, engines: [4.83], engineDiameter: 2.3, inlet: [14.73], wingtip: 'blended' },
  B37M: { name: 'Boeing 737 MAX 7', family: 'b737', length: 35.56, span: 35.92, height: 12.5, bodyWidth: 3.76, bodyHeight: 4.01, wingArea: 124.6, sweep: 25, tailplaneSpan: 14.35, engines: [4.82], engineDiameter: 2.5, inlet: [10.77], wingtip: 'split' },
  B38M: { name: 'Boeing 737 MAX 8', family: 'b737', length: 39.47, span: 35.92, height: 12.45, bodyWidth: 3.76, bodyHeight: 4.01, wingArea: 124.6, sweep: 25, tailplaneSpan: 14.35, engines: [4.82], engineDiameter: 2.5, inlet: [13], wingtip: 'split' },
  B39M: { name: 'Boeing 737 MAX 9', family: 'b737', length: 42.11, span: 35.92, height: 12.4, bodyWidth: 3.76, bodyHeight: 4.01, wingArea: 124.6, sweep: 25, tailplaneSpan: 14.35, engines: [4.82], engineDiameter: 2.5, inlet: [14.58], wingtip: 'split' },
  B3XM: { name: 'Boeing 737 MAX 10', family: 'b737', length: 43.79, span: 35.92, height: 12.45, bodyWidth: 3.76, bodyHeight: 4.01, wingArea: 124.6, sweep: 25, tailplaneSpan: 14.35, engines: [4.82], engineDiameter: 2.5, inlet: [15.6], wingtip: 'split' },
  B752: { name: 'Boeing 757-200', family: 'b757', length: 47.32, span: 41.07, height: 13.74, bodyWidth: 3.76, bodyHeight: 4.01, wingArea: 185.25, sweep: 25, tailplaneSpan: 15.21, engines: [6.48], engineDiameter: 2.4, inlet: [16.84], wingtip: 'blended' },
  B753: { name: 'Boeing 757-300', family: 'b757', length: 54.43, span: 41.07, height: 13.64, bodyWidth: 3.76, bodyHeight: 4.01, wingArea: 185.25, sweep: 25, tailplaneSpan: 15.22, engines: [6.5], engineDiameter: 2.4, inlet: [20.9], wingtip: 'blended' },
  B762: { name: 'Boeing 767-200ER', family: 'b767', length: 48.51, span: 47.57, height: 16.13, bodyWidth: 5.03, bodyHeight: 5.41, wingArea: 283.3, sweep: 31.5, tailplaneSpan: 18.62, engines: [7.92], engineDiameter: 2.7, inlet: [15.47], wingtip: 'plain' },
  B763: { name: 'Boeing 767-300ER', family: 'b767', length: 54.94, span: 47.57, height: 16.03, bodyWidth: 5.03, bodyHeight: 5.41, wingArea: 283.3, sweep: 31.5, tailplaneSpan: 18.62, engines: [7.92], engineDiameter: 2.7, inlet: [18.54], wingtip: 'plain' },
  B764: { name: 'Boeing 767-400ER', family: 'b767', length: 61.37, span: 51.92, height: 17.01, bodyWidth: 5.03, bodyHeight: 5.41, wingArea: 290.7, sweep: 31.5, tailplaneSpan: 18.62, engines: [7.92], engineDiameter: 2.7, inlet: [21.9], wingtip: 'raked' },
  B772: { name: 'Boeing 777-200ER', family: 'b777', length: 63.73, span: 60.93, height: 18.76, bodyWidth: 6.2, bodyHeight: 6.2, wingArea: 427.8, sweep: 31.6, tailplaneSpan: 21.53, engines: [9.61], engineDiameter: 3.9, inlet: [20.42], wingtip: 'plain' },
  B77L: { name: 'Boeing 777-200LR / 777F', family: 'b777', length: 63.73, span: 64.8, height: 18.75, bodyWidth: 6.2, bodyHeight: 6.2, wingArea: 436.8, sweep: 31.6, tailplaneSpan: 21.53, engines: [9.61], engineDiameter: 3.9, inlet: [20.42], wingtip: 'raked' },
  B773: { name: 'Boeing 777-300', family: 'b777', length: 73.86, span: 60.93, height: 18.76, bodyWidth: 6.2, bodyHeight: 6.2, wingArea: 427.8, sweep: 31.6, tailplaneSpan: 21.53, engines: [9.61], engineDiameter: 3.9, inlet: [25.47], wingtip: 'plain' },
  B77W: { name: 'Boeing 777-300ER', family: 'b777', length: 73.86, span: 64.8, height: 18.85, bodyWidth: 6.2, bodyHeight: 6.2, wingArea: 436.8, sweep: 31.6, tailplaneSpan: 21.53, engines: [9.61], engineDiameter: 3.9, inlet: [25.76], wingtip: 'raked' },
  B778: { name: 'Boeing 777-8', family: 'b777', length: 70.86, span: 71.76, height: 19.53, bodyWidth: 6.2, bodyHeight: 6.2, wingArea: 516.7, sweep: 30, tailplaneSpan: 24.56, engines: [10.64], engineDiameter: 4.5, inlet: [22.85], wingtip: 'raked' },
  B779: { name: 'Boeing 777-9', family: 'b777', length: 76.73, span: 71.76, height: 19.53, bodyWidth: 6.2, bodyHeight: 6.2, wingArea: 516.7, sweep: 30, tailplaneSpan: 24.56, engines: [10.64], engineDiameter: 4.5, inlet: [25.96], wingtip: 'raked' },
  B788: { name: 'Boeing 787-8', family: 'b787', length: 56.72, span: 60.12, height: 16.92, bodyWidth: 5.77, bodyHeight: 5.94, wingArea: 360, sweep: 32.2, tailplaneSpan: 19.81, engines: [9.73], engineDiameter: 3.8, inlet: [17.76], wingtip: 'raked' },
  B789: { name: 'Boeing 787-9', family: 'b787', length: 62.81, span: 60.12, height: 17.02, bodyWidth: 5.77, bodyHeight: 5.94, wingArea: 377, sweep: 32.2, tailplaneSpan: 19.81, engines: [9.91], engineDiameter: 3.8, inlet: [20.8], wingtip: 'raked' },
  B78X: { name: 'Boeing 787-10', family: 'b787', length: 68.3, span: 60.12, height: 17.02, bodyWidth: 5.77, bodyHeight: 5.94, wingArea: 377, sweep: 32.2, tailplaneSpan: 19.81, engines: [9.71], engineDiameter: 3.8, inlet: [23.85], wingtip: 'raked' },
  A332: { name: 'Airbus A330-200', family: 'a330', length: 58.82, span: 60.3, height: 17.98, bodyWidth: 5.64, bodyHeight: 5.64, wingArea: 361.6, sweep: 30, tailplaneSpan: 19.4, engines: [10.88], engineDiameter: 3.1, inlet: [18.08], wingtip: 'canted' },
  A333: { name: 'Airbus A330-300', family: 'a330', length: 63.67, span: 60.3, height: 17.18, bodyWidth: 5.64, bodyHeight: 5.64, wingArea: 361.6, sweep: 30, tailplaneSpan: 19.4, engines: [10.88], engineDiameter: 3.1, inlet: [21.28], wingtip: 'canted' },
  A338: { name: 'Airbus A330-800', family: 'a330', length: 58.82, span: 64, height: 18.29, bodyWidth: 5.64, bodyHeight: 5.64, wingArea: 465, sweep: 30, tailplaneSpan: 19.4, engines: [10.88], engineDiameter: 3.71, inlet: [17.86], wingtip: 'sharklet' },
  A339: { name: 'Airbus A330-900', family: 'a330', length: 63.66, span: 64, height: 17.13, bodyWidth: 5.64, bodyHeight: 5.64, wingArea: 465, sweep: 30, tailplaneSpan: 19.4, engines: [10.88], engineDiameter: 3.71, inlet: [21.05], wingtip: 'sharklet' },
  A359: { name: 'Airbus A350-900', family: 'a350', length: 66.8, span: 64.75, height: 17.47, bodyWidth: 5.96, bodyHeight: 6.09, wingArea: 442, sweep: 31.9, tailplaneSpan: 18.79, engines: [10.5], engineDiameter: 3.94, inlet: [21.97], wingtip: 'curved' },
  A35K: { name: 'Airbus A350-1000', family: 'a350', length: 73.79, span: 64.75, height: 17.41, bodyWidth: 5.96, bodyHeight: 6.09, wingArea: 464.3, sweep: 31.9, tailplaneSpan: 18.79, engines: [10.5], engineDiameter: 3.94, inlet: [25.78], wingtip: 'curved' },
  B744: { name: 'Boeing 747-400', family: 'b747', length: 70.67, span: 64.44, height: 19.51, bodyWidth: 6.5, bodyHeight: 7.8, wingArea: 525, sweep: 37.5, tailplaneSpan: 22.17, engines: [11.68, 21.03], engineDiameter: 2.8, inlet: [23.01, 32.16], wingtip: 'canted', upperDeck: 23.5 },
  B748: { name: 'Boeing 747-8', family: 'b747', length: 76.25, span: 68.4, height: 19.51, bodyWidth: 6.5, bodyHeight: 7.8, wingArea: 554, sweep: 37.5, tailplaneSpan: 21.99, engines: [11.93, 21.18], engineDiameter: 3.5, inlet: [27.25, 35.86], wingtip: 'raked', upperDeck: 27.6 },
  A388: { name: 'Airbus A380-800', family: 'a380', length: 72.73, span: 79.75, height: 24.27, bodyWidth: 7.14, bodyHeight: 8.41, wingArea: 845, sweep: 33.5, tailplaneSpan: 30.37, engines: [14.8, 25.7], engineDiameter: 3.9, inlet: [22.23, 29.94], wingtip: 'fence' },
  E170: { name: 'Embraer 170', family: 'ejet', length: 29.9, span: 26, height: 9.83, bodyWidth: 3.01, bodyHeight: 3.35, wingArea: 72.72, sweep: 23, tailplaneSpan: 10, engines: [4.09], engineDiameter: 1.9, inlet: [7.2], wingtip: 'blended' },
  E75L: { name: 'Embraer 175 (long wing)', family: 'ejet', length: 31.68, span: 28.65, height: 9.86, bodyWidth: 3.01, bodyHeight: 3.35, wingArea: 72.72, sweep: 23, tailplaneSpan: 10, engines: [4.09], engineDiameter: 1.9, inlet: [8.06], wingtip: 'raked' },
  E75S: { name: 'Embraer 175 (short wing)', family: 'ejet', length: 31.68, span: 26, height: 9.86, bodyWidth: 3.01, bodyHeight: 3.35, wingArea: 72.72, sweep: 23, tailplaneSpan: 10, engines: [4.09], engineDiameter: 1.9, inlet: [8.06], wingtip: 'blended' },
  E190: { name: 'Embraer 190', family: 'ejet', length: 36.24, span: 28.72, height: 10.55, bodyWidth: 3.01, bodyHeight: 3.35, wingArea: 92.5, sweep: 23, tailplaneSpan: 12.08, engines: [4.48], engineDiameter: 2.05, inlet: [11.9], wingtip: 'blended' },
  E195: { name: 'Embraer 195', family: 'ejet', length: 38.65, span: 28.72, height: 10.55, bodyWidth: 3.01, bodyHeight: 3.35, wingArea: 92.5, sweep: 23, tailplaneSpan: 12.08, engines: [4.48], engineDiameter: 2.05, inlet: [13.1], wingtip: 'blended' },
  E290: { name: 'Embraer 190-E2', family: 'ejet', length: 36.24, span: 33.72, height: 10.95, bodyWidth: 3.01, bodyHeight: 3.35, wingArea: 103, sweep: 25, tailplaneSpan: 10, engines: [4.83], engineDiameter: 2.45, inlet: [10.3], wingtip: 'raked' },
  E295: { name: 'Embraer 195-E2', family: 'ejet', length: 41.6, span: 35.12, height: 10.78, bodyWidth: 3.01, bodyHeight: 3.35, wingArea: 103, sweep: 25, tailplaneSpan: 10, engines: [4.83], engineDiameter: 2.45, inlet: [12.8], wingtip: 'raked' },
  CRJ2: { name: 'Bombardier CRJ200', family: 'crj', length: 26.77, span: 21.21, height: 6.22, bodyWidth: 2.69, bodyHeight: 2.69, wingArea: 48.35, sweep: 26.5, tailplaneSpan: 6.4, engines: [2.1], engineDiameter: 1.3, inlet: [17.3], wingtip: 'blended' },
  CRJ7: { name: 'Bombardier CRJ700', family: 'crj', length: 32.3, span: 23.2, height: 7.6, bodyWidth: 2.69, bodyHeight: 2.69, wingArea: 70.6, sweep: 26.5, tailplaneSpan: 8.54, engines: [2.29], engineDiameter: 1.55, inlet: [22.1], wingtip: 'blended' },
  CRJ9: { name: 'Bombardier CRJ900', family: 'crj', length: 36.24, span: 24.85, height: 7.35, bodyWidth: 2.69, bodyHeight: 2.69, wingArea: 71.07, sweep: 26.5, tailplaneSpan: 8.54, engines: [2.29], engineDiameter: 1.55, inlet: [26], wingtip: 'blended' },
  CRJX: { name: 'Bombardier CRJ1000', family: 'crj', length: 39.1, span: 26.2, height: 7.5, bodyWidth: 2.69, bodyHeight: 2.69, wingArea: 77.4, sweep: 26.5, tailplaneSpan: 8.54, engines: [2.29], engineDiameter: 1.55, inlet: [28.9], wingtip: 'blended' },
  AT43: { name: 'ATR 42-300/-320', family: 'atr', length: 22.67, span: 24.57, height: 7.59, bodyWidth: 2.87, bodyHeight: 2.6, wingArea: 54.5, sweep: 3, tailplaneSpan: 7.1, engines: [4.05], engineDiameter: 3.96, inlet: [7.2], wingtip: 'plain' },
  AT45: { name: 'ATR 42-500', family: 'atr', length: 22.67, span: 24.57, height: 7.59, bodyWidth: 2.87, bodyHeight: 2.6, wingArea: 54.5, sweep: 3, tailplaneSpan: 7.1, engines: [4.05], engineDiameter: 3.93, inlet: [7.2], wingtip: 'plain' },
  AT46: { name: 'ATR 42-600', family: 'atr', length: 22.67, span: 24.57, height: 7.59, bodyWidth: 2.87, bodyHeight: 2.6, wingArea: 54.5, sweep: 3, tailplaneSpan: 7.1, engines: [4.05], engineDiameter: 3.93, inlet: [7.2], wingtip: 'plain' },
  AT72: { name: 'ATR 72-200/-210', family: 'atr', length: 27.166, span: 27.05, height: 7.65, bodyWidth: 2.87, bodyHeight: 2.6, wingArea: 61, sweep: 3, tailplaneSpan: 7.1, engines: [4.05], engineDiameter: 3.93, inlet: [9.2], wingtip: 'plain' },
  AT75: { name: 'ATR 72-500', family: 'atr', length: 27.166, span: 27.05, height: 7.65, bodyWidth: 2.87, bodyHeight: 2.6, wingArea: 61, sweep: 3, tailplaneSpan: 7.1, engines: [4.05], engineDiameter: 3.93, inlet: [9.2], wingtip: 'plain' },
  AT76: { name: 'ATR 72-600', family: 'atr', length: 27.166, span: 27.05, height: 7.65, bodyWidth: 2.87, bodyHeight: 2.6, wingArea: 61, sweep: 3, tailplaneSpan: 7.1, engines: [4.05], engineDiameter: 3.93, inlet: [9.2], wingtip: 'plain' },
  DH8A: { name: 'De Havilland Canada Dash 8-100', family: 'dash8', length: 22.25, span: 25.89, height: 7.49, bodyWidth: 2.69, bodyHeight: 2.69, wingArea: 54.4, sweep: 2, tailplaneSpan: 7.92, engines: [3.95], engineDiameter: 3.96, wingtip: 'plain' },
  DH8B: { name: 'De Havilland Canada Dash 8-200', family: 'dash8', length: 22.25, span: 25.89, height: 7.49, bodyWidth: 2.69, bodyHeight: 2.69, wingArea: 54.4, sweep: 2, tailplaneSpan: 7.92, engines: [3.95], engineDiameter: 3.96, wingtip: 'plain' },
  DH8C: { name: 'De Havilland Canada Dash 8-300', family: 'dash8', length: 25.68, span: 27.43, height: 7.49, bodyWidth: 2.69, bodyHeight: 2.69, wingArea: 56.2, sweep: 2, tailplaneSpan: 7.92, engines: [3.95], engineDiameter: 3.96, wingtip: 'plain' },
  DH8D: { name: 'De Havilland Canada Dash 8-400', family: 'dash8', length: 32.83, span: 28.42, height: 8.34, bodyWidth: 2.69, bodyHeight: 2.69, wingArea: 64, sweep: 2, tailplaneSpan: 9.2, engines: [4.35], engineDiameter: 4.11, inlet: [11.3], wingtip: 'plain' },
} satisfies Record<string, Airframe>;

export type AircraftType = keyof typeof AIRCRAFT_TYPES;
export const AIRCRAFT_DESIGNATORS = Object.keys(AIRCRAFT_TYPES) as AircraftType[];

export const isAircraftType = (v: unknown): v is AircraftType =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(AIRCRAFT_TYPES, v);

export const airframe = (type: AircraftType): Airframe => AIRCRAFT_TYPES[type];
