# Reusable rendering architecture

The skill is the portable unit. Its `scripts/` directory contains the trip model, data preparation, CLI and engine; it works when copied away from the development repository. Keep itineraries, downloaded data, aircraft caches and exports in a separate work directory. Preserved trip renderers are not dependencies of new trips.

## Clocks and frame state

| Clock | Controls | Rule |
| --- | --- | --- |
| Presentation seconds | Camera, labels, transitions, beacon animation, frame index | Deterministic at any requested frame; duration is an editorial choice. |
| Physical UTC | Sun, stars, Moon, aircraft pose/lighting, lamp schedules | Derived from validated flight timestamps and layovers. |
| Weather UTC | Coverage, profile interpolation, wind advection | Matches physical dates in forecast/historical mode; explicit replay maps it to another interval. |

Weather advances through departure and arrival holds while physical time stays at the booked endpoint. The plan records this cinematic choice. Coverage, winds, vertical profiles, cloud shadows and cloud-dependent lamp sensors use the same weather clock.

`engine/frame_context.py` provides an immutable `FrameContext`: the three clocks, camera basis and distance, Sun in world/camera coordinates, heading, terrain MSL, physical aircraft altitude, displayed altitude and observation/interpolation status. `frame-contexts.json` records each output frame and terrain-clearance diagnostics. Sun visibility uses physical altitude; artistic height exaggeration never changes eclipse timing.

## Linear scene and depth

`engine/radiometry.py` defines the shared contract:

| Quantity | Representation |
| --- | --- |
| Radiance | Unclipped nonnegative `float32` RGB. Diffuse white in direct Sun is approximately one; these are scene-relative units, not calibrated photometry. |
| Transport | Immutable `TransportLayer(radiance, transmittance)`, where radiance is additive in-scattering and transmittance has one or three channels. Compose with `layer.over(background) = radiance + transmittance * background`. |
| Coverage | Separate scalar alpha for opaque surface and aircraft antialiasing. RGB is premultiplied by coverage. |
| Depth | Positive distance along a normalized finite-camera ray, in Earth radii (6,371,000 m). Terrain uses zero for no hit; aircraft uses infinity outside coverage. |
| Coordinates | Earth-centered, Earth-fixed unit sphere; camera basis is right/east, up/north, outward. |

The finite perspective camera has a 70-degree full-canvas horizontal field of view. The apparent globe radius determines observer distance. Aircraft renders use the matching angles for a central 224×224-pixel crop; their lateral apparent size remains deliberately enlarged for playback. Terrain visibility samples the airframe's physical metre-scale footprint, so distant hills under that enlarged illustration cannot cut away a parked plane. A mesh-bound contact offset seats the lowest part above its terrain anchor. Clouds and atmosphere still use the cinematic display rays and surface depth. Terrain uses `relief_exaggeration`; clouds and displayed aircraft altitude use `max(1, relief_exaggeration)`. Physical metres and displayed heights are recorded separately. Atmospheric scale heights retain their own explicit cinematic spread.

Surface display textures are decoded to linear RGB. Catalog stars, the phased Moon, surface reflection, city emission, clouds, atmosphere and aircraft stay in float through scene compositing. Aircraft replaces only coverage in front of terrain; its cloud and atmospheric paths terminate at its depth. The default `layered` mode integrates cloud and atmosphere separately. Optional `--transport joint` combines their local extinction and source terms on shared camera and Sun paths. Both use bounded multiple-scattering approximations rather than a full angular path tracer.

`render.scene_exposure()` builds an immutable chronological exposure curve from a coarse viewport lighting proxy. It uses a causal log-exposure response in presentation seconds; `adaptation_s` controls its response and `exposure_ev` offsets the result. Each frame samples one coherent scene instant; this avoids doubled stars under the compressed travel clock. One exposure, smooth Reinhard shoulder and sRGB encoding follow scene composition; labels and route graphics are added afterward. The output is display-referred PNG/H.264, not HDR10 video. Legacy PIL layer functions are preview adapters and must not enter the linear scene pipeline.

## Layer implementations

