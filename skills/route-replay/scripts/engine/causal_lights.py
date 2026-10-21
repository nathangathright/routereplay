"""Chronological unresolved photocell populations with immutable frame sampling.

A bounded global grid stores two uint8 activation fractions per requested UTC
sample, never a full image per frame. Workers share read-only memory maps. The
solver advances on physical time, including layovers; render order has no role.
Long unobserved gaps use a new 24-hour warmup. At persistent polar twilight the
initial relay state remains an explicit unobserved prior, not historical data.
"""
from datetime import datetime, timezone
import json
from pathlib import Path

import numpy as np
from scipy.ndimage import map_coordinates

from citylight_model import clear_sky_illuminance
from citypopulations import regional_populations, utc_timestamp

MODEL_VERSION = 1
DEFAULT_MAX_STORAGE = 256 * 1024 * 1024


class RelayPopulation:
    """Many fixed threshold relays, each retaining state within its deadband."""
    def __init__(self, threshold_factor, bins=32):
        factor = np.asarray(threshold_factor, np.float32).ravel()
        if bins < 2 or np.any(factor <= 0) or not np.all(np.isfinite(factor)):
            raise ValueError('Relay populations need positive finite thresholds and at least two bins.')
        quantile = (np.arange(bins) + .5) / bins
        # Logistic quantiles reproduce the previous unresolved spread while
        # giving each threshold a real, persistent hysteresis state.
        spread = np.log(quantile / (1 - quantile))
        self.on = factor[:, None, None] * np.array([16.1, 100.])[None, :, None] * (
            10 ** (np.array([.16, .28])[None, :, None] * spread))
        self.off = self.on * np.array([3., 1.8])[None, :, None]
        self.state = np.zeros(self.on.shape, bool)
        self.initialized = False

    def step(self, illuminance):
        lux = np.asarray(illuminance, np.float64).reshape((-1, 1, 1))
        if lux.shape[0] != self.state.shape[0] or np.any(lux < 0) or not np.all(np.isfinite(lux)):
            raise ValueError('Sensor illuminance must be finite, nonnegative and match the relay grid.')
        if not self.initialized:
            self.state[:] = lux < self.on
            self.initialized = True
        else:
            self.state[:] = np.where(lux <= self.on, True, np.where(lux >= self.off, False, self.state))
        return self.state.mean(axis=-1, dtype=np.float32)


def _grid(degrees):
    nlon = max(8, int(np.ceil(360 / degrees)))
    nlat = max(5, int(np.ceil(180 / degrees)) + 1)
    lon, lat = np.meshgrid(np.linspace(-np.pi, np.pi, nlon, endpoint=False),
                           np.linspace(-np.pi/2, np.pi/2, nlat))
    # A pole has one geographic position; arbitrary longitude must not seed
    # weather, population priors or a different relay state there.
    lon[[0, -1]] = 0
    return lon, lat


