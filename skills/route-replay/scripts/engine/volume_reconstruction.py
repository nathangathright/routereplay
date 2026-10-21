"""Stateless spatial reconstruction of scene-linear volume transport.

The callback always evaluates real rays with the caller's unchanged quadrature.
Adaptive reconstruction uses a coarse grid, fixed cell-centre scouts, and exact
output rays with continuous blend weights. It has no frame history or global
sample ranking. Worst-case work is the coarse grid plus scouts plus the full
output grid; only callback batches and output-sized arrays are retained. Finite
scouts can reveal missed narrow features, but cannot guarantee finding arbitrary
subpixel clouds. ``full`` is the output-grid spatial reference.
"""
import math

import numpy as np

from radiometry import TransportLayer


def sample_depth(depth, coordinates):
    """Nearest output-pixel depth at (x,y) positions; preserve 0/inf no-hit."""
    if depth is None:
        return None
    depth = np.asarray(depth)
    if depth.ndim != 2 or 0 in depth.shape:
        raise ValueError('depth must be a nonempty H×W array')
    coordinates = np.asarray(coordinates)
    if coordinates.ndim != 2 or coordinates.shape[1] != 2 or not np.all(np.isfinite(coordinates)):
        raise ValueError('coordinates must be a finite N×2 array')
    x = np.clip(np.floor(coordinates[:, 0]).astype(np.int64), 0, depth.shape[1]-1)
    y = np.clip(np.floor(coordinates[:, 1]).astype(np.int64), 0, depth.shape[0]-1)
    return depth[y, x]


def _grid_coordinates(size, shape):
    # Keep the float32 operation order identical to camera_geometry._directions.
    yy, xx = np.mgrid[:shape[0], :shape[1]].astype(np.float32)
    return np.stack([(xx+.5)*size[0]/shape[1], (yy+.5)*size[1]/shape[0]], axis=-1).reshape(-1, 2)


