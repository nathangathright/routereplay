import { describe, expect, it } from 'vitest';
import { AIRPORT_DATA_VERSION, lookupAirport, searchAirports } from '../src/server/airports';
import { matchAircraft, writtenIn } from '../src/server/compose/aircraft';
import { type IntentLeg, parseIntent } from '../src/server/compose/intent';
import { resolveIntent } from '../src/server/compose/resolve';
import { sceneSummary, summarize } from '../src/shared/scene/summary';
import { validateScene } from '../src/shared/scene/validate';

const opts = { lookupAirport, searchAirports, airportDataVersion: AIRPORT_DATA_VERSION, now: Date.parse('2026-11-12T00:00:00Z') };
const leg = (l: Partial<IntentLeg>): IntentLeg => ({
  mode: 'flight', from: '', fromCode: null, to: '', toCode: null, departDate: null, departTime: null,
  arriveDate: null, arriveTime: null, flight: null, aircraft: null, ...l,
});
const fields = (r: ReturnType<typeof resolveIntent>) => r.questions.flatMap((q) => q.fields);

describe('compose resolver', () => {
  it('fills offsets and works out an arrival date across the date line', () => {
    const r = resolveIntent(
      // The model's next-day arrival date is wrong; for a flight the times decide.
      { legs: [leg({ from: 'Auckland', fromCode: 'AKL', to: 'Honolulu', toCode: 'HNL', departDate: '2027-01-20', departTime: '23:05', arriveDate: '2027-01-21', arriveTime: '08:45', aircraft: '787-9' })] },
      'On 20 January 2027 we flew Auckland to Honolulu, leaving at 11:05pm and landing at 8:45am, on a 787-9.',
      opts,
    );
    expect(r.questions).toEqual([]);
    expect(r.complete).toBe(true);
    expect(r.spec.legs[0]).toMatchObject({ id: 'akl-hnl', departure: '2027-01-20T23:05:00+13:00', arrival: '2027-01-20T08:45:00-10:00', aircraft: 'B789' });
  });

  it('crosses a daylight-saving change overnight', () => {
    const r = resolveIntent(
      { legs: [leg({ from: 'LAX', to: 'JFK', departDate: '2027-03-13', departTime: '23:00', arriveTime: '07:55', aircraft: 'Boeing 757-200' })] },
      'LAX to JFK 13 March 2027 23:00-07:55, Boeing 757-200',
      opts,
    );
    expect(r.spec.legs[0]).toMatchObject({ departure: '2027-03-13T23:00:00-08:00', arrival: '2027-03-14T07:55:00-04:00', aircraft: 'B752' });
  });

  it('asks instead of inventing airports, dates and times, one question per leg', () => {
    const r = resolveIntent(
      { legs: [leg({ from: 'London', fromCode: 'LHR', to: 'New York', departTime: '15:00' }), leg({ from: 'SFO', to: 'ORD' })] },
      'London to New York at 3pm, then SFO to ORD',
      opts,
    );
    expect(r.complete).toBe(false);
    expect(r.questions).toHaveLength(2);
    expect(fields(r)).toEqual(['0.from', '0.to', '0.departure', '0.arrival', '1.departure', '1.arrival']);
    expect(r.questions[0]!.needs[0]).toBe('which London airport');
    expect(r.questions[0]!.choices).toEqual([
      { need: 0, options: ['Heathrow (LHR)', 'Gatwick (LGW)', 'Stansted (STN)', 'Luton (LTN)', 'London City (LCY)', 'Southend (SEN)'] },
      { need: 1, options: ['John F. Kennedy (JFK)', 'Newark Liberty (EWR)', 'LaGuardia (LGA)'] },
    ]);
    expect(r.questions[0]!.question).toContain('which London airport: Heathrow (LHR), Gatwick (LGW), Stansted (STN), Luton (LTN), London City (LCY), Southend (SEN)');
    expect(r.questions[1]).toMatchObject({ leg: 1, about: 'Flight, SFO → ORD', needs: ['date', 'local departure and arrival times'], lookup: true });
    expect(r.questions[1]!.question).toBe('Flight, SFO → ORD: date; local departure and arrival times');
    // The aircraft is never a question: an unnamed one is a typical type for the distance.
    expect(r.spec.legs[1]).toEqual({ from: 'SFO', to: 'ORD', id: 'sfo-ord', aircraft: 'A20N' });
    expect(r.assumed).toEqual(['1.aircraft']);
  });

  it('says which questions can be looked up: times, but not dates', () => {
    const r = resolveIntent(
      {
        legs: [
          leg({ from: 'JFK', to: 'LHR', departDate: '2027-06-12', flight: 'AA 100' }),
          leg({ mode: 'train', from: 'London', to: 'Paris' }),
          leg({ mode: 'ferry', from: 'Nice', fromCode: 'NCE', to: 'Ajaccio', toCode: 'AJA', departDate: '2027-06-20', departTime: '08:00', arriveTime: '13:30' }),
        ],
      },
      'AA 100 JFK → LHR 12 Jun 2027. Eurostar London to Paris. Ferry Nice to Ajaccio 20 Jun 2027 08:00-13:30',
      opts,
    );
    expect(r.questions.map((q) => [q.about, q.needs, q.lookup])).toEqual([
      ['AA 100, JFK → LHR, Sat 12 Jun 2027', ['local departure and arrival times'], true],
      ['Train, London → Paris', ['date', 'local departure and arrival times'], true],
    ]);
    expect(r.spec.legs[0]).toMatchObject({ aircraft: 'B789' });
    expect(r.spec.legs[2]).toMatchObject({ from: 'NCE', to: 'AJA', mode: 'ferry', departure: '2027-06-20T08:00:00+02:00' });
    const coded = resolveIntent({ legs: [leg({ from: 'Chicago (ORD)', to: 'SFO', flight: 'UA 1' })] }, 'UA 1 Chicago (ORD) to SFO', opts);
    expect(coded.questions[0]!.about).toBe('UA 1, Chicago (ORD) → SFO');
    const dateOnly = resolveIntent({ legs: [leg({ from: 'JFK', to: 'LHR', departTime: '18:00', arriveTime: '06:10' })] }, 'JFK to LHR 18:00-06:10', opts);
    expect(dateOnly.questions).toMatchObject([{ needs: ['date'], lookup: false }]);
  });

  it('asks for the year once, and ignores a year the text does not state', () => {
    const text = '12 June: Boston to Reykjavik 20:30, arriving 06:15 next morning, then Reykjavik to Amsterdam 07:40 → 12:55. Both on a 737 MAX 8.';
    const legs = (year: string) => [
      leg({ from: 'Boston', fromCode: 'BOS', to: 'Reykjavik', toCode: 'KEF', departDate: `${year}-06-12`, departTime: '20:30', arriveTime: '06:15', aircraft: '737 MAX 8' }),
      leg({ from: 'Reykjavik', fromCode: 'KEF', to: 'Amsterdam', toCode: 'AMS', departDate: `${year}-06-13`, departTime: '07:40', arriveTime: '12:55', aircraft: '737 MAX 8' }),
    ];
    expect(fields(resolveIntent({ legs: legs('0000') }, text, opts))).toEqual(['year']);
    expect(fields(resolveIntent({ legs: legs('2019') }, text, opts))).toEqual(['year']);
    // Last year, this year and next year to pick from.
    expect(resolveIntent({ legs: legs('0000') }, text, opts).questions[0]!.choices).toEqual([{ need: 0, options: ['2025', '2026', '2027'] }]);
  });

  it('replaces an aircraft the text never mentions with a typical one, and picks a family\'s common type', () => {
    const r = resolveIntent(
      { legs: [leg({ from: 'Singapore', fromCode: 'SIN', to: 'Hong Kong', toCode: 'HKG', departDate: '2027-07-19', departTime: '08:15', arriveTime: '12:10', aircraft: '787-9' })] },
      'SQ 890 from Singapore to Hong Kong on 19 July 2027, departs 08:15, arrives 12:10.',
      opts,
    );
    expect(r.complete).toBe(true);
    expect(r.spec.legs[0]).toMatchObject({ aircraft: 'A20N' });
    expect(r.assumed).toEqual(['0.aircraft']);
    const family = resolveIntent(
      { legs: [leg({ from: 'SIN', to: 'LHR', departDate: '2027-07-19', departTime: '23:15', arriveTime: '06:10', aircraft: 'A350' })] },
      'SIN-LHR 19 July 2027 23:15-06:10 on an A350',
      opts,
    );
    expect(family.spec.legs[0]).toMatchObject({ aircraft: 'A359' });
    expect(family.assumed).toEqual(['0.aircraft']);
  });

  it("joins a train's stand-in airports to the adjacent flights", () => {
    const r = resolveIntent(
      {
        legs: [
          leg({ from: "Chicago O'Hare", fromCode: 'ORD', to: 'Tokyo Narita', toCode: 'NRT', departDate: '2027-03-18', departTime: '11:00', arriveTime: '14:25', aircraft: '787-9' }),
          leg({ mode: 'train', from: 'Tokyo', fromCode: 'TYO', to: 'Kyoto', toCode: 'KYT', departDate: '2027-03-26', departTime: '10:00', arriveTime: '12:15' }),
          leg({ from: 'Osaka Kansai', fromCode: 'KIX', to: "O'Hare", toCode: 'ORD', departDate: '2027-03-30', departTime: '17:00', arriveTime: '14:50', aircraft: '777-300ER' }),
        ],
      },
      "2027: ORD-NRT on a 787-9, Shinkansen Tokyo to Kyoto, KIX-ORD on a 777-300ER",
      opts,
    );
    expect(r.issues).toEqual([]);
    expect(r.complete).toBe(true);
    expect(r.spec.legs.map((l) => `${l.from}-${l.to}`)).toEqual(['ORD-NRT', 'NRT-KIX', 'KIX-ORD']);
  });

  it('places stations in the airport table and drops a car rental that returns where it started', () => {
    const r = resolveIntent(
      {
        legs: [
          leg({ mode: 'train', from: 'London St Pancras', fromCode: 'LON', to: 'Paris Gare du Nord', toCode: null, departDate: '2027-04-08', departTime: '08:01', arriveTime: '11:20' }),
          leg({ mode: 'ferry', from: 'Wellington', fromCode: 'WLG', to: 'Picton', toCode: 'CHC', departDate: '2027-04-10', departTime: '09:00', arriveTime: '12:30' }),
          leg({ mode: 'car', from: 'Athens Airport', fromCode: 'ATH', to: 'Athens', toCode: null, departDate: '2027-04-12', departTime: '10:00' }),
        ],
      },
      '2027',
      opts,
    );
    expect(r.spec.legs).toHaveLength(2);
    expect(r.spec.legs[0]).toMatchObject({ from: 'LCY', to: 'ORY', mode: 'train' });
    expect(r.spec.legs[1]).toMatchObject({ from: 'WLG', to: 'PCN', mode: 'ferry' });
  });

  it('finds a place written with or without its accents', () => {
    for (const town of ['Cancún', 'Cancun']) {
      const r = resolveIntent({ legs: [leg({ mode: 'bus', from: town, to: 'Tulum', toCode: 'TQO', departDate: '2027-03-03', departTime: '09:15', arriveTime: '11:30' })] }, `Bus from ${town} to Tulum 3 March 2027 09:15-11:30`, opts);
      expect(r.spec.legs[0]).toMatchObject({ from: 'CUN', to: 'TQO' });
    }
  });

  it('prefers a code the person wrote and the table over a code the table lacks', () => {
    const r = resolveIntent({ legs: [leg({ from: 'SFO', fromCode: 'OAK', to: 'Siem Reap', toCode: 'REP' })] }, 'SFO to Siem Reap', opts);
    expect(r.spec.legs[0]).toMatchObject({ from: 'SFO', to: 'SAI' });
    const unknown = resolveIntent({ legs: [leg({ from: 'SFO', to: 'Nowhereville', toCode: 'QQX' })] }, 'SFO to Nowhereville', opts);
    expect(unknown.questions[0]!.needs[0]).toBe('which airport “QQX” is');
  });

  it('never names a place by one weak word', () => {
    // Before, a place no airport is named after fell back to airports with its first word ("South") and took the nearest.
    const r = resolveIntent(
      { legs: [leg({ mode: 'ferry', from: 'Piraeus', fromCode: 'ATH', to: 'South Aegean', departDate: '2027-05-02', departTime: '07:00', arriveTime: '15:00' })] },
      'Ferry from Piraeus to the South Aegean, 2 May 2027, 07:00-15:00',
      opts,
    );
    expect(r.spec.legs[0]!.to).toBeUndefined();
    expect(r.questions).toMatchObject([{ fields: ['0.to'], needs: ['which town or port you mean by “South Aegean”'], lookup: true }]);
  });

  it('questions an end that makes a leg too long for its mode, once for both legs that share it', () => {
    const r = resolveIntent(
      {
        legs: [
          // The model's code for a town the airport table lacks is half the world away.
          leg({ mode: 'ferry', from: 'Piraeus', fromCode: 'ATH', to: 'Aegina', toCode: 'TRW', departDate: '2027-05-02', departTime: '07:00', arriveTime: '08:15' }),
          leg({ mode: 'ferry', from: 'Aegina', fromCode: 'TRW', to: 'Hydra', toCode: 'ATH', departDate: '2027-05-03', departTime: '09:00', arriveTime: '11:00' }),
        ],
      },
      'Ferry from Piraeus to Aegina 2 May 2027 07:00-08:15, then on to Hydra 3 May 2027 09:00-11:00',
      opts,
    );
    expect(r.spec.legs.map((l) => [l.from, l.to])).toEqual([['ATH', undefined], [undefined, 'ATH']]);
    expect(fields(r)).toEqual(['0.to']);
    expect(r.questions[0]!.needs).toEqual(['which town or port you mean by “Aegina”']);
  });

  it('parses model output defensively', () => {
    expect(parseIntent('not json')).toBeNull();
    expect(parseIntent({ legs: [{ mode: 'plane', from: 'MEL', fromCode: 'mel', departTime: '9:05', arriveTime: '25:00', departDate: '0000-00-00' }] })!.legs[0])
      .toMatchObject({ mode: 'flight', fromCode: 'MEL', departTime: '09:05', arriveTime: null, departDate: null });
  });
});

