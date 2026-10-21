# Trip configuration

Use JSON with `schema_version: 1`. The examples are synthetic, not flight schedules or bookings. Coordinates and IANA timezones are explicit so rendering does not depend on an airport lookup API. Verify actual flight dates, schedules, and aircraft separately before creating a real itinerary.

```json
{
  "schema_version": 1,
  "title": "My trip",
  "airports": {
    "ORD": {"name": "Chicago", "lat": 41.9742, "lon": -87.9073, "timezone": "America/Chicago"},
    "SFO": {"name": "San Francisco", "lat": 37.6213, "lon": -122.3790, "timezone": "America/Los_Angeles"}
  },
  "flights": [
    {"from": "ORD", "to": "SFO", "departure": "2030-06-01T10:00:00-05:00", "arrival": "2030-06-01T12:30:00-07:00", "aircraft": "a321neo"}
  ],
  "video": {"duration_s": 12, "fps": 30},
  "weather": {"mode": "clear"}
}
```

## Required fields

`title` is a nonempty project name. It is metadata, not on-screen text. `airports` maps three uppercase letters to `name`, finite `lat` in [-90, 90], finite `lon` in [-180, 180], and an installed IANA `timezone`. `flights` is a nonempty ordered list of connected flights. Each flight's `from` and `to` reference airport codes; its arrival must be after its departure in UTC. Connections may have zero layover time, but may not overlap. Every next departure must use the previous arrival airport. Repeated visits are preserved as separate label occurrences.

Departure and arrival timestamps **must include the airport's local UTC offset** and must match its IANA timezone at that instant. For example, Chicago uses `-05:00` in summer and `-06:00` in winter under the currently installed timezone rules. A UTC `Z` timestamp is accepted only for an airport whose local offset is zero at that instant. During an autumn repeated hour, either valid offset selects the intended occurrence. A nonexistent spring-forward time is rejected. Update the operating system timezone database when future civil-time rules change.

Aircraft values currently supported: `a321neo`, `777-200er`, `787-9`, `757-300`. An unsupported type fails validation rather than silently substituting another model. Without a trajectory, coincident airport locations and exactly antipodal endpoints are rejected because the arc or heading is undefined. Add an intermediate airport, or supply an unambiguous trajectory with nonzero travel.

## Supplied trajectories

A flight may include a `trajectory` object. The source may be recorded observations or an explicitly identified synthetic fixture; this input does not retrieve or certify flight-tracking data. For example, these sparse synthetic points fit the ORD→SFO flight above:

```json
"trajectory": {
  "source": "Synthetic schema example; not a recorded flight",
  "altitude_reference": "MSL",
  "max_gap_s": 300,
  "points": [
    {"time": "2030-06-01T15:00:00Z", "lat": 41.9742, "lon": -87.9073, "altitude_m": 205},
    {"time": "2030-06-01T17:00:00Z", "lat": 40.4, "lon": -108.8, "altitude_m": 11000},
    {"time": "2030-06-01T19:30:00Z", "lat": 37.6213, "lon": -122.3790, "altitude_m": 4}
  ]
}
```

`source` is a nonempty description of provenance and any conversions. `altitude_reference` must be `MSL`; `altitude_m` is geometric metres above mean sea level, not pressure altitude, flight level, feet, or height above terrain. Convert those explicitly before import. Coordinates are WGS84 degrees. At least two points are required, with strictly increasing, offset-aware times inside the containing flight. Unlike airport departure/arrival fields, observation times may use `Z` regardless of the local airport offset. Latitude/longitude bounds match airports; altitude must be finite within −500 to 25,000 m. Adjacent antipodal observations are rejected. Observations exactly at departure/arrival must be within 20 km of the associated airport.

`max_gap_s` defaults to 300 and must be positive. Source observations retain their timestamps, coordinates and altitudes. Between observations, the engine uses spherical position interpolation and linear altitude interpolation; a gap longer than the threshold is explicitly marked `gap_interpolation`. Missing time before the first point or after the last point also uses an illustrative airport connection. The sparse example therefore contains two reported observation gaps. No interpolated point is described as an observation.

The camera, route guide, aircraft heading and altitude follow this timed path. Physical track altitude is retained; displayed height uses the shared artistic exaggeration. `frame-contexts.json` records physical altitude, terrain height, clearance, displayed altitude and `observed`, `track_interpolation`, `gap_interpolation` or `illustrative` status. Inspect terrain-clearance diagnostics: a coarse DEM and a supplied altitude are not an obstacle-clearance guarantee.

`flight_video.py import-track` attaches a local CSV, GPX, KML or IGC segment to a selected flight and writes a new validated trip file. Use `--flight 1` for the first flight; `--segment 0` selects the first segment when a source contains several. Explicit altitude declarations and conversion requirements depend on the format. Read [track-imports.md](track-imports.md) before importing.

The standalone CSV importer accepts exactly `time,lat,lon,altitude_m` columns and prints a normalized trajectory object to insert under a flight:

```sh
python3 scripts/trajectory.py observations.csv --source "Provider and conversion details" > trajectory.json
```

