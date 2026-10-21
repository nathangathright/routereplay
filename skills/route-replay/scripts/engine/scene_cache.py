"""Content-addressed linear HDR scenes, independent of typography and display.

Only explicitly designated display modules/settings are excluded from identity.
Unknown source files and settings invalidate conservatively. Each file contains
one final physical scene and aircraft coverage; no full-film arrays stay in RAM.
A per-frame advisory lock prevents duplicate scene computation across jobs;
writes are atomic even for callers outside the CLI. A corrupt/incomplete entry is a miss, never a partial hit.
"""
from __future__ import annotations

from collections import OrderedDict
from contextlib import contextmanager
import hashlib
import json
import math
import os
import sys
from pathlib import Path
import tempfile
import zipfile
import zlib

import numpy as np

SCHEMA_VERSION = 1
RADIANCE_SHAPE = (1920, 1080, 3)
COVERAGE_SHAPE = (224, 224, 1)
# These modules may change presentation, never physical transport or camera state.
OVERLAY_SOURCES = frozenset({
    'engine/scene_overlays.py', 'engine/fonts.py', 'engine/labels.py',
    'engine/telemetry_overlay.py', 'engine/media_overlay.py', 'media_moments.py',
})
_LAST_EVENT = None
_VALIDATION_LIMIT = 16384
_VALIDATED = OrderedDict()
_STORAGE_WARNING_SHOWN = False
_WRITES_FAILED = False


def reset_invocation():
    """Reset bounded planning metadata and storage warnings for a new CLI run."""
    global _LAST_EVENT, _STORAGE_WARNING_SHOWN, _WRITES_FAILED
    _VALIDATED.clear()
    _LAST_EVENT = None
    _STORAGE_WARNING_SHOWN = False
    _WRITES_FAILED = False


def _storage_failure(error):
    global _STORAGE_WARNING_SHOWN, _WRITES_FAILED
    _WRITES_FAILED = True
    if not _STORAGE_WARNING_SHOWN:
        print(f'Warning: Scene cache storage is unavailable ({error}). '
              'Continuing without new scene-cache writes; use --scene-cache off to disable them.',
              file=sys.stderr, flush=True)
        _STORAGE_WARNING_SHOWN = True


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, allow_nan=False,
                                     separators=(',', ':')).encode()).hexdigest()


def physical_trip(trip):
    physical = trip.to_dict()
    for field in ('title', 'telemetry', 'moments'):
        physical.pop(field, None)
    for field in ('exposure_ev', 'adaptation_s'):
        physical.get('style', {}).pop(field, None)
    return physical


def identity(trip, bundle, aircraft_mode, environment, quality, transport, *, scripts=None):
    """Return a normalized scene record and its full content key.

    Exposure/eye adaptation operate after HDR transport. Telemetry and local
    media do not change the flight clock. All other trip fields remain included,
    even metadata that could theoretically be omitted, to favor safe misses.
    """
    scripts = Path(scripts) if scripts is not None else Path(__file__).resolve().parent.parent
    physical = physical_trip(trip)
    sources = hashlib.sha256()
    for path in sorted(scripts.rglob('*.py')):
        relative = path.relative_to(scripts).as_posix()
        if relative not in OVERLAY_SOURCES:
            sources.update(relative.encode())
            sources.update(path.read_bytes())
    stable_environment = json.loads(json.dumps(environment))
    for field in ('cycles_device', 'compute_device'):
        if field in stable_environment:
            stable_environment[field].pop('fallback_reason', None)
    record = {'schema_version': SCHEMA_VERSION, 'trip': physical,
              'bundle': {key: value for key, value in bundle.items() if key != 'created_at'},
              'source_sha256': sources.hexdigest(), 'aircraft': aircraft_mode,
              'environment': stable_environment, 'quality': quality, 'transport': transport,
              'radiance_shape': list(RADIANCE_SHAPE), 'coverage_shape': list(COVERAGE_SHAPE),
              'storage': 'lossless float32 linear HDR and terrain-visible aircraft alpha'}
    return {'key': _digest(record), 'record': record}


def _path(directory, tick):
    if isinstance(tick, bool) or not isinstance(tick, int) or tick < 0:
        raise ValueError('Scene frame index must be a nonnegative integer.')
    return Path(directory) / f'{tick:06d}.npz'


def _metadata(key, tick, t):
    if not isinstance(key, str) or len(key) != 64 or any(c not in '0123456789abcdef' for c in key):
        raise ValueError('Scene cache requires a full SHA-256 identity.')
    if not math.isfinite(t):
        raise ValueError('Scene time must be finite.')
    return {'schema_version': SCHEMA_VERSION, 'key': key, 'frame': tick,
            'presentation_s': t, 'radiance_shape': list(RADIANCE_SHAPE),
            'coverage_shape': list(COVERAGE_SHAPE)}


def _validate(radiance, coverage):
    return (radiance.shape == RADIANCE_SHAPE and radiance.dtype == np.dtype('float32')
            and coverage.shape == COVERAGE_SHAPE and coverage.dtype == np.dtype('float32')
            and np.isfinite(radiance).all() and (radiance >= 0).all()
            and np.isfinite(coverage).all() and ((coverage >= 0) & (coverage <= 1)).all())


