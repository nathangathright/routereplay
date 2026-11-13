/** Plain-language lines for a composed journey, shown to the person before they create the draft. */
import { AIRCRAFT_TYPES, isAircraftType } from '../../shared/scene/aircraft';
import type { LegSpec } from '../../shared/scene/types';

export interface LegSummary {
  /** "Melbourne (MEL) → San Francisco (SFO)" */
  route: string;
  /** Local times: "Fri 5 Mar 2027, 10:15 → 06:05", or with the arrival day when it differs. */
  when: string;
  /** "Boeing 787-9", or "Train", "Bus", "Car", "Ferry". */
  by: string;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The local wall date and time written in a timestamp such as 2027-03-05T10:15:00+11:00. */
function wall(ts: string) {
  const [y, m, d] = ts.slice(0, 10).split('-').map(Number) as [number, number, number];
  return { date: ts.slice(0, 10), day: `${DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MONTHS[m - 1]}`, year: y, time: ts.slice(11, 16) };
}

/** An airport as the person wrote it, with its code; a bare code gets the airport's name instead. */
function place(written: string, code: string, airports: Record<string, string>): string {
  const label = written && written.toUpperCase() !== code ? written : (airports[code] ?? code).replace(/\s+(International\s+)?Airport$/i, '');
  return `${label} (${code})`;
}

export function summarize(legs: LegSpec[], places: { from: string; to: string }[], airports: Record<string, string>): LegSummary[] {
  return legs.map((leg, i) => {
    const dep = wall(leg.departure);
    const arr = wall(leg.arrival);
    const arrival = arr.date === dep.date ? arr.time : `${arr.day}, ${arr.time}`;
    const by = leg.aircraft && isAircraftType(leg.aircraft) ? AIRCRAFT_TYPES[leg.aircraft].name : `${leg.mode![0]!.toUpperCase()}${leg.mode!.slice(1)}`;
    return {
      route: `${place(places[i]?.from ?? '', leg.from, airports)} → ${place(places[i]?.to ?? '', leg.to, airports)}`,
      when: `${dep.day} ${dep.year}, ${dep.time} → ${arrival}`,
      by,
    };
  });
}
