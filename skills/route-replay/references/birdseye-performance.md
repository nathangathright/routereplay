# Bird’s-eye rendering performance

The globe renderer keeps its CPU reference and adds optional local Metal work.
The third-person Blender scene is separate. These changes do not freeze weather,
reuse previous-frame pixels, or change the physical clock.

For the separate quality/cost tradeoff introduced in v0.18, see [spatial volume
reconstruction](volume-reconstruction.md). Adaptive sampling adds rays to improve
reduced-resolution edges; it is not another speed optimization. Keep the same
selector when comparing compute backends or estimating a movie's render budget.

## Reuse a scene when editing its presentation

Final PNG caches still include the complete trip, fonts, code and environment.
A second cache under the work directory's `scenes/` stores the composed linear
HDR scene and aircraft coverage before exposure, route graphics, airport labels,
telemetry and local media. Typography, overlay-only source changes, title,
telemetry, media and exposure edits can reuse it. Physical inputs, camera timing,
weather, lighting, aircraft, quality and backend changes invalidate it. Unknown
source files and settings invalidate conservatively.

Scene entries are lossless float32, validated and written atomically. Locks on
individual frames allow overlay variants to share a scene without racing its
creation. A corrupt entry becomes a miss. Production and budget commands skip
Cycles preparation for valid scene hits. Budget reports distinguish expensive
scene misses from cheap overlay hits; one population cannot estimate the other.
Planning remembers validation results while each file's size, timestamps and
identity remain unchanged; rendering still validates the payload before reuse.

This trades disk for iteration speed: one measured 1080×1920 frame occupied
22.9 MB. A 540-frame film could therefore need roughly 12 GB of additional scene
storage, depending on compressibility. Work is kept one frame at a time in
memory. Scene entries are regenerable files in the chosen work directory; there
is no background cleanup service or remote storage.
Use `--scene-cache off` to avoid this extra storage. Cache setup, lock or write
failures warn and allow rendering to continue; a failed cache write retains the
completed scene for its final PNG. Required input and output errors remain fatal.
Failure state is per worker: each worker may attempt one failed cache write and
emit one warning before skipping further writes. Existing cache reads continue.

## Optional compute paths

```sh
python3 scripts/flight_video.py budget trip.json --assets data/prepared \
  --workdir renders --quality delivery --workers 2 --samples 6 \
  --compute metal --cloud-view batched --atmosphere-method lookup \
  --atmosphere-view batched --cloud-source batched
```

Use the same options for `preview` or `render` after inspecting the selected
frames. `--compute auto` probes optional Metal kernels and selects CPU if the
probe fails; explicit `metal` fails clearly. A failure after selection stops the
render rather than mixing backends within one cache. CPU remains the portable
default, with `--cloud-view reference --atmosphere-method integrate`.
Provenance records each effective view/source path and retains requested options
separately. Unsupported batched combinations normalize to the reference path and
share its cache identity. The optional atmosphere-view kernel is probed only when
selected; a failed probe follows the same explicit-Metal versus auto rules.

- **Weather:** Metal prepares global cloud coverage, column mass/height and
  spherical wind backtraces for each exact weather timestamp. CPU code still
  loads and smooths source grids and chooses forecast brackets. Sparse polar
  and nearly empty-column corrections retain the CPU boundary behavior. Source
  arrays and GPU uploads use bounded immutable caches. Weather keeps moving
  through layovers and end holds.
- **Cloud view:** `--cloud-view batched` batches ray samples into bounded tiles,
  computes density and front-to-back weights on Metal, evaluates complete Sun,
  sky, Moon and city sources in batches, and sums the weighted light on Metal.
  Geometry and some lighting still run on the CPU. The path supports layered
  transport with the current cloud lighting; CPU, joint transport and legacy
  normal-based lighting retain their reference view integration.
- **Empty space:** Conservative per-cell vertical occupancy masks skip cloud
  density work only where all contributing weather corners prove it empty.
  They retain bilinear cell boundaries, thin clouds and dateline wrapping.
  This does not reduce the sample count at cloud edges, the terminator or the
  aircraft. Existing opaque-ray termination is retained.