def load_scene(directory, key, tick, t):
    """Validate every byte and semantic input before exposing a cached frame."""
    expected = _metadata(key, tick, t)
    path = _path(directory, tick)
    try:
        # Refuse unexpectedly large/invented members before NumPy allocates them.
        limits = {'metadata.npy': 4096,
                  'radiance.npy': math.prod(RADIANCE_SHAPE)*4+1024,
                  'coverage.npy': math.prod(COVERAGE_SHAPE)*4+1024}
        with zipfile.ZipFile(path) as archive:
            members = archive.infolist()
            if (len(members) != 3 or {item.filename for item in members} != set(limits)
                    or any(item.file_size > limits[item.filename] for item in members)):
                return None
            for item in members:
                with archive.open(item) as member:
                    version = np.lib.format.read_magic(member)
                    if version == (1, 0):
                        shape, _, dtype = np.lib.format.read_array_header_1_0(member, max_header_size=1024)
                    elif version == (2, 0):
                        shape, _, dtype = np.lib.format.read_array_header_2_0(member, max_header_size=1024)
                    else:
                        return None
                    if item.filename == 'metadata.npy':
                        if shape != () or dtype.kind != 'U' or dtype.itemsize > 3072:
                            return None
                    elif (shape != (RADIANCE_SHAPE if item.filename == 'radiance.npy' else COVERAGE_SHAPE)
                          or dtype != np.dtype('float32')):
                        return None
                    if item.file_size - member.tell() != math.prod(shape)*dtype.itemsize:
                        return None
        with np.load(path, allow_pickle=False) as data:
            metadata = data['metadata']
            if metadata.shape != () or json.loads(str(metadata.item())) != expected:
                return None
            radiance, coverage = data['radiance'], data['coverage']
        if not _validate(radiance, coverage):
            return None
        radiance.setflags(write=False)
        coverage.setflags(write=False)
        return radiance, coverage
    except (OSError, ValueError, TypeError, KeyError, EOFError, zipfile.BadZipFile, zlib.error):
        return None