- `starfield.py` supplies catalog positions, date-driven orientation and unclipped star radiance. Apparent point size and brightness remain aesthetic controls. `celestial.py` computes a finite-distance Moon, geometric phase and Earth occultation.
- `cloudvolume.py` samples a continuous Earth-coordinate reconstruction constrained by weather coverage and vertical profiles. Wind advection connects source times. Procedural material renews in two smoothly blended charts every two hours, anchored to the bundle's verified `valid_start`, with at most four hours of wind history. Half-degree material maps and cellular billows reduce stretched sheet artifacts; see [cloud morphology](cloud-morphology.md). All backtraces stay within available coverage. Camera extinction, solar attenuation, surface shadows and aircraft obscuration query the same density field. `CloudVolumeResult.layer` and `.foreground_layer` are float transport; old PIL properties are compatibility previews. Procedural detail is seeded reconstruction, not observed cloud geometry.
- `atmosphere.py` integrates spherical Rayleigh/Mie optical depth, Earth shadow, phase functions and a bounded local approximation of multiple scattering. `atmosphere_transport(...)` accepts terrain or aircraft depth and the shared camera/crop geometry. It is not a full angular scattering solution.
- `solar_visibility.py` supplies shared finite-Sun visibility and analytic shadow crossings for both volume modes. Ray intervals split at the centre and edges of the solar disc's shadow, preventing an entire coarse sample interval from switching between lit and dark. Disc area uses a local straight-limb approximation; solar extinction follows the central ray. No random jitter or temporal history enters this correction.
- `jointtransport.py` partitions camera paths at cloud/air shell boundaries, sums local extinction before Beer–Lambert attenuation and uses both media for direct solar attenuation. The same function clips at terrain or aircraft depth; the compositor applies it once instead of stacking the separate cloud/air layers. It is slower than the reference layered path and remains opt-in.
- `nightlighting.py` supplies linear `city_emission(..., physical_dt=..., weather_dt=...)`. Historical satellite intensity locates emission. `lampspectra.py` contains offline RGB values derived from six CIE reference spectra. Each source population has an independent unit-luminance mixture; emission sums population RGB times activity. Dated local profiles can override individual populations, while version-1 chromaticity profiles retain their common-color behavior. Regional mixture weights, photocontrol thresholds and local schedules remain modeled priors, not a global fixture inventory.
- `cloudlighting.py` supplies source RGB before view opacity: direct solar scattering plus three diminishing secondary orders, and a bounded clear-sky lookup from the existing atmosphere integrator. Solar visibility and RGB air transmission multiply the order sum once. Three upper-hemisphere directions are attenuated through the unchanged cloud field; sky solid-angle weights and normalized phase are explicit. The same source is used by layered and joint paths, including aircraft-prefix rays. The secondary orders and sparse directional sky remain approximations; see [cloud lighting](cloud-lighting.md).
- `moonlighting.py` reuses the dated lunar ephemeris for topocentric direction, nonlinear phase brightness, distance, physical-altitude horizon visibility and approximate eclipse attenuation. `cloudvolume._moon_source` adds lunar direct/sky light through shared density in both transport modes. `moonlight` is one explicit cinematic flux multiplier. `lunar_incident` supplies direct RGB through the same air/cloud field to relief-normal terrain shading, the ocean GGX lobe and a Cycles directional light with mesh self-shadows. Terrain/aircraft legacy night fill falls to 20% when enabled. Camera-facing lunar atmosphere shares depth and dated direct extinction; a bounded same-albedo surface bounce and nearby sampled terrain shadows extend the direct response. See [moonlight](moonlight.md).
- `cityglow.py` approximates ground-light illumination of cloud volume with nine fixed spherical source samples whose footprint grows with physical height above the local terrain datum. It queries the same dated, profile-colored city emission as the surface. A six-sample radial column through the shared weather density attenuates the source, with a bounded two-exponential approximation for diffuse penetration and approximate clear-air RGB extinction. The radial column represents the oblique footprint paths too; this is not a full angular or multiple-bounce solve. Cloud source radiance gains the result before view attenuation, in both layered and joint modes, including aircraft-prefix rays. No additional night mask, alpha change, or screen-space glow is introduced. `cloud_city_glow` controls its cinematic strength; zero avoids the additional source/density queries. Physical UTC drives lamps while weather UTC moves the clouds, including during end holds. Diagnostics that omit `physical_dt` omit this source.
- `aircraft_blender.py` exports Cycles Combined and Z passes through float EXR, then writes `frame-XXXX.npz`: schema version 2, `radiance[384,384,3]`, `alpha[384,384,1]`, `depth[384,384]`, and scalar `model_camera_height_m` / `ground_clearance_m`. The scalars retain physical mesh scale and contact clearance for terrain visibility. Radiance is premultiplied linear RGB and depth uses shared Earth-ray units. PNG companions are display previews only. Older schema-1 or PNG-only caches must be rebuilt. `--aircraft diagram` is an explicit 2D fallback.