- **Atmosphere:** `--atmosphere-method lookup` uses bounded clear-air optical-depth
  tables for outward rays ending at the atmosphere boundary. Tables match the
  chosen quadrature budget. Inward, tangent and partial paths retain integration;
  dated aerosol extinction is always evaluated separately. Metal queries tables
  inside its existing kernel, avoiding a CPU interpolation roundtrip. The CPU
  reference uses the same table contract. Sun and Moon share the method.
- **Atmosphere view:** `--atmosphere-view batched` keeps float64 ray/depth and
  finite-disc shadow boundaries, prepares dated lunar and aerosol sources in
  bounded tiles, and integrates clear-air sunlight, scattering and front-to-back
  transmission on Metal. Ambiguous float32 density-boundary samples retain the
  reference solar integral and correct their weighted sunlight contribution.
  Moonlight and view extinction need no second evaluation. Both optical-depth methods are supported.
  CPU and joint transport retain their reference paths.
- **Cloud sources:** `--cloud-source batched` combines direct solar/lunar paths,
  directional sky queries and city-light footprint/column queries. Shared solar
  and lunar zenith paths are evaluated once. Existing quadrature, positions,
  source addition order and both clocks remain unchanged. Bounded tiles retain
  the existing CPU geometry and Metal density/light-depth kernels. This works
  with either cloud-view mode; CPU, joint, legacy cloud lighting and clear weather
  normalize to reference.

The lookup tables build locally and contain no trip dates or downloaded data.
The method draws on the reusable lookup approach in [Hillaire’s atmosphere
implementation](https://github.com/sebh/UnrealEngineSkyAtmosphere), with a narrower
scope chosen to preserve this renderer's existing transport model.

## Measure the complete configuration

In v0.16 on an M1 Max, six representative 1080×1920 delivery-quality frames took
114.80 seconds before these changes and 92.92 seconds with Metal weather,
batched cloud view and atmospheric lookup: 19% less rendering time. The night
sample improved from 14.67 to 7.40 seconds. These unprofiled, single-process
measurements used diagram aircraft, cold per-frame weather fields, no persistent
scene hits, and excluded setup and PNG writing. They are not a full-film estimate.
Across all six images, the maximum difference was one 8-bit channel level.

The v0.17 atmosphere-view and cloud-source paths reduced a fresh matched six-frame
run from 85.80 to 71.96 seconds: another 16.1% less rendering time against v0.16.
Both sides used Metal weather, batched cloud view and atmospheric lookup. Only
the two new options changed from reference to batched. Measurements used frozen
source exports, fresh processes, identical warmup, diagram aircraft, delivery
quality and the same cache/timing exclusions above. All frames improved:

| Moment | v0.16 | v0.17 |
| --- | ---: | ---: |
| Departure | 16.75s | 14.44s |
| Twilight | 21.73s | 18.62s |
| Layover | 15.14s | 13.17s |
| Night | 7.04s | 5.71s |
| Approach | 12.55s | 9.98s |
| Arrival hold | 12.58s | 10.04s |

The layover image was identical. Every other image differed by at most one
8-bit channel level in fewer than 0.0006% of channels. These are sampled complete
frames, not a full-film benchmark. The earlier and current v0.16 timing totals
come from different runs; use the matched pair within each experiment.

A separate overlay proof reused one lossless scene in 0.17 seconds versus
18.36 seconds for its initial render and store. Unchanged overlays reproduced
identical pixels. That comparison measures iteration speed, not fresh scenes.

Compare departure, dusk, night, cloud-rich cruise, layover and arrival frames.
Include actual Cycles aircraft before delivery; diagram measurements isolate the
globe compositor and cannot establish aircraft cost or shadow quality. Measure
worker counts on the same machine: several workers share the same GPU and memory.

Stage speedups are not whole-film speedups. Separate first-use compilation and
source preparation from warm work. Keep geometry, weather instants, sampling,
source snapshot and hardware identical for comparisons. Scene cache hits measure
presentation edits, not new scene rendering. Encoding remains a separate stage.

History-based temporal reconstruction remains future work. Compressing many
physical hours into seconds makes stale cloud/lighting history particularly risky.
The v0.18 spatial refinement path uses only the current frame, while the separate
empty-space optimization retains reference sampling positions. Both preserve
frame-order independence.
