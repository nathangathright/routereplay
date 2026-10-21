"""Sample the selected GFS run's instantaneous low/middle/high cloud forecast.

Coordinates are geographic longitude/latitude in radians. Sampling is bilinear
on the model's0.25-degree grid. Hourly states are advected with layer-specific
forecast winds and blended between valid times. Longitude
wraps at the dateline; latitude is clamped at the poles. Times outside the cached
forecast range clamp to the closest field. The itinerary is entirely in range.
"""

from functools import lru_cache
from pathlib import Path

import numpy as np
from scipy.ndimage import map_coordinates, gaussian_filter
from weatherfields import advected_coordinates, PROFILE_HOURS, PROFILE_TIMES, sample_wind, _displace, timestamp

from runtime import ASSETS
LAYER_NAMES = ('low', 'middle', 'high')


@lru_cache(maxsize=1)
def _forecast():
    with np.load(ASSETS / 'weather' / 'cloud-layers.npz') as data:
        values = data['coverage'].copy(), data['timestamps'].copy()
    for value in values: value.setflags(write=False)
    return values


def _coordinates(lon, lat):
    lon, lat = np.broadcast_arrays(np.asarray(lon), np.asarray(lat))
    return np.array([np.clip((90 - np.degrees(lat.ravel())) * 4, 0, 720),
                     (np.degrees(lon.ravel()) % 360) * 4], dtype=np.float32)


def _time(dt, times):
    stamp = dt.timestamp() if hasattr(dt, 'timestamp') else float(dt)
    index = int(np.clip(np.searchsorted(times, stamp) - 1, 0, len(times) - 2))
    amount = float(np.clip((stamp - times[index]) / (times[index + 1] - times[index]), 0, 1))
    return index, amount


def _sample(coverage, coordinates, index, amount, layer):
    before = map_coordinates(_float_field(index, layer), coordinates[0], order=1,
                             mode='grid-wrap', prefilter=False)
    after = map_coordinates(_float_field(index + 1, layer), coordinates[1], order=1,
                            mode='grid-wrap', prefilter=False)
    return np.clip(before * (1 - amount) + after * amount, 0, 1)


@lru_cache(maxsize=6)
def _float_field(index, layer):
    coverage, _ = _forecast()
    value = gaussian_filter(np.asarray(coverage[index, layer], np.float32), .35, mode=('nearest', 'wrap'))
    value.setflags(write=False)
    return value


def _advected_coordinates(lon, lat, dt, times, index, layer):
    stamp = dt.timestamp() if hasattr(dt, 'timestamp') else float(dt)
    dt = float(np.clip(stamp, times[0], times[-1]))
    earlier, later = advected_coordinates(lon, lat, (1500, 5500, 10500)[layer],
                                          dt, times[index], times[index + 1])
    return _coordinates(*earlier), _coordinates(*later)


def sample_layers(lon, lat, dt):
    """Return Nx3 low/middle/high fractional cover at the specified positions."""
    coverage, times = _forecast()
    index, amount = _time(dt, times)
    return np.stack([_sample(coverage, _advected_coordinates(lon, lat, dt, times, index, layer), index, amount, layer)
                     for layer in range(3)], axis=-1)


def sample_layer(lon, lat, dt, layer):
    """Return N fractions for one layer (0/1/2 or 'low'/'middle'/'high').

    This avoids sampling all three fields when each elevated shell has its own
    geographic coordinates because of parallax or shadow projection.
    """
    if isinstance(layer, str):
        layer = LAYER_NAMES.index(layer)
    if layer not in (0, 1, 2):
        raise ValueError('Cloud layer must be 0, 1, 2, low, middle, or high')
    coverage, times = _forecast()
    index, amount = _time(dt, times)
    return _sample(coverage, _advected_coordinates(lon, lat, dt, times, index, layer), index, amount, layer)


