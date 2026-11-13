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
