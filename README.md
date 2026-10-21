# Route Replay

A self-contained agent skill and offline renderer for 9:16 flight reels. Describe a trip in JSON; reuse the same engine for its route, dates, aircraft and cinematic treatment.

[GitHub](https://github.com/nathangathright/routereplay) · The installable skill identifier remains `cinematic-flight-videos`.

The renderer combines a north-up globe, terrain relief, dated Sun/stars/Moon, causal modeled city lighting, wind-advected clouds, atmospheric scattering and aircraft rendered in Blender Cycles. Scene layers share linear light and camera depth before a single exposure and tone mapper. The final video is display-referred H.264. Historical textures, reconstructed weather and artistic scale choices are identified in its provenance.

## Use the skill

Clone `https://github.com/nathangathright/routereplay.git`, then copy `skills/cinematic-flight-videos` into your agent's skills directory, or point a skill installer at this repository. The folder includes the runtime and references; it does not depend on a parent checkout. Ask: “Use cinematic-flight-videos to make a globe reel from this itinerary.”

For direct use, install Python 3.10+, Blender, FFmpeg and ffprobe, then install the Python dependencies in your preferred virtual environment:

```sh
python3 -m pip install -r skills/cinematic-flight-videos/scripts/requirements.txt
python3 skills/cinematic-flight-videos/scripts/flight_video.py doctor
python3 skills/cinematic-flight-videos/scripts/flight_video.py plan skills/cinematic-flight-videos/examples/sample-single-leg.json
```

The examples are synthetic, not flight schedules or bookings. Copy one to a work directory and edit it using the [trip format](skills/cinematic-flight-videos/references/trip-format.md). It supports one or more connected flights, repeat airport visits, explicit time zones, separate weather dates, optional timed MSL trajectories, and a distance-weighted video timeline. Supplied observations retain their coordinates and timestamps; missing observations are marked as interpolated gaps. Without a track, routes and altitude arcs remain illustrative.

[Import a local CSV, GPX, KML or IGC track](skills/cinematic-flight-videos/references/track-imports.md) into a new trip file with `flight_video.py import-track`. Optional `--telemetry` adds cumulative distance, physical MSL altitude and ground speed, with explicit estimate and missing-data markers. It is off by default; no tracking-service account or automatic retrieval is involved.

[Flight motion and moments](skills/cinematic-flight-videos/references/storytelling.md) add optional modeled bank/pitch, `--pacing highlights`, and UTC-anchored local photo/video cards. All three keep the north-up globe and run locally; default behavior is unchanged.

An experimental [rear-quarter camera](skills/cinematic-flight-videos/references/chase-camera.md) renders short third-person studies in a shared Blender scene. Its local maneuver is modeled and its cloud field is frozen at the shot midpoint. A shared spherical atmosphere and curved near/far cloud fields add horizon depth. It remains separate from the globe renderer.

Optional local extensions include dated aerosol and snow/sea-ice fields, ERA5 import, local DEMs, attributed survey/material calibration and machine-local render budgets. Read the [completed roadmap and remaining physical approximations](skills/cinematic-flight-videos/references/realism-roadmap.md).

## Prepare and render

```sh
python3 skills/cinematic-flight-videos/scripts/data.py bootstrap --destination data/november --month 11
python3 skills/cinematic-flight-videos/scripts/flight_video.py preview trip.json --assets data/november --workdir renders --quality preview
python3 skills/cinematic-flight-videos/scripts/flight_video.py budget trip.json --assets data/november --workdir renders --samples 3
python3 skills/cinematic-flight-videos/scripts/flight_video.py render trip.json --assets data/november --workdir renders
```

Static downloads come from NASA, NOAA, Natural Earth and CDS. They are substantial and cached locally. See [data sources](skills/cinematic-flight-videos/references/data-sources.md) for import, weather preparation, credits and limitations. A failed download stops with an error; it does not fabricate a substitute.

`preview` produces selected frames and a contact sheet. `--quality preview`, `delivery` and `high` change sampling budgets while preserving clocks, geometry and seeds; the default is `delivery`. Use `--aircraft diagram` for a faster layout proof without Blender, or `--frames 0,90,180` to select frames. Full rendering outputs 1080×1920 silent H.264, plus provenance, per-frame physical context, causal-light preparation metadata, frame timings and decode verification. Matching work resumes; changed inputs create a different cache directory. Inspect previews before a full encode, especially label placement on unusual routes.

Weather modes are explicit: matching forecast, prepared historical data, clearly identified replay, or clear skies. Dates outside available forecasts still work with astronomy and clear skies; they do not acquire invented future weather. The current GFS converter accepts a selected run. The explicit `ncei-0p50` provider retrieves available NOAA archived forecasts, checks availability and caches verified records for offline conversion. Archived forecasts remain model output, not reanalysis or observed weather. Optional local MSL terrain grids can be attached with `data.py attach-terrain`; the bundle records their source and hash, and the renderer uses them for terrain shading and aircraft ground sampling. Automatic track retrieval and local DEM acquisition are not included.

Four dimensional aircraft illustrations are included: A321neo, 777-200ER, 787-9 and 757-300. Optional self-contained static GLB files can replace them. Dated regional lighting profiles can supply attributed chromaticity, with optional populations and curfews. See [local inputs](skills/cinematic-flight-videos/references/local-assets.md) for formats and limits.

`--transport joint` enables a slower local CPU integration of cloud and atmosphere extinction and in-scattering. The existing `layered` mode remains the default. Both retain approximate multiple scattering; benchmark matched preview frames before committing to a full film. All rendering runs on the individual's computer after explicit asset preparation. No hosted backend, account system or background service is required.

[Bird’s-eye performance](skills/cinematic-flight-videos/references/birdseye-performance.md) covers reusable HDR scene caches, Metal weather preparation, batched atmosphere/cloud rays and lighting queries, conservative empty-space skipping and optional atmospheric lookup tables. Overlay-only revisions reuse the expensive physical scene.

Optional [spatial volume reconstruction](skills/cinematic-flight-videos/references/volume-reconstruction.md) adds depth/opacity-aware cloud and atmosphere enlargement with selective exact-pixel rays. `--volume-reconstruction adaptive` retains independent frames and full-resolution aircraft foreground transport; `full` supplies a spatial comparison at the same integration budget. The original `reference` mode remains the default. Compare neighboring frames and measure the added cost before choosing a mode for a whole film.

Optional [local acceleration](skills/cinematic-flight-videos/references/local-acceleration.md) selects Cycles Metal, MLX atmospheric and cloud light-path kernels and hardware VideoToolbox encoding independently. CPU/x264 remain defaults. Shadow-aware view integration also resolves twilight bands without relying on random jitter or globally increasing the sample budget.

City lights illuminate nearby clouds using the same dated lamp colors and activation as the surface. The local scattering approximation follows weather density and physical height; `style.cloud_city_glow` adjusts its cinematic strength. Dusk visibility comes from the changing scene brightness and shared exposure, without a separate reveal mask. Route graphics show only the trail already flown.

VideoToolbox exports `video-videotoolbox.mp4` with `verification-videotoolbox.json`; it preserves the default x264 output and reuses the same frame cache.

## Develop

```sh
npm run list
npm test
npm run check:distribution
npm run check:public
npm run export:skill
```

Node is only a convenience for these script aliases; each command delegates to Python. CI runs the portable validation suite without downloading Earth data or rendering in Blender.

The canonical engine lives inside the skill. Read the [architecture](skills/cinematic-flight-videos/references/architecture.md) before changing clocks, data, geometry or caches. The [realism roadmap](skills/cinematic-flight-videos/references/realism-roadmap.md) records implemented stages and remaining limits. Linear HDR here means internal scene-relative light, not calibrated radiometry; lamp populations and sub-grid clouds remain models. Keep cinematic exaggeration adjustable instead of baking it into source data.

## Share a clean distribution

`npm run export:skill` creates `dist/routereplay` from an allowlist, with a checksum manifest. It includes the installable skill, examples, tests and CI. It excludes legacy trip projects, personal itinerary evidence, downloaded data, rendered videos, local addresses and Git history. The exporter refuses to overwrite a nonempty destination.

The public repository starts from a clean snapshot. Keep personal trips in an external work directory or in ignored `private/`, `trips/` and `tracks/` directories. Credentials, downloaded datasets, render caches, media and local preview sites are ignored. The bundled small, licensed font and reference spectra are intentional source assets.

`npm run check:public` checks every tracked file against the distribution allowlist and rejects private paths/links, credential files, media, unexpected binary files and files over 1 MiB. Add new source files explicitly to the allowlist. Ignore rules do not remove already committed files or history: inspect `git diff --cached`, scan secrets, and audit any existing history before publishing it. Automated checks cannot identify every kind of personal information in free text or trip JSON.

Original code is MIT licensed. Downloaded data and dependencies retain their own terms, linked from each asset manifest.

Bundled CIE reference spectra and their derived numerical lamp palette are attributed under CC BY-SA 4.0; the surrounding Python code remains MIT. See [sources, conversion and data licensing](skills/cinematic-flight-videos/references/lamp-spectra.md).

City lights use separate reference-spectrum mixtures for streets, buildings, signs and persistent sources. Their color balance follows which populations remain active, while total modeled luminance is conserved. Optional dated profiles can override selected populations; the [Chicago/Auckland example](skills/cinematic-flight-videos/examples/city-lighting-chicago-auckland.json) uses municipal evidence for outdoor-lighting anchors and explicitly modeled coverage/proportions. It is not a measured city color map. See [the night-light model](skills/cinematic-flight-videos/references/night-light-model.md).

Cloud lighting uses volume scattering and three atmosphere-derived sky directions, with cloud density attenuating each incoming path. `style.cloud_lighting` blends the earlier shading (0) with the new default (1), without altering cloud shapes, opacity, city glow or camera exposure. See [the lighting model and its limits](skills/cinematic-flight-videos/references/cloud-lighting.md).

Moonlight uses one dated, phase-dependent source across clouds, terrain, ocean reflections and Cycles aircraft self-shadows. `style.moonlight` sets the cinematic multiplier: 4000 by default, 1 for the unboosted reference and 0 to disable it. Shared air/cloud extinction and the physical horizon attenuate it; enabled lunar lighting reduces the old terrain/aircraft night fill. The earlier `cloud_moonlight` key remains an alias. See [moonlight and its limits](skills/cinematic-flight-videos/references/moonlight.md).