## Inputs and deterministic preparation

`trip.py` validates airports, local offsets/IANA zones, connected legs, chronology, optional trajectories and weather mode. Airport occurrences are distinct from airport identity, so a repeated visit has its own label lifetime. `trajectory.py` retains supplied UTC observations and geometric MSL metres; `engine/motion.py` interpolates their positions and altitudes and marks gaps. Untracked legs retain illustrative great-circle routes and terrain-relative altitude arcs. See [trip-format.md](trip-format.md).

`data.py` validates source paths, hashes, grids and time coverage before rendering. `terrain_detail.py` uses the global ETOPO prior plus optional local MSL tiles for aircraft ground sampling, terrain intersection and normals. Local tiles are supplied through the documented adapter; there is no automatic high-resolution terrain provider. `gfs_archive.py` implements explicit current NODD and historical NCEI GFS acquisition with a bounded local SHA cache and offline reuse. Archived forecasts remain forecasts, and unavailable runs stop with an error. See [data-sources.md](data-sources.md).

`flight_video.py` prepares frame contexts and city-light state before dispatching workers. Lamp hysteresis evolves chronologically, including through long layovers; workers memory-map immutable results. Each frame uses one coherent scene instant, and the prepass includes its exact physical time. Lamp state and exposure never evolve in response to worker evaluation order. `prepass.json` records preparation metadata.

The content cache key includes normalized trip configuration, bundle records/hashes, Python source, fonts, runtime/tool environment, aircraft mode, quality profile and transport mode. Optional local GLB dimensions/orientation and lighting-profile hashes are part of the bundle identity. Cycles preparation additionally uses frame pose, Sun, Moon direction/incident RGB/diameter/fill mode, camera distance, displayed altitude and model detail. Validate cache shape and metadata before expensive work; matching filenames or airport sequences are insufficient. Aircraft lunar weather attenuation is prepared only for missing requested frames. Its frame-addressable lighting list uses null for unrequested entries; Cycles refuses to render an unprepared entry. Previews and cache resumes therefore avoid calculating unused film frames.

Each `preview` or `render` invocation holds an operating-system advisory lock for its cache before writing configuration, and through preparation, rendering and export. Another invocation targeting that same cache exits with a clear error; wait for the first run or choose another work directory. Different cache keys can run concurrently. The operating system releases ownership when the process exits; the persistent sibling `.lock` file does not indicate an active run and should not be deleted while a run is active.

Optional static GLB aircraft and dated local lighting profiles attach to the same verified bundle. GLB imports retain materials but discard authored cameras/lights and use the shared Cycles Sun/depth export. Local light profiles alter color and selected population/schedule properties within explicit geography and dates; they do not alter the chronological relay state. See [local inputs](local-assets.md). Bundle preparation is a single-writer operation that must finish before rendering.

## Quality and verification

`--quality preview|delivery|high` controls sampling budgets; the CLI default is `delivery`, including for the `preview` command. Profiles share clocks, geometry, seeds and source data.

| Budget | Preview | Delivery | High |
| --- | ---: | ---: | ---: |
| Terrain pixel scale / bisections | 3 / 12 | 1.5 / 14 | 1 / 17 |
| Terrain limb steps | 128 | 512 | 768 |
| Cloud pixel scale / substeps / solar steps | 6 / 1 / 4 | 3 / 2 / 8 | 2 / 3 / 12 |
| Atmosphere pixel scale / view steps / solar steps | 4 / 12 / 6 | 2 / 24 / 10 | 1.5 / 40 / 16 |
| Cycles samples | 12 | 32 | 64 |