describe('aircraft as written', () => {
  it.each([
    ['787-9', 'B789'], ['B787-9', 'B789'], ['A380', 'A388'], ['Boeing 777-300ER', 'B77W'], ['777-300', 'B773'],
    ['737 MAX 8', 'B38M'], ['737-800', 'B738'], ['73H', 'B738'], ['789', 'B789'], ['32Q', 'A21N'], ['A321neo', 'A21N'],
    ['A321', 'A321'], ['Q400', 'DH8D'], ['Dash 8-400', 'DH8D'], ['ATR 72-600', 'AT76'], ['CRJ900', 'CRJ9'],
    ['Embraer 190', 'E190'], ['a20n', 'A20N'], ['A350-1000', 'A35K'],
  ])('%s is %s', (written, type) => {
    expect(matchAircraft(written)).toEqual({ type });
  });

  it.each([['A350'], ['Boeing 777'], ['787 Dreamliner'], ['E175'], ['ATR 72']])('%s offers options', (written) => {
    const m = matchAircraft(written);
    expect(m && 'options' in m && m.options.length).toBeGreaterThan(1);
  });

  it('returns null for unknown types', () => {
    expect(matchAircraft('Cessna 172')).toBeNull();
  });

  it('checks the type appears in the text', () => {
    expect(writtenIn('Boeing 777-300ER', 'on a 777-300ER')).toBe(true);
    expect(writtenIn('787-9', 'Equipment: B787-9')).toBe(true);
    expect(writtenIn('787-9', 'SQ 890 from Singapore')).toBe(false);
  });
});

