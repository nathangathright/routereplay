"""Wind advection and pressure-derived GFS cloud-profile sampling.

Hourly wind states are linearly interpolated. Cloud states are independently
transported toward the requested time, then blended, reproducing exact forecast
endpoints. Spherical great-circle displacements avoid dateline/pole artifacts.
Constant local wind during each short trace is an approximation; model states
re-anchor the motion every hour (layer cover) or3h (vertical profiles).
"""

from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

import numpy as np
from scipy.ndimage import map_coordinates, gaussian_filter

from runtime import ASSETS, WEATHER
ROOT = ASSETS / 'weather'
INIT = datetime.fromisoformat(WEATHER['initialization']).timestamp() if WEATHER else 0
# Procedural material has no observed initial state. Anchor it at the verified
# common coverage start, which may be hours after model initialization.
MATERIAL_REFERENCE = datetime.fromisoformat(WEATHER['valid_start']).timestamp() if WEATHER else 0
VALID_END = datetime.fromisoformat(WEATHER['valid_end']).timestamp() if WEATHER else float('inf')
PROFILE_HOURS = np.array(WEATHER['profile_hours'] if WEATHER else [], dtype=int)
PROFILE_TIMES = INIT + PROFILE_HOURS * 3600
EARTH_M = 6_371_000.0


def timestamp(dt):
    return dt.timestamp() if hasattr(dt, 'timestamp') else float(dt)


def time_pair(times, stamp):
    if len(times) < 2:
        raise ValueError('Weather interpolation requires at least two timestamps')
    index = int(np.clip(np.searchsorted(times, stamp) - 1, 0, len(times) - 2))
    fraction = float(np.clip((stamp - times[index]) / (times[index + 1] - times[index]), 0, 1))
    return index, fraction


@lru_cache(maxsize=1)
def _winds():
    with np.load(ROOT / 'cloud-winds.npz') as data:
        values = tuple(data[key].copy() for key in ('u', 'v', 'timestamps', 'representative_heights_m'))
    for value in values: value.setflags(write=False)
    return values


@lru_cache(maxsize=16)
def _wind_slice(component,index):
    # Prepared bundles store float16; scipy interpolation requires float32.
    # Retain a few immutable slices rather than expanding the whole forecast.
    value=np.asarray(_winds()[component][index],np.float32)
    value.setflags(write=False)
    return value


@lru_cache(maxsize=1)
def _wind_state(stamp):
    u, v, times, heights = _winds()
    index, fraction = time_pair(times, stamp)
    return (np.asarray(u[index], np.float32) * (1 - fraction) + np.asarray(u[index + 1], np.float32) * fraction,
            np.asarray(v[index], np.float32) * (1 - fraction) + np.asarray(v[index + 1], np.float32) * fraction,
            heights)


def sample_wind(lon, lat, altitude_m, dt):
    lon, lat, altitude_m = np.broadcast_arrays(lon, lat, altitude_m)
    u, v, times, heights = _winds()
    index, fraction = time_pair(times, timestamp(dt))
    coords = np.array([np.interp(np.ravel(altitude_m), heights, np.arange(len(heights))),
                       np.clip((90 - np.degrees(np.ravel(lat))) * 2, 0, 360),
                       (np.degrees(np.ravel(lon)) % 360) * 2], np.float32)
    # Interpolate the sampled values, not whole global arrays for each RK stage.
    # This is mathematically equivalent and avoids large temporary wind grids.
    return tuple(map_coordinates(_wind_slice(component,index), coords, order=1, mode='grid-wrap', prefilter=False) * (1-fraction)
                 + map_coordinates(_wind_slice(component,index+1), coords, order=1, mode='grid-wrap', prefilter=False) * fraction
                 for component in (0,1))


def _displace(lon, lat, u, v, seconds):
    lon, lat = np.asarray(lon, np.float64), np.asarray(lat, np.float64)
    speed = np.hypot(u, v)
    angle = speed * seconds / EARTH_M
    east, north = u / np.maximum(speed, 1e-8), v / np.maximum(speed, 1e-8)
    sl, cl, sa, ca = np.sin(lat), np.cos(lat), np.sin(angle), np.cos(angle)
    so, co = np.sin(lon), np.cos(lon)
    # Cartesian tangent-vector rotation remains well defined at either pole;
    # the direct latitude/longitude destination formula has a0/0 there.
    x = cl * co * ca + (-east * so - north * sl * co) * sa
    y = cl * so * ca + (east * co - north * sl * so) * sa
    z = sl * ca + north * cl * sa
    return np.arctan2(y, x).astype(np.float32), np.arcsin(np.clip(z, -1, 1)).astype(np.float32)


