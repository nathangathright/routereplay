"""Curved, bounded cloud fields for the experimental local flight camera.

Atlas x/y are physical tangent-plane metres; its third coordinate is *radial*
MSL height, not tangent z. Near and far atlases can therefore sample one dated
field and crossfade without flattening the Earth. Optional silhouette warping
is an explicitly modeled vertical reconstruction, not an observed cloud shape.
"""
from __future__ import annotations

from pathlib import Path
import json
import math
import numpy as np

from chase_weather import EARTH_M, MAX_VOXELS, _instant, _sha, enu_basis, enu_to_ecef, tiled_rgba

MAX_EXTENT_M = 600_000.
MAX_WARP_M = 1_000.
DEFAULT_NEAR_EXTENT_M = 40_000.
DEFAULT_FAR_EXTENT_M = 500_000.


def xyh_to_enu(points_xyh_m):
    """Convert [east, north, radial MSL height] to physical tangent ENU."""
    points = np.asarray(points_xyh_m, np.float64)
    if points.ndim < 1 or points.shape[-1] != 3 or not np.isfinite(points).all():
        raise ValueError('Cloudscape points must be finite with final dimension three')
    if np.any(np.abs(points[..., :2]) > MAX_EXTENT_M) or np.any(points[..., 2] < -500) or np.any(points[..., 2] > 20_000):
        raise ValueError('Cloudscape points need ±600 km x/y and -500..20000 m radial height')
    result = points.copy()
    result[..., 2] = np.sqrt((EARTH_M + points[..., 2])**2 - np.sum(points[..., :2]**2, axis=-1)) - EARTH_M
    return result


def enu_to_xyh(points_enu_m):
    """Inverse of xyh_to_enu; also documents the renderer's atlas lookup."""
    points = np.asarray(points_enu_m, np.float64)
    if points.ndim < 1 or points.shape[-1] != 3 or not np.isfinite(points).all():
        raise ValueError('ENU points must be finite with final dimension three')
    result = points.copy()
    radial = points + np.array([0., 0., EARTH_M])
    result[..., 2] = np.linalg.norm(radial, axis=-1) - EARTH_M
    return result


def _smoothstep(x):
    x = np.clip(x, 0., 1.)
    return x*x*x*(x*(x*6.-15.)+10.)


def _ramp_with_derivative(height, low, high):
    t = np.clip((height-low)/(high-low), 0., 1.)
    return _smoothstep(t), 30.*t*t*(t-1.)**2/(high-low)


def _value_noise(points, scale):
    """Bounded smooth noise anchored to ECEF, without global/random state."""
    q = np.asarray(points, np.float64)/scale
    cell = np.floor(q).astype(np.int64)
    fraction = _smoothstep(q-cell)
    result = np.zeros(q.shape[:-1], np.float64)
    # uint64 arithmetic deliberately wraps; explicit masks avoid overflow warnings.
    mask = np.uint64(0xffffffff)
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                c = (cell + np.array([dx, dy, dz])).astype(np.uint64)
                value = ((c[..., 0]*np.uint64(73856093)) ^ (c[..., 1]*np.uint64(19349663)) ^
                         (c[..., 2]*np.uint64(83492791))) & mask
                value = ((value ^ (value >> np.uint64(13)))*np.uint64(1274126177)) & mask
                value = value ^ (value >> np.uint64(16))
                weight = np.prod(np.where(np.array([dx, dy, dz]), fraction, 1.-fraction), axis=-1)
                result += weight*(value.astype(np.float64)/4294967295.*2.-1.)
    return result


