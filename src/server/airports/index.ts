import type { Airport } from '../../shared/scene/types';
import { AIRPORT_DATA_VERSION, AIRPORT_LINES } from '../generated/airports';

export { AIRPORT_DATA_VERSION };

/**
 * Finds an airport by binary search over the table's text (generated from airports.json, one line per airport
 * in code order). As one string the table costs nothing to load and gives the garbage collector nothing to trace;
 * as thousands of objects it cost the first save in each Worker isolate several milliseconds of CPU.
 */
export function lookupAirport(code: string): Airport | undefined {
  const text = AIRPORT_LINES;
  let lo = 0; // always the start of a line
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const start = text.lastIndexOf('\n', mid - 1) + 1;
    const end = text.indexOf('\n', start);
    const key = text.slice(start, start + 3);
    if (key === code) {
      const [, name, city, country, lat, lon, timeZone] = text.slice(start, end).split('\t') as string[];
      return { code, name: name!, city: city!, country: country!, lat: Number(lat), lon: Number(lon), timeZone: timeZone! };
    }
    if (key < code) lo = end + 1;
    else hi = start;
  }
  return undefined;
}

let lowerLines: string | undefined;
const isWordChar = (c: number) => (c >= 97 && c <= 122) || (c >= 48 && c <= 57);

/**
 * Airports whose name or city contains `word` (lowercase letters and digits, accents removed) as a whole word.
 * Searches a lower-cased, accent-free copy of the table text ("cancun" finds Cancún), made once per isolate in about
 * 2 ms, with indexOf: a regular expression over the table took 1–2 ms per search.
 */
export function searchAirports(word: string): Airport[] {
  const text = (lowerLines ??= AIRPORT_LINES.replace(/[^\x00-\x7f]+/g, (m) => m.normalize('NFD').replace(/[\u0300-\u036f]/g, '')).toLowerCase());
  const out: Airport[] = [];
  let lastLine = -1;
  for (let i = text.indexOf(word); i >= 0; i = text.indexOf(word, i + word.length)) {
    if (isWordChar(text.charCodeAt(i - 1)) || isWordChar(text.charCodeAt(i + word.length))) continue;
    const start = text.lastIndexOf('\n', i) + 1;
    if (start === lastLine) continue;
    // Only the name (after the first tab) and city (after the second) count, not the country or time zone.
    const firstTab = text.indexOf('\t', start);
    const thirdTab = text.indexOf('\t', text.indexOf('\t', firstTab + 1) + 1);
    if (i < firstTab || i > thirdTab) continue;
    lastLine = start;
    const airport = lookupAirport(text.slice(start, start + 3).toUpperCase());
    if (airport) out.push(airport);
  }
  return out;
}
