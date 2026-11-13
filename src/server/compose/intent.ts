/**
 * The model's whole job: copy an itinerary into this small "intent" structure. Places stay as written (with the
 * model's IATA code beside them), dates and times stay local and as written. Everything else, from time zones and
 * UTC offsets to arrival dates, aircraft designators and the questions to ask, is worked out in resolve.ts.
 */

export const LEG_MODES = ['flight', 'train', 'bus', 'car', 'ferry'] as const;
export type LegMode = (typeof LEG_MODES)[number];

export interface IntentLeg {
  mode: LegMode;
  from: string;
  fromCode: string | null;
  to: string;
  toCode: string | null;
  /** "YYYY-MM-DD"; year 0000 when the text gives none. */
  departDate: string | null;
  /** Local "HH:MM". */
  departTime: string | null;
  arriveDate: string | null;
  arriveTime: string | null;
  flight: string | null;
  /** The aircraft type as written ("787-9", "A380", "73H"). */
  aircraft: string | null;
}

export interface Intent {
  legs: IntentLeg[];
}

const str = { type: 'string' } as const;
const strOrNull = { type: ['string', 'null'] } as const;

/** JSON Schema for structured output. Kept to what every provider's constrained decoding accepts. */
export const INTENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['legs'],
  properties: {
    legs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['mode', 'from', 'fromCode', 'to', 'toCode', 'departDate', 'departTime', 'arriveDate', 'arriveTime', 'flight', 'aircraft'],
        properties: {
          mode: { type: 'string', enum: [...LEG_MODES] },
          from: str,
          fromCode: strOrNull,
          to: str,
          toCode: strOrNull,
          departDate: strOrNull,
          departTime: strOrNull,
          arriveDate: strOrNull,
          arriveTime: strOrNull,
          flight: strOrNull,
          aircraft: strOrNull,
        },
      },
    },
  },
} as const;

export const SYSTEM_PROMPT = `You turn a traveller's itinerary into JSON for an animated map of the journey. Copy only what the text states. Never guess a time, date, airport or aircraft: use null when the text doesn't give it.

Return {"legs": [...]}, one entry per leg in travel order:
- mode: "flight", or for travel on the ground or water "train", "bus", "car" or "ferry" (tram or metro = train, coach or shuttle = bus, boat = ferry, a drive or taxi = car).
- from, to: the place as the text names it.
- fromCode, toCode: the airport's 3-letter IATA code. For a train, bus, car or ferry leg, the code of the airport nearest that station, port or town. Use null if unsure, or if a flight's city has several major airports (such as London, New York, Tokyo or Paris) and the text doesn't say which.
- departDate: "YYYY-MM-DD", as stated or clearly implied for a later leg ("then", "the next day"). If the text gives no year, write the year as 0000.
- arriveDate: only if the text states it ("+1", "next morning", a date); otherwise null.
- departTime, arriveTime: local 24-hour "HH:MM".
- flight: the flight number, such as "QF93".
- aircraft: the aircraft type exactly as written, such as "787-9", "A380", "Boeing 777-300ER" or "73H". Never infer it from the airline or flight number.

A flight "via" a city, or with a stop, is two legs. Leave out hotels, car rental pickups, names, booking codes, seats and prices.

The input may be a conversation: the traveller's messages, and questions Route Replay asked. Combine the traveller's messages into one itinerary; an answer fills in what its question asked about, and a later message corrects an earlier one.`;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * What the model reads: one message as it is (as evaluated), or a conversation as a labelled transcript, so
 * an answer like "Heathrow" resolves against the question it answers.
 */
export function modelInput(messages: ChatMessage[]): string {
  if (messages.length === 1) return messages[0]!.content;
  return messages.map((m) => `${m.role === 'user' ? 'Traveller' : 'Route Replay'}: ${m.content.trim()}`).join('\n\n');
}

/** Only what the traveller wrote: the resolver's guards check that a year, code or aircraft appears here. */
export function travellerText(messages: ChatMessage[]): string {
  return messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
}

/** A year of 0000 means the text gives none; month or day 00 means no date at all. */
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** Accept the model's JSON only in the expected shape; malformed fields become null rather than errors. */
export function parseIntent(raw: unknown): Intent | null {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as Intent).legs)) return null;
  const s = (v: unknown, re?: RegExp): string | null => {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    if (!t || /^(null|unknown|n\/a)$/i.test(t)) return null;
    return re && !re.test(t) ? null : t;
  };
  const legs: IntentLeg[] = [];
  for (const l of (raw as { legs: unknown[] }).legs) {
    if (typeof l !== 'object' || l === null) continue;
    const r = l as Record<string, unknown>;
    const mode = (LEG_MODES as readonly unknown[]).includes(r.mode) ? (r.mode as LegMode) : 'flight';
    const time = (v: unknown) => {
      const t = s(v, TIME_RE);
      return t && t.length === 4 ? `0${t}` : t;
    };
    legs.push({
      mode,
      from: s(r.from) ?? '',
      fromCode: s(r.fromCode)?.toUpperCase() ?? null,
      to: s(r.to) ?? '',
      toCode: s(r.toCode)?.toUpperCase() ?? null,
      departDate: s(r.departDate, DATE_RE),
      departTime: time(r.departTime),
      arriveDate: s(r.arriveDate, DATE_RE),
      arriveTime: time(r.arriveTime),
      flight: s(r.flight),
      aircraft: s(r.aircraft),
    });
  }
  return { legs };
}