def warped_height(physical_ecef_m, strength=0.):
    """Return source MSL height and its vertical Jacobian for density sampling.

    The source column's latitude/longitude is unchanged. Zero weather coverage
    therefore remains empty at every height. A bounded monotone remapping moves
    existing vertical support; multiplying extinction by dh_source/dh preserves
    its radial column integral (up to atlas discretization). It is not an exact
    3D mass or optical-depth preservation along oblique camera rays.
    """
    if not math.isfinite(strength) or not 0 <= strength <= 1:
        raise ValueError('Cloud silhouette strength must be within 0..1')
    points = np.asarray(physical_ecef_m, np.float64)
    if points.ndim < 1 or points.shape[-1] != 3 or not np.isfinite(points).all():
        raise ValueError('Physical cloud points must be finite with final dimension three')
    radius = np.linalg.norm(points, axis=-1)
    if np.any(radius < EARTH_M-500) or np.any(radius > EARTH_M+20_000):
        raise ValueError('Physical cloud points need -500..20000 m radial height')
    height = radius-EARTH_M
    if strength == 0:
        return height, np.ones_like(height)
    surface = points/radius[..., None]*EARTH_M
    noise = .75*_value_noise(surface, 14_000.)+.25*_value_noise(surface, 4_000.)
    displacement = strength*MAX_WARP_M*np.tanh(2.5*noise)/np.tanh(2.5)
    rise, rise_derivative = _ramp_with_derivative(height, 120., 2_200.)
    fall, fall_derivative = _ramp_with_derivative(height, 6_000., 12_000.)
    envelope = rise*(1.-fall)
    derivative = rise_derivative*(1.-fall)-rise*fall_derivative
    return height-displacement*envelope, 1.-displacement*derivative


def sample_density(points_xyh_m, *, origin_lat_deg, origin_lon_deg, weather_dt,
                   density_fn, height_exaggeration, silhouette_strength=0., chunk_size=65536):
    """Sample engine extinction in inverse physical metres, with optional warp."""
    when = _instant(weather_dt)
    if type(chunk_size) is not int or not 1 <= chunk_size <= 262144:
        raise ValueError('Cloudscape chunk_size must be within 1..262144')
    if not math.isfinite(height_exaggeration) or height_exaggeration <= 0:
        raise ValueError('Height exaggeration must be finite and positive')
    if not math.isfinite(silhouette_strength) or not 0 <= silhouette_strength <= 1:
        raise ValueError('Cloud silhouette strength must be within 0..1')
    physical = enu_to_ecef(xyh_to_enu(points_xyh_m), origin_lat_deg, origin_lon_deg)
    shape = physical.shape[:-1]
    flat = physical.reshape(-1, 3)
    sigma = np.empty(len(flat), np.float32)
    for first in range(0, len(flat), chunk_size):
        points = flat[first:first+chunk_size]
        height, jacobian = warped_height(points, silhouette_strength)
        query = points/np.linalg.norm(points, axis=-1, keepdims=True)*(1.+height[:, None]*height_exaggeration/EARTH_M)
        result = density_fn(query, when, normals=False)
        values = np.asarray(result[0] if isinstance(result, tuple) else result, np.float32)
        if values.shape != (len(query),) or not np.isfinite(values).all() or np.any(values < 0):
            raise ValueError('Existing density sampler must return finite nonnegative extinction per point')
        sigma[first:first+len(query)] = values*jacobian
    return sigma.reshape(shape)


def layer_blend(near_extent_m=DEFAULT_NEAR_EXTENT_M, far_extent_m=DEFAULT_FAR_EXTENT_M):
    """Single shared definition of paired atlas extents and rendering ramps."""
    return validate_layer_blend({'near_fade_start_m':.7*near_extent_m,
        'near_extent_m':near_extent_m, 'far_fade_start_m':.9*far_extent_m,
        'far_extent_m':far_extent_m})


def validate_layer_blend(blend):
    keys=('near_fade_start_m','near_extent_m','far_fade_start_m','far_extent_m')
    if not isinstance(blend,dict) or set(blend)!=set(keys):
        raise ValueError('Cloud blend needs the paired near/far extent and fade definitions')
    values=[blend[key] for key in keys]
    if not np.isfinite(values).all() or not 0 <= values[0] < values[1] < values[2] < values[3] <= MAX_EXTENT_M:
        raise ValueError('Layer fade bounds must be finite, increasing, and within 600 km')
    return {key:float(value) for key,value in zip(keys,values)}


