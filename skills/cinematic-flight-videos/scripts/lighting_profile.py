"""Optional, attributed local lamp measurements or explicitly modeled overrides.

Validation is standard-library only. Applying a profile imports NumPy lazily.
The profile changes chromaticity/population schedules, never source locations,
physical time, photocell state or the historical texture's emission budget.
"""
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path

MAX_BYTES = 256 * 1024
SOURCE_KEYS = {'url', 'credit', 'license_url', 'notes'}
POPULATIONS = ('outdoor', 'building', 'sign', 'persistent')
# Keep schema validation independent of NumPy and the rendering engine.
LAMP_IDS = ('sodium', 'led_2700', 'led_3000', 'led_4000', 'led_5000', 'metal_halide')
DEFAULT_DISTRICT_VARIATION = .20


def source_record(value):
    if not isinstance(value, dict) or set(value) != SOURCE_KEYS or not all(
            isinstance(value[k], str) and value[k].strip() for k in SOURCE_KEYS):
        raise ValueError('Lighting source requires exactly url, credit, license_url and notes strings')
    return dict(value)


def instant(text):
    try:
        dt = datetime.fromisoformat(text.replace('Z', '+00:00'))
        if dt.utcoffset() is None:
            raise ValueError()
        return dt.astimezone(timezone.utc)
    except (AttributeError, TypeError, ValueError) as exc:
        raise ValueError('Lighting validity dates need ISO timestamps with UTC offsets') from exc


def _number(value, label, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f'{label} must be finite and in [{low}, {high}]')
    return float(value)


