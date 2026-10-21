# Local dataset adapters

Use `scripts/data_adapters.py` to acquire a bounded NOAA surface interval or convert files you already have. The resulting products attach to the same portable asset bundle used by rendering. No backend, credential store or online rendering service is involved. Acquisition, conversion and rendering are separate operations; a completed bundle can render offline.

| Input | Implemented path | Renderer effect |
| --- | --- | --- |
| GFS snow depth, sea ice and land mask | Explicit NOAA run and interval; bounded HTTP Range acquisition with verified local cache | Dated snow/ice albedo and reduced open-water reflection |
| Aerosol optical depth at 550 nm | Local global CF-NetCDF import | Additional aerosol extinction on camera, Sun and Moon paths; modeled aerosol scattering |
| ERA5 cloud, condensate and wind fields | Local pressure-level plus single-level NetCDF import | Existing animated cloud/wind/profile interface, identified as reanalysis |
| Higher-resolution elevation | Local north-up WGS84/EGM2008 GeoTIFF import | Existing terrain tile overlay, intersections and slopes |

These paths validate file structure, units, coordinates, dates and attribution declarations. They do not independently authenticate a provider, verify a user's license rights or establish scientific calibration of the rendered image. Record the original dataset and any preprocessing in the source notes.

## Dependencies and provenance

All adapters need NumPy. Classic NetCDF uses SciPy; NetCDF4/HDF5 files additionally need the optional `netCDF4` Python package. The TIFF adapter uses Pillow. NOAA GRIB decoding needs ECMWF ecCodes and its Python bindings. Missing packages produce an error; the CLI does not install dependencies, log into a provider or accept terms.

Local imports require `--source-json` containing exactly these four nonempty strings:

```json
{
  "url": "https://provider.example/dataset",
  "credit": "Dataset producer, product and version",
  "license_url": "https://provider.example/license",
  "notes": "Acquisition date, original resolution and sampling interval, preprocessing, and any relevant license or attribution requirements."
}
```

Replace these placeholders with the actual provider and license. URLs must use HTTPS without embedded credentials. Source files are identified by basename, byte count and SHA256; personal absolute paths are not stored in the product. Hashes establish byte identity, not an independent provider signature. Code licensing does not replace dataset licensing.

Add `--bundle ./cache/trip` to an import/acquisition command to validate the destination before doing work and attach the converted product. The attachment copies validated bytes into content-addressed bundle paths, adds provenance and changes the render fingerprint. Without `--bundle`, conversion only writes its requested output. Keep raw acquisition caches outside distributable skills and exported code repositories.

## NOAA snow and sea ice

Inspect the selected run without network access:

```sh
python3 scripts/data_adapters.py gfs-surface \
  --provider ncei-0p50 --initialization 2023-10-01T00:00:00Z \
  --start 2023-10-01T03:00:00Z --end 2023-10-01T06:00:00Z --plan
```

The dates above are a tested archive example, not weather for another trip. Acquire that exact interval:

```sh
python3 scripts/data_adapters.py gfs-surface \
  --provider ncei-0p50 --initialization 2023-10-01T00:00:00Z \
  --start 2023-10-01T03:00:00Z --end 2023-10-01T06:00:00Z \
  --output ./cache/surface-20231001.npz --cache-directory ./cache/noaa \
  --max-download-mib 8 --max-cache-mib 16 --bundle ./cache/trip
```

Repeat with `--offline` to require the verified cache and prohibit network requests. Missing cached objects, unavailable dates, unrecognized grids and wrong decoded variables stop the import. No nearby date, run or alternate provider is substituted. HTTPS redirects remain on the chosen NOAA origin. The existing downloader verifies response byte ranges, size limits, GRIB framing and cached hashes.

