/**
 * Synthetic itineraries for the compose evaluation. No real trips: names, booking codes and prices are made up;
 * routes, flight numbers and times are plausible, not schedules.
 *
 * Each case lists the legs it should produce and `ask`: the questions it must ask instead of inventing a value
 * ("<leg>.<field>" or "year"). A case with an empty `ask` must come back complete and valid.
 *
 * Expected leg fields: from/to as an IATA code, or {near: code, km} for a train, bus, car or ferry stand-in;
 * dep/arr as local "YYYY-MM-DDTHH:MM", optionally with the offset; aircraft (ICAO) or mode. null means the
 * field must stay empty (unknown, or not computable without an answer). TYPICAL means the text names no aircraft
 * (or one Route Replay doesn't draw), so the leg must carry a typical one marked as assumed.
 */
const near = (code, km = 60) => ({ near: code, km });
export const TYPICAL = 'typical';

export const CASES = [
  {
    id: 'terse-complete',
    style: 'terse',
    text: 'QF93 MEL-SFO 5 Mar 2027 dep 10:15 arr 06:05, 787-9. Then UA 1234 SFO-ORD same day dep 08:30 arr 14:42, 737 MAX 8.',
    legs: [
      { from: 'MEL', to: 'SFO', dep: '2027-03-05T10:15+11:00', arr: '2027-03-05T06:05-08:00', aircraft: 'B789' },
      { from: 'SFO', to: 'ORD', dep: '2027-03-05T08:30-08:00', arr: '2027-03-05T14:42-06:00', aircraft: 'B38M' },
    ],
    ask: [],
  },
  {
    id: 'terse-missing',
    style: 'terse',
    text: 'Fri 3pm MEL to SFO to ORD',
    legs: [
      { from: 'MEL', to: 'SFO', dep: null, arr: null, aircraft: TYPICAL },
      { from: 'SFO', to: 'ORD', dep: null, arr: null, aircraft: TYPICAL },
    ],
    ask: ['0.departure', '0.arrival', '1.departure', '1.arrival'],
  },
  {
    id: 'booking-dateline',
    style: 'booking',
    text: `Your trip confirmation - Booking reference: QX7P2L
Passenger: MR ALEX SAMPLE   Frequent flyer: NZ 12345678

Flight 1: NZ 6  Auckland (AKL) to Los Angeles (LAX)
Tue 14 Sep 2027  Depart 19:30  Arrive 11:50  Equipment: 789
Seat 34A  Economy  Baggage 2 x 23kg

Flight 2: AA 2410  Los Angeles (LAX) to New York (JFK)
Tue 14 Sep 2027  Depart 13:05  Arrive 21:39  Equipment: 32Q

Fare: NZD 2,345.00  Taxes: NZD 312.40`,
    legs: [
      { from: 'AKL', to: 'LAX', dep: '2027-09-14T19:30+12:00', arr: '2027-09-14T11:50-07:00', aircraft: 'B789' },
      { from: 'LAX', to: 'JFK', dep: '2027-09-14T13:05-07:00', arr: '2027-09-14T21:39-04:00', aircraft: 'A21N' },
    ],
    ask: [],
  },
  {
    id: 'overnight-plus1',
    style: 'terse',
    text: 'BA286 SFO–LHR 10 Jun 2027 20:35 → 15:00+1 (A380)\nBA432 LHR–AMS 11 Jun 2027 18:30 → 20:55 (A320)',
    legs: [
      { from: 'SFO', to: 'LHR', dep: '2027-06-10T20:35-07:00', arr: '2027-06-11T15:00+01:00', aircraft: 'A388' },
      { from: 'LHR', to: 'AMS', dep: '2027-06-11T18:30+01:00', arr: '2027-06-11T20:55+02:00', aircraft: 'A320' },
    ],
    ask: [],
  },
  {
    id: 'dateline-westbound',
    style: 'prose',
    text: 'Qantas A380 from Los Angeles to Sydney: departing 1 February 2027 at 10:40pm, arriving 3 February at 8:15am.',
    legs: [{ from: 'LAX', to: 'SYD', dep: '2027-02-01T22:40-08:00', arr: '2027-02-03T08:15+11:00', aircraft: 'A388' }],
    ask: [],
  },
  {
    id: 'dateline-eastbound',
    style: 'prose',
    text: 'On 20 January 2027 we flew Auckland to Honolulu, leaving at 11:05pm and landing at 8:45am, on a 787-9.',
    legs: [{ from: 'AKL', to: 'HNL', dep: '2027-01-20T23:05+13:00', arr: '2027-01-20T08:45-10:00', aircraft: 'B789' }],
    ask: [],
  },
  {
    id: 'london-ambiguous',
    style: 'prose',
    text: 'Flying London to New York on 3 May 2027, 11:00 to 13:55, Boeing 777-300ER.',
    legs: [{ from: null, to: null, dep: null, arr: null, aircraft: 'B77W' }],
    ask: ['0.from', '0.to'],
  },
  {
    id: 'london-specific',
    style: 'prose',
    text: 'Heathrow to JFK, 3 May 2027, departing 11:00 and arriving 13:55 on a 777-300ER.',
    legs: [{ from: 'LHR', to: 'JFK', dep: '2027-05-03T11:00+01:00', arr: '2027-05-03T13:55-04:00', aircraft: 'B77W' }],
    ask: [],
  },
  {
    id: 'nz-ferry-car',
    style: 'prose',
    text: 'We flew Auckland to Wellington on 12 February 2027 (NZ 417, 7:00am to 8:05am, an A320neo). The next morning we took the 9:00 Interislander ferry from Wellington to Picton, arriving at 12:30, then picked up a rental car and drove to Christchurch, leaving about 1pm and getting in around 6:30pm.',
    legs: [
      { from: 'AKL', to: 'WLG', dep: '2027-02-12T07:00+13:00', arr: '2027-02-12T08:05+13:00', aircraft: 'A20N' },
      { from: 'WLG', to: near('PCN'), dep: '2027-02-13T09:00+13:00', arr: '2027-02-13T12:30+13:00', mode: 'ferry' },
      { from: near('PCN'), to: near('CHC'), dep: '2027-02-13T13:00+13:00', arr: '2027-02-13T18:30+13:00', mode: 'car' },
    ],
    ask: [],
  },
  {
    id: 'europe-trains',
    style: 'prose',
    text: 'Eurostar from London St Pancras to Paris Gare du Nord on 8 April 2027, 08:01 to 11:20, then a TGV from Paris Gare de Lyon to Lyon Part-Dieu, 13:00 to 14:56.',
    legs: [
      { from: near('LCY'), to: near('LBG'), dep: '2027-04-08T08:01+01:00', arr: '2027-04-08T11:20+02:00', mode: 'train' },
      { from: near('LBG'), to: near('LYS'), dep: '2027-04-08T13:00+02:00', arr: '2027-04-08T14:56+02:00', mode: 'train' },
    ],
    ask: [],
  },
  {
    id: 'missing-aircraft',
    style: 'prose',
    text: 'SQ 890 from Singapore to Hong Kong on 19 July 2027, departs 08:15, arrives 12:10.',
    legs: [{ from: 'SIN', to: 'HKG', dep: '2027-07-19T08:15+08:00', arr: '2027-07-19T12:10+08:00', aircraft: TYPICAL }],
    ask: [],
  },
  {
    id: 'missing-times',
    style: 'prose',
    text: 'Brisbane to Tokyo Haneda on 2 October 2027 on a 787-9. Not sure of the times.',
    legs: [{ from: 'BNE', to: 'HND', dep: null, arr: null, aircraft: 'B789' }],
    ask: ['0.departure', '0.arrival'],
  },
  {
    id: 'typos',
    style: 'terse',
    text: 'Melborne to Singpore on 15 Aug 2027, 15:30-21:15, A350-900. Then Singpore to Londn Heathrw same night, 23:50 arriving 06:25 on the 16th, A350-1000.',
    legs: [
      { from: 'MEL', to: 'SIN', dep: '2027-08-15T15:30+10:00', arr: '2027-08-15T21:15+08:00', aircraft: 'A359' },
      { from: 'SIN', to: 'LHR', dep: '2027-08-15T23:50+08:00', arr: '2027-08-16T06:25+01:00', aircraft: 'A35K' },
    ],
    ask: [],
  },
  {
    id: 'repeated-airport',
    style: 'terse',
    text: 'SFO → HNL 20 Dec 2027 09:00–12:40 A321neo; HNL → SFO 27 Dec 2027 14:30–21:35 A321neo',
    legs: [
      { from: 'SFO', to: 'HNL', dep: '2027-12-20T09:00-08:00', arr: '2027-12-20T12:40-10:00', aircraft: 'A21N' },
      { from: 'HNL', to: 'SFO', dep: '2027-12-27T14:30-10:00', arr: '2027-12-27T21:35-08:00', aircraft: 'A21N' },
    ],
    ask: [],
  },
  {
    id: 'dst-red-eye',
    style: 'prose',
    text: 'Red-eye from LAX to JFK leaving Saturday 13 March 2027 at 11:00pm, landing 7:55am Sunday. Boeing 757-200.',
    legs: [{ from: 'LAX', to: 'JFK', dep: '2027-03-13T23:00-08:00', arr: '2027-03-14T07:55-04:00', aircraft: 'B752' }],
    ask: [],
  },
  {
    id: 'no-year',
    style: 'prose',
    text: '12 June: Boston to Reykjavik 20:30, arriving 06:15 next morning, then Reykjavik to Amsterdam 07:40 → 12:55. Both on a 737 MAX 8.',
    legs: [
      { from: 'BOS', to: 'KEF', dep: null, arr: null, aircraft: 'B38M' },
      { from: 'KEF', to: 'AMS', dep: null, arr: null, aircraft: 'B38M' },
    ],
    ask: ['year'],
  },
  {
    id: 'bus-then-flight',
    style: 'prose',
    text: 'Bus from Bangkok to Siem Reap on 8 Jan 2027, 08:00 to 16:30. Two days later we flew Siem Reap to Hanoi, 14:15 to 16:05, on an A321.',
    legs: [
      { from: near('BKK'), to: 'SAI', dep: '2027-01-08T08:00+07:00', arr: '2027-01-08T16:30+07:00', mode: 'bus' },
      { from: 'SAI', to: 'HAN', dep: '2027-01-10T14:15+07:00', arr: '2027-01-10T16:05+07:00', aircraft: 'A321' },
    ],
    ask: [],
  },
  {
    id: 'road-trip',
    style: 'prose',
    text: 'Drove from San Francisco to Los Angeles on 1 May 2027, left at 8am, arrived 3:30pm.',
    legs: [{ from: near('SFO'), to: near('LAX'), dep: '2027-05-01T08:00-07:00', arr: '2027-05-01T15:30-07:00', mode: 'car' }],
    ask: [],
  },
  {
    id: 'booking-email',
    style: 'booking',
    text: `Hi Alex,
Thanks for booking with Example Travel! Here is your itinerary.

HOTEL: Hotel Grande Bretagne, Athens - check-in 3 Oct 2027, check-out 7 Oct 2027. Confirmation 88231.
CAR RENTAL: Pick-up Athens Airport (ATH) 7 Oct 2027 10:00, drop-off same location 10 Oct 2027.

FLIGHTS
LH 455  San Francisco (SFO) -> Frankfurt (FRA)   Sat 02 Oct 2027  15:20 -> Sun 03 Oct 2027 11:05   Airbus A350-900
LH 1284 Frankfurt (FRA) -> Athens (ATH)          Sun 03 Oct 2027  13:10 -> 16:55                  Airbus A321neo

Total paid: USD 1,842.60. Cancellation policy applies.
Questions? Reply to this email.`,
    legs: [
      { from: 'SFO', to: 'FRA', dep: '2027-10-02T15:20-07:00', arr: '2027-10-03T11:05+02:00', aircraft: 'A359' },
      { from: 'FRA', to: 'ATH', dep: '2027-10-03T13:10+02:00', arr: '2027-10-03T16:55+03:00', aircraft: 'A21N' },
    ],
    ask: [],
  },
  {
    id: 'japan-prose',
    style: 'prose',
    text: "In March 2027 I flew from Chicago O'Hare to Tokyo Narita on a 787-9, leaving on the 18th at 11:00 and landing on the 19th at 14:25. A week later, on the 26th, I took the Shinkansen from Tokyo to Kyoto, 10:00 to 12:15. On the 30th I flew home from Osaka Kansai at 17:00 on a 777-300ER, landing at O'Hare at 14:50 the same day.",
    legs: [
      { from: 'ORD', to: 'NRT', dep: '2027-03-18T11:00-05:00', arr: '2027-03-19T14:25+09:00', aircraft: 'B789' },
      { from: 'NRT', to: 'KIX', dep: '2027-03-26T10:00+09:00', arr: '2027-03-26T12:15+09:00', mode: 'train' },
      { from: 'KIX', to: 'ORD', dep: '2027-03-30T17:00+09:00', arr: '2027-03-30T14:50-05:00', aircraft: 'B77W' },
    ],
    ask: [],
  },
  {
    id: 'via-stopover',
    style: 'terse',
    text: 'QF1 SYD to London via Singapore, departing 4 November 2027 at 16:10, on an A380.',
    legs: [
      { from: 'SYD', to: 'SIN', dep: '2027-11-04T16:10+11:00', arr: null, aircraft: 'A388' },
      { from: 'SIN', to: null, dep: null, arr: null, aircraft: 'A388' },
    ],
    ask: ['0.arrival', '1.departure', '1.arrival', '1.to'],
  },
  {
    id: 'named-airport',
    style: 'prose',
    text: 'Newark Liberty to San Francisco on 21 August 2027, 6:00am to 9:25am, Boeing 757-200.',
    legs: [{ from: 'EWR', to: 'SFO', dep: '2027-08-21T06:00-04:00', arr: '2027-08-21T09:25-07:00', aircraft: 'B752' }],
    ask: [],
  },
  {
    id: 'arizona-no-dst',
    style: 'terse',
    text: 'PHX → DEN 4 Jul 2027 07:15–09:55 (A320), DEN → MDW same day 11:30–15:00 (737-800)',
    legs: [
      { from: 'PHX', to: 'DEN', dep: '2027-07-04T07:15-07:00', arr: '2027-07-04T09:55-06:00', aircraft: 'A320' },
      { from: 'DEN', to: 'MDW', dep: '2027-07-04T11:30-06:00', arr: '2027-07-04T15:00-05:00', aircraft: 'B738' },
    ],
    ask: [],
  },
  {
    id: 'sleeper-train',
    style: 'prose',
    text: 'Overnight sleeper train from Vienna to Venice, leaving 10 September 2027 at 21:27 and arriving at 08:44. On 14 September I flew Venice to London Gatwick, 10:25 to 11:40, on an A320.',
    legs: [
      { from: near('VIE'), to: 'VCE', dep: '2027-09-10T21:27+02:00', arr: '2027-09-11T08:44+02:00', mode: 'train' },
      { from: 'VCE', to: 'LGW', dep: '2027-09-14T10:25+02:00', arr: '2027-09-14T11:40+01:00', aircraft: 'A320' },
    ],
    ask: [],
  },
  {
    id: 'tokyo-ambiguous',
    style: 'prose',
    text: 'Singapore to Tokyo on 2 November 2027, 22:45 to 06:55, Boeing 787-10.',
    legs: [{ from: 'SIN', to: null, dep: '2027-11-02T22:45+08:00', arr: null, aircraft: 'B78X' }],
    ask: ['0.to'],
  },
  {
    id: 'relative-date',
    style: 'terse',
    text: "Tomorrow I'm flying JFK to MIA at 7am, landing 10:10, on an A321.",
    legs: [{ from: 'JFK', to: 'MIA', dep: null, arr: null, aircraft: 'A321' }],
    ask: ['0.departure'],
  },
  {
    id: 'aircraft-family',
    style: 'terse',
    text: 'LHR to DXB on 1 Feb 2027 09:40 → 20:35 on an A380, then DXB to SYD same night 21:15 → 17:30 next day on a Boeing 777.',
    legs: [
      { from: 'LHR', to: 'DXB', dep: '2027-02-01T09:40+00:00', arr: '2027-02-01T20:35+04:00', aircraft: 'A388' },
      { from: 'DXB', to: 'SYD', dep: '2027-02-01T21:15+04:00', arr: '2027-02-02T17:30+11:00', aircraft: TYPICAL },
    ],
    ask: [],
  },
  {
    id: 'notes-no-times',
    style: 'notes',
    // How people jot a trip down: flight numbers and some dates, no times or aircraft, places by name.
    text: `AA 100 JFK → LHR Jun 12, 2027
Eurostar London to Paris
TGV to Nice
Ferry to Corsica
XK 774 AJA → ORY Jun 25, 2027`,
    legs: [
      { from: 'JFK', to: 'LHR', dep: null, arr: null, aircraft: TYPICAL },
      { from: near('LHR'), to: near('ORY'), dep: null, arr: null, mode: 'train' },
      { from: near('ORY'), to: 'NCE', dep: null, arr: null, mode: 'train' },
      { from: 'NCE', to: near('AJA', 200), dep: null, arr: null, mode: 'ferry' },
      { from: 'AJA', to: 'ORY', dep: null, arr: null, aircraft: TYPICAL },
    ],
    ask: ['0.departure', '0.arrival', '1.departure', '1.arrival', '2.departure', '2.arrival', '3.departure', '3.arrival', '4.departure', '4.arrival'],
  },
];