def validate_profile(value):
    keys = {'schema_version', 'title', 'source', 'regions'}
    if not isinstance(value, dict) or set(value) != keys or type(value['schema_version']) is not int or value['schema_version'] not in (1, 2):
        raise ValueError('Lighting profile requires schema_version 1 or 2, title, source and regions only')
    try:
        size = len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8'))
    except (TypeError, ValueError) as exc:
        raise ValueError('Lighting profile must contain finite JSON values') from exc
    if size > MAX_BYTES:
        raise ValueError('Lighting profile exceeds 256 KiB')
    if not isinstance(value['title'], str) or not value['title'].strip():
        raise ValueError('Lighting profile needs a nonempty title')
    source_record(value['source'])
    regions = value['regions']
    if not isinstance(regions, list) or not 1 <= len(regions) <= 64:
        raise ValueError('Lighting profile needs 1–64 regions')
    ids = set()
    required = {'id', 'lat', 'lon', 'radius_km', 'valid_from', 'valid_until', 'basis', 'notes'}
    optional = {'shares', 'building_curfew', 'sign_curfew', 'observed_at', 'uncertainty'}
    if value['schema_version'] == 1:
        required = required | {'xy'}
    else:
        optional = optional | {'xy', 'population_mixtures', 'district_variation', 'source'}
    for region in regions:
        if not isinstance(region, dict) or not required.issubset(region) or set(region) - required - optional:
            raise ValueError('Lighting region fields differ from the documented schema')
        name = region['id']
        if not isinstance(name, str) or not name.strip() or name in ids:
            raise ValueError('Lighting region IDs must be nonempty and unique')
        ids.add(name)
        if region['basis'] not in ('measured', 'modeled'):
            raise ValueError('Lighting basis must be measured or modeled')
        if not isinstance(region['notes'], str) or not region['notes'].strip():
            raise ValueError('Lighting regions need measurement/model notes')
        if instant(region['valid_from']) >= instant(region['valid_until']):
            raise ValueError('Lighting valid_until must be after valid_from (exclusive end)')
        for key, low, high in [('lat', -90, 90), ('lon', -180, 180), ('radius_km', 1, 2000),
                               ('building_curfew', 12, 36), ('sign_curfew', 12, 36)]:
            if key in region:
                _number(region[key], key, low, high)
        if value['schema_version'] == 2 and ('xy' in region) == ('population_mixtures' in region):
            raise ValueError('Lighting version 2 regions require exactly one of xy or population_mixtures')
        if 'xy' in region:
            xy = region['xy']
            if not isinstance(xy, list) or len(xy) != 2:
                raise ValueError('Lighting xy must contain two chromaticity coordinates')
            x, y = [_number(v, 'xy', .0001, .9999) for v in xy]
            if x + y > 1:
                raise ValueError('Lighting xy must satisfy x + y <= 1')
        if 'population_mixtures' in region:
            mixtures = region['population_mixtures']
            if not isinstance(mixtures, dict) or not mixtures or set(mixtures) - set(POPULATIONS):
                raise ValueError('Lighting population_mixtures needs outdoor, building, sign and/or persistent objects')
            for population, mixture in mixtures.items():
                if not isinstance(mixture, dict) or not mixture or set(mixture) - set(LAMP_IDS):
                    raise ValueError(f'Lighting {population} mixture contains an unknown lamp ID or is empty')
                if abs(sum(_number(weight, 'lamp weight', 0, 1) for weight in mixture.values()) - 1) > 1e-6:
                    raise ValueError('Lighting lamp weights must sum to one')
        if 'district_variation' in region:
            if 'population_mixtures' not in region:
                raise ValueError('district_variation applies only to population_mixtures')
            _number(region['district_variation'], 'district_variation', 0, .5)
        if 'source' in region:
            source_record(region['source'])
        if 'observed_at' in region:
            instant(region['observed_at'])
        if 'uncertainty' in region:
            uncertainty=region['uncertainty']
            if (not isinstance(uncertainty,dict) or 'notes' not in uncertainty or
                    set(uncertainty)-{'notes','xy','population_fraction','schedule_hours'} or
                    not isinstance(uncertainty['notes'],str) or not uncertainty['notes'].strip()):
                raise ValueError('Lighting uncertainty needs notes and optional absolute xy/population_fraction/schedule_hours bounds')
            if 'xy' in uncertainty:
                if not isinstance(uncertainty['xy'],list) or len(uncertainty['xy'])!=2:raise ValueError('Uncertainty xy needs two absolute coordinate bounds')
                for error in uncertainty['xy']:_number(error,'uncertainty xy',0,1)
            for key,high in [('population_fraction',1),('schedule_hours',24)]:
                if key in uncertainty:_number(uncertainty[key],'uncertainty '+key,0,high)
        if 'shares' in region:
            shares = region['shares']
            if not isinstance(shares, list) or len(shares) != 4:
                raise ValueError('Lighting shares must list outdoor, building, sign and persistent fractions')
            if abs(sum(_number(v, 'share', 0, 1) for v in shares) - 1) > 1e-6:
                raise ValueError('Lighting shares must sum to one')
    return value


def read_profile(path):
    path = Path(path)
    with path.open('rb') as handle:
        raw = handle.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError('Lighting profile exceeds 256 KiB')
    return validate_profile(json.loads(raw))


def xy_linear_rgb(xy):
    """CIE xy → XYZ with Y=1 → linear sRGB; project out-of-gamut values.

    D65 sRGB matrix follows W3C CSS Color 4's sample conversion equations.
    Negative channels are clipped, then luminance is restored to one. This is
    a display-gamut approximation, not a spectral renderer or absolute lux.
    """
    import numpy as np
    x, y = xy
    xyz = np.array([x / y, 1., (1 - x - y) / y])
    matrix = np.array([[12831 / 3959, -329 / 214, -1974 / 3959],
                       [-851781 / 878810, 1648619 / 878810, 36519 / 878810],
                       [705 / 12673, -2585 / 12673, 705 / 667]])
    rgb = np.maximum(matrix @ xyz, 0)
    return rgb / (rgb @ np.array([.2126, .7152, .0722]))