describe('aircraft written as a code', () => {
  it('accepts a name the model expanded from a code in the text', () => {
    expect(writtenIn('Boeing 737-900ER', 'SEA→ANC 0815-1105 B739')).toBe(true);
    expect(writtenIn('Boeing 777-300ER', 'EK 413 SYD DXB 22NOV27 2110 0525+1 77W')).toBe(true);
    expect(writtenIn('Boeing 777-300ER', 'EK 413 SYD DXB 22NOV27 2110 0525+1')).toBe(false);
  });
});

describe('journey summary', () => {
  it('names each place once with its code, and marks a typical aircraft', () => {
    const legs = [{ id: 'ord-sfo', from: 'ORD', to: 'SFO', departure: '2027-05-03T07:00:00-05:00', arrival: '2027-05-03T09:35:00-07:00', aircraft: 'B739' }];
    expect(summarize(legs, [{ from: 'Chicago (ORD)', to: 'SFO' }], { SFO: 'San Francisco International Airport' }, ['0.aircraft'])).toEqual([
      { route: 'Chicago (ORD) → San Francisco (SFO)', when: 'Mon 3 May 2027, 07:00 → 09:35', by: 'Boeing 737-900ER', typical: true },
    ]);
  });

  it('describes a saved draft the same way, which opens a conversation that edits it', () => {
    const spec = {
      schemaVersion: 1,
      legs: [
        { id: 'sfo-sea', from: 'SFO', to: 'SEA', departure: '2027-04-02T09:00:00-07:00', arrival: '2027-04-02T11:10:00-07:00', aircraft: 'B38M' },
        { id: 'sea-anc', from: 'SEA', to: 'ANC', departure: '2027-04-03T23:30:00-07:00', arrival: '2027-04-04T02:05:00-08:00', aircraft: 'B739' },
      ],
    };
    const r = validateScene(spec, { lookupAirport, airportDataVersion: AIRPORT_DATA_VERSION, now: Date.parse('2026-11-12T00:00:00Z') });
    expect(r.ok && sceneSummary(r.normalized)).toEqual([
      { route: 'San Francisco (SFO) → Seattle (SEA)', when: 'Fri 2 Apr 2027, 09:00 → 11:10', by: 'Boeing 737 MAX 8' },
      { route: 'Seattle (SEA) → Anchorage (ANC)', when: 'Sat 3 Apr 2027, 23:30 → Sun 4 Apr, 02:05', by: 'Boeing 737-900ER' },
    ]);
  });
});
