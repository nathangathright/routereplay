# Aircraft types

Each leg names the aircraft that flew it by ICAO type designator (`legs[].aircraft`), and the scene draws that type. The models are original geometry built in code (`src/app/render/airframe.ts`) from the dimensions in `src/shared/scene/aircraft.ts`; there are no model files or liveries. Every model is drawn the same length on screen, as in the offline renderer, so proportions tell types apart.

## Where the numbers come from

Collected November 12, 2026. Overall dimensions come first from the manufacturers' airport planning documents:

- Boeing: *Airplane Characteristics for Airport Planning* (ACAPS), [boeing.com/commercial/airports/plan-manuals](https://www.boeing.com/commercial/airports/plan-manuals). 777X values come from [boeing.com/commercial/777x](https://www.boeing.com/commercial/777x).
- Airbus: *Aircraft Characteristics: Airport and Maintenance Planning* (AC) for the A320 family, A330, A350, and A380, and the A220 *Aircraft Characteristics Publication*, at [aircraft.airbus.com](https://aircraft.airbus.com/en/customer-care/fleet-wide-care/airport-operations-and-aircraft-characteristics/aircraft-characteristics).
- Embraer: *Airport Planning Manuals* for the [E190](https://embraer.com/media/jwsj1u1u/e190apm_apm_190-1.pdf), [E-Jets E2](https://www.embraer.com/media/vmsjxvk5/e-jets-e2_apm_e-jetse2.pdf), and E175 (archived copy).
- CRJ: the CRJ900 *Airport Planning Manual*, and the [MHI CRJ page](https://www.mhi.com/business/products-services/aviation/aircraft-aftermarket-service/crj) for the other models.
- ATR: the [ATR 72-600](https://www.atr-aircraft.com/wp-content/uploads/2020/07/Factsheets_-_ATR_72-600.pdf) and [ATR 42-600](https://www.atr-aircraft.com/wp-content/uploads/2020/07/Factsheets_-_ATR_42-600.pdf) factsheets.
- Dash 8: the [Dash 8-400 spec sheet](https://dehavillandfield.com/wp-content/uploads/2022/08/Dash8_Spec_Sheet_web.pdf).

Values read off drawings use the side view where two views disagree. Heights are the manufacturers' highest normal-operation values, slightly above brochure figures. [aircraft-sources.json](aircraft-sources.json) records the source of every value, with document sections and pages, plus the alternatives considered. `src/shared/scene/aircraft.ts` was built from it, with two changes: shorter names for the CRJ and 747-8, and a 7.92 m estimate where it has no tailplane span.

**Estimates.** The "Estimated" column lists values that are not from a manufacturer document: either a secondary source (mostly wing areas from reference works) or a measurement scaled from a drawing. Notable ones:

- Nacelle diameters are mostly scaled from plan views, about ±10 %.
- Embraer and CRJ engine positions are scaled from drawings.
- Wing sweep is approximate for the A220, E-Jets, CRJs, ATRs, Dash 8s, and 777X.
- The 747's fuselage height, including the upper deck, is scaled from a drawing.
- The 777-8 shares the 777-9's details apart from its length, span, and height.
- The Dash 8-100, -200, and -300 tailplane spans (7.92 m) are our own estimate.

**Where a designator covers several configurations**, we chose the most common one:

- 737-700/800/900: blended winglets (split winglets keep about the same span).
- A319/A320 ceo: wingtip fences. A321 ceo: sharklets.
- 757: blended winglets.
- 767-300ER: plain wingtips, since freighters dominate the fleet.
- E175: split by wing, as ICAO does (`E75L` long wing, `E75S` short).

**Shape.** Where the wing sits along the fuselage, its taper and kink, the nose and tail-cone proportions, and the fin and tailplane shapes are estimated per family from three-view drawings (`AIRCRAFT_FAMILIES`). The model is a recognizable illustration, not engineering data.

## Types

| ICAO | Type | Length × span (m) | Wingtip | Estimated |
| --- | --- | --- | --- | --- |
| `BCS1` | Airbus A220-100 | 34.98 × 35.1 | blended winglet | body width, body height, sweep, nacelle |
| `BCS3` | Airbus A220-300 | 38.69 × 35.1 | blended winglet | body width, body height, sweep, nacelle |
| `A318` | Airbus A318 | 31.45 × 34.1 | wingtip fence | wing area, sweep, nacelle |
| `A319` | Airbus A319 | 33.84 × 34.1 | wingtip fence | wing area, sweep, nacelle |
| `A320` | Airbus A320 | 37.57 × 34.1 | wingtip fence | wing area, sweep, nacelle |
| `A321` | Airbus A321 | 44.51 × 35.8 | sharklet | wing area, sweep, nacelle |
| `A19N` | Airbus A319neo | 33.84 × 35.8 | sharklet | wing area, sweep, nacelle |
| `A20N` | Airbus A320neo | 37.57 × 35.8 | sharklet | wing area, sweep, nacelle |
| `A21N` | Airbus A321neo | 44.51 × 35.8 | sharklet | wing area, sweep, nacelle |
| `B736` | Boeing 737-600 | 31.24 × 34.32 | plain | wing area, sweep, nacelle |
| `B737` | Boeing 737-700 | 33.63 × 35.79 | blended winglet | wing area, sweep, nacelle |
| `B738` | Boeing 737-800 | 39.47 × 35.79 | blended winglet | wing area, sweep, nacelle |
| `B739` | Boeing 737-900ER | 42.11 × 35.79 | blended winglet | wing area, sweep, nacelle |
| `B37M` | Boeing 737 MAX 7 | 35.56 × 35.92 | split winglet | wing area, sweep, nacelle |
| `B38M` | Boeing 737 MAX 8 | 39.47 × 35.92 | split winglet | wing area, sweep, nacelle |
| `B39M` | Boeing 737 MAX 9 | 42.11 × 35.92 | split winglet | wing area, sweep, nacelle |
| `B3XM` | Boeing 737 MAX 10 | 43.79 × 35.92 | split winglet | wing area, sweep, nacelle |
| `B752` | Boeing 757-200 | 47.32 × 41.07 | blended winglet | wing area, sweep, nacelle |
| `B753` | Boeing 757-300 | 54.43 × 41.07 | blended winglet | wing area, sweep, nacelle |
| `B762` | Boeing 767-200ER | 48.51 × 47.57 | plain | wing area, sweep, nacelle |
| `B763` | Boeing 767-300ER | 54.94 × 47.57 | plain | wing area, sweep, nacelle |
| `B764` | Boeing 767-400ER | 61.37 × 51.92 | raked tip | wing area, sweep, nacelle |
| `B772` | Boeing 777-200ER | 63.73 × 60.93 | plain | wing area, sweep, nacelle |
| `B77L` | Boeing 777-200LR / 777F | 63.73 × 64.8 | raked tip | wing area, sweep, nacelle |
| `B773` | Boeing 777-300 | 73.86 × 60.93 | plain | wing area, sweep, nacelle |
| `B77W` | Boeing 777-300ER | 73.86 × 64.8 | raked tip | wing area, sweep, nacelle |
| `B778` | Boeing 777-8 | 70.86 × 71.76 | raked tip | body width, body height, wing area, sweep, tailplane, engine offsets, nacelle, inlet |
| `B779` | Boeing 777-9 | 76.73 × 71.76 | raked tip | wing area, sweep, nacelle |
| `B788` | Boeing 787-8 | 56.72 × 60.12 | raked tip | wing area, sweep, nacelle |
| `B789` | Boeing 787-9 | 62.81 × 60.12 | raked tip | wing area, sweep, nacelle |
| `B78X` | Boeing 787-10 | 68.3 × 60.12 | raked tip | wing area, sweep, nacelle |
| `A332` | Airbus A330-200 | 58.82 × 60.3 | canted winglet | wing area, sweep |
| `A333` | Airbus A330-300 | 63.67 × 60.3 | canted winglet | wing area, sweep |
| `A338` | Airbus A330-800 | 58.82 × 64 | sharklet | wing area, sweep |
| `A339` | Airbus A330-900 | 63.66 × 64 | sharklet | wing area, sweep |
| `A359` | Airbus A350-900 | 66.8 × 64.75 | curved winglet | wing area, sweep |
| `A35K` | Airbus A350-1000 | 73.79 × 64.75 | curved winglet | wing area, sweep |
| `B744` | Boeing 747-400 | 70.67 × 64.44 | canted winglet | body height, wing area, sweep, nacelle |
| `B748` | Boeing 747-8 | 76.25 × 68.4 | raked tip | body height, wing area, sweep, nacelle |
| `A388` | Airbus A380-800 | 72.73 × 79.75 | wingtip fence | wing area, sweep |
| `E170` | Embraer 170 | 29.9 × 26 | blended winglet | length, height, sweep, engine offsets, nacelle, inlet |
| `E75L` | Embraer 175 (long wing) | 31.68 × 28.65 | raked tip | sweep, engine offsets, nacelle, inlet |
| `E75S` | Embraer 175 (short wing) | 31.68 × 26 | blended winglet | sweep, engine offsets, nacelle, inlet |
| `E190` | Embraer 190 | 36.24 × 28.72 | blended winglet | sweep, engine offsets, nacelle, inlet |
| `E195` | Embraer 195 | 38.65 × 28.72 | blended winglet | length, height, sweep, tailplane, engine offsets, nacelle, inlet |
| `E290` | Embraer 190-E2 | 36.24 × 33.72 | raked tip | sweep, engine offsets, nacelle, inlet |
| `E295` | Embraer 195-E2 | 41.6 × 35.12 | raked tip | sweep, engine offsets, nacelle, inlet |
| `CRJ2` | Bombardier CRJ200 | 26.77 × 21.21 | blended winglet | body width, body height, wing area, sweep, tailplane, engine offsets, nacelle, inlet |
| `CRJ7` | Bombardier CRJ700 | 32.3 × 23.2 | blended winglet | body width, body height, wing area, sweep, tailplane, engine offsets, nacelle, inlet |
| `CRJ9` | Bombardier CRJ900 | 36.24 × 24.85 | blended winglet | sweep, inlet |
| `CRJX` | Bombardier CRJ1000 | 39.1 × 26.2 | blended winglet | body width, body height, wing area, sweep, tailplane, engine offsets, nacelle, inlet |
| `AT43` | ATR 42-300/-320 | 22.67 × 24.57 | plain | body width, body height, sweep, tailplane, propeller, inlet |
| `AT45` | ATR 42-500 | 22.67 × 24.57 | plain | body width, body height, sweep, tailplane, inlet |
| `AT46` | ATR 42-600 | 22.67 × 24.57 | plain | body width, body height, sweep, tailplane, inlet |
| `AT72` | ATR 72-200/-210 | 27.166 × 27.05 | plain | body width, body height, sweep, tailplane, propeller, inlet |
| `AT75` | ATR 72-500 | 27.166 × 27.05 | plain | body width, body height, sweep, tailplane, inlet |
| `AT76` | ATR 72-600 | 27.166 × 27.05 | plain | body width, body height, sweep, tailplane, inlet |
| `DH8A` | De Havilland Canada Dash 8-100 | 22.25 × 25.89 | plain | length, span, height, body width, body height, wing area, sweep, tailplane, engine offsets, propeller |
| `DH8B` | De Havilland Canada Dash 8-200 | 22.25 × 25.89 | plain | length, span, height, body width, body height, wing area, sweep, tailplane, engine offsets, propeller |
| `DH8C` | De Havilland Canada Dash 8-300 | 25.68 × 27.43 | plain | length, span, height, body width, body height, wing area, sweep, tailplane, engine offsets, propeller |
| `DH8D` | De Havilland Canada Dash 8-400 | 32.83 × 28.42 | plain | body width, body height, wing area, sweep, tailplane, engine offsets, propeller, inlet |
