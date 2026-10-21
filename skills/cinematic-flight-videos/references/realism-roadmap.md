# Cinematic realism roadmap

All six rendering foundations and the first local-extension release are implemented in the portable engine. Validation covers recorded-path fixtures, three- and four-stop journeys, long layovers, actual Blender depth exports and rendered frames. The approved earlier films remain preserved separately.

## Implemented foundations

| Priority | Implementation | Validation |
| --- | --- | --- |
| 1 · Linear HDR | Scene-relative float RGB from terrain, celestial bodies, lights, clouds, atmosphere and aircraft; one causal exposure prepass and one final display transform. | HDR values survive transport and resizing; exposure is deterministic; actual Cycles output retains highlights above diffuse white. |
| 2 · Coherent clouds | Seeded detail follows wind backtraces in Earth coordinates. Camera, aircraft and Sun rays integrate the same density. Phase and approximate multiple scattering are adjustable. | Shared extinction, depth ordering, temporal advection, shuffled frame order, real weather-field smoke renders and profile comparisons. |
| 3 · Aircraft integration | Cycles emits linear radiance, alpha and ray depth. Aircraft and globe share Sun direction, projection and depth units; clouds and haze terminate at the aircraft surface. | Linear cache integrity, solar visibility, depth tests and actual Blender renders. Physical MSL altitude remains separate from cinematic height exaggeration. |
| 4 · Causal city lights | Regional modeled lamp mixtures, local mean solar-time schedules, photocontrol hysteresis and cloud-darkened illumination feed a chronological prepass. Workers read immutable snapshots. | Dusk/dawn hysteresis, long layovers, polar/dateline continuity, repeat visits and shuffled rendering produce repeatable results. |
| 5 · Curved atmosphere | Rayleigh/Mie transport uses spherical paths, Earth shadow and optical-depth reddening, with a bounded approximation for multiple scattering. | Tangent paths, solar shadow, attenuation, forward scattering and depth termination are covered numerically and checked in images. |
| 6 · Tracks and local terrain | Optional timestamped MSL waypoints preserve observed positions and altitudes; gaps are labeled illustrative. Optional attributed local DEM tiles refine terrain height, normals, silhouettes and aircraft clearance. | Track round trips, turns, gaps, bad datum rejection, tile seams, normals, source hashes and terrain clearance checks. |

The portable suite and a separate itinerary matrix cover mixed connections, repeated airports, DST changes, year rollover and separate physical/weather clocks. Independent exported-copy runs check that the skill works without access to its development repository.

Modeled bank/pitch, monotone highlights pacing and UTC-anchored local media moments are implemented as optional local features. They retain the north-up composition and preserve existing defaults. See [flight motion and moments](storytelling.md) for their limits. A separate experimental [rear-quarter camera](chase-camera.md) now renders short full-scene studies with modeled bank, shared spherical air, and frozen curved near/far weather volumes. Modeled vertical cloud deformation adds uneven silhouettes; the distant field reaches 500 km from the shot origin. Animated chase weather, continuous camera transitions, interactive 3D inspection, measured attitude imports and altitude-ribbon styling remain future work.

Local CSV, GPX, KML `gx:Track` and IGC imports now attach one explicitly selected recorded segment to a flight, retaining source, datum and gap provenance in a new trip file. Optional telemetry shows cumulative horizontal journey distance, physical MSL altitude and physical-time ground speed, marking estimates and unavailable values. Imports and rendering use ordinary local files; see [formats, conversion requirements and telemetry](track-imports.md).

City color now comes from six CIE reference lamp spectra with independent outdoor, building, sign and persistent mixtures. Activity changes their combined chromaticity while preserving the existing modeled luminance budget. Optional dated profiles select population mixtures within specified regions; Chicago/Auckland examples provide municipal outdoor-lighting anchors with modeled proportions and coverage. The historical grayscale footprint, global priors and RGB transport remain approximations; see [night lighting](night-light-model.md).