def layer_weights(points_xy_m, near_extent_m=DEFAULT_NEAR_EXTENT_M, near_fade_start_m=None,
                  far_extent_m=DEFAULT_FAR_EXTENT_M, far_fade_start_m=None, *, blend=None):
    """Complementary square XY weights, evaluated after native resampling.

    Pass the renderer record's layer_blend_m to use its shared definition. Both
    media evaluate these ramps at the same physical point, never bake them into
    independently sampled grids. Far alone fades at its distant outer boundary.
    """
    if blend is None:
        blend=layer_blend(near_extent_m,far_extent_m)
        if near_fade_start_m is not None:blend['near_fade_start_m']=near_fade_start_m
        if far_fade_start_m is not None:blend['far_fade_start_m']=far_fade_start_m
    blend=validate_layer_blend(blend)
    points=np.asarray(points_xy_m,np.float64)
    if points.ndim<1 or points.shape[-1]!=2 or not np.isfinite(points).all():
        raise ValueError('Layer blend needs finite XY points')
    distance=np.max(np.abs(points),axis=-1)
    near=1.-_smoothstep((distance-blend['near_fade_start_m'])/
                       (blend['near_extent_m']-blend['near_fade_start_m']))
    edge=1.-_smoothstep((distance-blend['far_fade_start_m'])/
                       (blend['far_extent_m']-blend['far_fade_start_m']))
    return near,(1.-near)*edge


