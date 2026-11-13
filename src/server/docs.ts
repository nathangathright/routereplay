/** Agent-facing documents rendered from the single workflow source with the deployment origin. */
import { AIRCRAFT_DESIGNATORS, AIRCRAFT_TYPES } from '../shared/scene/aircraft';
import { ASSET_MANIFEST_VERSION, DEFAULTS, LIMITS, SURFACE_MODES, WARNING_THRESHOLDS } from '../shared/scene/constants';
import { EXAMPLE_SCENE } from '../shared/scene/examples';
import { sceneSchemaV1 } from '../shared/scene/schema';
import { ACKNOWLEDGMENTS_TXT, DOCS_VERSION, FAQ_TXT, REFERENCE_MD, WORKFLOW_MD } from './generated/content';
import { DRAFT_RETENTION_DAYS, REVISIONS_KEPT, SESSION_DAYS } from './store';

export { DOCS_VERSION };

function fill(text: string, origin: string): string {
  const values: Record<string, string> = {
    ORIGIN: origin,
    EXAMPLE_JSON: JSON.stringify(EXAMPLE_SCENE, null, 2),
    REVISIONS_KEPT: String(REVISIONS_KEPT),
    MAX_LEGS: String(LIMITS.maxLegs),
    AIRCRAFT_LIST: AIRCRAFT_DESIGNATORS.map((t) => `\`${t}\` ${AIRCRAFT_TYPES[t].name}`).join(', '),
    MIN_FLIGHT_MINUTES: String(LIMITS.minFlightMinutes),
    MAX_FLIGHT_HOURS: String(LIMITS.maxFlightMinutes / 60),
    MAX_SURFACE_DAYS: String(LIMITS.maxSurfaceMinutes / (24 * 60)),
    SURFACE_MODES: SURFACE_MODES.map((m) => `\`${m}\``).join(', '),
    MIN_SURFACE_WEIGHT: String(DEFAULTS.minSurfaceWeight),
    MAX_JOURNEY_DAYS: String(LIMITS.maxJourneyDays),
    MIN_DURATION: String(LIMITS.minDurationSeconds),
    MAX_DURATION: String(LIMITS.maxDurationSeconds),
    MIN_LEG_SECONDS: String(LIMITS.minLegSeconds),
    MIN_WEIGHT: String(LIMITS.minLegWeight),
    MAX_WEIGHT: String(LIMITS.maxLegWeight),
    MAX_STOP_HOLD: String(LIMITS.maxStopHoldSeconds),
    MAX_END_HOLD: String(LIMITS.maxStartEndHoldSeconds),
    MAX_TITLE: String(LIMITS.maxTitleLength),
    MAX_PAYLOAD_KIB: String(LIMITS.maxPayloadBytes / 1024),
    DRAFT_RETENTION_DAYS: String(DRAFT_RETENTION_DAYS),
    DOCS_VERSION,
    WARN_MIN_KMH: WARNING_THRESHOLDS.minAverageKmh.toLocaleString('en-US'),
    WARN_MAX_KMH: WARNING_THRESHOLDS.maxAverageKmh.toLocaleString('en-US'),
    WARN_SLOW_HOURS: String(WARNING_THRESHOLDS.slowCheckMinBlockMinutes / 60),
    WARN_SURFACE_MAX_KMH: String(WARNING_THRESHOLDS.surfaceMaxAverageKmh),
    WARN_SURFACE_MIN_KMH: String(WARNING_THRESHOLDS.surfaceMinAverageKmh),
    WARN_SURFACE_SLOW_HOURS: String(WARNING_THRESHOLDS.surfaceSlowCheckMinBlockMinutes / 60),
    WARN_LONG_HOURS: String(WARNING_THRESHOLDS.longBlockMinutes / 60),
    WARN_SCREEN_SECONDS: String(WARNING_THRESHOLDS.minScreenSeconds),
    WARN_LAYOVER_RATE: String(WARNING_THRESHOLDS.maxLayoverHoursPerSecond),
    WARN_YEARS: String(WARNING_THRESHOLDS.maxYearsFromToday),
  };
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => values[k] ?? m);
}

export function agentDocs(origin: string): string {
  const intro = `# Route Replay agent instructions

Docs version ${DOCS_VERSION}, scene schema v1. Endpoints: ${origin}/api/v1. Schema: ${origin}/schemas/scene-v1.json.

`;
  return fill(intro + WORKFLOW_MD + '\n' + REFERENCE_MD, origin);
}

/** Credits for the imagery, data, and software the site uses, as plain text (src/server/acknowledgments.txt). */
export function acknowledgments(origin: string): string {
  return ACKNOWLEDGMENTS_TXT.replace(/\{\{ORIGIN\}\}/g, origin).replace(/\{\{ASSET_VERSION\}\}/g, ASSET_MANIFEST_VERSION);
}

/**
 * Questions and answers for people using the site, as plain text (src/server/faq.txt): what happens to the text
 * typed into the chat, who can see a draft, where the routes and clouds come from.
 */
export function faq(origin: string): string {
  const values: Record<string, string> = { ORIGIN: origin, SESSION_DAYS: String(SESSION_DAYS), DRAFT_RETENTION_DAYS: String(DRAFT_RETENTION_DAYS) };
  return FAQ_TXT.replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => values[k] ?? m);
}

export function llmsTxt(origin: string): string {
  return `# Route Replay

> Turn a flight itinerary into an animated journey on a 3D Earth, authored by your own agent over HTTP.

- [Agent instructions](${origin}/agent-docs): workflow, endpoints, errors, limits
- [Scene schema v1](${origin}/schemas/scene-v1.json): JSON Schema for the scene spec
- [API index](${origin}/api/v1)
`;
}

export function schemaJson(origin: string): string {
  return JSON.stringify({ ...sceneSchemaV1, $id: `${origin}/schemas/scene-v1.json` }, null, 2) + '\n';
}
