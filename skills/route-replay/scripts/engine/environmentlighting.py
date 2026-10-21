"""Explicit dated environment inputs; no downloads or hidden date substitution.

AOD550 controls an *additional* modeled aerosol population, above the existing
clear-air baseline. Its vertical profile, Angstrom exponent and single-scatter
albedo are declared assumptions, not extra observations from a column product.
Snow/ice cover changes reflectance, never the geometric terrain or weather.
"""
from functools import lru_cache
import importlib
import os
import sys
import numpy as np

EARTH_KM = 6371.
HEIGHT_SCALE = 7.2
AEROSOL_HEIGHT_KM = 1.2 * HEIGHT_SCALE
ANGSTROM_EXPONENT = 1.3
SINGLE_SCATTER_ALBEDO = .90
RGB_WAVELENGTH_NM = np.array([680., 550., 440.])
SNOW_ALBEDO = np.array([.80, .83, .86])
ICE_ALBEDO = np.array([.48, .56, .62])


def product(kind):
    runtime=sys.modules.get('runtime')
    if runtime is None and os.environ.get('FLIGHT_ASSET_DIR'):
        # Configured rendering must not depend on another layer importing
        # runtime first. Pure transport queries without a bundle remain valid.
        runtime=importlib.import_module('runtime')
    record = getattr(runtime, 'BUNDLE', {}).get('environment', {}).get(kind)
    return runtime.ASSETS / record['path'] if record else None


@lru_cache(maxsize=4)
def _frame_sampler(path, when):
    # Production bundle products are hash-verified, content-addressed and
    # immutable. Bind once per weather instant, not once per quadrature node.
    from environmental_data import prepared_environment_sampler
    return prepared_environment_sampler(path, when)


def aerosol_coefficients(points, when):
    """Additional RGB extinction per displayed kilometre at Earth-fixed points."""
    point = np.asarray(points, np.float64)
    result = np.zeros(point.shape, np.float64)
    path = product('aerosol') if when is not None else None
    if path is None or not point.size:
        return result
    radius = np.linalg.norm(point, axis=-1)
    if np.any(radius == 0) or not np.isfinite(point).all():
        raise ValueError('Aerosol queries require finite nonzero Earth positions')
    height = (radius - 1) * EARTH_KM
    valid = (height >= 0) & (height < 100*HEIGHT_SCALE)
    if not np.any(valid):
        return result
    p = point[valid]
    aod = _frame_sampler(path, when)(np.arctan2(p[..., 1], p[..., 0]),
        np.arcsin(np.clip(p[..., 2]/radius[valid], -1, 1)))['aod550']
    spectrum = (RGB_WAVELENGTH_NM/550.)**(-ANGSTROM_EXPONENT)
    result[valid] = (aod*np.exp(-height[valid]/AEROSOL_HEIGHT_KM)
                     /AEROSOL_HEIGHT_KM)[..., None]*spectrum
    return result


def aerosol_optical_depth(points, directions, length, when, samples=10):
    """Integrate the same aerosol density on camera, Sun and Moon paths."""
    points = np.asarray(points, float)
    directions = np.asarray(directions, float)
    length = np.maximum(np.asarray(length, float), 0)
    shape=np.broadcast_shapes(points.shape[:-1],directions.shape[:-1],length.shape)
    points=np.broadcast_to(points,shape+(3,)).reshape(-1,3)
    directions=np.broadcast_to(directions,shape+(3,)).reshape(-1,3)
    length=np.broadcast_to(length,shape).reshape(-1)
    result = np.zeros(points.shape, np.float64)
    if when is None or product('aerosol') is None:
        return result.reshape(shape+(3,))
    if type(samples) is not int or samples < 1:
        raise ValueError('Aerosol integration requires positive integer samples')
    # A uniform march over the 720-km displayed air shell would miss most of
    # this low-altitude layer. Split at both sides of radial shells and use
    # Gaussian quadrature inside each, including tangent and outside-entry rays.
    from camera_geometry import sphere_interval
    edges = [np.zeros_like(length), length]
    for height in (.0, .25, .5, 1., 2., 4., 8., 16., 32., 100.):
        near, far, hit = sphere_interval(points, directions, 1+height*HEIGHT_SCALE/EARTH_KM)
        for edge in (near, far):
            edges.append(np.clip(np.where(hit, edge, 0), 0, length))
    edges = np.sort(np.stack(edges, axis=-1), axis=-1)
    nodes, weights = np.polynomial.legendre.leggauss(min(8, max(2, (samples+3)//4)))
    for begin, end in zip(edges[..., :-1].T, edges[..., 1:].T):
        active = end > begin
        if not np.any(active):
            continue
        half = (end[active]-begin[active])*.5
        middle = (end[active]+begin[active])*.5
        for node, weight in zip(nodes, weights):
            query = points[active]+directions[active]*(middle+half*node)[..., None]
            result[active] += aerosol_coefficients(query, when)*(half*EARTH_KM*weight)[..., None]
    return result.reshape(shape+(3,))


def aerosol_incident(points, direction, when):
    """Additional directional transmittance; identity without a supplied product."""
    if when is None or product('aerosol') is None:
        return np.ones(np.shape(points), np.float64)
    from camera_geometry import sphere_interval
    _, length, _ = sphere_interval(points, direction, 1+100*HEIGHT_SCALE/EARTH_KM)
    return np.exp(-aerosol_optical_depth(points, direction, length, when))


def aerosol_segment_depth(midpoint, direction, length, when):
    """Two-point Gaussian extinction for a shell-resolved camera segment."""
    if when is None or product('aerosol') is None:
        return np.zeros(np.shape(midpoint))
    offset=np.asarray(direction)*(np.asarray(length)*(.5/np.sqrt(3)))[:,None]
    return (aerosol_coefficients(midpoint-offset,when)+aerosol_coefficients(midpoint+offset,when))*(np.asarray(length)*EARTH_KM*.5)[:,None]


def surface_conditions(albedo, land, lon, lat, when):
    """Return dated albedo and open-water fraction; artistic material constants."""
    albedo = np.asarray(albedo)
    land = np.clip(np.asarray(land), 0, 1)
    path = product('surface_conditions') if when is not None else None
    if path is None:
        return albedo, 1-land
    values = _frame_sampler(path, when)(lon, lat)
    snow = values['snow_fraction'][..., None]*land
    ice = values['sea_ice_fraction'][..., None]*(1-land)
    return albedo*(1-snow-ice)+SNOW_ALBEDO*snow+ICE_ALBEDO*ice, (1-land)-ice