@lru_cache(maxsize=2)
def _column_fields(hour):
    """Smooth column mass and mass-weighted height from the real GFS profiles."""
    with np.load(ASSETS / 'weather' / f'cloud-profile-f{hour:03d}.npz') as data:
        tau=np.asarray(data['column_tau'],np.float32)
        moment=tau*np.asarray(data['column_height'],np.float32)
    values = tuple(gaussian_filter(field,(0,.65,.65),mode=('nearest','nearest','wrap'))
                   for field in (tau,moment))
    for value in values: value.setflags(write=False)
    return values

def sample_column(lon,lat,dt,layer):
    """Return cloud optical mass and physical mean height for a profile band.

    Mass comes from GFS condensate and the documented assumed particle sizes.
    This helper does not apply the cinematic renderer's opacity scale or shape.
    Heights are interpolated by mass so empty neighboring columns do not drag
    actual cloud layers toward an arbitrary default altitude.
    """
    stamp=dt.timestamp() if hasattr(dt,'timestamp') else float(dt)
    stamp=float(np.clip(stamp,PROFILE_TIMES[0],PROFILE_TIMES[-1]))
    index,amount=_time(stamp,PROFILE_TIMES)
    states=(_column_fields(int(PROFILE_HOURS[index])),_column_fields(int(PROFILE_HOURS[index+1])))
    coords=advected_coordinates(lon,lat,(1500,5500,10500)[layer],stamp,
                               PROFILE_TIMES[index],PROFILE_TIMES[index+1])
    sampled=[]
    for (lo,la),fields in zip(coords,states):
        positions=np.array([np.clip((90-np.degrees(np.ravel(la)))*2,0,360),
                            (np.degrees(np.ravel(lo))%360)*2],np.float32)
        sampled.append([map_coordinates(field[layer],positions,order=1,mode='grid-wrap',prefilter=False)
                        for field in fields])
    tau=sampled[0][0]*(1-amount)+sampled[1][0]*amount
    moment=sampled[0][1]*(1-amount)+sampled[1][1]*amount
    height=np.where(tau>1e-6,moment/np.maximum(tau,1e-6),(1500,5500,12000)[layer])
    return np.maximum(tau,0),height


def sample_layer_fields(lon, lat, dt, layer):
    """Coverage, column mass and centroid with a shared local wind sample.

    Coverage and condensate retain their different source time grids. Sharing
    wind and coordinate reconstruction keeps their motion coherent and avoids
    repeatedly interpolating wind when preparing a frame's density field.
    """
    coverage, times = _forecast()
    stamp = timestamp(dt)
    lo, la = np.broadcast_arrays(lon, lat)
    lo, la = lo.ravel(), la.ravel()
    u, v = sample_wind(lo, la, (1500, 5500, 10500)[layer], stamp)
    cover_stamp = float(np.clip(stamp, times[0], times[-1]))
    ci, ca = _time(cover_stamp, times)
    cc = tuple(_coordinates(*_displace(lo, la, u, v, float(t)-cover_stamp))
               for t in times[ci:ci+2])
    cover = _sample(coverage, cc, ci, ca, layer)
    profile_stamp = float(np.clip(stamp, PROFILE_TIMES[0], PROFILE_TIMES[-1]))
    pi, pa = _time(profile_stamp, PROFILE_TIMES)
    sampled = []
    for index in (pi, pi+1):
        x, y = _displace(lo, la, u, v, float(PROFILE_TIMES[index])-profile_stamp)
        coords = np.array([np.clip((90-np.degrees(y))*2, 0, 360), (np.degrees(x)%360)*2], np.float32)
        sampled.append([map_coordinates(field[layer], coords, order=1, mode='grid-wrap', prefilter=False)
                        for field in _column_fields(int(PROFILE_HOURS[index]))])
    tau = sampled[0][0]*(1-pa)+sampled[1][0]*pa
    moment = sampled[0][1]*(1-pa)+sampled[1][1]*pa
    height = np.where(tau>1e-6, moment/np.maximum(tau,1e-6), (1500,5500,12000)[layer])
    return cover, np.maximum(tau,0), height