def _output_coordinates(begin, end, width):
    indices = np.arange(begin, end)
    return np.stack([indices % width+.5, indices // width+.5], axis=-1).astype(np.float32)


def _sample(callback, coordinates):
    values = callback(coordinates)
    if not isinstance(values, (tuple, list)) or len(values) not in (2, 3):
        raise ValueError('sample_rays must return radiance, transmittance[, cloud_distance]')
    light, transmission = (np.asarray(value, np.float32) for value in values[:2])
    if transmission.ndim == 1:
        transmission = transmission[:, None]
    if light.shape != (len(coordinates), 3):
        raise ValueError('sample radiance must have shape N×3')
    if transmission.shape not in ((len(coordinates), 1), (len(coordinates), 3)):
        raise ValueError('sample transmittance must have shape N, N×1 or N×3')
    if not np.all(np.isfinite(light)) or not np.all(np.isfinite(transmission)):
        raise ValueError('sample transport must be finite')
    guide = None
    if len(values) == 3:
        guide = np.asarray(values[2], np.float32).reshape(-1)
        if guide.shape != (len(coordinates),):
            raise ValueError('cloud_distance must have shape N')
        # Empty/invalid cloud distances have no opacity confidence.
        guide = np.where(np.isfinite(guide) & (guide > 0), guide, 0)
    return np.maximum(light, 0), np.clip(transmission, 0, 1), guide


def _sample_batches(callback, coordinates, batch_size):
    light = transmission = guide = None
    for begin in range(0, len(coordinates), batch_size):
        end = min(begin+batch_size, len(coordinates))
        current = _sample(callback, coordinates[begin:end])
        if light is None:
            light = np.empty((len(coordinates), 3), np.float32)
            transmission = np.empty((len(coordinates), current[1].shape[1]), np.float32)
            guide = None if current[2] is None else np.empty(len(coordinates), np.float32)
        if current[1].shape[1] != transmission.shape[1] or (current[2] is None) != (guide is None):
            raise ValueError('sample_rays must return consistent channels and cloud_distance')
        light[begin:end], transmission[begin:end] = current[:2]
        if guide is not None:
            guide[begin:end] = current[2]
    return light, transmission, guide


def _corners(coordinates, size, shape, *, scout=False):
    offset = 1. if scout else .5
    # Scout locations are midway between the original coarse centres.
    sx = coordinates[:, 0]*shape[1]/size[0]-offset
    sy = coordinates[:, 1]*shape[0]/size[1]-offset
    grid_shape = (max(1, shape[0]-1), max(1, shape[1]-1)) if scout else shape
    if scout and shape[1] == 1:
        sx = np.zeros_like(sx)
    if scout and shape[0] == 1:
        sy = np.zeros_like(sy)
    sx = np.clip(sx, 0, grid_shape[1]-1)
    sy = np.clip(sy, 0, grid_shape[0]-1)
    x0, y0 = np.floor(sx).astype(int), np.floor(sy).astype(int)
    x1, y1 = np.minimum(x0+1, grid_shape[1]-1), np.minimum(y0+1, grid_shape[0]-1)
    fx, fy = sx-x0, sy-y0
    indices = np.stack([y0*grid_shape[1]+x0, y0*grid_shape[1]+x1,
                        y1*grid_shape[1]+x0, y1*grid_shape[1]+x1], axis=-1)
    weights = np.stack([(1-fx)*(1-fy), fx*(1-fy), (1-fx)*fy, fx*fy], axis=-1).astype(np.float32)
    return indices, weights


def _depth_similarity(target, corners):
    valid = np.isfinite(target) & (target > 0)
    corner_valid = np.isfinite(corners) & (corners > 0)
    # Replace no-hit sentinels before subtraction: inf-inf must never be used.
    target = np.where(valid, target, 0)[:, None]
    corners = np.where(corner_valid, corners, 0)
    tolerance = 2e-5+.01*np.minimum(target, corners)
    difference = np.abs(target-corners)/tolerance
    similarity = np.exp(-np.minimum(difference*difference, 80))
    return np.where(valid[:, None] == corner_valid, similarity, 0).astype(np.float32)


def _variation(light, transmission, guide):
    light_range = np.max(light, axis=1)-np.min(light, axis=1)
    # Physical sampling stays independent of display exposure and scene-cache
    # reuse. Very dark detail varying only in radiance may remain reconstructed.
    light_scale = .02+.15*np.max(light, axis=(1, 2))
    severity = np.max(light_range, axis=1)/light_scale
    severity = np.maximum(severity, np.max(np.ptp(transmission, axis=1), axis=1)/.12)
    if guide is not None:
        opacity = 1-np.mean(transmission, axis=-1)
        # All pairs, with opacity tending continuously to zero for empty rays.
        for a in range(guide.shape[1]):
            for b in range(a):
                confidence = np.minimum(opacity[:, a], opacity[:, b])
                confidence *= (guide[:, a] > 0) & (guide[:, b] > 0)
                difference = np.abs(guide[:, a]-guide[:, b])/(.002+.05*np.minimum(guide[:, a], guide[:, b]))
                severity = np.maximum(severity, confidence*difference)
    return severity


def _interpolate(samples, coarse_depth, coarse_support, coordinates, size, shape,
                 opaque_depth, support_mask):
    indices, spatial = _corners(coordinates, size, shape)
    light, transmission, guide = samples
    light, transmission = light[indices], transmission[indices]
    guide = None if guide is None else guide[indices]
    weights = spatial.copy()
    geometry = np.zeros(len(coordinates), np.float32)
    if coarse_depth is not None:
        similarity = _depth_similarity(sample_depth(opaque_depth, coordinates), coarse_depth[indices])
        weights *= similarity
        # Any incompatible contributing geometry requires exact output rays.
        geometry = np.max(np.where(spatial > 0, 1-similarity, 0), axis=1)
    if coarse_support is not None:
        compatible = sample_depth(support_mask, coordinates)[:, None] == coarse_support[indices]
        weights *= compatible
        geometry = np.maximum(geometry, np.any((spatial > 0) & ~compatible, axis=1))
    opacity = 1-np.mean(transmission, axis=-1)
    target_opacity = np.sum(spatial*opacity, axis=1)
    weights *= np.exp(-((opacity-target_opacity[:, None])/.25)**2)
    if guide is not None:
        confidence = spatial*opacity*(guide > 0)
        target_guide = np.sum(confidence*guide, axis=1)/np.maximum(np.sum(confidence, axis=1), 1e-12)
        difference = np.abs(guide-target_guide[:, None])/(.002+.05*np.minimum(guide, target_guide[:, None]))
        guide_confidence = np.minimum(opacity, target_opacity[:, None])*(guide > 0)
        weights *= np.exp(-np.minimum((difference*guide_confidence)**2, 80))
    total = np.sum(weights, axis=1)
    missing = total < 1e-8
    weights = np.where(missing[:, None], spatial, weights/np.maximum(total[:, None], 1e-20))
    geometry = np.maximum(geometry, missing)
    result_light = np.sum(weights[:, :, None]*light, axis=1)
    result_transmission = np.sum(weights[:, :, None]*transmission, axis=1)
    severity = _variation(light, transmission, guide)
    return result_light, result_transmission, severity, geometry


def _blend_weight(severity):
    """C1 activation: newly sampled exact rays begin with zero contribution."""
    value = np.clip((severity-.25)/.75, 0, 1)
    return value*value*(3-2*value)


def reconstruct_transport(size, scale, sample_rays, *, opaque_depth=None,
                          support_mask=None, sample_geometry=None,
                          mode='adaptive', batch_size=4096):
    """Reconstruct RGB radiance and scalar/RGB transmission at output size.

    ``sample_rays(xy)`` receives N×2 float32 output coordinates and returns
    ``(radiance[N,3], transmittance[N or N,C], optional_cloud_distance[N])``.
    The distance is the opacity-weighted mean scattering distance, zero when
    empty. ``opaque_depth`` is full-resolution normalized-ray depth (0/inf mean
    no opaque hit). Optional ``support_mask`` identifies nonempty integration
    intervals. ``sample_geometry(xy)`` optionally returns the corresponding
    opaque depth and support at the exact coarse-ray positions, in that order.
    Use it for analytic guides: rounding a fractional coarse ray to a full-grid
    pixel can put its guide on the opposite side of a silhouette. Output guides
    remain full-resolution arrays. Geometry callbacks are bounded and used only
    for coarse samples. Guides affect reconstruction, never callback physics.
    ``full`` evaluates every output pixel centre with no reconstruction. Legacy
    ``reference`` resizing belongs to the callers and is deliberately separate.
    """
    if (len(size) != 2 or any(isinstance(n, bool) or int(n) != n or n <= 0 for n in size)):
        raise ValueError('size must contain positive integer width and height')
    size = tuple(map(int, size))
    if not np.isfinite(scale) or scale < 1:
        raise ValueError('scale must be finite and at least one')
    if isinstance(batch_size, bool) or int(batch_size) != batch_size or batch_size < 1:
        raise ValueError('batch_size must be a positive integer')
    batch_size = int(batch_size)
    if mode not in ('adaptive', 'full'):
        raise ValueError('reconstruction mode must be adaptive or full; reference is handled by callers')
    for name, value in (('opaque_depth', opaque_depth), ('support_mask', support_mask)):
        if value is not None and np.asarray(value).shape != (size[1], size[0]):
            raise ValueError(f'{name} must match the output H×W canvas')
    if opaque_depth is not None:
        opaque_depth = np.asarray(opaque_depth, np.float32)
        if np.any(np.isnan(opaque_depth)) or np.any(opaque_depth < 0):
            raise ValueError('opaque_depth must contain nonnegative depths or infinity')
    if support_mask is not None:
        support_mask = np.asarray(support_mask, bool)
    shape = (math.ceil(size[1]/scale), math.ceil(size[0]/scale))
    count = size[0]*size[1]
    if mode == 'full' or shape == (size[1], size[0]):
        light = np.empty((count, 3), np.float32)
        transmission = None
        for begin in range(0, count, batch_size):
            end = min(begin+batch_size, count)
            current = _sample(sample_rays, _output_coordinates(begin, end, size[0]))
            if transmission is None:
                transmission = np.empty((count, current[1].shape[1]), np.float32)
            if current[1].shape[1] != transmission.shape[1]:
                raise ValueError('sample_rays must return consistent transmittance channels')
            light[begin:end], transmission[begin:end] = current[:2]
        return TransportLayer(light.reshape(size[1], size[0], 3), transmission.reshape(size[1], size[0], -1))

    coordinates = _grid_coordinates(size, shape)
    samples = _sample_batches(sample_rays, coordinates, batch_size)
    coarse_depth = sample_depth(opaque_depth, coordinates)
    coarse_support = sample_depth(support_mask, coordinates)
    if sample_geometry is not None:
        for begin in range(0, len(coordinates), batch_size):
            end = min(begin+batch_size, len(coordinates))
            geometry = sample_geometry(coordinates[begin:end])
            if not isinstance(geometry, (tuple, list)) or len(geometry) != 2:
                raise ValueError('sample_geometry must return opaque_depth, support')
            for name, actual, target in (('opaque_depth', geometry[0], coarse_depth),
                                         ('support', geometry[1], coarse_support)):
                if (actual is None) != (target is None):
                    raise ValueError(f'sample_geometry {name} must match the provided output guide')
                if actual is None:
                    continue
                actual = np.asarray(actual)
                if actual.shape != (end-begin,):
                    raise ValueError(f'sample_geometry {name} must have shape N')
                if name == 'opaque_depth':
                    if np.any(np.isnan(actual)) or np.any(actual < 0):
                        raise ValueError('sample_geometry opaque_depth must be nonnegative or infinity')
                elif not np.all(np.isin(actual, [False, True])):
                    raise ValueError('sample_geometry support must contain boolean values')
                target[begin:end] = actual
    # One fixed scout per coarse cell, including one-dimensional crops.
    scout_shape = (max(1, shape[0]-1), max(1, shape[1]-1))
    yy, xx = np.mgrid[:scout_shape[0], :scout_shape[1]].astype(np.float32)
    sx = (xx+1)*size[0]/shape[1] if shape[1] > 1 else np.full_like(xx, size[0]/2)
    sy = (yy+1)*size[1]/shape[0] if shape[0] > 1 else np.full_like(yy, size[1]/2)
    scouts = np.stack([sx, sy], axis=-1).reshape(-1, 2)
    scout_severity = np.empty(len(scouts), np.float32)
    for begin in range(0, len(scouts), batch_size):
        end = min(begin+batch_size, len(scouts))
        xy = scouts[begin:end]
        actual = _sample(sample_rays, xy)
        predicted = _interpolate(samples, coarse_depth, coarse_support, xy, size, shape,
                                 opaque_depth, support_mask)
        if actual[1].shape[1] != samples[1].shape[1]:
            raise ValueError('sample_rays must return consistent transmittance channels')
        scout_severity[begin:end] = _variation(np.stack([predicted[0], actual[0]], axis=1),
                                              np.stack([predicted[1], actual[1]], axis=1), None)
    light = np.empty((count, 3), np.float32)
    transmission = np.empty((count, samples[1].shape[1]), np.float32)
    # Accumulate sparse refinements across output tiles so expensive integration
    # callbacks receive full batches, preserving their original screen order.
    pending_xy = np.empty((batch_size, 2), np.float32)
    pending_indices = np.empty(batch_size, np.intp)
    pending_blend = np.empty(batch_size, np.float32)
    pending_count = 0

    def flush_refinements():
        nonlocal pending_count
        if not pending_count:
            return
        exact = _sample(sample_rays, pending_xy[:pending_count])
        if exact[1].shape[1] != transmission.shape[1]:
            raise ValueError('sample_rays must return consistent transmittance channels')
        indices = pending_indices[:pending_count]
        fraction = pending_blend[:pending_count, None]
        light[indices] += fraction*(exact[0]-light[indices])
        transmission[indices] += fraction*(exact[1]-transmission[indices])
        pending_count = 0

    for begin in range(0, count, batch_size):
        end = min(begin+batch_size, count)
        xy = _output_coordinates(begin, end, size[0])
        current_light, current_transmission, severity, geometry = _interpolate(
            samples, coarse_depth, coarse_support, xy, size, shape, opaque_depth, support_mask)
        indices, weights = _corners(xy, size, shape, scout=True)
        severity = np.maximum(severity, np.sum(weights*scout_severity[indices], axis=1))
        blend = np.maximum(_blend_weight(severity), _blend_weight(geometry))
        supported = np.ones(len(xy), bool) if support_mask is None else sample_depth(support_mask, xy)
        refine = np.flatnonzero((blend > 0) & supported)
        current_light[~supported] = 0
        current_transmission[~supported] = 1
        light[begin:end], transmission[begin:end] = current_light, current_transmission
        offset = 0
        while offset < len(refine):
            take = min(batch_size-pending_count, len(refine)-offset)
            selected = refine[offset:offset+take]
            queue = slice(pending_count, pending_count+take)
            pending_xy[queue] = xy[selected]
            pending_indices[queue] = begin+selected
            pending_blend[queue] = blend[selected]
            pending_count += take
            offset += take
            if pending_count == batch_size:
                flush_refinements()
    flush_refinements()
    return TransportLayer(np.maximum(light.reshape(size[1], size[0], 3), 0),
                          np.clip(transmission.reshape(size[1], size[0], -1), 0, 1))
