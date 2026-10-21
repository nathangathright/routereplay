#!/usr/bin/env python3
"""Prepare an explicitly selected NOAA GFS run for a portable static bundle.

Use --plan to inspect the exact forecast hours and bounded GRIB record count.
No run is selected automatically; unavailable/out-of-range data fails. NumPy and
ECMWF ecCodes are required only for actual conversion, not --help or --plan.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path

from data import attach_weather, read_bundle, utc, write_json
from gfs_archive import DownloadCache, GFSArchive, PROVIDERS, provider_spec

PRESSURES_HPA = [1000, 925, 850, 700, 500, 350, 250, 150]
WIND_PRESSURES_HPA = [850, 500, 250]
LAYERS = [('LCDC', 'low cloud layer'), ('MCDC', 'middle cloud layer'), ('HCDC', 'high cloud layer')]
# Assigned only by main after planning and dependency checks.
INIT = DEST = ALTITUDES_M = np = eccodes = ARCHIVE = None


def plan(initialization, start, end, provider="nodd-0p25"):
    init, start, end = utc(initialization), utc(start), utc(end)
    if init.hour not in (0, 6, 12, 18) or init.minute or init.second or init.microsecond:
        raise ValueError('GFS initialization must be 00, 06, 12, or 18 UTC exactly')
    spec = provider_spec(provider, init)
    if start >= end or start < init or end > init + timedelta(hours=spec['max_hour']):
        raise ValueError(f"Requested interval must lie inside {provider}'s run (initialization through +{spec['max_hour']}h)")
    hours = spec['hours']
    profiles = list(range(0, spec['max_hour']+1, 3))
    lower, upper = (start-init).total_seconds()/3600, (end-init).total_seconds()/3600
    def bracket(available):
        left = max(i for i, h in enumerate(available) if h <= lower)
        right = min(i for i, h in enumerate(available) if h >= upper)
        # Two states are needed by every renderer interpolation path.
        if left == right:
            right = min(len(available)-1, right+1)
            left = max(0, right-1)
        return available[left:right+1]
    regular, profile = bracket(hours), bracket(profiles)
    return {'initialization': init.isoformat(), 'requested_start': start.isoformat(),
            'requested_end': end.isoformat(), 'layer_hours': regular, 'wind_hours': regular,
            'profile_hours': profile, 'bounded_grib_records': len(regular)*9+len(profile)*40,
            'source_mode': 'forecast', 'provider': provider, 'data_kind': spec['data_kind'],
            'source_grid_degrees': spec['grid_degrees'], 'documentation_url': spec['documentation_url'],
            'availability_note': spec['availability_note'],
            'available_on_server': 'not checked; use --check-availability to validate exact inventories'}


def record(hour, variable, level, prefix, half_resolution=True):
    path, archive_meta = ARCHIVE.get_record(hour, variable, level)
    url = archive_meta['source_url']
    start, end = archive_meta['byte_range']
    level_text = f'{level} mb' if isinstance(level, int) else level
    filename = path.name
    spec = ARCHIVE.spec
    with path.open('rb') as handle:
        message = eccodes.codes_grib_new_from_file(handle)
        if message is None:
            raise ValueError(f'Cannot decode {path.name}')
        try:
            get = lambda key: eccodes.codes_get(message, key)
            expected = INIT + timedelta(hours=hour)
            checks = {'dataDate': int(INIT.strftime('%Y%m%d')), 'dataTime': INIT.hour*100,
                      'validityDate': int(expected.strftime('%Y%m%d')), 'validityTime': int(expected.strftime('%H%M')),
                      'stepType': 'instant', 'startStep': hour, 'endStep': hour, 'Ni': spec['ni'], 'Nj': spec['nj'],
                      'gridType': 'regular_ll', 'iDirectionIncrementInDegrees': spec['grid_degrees'],
                      'jDirectionIncrementInDegrees': spec['grid_degrees'],
                      'latitudeOfFirstGridPointInDegrees': 90, 'longitudeOfFirstGridPointInDegrees': 0,
                      'longitudeOfLastGridPointInDegrees': 360-spec['grid_degrees'],
                      'latitudeOfLastGridPointInDegrees': -90, 'jScansPositively': 0,
                      'iScansNegatively': 0, 'jPointsAreConsecutive': 0, 'numberOfMissing': 0}
            for key, value in checks.items():
                if get(key) != value:
                    raise ValueError(f'Unexpected {key}={get(key)!r}, expected {value!r}: {filename}')
            values = eccodes.codes_get_values(message).reshape(spec['nj'], spec['ni']).astype(np.float32)
            if not np.isfinite(values).all():
                raise ValueError(f'Non-finite GFS values: {filename}')
            meta = {'variable': variable, 'source_level': level_text, 'name': get('name'), 'units': get('units'),
                    'forecast_hour': hour, 'valid_time': expected.isoformat(), 'source_url': url,
                    'index_record': archive_meta['index_record'], 'byte_range': [start, end], 'local_file': filename,
                    'sha256': archive_meta['sha256'], 'inventory_sha256': archive_meta['inventory_sha256'],
                    'retrieved_at': archive_meta['retrieved_at'],
                    'source_grid_degrees': spec['grid_degrees'],
                    'minimum': float(values.min()), 'maximum': float(values.max()), 'step_type': get('stepType')}
            if half_resolution and spec['grid_degrees'] == .25:
                values = values[::2, ::2].copy()
            return values, meta
        finally:
            eccodes.codes_release(message)


def layer_hour(hour):
    fields, metadata = [], []
    for variable, level in LAYERS:
        values, meta = record(hour, variable, level, 'layer', half_resolution=False)
        if values.min() < 0 or values.max() > 100.1:
            raise ValueError('Layer cloud cover is outside percent units')
        if ARCHIVE.spec['grid_degrees'] == .5:
            values = upsample_coverage(values)
        fields.append(np.clip(values/100, 0, 1).astype(np.float16))
        metadata.append(meta)
    print(f'Cloud layers f{hour:03d}: verified three instantaneous fields', flush=True)
    return np.stack(fields), metadata


def atomic_npz(path, **arrays):
    temporary = path.with_suffix('.tmp')
    with temporary.open('wb') as handle:
        np.savez_compressed(handle, **arrays)
    temporary.replace(path)


def wind_hour(hour):
    components, metadata = [], []
    for variable in ('UGRD', 'VGRD'):
        values = []
        for pressure in WIND_PRESSURES_HPA:
            array, meta = record(hour, variable, pressure, 'wind')
            values.append(array)
            metadata.append(meta)
        components.append(np.stack(values).astype(np.float16))
    print(f'Wind f{hour:03d}: verified six instantaneous fields', flush=True)
    return components, metadata


def profile_hour(hour):
    fields, metadata = {}, []
    for variable in ('HGT', 'TMP', 'TCDC', 'CLMR', 'ICMR'):
        values = []
        for pressure in PRESSURES_HPA:
            array, meta = record(hour, variable, pressure, 'profile')
            values.append(array)
            metadata.append(meta)
        fields[variable] = np.stack(values)
    height = fields['HGT']
    # Geopotential-to-geometric height correction is small, but easy to retain.
    height = 6_371_000 * height / (6_371_000 - height)
    if not np.all(np.diff(height, axis=0) > 0):
        raise ValueError('GFS pressure surfaces are not vertically ordered')
    pressure = np.asarray(PRESSURES_HPA, np.float32)[:, None, None] * 100
    density_air = pressure / (287.05 * np.maximum(fields['TMP'], 150))
    # Geometric-optics extinction, assuming effective radii of10µm liquid and
    #30µm ice. These radii are explicit visualization assumptions, not GFS data.
    extinction_liquid = np.maximum(fields['CLMR'], 0) * density_air * (3 / (2 * 1000 * 10e-6))
    extinction_ice = np.maximum(fields['ICMR'], 0) * density_air * (3 / (2 * 917 * 30e-6))
    extinction = extinction_liquid + extinction_ice
    coverage = np.clip(fields['TCDC'] / 100, 0, 1)
    ice_fraction = extinction_ice / np.maximum(extinction, 1e-10)
    # Preserve actual profiles while converting irregular pressure surfaces into
    # a compact regular-height volume for fast trilinear sampling while rendering.
    grids = {key: [] for key in ('extinction', 'coverage', 'ice_fraction')}
    rows, cols = np.indices(height.shape[1:])
    source = {'extinction': extinction, 'coverage': coverage, 'ice_fraction': ice_fraction}
    for altitude in ALTITUDES_M:
        index = np.clip(np.sum(height <= altitude, axis=0) - 1, 0, len(PRESSURES_HPA) - 2)
        bottom, top = height[index, rows, cols], height[index + 1, rows, cols]
        fraction = np.clip((altitude - bottom) / np.maximum(top - bottom, 1), 0, 1)
        # Fade beyond sampled end surfaces instead of extending cloud infinitely.
        support = np.clip((altitude - height[0] + 750) / 750, 0, 1)
        support *= np.clip((height[-1] + 1000 - altitude) / 1000, 0, 1)
        for key, values in source.items():
            a, b = values[index, rows, cols], values[index + 1, rows, cols]
            value = a * (1 - fraction) + b * fraction
            if key != 'ice_fraction':
                value *= support
            grids[key].append(value.astype(np.float16))
    arrays = {key: np.stack(value) for key, value in grids.items()}
    sigma = np.asarray(arrays['extinction'], np.float32)
    intervals = (sigma[:-1] + sigma[1:]) * 500
    above = np.zeros_like(sigma)
    above[:-1] = np.cumsum(intervals[::-1], axis=0)[::-1]
    arrays['tau_above'] = above.astype(np.float16)
    column_tau, column_height = [], []
    for first, last in ((0, 3), (3, 8), (8, 16)):
        height = ALTITUDES_M[first:last + 1, None, None]
        field = sigma[first:last + 1]
        tau = np.trapezoid(field, height, axis=0)
        centroid = np.trapezoid(field * height, height, axis=0) / np.maximum(tau, 1e-8)
        centroid = np.where(tau > 1e-7, centroid, (first + last) * 500)
        column_tau.append(tau.astype(np.float16))
        column_height.append(centroid.astype(np.float16))
    arrays['column_tau'] = np.stack(column_tau)
    arrays['column_height'] = np.stack(column_height)
    atomic_npz(DEST / f'cloud-profile-f{hour:03d}.npz',
               **arrays,
               altitudes_m=ALTITUDES_M,
               timestamp=np.float64((INIT + timedelta(hours=hour)).timestamp()))
    print(f'Profile f{hour:03d}: verified40 instantaneous fields; cached17 height planes', flush=True)
    return metadata


def upsample_coverage(values):
    """Bilinear 0.5° -> 0.25° reconstruction; periodic longitude, exact poles.

    Interpolation preserves original samples and introduces no new source detail.
    """
    if values.shape != (361, 720):
        raise ValueError('Expected a north-to-south 0.5-degree coverage grid')
    across = np.empty((361, 1440), dtype=np.float32)
    across[:, ::2] = values
    across[:, 1::2] = (values+np.roll(values, -1, axis=1))*.5
    result = np.empty((721, 1440), dtype=np.float32)
    result[::2] = across
    result[1::2] = (across[:-1]+across[1:])*.5
    return result


def main():
    global INIT, DEST, ALTITUDES_M, np, eccodes, ARCHIVE
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', required=True, help='Existing static bundle directory')
    parser.add_argument('--initialization', required=True, help='Explicit GFS model run, ISO date with UTC offset')
    parser.add_argument('--start', required=True, help='Required weather-clock start, including departure hold')
    parser.add_argument('--end', required=True, help='Required weather-clock end, including arrival hold')
    parser.add_argument('--provider', choices=PROVIDERS, default='nodd-0p25', help='Explicit NOAA provider; no automatic fallback')
    parser.add_argument('--work-directory', help='Optional converted dataset cache; defaults inside bundle')
    parser.add_argument('--cache-directory', help='Verified HTTP object cache; defaults inside bundle/downloads/http-cache')
    parser.add_argument('--max-download-mib', type=int, default=512, help='Network byte budget for this invocation')
    parser.add_argument('--offline', action='store_true', help='Use verified cached inventories/records only; never access network')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--plan', action='store_true', help='Print forecast hours/count without network or dependencies')
    mode.add_argument('--check-availability', action='store_true', help='Fetch/cache small inventories; report exact GRIB byte count')
    mode.add_argument('--download-only', action='store_true', help='Cache exact bounded GRIB records without converting or changing the bundle')
    args = parser.parse_args()
    try:
        schedule = plan(args.initialization, args.start, args.end, args.provider)
        if args.plan:
            print(json.dumps(schedule, indent=2))
            return
        # Conversion must have a usable destination before even small archive
        # inventories are requested. Standalone planning/acquisition can run
        # before the static bundle exists and intentionally skip this check.
        if not args.check_availability and not args.download_only:
            read_bundle(args.bundle)
        INIT = utc(args.initialization)
        if INIT > datetime.now(timezone.utc):
            raise ValueError('A future GFS initialization cannot be downloaded')
        bundle = Path(args.bundle).expanduser().resolve()
        cache_root = Path(args.cache_directory).expanduser().resolve() if args.cache_directory else bundle/'downloads'/'http-cache'
        cache = DownloadCache(cache_root, offline=args.offline, max_download_bytes=args.max_download_mib*1024*1024)
        ARCHIVE = GFSArchive(args.provider, INIT, cache)
        checked = ARCHIVE.preflight(schedule, require_cached=args.offline and not args.check_availability)
        summary = {k: v for k, v in checked.items() if k != 'records'}
        print(json.dumps({'availability': summary}, indent=2), flush=True)
        if args.check_availability:
            return
        if checked['uncached_grib_bytes']+cache.downloaded_bytes > cache.max_download_bytes:
            raise ValueError('Required GRIB bytes exceed --max-download-mib; no GRIB download started')
        if args.download_only:
            with ThreadPoolExecutor(max_workers=3) as executor:
                list(executor.map(lambda r: ARCHIVE.get_record(r['hour'], r['variable'], r['level']), checked['records']))
            print(json.dumps({'cached': True, 'network_requests': cache.network_requests, 'downloaded_bytes': cache.downloaded_bytes}, indent=2))
            return
        import numpy as np
        import eccodes
        DEST = Path(args.work_directory).expanduser().resolve() if args.work_directory else bundle/'downloads'/f'{args.provider}-{INIT:%Y%m%d-%H}'
        DEST.mkdir(parents=True, exist_ok=True)
        run_file = DEST/'run.json'
        run = {'initialization': INIT.isoformat(), 'provider': args.provider}
        prior = json.loads(run_file.read_text()) if run_file.exists() else run
        legacy = args.provider == 'nodd-0p25' and prior == {'initialization': INIT.isoformat()}
        if prior != run and not legacy:
            raise ValueError('Work directory belongs to another model run or provider; choose a new directory')
        write_json(run_file, run)
        ALTITUDES_M = np.arange(0, 16001, 1000, dtype=np.float32)
        layer_hours, wind_hours, profile_hours = (schedule[k] for k in ('layer_hours', 'wind_hours', 'profile_hours'))
        provenance = ARCHIVE.source_metadata()
        with ThreadPoolExecutor(max_workers=3) as executor:
            layers = list(executor.map(layer_hour, layer_hours))
        atomic_npz(DEST/'cloud-layers.npz', coverage=np.stack([r[0] for r in layers]),
                   timestamps=np.array([(INIT+timedelta(hours=h)).timestamp() for h in layer_hours], dtype=np.float64))
        write_json(DEST/'cloud-layers-source.json', {
            'model': 'NOAA GFS', 'initialization': INIT.isoformat(), 'forecast_hours': layer_hours,
            **provenance, 'variables': ['LCDC', 'MCDC', 'HCDC'], 'layer_order': ['low', 'middle', 'high'],
            'grid_degrees': .25, 'coverage_shape': [len(layer_hours), 3, 721, 1440], 'coverage_units': 'fraction',
            'resampling': 'bilinear 0.5-to-0.25-degree; periodic longitude; exact pole endpoints' if args.provider == 'ncei-0p50' else 'native 0.25-degree',
            'retrieved_at': max(field['retrieved_at'] for result in layers for field in result[1]),
            'fields': [field for result in layers for field in result[1]]})
        del layers
        with ThreadPoolExecutor(max_workers=3) as executor:
            winds = list(executor.map(wind_hour, wind_hours))
        atomic_npz(DEST/'cloud-winds.npz', u=np.stack([r[0][0] for r in winds]), v=np.stack([r[0][1] for r in winds]),
                   timestamps=np.array([(INIT+timedelta(hours=h)).timestamp() for h in wind_hours], dtype=np.float64),
                   representative_heights_m=np.array([1500, 5500, 10500], np.float32))
        wind_meta = [field for result in winds for field in result[1]]
        del winds
        with ThreadPoolExecutor(max_workers=3) as executor:
            profiles = list(executor.map(profile_hour, profile_hours))
        write_json(DEST/'cloud-profile-source.json', {
            'model': 'NOAA GFS', 'initialization': INIT.isoformat(), 'grid_degrees': .5, **provenance,
            'wind_forecast_hours': wind_hours, 'profile_forecast_hours': profile_hours,
            'pressure_levels_hpa': PRESSURES_HPA, 'profile_altitudes_m': ALTITUDES_M.tolist(),
            'liquid_effective_radius_m': 10e-6, 'ice_effective_radius_m': 30e-6,
            'visualization_assumptions': ['Cloud extinction reconstructed from condensate with assumed particle radii.',
                'Winds at 850/500/250 hPa are assigned 1500/5500/10500 m.',
                'Pressure fields reconstructed onto 1 km height planes; cloud details are not observed individual clouds.'],
            'retrieved_at': max(field['retrieved_at'] for field in wind_meta+[f for result in profiles for f in result]),
            'wind_fields': wind_meta,
            'profile_fields': [field for result in profiles for field in result]})
        result = attach_weather(bundle, DEST, source_mode='forecast')
        print(json.dumps({'valid': True, 'network_requests': cache.network_requests, 'downloaded_bytes': cache.downloaded_bytes,
                          'weather': {k: result['weather'][k] for k in ('initialization', 'valid_start', 'valid_end', 'source_mode')}}, indent=2))
    except (ValueError, OSError, KeyError, ImportError) as error:
        parser.exit(1, f'Weather preparation failed: {error}\nNo alternative date or clear-weather fallback was selected.\n')


if __name__ == '__main__':
    main()