def bake_atlas(output_prefix, *, origin_lat_deg, origin_lon_deg, bounds_xyh_m,
               shape_zyx=(64,160,160), weather_dt, physical_dt=None, density_fn,
               height_exaggeration, silhouette_strength=0., source=None, write_rgba=False, layer_blend_m=None):
    """Bake curved-height density plus a renderer record, bounded to 2m voxels.

    No edge fade is baked. Renderer owns complementary near/far weights and a
    final outer fade. It must mask atlas lookups outside bounds_xyh_m and index
    height using sqrt(x*x+y*y+(z+EARTH_M)**2)-EARTH_M, never Generated.z.
    """
    when = _instant(weather_dt)
    physical = _instant(physical_dt) if physical_dt is not None else None
    blend = validate_layer_blend(layer_blend_m) if layer_blend_m is not None else None
    bounds = np.asarray(bounds_xyh_m, np.float64)
    if bounds.shape != (3, 2) or not np.isfinite(bounds).all() or np.any(bounds[:,1] <= bounds[:,0]):
        raise ValueError('bounds_xyh_m must be increasing finite [[east_min,max],[north_min,max],[height_min,max]]')
    if np.any(np.abs(bounds[:2]) > MAX_EXTENT_M) or bounds[2,0] < -500 or bounds[2,1] > 20_000:
        raise ValueError('Cloudscape bounds need ±600 km x/y and -500..20000 m radial height')
    shape = tuple(shape_zyx)
    if len(shape) != 3 or any(type(n) is not int or not 2 <= n <= 256 for n in shape) or math.prod(shape) > MAX_VOXELS:
        raise ValueError('Atlas needs 2..256 nodes per axis and at most 2000000 voxels')
    if not math.isfinite(silhouette_strength) or not 0 <= silhouette_strength <= 1:
        raise ValueError('Cloud silhouette strength must be within 0..1')
    if blend is not None:
        matched = any(np.array_equal(bounds[:2], [[-extent,extent],[-extent,extent]])
                      for extent in (blend['near_extent_m'],blend['far_extent_m']))
        if not matched:
            raise ValueError('Paired cloud atlas XY bounds must match one of the recorded blend extents')
    x, y, heights = [np.linspace(*bound, n, dtype=np.float64) for bound, n in zip(bounds, shape[::-1])]
    xx, yy = np.meshgrid(x, y, indexing='xy')
    density = np.empty(shape, np.float32)
    for k, height in enumerate(heights):
        points = np.stack((xx, yy, np.full_like(xx, height)), axis=-1)
        density[k] = sample_density(points, origin_lat_deg=origin_lat_deg, origin_lon_deg=origin_lon_deg,
            weather_dt=when, density_fn=density_fn, height_exaggeration=height_exaggeration,
            silhouette_strength=silhouette_strength)
    # AABB encloses the spherical-height prism even when XY bounds omit zero.
    max_r2 = np.sum(np.max(bounds[:2]**2, axis=1))
    nearest_xy = np.where((bounds[:2,0] <= 0) & (bounds[:2,1] >= 0), 0., np.min(np.abs(bounds[:2]), axis=1))
    min_r2 = float(nearest_xy@nearest_xy)
    z_min = float(np.sqrt((EARTH_M+bounds[2,0])**2-max_r2)-EARTH_M)
    z_max = float(np.sqrt((EARTH_M+bounds[2,1])**2-min_r2)-EARTH_M)
    scene_bounds = [[float(bounds[0,0]), float(bounds[1,0]), z_min],
                    [float(bounds[0,1]), float(bounds[1,1]), z_max]]
    prefix = Path(output_prefix).expanduser().resolve()
    prefix.parent.mkdir(parents=True, exist_ok=True)
    archive = prefix.with_suffix('.npz')
    np.savez_compressed(archive, density=density, x_m=x, y_m=y, height_m=heights,
                        origin_ecef_m=enu_to_ecef(np.zeros(3), origin_lat_deg, origin_lon_deg),
                        basis_enu_rows=enu_basis(origin_lat_deg, origin_lon_deg))
    atlas_record = None
    if write_rgba:
        rgba, layout = tiled_rgba(density)
        raw = prefix.with_suffix('.rgba.f32'); rgba.tofile(raw)
        atlas_record = dict(layout, path=raw.name, sha256=_sha(raw), bytes=raw.stat().st_size)
    record = {'npz_path':archive.name, 'coordinate_system':'enu_xy_radial_height',
              'bounds_xyh_m':bounds.tolist(), 'bounds_enu_m':scene_bounds, 'layer_blend_m':blend}
    metadata = {'schema_version':1, 'weather_utc':when.isoformat(),
        'physical_utc':physical.isoformat() if physical else None,
        'origin':{'lat_deg':float(origin_lat_deg), 'lon_deg':float(origin_lon_deg), 'altitude_m':0.},
        'earth_radius_m':EARTH_M, 'bounds_xyh_m':bounds.tolist(), 'scene_bounds_enu_m':scene_bounds,
        'shape_zyx':list(shape), 'layer_blend_m':blend, 'axis_order':'density[radial_height,y,x]; physical metres',
        'density_units':'inverse physical metre', 'density_gain':1.,
        'height_exaggeration_query_only':height_exaggeration, 'silhouette_strength':silhouette_strength,
        'silhouette_warp_max_m':MAX_WARP_M*silhouette_strength,
        'weather_frozen':True, 'source':source or {}, 'edge_fade_baked':False,
        'renderer_record':record, 'density_statistics':{'min':float(density.min()), 'max':float(density.max()),
            'mean':float(density.mean()), 'nonzero_fraction':float(np.mean(density>0))},
        'npz':{'path':archive.name, 'sha256':_sha(archive), 'bytes':archive.stat().st_size},
        'rgba_atlas':atlas_record,
        'limitations':['Forecasts constrain the cloud field; neither individual billows nor the optional vertical warp are observations.',
            'Vertical warp preserves radial column optical depth analytically; finite atlas discretization and oblique paths are approximate.',
            'Near/far atlas resolution differs; the renderer must apply complementary weights once, with no duplicated full-density overlap.',
            'One frozen weather instant and a finite distant field; this is not an unlimited global cloud volume.']}
    prefix.with_suffix('.json').write_text(json.dumps(metadata, indent=2, allow_nan=False)+'\n')
    return metadata
