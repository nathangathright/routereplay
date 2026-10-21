"""Machine-local render measurements and conservative, cache-aware planning.

The CLI calls run_budget inside flight_video.configure. A fresh Python worker
measures the same preparation and frame functions as production. No video is
encoded, caches are never cleared, and unavailable costs stay explicitly unknown.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import statistics
import subprocess
import sys
import time

SCRIPTS = Path(__file__).resolve().parent
MAX_SAMPLES = 12
MAX_MEASURED_PREPASS_FRAMES = 12000
MAX_PLANNED_FRAMES = 1000000
SCHEMA_VERSION = 1


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, allow_nan=False).encode()).hexdigest()


def _read(path):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return None


def _write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    pending = path.with_name(path.name + '.pending')
    pending.write_text(json.dumps(value, indent=2, allow_nan=False) + '\n')
    pending.replace(path)


def _positive(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0


def _rounded(value):
    """Two significant digits for estimates, never machine-looking precision."""
    return 0 if value == 0 else round(value, 1 - int(math.floor(math.log10(abs(value)))))


def _summary(values):
    values = [float(v) for v in values if _positive(v)]
    if not values:
        return None
    return {'count': len(values), 'mean': statistics.mean(values), 'median': statistics.median(values),
            'minimum': min(values), 'maximum': max(values)}


def validate_request(trip, *, samples=3, frames=None, workers=2, estimate_only=False):
    if isinstance(workers, bool) or not isinstance(workers, int) or not 1 <= workers <= 256:
        raise ValueError('Budget workers must be an integer from 1 through 256.')
    if isinstance(samples, bool) or not isinstance(samples, int) or not 1 <= samples <= MAX_SAMPLES:
        raise ValueError(f'Budget samples must be an integer from 1 through {MAX_SAMPLES}.')
    if not 1 <= trip.frame_count <= MAX_PLANNED_FRAMES:
        raise ValueError(f'Budget planning supports at most {MAX_PLANNED_FRAMES} frames.')
    if not estimate_only and trip.frame_count > MAX_MEASURED_PREPASS_FRAMES:
        raise ValueError(f'Measured budgets prepare at most {MAX_MEASURED_PREPASS_FRAMES} frames; '
                         'use --estimate-only for larger plans. Their prepass cost remains unknown.')
    if isinstance(frames, str):
        try:
            frames = [int(v.strip()) for v in frames.split(',')]
        except ValueError as exc:
            raise ValueError('Budget frames must be comma-separated integers.') from exc
    if frames is not None:
        if (not isinstance(frames, (list, tuple)) or not 1 <= len(frames) <= MAX_SAMPLES or
                any(isinstance(t, bool) or not isinstance(t, int) or not 0 <= t < trip.frame_count for t in frames)):
            raise ValueError(f'Select 1–{MAX_SAMPLES} budget frames within this trip.')
        return sorted(set(frames))
    return None


def representative_frames(trip, samples=3, available=None):
    """Cover the itinerary in presentation time, including holds when affordable."""
    available = list(range(trip.frame_count)) if available is None else sorted(set(available))
    if not available:
        return []
    count = min(samples, len(available))
    intervals = list(trip.leg_intervals)
    mids = [round((start + end) * .5 * trip.fps) for start, end in intervals]
    holds = []
    edges = [(0., intervals[0][0])] + [(a[1], b[0]) for a, b in zip(intervals, intervals[1:])] + [(intervals[-1][1], trip.duration_s)]
    for start, end in edges:
        if end > start:
            holds.append(round((start + end) * .5 * trip.fps))
    # When samples cannot cover every leg, spread them over the whole route.
    if count < len(mids):
        preferred = [mids[round(i * (len(mids)-1) / max(1, count-1))] for i in range(count)]
    else:
        preferred = mids + holds + [0, trip.frame_count-1]
    preferred += [round(i * (trip.frame_count-1) / max(1, count-1)) for i in range(count)]
    chosen = []
    import bisect
    for target in preferred:
        at = bisect.bisect_left(available, target)
        candidates = available[max(0, at-1):at+1]
        if not candidates:
            continue
        selected = min(candidates, key=lambda t: (abs(t-target), t))
        if selected not in chosen:
            chosen.append(selected)
        if len(chosen) == count:
            break
    if len(chosen) < count:
        chosen += [t for t in available if t not in chosen][:count-len(chosen)]
    return sorted(chosen)


def identity(trip, work, environment, *, workers, aircraft_mode, quality, transport):
    provenance = _read(Path(work)/'provenance.json') or {}
    cache_key = provenance.get('cache_key')
    if not isinstance(cache_key, str) or len(cache_key) != 64:
        raise ValueError('Budget requires a configured content-addressed render cache.')
    source = hashlib.sha256()
    for path in sorted(SCRIPTS.rglob('*.py')):
        source.update(path.relative_to(SCRIPTS).as_posix().encode())
        source.update(path.read_bytes())
    machine = {'node_hash': hashlib.sha256(platform.node().encode()).hexdigest(),
               'platform': platform.platform(), 'machine': platform.machine(),
               'processor': platform.processor(), 'logical_cpus': os.cpu_count(),
               'python': sys.version.split()[0]}
    record = {'cache_key': cache_key, 'source_sha256': source.hexdigest(), 'trip': trip.fingerprint,
              'machine': machine, 'environment': environment, 'workers': workers,
              'aircraft': aircraft_mode, 'quality': quality, 'transport': transport,
              'scene_cache_enabled':os.environ.get('FLIGHT_SCENE_CACHE',
                  'on' if provenance.get('scene_cache', {}).get('enabled', True) else 'off') == 'on'}
    # The cache key already excludes operational fallback messages; do so here too.
    record['environment'] = json.loads(json.dumps(environment))
    for field in ('cycles_device', 'compute_device'):
        if field in record['environment']:
            record['environment'][field].pop('fallback_reason', None)
    return {'fingerprint': _hash(record), **record}


def set_timing_identity(args, trip, work, environment):
    """Tag normal render timings without altering pixel identity or cache inputs."""
    value = identity(trip, work, environment, workers=getattr(args, 'workers', 2), aircraft_mode=args.aircraft,
                     quality=getattr(args, 'quality', 'delivery'),
                     transport=getattr(args, 'transport', 'layered'))['fingerprint']
    os.environ['FLIGHT_BUDGET_FINGERPRINT'] = value
    return value


def _measure(request_path, log_path, timeout):
    # A timed-out benchmark must stop its pool/Blender descendants before the
    # caller releases the render-cache lock and permits another process to resume.
    with log_path.open('w') as log:
        process = subprocess.Popen([sys.executable, '-E', str(Path(__file__).resolve()),
                                    '--worker', str(request_path)], stdout=log,
                                   stderr=subprocess.STDOUT, start_new_session=os.name == 'posix')
        try:
            return process.wait(timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            if os.name == 'posix':
                import signal
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
                # The worker may exit before one of its descendants. Kill any
                # remaining group members before returning the cache lock.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                if process.poll() is None:
                    process.wait()
            else:
                subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
                process.kill(); process.wait()
            raise RuntimeError(f'Render budget exceeded {timeout:g}s; completed caches remain resumable. '
                               f'Diagnostics: {log_path}') from exc


def cache_progress(trip, work, aircraft_mode, *, png_validator=None, aircraft_validator=None):
    """Validate actual artifacts; stray timing files never count as completed pixels."""
    import flight_video as pipeline
    from engine.motion import Motion
    work = Path(work)
    png_validator = png_validator or pipeline.valid_png
    aircraft_validator = aircraft_validator or pipeline.valid_aircraft
    complete, missing, sizes, timings = [], [], [], []
    for tick in range(trip.frame_count):
        path = work/'frames'/f'{tick:06d}.png'
        if path.is_file() and png_validator(path, (1080, 1920)):
            complete.append(tick); sizes.append(path.stat().st_size)
            value = _read(path.with_suffix('.timing.json'))
            if isinstance(value, dict) and value.get('frame') == tick and _positive(value.get('seconds')):
                timings.append({'frame': tick, 'seconds': float(value['seconds']),
                                'budget_fingerprint': value.get('budget_fingerprint'),
                                'scene_cache': value.get('scene_cache', {'status':'unknown'})})
        else:
            missing.append(tick)
    from scene_cache import missing_frames, configured
    scene_setup = configured()
    scene_missing = set(missing_frames(range(trip.frame_count),trip=trip))
    scene_cached = [tick for tick in range(trip.frame_count) if tick not in scene_missing]
    scene_sizes = ([(scene_setup[0]/f'{tick:06d}.npz').stat().st_size for tick in scene_cached]
                   if scene_setup else [])
    kinds = {}
    if aircraft_mode == 'cycles':
        motion = Motion(trip)
        needed = set()
        for tick in sorted(scene_missing):
            for leg, _ in motion.aircraft_mix(tick/trip.fps):
                needed.add((trip.legs[leg].aircraft, tick))
        for kind, tick in sorted(needed):
            item = kinds.setdefault(kind, {'required_for_render': 0, 'valid_cached': 0, 'missing': [], 'bytes': []})
            item['required_for_render'] += 1
            path = work/'aircraft'/('frames-'+kind)/f'frame-{tick:04d}.npz'
            if path.is_file() and aircraft_validator(path):
                item['valid_cached'] += 1; item['bytes'].append(path.stat().st_size)
            else:
                item['missing'].append(tick)
    footprint = sum(path.stat().st_size for path in work.rglob('*') if path.is_file())
    snapshot = {'complete_frames': complete, 'missing_frames': missing,
                'missing_aircraft': {k: v['missing'] for k,v in kinds.items()},
                'scene_cached': scene_cached}
    return {'frames_total': trip.frame_count, 'valid_frames': len(complete), 'remaining_frames': len(missing),
            'complete_frame_indices': complete, 'missing_frame_indices': missing, 'png_bytes': sizes,
            'frame_timings': timings, 'aircraft': kinds, 'cache_bytes': footprint,
            'scene_cache': {'key': scene_setup[1] if scene_setup else None,
                            'cached_frame_indices':scene_cached, 'bytes':scene_sizes,
                            'remaining_hits':sum(tick not in scene_missing for tick in missing),
                            'remaining_misses':sum(tick in scene_missing for tick in missing)},
            'snapshot_fingerprint': _hash(snapshot)}


def _memory():
    try:
        import resource
        scale = 1 if sys.platform == 'darwin' else 1024
        return {'process_peak_rss_bytes': int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*scale),
                'largest_child_peak_rss_bytes': int(resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss*scale)}
    except (ImportError, AttributeError, OSError):
        return {'process_peak_rss_bytes': None, 'largest_child_peak_rss_bytes': None}


def _worker(request_path):
    """Fresh process uses production preparation, aircraft and process-pool functions."""
    started = time.perf_counter()
    import flight_video as pipeline
    from trip import load_trip
    request = _read(request_path)
    work = Path(request['work']); trip = load_trip(work/'trip.json')
    result = {'import_seconds': time.perf_counter()-started, 'aircraft': {}}
    start = time.perf_counter()
    pipeline.prepare_media(trip, work, request['frames'])
    terrain = pipeline.prepare_contexts(trip, work, request['bundle'], request['assets'],
                                        scene_frames=request['frames'])
    result['prepass_seconds'] = time.perf_counter()-start
    from scene_cache import missing_frames
    physical_frames = missing_frames(request['frames'],trip=trip)
    result['scene_cache'] = {'hit':len(request['frames'])-len(physical_frames), 'miss':len(physical_frames)}
    if request['aircraft'] == 'cycles':
        from engine.motion import Motion
        motion = Motion(trip)
        needed = {}
        for tick in physical_frames:
            for leg,_ in motion.aircraft_mix(tick/trip.fps):
                kind = trip.legs[leg].aircraft
                path = work/'aircraft'/('frames-'+kind)/f'frame-{tick:04d}.npz'
                if not pipeline.valid_aircraft(path):
                    needed.setdefault(kind, []).append(tick)
        start = time.perf_counter()
        prepared = pipeline.prepare_aircraft(trip,work,physical_frames,request['environment']['tools']['blender'],
            terrain,request['bundle'],request['assets'],frame_timeout=request['frame_timeout'],
            device=request['environment']['cycles_device'],threads=request['threads'])
        if isinstance(prepared, dict):
            needed = prepared
        result['aircraft'] = {'seconds': time.perf_counter()-start,
            'new_frames_by_kind': {kind:len(ticks) for kind,ticks in needed.items()},
            'output_bytes_by_kind': {kind:[(work/'aircraft'/('frames-'+kind)/f'frame-{tick:04d}.npz').stat().st_size
                                           for tick in ticks] for kind,ticks in needed.items()}}
    start = time.perf_counter()
    pipeline.produce_frames(trip,work,request['frames'],request['workers'])
    result['render_batch_seconds'] = time.perf_counter()-start
    events=[(_read(work/'frames'/f'{tick:06d}.timing.json') or {}).get('scene_cache', {}).get('status')
            for tick in request['frames']]
    events=['miss' if event == 'disabled' else event for event in events]
    if all(event in ('hit','miss') for event in events):
        result['scene_cache'] = {status:events.count(status) for status in ('hit','miss')}
    result['memory'] = _memory()
    result['worker_total_seconds'] = time.perf_counter()-started
    _write(request['result_path'], result)


def estimate(progress, benchmark, *, workers, fingerprint=None):
    """Ranges are explicit planning scenarios, not confidence intervals or guarantees."""
    remaining = progress['remaining_frames']
    notes = []
    measured_frames = set((benchmark or {}).get('sample_frames', []))
    trusted = [r for r in progress['frame_timings'] if
               (fingerprint is not None and r.get('budget_fingerprint') == fingerprint) or r['frame'] in measured_frames]
    unverified = [r for r in progress['frame_timings'] if r not in trusted]
    frame_stats = _summary([r['seconds'] for r in trusted])
    sample_count = (benchmark or {}).get('new_render_frames', 0)
    measured = (benchmark or {}).get('measurement', {})
    if sample_count and _positive(measured.get('render_batch_seconds')):
        rate = measured['render_batch_seconds']/sample_count
        rate_basis = 'Measured batch wall time per new frame; includes process startup. No additional worker speedup assumed.'
    elif frame_stats:
        rate = frame_stats['median']
        rate_basis = 'Existing per-frame timings, serial planning only; worker overlap/throughput was not measured.'
        notes.append('Completed timing files do not establish parallel throughput or preparation cost.')
    else:
        rate = None
        rate_basis = 'No matching local completed-frame measurement.'
    # With few frames, geographic and startup variation dominate. These are
    # deliberately broad scenarios and do not claim statistical coverage.
    spread = (0.5, 2.) if sample_count >= 3 else (1/3, 3.)
    render_mid = remaining*rate if rate is not None else (0. if remaining == 0 else None)
    scene_rates = None
    if 'scene_cache' in progress:
        # A warm overlay measurement must never imply that uncached transport
        # is equally cheap. Keep the two populations separate; unseen costs
        # stay unknown, including legacy timings that did not record status.
        scene_rates = {}
        counts = measured.get('scene_cache', {})
        render_mid = 0.
        for status in ('hit', 'miss'):
            count = progress['scene_cache']['remaining_'+('hits' if status == 'hit' else 'misses')]
            values = [r['seconds'] for r in trusted
                      if r.get('scene_cache', {}).get('status') in (('miss','disabled') if status == 'miss' else ('hit',))]
            group_rate = statistics.median(values) if values else None
            if sample_count and counts.get(status) == sample_count and _positive(measured.get('render_batch_seconds')):
                group_rate = measured['render_batch_seconds']/sample_count
            scene_rates[status] = {'remaining_frames':count,
                                   'wall_seconds_per_frame':None if group_rate is None else _rounded(group_rate)}
            if count and group_rate is None:
                render_mid = None
            elif render_mid is not None:
                render_mid += count*(group_rate or 0.)
        rate = render_mid/remaining if render_mid is not None and remaining else None
        rate_basis = 'Separate scene-hit overlay and scene-miss transport measurements; unmeasured populations remain unknown.'
        notes.append('Overlay-only timings cannot estimate uncached physical scenes. Scene validation reads one frame at a time before preparation.')
    render_range = ([_rounded(render_mid*spread[0]), _rounded(render_mid*spread[1])]
                    if render_mid is not None else None)
    aircraft_seconds = 0.
    missing_kinds = []
    projected_aircraft_bytes = 0.
    for kind, item in progress['aircraft'].items():
        count = len(item['missing'])
        prior = measured.get('aircraft', {})
        measured_counts = prior.get('new_frames_by_kind', {})
        if count:
            if measured_counts.get(kind, 0) and _positive(prior.get('seconds')):
                aircraft_seconds += count*prior['seconds']/sum(measured_counts.values())
            else:
                missing_kinds.append(kind)
        sizes = item['bytes'] + prior.get('output_bytes_by_kind', {}).get(kind, [])
        if count and not sizes:
            projected_aircraft_bytes = None
        elif projected_aircraft_bytes is not None:
            projected_aircraft_bytes += count*statistics.mean(sizes) if count else 0
    prepass = measured.get('prepass_seconds')
    # Full prepare_contexts is rerun by production even on resume. A measured
    # prepass is retained as an upper planning proxy for its warmed cache.
    if _positive(prepass):
        preparation = prepass
    else:
        preparation = None
    known_total = render_mid is not None and preparation is not None and not missing_kinds
    total = render_mid+preparation+aircraft_seconds if known_total else None
    known_parts = sum(v for v in (render_mid, preparation, aircraft_seconds) if v is not None)
    png_mean = statistics.mean(progress['png_bytes']) if progress['png_bytes'] else None
    png_bytes = remaining*png_mean if png_mean is not None else (0 if remaining == 0 else None)
    disk = (png_bytes+projected_aircraft_bytes if png_bytes is not None and projected_aircraft_bytes is not None else None)
    rss = measured.get('memory', {})
    own, child = rss.get('process_peak_rss_bytes'), rss.get('largest_child_peak_rss_bytes')
    host_envelope = own + workers*child if own is not None and child is not None else None
    notes.extend(['Aircraft planning uses pooled measured time per new asset, including lighting prepass and Blender launches; unseen aircraft types remain unknown.',
                  'Sample ranges are scenarios, not confidence bounds; unobserved cloud, terrain, night and aircraft cases may cost more.',
                  'Worker processes compete for CPU/RAM; Metal/Cycles workers may share one GPU. Do not extrapolate these measurements to another worker count.',
                  'Host memory is a conservative process-plus-workers RSS proxy, not simultaneous measured residency. GPU/VRAM and driver allocations are unknown.',
                  'Video encoding, decode verification and final/temporary MP4 disk usage are unmeasured and excluded. This is a remaining frame-cache budget, not a promised export completion time.'])
    return {'frame_seconds': frame_stats,
            'unverified_frame_seconds': _summary([r['seconds'] for r in unverified]),
            'unverified_frame_timing_count': len(unverified), 'wall_seconds_per_frame': None if rate is None else _rounded(rate),
            'rate_basis': rate_basis, 'scene_rates':scene_rates, 'remaining_render_wall_seconds': render_range,
            'remaining_aircraft_seconds_estimate': None if missing_kinds else _rounded(aircraft_seconds),
            'unmeasured_aircraft_kinds': missing_kinds,
            'next_prepass_seconds_proxy': None if preparation is None else _rounded(preparation),
            'remaining_frame_cache_wall_seconds': None if total is None else [_rounded(total*spread[0]), _rounded(total*spread[1])],
            'known_components_seconds_estimate': _rounded(known_parts),
            'encoding_and_verification_seconds': None,
            'additional_frame_and_aircraft_bytes': None if disk is None else [_rounded(disk*.7), _rounded(disk*1.5)],
            'additional_scene_cache_bytes_upper_bound': (
                progress['scene_cache']['remaining_misses']*(1920*1080*3*4+224*224*4+65536)
                if progress.get('scene_cache', {}).get('key') else (0 if 'scene_cache' in progress else None)),
            'additional_prepass_and_encoded_output_bytes': None,
            'host_memory_planning_proxy_bytes': host_envelope, 'gpu_memory_bytes': None, 'uncertainty': notes}


def run_budget(args, trip, bundle, work, environment, *, startup_seconds=0.):
    """Return report. Measurement writes caches; estimate-only reads them unchanged.

    Optional args: samples=3, frames=None, estimate_only=False, report=None.
    Other fields are the existing flight_video render arguments. configure's
    elapsed startup can be supplied separately; it is never multiplied by frames.
    """
    work = Path(work).resolve()
    workers = args.workers
    estimate_only = getattr(args, 'estimate_only', False)
    timeout = getattr(args, 'budget_timeout', 1800.)
    if not _positive(timeout) or timeout > 86400:
        raise ValueError('Budget timeout must be positive and at most 86400 seconds.')
    explicit = validate_request(trip, samples=getattr(args,'samples',3), frames=getattr(args,'frames',None),
                                workers=workers, estimate_only=estimate_only)
    stamp = identity(trip,work,environment,workers=workers,aircraft_mode=args.aircraft,
                     quality=args.quality,transport=args.transport)
    if not estimate_only:
        os.environ['FLIGHT_BUDGET_FINGERPRINT'] = stamp['fingerprint']
    before = cache_progress(trip,work,args.aircraft)
    previous = _read(work/'render-budget-benchmark.json')
    benchmark = previous if isinstance(previous, dict) and previous.get('fingerprint') == stamp['fingerprint'] else None
    rejected = previous is not None and benchmark is None
    # Old per-frame records have no machine/worker identity. Show them only as
    # unverified diagnostics, never as current throughput evidence.
    selected = explicit if explicit is not None else representative_frames(
        trip,getattr(args,'samples',3),before['missing_frame_indices'])
    new_frames = [t for t in selected if t in set(before['missing_frame_indices'])]
    if not estimate_only and new_frames:
        request = {'work':str(work),'assets':str(Path(args.assets).expanduser().resolve()),'bundle':bundle,
                   'frames':new_frames,'workers':workers,'aircraft':args.aircraft,'environment':environment,
                   'threads':getattr(args,'blender_threads',2),'frame_timeout':getattr(args,'blender_frame_timeout',120.),
                   'result_path':str(work/'render-budget-measurement.json')}
        request_path = work/'render-budget-request.json'; _write(request_path,request)
        started = time.perf_counter()
        log_path = work/'render-budget.log'
        code = _measure(request_path,log_path,timeout)
        if code:
            raise RuntimeError(f'Render budget measurement failed; diagnostics: {log_path}')
        measurement = _read(request['result_path'])
        if not isinstance(measurement,dict):
            raise RuntimeError(f'Render budget worker did not write measurements; diagnostics: {log_path}')
        measurement['subprocess_wall_seconds']=time.perf_counter()-started
        benchmark={'schema_version':SCHEMA_VERSION,'fingerprint':stamp['fingerprint'],
                   'created_utc':datetime.now(timezone.utc).isoformat(),'sample_frames':new_frames,
                   'new_render_frames':len(new_frames),'measurement':measurement}
        after_stamp = identity(trip,work,environment,workers=workers,aircraft_mode=args.aircraft,
                               quality=args.quality,transport=args.transport)
        if after_stamp['fingerprint'] == stamp['fingerprint']:
            _write(work/'render-budget-benchmark.json',benchmark)
    else:
        after_stamp = stamp
    changed = after_stamp['fingerprint'] != stamp['fingerprint']
    progress = cache_progress(trip,work,args.aircraft) if not estimate_only and new_frames else before
    report={'schema_version':SCHEMA_VERSION,'created_utc':datetime.now(timezone.utc).isoformat(),
            'mode':'estimate_only' if estimate_only else 'measured', 'identity':stamp,
            'configured_startup_seconds': startup_seconds if _positive(startup_seconds) else None,
            'selected_frames':selected,'new_measured_frames':new_frames if not estimate_only else [],
            'measurement':benchmark,'stale_benchmark_rejected':rejected,
            'source_changed_during_measurement':changed,
            'identity_after_measurement':after_stamp if changed else None,
            'measurement_usable_for_estimate':benchmark is not None and not changed,
            'progress':progress,'estimate':estimate(progress,None if changed else benchmark,workers=workers,
                                                    fingerprint=None if changed else stamp['fingerprint']),
            'disk_free_bytes':__import__('shutil').disk_usage(work).free,
            'work_directory':str(work)}
    if changed:
        report['estimate']['uncertainty'].insert(0, 'Source changed during measurement. Raw timings are retained, '
            'but cannot establish a matching budget; repeat after source changes finish.')
    destination=getattr(args,'report',None)
    if destination:
        _write(Path(destination).expanduser().resolve(),report)
    elif not estimate_only:
        _write(work/'render-budget.json',report)
    return report


if __name__ == '__main__':
    if len(sys.argv)==3 and sys.argv[1]=='--worker':
        _worker(sys.argv[2])
    else:
        raise SystemExit('Use flight_video.py budget with a trip and local asset bundle.')