def backtrace_coordinates(lon, lat, altitude_m, dt, reference=None,
                          max_step_seconds=3600., max_steps=64, wind_sampler=None):
    """Material coordinates at a fixed epoch, traced through the actual wind.

    Midpoint spherical integration is deterministic, with no mutable previous
    frame state. The default reference is the bundle's verified valid_start,
    an arbitrary procedural seed epoch shared by every frame and ray type;
    zero wind leaves Earth-fixed detail fixed. This reconstructs motion, not
    observed individual cloud evolution. One-hour target steps are capped at
    64 for long forecast spans; these spans use coarser integration explicitly.
    """
    sampler = sample_wind if wind_sampler is None else wind_sampler
    lon, lat, altitude_m = np.broadcast_arrays(lon, lat, altitude_m)
    lo, la, height = lon.ravel().copy(), lat.ravel().copy(), altitude_m.ravel()
    stamp = timestamp(dt)
    if reference is None:
        if not MATERIAL_REFERENCE <= stamp <= VALID_END:
            raise ValueError('Cloud material time lies outside verified weather coverage')
        target = MATERIAL_REFERENCE
    else:
        # Explicit references support pure synthetic wind/transport diagnostics.
        target = timestamp(reference)
    if max_step_seconds <= 0 or max_steps < 1:
        raise ValueError('Advection integration step and step budget must be positive')
    if stamp == target:
        return lo.astype(np.float32), la.astype(np.float32)
    count = max(1, int(np.ceil(abs(target-stamp)/max_step_seconds)))
    if count > max_steps:
        boundaries = np.linspace(stamp, target, int(max_steps)+1)
    else:
        # Epoch-anchored steps avoid changing every previous integration
        # interval when the requested frame crosses an hour boundary.
        sign = 1 if stamp > target else -1
        boundaries = np.r_[stamp, target+sign*np.arange(count-1,-1,-1)*max_step_seconds]
    point = np.stack([np.cos(la)*np.cos(lo),np.cos(la)*np.sin(lo),np.sin(la)],axis=-1)
    def angles(value):
        return np.arctan2(value[:,1],value[:,0]), np.arcsin(np.clip(value[:,2],-1,1))
    def velocity(x,y,u,v):
        return np.stack([-u*np.sin(x)-v*np.sin(y)*np.cos(x),
                         u*np.cos(x)-v*np.sin(y)*np.sin(x),v*np.cos(y)],axis=-1)/EARTH_M
    for moment,end in zip(boundaries[:-1],boundaries[1:]):
        step = end-moment
        lo,la=angles(point)
        u,v=sampler(lo,la,height,moment)
        middle=point+.5*step*velocity(lo,la,u,v)
        middle/=np.linalg.norm(middle,axis=-1,keepdims=True)
        ml,ma=angles(middle)
        u,v=sampler(ml,ma,height,moment+.5*step)
        # The second-stage vector must use the midpoint's geographic basis;
        # reusing its east/north components at the initial point causes drift.
        point+=step*velocity(ml,ma,u,v)
        point/=np.linalg.norm(point,axis=-1,keepdims=True)
    return tuple(value.astype(np.float32) for value in angles(point))


def advected_coordinates(lon, lat, altitude_m, dt, earlier, later, return_wind=False):
    lon, lat, altitude_m = np.broadcast_arrays(lon, lat, altitude_m)
    lon, lat, altitude_m = lon.ravel(), lat.ravel(), altitude_m.ravel()
    stamp = timestamp(dt)
    u, v = sample_wind(lon, lat, altitude_m, stamp)
    coordinates = (_displace(lon, lat, u, v, float(earlier) - stamp),
                   _displace(lon, lat, u, v, float(later) - stamp))
    return (coordinates, (u, v)) if return_wind else coordinates


@lru_cache(maxsize=2)
def _profile(hour):
    with np.load(ROOT / f'cloud-profile-f{hour:03d}.npz') as data:
        fields = {key: np.asarray(data[key], np.float32) for key in ('extinction', 'coverage', 'ice_fraction', 'tau_above')}
    # A half-cell horizontal reconstruction filter suppresses pressure-grid
    # plateaus at very close perspective zoom. Hourly0.25° cover restores the
    # finer extent; no extra cloud is introduced outside that occupancy mask.
    for key in ('extinction', 'tau_above'):
        fields[key] = gaussian_filter(fields[key], sigma=(0, .55, .55), mode=('nearest', 'nearest', 'wrap'))
    for field in fields.values(): field.setflags(write=False)
    return fields


def sample_profile(lon, lat, altitude_m, dt, fields=('extinction',), advect=True, return_wind=False):
    """Return requested forecast-derived fields, each flattened to N values.

    Extinction has units1/m and includes the documented assumed particle sizes.
    It is not measured opacity. Height planes come from actual GFS HGT profiles.
    """
    lon, lat, altitude_m = np.broadcast_arrays(lon, lat, altitude_m)
    lon, lat, altitude_m = lon.ravel(), lat.ravel(), altitude_m.ravel()
    stamp = float(np.clip(timestamp(dt), PROFILE_TIMES[0], PROFILE_TIMES[-1]))
    index, fraction = time_pair(PROFILE_TIMES, stamp)
    before, after = _profile(int(PROFILE_HOURS[index])), _profile(int(PROFILE_HOURS[index + 1]))
    if advect:
        coordinates, wind = advected_coordinates(lon, lat, altitude_m, stamp,
                                                 PROFILE_TIMES[index], PROFILE_TIMES[index + 1], True)
    else:
        coordinates, wind = ((lon, lat), (lon, lat)), (np.zeros_like(lon), np.zeros_like(lat))
    sampled = []
    for lo, la in coordinates:
        sampled.append(np.array([np.clip(altitude_m / 1000, 0, 16),
                                 np.clip((90 - np.degrees(la)) * 2, 0, 360),
                                 (np.degrees(lo) % 360) * 2], np.float32))
    support = ((altitude_m >= 0) & (altitude_m <= 16000)).astype(np.float32)
    results = []
    for field in fields:
        a = map_coordinates(before[field], sampled[0], order=1, mode='grid-wrap', prefilter=False)
        b = map_coordinates(after[field], sampled[1], order=1, mode='grid-wrap', prefilter=False)
        results.append(np.maximum(0, a * (1 - fraction) + b * fraction) * support)
    return (tuple(results), wind) if return_wind else tuple(results)