/**
 * Held out: written after the resolver was tuned on CASES, to check that its rules generalise. Don't tune on these;
 * add new held-out cases instead.
 */
export const HOLDOUT = [
  {
    id: 'ho-terse-arrows',
    style: 'terse',
    text: 'SEA→ANC 2027-08-02 0815-1105 B739; ANC→FAI same day 1300-1405 B738',
    legs: [
      { from: 'SEA', to: 'ANC', dep: '2027-08-02T08:15-07:00', arr: '2027-08-02T11:05-08:00', aircraft: 'B739' },
      { from: 'ANC', to: 'FAI', dep: '2027-08-02T13:00-08:00', arr: '2027-08-02T14:05-08:00', aircraft: 'B738' },
    ],
    ask: [],
  },
  {
    id: 'ho-gds-itinerary',
    style: 'booking',
    text: `ITINERARY  REF 4KQ9ZT
 1 EK 413  SYD DXB  22NOV27  2110  0525+1  77W
 2 EK  29  DXB LHR  23NOV27  0750  1140     388`,
    legs: [
      { from: 'SYD', to: 'DXB', dep: '2027-11-22T21:10+11:00', arr: '2027-11-23T05:25+04:00', aircraft: 'B77W' },
      { from: 'DXB', to: 'LHR', dep: '2027-11-23T07:50+04:00', arr: '2027-11-23T11:40+00:00', aircraft: 'A388' },
    ],
    ask: [],
  },
  {
    id: 'ho-greek-ferry',
    style: 'prose',
    text: 'Took the ferry from Piraeus to Santorini on 18 June 2027, leaving at 07:25 and arriving at 15:10, then flew Santorini to Athens on the 22nd at 19:00, landing 19:50, on an A320.',
    legs: [
      { from: near('ATH'), to: 'JTR', dep: '2027-06-18T07:25+03:00', arr: '2027-06-18T15:10+03:00', mode: 'ferry' },
      { from: 'JTR', to: 'ATH', dep: '2027-06-22T19:00+03:00', arr: '2027-06-22T19:50+03:00', aircraft: 'A320' },
    ],
    ask: [],
  },
  {
    id: 'ho-paris-ambiguous',
    style: 'prose',
    text: 'Paris to Montreal on 9 Sept 2027, 13:30 → 15:05, A330-900.',
    legs: [{ from: null, to: 'YUL', dep: null, arr: null, aircraft: 'A339' }],
    ask: ['0.from'],
  },
  {
    id: 'ho-missing-arrival',
    style: 'prose',
    text: 'Dublin to Boston, 30 June 2027, departing 10:50 on an A321neo.',
    legs: [{ from: 'DUB', to: 'BOS', dep: '2027-06-30T10:50+01:00', arr: null, aircraft: 'A21N' }],
    ask: ['0.arrival'],
  },
  {
    id: 'ho-mexico-bus',
    style: 'prose',
    text: 'ADO bus from Cancún to Tulum, 3 March 2027, 09:15 to 11:30, then flew Tulum to Mexico City on 6 March, 12:40 to 13:45, Boeing 737 MAX 8.',
    legs: [
      { from: near('CUN'), to: 'TQO', dep: '2027-03-03T09:15-05:00', arr: '2027-03-03T11:30-05:00', mode: 'bus' },
      { from: 'TQO', to: 'MEX', dep: '2027-03-06T12:40-05:00', arr: '2027-03-06T13:45-06:00', aircraft: 'B38M' },
    ],
    ask: [],
  },
  {
    id: 'ho-baltic-ferry',
    style: 'prose',
    text: 'Overnight ferry from Helsinki to Stockholm: depart 17:00 on 12 July 2027, arrive 09:45.',
    legs: [{ from: near('HEL'), to: near('BMA'), dep: '2027-07-12T17:00+03:00', arr: '2027-07-13T09:45+02:00', mode: 'ferry' }],
    ask: [],
  },
  {
    id: 'ho-casual-us',
    style: 'prose',
    text: 'flew out of Denver at 6:10am on 14 Jan 2027 to Atlanta (got in 11:20), then ATL to Savannah at 1:05pm, landing 2:10. both were 737-800s',
    legs: [
      { from: 'DEN', to: 'ATL', dep: '2027-01-14T06:10-07:00', arr: '2027-01-14T11:20-05:00', aircraft: 'B738' },
      { from: 'ATL', to: 'SAV', dep: '2027-01-14T13:05-05:00', arr: '2027-01-14T14:10-05:00', aircraft: 'B738' },
    ],
    ask: [],
  },
  {
    id: 'ho-train-then-flight',
    style: 'terse',
    text: 'Lisbon–Porto by train, 2 May 2027 07:39–10:35. Then Porto to Paris Orly 2 May 2027, 18:05 → 21:30.',
    legs: [
      { from: near('LIS'), to: 'OPO', dep: '2027-05-02T07:39+01:00', arr: '2027-05-02T10:35+01:00', mode: 'train' },
      { from: 'OPO', to: 'ORY', dep: '2027-05-02T18:05+01:00', arr: '2027-05-02T21:30+02:00', aircraft: TYPICAL },
    ],
    ask: [],
  },
  {
    id: 'ho-dst-autumn',
    style: 'prose',
    text: 'Flew Madrid to Lisbon on 31 October 2027, departing 08:55 and arriving 09:20, A320neo.',
    legs: [{ from: 'MAD', to: 'LIS', dep: '2027-10-31T08:55+01:00', arr: '2027-10-31T09:20+00:00', aircraft: 'A20N' }],
    ask: [],
  },
  {
    id: 'ho-code-typo',
    style: 'terse',
    text: 'JKF to LAX on 5 Feb 2027 at 7:00, landing 10:35, A321',
    legs: [{ from: 'JFK', to: 'LAX', dep: '2027-02-05T07:00-05:00', arr: '2027-02-05T10:35-08:00', aircraft: 'A321' }],
    ask: [],
  },
  {
    id: 'ho-unsupported-aircraft',
    style: 'prose',
    text: 'Rex flight Sydney to Dubbo, 2027-04-20 14:00–15:15, Saab 340.',
    legs: [{ from: 'SYD', to: 'DBO', dep: '2027-04-20T14:00+10:00', arr: '2027-04-20T15:15+10:00', aircraft: TYPICAL }],
    ask: [],
  },
];