def apply_profile(profile, lon, lat, when, color, priors):
    """Blend active spherical regions, independent of input/frame order.

    Coverage is full within 80% of radius, feathered to zero at radius. Active
    overlaps are weighted equally by spatial coverage; outside coverage or
    validity dates, the normal modeled defaults remain unchanged.
    """
    if profile is None or when is None:
        return color, priors
    if any('population_mixtures' in region for region in profile['regions']):
        raise ValueError('Population mixtures need apply_population_profile with four population colors')
    import numpy as np
    if when.utcoffset() is None:
        raise ValueError('Lighting evaluation requires a timezone-aware instant')
    lon, lat = np.broadcast_arrays(lon, lat)
    shape = lon.shape
    channels = np.concatenate((np.asarray(color).reshape(-1, 3),
        np.asarray(priors['shares']).reshape(-1, 4),
        np.asarray(priors['building_curfew']).reshape(-1, 1),
        np.asarray(priors['sign_curfew']).reshape(-1, 1)), axis=1)
    weights = np.zeros_like(channels, dtype=float)
    sums = np.zeros_like(channels, dtype=float)
    for region in sorted(profile['regions'], key=lambda r: r['id']):
        if not instant(region['valid_from']) <= when < instant(region['valid_until']):
            continue
        la, lo = math.radians(region['lat']), math.radians(region['lon'])
        # Haversine avoids precision loss for small regions and wraps longitude.
        h = np.sin((lat.ravel() - la) / 2)**2 + np.cos(lat.ravel()) * math.cos(la) * np.sin((lon.ravel() - lo) / 2)**2
        km = 12742 * np.arcsin(np.sqrt(np.clip(h, 0, 1)))
        t = np.clip((1 - km / region['radius_km']) / .2, 0, 1)
        weight = t * t * (3 - 2 * t)
        params = np.r_[xy_linear_rgb(region['xy']), region.get('shares', [0]*4),
                       region.get('building_curfew', 0), region.get('sign_curfew', 0)]
        mask = np.r_[[1]*3, [int('shares' in region)]*4,
                     int('building_curfew' in region), int('sign_curfew' in region)]
        active = weight[:, None] * mask
        sums += active * params
        weights += active
    mix = np.minimum(weights, 1)
    result = channels * (1 - mix) + sums / np.maximum(weights, 1e-30) * mix
    updated = dict(priors)
    updated['shares'] = result[:, 3:7].reshape(shape + (4,)).astype(np.float32)
    updated['building_curfew'] = result[:, 7].reshape(shape)
    updated['sign_curfew'] = result[:, 8].reshape(shape)
    return result[:, :3].reshape(shape + (3,)).astype(np.float32), updated


