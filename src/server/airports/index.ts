import type { Airport } from '../../shared/scene/types';
import data from './airports.json';

type Row = [string, string, string, string, number, number, string];

let index: Map<string, Airport> | null = null;

function build(): Map<string, Airport> {
  const m = new Map<string, Airport>();
  for (const r of data.rows as unknown as Row[]) {
    const [code, name, city, country, lat, lon, timeZone] = r;
    m.set(code, { code, name, city, country, lat, lon, timeZone });
  }
  return m;
}

export const AIRPORT_DATA_VERSION: string = data.version;

export function lookupAirport(code: string): Airport | undefined {
  index ??= build();
  return index.get(code);
}

export function airportCount(): number {
  index ??= build();
  return index.size;
}
