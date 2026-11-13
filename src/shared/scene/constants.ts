/**
 * Versioned contract constants. Changing a limit or preset here changes the public
 * contract: update the JSON Schema (generated from schema.ts), agent docs, and tests together.
 */
export const SCHEMA_VERSION = 1 as const;
export const SUPPORTED_SCHEMA_VERSIONS = [1] as const;

/** Renderer semantic version pinned into every normalized record and publication. */
export const RENDERER_VERSION = '2.2.0';
/** Version of the static asset bundle (textures, fonts) under /assets. */
export const ASSET_MANIFEST_VERSION = '2026-11-12';

export const LIMITS = {
  /** Maximum request body for create/replace, in bytes. */
  maxPayloadBytes: 64 * 1024,
  maxLegs: 12,
  maxTitleLength: 80,
  maxLegIdLength: 32,
  minDurationSeconds: 4,
  maxDurationSeconds: 120,
  /** Every flight must receive at least this much presentation time. */
  minLegSeconds: 1,
  maxStartEndHoldSeconds: 10,
  maxStopHoldSeconds: 20,
  minLegWeight: 0.1,
  maxLegWeight: 10,
  /** Flight block time bounds (minutes). */
  minFlightMinutes: 10,
  maxFlightMinutes: 30 * 60,
  /** Longest train, bus, car, or ferry leg (minutes): a week, enough for the longest scheduled rail journeys. */
  maxSurfaceMinutes: 7 * 24 * 60,
  /** Whole journey span from first departure to last arrival. */
  maxJourneyDays: 366,
  earliestYear: 1950,
  latestYear: 2100,
  maxSeed: 2_147_483_647,
} as const;

/**
 * Time keeps running through the start and end holds: from this many minutes before departure, and on to this many
 * after arrival. The Sun, Moon, stars, and clouds share this one clock (the offline renderer advances only its
 * weather there, which leaves the Sun frozen while clouds move).
 */
export const HOLD_MINUTES = 20;

export const DEFAULTS = {
  // The offline renderer's defaults (routereplay trip.py).
  startHoldSeconds: 1.6,
  endHoldSeconds: 2.7,
  stopHoldSeconds: 1.3,
  /** Default flight time per leg when durationSeconds is omitted. */
  secondsPerLeg: 6,
  minFlightSeconds: 6,
  /**
   * Floor on a surface leg's default weight. Ground legs are short beside the flights around them, so the
   * distance-based default would flash a ferry crossing past in a second.
   */
  minSurfaceWeight: 0.5,
  weather: 'clouds',
  style: 'standard',
  seed: 1,
} as const;

/**
 * Advisory warning thresholds (plan 2, A3). Warnings never block saving; they point the agent at
 * likely mistakes. Tuned against the itinerary corpus in tests/warnings.test.ts.
 */
export const WARNING_THRESHOLDS = {
  /** Gate-to-gate average speed bounds (great-circle km per block hour). */
  minAverageKmh: 250,
  maxAverageKmh: 1050,
  /** Slow averages are flagged only above this block time, so short hops with long taxi times pass. */
  slowCheckMinBlockMinutes: 180,
  /** Surface legs: faster than high-speed rail over the great-circle distance, or slower than walking pace. */
  surfaceMaxAverageKmh: 350,
  surfaceMinAverageKmh: 5,
  surfaceSlowCheckMinBlockMinutes: 12 * 60,
  /** Longer than the longest scheduled nonstops, but within the validation limit. */
  longBlockMinutes: 19.5 * 60,
  minScreenSeconds: 2,
  /** A stop compresses more than this many real hours into each second on screen (routereplay's rule). */
  maxLayoverHoursPerSecond: 24,
  maxYearsFromToday: 2,
} as const;

/**
 * Ways to travel a leg on the ground or water. Each mode draws its own vehicle moving along the ground
 * (src/app/render/vehicles.ts), and names the leg in the route summary and storyboards.
 */
export const SURFACE_MODES = ['train', 'bus', 'car', 'ferry'] as const;

export const ASPECT_RATIOS = ['16:9', '9:16', '1:1'] as const;
export const WEATHER_TREATMENTS = ['clouds', 'omitted'] as const;
export const STYLE_PRESETS = ['standard'] as const;

export type AspectRatio = (typeof ASPECT_RATIOS)[number];
export type WeatherTreatment = (typeof WEATHER_TREATMENTS)[number];
export type StylePreset = (typeof STYLE_PRESETS)[number];
export type SurfaceMode = (typeof SURFACE_MODES)[number];

export const LEG_ID_PATTERN = '^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$';
export const AIRPORT_CODE_PATTERN = '^[A-Z]{3}$';
export const TIMESTAMP_PATTERN =
  '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d{1,3})?)?(Z|[+-]\\d{2}:\\d{2})$';

/** Export/render dimensions for each aspect ratio at the 720p baseline. */
export const RENDER_SIZES: Record<AspectRatio, { width: number; height: number }> = {
  '16:9': { width: 1280, height: 720 },
  '9:16': { width: 720, height: 1280 },
  '1:1': { width: 960, height: 960 },
};
export const FPS = 30;
