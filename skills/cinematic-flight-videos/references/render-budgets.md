# Local render budgets

Measure a few frames before starting a long render:

```sh
python scripts/flight_video.py budget trip.json \
  --assets ./assets --workdir ./renders \
  --quality preview --workers 2 --samples 3 \
  --report ./budget.json
```

Use the same quality, aircraft mode, transport, compute backend, Cycles backend,
Blender thread count and worker count intended for the render. A preview
measurement does not establish delivery-quality speed. The command uses the
normal content-addressed cache, so successfully prepared aircraft and rendered
frames can be reused. It never encodes or copies a full film.

The default selects three missing frames spread across flight legs. With enough
samples it also covers presentation holds. Use `--frames 0,240,539` to select known
day, night, cloudy, terrain or aircraft-transition cases. Selection accepts at
most twelve frames; `--samples` accepts one through twelve. Physical layovers of
many days do not expand the number of selected frames.

The benchmark runs a fresh local Python process and measures production context
and city-light preparation, selected-frame aircraft lighting and Cycles
preparation when enabled, and the compositor process pool. Configuration and
backend startup are reported separately. The child has a 1,800-second default
timeout, configurable with `--budget-timeout` up to 86,400 seconds. A timeout stops
its workers and Blender descendants and leaves completed cache entries resumable.
Measured plans are limited to 12,000 total presentation frames so the full
production prepass stays bounded; larger plans can use `--estimate-only`.

## Read an existing estimate

```sh
python scripts/flight_video.py budget trip.json \
  --assets ./assets --workdir ./renders \
  --quality preview --workers 2 --estimate-only \
  --report ./remaining-budget.json
```

This reads an existing matching cache without rendering. Omit `--report` to print
JSON without saving a report. An explicit report path should be outside the input
asset bundle and trip file.

A usable measurement must match the source files, normalized trip, validated
asset/cache identity, machine, Python and tool environment, backends, quality,
transport, aircraft mode and worker count. Report files are not source or asset
inputs and do not alter that identity. Changed source during a benchmark retains
the raw observations but suppresses its estimate. Measurements from another
machine or configuration are rejected. Old untagged per-frame timings remain
visible as unverified observations and do not establish an estimate.

## Interpret the report

- `progress` counts valid PNG and aircraft cache entries; corrupt files and
  timing sidecars without a valid image do not count as completed work.
- `measurement.measurement` contains raw observed stage durations, output sizes
  and process memory peaks. The benchmark's batch duration includes worker
  startup, even for a one-frame sample.
- `estimate.frame_seconds` summarizes matching frame timings.
  `remaining_render_wall_seconds` uses measured batch throughput, or serial
  planning from tagged completed-frame timings. It does not assume more workers
  produce a proportional speedup.
- `remaining_frame_cache_wall_seconds` includes estimated missing aircraft and a
  repeat-prepass proxy. It remains `null` if a required aircraft type or prepass
  has not been measured. A PNG cache hit does not imply that production can skip
  its required aircraft preparation.
- `additional_frame_and_aircraft_bytes` extrapolates observed file sizes;
  `disk_free_bytes` reports current free storage. Additional prepass storage,
  temporary video and final encoded size remain unknown.
- `host_memory_planning_proxy_bytes` adds the benchmark process peak to the
  worker count times the largest observed child peak. This is a conservative
  RSS proxy, not a simultaneous residency measurement or a VRAM measurement.

Ranges are broad planning scenarios, not confidence intervals or deadlines:
one or two samples use one-third to three times the observed rate; three or more
use one-half to twice the rate. Estimates use two significant digits, while raw
observations retain their measured precision. Unseen weather, terrain, night
lighting and aircraft cases can exceed those scenarios. Aircraft launch and
lighting costs are pooled across measured assets, so their startup overhead can
make extrapolation conservative.

Other programs, CPU thermal limits, shared GPU work and concurrent workers can
change throughput and memory use. Measure the intended local configuration under
representative load. Encoding and decode verification are excluded: this is a
remaining frame-cache budget, not a promised time to finish an MP4. Missing
measurements are represented by `null`, never by a fabricated zero-cost stage.