View budgets are base counts. Shadow-crossing subdivisions add samples only where a ray intersects the terminator or penumbra.

`provenance.json` stores the selected profile, data identity and limitations. `performance.json` summarizes actual frame timings; it is not a prediction for another machine. Inspect matching timestamps before full encoding and decode the final output with `verify`.

Portable tests cover linear transport, exposure causality, normalized ray depth, cloud/atmosphere integration, analytic shadow crossings, lamp hysteresis, trajectories, local terrain and itinerary/calendar behavior. Rendered checks remain necessary for silhouettes, label layout, twilight continuity and apparent-size choices. The optional MLX atmospheric and cloud light-path kernels retain CPU references and are checked for numerical agreement, including poles, tangents, material-chart blends and call order. See [local acceleration](local-acceleration.md) for backend selection, cache identity and encoding. No hosted runtime is needed.

## Optional evidence and budgeting

`environmental_data.py` holds bounded dated global products. `environmentlighting.py` reconstructs additional aerosol extinction and blends dated snow/sea-ice reflectance. Products use weather UTC explicitly, including replay; a column AOD value does not supply a measured vertical profile, spectral exponent or scattering albedo. Clear-air secondary lookup tables remain unchanged. No consumer downloads data.

`calibration.py` validates attributed point survey controls and procedural material central values with declared evidence/uncertainty. The same feathered survey footprint is used by all terrain samplers and clearance. `render_budget.py` measures local stages and binds their reuse to source, machine and render settings, with explicit missing-cost and cache-progress reporting.

## Storytelling clock and preparation

`Trip.progress` is the single pacing boundary: classic smootherstep or the pure `pacing.py` highlights map. `Trip.presentation_time` inverts it for physical UTC media anchors. `Motion.attitude` estimates pose from physical seconds, independent of editorial duration. Frame contexts carry the same pose into Cycles; contact/depth are computed after orientation.

`media_moments.py` validates local events, resolves paths before snapshots, hashes input bytes and decoder versions for render identity, and decodes selected output ticks before frame workers start. Both preview/render and budget workers use that preparation. `media_overlay.py` only composites verified prepared images. Local media is never bundled into the portable skill.

## Reusable HDR scenes and accelerated preparation

`scene_cache.py` stores lossless linear composed scenes and aircraft coverage before `scene_overlays.py` applies exposure and graphics. Physical and final-frame identities are distinct; atomic frame writes and per-frame locks protect shared reuse. Cache hits skip Cycles preparation. `render_budget.py` distinguishes hit/miss timing populations and includes scene storage.

`metal_weather.py` prepares exact-time macro weather and wind backtraces, with CPU corrections at ill-conditioned boundaries. `cloudview.py` batches the complete layered cloud source over tiled GPU density/prefix weights; `cloud_occupancy.py` conservatively rejects proven empty weather cells. Optional `atmosphere_lookup.py` tables replace outward full-path clear-air quadrature only; dated aerosols and unsupported rays remain integrated. All selectors enter cache/provenance identity. See [bird’s-eye performance](birdseye-performance.md).

`volume_reconstruction.py` optionally reconstructs reduced cloud/air transport with normalized depth/opacity-aware spatial weights and continuous exact-pixel refinement. Fixed scouts inspect the gaps between coarse samples. The callback retains each medium's quadrature, geometry, dates and sources; full-resolution shell/opaque guides only control reconstruction. Aircraft cloud prefixes use full crop rays in adaptive/full modes. No frame history or time quantization is introduced. The `full` selector evaluates output pixel centres with the same integration budget, and explicit custom ray grids retain their caller-owned resolution. See [spatial reconstruction](volume-reconstruction.md) for costs and limits.

`metal_atmosphere.py` optionally fuses clear-air camera-segment integration and nested solar depth, retaining CPU float64 geometry, finite-disc visibility and dated Moon/aerosol preparation. Affected rays fall back to reference calculations at ambiguous density boundaries. `cloudlighting.sample_source_batched` combines the unchanged Sun, Moon, directional sky and city queries in bounded tiles, including shared zenith paths. Both remain opt-in for Metal with layered transport; effective selectors are recorded separately from requests. No prior-frame pixels or lighting history are reused.
