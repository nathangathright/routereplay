# Data bundles and time coverage

A trip chooses dates; a data bundle declares what those dates can support. Never silently substitute a model run from another date, clamp to the last weather frame, or describe a historical texture as live imagery.

## Static bundle

From a fresh install, with the rendering dependencies installed:

```sh
python3 scripts/data.py bootstrap --destination ./cache/november --month 11
python3 scripts/data.py verify ./cache/november
```

Bootstrap downloads five public source products, builds the land mask and resized night-light texture, and writes `bundle.json`. It requires internet access and Pillow; manifest inspection and integrity checks use Python's standard library. It does not fetch weather or aircraft renders. A NOAA server outage is an error, not permission to use invented terrain. Use the import path when verified files are already available:

```sh
python3 scripts/data.py import-bundle --source ./existing-assets \
  --destination ./cache/november --month 11 --with-weather
```

Import copies the selected renderer assets and optionally converted weather. It excludes booking records, original trip files, aircraft sprite caches, and personal paths. Bundle records contain relative paths, byte lengths, SHA256 hashes, source URLs, credits, and source-policy links. Hashes identify the downloaded bytes; they are not signatures from the provider. Keep the resulting manifest with exports to reproduce the exact source selection.

| Product | Source and processing | Meaning and reuse |
| --- | --- | --- |
| Seasonal surface | [NASA Blue Marble monthly base maps](https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-map/), 5400×2700 | Selected month of **2004**, representative seasonal appearance. Use the month of the trip's first local departure; cross-month trips currently retain that one map. Credit NASA Earth Observatory, Reto Stöckli and Robert Simmon. Follow [NASA media guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/), including third-party notices and no implied endorsement. |
| Elevation | [NOAA ETOPO 2022](https://www.ncei.noaa.gov/products/etopo-global-relief-model), sampled through [NOAA ERDDAP](https://coastwatch.pfeg.noaa.gov/erddap/griddap/ETOPO_2022_v1_15s.html) with a 20-cell stride | Real elevation sampled at 5 arc minutes; the renderer exaggerates relief. The NetCDF carries NOAA's reuse/warranty notice. The download is already classic NetCDF, so no terrain conversion tool is needed. |
| Night-light intensity | [NASA Black Marble 2016 map](https://science.nasa.gov/earth/earth-observatory/earth-at-night/maps/), grayscale resized to 8192×4096 | Historical annual display mosaic, not radiance or actual lamp spectra. City-color diversity and lighting activation are simulated. NASA media terms apply. |
| Land mask | [Natural Earth 1:50m land](https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_50m_land.geojson), rasterized to 8192×4096 | Natural Earth states its data is [public domain](https://www.naturalearthdata.com/about/terms-of-use/). Source retrieval hashes pin the locally obtained version. |
| Stars | [CDS V/50 Bright Star Catalogue](https://cdsarc.cds.unistra.fr/ftp/V/50/ReadMe), `catalog.gz` | Hoffleit and Warren (1991). Positions are propagated to the render date. Retain the catalogue citation and consult provider terms; do not assume all third-party catalogue data shares the code license. |

Astronomy uses the installed ERFA leap-second table with UT1 approximated by UTC and zero polar motion. Future dates can emit an ERFA “dubious year” warning because future leap seconds are unknown; this is an acknowledged approximation, not a weather-data fallback.

The Moon uses the renderer's ERFA ephemeris calculations; it does not need a downloaded file for a particular calendar year. No flight date is baked into these static assets. Surface textures and lights still represent their stated historical epochs.

## Optional local terrain

Attach an already prepared local DEM tile to a verified bundle:

```sh
python3 scripts/data.py attach-terrain ./cache/november local-dem.npz --source-json local-dem-source.json
python3 scripts/data.py verify ./cache/november
```

`local-dem-source.json` must be a JSON object containing exactly `url`, `credit`, `license_url` and `notes`, each a nonempty string. Other keys are rejected. Record the original product, resolution, vertical datum and conversion/resampling steps. Attaching a tile does not download data or grant redistribution rights. There is no automatic local DEM acquisition adapter.

The NPZ contains exactly these arrays, with no pickled objects:

| Array | Contract |
| --- | --- |
| `latitude` | One-dimensional increasing, uniformly spaced degrees in [−90, 90], at least four values |
| `longitude` | One-dimensional increasing, uniformly spaced degrees in [−180, 180], at least four values |
| `height_m` | Finite `latitude × longitude` heights in MSL metres, within [−12000, 10000]; no nodata holes |
| `altitude_reference` | Scalar string `MSL` |

Split tiles crossing the antimeridian into separate regular grids. Resolve nodata and vertical-datum differences before attaching; the importer does not infer them. Each tile may expand to at most 256 MiB; a bundle accepts at most 32 tiles totaling at most 512 MiB uncompressed. These limits count all NPZ archive members and are checked from archive metadata before any tile arrays are decompressed. Files are copied into content-addressed `terrain-tiles/` paths and added to the manifest with hashes and source records; reattaching identical bytes is idempotent. A failed manifest publication removes a newly added tile while preserving an identical asset that already existed.

The terrain sampler overlays local grids on the global prior, feathers two grid cells at tile edges and gives finer grids precedence in overlaps. Terrain intersection, lighting slopes and aircraft ground sampling use the same sampler. Sea-level clipping remains in effect for bathymetry. Local terrain changes elevation/detail, not the resolution or epoch of the surface-color imagery. Missing tiles leave the coarse global terrain in place; they do not create measured airport elevations.

## Weather choices

- `clear`: no cloud/weather dataset. Works on arbitrary dates supported by the astronomy implementation, and means deliberately clear conditions, not verified clear skies.
- `forecast`: the weather clock must lie inside the supplied forecast run's intersection of layer, wind, and pressure-profile coverage. An archived GFS forecast remains forecast model output, not a weather observation.
- `historical`: supplied historical-provider data with matching source metadata. The explicit local ERA5 pressure/single-level NetCDF adapter now produces this contract; see [dataset adapters](data-adapters.md). It does not automatically acquire authenticated CDS data. Simply passing `--source-mode historical` cannot relabel a forecast bundle.
- `illustrative_replay`: the trip explicitly maps its weather clock to another available date interval. Solar/lunar/star calculations still use the flight dates. Record the replay in the export provenance, so the result is not described as the trip's actual weather.

The legacy alias `itinerary_forecast` is accepted by bundle validation as `forecast`. Use the trip schema's documented spelling when authoring new trips.

Departure and arrival holds are part of required weather coverage. Validate `Trip.weather_time(0)` through the final frame's weather time before generating aircraft or film frames. Matching airport dates alone is insufficient.

## Preparing a GFS run

The included adapter takes an explicit run and interval. It downloads bounded records from the [NOAA GFS public archive](https://registry.opendata.aws/noaa-gfs-bdp-pds/), verifies each GRIB initialization, validity, grid, and instantaneous step, then prepares the renderer's cloud and wind arrays. Plan without network access:

```sh
python3 scripts/prepare_weather_bundle.py --bundle ./cache/november \
  --initialization 2026-10-17T18:00:00Z \
  --start 2026-10-17T23:00:00Z --end 2026-10-18T20:00:00Z --plan
```

Choose a run that is actually available and brackets the required weather clock; the example is a schema demonstration, not a recommendation to use that weather for another date. Remove `--plan` to fetch and attach the selected data. Conversion needs NumPy, ECMWF ecCodes, and its Python bindings. Runtime rendering does not need ecCodes. The CLI reports missing dependencies rather than installing them itself.

Two explicit providers are available:

| Provider | Grid and supported hours | Availability |
| --- | --- | --- |
| `nodd-0p25` (default) | 0.25°; hourly through +120, every 3 hours from +123 to +384 | NOAA Open Data Dissemination high-resolution storage, described by NCEI as a trailing 30-day window; exact objects are checked |
| `ncei-0p50` | 0.5°; every 3 hours through +192 | [NCEI long-term GFS forecast archive](https://www.ncei.noaa.gov/products/weather-climate-models/global-forecast); actual date/hour gaps remain possible |

For an archived run, inspect availability before downloading records:

```sh
python3 scripts/prepare_weather_bundle.py --bundle ./cache/october \
  --provider ncei-0p50 --initialization 2023-10-01T00:00:00Z \
  --start 2023-10-01T03:00:00Z --end 2023-10-01T06:00:00Z \
  --cache-directory ./cache/noaa --check-availability
```

This historical interval is a tested example, not an instruction to substitute weather for a different trip. Remove `--check-availability` to download, convert and attach it. An NCEI archive gap is an error; the tool never chooses another date or provider. Use weather mode `forecast` for this archived forecast model output. `historical` describes a separately converted historical-provider dataset, such as the local ERA5 adapter, with matching source metadata.

`--plan` is entirely offline. `--check-availability` checks the required inventories and reports missing fields or hours without downloading GRIB payloads. `--download-only` caches the exact records without changing the render bundle. Add `--offline` to a check or conversion to prohibit network requests and require a complete verified cache. `--max-download-mib` bounds total network bytes, including inventories; its default is 512 MiB. Explicit `--cache-directory` lets multiple trips reuse NOAA records. Acquisition-only modes do not require a prepared static bundle; conversion validates its destination first.

The request cache records URLs, byte ranges, retrieval times, lengths and SHA256 hashes. Each cached payload is verified before use. Downloads require HTTPS on the chosen NOAA origin, honor exact byte ranges, and publish only completed records. Hashes establish local byte identity, not independent provider signatures. Work directories are keyed by provider and initialization. The render bundle contains converted arrays and source metadata; the raw cache stays separate and can be moved alongside it for offline rebuilding.

Pre-v0.3 converted weather bundles still render as before. Old loose raw GRIB downloads are not automatically imported into the new request cache; a new preparation needs one acquisition to populate it. Keep the existing converted bundle to avoid re-downloading just to render.

NCEI coverage is bilinearly reconstructed from its native 0.5° grid into the renderer's 0.25° coverage interface, with periodic longitude and exact pole endpoints. Winds and profiles remain at native 0.5°. This does not create finer observed detail. Three-hourly archive states are animated with the existing interpolation and wind reconstruction. A typical day uses hundreds of records and substantial disk, memory and bandwidth; inspect the plan and byte estimate first.

Cloud coverage, pressure-level condensate, temperature, height, and winds are model data. Particle radii, pressure-to-height reconstruction, sub-grid texture, cinematic opacity, and interpolated movement are visualization assumptions. The renderer advects seeded Earth-coordinate density detail with the model winds and queries the same extinction field for camera rays, solar rays and aircraft obscuration. Procedural material charts renew every two hours with at most four hours of history, anchored to the bundle's verified `valid_start`; they never query earlier uncovered winds. Coverage carving can reduce reconstructed optical mass; [cloud morphology](cloud-morphology.md) describes the modeled shape and lifetime. Animation between source timestamps remains reconstructed weather, not per-frame observations.

## Provider contract

`bundle.json` schema version 1 contains `surface_month`, five named `assets` records (`land_mask`, `terrain`, `surface`, `nightlights`, `stars`), optional `weather`, an optional `terrain_tiles` list of local DEM file records, optional `lighting_profile`, optional `aircraft_models` keyed by supported aircraft type, optional `calibration`, and optional `environment` mapping `aerosol` and/or `surface_conditions` to dated content-addressed products. See [local inputs](local-assets.md), [calibration](calibration.md) and [dataset adapters](data-adapters.md) for their schemas. Each file record has `path`, `bytes`, `sha256`, and `source` (`url`, `credit`, `license_url`, `notes`). Paths must remain inside the bundle, including after resolving symlinks.

Weather is represented by:

```text
weather/cloud-layers.npz
  coverage: (T, 3, 721, 1440), fractional low/middle/high cover
  timestamps: T float64 UTC Unix seconds
weather/cloud-winds.npz
  u, v: (T, 3, 361, 720), m/s
  representative_heights_m: (3,), currently 1500/5500/10500
  timestamps: T float64 UTC Unix seconds
weather/cloud-profile-fHHH.npz
  extinction, coverage, ice_fraction, tau_above: (17, 361, 720)
  column_tau, column_height: (3, 361, 720)
  altitudes_m: (17,), 0 to 16000 in 1000 m steps
  timestamp: scalar float64 UTC Unix seconds
weather/cloud-layers-source.json
  model, initialization, forecast_hours, source_mode (default forecast)
weather/cloud-profile-source.json
  model, initialization, wind_forecast_hours, profile_forecast_hours,
  source_mode (default forecast)
```

Coverage is north-to-south 90° to −90°, longitudes 0° through 359.75°. Winds/profiles use the same extent at 0.5°. A provider changing coordinates, units, vertical planes, or array layout needs a conversion adapter, not merely new filenames. Preserve original provider URLs and conversion assumptions in the source JSON. For a custom or non-default provider, include a `provider` object with `url`, `credit`, `license_url`, and `notes` in `cloud-layers-source.json`; those values are carried into the manifest instead of assuming the default NOAA AWS origin. Explicit provider metadata takes precedence even when the model remains NOAA GFS.

`weather/runtime.json` is generated from these files, with `initialization`, the three hour lists, `source_mode`, and `valid_start`/`valid_end`. Runtime and bundle metadata must agree with actual NPZ timestamps. `read_bundle(path, verify_hashes=True)` checks paths, hashes, shapes, and timestamps. `validate_bundle(path, weather_mode, start_dt, end_dt, month)` additionally rejects a mismatched seasonal month, missing weather, source-mode mismatch, and uncovered times. Workers can skip repeated hashing only after the controlling process validates the bundle.

For the next realism improvements, keep provider-specific conversions here and keep artistic controls in render presets. Add measured radiance, aerosol fields, better cloud microphysics, and additional terrain providers as independently versioned products with explicit units, spatial grids, valid intervals, provenance, and hashes. This lets the renderer evolve without hiding data substitutions inside shader or camera code.
