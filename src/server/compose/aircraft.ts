import { AIRCRAFT_DESIGNATORS, AIRCRAFT_TYPES, type AircraftType, isAircraftType } from '../../shared/scene/aircraft';

/** The 3-character IATA codes booking sites show, for the supported types (IATA SSIM Appendix A). */
const IATA_CODES: Record<string, AircraftType> = {
  '221': 'BCS1', '223': 'BCS3', '318': 'A318', '319': 'A319', '320': 'A320', '321': 'A321',
  '31N': 'A19N', '32N': 'A20N', '32Q': 'A21N', '73G': 'B737', '738': 'B738', '73H': 'B738', '739': 'B739',
  '7M7': 'B37M', '7M8': 'B38M', '7M9': 'B39M', '752': 'B752', '753': 'B753', '762': 'B762', '763': 'B763',
  '764': 'B764', '772': 'B772', '77L': 'B77L', '773': 'B773', '77W': 'B77W', '778': 'B778', '779': 'B779',
  '788': 'B788', '789': 'B789', '781': 'B78X', '332': 'A332', '333': 'A333', '338': 'A338', '339': 'A339',
  '359': 'A359', '351': 'A35K', '744': 'B744', '74H': 'B748', '388': 'A388', 'E70': 'E170', 'E90': 'E190',
  'E95': 'E195', '290': 'E290', '295': 'E295', 'CR2': 'CRJ2', 'CR7': 'CRJ7', 'CR9': 'CRJ9', 'CRK': 'CRJX',
  'DH1': 'DH8A', 'DH2': 'DH8B', 'DH3': 'DH8C', 'DH4': 'DH8D',
};

const MAKERS = /\b(airbus|boeing|embraer|bombardier|de havilland( canada)?|dhc|atr aircraft|dreamliner|jumbo|superjumbo|aircraft|jet)\b/g;
const squash = (s: string) =>
  s.toLowerCase().replace(MAKERS, '').replace(/\bq(?=\d00\b)/, 'dash8-').replace(/[^a-z0-9]/g, '')
    // "B787-9" and "E175" are common shorthand for "787-9" and "175".
    .replace(/^b(?=7\d7)/, '').replace(/^(e|erj)(?=1\d\d)/, '');

const NAMES = AIRCRAFT_DESIGNATORS.map((code) => [code, squash(AIRCRAFT_TYPES[code].name)] as const);

/**
 * Whether the aircraft as the model wrote it appears in the itinerary (a guard against made-up types), as written or
 * as the type's ICAO or IATA code ("Boeing 737-900ER" for "B739").
 */
export function writtenIn(aircraft: string, text: string): boolean {
  const core = squash(aircraft);
  if (core.length > 0 && squash(text).includes(core)) return true;
  const m = matchAircraft(aircraft);
  if (!m || !('type' in m)) return false;
  const codes = [m.type, ...Object.keys(IATA_CODES).filter((k) => IATA_CODES[k] === m.type)];
  return codes.some((c) => new RegExp(`\\b${c}\\b`, 'i').test(text));
}

export type AircraftMatch = { type: AircraftType } | { options: AircraftType[] } | null;

/**
 * Map an aircraft type as a person wrote it to a supported ICAO designator. A family name that fits several types
 * ("A350", "787") returns them as options to ask about; anything else unrecognised returns null.
 */
export function matchAircraft(written: string): AircraftMatch {
  const raw = written.trim();
  const upper = raw.toUpperCase();
  if (isAircraftType(upper)) return { type: upper };
  if (IATA_CODES[upper]) return { type: IATA_CODES[upper]! };
  const key = squash(raw);
  if (!key) return null;
  const exact = NAMES.filter(([, n]) => n === key);
  if (exact.length === 1) return { type: exact[0]![0] };
  const prefix = NAMES.filter(([, n]) => n.startsWith(key));
  if (prefix.length === 1) return { type: prefix[0]![0] };
  if (prefix.length > 1) return { options: prefix.map(([c]) => c) };
  return null;
}
