# Local aircraft and lighting inputs

These adapters copy user-supplied files into an ordinary data bundle. They need no account, service, database or runtime network access. Prepare the bundle before rendering; do not modify it while workers are using it. Replacement attachments leave old content-addressed files on disk for reproducibility; only the manifest's selected files are rendered. Remove unreferenced assets only after checking that no other saved manifest needs them.

## Static GLB aircraft

A local GLB can replace the illustration for `a321neo`, `777-200er`, `787-9` or `757-300`:

```sh
python3 scripts/data.py attach-aircraft data/october a321neo aircraft.glb --metadata-json aircraft.json
python3 scripts/data.py verify data/october
python3 scripts/flight_video.py preview trip.json --assets data/october --workdir renders
```

The metadata is a JSON object:

```json
{
  "length_m": 44.51,
  "wingspan_m": 35.8,
  "nose_axis": "+X",
  "up_axis": "+Z",
  "source": {
    "url": "https://example.org/your-model",
    "credit": "Your model author",
    "license_url": "https://example.org/your-model-license",
    "notes": "State the source, dimensions, material assumptions and any edits."
  }
}
```

Replace the placeholder source with the actual asset's attribution and license. Axes refer to the original glTF coordinates, before Blender's coordinate conversion. Each axis must be one of `+X`, `-X`, `+Y`, `-Y`, `+Z`, `-Z`, with perpendicular nose/up directions. Dimensions must be positive and at most 500 metres. The measured mesh span/length ratio must agree with the declared ratio within 5%.

Use a static, self-contained GLB 2 file of at most 128 MiB, with its buffers and PNG/JPEG textures embedded. External files, skins, animations and morph targets are unsupported. The validator bounds geometry and image resources and rejects unsupported required extensions; export a plain static GLB when validation fails. There is no automatic model download or license discovery.

The renderer removes authored lights and cameras, retains mesh materials, aligns the model to heading, and centers its envelope. It scales the mesh uniformly to the same cinematic display length as the procedural aircraft. Declared physical length feeds the shared depth conversion. Cycles supplies the dated Sun, shadows and linear radiance/depth passes; imported geometry does not receive the procedural wing-flex animation. A successful import is not proof of CAD accuracy or calibrated paint/material response. Inspect silhouettes, axis orientation and reflections before a full render. Each Blender batch has 300 seconds of startup allowance plus 120 seconds per frame. For complex assets or slower machines, increase `--blender-frame-timeout` (seconds per frame, at most 86400). A timeout stops that batch and points to its diagnostics; valid completed frames remain resumable.

## Dated regional lighting profiles

Start from `examples/sample-lighting-profile.json` for a synthetic common-color profile, or `examples/city-lighting-chicago-auckland.json` for a dated, explicitly modeled outdoor-light example. Neither example is enabled automatically. Attach your edited profile:

```sh
python3 scripts/data.py attach-lighting data/october lighting-profile.json
python3 scripts/data.py verify data/october
```

A profile requires `schema_version: 1` or `2`, a `title`, a `source` with exactly `url`, `credit`, `license_url`, `notes`, and 1–64 `regions`. The file is limited to 256 KiB; validation uses only the Python standard library. Each region has:

| Field | Meaning |
| --- | --- |
| `id` | Unique nonempty identifier |
| `lat`, `lon`, `radius_km` | Geographic center in degrees and radius from 1 to 2000 km |
| `valid_from`, `valid_until` | Offset-bearing timestamps, with an exclusive end |
| `basis` | `measured` or `modeled`, describing the supplied values; this declaration is not independently verified |
| `xy` | Two CIE chromaticity coordinates, both positive with x + y ≤ 1; required in version 1 |
| `notes` | Measurement method, scope, assumptions or modeling explanation |
| `shares` (optional) | Outdoor, building, sign and persistent emission fractions, summing to one |
| `building_curfew`, `sign_curfew` (optional) | Local mean solar hours from 12 to 36; 25 means 01:00 the following morning |
| `population_mixtures` (version 2) | Lamp contributions for one or more of `outdoor`, `building`, `sign`, `persistent` |
| `district_variation` (version 2, optional) | Geographic mixture perturbation from 0 to 0.5, default 0.20; permitted only with `population_mixtures` |
| `source` (version 2, optional) | Region attribution with the same four fields as the top-level source |

Version 2 requires exactly one of `xy` and `population_mixtures` in each region. Common `xy` applies to all four populations and preserves version 1 behavior. A mixture can target just one population:

```json
"population_mixtures": {
  "outdoor": {"sodium": 0.10, "led_2700": 0.15, "led_3000": 0.75}
}
```

Each population object maps lamp IDs to finite nonnegative weights summing to one. Allowed IDs are `sodium`, `led_2700`, `led_3000`, `led_4000`, `led_5000`, and `metal_halide`. These are nominal reference-spectrum families, not exact Kelvin targets or measured local fixtures; see [lamp spectra and licensing](lamp-spectra.md). Weights describe relative photopic luminous contributions, not fixture counts. Colors mix in linear RGB at unit luminance, preserving the light budget. Omitted populations retain their existing colors. Population `shares` and schedules also remain unchanged unless supplied separately.

District variation uses one stable 18 km spherical noise field per covered region. A signed field tilts the six lamp weights toward warmer or cooler families using fixed coefficients. Each weight's multiplier stays within `[1-d, 1+d]` before the mixture is normalized again. Zero contributions stay zero. `district_variation: 0` disables this modeled variation; a single-lamp mixture remains that lamp exactly. The field depends on geography and region ID, not time, frame, camera, texture brightness or weather. It does not identify actual districts, roads or fixture locations.

Only supply populations or schedules when supported. Streetlight evidence does not establish building/sign colors, population shares or switching times. Explain unsupported choices in the region notes with `basis: "modeled"`; a publisher's fixture percentage is not automatically a luminous fraction.

Profiles apply by physical UTC, independently of replayed weather. Coverage is full inside 80% of the radius, then smoothly feathers to zero. Overlaps use spatially weighted values, independently for each supplied population/color/schedule property, accumulated in sorted region-ID order. A building-only region does not dilute an overlapping outdoor override. Regions outside their dates or geography leave default priors unchanged. Undated diagnostic calls also retain the defaults.

CIE xy is converted through unit-luminance XYZ to linear sRGB using the [W3C CSS Color 4 conversion equations](https://www.w3.org/TR/css-color-4/#color-conversion-code). Negative out-of-gamut channels are clipped and luminance renormalized. This adds attributed chromaticity variety, not spectral rendering or absolute radiance calibration. Profiles do not relocate lights, alter the historical texture, or replace the causal photocell state. Curfews use mean solar time rather than civil time-zone boundaries.

The Chicago/Auckland example is bounded to October–November 2026. Chicago's [2017 streetlight announcement](https://chicagoinfrastructure.org/press/2017/04/) specifies LEDs at 3000 K or below. [Auckland Transport](https://at.govt.nz/about-us/sustainability) reports 99% LED conversion by mid-2025 and describes 4000 K streetlights. The example carries those directions into the trip period as a model; it is neither a measured 2026 inventory nor a forecast for later trips. Its luminous weights, district variation and 20/15 km city-centered circles are illustrative. ORD and AKL are outside those circles. Buildings, signs, persistent sources and schedules retain defaults.

## Reproducibility

Both attachment commands stage and validate the copied bytes before publishing the manifest. Files get content-addressed paths and source/hash records; dimensions and orientation also affect the render cache identity. Moving the entire bundle preserves its identity. Failed publication preserves the existing manifest and removes only newly published assets. Render provenance includes the selected records and their limits.
