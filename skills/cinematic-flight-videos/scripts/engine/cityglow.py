"""Bounded ground-to-cloud light transport in scene-relative linear RGB.

This is a local irradiance approximation, not a surface/volume path tracer.
Nine spherical ground taps spread the source with physical altitude; a radial
column through the shared cloud density attenuates it. A two-exponential closure
approximates diffuse penetration without an unattenuated ambient-light floor.
The caller supplies dated lamp emission and weather-dependent cloud density.
"""
import numpy as np

EARTH_M = 6_371_000.
# Normalized, positive disk quadrature: central area and two four-point rings.
TAPS = ((0., 0., .25),
        (.85, 0., .125), (0., .85, .125), (-.85, 0., .125), (0., -.85, .125),
        (1.65, 1.65, .0625), (-1.65, 1.65, .0625),
        (-1.65, -1.65, .0625), (1.65, -1.65, .0625))


def ground_illumination(points, source, density, *, height_exaggeration=1.,
                        strength=1., column_samples=6, ground_height=None,
                        batched=False):
    """Return the additive cloud source term, before view extinction.

    ``source(lon, lat)`` returns unattenuated, linear ground RGB at radian
    coordinates. ``density(points)`` returns extinction per physical metre at
    Earth-fixed points in the exaggerated scene. Geometry is queried at the
    cloud's physical height so cinematic exaggeration cannot widen city glow.
    The source has no terminator mask: daylight contrast belongs to compositing.
    ``ground_height(up)`` optionally supplies the local physical MSL datum;
    the dominant column uses this datum for its footprint and integration.
    """
    points = np.asarray(points, np.float64)
    if points.ndim != 2 or points.shape[1] != 3 or not np.all(np.isfinite(points)):
        raise ValueError('City glow needs finite Nx3 Earth-fixed points')
    if not np.isfinite(strength) or strength < 0 or not np.isfinite(height_exaggeration) or height_exaggeration < 1:
        raise ValueError('City glow strength must be nonnegative and height scale at least one')
    if not np.isfinite(column_samples) or int(column_samples) != column_samples or column_samples < 1:
        raise ValueError('City glow column samples must be a positive integer')
    result = np.zeros((len(points), 3), np.float32)
    if not len(points) or strength == 0:
        return result
    radius = np.linalg.norm(points, axis=-1)
    altitude = (radius - 1) * EARTH_M / height_exaggeration
    up = points / np.maximum(radius[:, None], 1e-12)
    ground = np.zeros(len(points)) if ground_height is None else np.asarray(ground_height(up), np.float64)
    if ground.shape != radius.shape or not np.all(np.isfinite(ground)) or np.any(ground < 0):
        raise ValueError('City glow ground height must return finite nonnegative MSL metres')
    height = altitude - ground
    # Reconstructing metres from an Earth-radius coordinate leaves sub-micron
    # roundoff at exact ground contact; it must not create a positive column.
    selected = np.flatnonzero((height > 1e-6) & (altitude <= 16000.))
    if not len(selected):
        return result
    height = height[selected]
    base = ground[selected]
    up = points[selected] / radius[selected, None]
    lon = np.arctan2(up[:, 1], up[:, 0])
    east = np.stack((-np.sin(lon), np.cos(lon), np.zeros_like(lon)), axis=-1)
    north = np.cross(up, east)
    incident = np.zeros((len(selected), 3), np.float64)
    taps=[]
    for x, y, weight in TAPS:
        offset = height[:, None] * (x * east + y * north) / EARTH_M
        ground = up + offset
        ground /= np.linalg.norm(ground, axis=-1, keepdims=True)
        longitude=np.arctan2(ground[:, 1], ground[:, 0])
        latitude=np.arcsin(np.clip(ground[:, 2], -1, 1))
        if batched:
            taps.append((longitude,latitude))
            continue
        rgb = np.asarray(source(longitude,latitude), np.float64)
        if rgb.shape != incident.shape or not np.all(np.isfinite(rgb)) or np.any(rgb < 0):
            raise ValueError('City glow source must return finite nonnegative Nx3 linear RGB')
        incident += weight * rgb
    if batched:
        # Retain all nine exact spherical taps and the original summation
        # order. Combining provider calls changes no lamp clock or footprint.
        rgb=np.asarray(source(np.concatenate([tap[0] for tap in taps]),
                              np.concatenate([tap[1] for tap in taps])),np.float64)
        if rgb.shape != (len(TAPS)*len(selected),3) or not np.isfinite(rgb).all() or np.any(rgb<0):
            raise ValueError('City glow source must return finite nonnegative Nx3 linear RGB')
        for (_,_,weight),value in zip(TAPS,rgb.reshape(len(TAPS),len(selected),3)):
            incident += weight*value
    lit = np.any(incident > 0, axis=-1)
    if not np.any(lit):
        return result
    # The dominant vertical column approximates the ring paths too. This keeps
    # per-frame work local and bounded; there is no global photon/light cache.
    heights = height[lit]
    tau = np.zeros(len(heights), np.float64)
    step = heights / int(column_samples)
    queries=[]
    for index in range(int(column_samples)):
        query = up[lit] * (1 + (base[lit] + (index + .5) * step) * height_exaggeration / EARTH_M)[:, None]
        if batched:
            queries.append(query)
            continue
        sigma = np.asarray(density(query), np.float64)
        if sigma.shape != tau.shape or not np.all(np.isfinite(sigma)) or np.any(sigma < 0):
            raise ValueError('City glow density must return finite nonnegative extinction')
        tau += sigma * step
    if batched:
        sigma=np.asarray(density(np.concatenate(queries)),np.float64)
        if sigma.shape != (int(column_samples)*len(heights),) or not np.isfinite(sigma).all() or np.any(sigma<0):
            raise ValueError('City glow density must return finite nonnegative extinction')
        for value in sigma.reshape(int(column_samples),len(heights)):
            tau += value*step
    penetration = .7 * np.exp(-tau) + .3 * np.exp(-.4 * tau)
    # Approximate clear-air loss over physical height. Cloud scattering is a
    # diffuse closure, so it does not stamp the fine street texture onto clouds.
    air = np.exp(-heights[:, None] / 1000 * np.array([.012, .017, .027]))
    result[selected[lit]] = incident[lit] * air * (.5 * strength * penetration[:, None])
    return result