def build_lamp_timeline(physical_times, solar_cosine, *, sensor_transmission=None,
                        weather_time=None, grid_degrees=2., max_step_seconds=300.,
                        warmup_hours=24., gap_restart_hours=48., output_dir=None,
                        max_storage_bytes=DEFAULT_MAX_STORAGE):
    """Solve before rendering; callbacks receive flattened radian grid and UTC.

    ``solar_cosine(lon,lat,physical_dt)`` provides geometric lighting.
    ``sensor_transmission(lon,lat,weather_dt)`` is an ambient sky estimate, not
    a direct-sun shadow. All exact requested physical times should be included.
    Requests between prepared times use their previous state, never look ahead.
    The 5-minute limit bounds integration work between actual frame samples;
    it does not stretch a seconds-long hardware relay delay into a film fade.
    """
    times = np.unique([utc_timestamp(dt) for dt in physical_times]).astype(np.float64)
    if not len(times):
        raise ValueError('Prepare at least one physical lamp timestamp.')
    if (not np.isfinite(grid_degrees) or not 0 < grid_degrees <= 45 or
            not 0 < max_step_seconds <= 300 or not 0 < warmup_hours <= gap_restart_hours):
        raise ValueError('Use a positive grid, at most 300-second integration steps and valid warmup/gap limits.')
    degrees = float(grid_degrees)
    lon, lat = _grid(degrees)
    while len(times) * lon.size * 2 > max_storage_bytes:
        degrees *= 2
        if degrees > 45:
            raise ValueError('Too many lamp samples for the bounded state cache.')
        lon, lat = _grid(degrees)
    warmup = warmup_hours * 3600
    # Validate calendar coverage before opening a potentially large cache file.
    try:
        datetime.fromtimestamp(times[0] - warmup, timezone.utc)
        datetime.fromtimestamp(times[-1], timezone.utc)
    except (ValueError, OverflowError, OSError) as exc:
        raise ValueError('Lamp dates must allow a complete warmup before the first frame.') from exc
    shape = (len(times), 2, *lon.shape)
    directory = Path(output_dir) if output_dir is not None else None
    if directory:
        directory.mkdir(parents=True, exist_ok=True)
        state_path = directory / 'state.pending.npy'
        snapshots = np.lib.format.open_memmap(state_path, mode='w+', dtype=np.uint8, shape=shape)
    else:
        snapshots = np.empty(shape, dtype=np.uint8)
    flat_lon, flat_lat = lon.ravel(), lat.ravel()
    priors = regional_populations(flat_lon, flat_lat)
    relays = RelayPopulation(priors['threshold_factor'])
    cursor = times[0] - warmup
    restarts, steps = [], 0

    def advance(stamp):
        nonlocal steps
        when = datetime.fromtimestamp(float(stamp), timezone.utc)
        sun = np.broadcast_to(solar_cosine(flat_lon, flat_lat, when), flat_lon.shape)
        lux = clear_sky_illuminance(sun)
        if sensor_transmission is not None:
            weather_dt = weather_time(when) if weather_time is not None else when
            transmission = np.broadcast_to(sensor_transmission(flat_lon, flat_lat, weather_dt), flat_lon.shape)
            if not np.all(np.isfinite(transmission)) or np.any((transmission < 0) | (transmission > 1)):
                raise ValueError('Ambient sensor transmission must be finite and lie in [0, 1].')
            lux = lux * transmission
        steps += 1
        return relays.step(lux)

    activation = advance(cursor)
    for index, target in enumerate(times):
        if target - cursor > gap_restart_hours * 3600:
            cursor = target - warmup
            relays = RelayPopulation(priors['threshold_factor'])
            restarts.append(float(target))
            activation = advance(cursor)
        while cursor < target:
            cursor = min(float(target), cursor + max_step_seconds)
            activation = advance(cursor)
        snapshots[index] = np.rint(255 * activation.T.reshape((2, *lon.shape))).astype(np.uint8)
    metadata = {'model_version': MODEL_VERSION, 'grid_shape': list(lon.shape),
                'requested_grid_degrees': grid_degrees, 'effective_grid_degrees': degrees,
                'sample_count': len(times), 'first_utc': datetime.fromtimestamp(times[0], timezone.utc).isoformat(),
                'last_utc': datetime.fromtimestamp(times[-1], timezone.utc).isoformat(),
                'state_bytes': int(snapshots.nbytes), 'integration_steps': steps,
                'maximum_internal_step_seconds': max_step_seconds, 'relay_bins_per_population': 32,
                'warmup_hours': warmup_hours, 'gap_restart_hours': gap_restart_hours,
                'gap_restart_count': len(restarts), 'cloud_darkened_sensor': sensor_transmission is not None,
                'schedule_policy': 'mean_solar_time_no_dst',
                'sampling': 'Exact requested physical UTCs; previous state for unprepared intermediate UTCs.',
                'limitations': [
                    '2016 grayscale source is historical display imagery, not calibrated radiance or measured CCT.',
                    'Regional fixture mixtures, shares, spectra, schedules and curfews are modeled priors.',
                    'Mean solar time is not authoritative local civil time; no DST or political time-zone boundaries.',
                    'Cloud sensor lux is a bounded ambient estimate, not measured illuminance or direct-sun shadow.',
                    'Sub-step weather changes and seconds-long hardware relay delays are unresolved.',
                    'Initial polar twilight relay state is uncertain; long unobserved gaps restart with 24-hour warmup.',
                    'Grid may coarsen to bound storage; no light is created outside the source texture.']}
    if directory:
        snapshots.flush()
        del snapshots
        state_path.replace(directory / 'state.npy')
        np.save(directory / 'times.npy', times)
        temporary = directory / 'metadata.pending.json'
        temporary.write_text(json.dumps(metadata, indent=2, allow_nan=False) + '\n')
        temporary.replace(directory / 'metadata.json')
        return LampTimeline.load(directory)
    snapshots.flags.writeable = False
    times.flags.writeable = False
    return LampTimeline(times, snapshots, metadata)


class LampTimeline:
    def __init__(self, times, states, metadata):
        self.times, self.states, self.metadata = times, states, metadata
        self.times.flags.writeable = False
        self.states.flags.writeable = False
        if (times.ndim != 1 or not len(times) or np.any(np.diff(times) <= 0) or
                states.shape != (len(times), 2, *metadata['grid_shape']) or
                states.dtype != np.uint8 or not np.all(np.isfinite(times))):
            raise ValueError('Invalid immutable lamp timeline.')

    @classmethod
    def load(cls, directory):
        directory = Path(directory)
        metadata = json.loads((directory / 'metadata.json').read_text())
        if metadata['model_version'] != MODEL_VERSION:
            raise ValueError('Lamp timeline version does not match this renderer.')
        return cls(np.load(directory / 'times.npy', mmap_mode='r'),
                   np.load(directory / 'state.npy', mmap_mode='r'), metadata)

    def sample(self, lon, lat, physical_dt):
        stamp = utc_timestamp(physical_dt)
        if stamp < self.times[0] - 1e-6 or stamp > self.times[-1] + 1e-6:
            raise ValueError('Physical lamp time lies outside the prepared timeline.')
        lon, lat = np.broadcast_arrays(lon, lat)
        if not np.all(np.isfinite(lon)) or not np.all(np.isfinite(lat)) or np.any(np.abs(lat) > np.pi/2 + 1e-8):
            raise ValueError('Lamp coordinates must be finite with latitude in [-pi/2, pi/2].')
        index = max(0, int(np.searchsorted(self.times, stamp + 1e-6, side='right') - 1))
        nlat, nlon = self.states.shape[-2:]
        coordinates = np.array([np.clip((lat.ravel() / np.pi + .5) * (nlat - 1), 0, nlat - 1),
                                ((lon.ravel() / (2 * np.pi) + .5) * nlon) % nlon])
        samples = [map_coordinates(self.states[index, component], coordinates, output=np.float32,
                                   order=1, mode='grid-wrap', prefilter=False) / 255
                   for component in range(2)]
        return np.stack(samples, axis=-1).reshape(lon.shape + (2,))
