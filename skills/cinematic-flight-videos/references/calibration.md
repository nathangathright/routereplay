# Local calibration

Attach a local JSON profile with `python3 scripts/data.py attach-calibration BUNDLE PROFILE.json`. The command validates and copies the profile, records its hash and source, and includes it in render cache identity. Prepared rendering remains offline.

A schema-1 profile has exactly `schema_version`, `title`, `source`, `surveys` and `materials`. `source` is an object containing nonempty `url`, `credit`, `license_url` and `notes`. Profiles are limited to 256 KiB, 32 survey controls and the supported aircraft types. At least one survey or material override is required.

## Terrain controls

Each `surveys` entry contains:

| Field | Meaning |
| --- | --- |
| `id`, optional `code` | Unique control ID and optional airport code. |
| `lat`, `lon` | Degrees, latitude −90…90 and longitude −180…180. |
| `radius_m` | Modeled influence footprint, 25…5000 m. |
| `elevation_m` | Central elevation, 0…9000 m. Negative elevations are rejected because the current scene's solid-Earth and surface brackets use sea level. |
| `datum` | `MSL`, `EGM96` or `EGM2008`. The label records the supplied datum; no datum transformation is performed. Reconcile inputs before import. Ellipsoidal heights are rejected. |
| `basis` | `measured` or `modeled`. |
| `source`, `notes` | Attribution and what the control actually establishes. |
| `observed_at`, `uncertainty_m` | Required for measured controls: offset-bearing ISO timestamp and finite absolute uncertainty in metres. Optional for modeled controls. |

The inner half of the declared radius is flattened to the central elevation. A smooth cubic feather returns to the underlying DEM at the outer radius. Those surfaces are modeled interpolation from the control: they do not assert a surveyed runway polygon, runway slope or obstacle clearance. Overlapping footprints are rejected; reduce the radii or supply one explicitly reconciled control.

The same terrain sampler drives globe intersections, surface normals, landing altitude and aircraft clearance. Global terrain and local DEM tiles are evaluated first, then survey controls. Dates and uncertainty remain evidence metadata: they do not add noise or automatically expire an elevation. Reusing a profile on a later trip does not assert that the site was reverified.

## Procedural aircraft materials

`materials` maps `generic`, `a321neo`, `777-200er`, `787-9` or `757-300` to named slot objects. Supported slots are `paint`, `wing`, `metal`, `glass`, `dark` and `panel`. An aircraft type uses only its own entry; `generic` is not a wildcard.

Each slot requires `linear_rgb` (three values in 0…1), `roughness` and `metallic` (0…1), `basis`, `source` and `notes`. Measured slots also require `observed_at` and `uncertainty`. That uncertainty object contains absolute bounds for `linear_rgb`, `roughness` and `metallic`, plus `notes` describing how those bounds were obtained. Modeled slots may omit dates and uncertainty. Uncertainty is retained without stochastic shading.

Overrides reach the actual Cycles Principled shader after cinematic defaults. Other shader settings, such as clearcoat, remain modeled. Supplied GLB materials are retained; this profile does not select or rewrite imported materials. The aircraft source record includes applied slots and their evidence.

A minimal synthetic material profile:

```json
{
  "schema_version": 1,
  "title": "Illustrative paint override",
  "source": {"url":"https://example.org/profile","credit":"Local author","license_url":"https://example.org/license","notes":"Synthetic example, not measured."},
  "surveys": [],
  "materials": {
    "a321neo": {
      "paint": {
        "linear_rgb": [0.65, 0.68, 0.72],
        "roughness": 0.3,
        "metallic": 0.02,
        "basis": "modeled",
        "source": {"url":"https://example.org/profile","credit":"Local author","license_url":"https://example.org/license","notes":"Illustrative values."},
        "notes": "A visual choice; no specific aircraft finish is claimed."
      }
    }
  }
}
```

## Regional lighting evidence

Existing lighting-profile schema versions 1 and 2 accept optional `observed_at` and `uncertainty` on each region. Uncertainty requires descriptive `notes` and may include absolute `xy` coordinate bounds, a `population_fraction` bound in 0…1 and `schedule_hours` in 0…24. These fields do not change the rendered central values or the region's explicit `valid_from`/`valid_until` interval. Older measured profiles without uncertainty remain readable; missing uncertainty is not inferred.

The renderer still uses scene-relative RGB, modeled lamp populations and simplified procedural materials. Attaching evidence narrows those assumptions only where the profile supplies usable coverage; it does not calibrate the entire scene's photometry.
