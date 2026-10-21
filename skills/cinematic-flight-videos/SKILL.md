---
name: cinematic-flight-videos
description: Create and refine cinematic 9:16 globe flight videos from itineraries, with date-aware astronomy, terrain, city lights, animated weather and aircraft. Use for flight-route reels, new trip editions, or improvements to this renderer's realism.
---

Use the bundled renderer; create a trip JSON instead of copying or editing the engine for each journey. Resolve paths relative to this skill directory. Python 3.10+, the packages in `scripts/requirements.txt`, FFmpeg/ffprobe and Blender are the rendering dependencies. Planning uses only the standard library.

For modeled aircraft bank/pitch, flight-phase pacing or local photo/video moments, read [storytelling.md](references/storytelling.md). Keep these opt-in. Distinguish modeled pose from recorded attitude, use the shared physical clock, and inspect cards against airport labels.

For an experimental third-person aircraft shot, read [chase-camera.md](references/chase-camera.md) and use the separate `scripts/chase_preview.py` command. Keep its modeled maneuver and frozen weather explicit. Inspect rendered stills before a full clip; it does not replace or automatically join the globe film.

## Prepare the trip

Read [trip-format.md](references/trip-format.md) and start from an appropriate JSON in `examples/`. Gather airport coordinates, IANA time zones, departure/arrival dates and offsets, and aircraft types. Preserve booking facts separately from current published schedules. Do not infer a registration or claim a live aircraft assignment from a model name. The bundled dimensional illustrations support A321neo, 777-200ER, 787-9 and 757-300; adding another type requires geometry and validation.

Run these commands with the real skill path in place of `$SKILL_DIR`:

```sh
python3 "$SKILL_DIR/scripts/flight_video.py" doctor
python3 "$SKILL_DIR/scripts/flight_video.py" plan trip.json
```

Review the normalized UTC chronology, all connections, weather sample interval and video timing. Arbitrary connected leg counts are supported; airport visits are distinct even when a code repeats. Without a supplied trajectory, coincident or exactly antipodal endpoints need an intermediate airport. Supplied trajectories must contain nonzero travel and unambiguous segments.

If observations are supplied, use `flight_video.py import-track` to attach a local CSV, GPX, KML or IGC segment to one flight. Read [track-imports.md](references/track-imports.md) for supported records, explicit altitude conventions and selection flags. Import into a new trip file, then inspect its plan, reported gaps and terrain clearance. Preserve UTC timestamps, coordinates and geometric MSL metres; describe conversions in the source. Direct `trajectory` JSON remains supported by [trip-format.md](references/trip-format.md). Without observations, the route and altitude remain explicitly illustrative. Track import uses local files and does not retrieve data from tracking services.

