# Import recorded tracks

Use a local track file to attach observations to one flight in an existing trip.
The importer writes normalized trajectory data into a new trip JSON; it does not
contact tracking services, authenticate to a provider or retrieve missing points.
Keep the original recording and describe its recorder, export and any conversions
with `--source`.

For a GPX recording whose elevations are documented as geometric MSL metres:

```sh
python3 scripts/flight_video.py import-track trip.json flight.gpx \
  --flight 1 --altitude-reference msl \
  --source "Recorder export; elevations documented as geometric MSL metres" \
  --output trip-with-track.json --telemetry
python3 scripts/flight_video.py plan trip-with-track.json
python3 scripts/flight_video.py preview trip-with-track.json \
  --assets data/november --workdir renders --quality preview
```

The recording must fit the selected flight's dates and endpoints. `--flight` is
one-based. `--output` must name a new file; the original trip, recording and prior
imports are never overwritten. If the selected flight already has a trajectory,
`--replace-trajectory` explicitly permits replacing it in the new file.

## Accepted records

| Format | Required content and altitude convention |
| --- | --- |
| CSV | Exactly `time,lat,lon,altitude_m` columns. Times carry explicit UTC offsets; altitude is already geometric MSL metres. |
| GPX 1.0/1.1 | Timestamped track points with elevation. Declare the elevation reference with `--altitude-reference msl` or `ellipsoid`; a filename or recorder brand does not establish its datum. |
| KML 2.2 | Timestamped `gx:Track` records with matched time/coordinate arrays and `altitudeMode` set to `absolute`. These are MSL metres; a route line without per-point timestamps cannot provide this trajectory. |
| IGC | Valid GNSS fixes from B records, with an explicit `--date YYYY-MM-DD` agreeing with the file's DDMMYY date. GNSS ellipsoid heights require `--altitude-offset-m`; `--altitude-reference ellipsoid` is optional. Pressure altitude is unused; invalid fixes and zero GNSS altitudes break segments. |

GPX's metric coordinates and track structure are documented in the
[GPX schema](https://www.topografix.com/GPX/1/1/). The supported timed KML records
are described in Google's [gx:Track reference](https://developers.google.com/kml/documentation/kmlreference#gxtrack).
IGC fix validity, dates, GNSS altitude and pressure altitude are separate fields
in the [IGC flight-recorder specification, Amendment 8](https://www.fai.org/sites/default/files/igc_fr_specification_with_al8_2023-2-1_0.pdf).
The importer supports the subset above, not every construct in those formats.

`--format auto` detects the format from file contents. Use
`--format csv|gpx|kml|igc` to select a parser explicitly. If a file contains multiple segments, select one
explicitly with zero-based `--segment`, for example `--segment 0`. Segments are
not silently joined across recording breaks. Import separate flight recordings
by repeating the command on the preceding output, using a new output filename
each time.

Inputs must be local UTF-8 text, at most 32 MiB and 100,000 observations.
Compressed KMZ, GPX routes without track points, XML entities and external
resources are unsupported. GPX points need a valid 3D fix if a fix type is
declared. IGC security signatures are not verified; subsecond or extra-coordinate
precision extensions require external normalization.

## Altitude and time

The renderer requires geometric metres above mean sea level. Ellipsoid height,
pressure altitude, flight level and terrain-relative height are different
quantities. Confirm the recording's convention before selecting an import flag.

For explicitly declared ellipsoid heights, `--altitude-offset-m` supplies a
documented constant conversion: output MSL altitude equals input altitude plus
that offset. This is a limited-area approximation, not a geoid model for an
intercontinental flight. If a constant offset cannot represent the route,
convert each observation with appropriate external datum data and import the
resulting MSL CSV. Record that conversion in `--source`.

For example, an IGC recording with a verified additive offset of −30 m within
its limited flight area can be imported as follows. The offset is illustrative;
use the value established for the recording's location and vertical datum.

```sh
python3 scripts/flight_video.py import-track trip.json flight.igc \
  --flight 1 --date 2026-10-19 --altitude-offset-m -30 \
  --source "Recorder export; verified local ellipsoid-to-MSL offset -30 m" \
  --output trip-with-igc.json
```

An ellipsoid offset must be finite and within ±1000 m. GPX `geoidheight` is not
applied implicitly. KML absolute altitude and normalized CSV already use MSL,
so they reject an added datum offset.

GPX, KML and CSV timestamps must identify their UTC offset. IGC's explicit full
date avoids guessing a century from DDMMYY; UTC midnight crossings must retain
chronological order. Import does not infer flight dates from filenames, current
time, airport time zones or weather dates.

At least two observations are needed. Times must increase strictly and fall
within the selected flight. Coordinates are WGS84 degrees, with latitude in
[-90, 90] and longitude in [-180, 180]; MSL altitude must be finite within −500
to 25,000 metres. Observations exactly at departure or arrival must be within
20 km of the corresponding airport. Duplicate or reversed timestamps,
ambiguous antipodal segments and invalid coordinates fail validation.

`--max-gap-s` defaults to 300. Longer intervals and missing beginning/end
observations remain explicit gaps in the plan. The film connects them using
the documented trajectory fallback; it does not describe the connection as an
observation. Check the plan and terrain-clearance diagnostics before rendering.
See [the trajectory schema](trip-format.md#supplied-trajectories) for interpolation
and physical versus displayed altitude.

## Optional telemetry

Add `--telemetry` during import to save the overlay setting in the new trip, or
enable it only for a `plan`, `preview`, `render` or `budget` invocation. Aviation
units are NM/FT/KT; `--telemetry-units metric` selects KM/M/KM/H. A units flag also
enables the overlay unless paired with `--no-telemetry`.

The overlay shows cumulative journey distance, physical MSL altitude and
horizontal ground speed. It uses the flight's physical clock even when the
video compresses hours into seconds. Distance stays constant and speed is zero
during holds. A terminal altitude is shown only when an observation exists at
that exact arrival or departure. Estimated values carry `≈`; missing altitude
or speed carries `—`. An illustrative or gap-filled portion marks the cumulative
distance as estimated. See [all telemetry conventions](trip-format.md#optional-telemetry).

Telemetry uses the bundled rounded Dosis font. Its
[font source and license](../assets/fonts/dosis/README.md) travel with the skill.
`FLIGHT_TELEMETRY_FONT` accepts a locally licensed TrueType/OpenType replacement.
