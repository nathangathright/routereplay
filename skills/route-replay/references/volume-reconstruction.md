# Spatial volume reconstruction

`--volume-reconstruction reference|adaptive|full` selects the spatial sampling of
layered cloud and atmospheric transport. The default is `reference`. It works
with CPU and optional Metal integration; the selected view/source backends and
quality profile still determine each ray's quadrature. Joint transport retains
its existing path, with the requested and effective reconstruction choices
recorded separately.

```sh
python3 scripts/flight_video.py preview trip.json --assets data/prepared \
  --workdir renders --quality delivery --transport layered \
  --volume-reconstruction adaptive --frames 0,90,180
```

Use `full` on matched frames to evaluate spatial reconstruction. Keep the
quality, backend, geometry, physical and weather timestamps, source snapshot and
lighting options identical. These options also apply to `render` and `budget`;
the effective selector participates in cache identity.

| Mode | Camera-ray sampling |
| --- | --- |
| `reference` | Existing quality-dependent coarse grid and bilinear enlargement of radiance/transmittance. |
| `adaptive` | Coarse grid, fixed scouts between its centres, normalized depth/opacity-aware reconstruction, and additional exact output-pixel rays where local variation requires them. |
| `full` | Every output pixel centre, with the same per-ray integration budgets as the selected quality profile. |

`full` is a spatial diagnostic reference. It does not increase view or solar
quadrature, integrate a pixel footprint, or remove the existing cloud/air
lighting approximations. It is not physical ground truth.

## Reconstruction and boundaries

The shared helper reconstructs scene-linear, nonnegative HDR radiance and scalar
or RGB transmission. Radiance has no display-range clamp. Spatial weights are
nonnegative and normalized; transmission stays within zero and one. Composition
continues to use additive radiance plus transmitted background, before the
existing exposure and tone mapper.

Coarse samples retain the exact finite-camera positions of the reference grid,
including odd canvas sizes and crops. Opaque depth is supplied at output
resolution, with zero and infinity both meaning no opaque hit. Incompatible
depths reduce interpolation weights, and strong geometry mismatches require
exact output rays. The cloud and air wrappers also compute full-resolution
integration-support masks, preserving identity transport outside the volume or
where an opaque endpoint precedes the volume entry. Guide images control
reconstruction; the integration callback still clips every sampled ray using
its actual geometry and depth. Fractional coarse rays use their own analytic
ground and shell intersections, rather than borrowing the classification of a
neighboring output pixel.

Local radiance, transmission and cloud-distance variation determine continuous
refinement weights. The cloud distance is a mean scattering distance weighted
by accumulated opacity; its influence tends to zero as cloud opacity vanishes.
Fixed scouts midway between coarse samples compare actual transport with the
coarse reconstruction. Scouts can expose narrow structure missed by the coarse
centres, but a finite grid cannot guarantee detection of every thin cloud.

The thresholds use fixed scene-linear ranges, independent of display exposure.
Extremely faint radiance-only variation can therefore remain reconstructed even
when exposure makes it visible. Transmission and geometry still guide refinement.
This keeps cached physical scenes independent of exposure edits; compare night
frames with `full` under the intended exposure. Depth rejection is deliberately
conservative and can also add rays along smooth but steep depth gradients.

Refinement uses a smooth activation function. An additional output-pixel ray
starts with zero contribution and gains weight continuously, reaching the exact
ray value in difficult regions. There is no global sample ranking, temporal
history, stochastic jitter, weather-time quantization or prior-frame reuse.
Physical and weather clocks continue to advance at their original exact times.
Only the current frame's fields and deterministic camera positions determine
its result.

Generated aircraft foreground cloud rays use the full 224×224 crop in both
`adaptive` and `full`; the atmosphere foreground already requests full crop
sampling. Existing nearest-valid aircraft-depth extension through transparent
pixels remains in place. Custom `camera_rays` arguments retain their supplied
grid and longstanding integration/resizing contract, since the caller owns
those rays and their resolution.

## Work and validation

The helper bounds integration requests to batches of at most 4,096 rays. It
retains current-frame output arrays and reduced-grid data, without an expanding
frame cache. Sparse regions can avoid many output-pixel integrations, but the
adaptive budget is deliberately not a hard ray-count cap: its worst case is the
coarse grid plus scouts plus the full output grid. It can cost more than `full`.
The generated aircraft foreground remains a full crop in either new mode.

At `high` quality, the 1080×1920 atmosphere starts with about 1.84 million
coarse/scout rays—89% of the full output grid—before refinement. Clouds start
at about 50%. Benchmark `full` first when choosing a high-quality configuration;
adaptive work can approach or exceed it. These are ray counts, not measured
render times, and delivery-quality timings do not predict the high profile.

Compare matched reference, adaptive and full frames around cloud silhouettes,
thin cloud layers, terrain and aircraft edges, the atmospheric limb, dusk and
night. Inspect motion at neighboring presentation times and shuffled frame
order as well as still-image error. Analytic tests cover exact sample positions,
HDR/identity transport, depth boundaries, scout discovery, continuous activation
and deterministic frame/batch order. Portable tests do not establish visual
quality or rendering time for another itinerary, quality profile or machine.