When requested, enable the optional distance, MSL altitude and ground-speed overlay with `--telemetry`, or set top-level `telemetry.enabled` in the trip. `--telemetry-units aviation` selects NM/FT/KT; `metric` selects KM/M/KM/H. Readouts use physical time and altitude. Preserve the `≈` estimate markers and `—` for unavailable values; do not present a reconstructed route as measured telemetry. See [telemetry settings](references/trip-format.md#optional-telemetry).

## Resolve data honestly

Read [data-sources.md](references/data-sources.md) when preparing or changing assets. Bundles contain checksums and provenance. Bootstrap static assets for the departure's local calendar month, or import an existing verified bundle. Large datasets and personal itineraries belong in the caller's work directory, outside this installed skill.

```sh
python3 "$SKILL_DIR/scripts/data.py" bootstrap --destination data/november --month 11
```

Select weather deliberately: `forecast` needs matching forecast timestamps, `historical` needs a prepared historical bundle, `illustrative_replay` explicitly maps other dates, and `clear` renders without weather. Missing data or dates outside a bundle's coverage are errors. Never silently substitute weather or relabel replay as a forecast. The GFS preparer requires an explicit run and checks its available hours; it cannot predict dates beyond the selected run. Use the local GFS preparer's explicit `ncei-0p50` provider for archived forecasts where NOAA has the selected run. Availability checks, a verified local cache and `--offline` support repeatable acquisition without a service; archived forecasts remain `forecast`, not observations or reanalysis.

For optional user-supplied static GLB aircraft and dated regional lamp chromaticity/population mixtures, read [local-assets.md](references/local-assets.md). Attach them to the data bundle; retain their provenance, dimensions, validity and license. Version-2 lighting profiles can override selected populations using the reference lamp families. The Chicago/Auckland example has municipal outdoor-lighting anchors with modeled mixture proportions and coverage; it is not a survey and is never enabled automatically. The earlier version-1 lighting example remains synthetic.

## Preview, then render

```sh
python3 "$SKILL_DIR/scripts/flight_video.py" preview trip.json --assets data/november --workdir renders
python3 "$SKILL_DIR/scripts/flight_video.py" render trip.json --assets data/november --workdir renders
python3 "$SKILL_DIR/scripts/flight_video.py" verify renders/RENDER_KEY/video.mp4
```

`--quality preview` reduces sampling cost; `delivery` is the default for both commands, and `high` increases integration detail. These profiles share geometry, dates and seeds. `--transport joint` opts into a slower CPU path that integrates cloud and air extinction/scattering together; `layered` remains the default. Compare a few matched frames before choosing joint transport for a full film.

`preview` renders departure, each flight apex/arrival and the final hold, with a contact sheet. `--frames 0,90,180` selects exact frames. `--aircraft diagram` explicitly substitutes a fast 2D layout proof; it does not validate aircraft geometry, shadows or materials. Default `cycles` builds the dimensional 3D aircraft with dated Sun and Moon lighting. `--workers 2` controls CPU/memory use. Matching renders resume from cached frames; trip, data, code, fonts and environment changes create a new final-frame cache directory. A separate lossless HDR scene cache can be reused for overlay-only changes; it requires additional local disk space.

For scene reuse, Metal weather preparation, batched atmospheric integration, cloud view/source batching and bounded atmosphere lookup tables, read [birdseye-performance.md](references/birdseye-performance.md). Benchmark the complete configuration and preserve reference paths for comparisons.

For spatial detail, `--volume-reconstruction adaptive` adds depth/opacity-aware reconstruction and selective output-pixel rays; `full` is a spatial reference with unchanged per-ray quadrature. Both preserve independent frames and use full-resolution aircraft foreground transport. The default remains `reference`. Read [volume-reconstruction.md](references/volume-reconstruction.md), compare consecutive frames, and measure cost before a full export.

For optional Cycles Metal, MLX air/cloud light-path integration or VideoToolbox encoding, read [local-acceleration.md](references/local-acceleration.md). Benchmark matching frames on the individual's machine; more GPU use is not automatically faster for small aircraft images. CPU and x264 remain the portable defaults.

Inspect the contact sheet before a full encode: route order, north-up orientation, airport proximity and unambiguous leader lines, stable label placement, transitions at every stop, unequal zoom apexes, night/day, cloud/aircraft occlusion and phone-scale contrast. Generated label slots are a starting layout; unusual routes may require a layout algorithm improvement. Do not ship a visually confusing result merely because numeric checks pass.

The current cinematic preset keeps the plane centered, scales zoom by relative route distance, and recedes departed labels with the ground. By default, split-flap airport codes are the only on-screen text; telemetry adds a compact readout near the top when enabled. These are configurable creative defaults, not restrictions on future user requests. The implementation currently renders at 1080×1920; changing aspect ratio requires coordinating every layer.

Deliver the MP4 with `provenance.json` and `verification.json`; retain `frame-contexts.json`, `prepass.json` and `performance.json` for traceability. Explain which weather mode was used and any material data gaps. The encode includes descriptive metadata without adding on-screen text. No music is bundled; platform music availability and licensing are separate from video generation.

With `--encoder videotoolbox`, deliver `video-videotoolbox.mp4` and `verification-videotoolbox.json` instead; the original x264 files are preserved.

## Improve the renderer

Read [architecture.md](references/architecture.md) before changing shared geometry, clocks, caches or compositing. Use [realism-roadmap.md](references/realism-roadmap.md) for prioritization, and [night-light-model.md](references/night-light-model.md) for the distinction between measured lighting anchors and modeled behavior.

Keep physical state separate from cinematic display choices. A repeatable camera or lighting prepass must not depend on parallel frame order. Verify affected behavior with portable tests and a small rendered comparison, then inspect decoded output. Add provenance for new sources and keep weather, astronomy and view geometry synchronized. The engine composites scene-relative linear HDR with one final exposure/tone mapper, shared aircraft depth, advected cloud density, curved atmospheric transport and a causal lamp-state prepass. Its output remains display-referred video. Joint transport, supplied tracks, local DEM tiles, static GLB aircraft and attributed regional lighting profiles are supported. Automatic track retrieval, automatic high-resolution terrain acquisition, a measured global lamp inventory and individual-cloud observations are not. Keep those distinctions in the provenance.

Keep improvements deployable as an individual skill: local files, explicit acquisition, bounded caches and optional local compute. Preserve offline rendering after preparation. Do not introduce a hosted control plane, account system or required background service.

## Optional local extensions

- For dated aerosol, snow/sea-ice, ERA5 or geographic GeoTIFF inputs, read [data-adapters.md](references/data-adapters.md). Prepare explicitly with `scripts/data_adapters.py` or `scripts/era5_import.py`; attach products with `scripts/data.py`. Preserve dates, units, source/license and conversion assumptions. Environment products follow the weather clock, including explicit replay.
- For supplied survey controls, procedural aircraft materials or lamp-measurement uncertainty, read [calibration.md](references/calibration.md). Never label a modeled footprint or artistic material as measured.
- Before a costly export, use `flight_video.py budget` with the intended quality, transport, aircraft, device and workers. Read [render-budgets.md](references/render-budgets.md); report its range and unmeasured costs, and reuse the compatible cache. `--estimate-only` reads an existing exact configuration.
- Moonlight includes camera-visible air scattering, a bounded local land bounce and nearby terrain shadow sampling. See [moonlight.md](references/moonlight.md) for the physical and cinematic conventions.