def apply_population_profile(profile, lon, lat, when, colors, priors):
    """Apply dated overrides to independent unit-luminance population colors.

    ``colors`` has shape ``broadcast(lon, lat).shape + (4, 3)`` in outdoor,
    building, sign, persistent order. Version 1/common ``xy`` applies the same
    color to all four populations. Unspecified color/schedule channels are
    unchanged. Overlaps accumulate in sorted region-ID order per channel.

    District variation is a deterministic geographic mixture approximation:
    one spherical 18 km field per active region tilts warm/cool weights by
    factors within [1-d, 1+d], then renormalizes. Zero weights remain zero.
    The field has no dependence on time, camera, pixel brightness or frame.
    """
    if profile is None or when is None:
        return colors, priors
    import numpy as np
    if when.utcoffset() is None:
        raise ValueError('Lighting evaluation requires a timezone-aware instant')
    lon, lat = np.broadcast_arrays(lon, lat)
    shape = lon.shape
    base_colors = np.broadcast_to(np.asarray(colors), shape + (4, 3))
    channels = np.concatenate((base_colors.reshape(-1, 12),
        np.broadcast_to(priors['shares'], shape + (4,)).reshape(-1, 4),
        np.broadcast_to(priors['building_curfew'], shape).reshape(-1, 1),
        np.broadcast_to(priors['sign_curfew'], shape).reshape(-1, 1)), axis=1)
    weights = np.zeros_like(channels, dtype=float)
    sums = np.zeros_like(channels, dtype=float)
    touched = False
    for region in sorted(profile['regions'], key=lambda r: r['id']):
        if not instant(region['valid_from']) <= when < instant(region['valid_until']):
            continue
        la, lo = math.radians(region['lat']), math.radians(region['lon'])
        h = np.sin((lat.ravel() - la) / 2)**2 + np.cos(lat.ravel()) * math.cos(la) * np.sin((lon.ravel() - lo) / 2)**2
        km = 12742 * np.arcsin(np.sqrt(np.clip(h, 0, 1)))
        t = np.clip((1 - km / region['radius_km']) / .2, 0, 1)
        coverage = t * t * (3 - 2 * t)
        selected = np.flatnonzero(coverage > 0)
        if not selected.size:
            continue
        touched = True
        params = np.zeros((len(selected), 18), dtype=float)
        mask = np.zeros(18, dtype=float)
        if 'xy' in region:
            params[:, :12] = np.tile(xy_linear_rgb(region['xy']), 4)
            mask[:12] = 1
        else:
            from engine.lampspectra import LAMP_IDS as palette_ids, LINEAR_PALETTE
            if tuple(palette_ids) != LAMP_IDS:
                raise ValueError('Lamp palette IDs differ from the profile schema')
            mixtures = region['population_mixtures']
            variation = region.get('district_variation', DEFAULT_DISTRICT_VARIATION)
            district = None
            if variation and any(sum(weight > 0 for weight in mix.values()) > 1 for mix in mixtures.values()):
                from engine.citypopulations import geographic_noise, unit_points
                points = unit_points(lon.ravel()[selected], lat.ravel()[selected])
                seed = int.from_bytes(hashlib.sha256(region['id'].encode('utf-8')).digest()[:4], 'big')
                district = (2 * geographic_noise(points, 18., seed).astype(float) - 1)[:, None]
            # These fixed signs create correlated warm/cool district changes,
            # with one field rather than six independent noise evaluations.
            tilt = np.array([-1., -.6, -.2, .2, .6, 1.])
            for index, population in enumerate(POPULATIONS):
                if population not in mixtures:
                    continue
                mixture = np.array([mixtures[population].get(lamp, 0.) for lamp in LAMP_IDS])
                local = np.broadcast_to(mixture, (len(selected), len(LAMP_IDS))).copy()
                if district is not None:
                    local *= 1 + variation * district * tilt
                local /= local.sum(axis=1, keepdims=True)
                params[:, 3*index:3*(index+1)] = local @ LINEAR_PALETTE
                mask[3*index:3*(index+1)] = 1
        if 'shares' in region:
            params[:, 12:16] = region['shares']
            mask[12:16] = 1
        for channel, key in ((16, 'building_curfew'), (17, 'sign_curfew')):
            if key in region:
                params[:, channel] = region[key]
                mask[channel] = 1
        active = coverage[selected, None] * mask
        sums[selected] += active * params
        weights[selected] += active
    if not touched:
        return colors, priors
    mix = np.minimum(weights, 1)
    result = channels * (1 - mix) + sums / np.maximum(weights, 1e-30) * mix
    updated = dict(priors)
    updated['shares'] = result[:, 12:16].reshape(shape + (4,)).astype(np.asarray(priors['shares']).dtype)
    updated['building_curfew'] = result[:, 16].reshape(shape)
    updated['sign_curfew'] = result[:, 17].reshape(shape)
    dtype = base_colors.dtype if np.issubdtype(base_colors.dtype, np.floating) else np.float32
    return result[:, :12].reshape(shape + (4, 3)).astype(dtype), updated