The importer validates coordinates and ordering; loading the containing trip additionally checks flight time bounds and airport endpoints. For a leg without a trajectory, the engine uses an illustrative great-circle path and an altitude arc up to 11,000 m above sampled terrain.

## Optional telemetry

Telemetry is off when omitted. To enable it in the saved trip, add this top-level object:

```json
"telemetry": {"enabled": true, "units": "aviation"}
```

`enabled` must be a JSON boolean and defaults to `false`. `units` defaults to `aviation`: distance in nautical miles (NM), altitude in feet (FT), and ground speed in knots (KT). `metric` uses kilometres (KM), metres (M), and kilometres per hour (KM/H). These are the only accepted unit sets. Supplying an empty object retains the disabled defaults; omitting the object preserves older normalized trip configurations.

The `plan`, `preview`, `render`, `budget` and `import-track` commands accept `--telemetry`, `--no-telemetry` and `--telemetry-units aviation|metric`. A units flag enables the overlay unless paired with `--no-telemetry`. Flags override the trip settings for that invocation. `import-track` saves the resulting settings in its new output file; other commands preserve the input JSON. Effective settings and the telemetry font participate in render-cache identity.

```sh
python3 scripts/flight_video.py plan trip.json --telemetry
python3 scripts/flight_video.py preview trip.json --assets data/november --workdir renders --telemetry-units metric
```

The readout near the top shows three rounded values:

| Value | Basis |
| --- | --- |
| Distance | Cumulative horizontal distance along the reconstructed route, including previous flights. It stays constant during holds. Once an illustrative leg or observation gap contributes, the cumulative total is marked estimated. |
| Altitude · MSL | Physical altitude in the track, without cinematic height exaggeration. A flight without observations uses the illustrative altitude arc and is marked estimated. Altitude is unavailable within a long observation gap or missing endpoint interval. |
| Ground speed | Horizontal distance between timed positions divided by elapsed physical seconds. It does not use video-time compression, vertical speed, airspeed or the displayed zoom arc. It is zero during departure, arrival and layover holds; it is unavailable within a long observation gap. |

`≈` identifies estimated or illustrative values; `—` identifies unavailable values. Between sufficiently close observations, altitude is interpolated and speed is derived from the track timestamps, rather than read from an onboard speed sensor. During a hold, altitude is shown only when an observation exists at that exact flight departure or arrival. An airport terrain estimate is not substituted for a missing terminal altitude. Replay changes weather sampling, not telemetry's physical clock.

Telemetry uses bundled Dosis, a rounded sans-serif font distributed under [SIL OFL 1.1](../assets/fonts/dosis/OFL.txt). No font download or installation is needed. Set `FLIGHT_TELEMETRY_FONT` to a locally licensed TrueType/OpenType file to use another typeface; the font bytes are included in cache identity. Airport split-flap lettering retains its separate font setting.

## Aircraft motion and media

Optional top-level `attitude` and `moments`, plus `video.pacing`, add modeled bank/pitch, highlights pacing and local media cards. Read [flight motion and moments](storytelling.md) for fields, limits, CLI overrides and timestamp anchoring. They are off/classic/empty when omitted.

## Editorial settings

`video` is optional. Defaults are `fps: 30`, `departure_hold_s: 1.6`, `arrival_hold_s: 2.7`, and `layover_hold_s: 1.3` for each connection. If `duration_s` is omitted, duration is the total holds plus six seconds per flight. An explicit duration must exceed all holds combined. Remaining video time is divided between flights in proportion to the square root of each flight's route angular distance (the waypoint chain when supplied, otherwise the great-circle arc). Longer flights receive more screen time without overwhelming short segments.

Use optional `video.layover_holds_s` to set each connection separately, in flight order. The list must contain exactly one finite, nonnegative number for every connection (`number of flights − 1`); a single-flight trip may use an empty list. For four flights, `"layover_holds_s": [0, 5, 1.5]` cuts the first layover, gives the second five video seconds, and gives the third 1.5 seconds. The list overrides `layover_hold_s` for all connections. Omitting it preserves the scalar default. Normalized JSON retains an explicitly supplied list; changing the scalar then does not change that list.

These are presentation durations. They do not alter actual arrival/departure dates or weather provenance. A positive hold animates the complete physical layover, so a multi-day connection can show several Sun cycles. The plan records each connection's physical hours, video duration and average compression rate. It includes a metadata warning when an animated connection exceeds 24 physical hours per video second, suggesting a longer hold or an explicit zero-second cut. This warning is not drawn on the video. Smootherstep easing makes the instantaneous rate vary around the reported average. Increase `duration_s` as needed when assigning longer holds, since flight motion still needs positive remaining time.

`frame_count` is the nearest integer to `duration_s * fps` (minimum one). The encoded duration is therefore `frame_count / fps`; specify an integral frame count if exact editorial duration matters. Time queries outside the timeline clamp to its endpoints. Flight progress and layover clock changes use smootherstep easing. The preceding flight remains active during a layover; the next flight becomes active at its start. With a zero-second editorial layover, the physical clock cuts directly to the next departure at the shared boundary.

`style` is optional. These defaults define the cinematic presentation:

