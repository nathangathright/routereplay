"""Bounded lunar atmosphere and indirect surface response.

The camera-visible air source uses the same lunar geometry and shared air/cloud
extinction as other layers. The surface term is a local radiosity closure:
unresolved neighboring slopes are assumed to share the receiver's albedo.
It is deliberately bounded and is not terrain-to-terrain path tracing.
"""
import numpy as np


def atmosphere_source(points, rays, sr, sm, physical_dt, weather_dt, *,
                      gain, with_clouds=True, samples=10, extra_tau=None,
                      fields=None, cloud_strength=None, cloud_samples=None,
                      shared_cloud_geometry=False):
    """Lunar scattering integrated over one view segment, before view extinction.

    Layered air positions use the air height scale, so cloud queries preserve
    their physical altitude by remapping to the cloud height scale. Joint
    transport explicitly shares displayed positions between media and sets
    ``shared_cloud_geometry=True`` to retain that convention.
    """
    result = np.zeros((len(points), 3), np.float64)
    if physical_dt is None or gain == 0 or not len(points):
        return result
    if not np.isfinite(gain) or gain < 0:
        raise ValueError('Lunar gain must be finite and nonnegative')
    import atmosphere as air
    from moonlighting import lunar_illumination
    from camera_geometry import sphere_interval
    radius=np.linalg.norm(points,axis=-1)
    eligible=np.flatnonzero(radius>=1.)
    if not len(eligible):return result
    state = lunar_illumination(points[eligible], physical_dt, height_exaggeration=air.VISIBILITY_SCALE)
    lit = (state.visibility > 0) & (state.ratio > 0)
    if not np.any(lit):return result
    active=eligible[lit]
    point = points[active]
    direction = state.direction[lit]
    _, length, _ = sphere_interval(point, direction, air.OUTER_KM/air.EARTH_KM)
    tau = air.optical_depth(point, direction, length, samples=samples, weather_dt=weather_dt)
    if with_clouds:
        from cloudvolume import _cloud_optical_depth, HEIGHT_EXAGGERATION
        query=point
        if not shared_cloud_geometry:
            physical_height=(radius[active]-1)/air.VISIBILITY_SCALE
            query=(point/radius[active,None])*(1+physical_height*HEIGHT_EXAGGERATION)[:,None]
        tau += _cloud_optical_depth(query, direction, weather_dt, fields=fields,
            strength=cloud_strength,samples=samples if cloud_samples is None else cloud_samples)[:, None]
    cosine = np.clip(np.sum(rays[active]*direction, axis=-1), -1, 1)
    scattering = (sr[active, None]*air.BETA_R*air.phase_rayleigh(cosine)[:, None]
                   + sm[active, None]*air.BETA_M*air.phase_mie(cosine)[:, None])
    if extra_tau is not None:
        from environmentlighting import SINGLE_SCATTER_ALBEDO
        scattering += extra_tau[active]*SINGLE_SCATTER_ALBEDO*air.phase_mie(cosine)[:, None]
    result[active] = (scattering*np.exp(-tau)
        *(gain*state.ratio[lit]*state.visibility[lit])[:, None])
    return result


def surface_bounce(world, normals, albedo, direction, incident):
    """One bounded diffuse neighbor bounce, in existing surface radiance units.

    A tilted receiver sees more unresolved adjacent ground. The view factor is
    capped at .18, and a unit-albedo bounce can never exceed .18 of the local
    horizontal direct irradiance. Flat ground has zero ground-to-ground bounce.
    Measured terrain normals change the receiving orientation; the neighboring
    albedo and geometry are modeled, not measured transport or an ambient floor.
    """
    up_cosine = np.clip(np.sum(normals*world, axis=-1), -1, 1)
    neighbor_cosine = np.clip(np.sum(world*direction, axis=-1), 0, 1)
    view_factor = np.minimum(.18, .5*(1-up_cosine))
    reflectance = np.clip(np.asarray(albedo), 0, 1)
    return reflectance**2*np.asarray(incident)*(neighbor_cosine*view_factor)[:, None]


def terrain_visibility(points, direction, angular_radius, terrain_sampler, *,
                       steps=16, maximum_distance_m=50000.):
    """Physical-height lunar terrain shadow, sampled over the nearest 50 km.

    Exponentially spaced terrain probes resolve nearby ridges; finite lunar-disc
    coverage smooths the maximum horizon angle. Thin unsampled ridges and more
    distant terrain remain limitations. This never uses cinematic height.
    """
    point = np.asarray(points, float)
    direction = np.broadcast_to(np.asarray(direction, float), point.shape)
    angle = np.broadcast_to(np.asarray(angular_radius, float), (len(point),))
    if (point.ndim != 2 or point.shape[1] != 3 or not np.isfinite(point).all()
            or not np.isfinite(direction).all() or np.any(angle <= 0)
            or not np.isfinite(angle).all() or type(steps) is not int or steps < 2
            or not np.isfinite(maximum_distance_m) or maximum_distance_m < 20):
        raise ValueError('Terrain lunar shadow needs finite positions, radii and valid sampling bounds')
    radius = np.linalg.norm(point, axis=-1)
    if np.any(radius < 1-1e-10) or not np.allclose(np.linalg.norm(direction, axis=-1), 1, atol=1e-7):
        raise ValueError('Terrain lunar shadow requires above-ground normalized rays')
    origin = point + point/radius[:, None]*(2./6371000.)
    obstruction = np.full(len(point), -np.inf)
    for distance_m in np.geomspace(20., maximum_distance_m, steps):
        query = origin + direction*(distance_m/6371000.)
        altitude = (np.linalg.norm(query, axis=-1)-1)*6371000.
        terrain = np.asarray(terrain_sampler(query), float)
        obstruction = np.maximum(obstruction, np.arctan2(terrain-altitude, distance_m))
    u = np.clip(-obstruction/angle, -1, 1)
    return .5+(np.arcsin(u)+u*np.sqrt(np.maximum(1-u*u, 0)))/np.pi