The providers are `ncei-0p50` for the [NCEI 0.5° archive](https://www.ncei.noaa.gov/products/weather-climate-models/global-forecast), or `nodd-0p25` for the recent NOAA high-resolution window. Their supported time schedules match the [GFS cloud adapter](data-sources.md#preparing-a-gfs-run). Archived GFS is **forecast model output**, not observation or reanalysis. Availability is checked against exact objects during acquisition.

Each state requires `LAND`, `SNOD` and `ICEC`. The [official parameter inventory](https://www.nco.ncep.noaa.gov/pmb/products/gfs/gfs.t00z.pgrb2.0p50.f003.shtml) identifies snow depth in metres and ice concentration as a fraction. The adapter verifies decoded parameter numbers, units, initialization, validity, instantaneous step, grid endpoints and scanning direction. Missing snow values over sea or missing ice values over land become zero only after checking the same-time `LAND` mask. Missing values within the applicable domain remain errors.

The output uses `snow_fraction = min(SNOD / 0.1 m, 1)`. This is an explicit **modeled visual cover fraction**, not measured snow coverage. `--full-snow-depth-m` changes that assumption within 0.01–1 m. Ice concentration remains the provider fraction. Both outputs retain the native global grid. Temporal and spatial interpolation reconstruct intermediate states; they are not new measurements. NOAA attribution and modification notes are retained under the [NWS reuse policy](https://www.weather.gov/disclaimer).

The default run-wide download limit is 32 MiB; the cache limit is 256 MiB. Bounds include inventories and payloads, and reserve room for request metadata before fetching payloads. At most 80 time states are acquired per invocation. No cache eviction happens automatically. A cache that exceeds the configured budget causes an error; choose another cache or explicitly raise the bound. The plan reports array bytes plus a conservative metadata reserve and rejects intervals that exceed the decoded-output limit before creating a cache or making network requests. Split those intervals first.

## Aerosol optical depth

A NASA MERRA-2 aerosol product is a practical source for historical column AOD. The [M2T1NXAER collection](https://access.earthdata.nasa.gov/collections/C1276812830-GES_DISC) contains hourly **time-averaged** diagnostics. Obtain the files through the provider using your own account if required, follow its [citation guidance](https://gmao.gsfc.nasa.gov/gmao-products/merra-2/citing-merra-2-data_merra-2/) and [data-use policy](https://www.earthdata.nasa.gov/engage/open-data-services-software/data-use-policy), then import a prepared interval:

```sh
python3 scripts/data_adapters.py import-aerosol aerosol.nc \
  --variable TOTEXTTAU --source-kind reanalysis \
  --source-json aerosol-source.json --output ./cache/aerosol.npz \
  --bundle ./cache/trip
```

`TOTEXTTAU` is total extinction optical depth at 550 nm in NASA's [GEOS file specification](https://gmao.gsfc.nasa.gov/media/publications/zbly36ziNFDQeVqPhUoFbmYmvh/GEOS_5_FP_File_Specification_ON4v2_0_fqkxorzhgte_FgpliLt.pdf). The importer also accepts `aod550` and `od550aer`, but those generic names require an explicit `wavelength_nm=550` variable attribute. Values must have units `1` or `dimensionless`, be finite and lie in [0, 20]. Set `--source-kind` to the actual product: `forecast`, `reanalysis`, `observation` or `modeled`.

The file needs `time` or `valid_time`, `latitude` or `lat`, and `longitude` or `lon`. Coordinate aliases must be unambiguous. It must contain a complete regular global grid with both poles and a longitude-zero sample; latitude direction and longitude convention are reordered explicitly. Time must use CF seconds/minutes/hours/days since an epoch, with a standard/Gregorian calendar. Offsetless CF reference dates are UTC. Extra experiment/member dimensions, missing values, partial geographic coverage and duplicate longitude endpoints are rejected. Merge or select the intended states outside the importer, recording that work in provenance.

Time values remain the interpolation knots. For a time-averaged source, those are the provider's sample centers, not instantaneous measurements. Column AOD does not provide aerosol height, spectrum, phase function or single-scatter albedo. The renderer supplies explicit modeled assumptions for those quantities and adds this aerosol population above its existing clear-air baseline. This is a visibly data-driven haze layer, not full chemistry or radiative-transfer calibration.

## ERA5 reanalysis

Acquire [ERA5 pressure-level](https://cds.climate.copernicus.eu/datasets/reanalysis-era5-pressure-levels?tab=overview) and [single-level](https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels?tab=documentation) NetCDF for the same global UTC interval. Provider accounts, request limits and license acceptance remain with the user. This skill imports existing files; it does not submit CDS jobs or accept terms. Follow the current license and required attribution linked by the dataset rather than assuming all products have the same terms.

Request these pressure-level variables and levels:

| Variables | Required units |
| --- | --- |
| `z` geopotential | m²/s² |
| `t` temperature | K |
| `cc` cloud fraction | 1 |
| `clwc`, `ciwc` cloud liquid/ice water mixing ratio | kg/kg |
| `u`, `v` wind components | m/s |

Required levels are 1000, 925, 850, 700, 500, 350, 250 and 150 hPa. Additional levels may be present but do not increase the reconstructed detail. The single-level file needs `lcc`, `mcc`, `hcc` as fractional cover. The [ERA5 documentation](https://confluence.ecmwf.int/pages/viewpage.action?pageId=181128119) describes these provider variables. Global coordinate checks match the aerosol importer. Both files must have identical timestamps: 2–25 states on exact UTC hours, no more than three hours apart. Each input is limited to 2 GiB, and each requested variable slice to 256 MiB decoded. Select a single experiment/member before import; a mixed `expver` dimension is rejected rather than silently choosing ERA5 or ERA5T.

```sh
python3 scripts/data_adapters.py import-era5 \
  --pressure era5-pressure.nc --single-level era5-single.nc \
  --source-json era5-source.json --destination ./cache/era5-weather \
  --bundle ./cache/trip
```

Use trip weather mode `historical` for matching ERA5 dates. The destination stores the existing cloud-layer, wind and pressure-profile contract with `model: "ECMWF ERA5"`, `source_mode: "historical"` and `data_kind: "reanalysis"`. Its `initialization` is the first timestamp used as an internal temporal origin; it is **not a forecast initialization**. Original input identities and conversion assumptions remain in both source metadata files.

The adapter converts geopotential to geopotential height using 9.80665 m/s² and then to geometric height. It models condensate extinction using 10 µm liquid and 30 µm ice effective radii, reconstructs profiles on 17 altitude planes from 0–16 km, and assigns 850/500/250 hPa winds to representative heights of 1500/5500/10500 m. Coverage becomes the renderer's 0.25° grid; profiles and winds use 0.5°. Bilinear regridding adds no observed resolution. Endpoint fades, condensate optics and sub-grid cloud morphology remain visualization assumptions.

A completed destination caches the conversion by original hashes, source metadata and converter identity. Repeating the command uses the verified output without network requests. Changed input, provenance, code or generated bytes cause an error instead of silently replacing the product; select a fresh destination. Retain raw inputs if an offline rebuild is required.

## Higher-resolution terrain

[Copernicus DEM GLO-30/GLO-90](https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM) provides a practical GeoTIFF source. It is a **digital surface model**, so vegetation and structures can affect heights; do not present it as surveyed bare-earth airport terrain. Obtain the chosen tile or crop through the provider and record its resolution, version and required credit under the [product license](https://dataspace.copernicus.eu/sites/default/files/media/files/2025-06/copernicus_contributing_mission_data_access_v2_cop_dem_licenses.pdf). No automatic Copernicus login, license acceptance or download is performed.

```sh
python3 scripts/data_adapters.py import-dem terrain.tif \
  --vertical-datum EGM2008 --source-json terrain-source.json \
  --output ./cache/terrain-tile.npz --bundle ./cache/trip
```

Accepted TIFFs have one image/band, at least four pixels on each side, at most 16 million pixels, and a file size no larger than 256 MiB. The horizontal CRS must be north-up geographic WGS84 EPSG:4326 in degrees. Heights must be explicitly declared **EGM2008 orthometric metres**; contradictory vertical CRS or unit tags are rejected. `RasterPixelIsArea` uses pixel centers; `RasterPixelIsPoint` keeps sample positions. The adapter preserves that distinction.

There is no silent reprojection, geoid conversion, nodata filling or unit inference. Convert ellipsoidal, NAVD88 or other height references externally and document the transform before import. Nodata, nonfinite heights, rotated/projected grids and antimeridian-crossing tiles fail. Crop or split them outside the importer, retaining source provenance.

The resulting [terrain tile contract](data-sources.md#optional-local-terrain) uses the existing renderer MSL convention, retaining EGM2008 in the attached source notes. It overlays the global prior, feathers edges and changes the shared terrain geometry/slopes; it does not improve surface-color texture resolution. For a separate attachment step, add `--source-output terrain-derived-source.json`, then use that derived attribution with `data.py attach-terrain`.

## Dated product contract

Aerosol and surface products are NPZ files containing `latitude`, `longitude`, `timestamps`, scalar JSON `metadata` and their fields. Fields are float32 with shape `time × latitude × longitude`. Global latitude runs 90° to −90° including both poles; periodic longitude starts at 0° and omits 360°. `aod550`, `snow_fraction` and `sea_ice_fraction` have dimensionless units. The schema requires source kind, source/license/credit/notes, original file identities and explicit conversion assumptions.

Limits are 128 MiB compressed, 256 MiB decoded, at most 721 × 1440 spatial samples, and 2–240 timestamps between 1900 and 2200 with no gap over 24 hours. Fractions must be within [0, 1]. Source and output metadata are checked before attachment. The bundle stores optional `environment.aerosol` and `environment.surface_conditions` file records, each with relative path, hash and provenance.

Both products use the **weather UTC clock**, including departure/arrival holds. Their supplied interval must cover the entire required clock. An explicit `illustrative_replay` trip maps them to the same alternate date interval as clouds; this remapping is recorded in provenance. Solar/lunar/stellar positions and dated city-light profiles continue to use physical UTC. Rendering never clamps an environment sample to its last state or silently shifts its date. An absent optional product retains the documented baseline model; an attached but invalid/uncovered product fails validation.

```sh
python3 scripts/data_adapters.py inspect ./cache/aerosol.npz
python3 scripts/data.py attach-environment ./cache/trip ./cache/aerosol.npz
python3 scripts/data.py verify ./cache/trip
python3 scripts/flight_video.py plan trip.json
```

Python consumers use `environment_metadata(path)` or `validate_environment_coverage(path, start_dt, end_dt)` for declared UTC bounds and `[T,H,W]` shape. `sample_environment(path, lon_radians, lat_radians, when)` returns the supplied fields at broadcast-shaped coordinates, with periodic bilinear spatial and linear temporal interpolation. Out-of-range times and invalid coordinates raise errors.