| Field | Default | Meaning |
| --- | ---: | --- |
| `ground_radius` | 1300 | Apparent Earth radius in reference pixels at ground level |
| `summit_radius` | 440 | Apparent Earth radius at the longest flight's apex |
| `relief_exaggeration` | 12 | Terrain height multiplier; cloud and displayed aircraft heights use at least 1× |
| `atmosphere_strength` | 1 | Atmosphere intensity multiplier |
| `star_strength` | 1 | Catalog-star radiance multiplier |
| `cloud_strength` | 1 | Reconstructed cloud extinction multiplier, shared by shadow and camera paths |
| `cloud_phase_g` | 0.65 | Cloud forward-scattering asymmetry, from 0 to 0.95 |
| `cloud_multiple_scattering` | 1 | Approximate diffuse cloud scattering gain, from 0 to 4 |
| `cloud_lighting` | 1 | Blend from earlier normal-based shading (0) to volume scattering and directional sky illumination (1); see [cloud lighting](cloud-lighting.md) |
| `cloud_morphology` | 1 | Rounded billows with bounded wind history (1), or earlier sheets and seed history (0); see [cloud morphology](cloud-morphology.md) |
| `moonlight` | 4000 | Shared cloud, terrain, ocean and Cycles aircraft lunar multiplier (`cloud_moonlight` is a legacy alias), from 0 to 20000; 0 disables it, 1 uses the unboosted reference, 4000 is cinematic. See [moonlight](moonlight.md) |
| `cloud_city_glow` | 2 | Cinematic ground-light scattering into clouds, from 0 to 8; 0 disables it |
| `atmosphere_multiple_scattering` | 1 | Bounded approximate secondary atmospheric scattering |
| `atmosphere_saturation` | 1 | Atmospheric scattering color saturation |
| `city_light_strength` | 1 | Linear city-source emission multiplier |
| `exposure_ev` | 0 | Global final exposure offset in stops, from −10 to +10 |
| `adaptation_s` | 0.75 | Positive exposure response time in presentation seconds |

Radii must be positive and summit radius cannot exceed ground radius. Radiance/geometry multipliers must be nonnegative; `adaptation_s` must be positive and `exposure_ev` may be negative. These are artistic settings; they do not alter actual UTC time or change the date attached to data.

## Weather and the three clocks

The **video clock** determines shot timing. The **physical clock** interpolates the itinerary's actual UTC departure, arrival, and connection times, then holds at the endpoints; sunlight and celestial calculations use this clock. The **weather clock** continues through departure and arrival holds, sampling twenty minutes before the first departure through twenty minutes after the last arrival. Setting an endpoint hold to zero removes that endpoint's weather extension.

`weather.mode` defaults to `clear`. Other accepted modes describe the requested data semantics:

- `clear`: intentionally omits cloud/weather fields; atmospheric scattering remains, without claiming clear-weather observations.
- `forecast`: samples for the itinerary's UTC dates from a forecast whose coverage includes them.
- `historical`: samples for the itinerary's UTC dates from archived observations or reanalysis, with the provider identified.
- `illustrative_replay`: uses different weather dates only when explicitly selected, with both `sample_start` and `sample_end` supplied as offset-aware timestamps. The entire weather clock, including end holds, maps to that sample interval. The physical clock stays on the trip date.

Example replay: `{"mode":"illustrative_replay","sample_start":"2020-05-01T00:00:00Z","sample_end":"2020-05-02T00:00:00Z"}`. Replay is illustrative weather, not a forecast of the trip. Configuration validation does not download or certify a provider's data availability. A renderer must check date coverage and provenance before using forecast or historical caches; never silently relabel a cache from another date. Sample timestamps are rejected outside explicit replay mode.

## Python interface and identity

`load_trip(path)` or `trip_from_dict(data)` returns a `Trip`; invalid input raises `TripError`. `Trip.airports` contains the defined airport objects. `Trip.airport_sequence` contains the first departure followed by every arrival, preserving repeated visits. `Trip.legs` contains `Flight(origin, destination, depart, arrive, aircraft, trajectory=None)`; all `depart` and `arrive` values are aware UTC datetimes. `departure` and `arrival` are aliases. `Trip.utc_times` is the flat departure/arrival sequence; `Trip.leg_intervals` contains video `(start, end)` seconds. `Trip.layover_holds_s` is the optional tuple supplied by the configuration; `Trip.effective_layover_holds_s` resolves it or the scalar fallback into one duration per connection.

`active_leg(t)`, `progress(index, t)`, `travel_time(t)`, and `weather_time(t)` calculate deterministic timeline state. `to_dict()` returns normalized, reloadable JSON data. `to_plan()` returns route occurrences, UTC flight times, distances, video intervals, connection compression rates and warnings, output duration, weather sample bounds, trajectory sources/gaps, and settings. `fingerprint` is a SHA-256 of the normalized configuration, independent of JSON key ordering. Use it as **one component** of a render-cache key alongside renderer version, actual source-data hashes, quality settings, and aircraft-model version; it alone does not prove that a cache is valid.

Validate without render dependencies:

```sh
python3 scripts/trip.py examples/sample-three-leg.json
```