City emission now also illuminates nearby clouds in both volume modes. The bounded local approximation shares the surface lamp colors, schedules and causal state, samples a physical ground footprint and attenuates through weather density. Dusk contrast emerges from changing daylight and the common exposure; no extra terminator reveal is applied. `cloud_city_glow` controls the effect, with zero restoring the earlier cloud-lighting behavior. The approximation and its radial-column limits are described in [architecture](architecture.md).

Cloud lighting now uses a shared volume source in both modes: direct and three approximate secondary solar orders, plus directional atmosphere-derived sky light attenuated through the cloud density. The fixed blue ambient and pseudo-surface normal are absent at the default setting. `cloud_lighting=0` retains the earlier shading for comparisons. See [lighting method and limits](cloud-lighting.md).

Cloud morphology now uses layered cellular billows, coverage gaps and smoothly renewed wind-advected material. Half-degree maps and a four-hour maximum material age prevent the severe stretching caused by following one procedural seed through an entire long trip. `cloud_morphology=0` preserves the earlier reconstruction. Lighting and exposure controls are independent. See [shape, motion and limits](cloud-morphology.md).
Clouds, terrain, ocean and Cycles aircraft now receive shared date- and phase-dependent moonlight, with physical-horizon blocking and approximate eclipse attenuation. The default brightness is explicitly cinematic. Camera-facing lunar air scattering, a bounded local surface bounce and sampled nearby terrain shadows are implemented; see [scope and limits](moonlight.md).


## Local extensions in v0.3

| Improvement | Individual deployment | Validation and limits |
| --- | --- | --- |
| Joint cloud and atmosphere | Optional `--transport joint` CPU mode integrates both media on shared camera and Sun paths. | Analytic attenuation, depth, ordering and convergence tests; real-field comparisons and a combined Cycles smoke. Multiple scattering remains approximate. |
| Historical weather acquisition | Explicit NOAA NCEI archive adapter, availability checks, bounded direct downloads, verified cache and offline conversion. | A real 98-record archive conversion succeeded; repeating it offline made zero requests. Archive gaps fail explicitly. Archived forecasts are not reanalysis or observations. |
| Local aircraft geometry | Attach a static self-contained GLB with source, dimensions and orientation. Existing procedural models remain defaults. | Actual Blender imports, direct-Sun response, shared depth and all four procedural checks. No automatic model download, rig animation or CAD-accuracy claim. |
| Regional light evidence | Attach dated geographic CIE xy profiles with measured/modeled basis and optional populations/curfews. | Geography, dates, overlaps, defaults and worker-loading tests. No global measured lamp database is bundled; example values are synthetic. |

See [data preparation](data-sources.md) and [local inputs](local-assets.md). All features run from the installed skill and ordinary local files. Internet access is used only for explicit source acquisition; prepared rendering remains offline.

## Controls that keep trips reusable

Use a trip JSON for airport coordinates, IANA time zones, offset-bearing dates, connected legs and aircraft. Repeated airport visits get independent label lifetimes. Example files include a four-stop itinerary with 79-hour layovers and a clearly labeled synthetic trajectory.

Physical UTC controls astronomy and lamp schedules. Weather UTC controls meteorology; presentation seconds control the edit. An explicit replay can map weather onto another date, while end holds continue weather motion. No renderer silently turns a replay into a trip-date forecast.

`--quality preview`, `delivery` and `high` change sampling budgets while preserving geometry, clocks, fields and seeds. Cache keys include source, data hashes, trip, quality, transport mode, fonts and tool versions. Outputs carry provenance, frame contexts, prepass metadata, performance timings and decode verification.

## What remains approximate

The renderer produces scene-relative linear light, not calibrated photometry. Historical seasonal surfaces and the 2016 night composite are not travel-date observations. Night-light locations constrain emission; lamp populations, color mixtures and schedules are modeled rather than a measured global fixture inventory. Local schedules use mean solar time, not civil time-zone polygons.

Weather fields constrain coverage, mass, height and wind. Individual billows are seeded reconstructions; wind backtraces use a bounded numerical approximation. The default cloud and atmosphere paths remain separate layers. The optional joint mode combines their extinction and local source terms but does not solve global angular multiple scattering. Aircraft use dimensioned procedural illustrations or supplied static GLB geometry and remain deliberately enlarged on screen.