def store_scene(directory, key, tick, t, radiance, coverage):
    """Lossless storage: no half-precision quantization or display transform."""
    metadata = _metadata(key, tick, t)
    radiance = np.asarray(radiance, dtype=np.float32)
    coverage = np.asarray(coverage, dtype=np.float32)
    if not _validate(radiance, coverage):
        raise ValueError('Cannot cache an invalid linear HDR scene or aircraft coverage.')
    path = _path(directory, tick)
    path.parent.mkdir(parents=True, exist_ok=True)
    pending = None
    try:
        # Unique names avoid writer collisions; readers see old or new complete
        # files. Low-cost lossless deflate saves disk without a second full copy.
        with tempfile.NamedTemporaryFile(prefix='.'+path.stem+'-', suffix='.tmp',
                                         dir=path.parent, delete=False) as handle:
            pending = Path(handle.name)
            with zipfile.ZipFile(handle, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
                for name, array in (('metadata', np.asarray(json.dumps(metadata, sort_keys=True))),
                                    ('radiance', radiance), ('coverage', coverage)):
                    with archive.open(name+'.npy', 'w', force_zip64=True) as member:
                        np.lib.format.write_array(member, array, allow_pickle=False)
            handle.flush()
            os.fsync(handle.fileno())
        pending.replace(path)
    finally:
        if pending is not None:
            pending.unlink(missing_ok=True)



def initialize(directory, record):
    """Publish identical source identity safely across independent overlay jobs."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    pending = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', prefix='.identity-', suffix='.tmp',
                                         dir=directory, delete=False) as handle:
            pending = Path(handle.name)
            json.dump(record, handle, sort_keys=True, indent=2, allow_nan=False)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        pending.replace(directory/'identity.json')
    finally:
        if pending is not None:
            pending.unlink(missing_ok=True)


def configure_cache(directory, record, fps, *, mode='on', estimate_only=False):
    """Cache storage is optional; required output-file errors remain fatal."""
    reset_invocation()
    if mode not in ('on', 'off'):
        raise ValueError('Scene cache must be on or off.')
    for name in ('FLIGHT_SCENE_DIR','FLIGHT_SCENE_KEY','FLIGHT_SCENE_FPS'):
        os.environ.pop(name, None)
    os.environ['FLIGHT_SCENE_CACHE'] = 'off'
    result = {'requested':mode, 'enabled':False, 'key':record['key'],
              'directory':str(directory), 'schema_version':record['record']['schema_version'],
              'stage':'linear HDR with aircraft and foreground extinction, before exposure and graphics'}
    if mode == 'off':
        return result
    if not estimate_only:
        try:
            initialize(directory, record)
        except OSError as error:
            _storage_failure(error)
            result['storage_error'] = str(error)
            return result
    os.environ.update(FLIGHT_SCENE_CACHE='on', FLIGHT_SCENE_DIR=str(directory),
                      FLIGHT_SCENE_KEY=record['key'], FLIGHT_SCENE_FPS=str(fps))
    result['enabled'] = True
    return result


@contextmanager
def _frame_lock(directory, tick):
    """Try to serialize a missing frame; cache I/O cannot discard valid work."""
    path = _path(directory, tick)
    handle = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        # Never unlink this stable inode: later writers must use the same lock.
        handle = path.with_suffix('.lock').open('a+b')
        if os.name == 'nt':
            import msvcrt
            if handle.tell() == 0:
                handle.write(b'\0'); handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
    except OSError as error:
        if handle is not None:
            try:
                handle.close()
            except OSError:
                pass
        _storage_failure(error)
        yield False
        return
    # Keep the renderer's body outside the acquisition catch. Its own OSError
    # (e.g. missing input assets) must propagate without rerunning or masking it.
    try:
        yield True
    finally:
        try:
            handle.close()
        except OSError as error:
            _storage_failure(error)

def configured():
    if os.environ.get('FLIGHT_SCENE_CACHE', 'on') == 'off':
        return None
    directory, key = os.environ.get('FLIGHT_SCENE_DIR'), os.environ.get('FLIGHT_SCENE_KEY')
    if not directory or not key:
        return None
    fps = float(os.environ['FLIGHT_SCENE_FPS'])
    if not math.isfinite(fps) or fps <= 0:
        raise ValueError('Scene cache frame rate must be positive.')
    return Path(directory), key, fps



def _file_stamp(path):
    try:
        stat = path.stat()
        return (stat.st_dev,stat.st_ino,stat.st_size,stat.st_mtime_ns,stat.st_ctime_ns)
    except OSError:
        return None


def _valid_for_planning(directory, key, tick, t):
    """Reuse a full validation only while the same file revision is unchanged.

    Store booleans/stat tuples, never pixel arrays. The renderer always calls
    load_scene again; this memo is only for preparation and budget planning.
    """
    path = _path(directory, tick)
    before = _file_stamp(path)
    if before is None:
        return False
    memo_key = (str(path.absolute()),key,tick,t,before,RADIANCE_SHAPE,COVERAGE_SHAPE)
    if memo_key in _VALIDATED:
        _VALIDATED.move_to_end(memo_key)
        return _VALIDATED[memo_key]
    valid = load_scene(directory,key,tick,t) is not None
    if _file_stamp(path) != before:
        return False  # A concurrent replacement needs a fresh full validation.
    _VALIDATED[memo_key] = valid
    if len(_VALIDATED) > _VALIDATION_LIMIT:
        _VALIDATED.popitem(last=False)
    return valid

def missing_frames(ticks, *, trip=None):
    """Bounded-memory validation used to skip unnecessary aircraft preparation."""
    setup = configured()
    if setup is None:
        return list(ticks)
    directory, key, fps = setup
    if trip is not None:
        # Helpers may be called outside configure. A leftover process environment
        # must not suppress preparation for a different physical itinerary.
        try:
            record = json.loads((directory/'identity.json').read_text())
            if (fps != trip.fps or record.get('key') != key
                    or record['record']['trip'] != physical_trip(trip)):
                return list(ticks)
        except (OSError, ValueError, TypeError, KeyError):
            return list(ticks)
    missing = []
    for tick in ticks:
        if not _valid_for_planning(directory, key, tick, tick/fps):
            missing.append(tick)
    return missing


def cached_scene(t, compute):
    """Cache exact output-frame instants; arbitrary interactive times bypass it."""
    global _LAST_EVENT
    _LAST_EVENT = {'status': 'disabled'}
    setup = configured()
    if setup is None:
        return compute()
    directory, key, fps = setup
    tick = round(t*fps)
    if tick < 0 or t != tick/fps:
        _LAST_EVENT = {'status': 'non-frame-time'}
        return compute()
    result = load_scene(directory, key, tick, t)
    if result is not None:
        _LAST_EVENT = {'status': 'hit', 'key': key, 'frame': tick}
        return result
    if _WRITES_FAILED:
        result = compute()
        _LAST_EVENT = {'status':'miss', 'key':key, 'frame':tick, 'storage':'unavailable'}
        return result
    with _frame_lock(directory, tick) as writable:
        if not writable:
            result = compute()
            _LAST_EVENT = {'status':'miss', 'key':key, 'frame':tick, 'storage':'unavailable'}
            return result
        result = load_scene(directory, key, tick, t)
        if result is not None:
            _LAST_EVENT = {'status': 'hit', 'key': key, 'frame': tick}
            return result
        result = compute()
        try:
            store_scene(directory, key, tick, t, *result)
        except OSError as error:
            _storage_failure(error)
            _LAST_EVENT = {'status':'miss', 'key':key, 'frame':tick, 'storage':'failed'}
        else:
            _LAST_EVENT = {'status':'miss', 'key':key, 'frame':tick, 'storage':'stored'}
        return result


def last_event():
    return dict(_LAST_EVENT or {'status': 'not-requested'})
