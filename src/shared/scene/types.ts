import type { AircraftType } from './aircraft';
import type { StylePreset, WeatherTreatment } from './constants';

/** Authoring spec as an agent submits it (schema version 1). */
export interface SceneSpecV1 {
  schemaVersion: 1;
  title?: string;
  legs: LegSpec[];
  presentation?: PresentationSpec;
  environment?: { weather?: WeatherTreatment };
  assets?: { style?: StylePreset };
  seed?: number;
}

export interface LegSpec {
  id: string;
  from: string;
  to: string;
  departure: string;
  arrival: string;
  /** ICAO type designator, e.g. "B38M". */
  aircraft: string;
}

export interface PresentationSpec {
  durationSeconds?: number;
  legWeights?: Record<string, number>;
  stopHolds?: Record<string, number>;
  startHoldSeconds?: number;
  endHoldSeconds?: number;
}

export interface Airport {
  code: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  timeZone: string;
}

export interface NormalizedLeg {
  id: string;
  from: string;
  to: string;
  departureUtc: string;
  arrivalUtc: string;
  departureLocal: string;
  arrivalLocal: string;
  aircraft: AircraftType;
  /** Great-circle distance in kilometers (spherical Earth). */
  distanceKm: number;
  /** Resolved relative share of flight presentation time. */
  weight: number;
  /** Presentation seconds assigned to this flight. */
  flightSeconds: number;
  /** Hold at this leg's arrival airport before the next leg (0 for the final leg). */
  holdAfterSeconds: number;
}

/** Normalized record derived by the service. This is what the renderer consumes. */
export interface NormalizedSceneV1 {
  schemaVersion: 1;
  title: string | null;
  airports: Record<string, Airport>;
  legs: NormalizedLeg[];
  presentation: {
    durationSeconds: number;
    startHoldSeconds: number;
    endHoldSeconds: number;
    fps: number;
  };
  /**
   * `cloudRun` is the GFS model run (YYYYMMDDHH) pinned when the revision was saved, so a published journey
   * always draws the same clouds. Present only with `weather: 'clouds'`.
   */
  environment: { weather: WeatherTreatment; cloudRun?: string };
  assets: { style: StylePreset };
  seed: number;
  compatibility: {
    schemaVersion: 1;
    rendererVersion: string;
    assetManifestVersion: string;
    airportDataVersion: string;
  };
}

export interface ValidationIssue {
  /** JSON Pointer to the offending value, e.g. /legs/1/departure. "" means the document root. */
  path: string;
  code: IssueCode;
  message: string;
  hint?: string;
}

export type IssueCode =
  | 'invalid_json'
  | 'type'
  | 'required'
  | 'unknown_field'
  | 'unsupported_version'
  | 'unsupported_preset'
  | 'unsupported_aircraft'
  | 'pattern'
  | 'too_long'
  | 'too_many'
  | 'too_few'
  | 'out_of_range'
  | 'not_finite'
  | 'not_integer'
  | 'timestamp_format'
  | 'invalid_date'
  | 'offset_mismatch'
  | 'unknown_airport'
  | 'duplicate_leg_id'
  | 'unknown_leg_reference'
  | 'hold_on_final_leg'
  | 'disconnected_legs'
  | 'same_airport'
  | 'antipodal_route'
  | 'arrival_not_after_departure'
  | 'overlapping_legs'
  | 'flight_duration'
  | 'journey_too_long'
  | 'duration_budget';

export type ValidationResult =
  | { ok: true; spec: SceneSpecV1; normalized: NormalizedSceneV1 }
  | { ok: false; issues: ValidationIssue[] };

export type AirportLookup = (code: string) => Airport | undefined;