Actual trajectories require user-supplied or legitimately acquired observations. Interpolation between records is still interpolation; missing intervals and terminal gaps stay visible in provenance. Local DEM tiles need their own source, license and MSL datum. A coarse global grid cannot establish surveyed runway clearance.

## Completed individual-install roadmap

All four previously listed extension areas now have local implementations:

| Item | Delivered | Limits |
| --- | --- | --- |
| Broader GPU kernels | Optional MLX point-density batches and the joint primary solar cloud integral, retaining CPU geometry and reference code. | M1 Max matched preview frames measured 1.06× for layered frame 330 and 2.62× for joint frame 450, excluding identical weather/exposure preparation. Whole-film speed depends on the scene; most geometry, compositing and preparation remain CPU work. |
| Dataset adapters | Explicit NOAA GFS snow/sea-ice acquisition, local aerosol NetCDF import, ERA5 pressure/single-level conversion, and bounded geographic GeoTIFF terrain import. Dated fields affect haze, sunlight, surface reflectance and water glint. | Sources require usable licenses and supplied files where authentication is needed. Forecast is distinct from reanalysis; snow depth-to-cover and aerosol vertical/material properties remain declared models. No acquisition occurs in a frame render. |
| Local calibration | Attributed point surveys, procedural aircraft material overrides, and regional lamp uncertainty metadata. Shared terrain sampling drives surface, normals and clearance. | Survey footprints are modeled flat cores with feathered edges. Evidence dates are not promises of current accuracy. Material values are central estimates; uncertainty is recorded without randomizing frames. |
| Portable render budgets | A bounded local sample measures preparation, aircraft and frame stages; records machine/configuration identity; estimates remaining time and disk with ranges; reports cache progress and memory proxies. | GPU memory and encoding can remain unmeasured. Source/configuration changes invalidate reuse. A short benchmark is evidence, not a guaranteed completion time. |

See [local acceleration](local-acceleration.md), [dataset adapters](data-adapters.md), [calibration](calibration.md), [render budgets](render-budgets.md), and [lunar transport](moonlight.md) for commands, evidence requirements and approximations.

The follow-on lunar work is also implemented: camera-visible scattering, bounded indirect surface response and nearby terrain shadow sampling. These additions retain physical astronomy, explicit weather replay, linear light, shared depth and offline preparation.

## Research limits that remain

The roadmap's deliverables are complete at their documented scope. Full global multiple scattering, terrain path tracing, measured global lamp inventories, exact aircraft BRDFs and a real atmospheric fluid simulation remain outside that scope. Higher sampling and better legitimately acquired local data can improve particular shots; neither turns cinematic height, seeded clouds or modeled material constants into observations.

A hosted backend, shared account database and managed storage remain outside this project. The deployment unit is an individual skill installation with ordinary local files.

## Bird’s-eye performance follow-up

Implemented local HDR scene/overlay cache separation, exact-time Metal weather preparation, tiled cloud view integration retaining all lighting sources, conservative vertical occupancy skipping and optional clear-air optical-depth tables. CPU references and deterministic per-frame rendering remain available. See [scope and measurement procedure](birdseye-performance.md). Temporal-history reuse remains deferred.

The v0.17 follow-up adds optional Metal atmosphere view integration and batched cloud-light queries. Float64 shadow/depth geometry, dated Moon/aerosol inputs and all city-light samples are retained. Sparse corrections preserve solar density boundaries without repeating lunar work. Both options default to the reference path; unsupported configurations record their effective fallback in provenance. These changes accelerate the existing appearance rather than introducing a new lighting model.

The v0.18 follow-up implements [depth/opacity-aware spatial reconstruction](volume-reconstruction.md), fixed probes between coarse samples, and continuously weighted selective output-pixel rays. Aircraft foreground clouds use full crop sampling. A full spatial mode and neighboring-frame comparisons separate reconstruction error from actual weather motion. Each frame remains independent. These modes add sampling work and retain the existing per-ray quadrature and modeled lighting; they do not guarantee discovery of every thin cloud or integrate subpixel coverage.
