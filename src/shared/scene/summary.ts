/** Plain-language lines for a journey, shown in the homepage chat and the draft's sidebar. */
import { AIRCRAFT_TYPES, isAircraftType } from './aircraft';
import type { LegSpec, NormalizedSceneV1 } from './types';

export interface LegSummary {
  /** "Melbourne (MEL) → San Francisco (SFO)" */
  route: string;
  /** Local times: "Fri 5 Mar 2027, 10:15 → 06:05", or with the arrival day when it differs. */
  when: string;
  /** "Boeing 787-9", or "Train", "Bus", "Car", "Ferry". */
  by: string;
  /** The text didn't name this aircraft: it's a typical one for the distance, or the family's most common type. */
  typical?: true;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The local wall date and time written in a timestamp such as 2027-03-05T10:15:00+11:00. */
function wall(ts: string) {
  const [y, m, d] = ts.slice(0, 10).split('-').map(Number) as [number, number, number];
  return { date: ts.slice(0, 10), day: `${DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MONTHS[m - 1]}`, year: y, time: ts.slice(11, 16) };
}

/** "Sat 17 Oct 2026" for a date whose year is known, "17 Oct" when it isn't (the weekday depends on it). */
export function dayLabel(date: string, withYear: boolean): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return withYear ? `${DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MONTHS[m - 1]} ${y}` : `${d} ${MONTHS[m - 1]}`;
}

/** Whether a place as written already shows the code: "Chicago (ORD)". */
export const showsCode = (written: string, code: string) => new RegExp(`\\b${code}\\b`).test(written);

/** An airport as the person wrote it, with its code; a bare code gets the airport's name instead. */
function place(written: string, code: string, airports: Record<string, string>): string {
  if (written && written.toUpperCase() !== code && showsCode(written, code)) return written;
  const label = written && written.toUpperCase() !== code ? written : (airports[code] ?? code).replace(/\s+(International\s+)?Airport$/i, '');
  return `${label} (${code})`;
}

export function summarize(legs: LegSpec[], places: { from: string; to: string }[], airports: Record<string, string>, assumed: string[] = []): LegSummary[] {
  return legs.map((leg, i) => {
    const dep = wall(leg.departure);
    const arr = wall(leg.arrival);
    const arrival = arr.date === dep.date ? arr.time : `${arr.day}, ${arr.time}`;
    const by = leg.aircraft && isAircraftType(leg.aircraft) ? AIRCRAFT_TYPES[leg.aircraft].name : leg.mode ? `${leg.mode[0]!.toUpperCase()}${leg.mode.slice(1)}` : 'Flight';
    return {
      route: `${place(places[i]?.from ?? '', leg.from, airports)} → ${place(places[i]?.to ?? '', leg.to, airports)}`,
      when: `${dep.day} ${dep.year}, ${dep.time} → ${arrival}`,
      by,
      ...(assumed.includes(`${i}.aircraft`) ? { typical: true as const } : {}),
    };
  });
}

/** The same lines for a saved journey, with each airport named by its city. */
export function sceneSummary(scene: NormalizedSceneV1): LegSummary[] {
  const legs = scene.legs.map((l) => ({ id: l.id, from: l.from, to: l.to, departure: l.departureLocal, arrival: l.arrivalLocal, aircraft: l.aircraft, mode: l.mode }));
  const city = (code: string) => scene.airports[code]?.city ?? '';
  const names = Object.fromEntries(Object.values(scene.airports).map((a) => [a.code, a.name]));
  return summarize(legs, legs.map((l) => ({ from: city(l.from), to: city(l.to) })), names);
}
