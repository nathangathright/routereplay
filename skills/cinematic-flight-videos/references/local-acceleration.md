# Local acceleration

Acceleration is optional. The defaults remain CPU rendering, two Blender CPU threads and software x264 encoding. Select each stage independently; a GPU setting does not move the entire renderer to the GPU.

| Option | Work accelerated | Requirements and fallback |
| --- | --- | --- |
| `--cycles-device metal` | Blender's aircraft lighting and geometry | A successful local Cycles Metal render probe. `auto` tries Metal and falls back to CPU during selection; explicit `metal` fails clearly if unavailable. |
| `--blender-threads 10` | CPU work in Blender | Choose a count suitable for the machine. Tiny aircraft images may render faster on several CPU cores than on Metal. This is separate from `--workers`. |
| `--compute metal` | Weather preparation/backtraces, atmospheric solar depth, cloud light paths/density and optional batched cloud views | Optional MLX on Apple Silicon. `auto` probes both kernels and falls back to CPU during selection. Cloud light paths evaluate density and all march samples in one dispatch. Small density batches, legacy normals, geometry, terrain, compositing and some lighting remain on the CPU. See [bird’s-eye performance](birdseye-performance.md) for batched view and atmosphere options. |
| `--encoder videotoolbox` | Final H.264 encoding | Local Apple hardware and a successful 1080×1920 encode probe. Hardware is required; there is no silent software fallback. Default `x264` remains available. |

For the optional MLX kernels, install `scripts/requirements-metal.txt` into the same Python environment as the renderer. Blender Metal and VideoToolbox do not need MLX. Rendering remains offline after dependency and asset preparation.

```sh
python3 "$SKILL_DIR/scripts/flight_video.py" preview trip.json \
  --assets data/november --workdir renders --quality preview --frames 0,90,180 \
  --cycles-device cpu --blender-threads 10 --compute auto
```

Compare a few identical frames before selecting acceleration for a full film. Test initial compilation separately from warm execution. `--blender-probe-timeout` controls the cold Metal probe budget; `--blender-frame-timeout` controls the subsequent render batches. Increasing workers can increase memory use and contention for the same GPU.

The resolved backend, device information, precision and Blender thread count enter the frame cache identity and provenance. Changing backends therefore cannot silently reuse frames rendered with another backend. MLX uses float32. The atmospheric kernel repairs rare near-boundary samples with float64; the cloud kernel retains CPU shell-hit classification. Both return numerically close results, not bit-identical ones. Cloud field and texture uploads are reused only for immutable arrays in bounded two-entry caches. The public CPU implementation remains the reference.

`auto` fallback occurs at selection time. A later worker or device failure stops the render and retains completed frames; it does not mix CPU and GPU results in one cache. The probe confirms a small render/kernel works, not that every supplied model fits the device. Retry explicitly on CPU if needed.

Encoder selection reuses the same rendered frames. VideoToolbox writes `video-videotoolbox.mp4` and its own verification record, preserving `video.mp4`. Its quality setting is not equivalent to x264 CRF. Inspect a decoded twilight/cloud sequence for compression artifacts before delivery.

On one M1 Max benchmark of eight small aircraft frames, ten CPU threads slightly outperformed Metal; both were about twice as fast as two CPU threads. The atmospheric kernel's benefit grows with solar quadrature cost. Cloud acceleration fuses repeated density lookups across a complete light ray, avoiding per-sample CPU/GPU transfers. These are stage measurements, not a promise of full-film speed. Use the render's performance report to assess the actual trip and quality profile.

A matched M1 Max test of two delivery-quality cloud passes measured 10.26 → 6.32 seconds and 24.83 → 8.68 seconds with the fused cloud kernel (1.62× and 2.86×). Atmospheric Metal was enabled on both sides; unchanged weather preparation and the other frame stages were outside those timers. Camera transmission was identical; maximum scene-linear RGB differences were below 0.00076. These are two warm stage measurements, not full-film speed estimates. Full-frame comparisons differed by at most two 8-bit channel levels. Benchmark each trip and worker count locally.

## Expanded cloud kernels

Point-density batches of at least 1,024 samples use a fused Metal kernel when legacy normals are not required. Smaller batches retain CPU sampling because dispatch can cost more than the work. The joint primary solar path now uses fused cloud integration with CPU shell intervals and finite-Sun visibility. There is no runtime error fallback; a GPU failure still stops the invocation.

Transfer-inclusive matched M1 Max preview frames measured layered frame 330 at 2.40 s versus 2.26 s, and joint frame 450 at 12.51 s versus 4.78 s. These warm compositor measurements exclude identical macro-weather/exposure preparation and use a diagram aircraft. Maximum decoded RGB difference was one 8-bit level with a zero 99th percentile in both frames. They do not predict full-film speed or include later lunar/environment costs. Weather preparation, geometry, terrain, small density batches and most compositing remain on CPU. Use the [local render budget](render-budgets.md) to measure the actual final configuration.

The earlier timings above predate the new weather, scene-cache and batched-view paths. See [bird’s-eye performance](birdseye-performance.md) for their scope, cache storage and comparison procedure.
