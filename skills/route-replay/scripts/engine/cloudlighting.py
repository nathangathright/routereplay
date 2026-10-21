"""Local cloud source approximations, independent of density and view opacity.

The finite scattering orders reuse one Sun optical depth. They broaden the
phase and reduce effective *cloud* attenuation for secondary paths; this is a
bounded closure, not a global multiple-scattering solve. Directional sky RGB
comes from the existing spherical atmosphere, without a fixed night floor.

Nubis Evolved (2022) motivates separate direct/secondary phases; Nubis Cubed
(2023) motivates attenuating ambient light along sky directions. The order
series and small atmosphere lookup here are local adaptations, not Guerrilla's
implementation. No density, weather, display exposure, or city source changes
are made by this module.
"""
from functools import lru_cache

import numpy as np

import atmosphere as air


# Displayed kilometres: do not divide by the cloud height exaggeration. The
# atmosphere has its own compensated 7.2x height convention in atmosphere.py.
_HEIGHT_KM = np.array([0., 1., 2., 4., 8., 16., 32., 64., 96., 128., 192.,
                       256., 384., 512., 720.])
_SUN_ELEVATION = np.array([-90., -45., -30., -20., -15., -12., -10., -8., -6.,
                           -4., -2., -1., 0., 1., 2., 4., 6., 10., 15., 20.,
                           30., 35., 40., 45., 50., 55., 60., 75., 90.])
_SKY_WEIGHTS = np.full(3, 2*np.pi/3, dtype=np.float32)
for _array in (_HEIGHT_KM, _SUN_ELEVATION, _SKY_WEIGHTS):
    _array.setflags(write=False)


def _gain(value, name):
    value = float(value)
    if not np.isfinite(value) or value < 0:
        raise ValueError(f'{name} must be finite and nonnegative')
    return value


def solar_source(cloud_tau, air_transmission, visibility, mu, *, phase_g=.65,
                 multiple_scattering=1.):
    """Return N×3 scene-linear cloud source, before view opacity.

    ``mu = dot(camera_to_sample, sample_to_sun)``: +1 is forward scattering
    when looking toward the Sun. ``cloud_tau`` is a dimensionless Sun-path
    integral of the unchanged density. Clear-air RGB transmission and solar
    disc visibility multiply the completed order sum exactly once.

    The primary phase is a normalized 65% isotropic / 35% HG mixture. Thus the
    previous broad phase convention is retained, with its 4*pi normalization
    made explicit; air.SOLAR_RADIANCE supplies the same scene-relative solar
    scale as the atmosphere. No surface normal or Lambert factor is used.
    Three secondary orders halve cloud attenuation and anisotropy per order.
    Their weights fall geometrically, with a maximum ratio .7. A Sun-path
    interaction probability suppresses secondary light in the optically thin
    limit. This remains a directional closure, not an energy-conserving solve.
    """
    tau = np.asarray(cloud_tau, np.float64)
    if tau.ndim != 1 or np.any(~np.isfinite(tau)) or np.any(tau < 0):
        raise ValueError('Cloud optical depth must be a finite nonnegative N-vector')
    attenuation = np.broadcast_to(np.asarray(air_transmission, np.float64), (len(tau), 3))
    visible = np.broadcast_to(np.asarray(visibility, np.float64), tau.shape)
    cosine = np.broadcast_to(np.asarray(mu, np.float64), tau.shape)
    if (np.any(~np.isfinite(attenuation)) or np.any((attenuation < 0) | (attenuation > 1))
            or np.any(~np.isfinite(visible)) or np.any((visible < 0) | (visible > 1))):
        raise ValueError('Air transmission and solar visibility must be in [0, 1]')
    if np.any(~np.isfinite(cosine)) or np.any(np.abs(cosine) > 1+1e-6):
        raise ValueError('Scattering cosine must be in [-1, 1]')
    g = float(phase_g)
    if not np.isfinite(g) or not 0 <= g <= .95:
        raise ValueError('Cloud phase asymmetry must be in [0, .95]')
    multiple = _gain(multiple_scattering, 'Multiple scattering')
    cosine = np.clip(cosine, -1, 1)
    ratio = min(.7, .45*multiple)*(-np.expm1(-tau))
    source = np.zeros_like(tau)
    for order in range(4):
        phase = .65/(4*np.pi)+.35*air.phase_mie(cosine, g*(.5**order))
        source += ratio**order*np.exp(-tau*(.5**order))*phase
    return (air.SOLAR_RADIANCE*source[:, None]*attenuation*visible[:, None]).astype(np.float32)


@lru_cache(maxsize=4)
def _sky_lookup(strength, multiple_scattering, saturation):
    """Immutable clear-sky radiance table; at most four style variants/process.

    No weather/time cache and no cross-frame accumulation. Three fixed rays
    sample zenith and 45 degrees toward/away from the Sun's horizontal bearing.
    The Sun disc is absent: integrate_atmosphere_rays returns only scattered
    sky radiance. Its own bounded multiple-scattering approximation is retained.
    """
    diagonal = 1/np.sqrt(2.)
    directions = np.array([[0., 0., 1.], [diagonal, 0., diagonal], [-diagonal, 0., diagonal]])
    origins = np.zeros((len(_HEIGHT_KM), 3, 3))
    # A point exactly on the ground is an opaque zero-length hit in the shared
    # ray API. Start the first lookup sample one metre above it.
    origins[:, :, 2] = 1+np.maximum(_HEIGHT_KM, .001)[:, None]/air.EARTH_KM
    rays = np.broadcast_to(directions, origins.shape)
    table = np.empty((len(_SUN_ELEVATION), len(_HEIGHT_KM), 3, 3), np.float32)
    for index, elevation in enumerate(np.radians(_SUN_ELEVATION)):
        sun = np.array([np.cos(elevation), 0., np.sin(elevation)])
        table[index], _ = (value.reshape(len(_HEIGHT_KM), 3, 3) for value in
            air.integrate_atmosphere_rays(origins.reshape(-1, 3), rays.reshape(-1, 3), sun,
                view_samples=24, sun_samples=10, strength=strength,
                multiple_scattering=multiple_scattering, saturation=saturation))
    if not np.all(np.isfinite(table)) or np.any(table < 0):
        raise ValueError('Atmosphere produced invalid sky radiance')
    table.setflags(write=False)
    return table


def _bracket(grid, values):
    values = np.clip(values, grid[0], grid[-1])
    lower = np.clip(np.searchsorted(grid, values, side='right')-1, 0, len(grid)-2)
    blend = (values-grid[lower])/(grid[lower+1]-grid[lower])
    return lower, blend


def sky_samples(points, sun, *, strength=1., multiple_scattering=1., saturation=1.):
    """Return directions N×3×3, incoming RGB N×3×3, solid-angle weights (3,).

    Directions point from each sample toward the incident sky. Their phase
    cosine is ``dot(camera_to_sample, direction)``. The three positive weights
    sum to 2*pi, approximating the upper hemisphere; this sparse quadrature
    omits the below-horizontal sky visible at altitude and neighboring-cloud
    bounce. The caller must attenuate each direction with the same cloud
    density, and add dated city illumination independently.

    Altitude is measured directly in displayed Earth-radius coordinates, as
    used by atmosphere.py. Bilinear interpolation is continuous in altitude
    and local solar elevation, including twilight. There is no night floor or
    local day/night mask. A caller can reuse the lookup for lunar sky by passing
    one light direction per point and scaling its incoming RGB by lunar flux.

    At solar zenith/nadir, the horizontal bearing is undefined. In an 8.6-degree
    cone the oblique directions and their RGB smoothly collapse to zenith;
    this avoids an arbitrary azimuth flip at the cost of reduced sky quadrature.
    """
    point = np.asarray(points, np.float64)
    light = np.asarray(sun, np.float64)
    if point.ndim != 2 or point.shape[1] != 3 or not np.all(np.isfinite(point)):
        raise ValueError('Sky samples need finite N×3 Earth-fixed points')
    radius = np.linalg.norm(point, axis=-1)
    if np.any(radius < 1-1e-10):
        raise ValueError('Sky samples must be on or above the unit Earth')
    if (light.shape not in ((3,), point.shape) or not np.all(np.isfinite(light))
            or np.any(np.linalg.norm(light, axis=-1) == 0)):
        raise ValueError('Sky samples need finite nonzero light directions: 3 or N×3')
    styles = tuple(_gain(value, name) for value, name in
                   ((strength, 'Sky strength'), (multiple_scattering, 'Sky multiple scattering'),
                    (saturation, 'Sky saturation')))
    if len(point) == 0:
        return np.empty((0, 3, 3), np.float32), np.empty((0, 3, 3), np.float32), _SKY_WEIGHTS
    light = light/np.linalg.norm(light, axis=-1, keepdims=True)
    up = point/radius[:, None]
    cosine = np.clip(up@light if light.ndim == 1 else np.sum(up*light, axis=-1), -1, 1)
    tangent = light-up*cosine[:, None]
    tangent_length = np.linalg.norm(tangent, axis=-1)
    collapse = np.clip(tangent_length/.15, 0, 1)
    collapse = collapse*collapse*(3-2*collapse)
    tangent *= np.divide(collapse, tangent_length, out=np.zeros_like(collapse),
                         where=tangent_length > 0)[:, None]
    toward, away = up+tangent, up-tangent
    toward /= np.linalg.norm(toward, axis=-1, keepdims=True)
    away /= np.linalg.norm(away, axis=-1, keepdims=True)
    directions = np.stack((up, toward, away), axis=1)
    height, hw = _bracket(_HEIGHT_KM, (radius-1)*air.EARTH_KM)
    elevation, ew = _bracket(_SUN_ELEVATION, np.degrees(np.arcsin(cosine)))
    table = _sky_lookup(*styles)
    low = table[elevation, height]*(1-hw[:, None, None])+table[elevation, height+1]*hw[:, None, None]
    high = table[elevation+1, height]*(1-hw[:, None, None])+table[elevation+1, height+1]*hw[:, None, None]
    incoming = low*(1-ew[:, None, None])+high*ew[:, None, None]
    incoming[:, 1:] = incoming[:, :1]+collapse[:, None, None]*(incoming[:, 1:]-incoming[:, :1])
    return directions.astype(np.float32), incoming.astype(np.float32), _SKY_WEIGHTS


def _sky_sources_batched(cloud,points,rays,solar,lunar,lunar_rows,dt,fields,*,
                         strength,multiple_scattering,samples):
    """Batch unchanged sky paths, sharing the identical solar/lunar zenith.

    The incoming-radiance threshold remains per source and direction. Sharing
    a path never merges that threshold or the separate lunar visibility gain.
    CPU float64 geometry and the provider's density/sample count are retained.
    """
    directions,incoming,weights=solar
    lunar_directions,lunar_incoming,lunar_weights=lunar
    specifications=[]
    # Solar and lunar zenith both equal the same normalized point, independent
    # of light azimuth. Integrate their union exactly once; keep source weights
    # and ordered accumulation separate below.
    solar_active=np.any(incoming[:,0]>1e-7,axis=-1)
    lunar_active=np.any(lunar_incoming[:,0]>1e-7,axis=-1)
    zenith_active=solar_active.copy()
    zenith_active[lunar_rows[lunar_active]]=True
    zenith_rows=np.flatnonzero(zenith_active)
    specifications.append((zenith_rows,directions[zenith_rows,0]))
    for index in (1,2):
        rows=np.flatnonzero(np.any(incoming[:,index]>1e-7,axis=-1))
        specifications.append((rows,directions[rows,index]))
    for index in (1,2):
        rows=np.flatnonzero(np.any(lunar_incoming[:,index]>1e-7,axis=-1))
        specifications.append((lunar_rows[rows],lunar_directions[rows,index]))
    sizes=[len(rows) for rows,_ in specifications]
    if sum(sizes):
        depth=cloud._cloud_optical_depth(
            np.concatenate([points[rows] for rows,_ in specifications]),
            np.concatenate([direction for _,direction in specifications]),dt,
            fields=fields,strength=strength,samples=samples)
    else:
        depth=np.empty(0,np.float32)
    depths=np.split(depth,np.cumsum(sizes)[:-1])
    zenith_depth=np.zeros(len(points),np.float32)
    zenith_depth[zenith_rows]=depths[0]
    secondary=min(.6,.2*multiple_scattering)

    def accumulate(local_rays,local_incoming,local_directions,local_weights,entries):
        color=np.zeros((len(local_rays),3),np.float32)
        for index,(rows,tau) in enumerate(entries):
            if not len(rows):continue
            penetration=(1-secondary)*np.exp(-tau)+secondary*np.exp(-.35*tau)
            cosine=np.clip(np.sum(local_rays[rows]*local_directions[rows,index],axis=-1),-1,1)
            phase=(1-.2**2)/(1+.2**2-2*.2*cosine)**1.5
            color[rows]+=(local_weights[index]/(4*np.pi))*local_incoming[rows,index]*(penetration*phase)[:,None]
        return color

    solar_rows=np.flatnonzero(solar_active)
    sun_entries=[(solar_rows,zenith_depth[solar_rows])]
    sun_entries.extend((specifications[index][0],depths[index]) for index in (1,2))
    moon_rows=np.flatnonzero(lunar_active)
    moon_entries=[(moon_rows,zenith_depth[lunar_rows[moon_rows]])]
    for index in (1,2):
        rows=np.flatnonzero(np.any(lunar_incoming[:,index]>1e-7,axis=-1))
        moon_entries.append((rows,depths[index+2]))
    return (accumulate(rays,incoming,directions,weights,sun_entries),
            accumulate(rays[lunar_rows],lunar_incoming,lunar_directions,lunar_weights,moon_entries))


def sample_source_batched(cloud,points,rays,sun,weather_dt,fields,*,strength=None,
                          sun_samples=None,physical_dt=None,tile_points=16384):
    """Complete layered cloud source with exact bounded batching.

    No new quadrature, history, time quantization or spatial lookup is added.
    Existing cloud/air providers retain their selected backend and dated
    aerosol behavior. Direct Sun/Moon paths use one provider call each; sky
    uses one call with the shared zenith removed. Every lamp footprint and
    radial-column sample is retained. Legacy lighting and joint transport use
    the reference entry points. Backend failures propagate to the caller.
    """
    from camera_geometry import sphere_interval
    from moonlighting import lunar_illumination
    from quality import get_quality
    from solar_visibility import solar_visibility
    points=np.asarray(points);rays=np.asarray(rays)
    if (points.ndim!=2 or points.shape[1:]!=(3,) or rays.shape!=points.shape
            or not np.isfinite(points).all() or not np.isfinite(rays).all()):
        raise ValueError('Cloud source needs finite matching N×3 points and rays')
    if isinstance(tile_points,bool) or int(tile_points)!=tile_points or tile_points<1:
        raise ValueError('Cloud source tile must have a positive integer point count')
    count=get_quality().cloud_sun_steps if sun_samples is None else int(sun_samples)
    if count<1:raise ValueError('Cloud source needs positive light samples')
    sky_count=min(count,max(4,count//2))
    gain=cloud.TRIP.style.get('moonlight',4000.)
    if not np.isfinite(gain) or not 0<=gain<=20000:
        raise ValueError('Cloud moonlight must be finite and in [0, 20000]')
    phase_g=cloud.TRIP.style.get('cloud_phase_g',.65)
    multiple=cloud.TRIP.style.get('cloud_multiple_scattering',1.)
    sky_style=dict(strength=cloud.TRIP.style.get('atmosphere_strength',1.),
        multiple_scattering=cloud.TRIP.style.get('atmosphere_multiple_scattering',1.),
        saturation=cloud.TRIP.style.get('atmosphere_saturation',1.))
    result=np.zeros((len(points),3),np.float32)
    for offset in range(0,len(points),int(tile_points)):
        selection=slice(offset,offset+int(tile_points))
        point=points[selection];ray=rays[selection]
        visibility=solar_visibility(point,sun)
        sun_rows=np.flatnonzero(visibility>0)
        moon=None
        moon_rows=np.empty(0,np.int64)
        if physical_dt is not None and gain>0:
            moon=lunar_illumination(point,physical_dt,height_exaggeration=cloud.HEIGHT_EXAGGERATION)
            moon_rows=np.flatnonzero((moon.ratio>0)&(moon.visibility>0))
        moon_direction=np.empty((0,3)) if moon is None else moon.direction[moon_rows]
        direct_points=np.concatenate((point[sun_rows],point[moon_rows]))
        direct_directions=np.concatenate((np.broadcast_to(sun,(len(sun_rows),3)),moon_direction))
        cloud_depth=np.empty(0,np.float32);air_depth=np.empty((0,3),np.float32)
        if len(direct_points):
            cloud_depth=cloud._cloud_optical_depth(direct_points,direct_directions,weather_dt,
                fields=fields,strength=strength,samples=count)
            _,length,_=sphere_interval(direct_points,direct_directions,air.OUTER_KM/air.EARTH_KM)
            air_depth=air.optical_depth(direct_points,direct_directions,length,
                samples=get_quality().atmosphere_sun_steps,weather_dt=weather_dt)
        sun_cloud=np.zeros(len(point),np.float32);sun_air=np.zeros((len(point),3),np.float32)
        sun_cloud[sun_rows]=cloud_depth[:len(sun_rows)]
        sun_air[sun_rows]=air_depth[:len(sun_rows)]
        color=solar_source(sun_cloud,np.exp(-sun_air),visibility,np.clip(ray@sun,-1,1),
            phase_g=phase_g,multiple_scattering=multiple)
        solar=sky_samples(point,sun,**sky_style)
        lunar=sky_samples(point[moon_rows],moon_direction,**sky_style)
        sky,moon_sky=_sky_sources_batched(cloud,point,ray,solar,lunar,moon_rows,
            weather_dt,fields,strength=strength,multiple_scattering=multiple,samples=sky_count)
        color+=sky
        # Preserve the reference source addition order: solar + city + Moon.
        color+=cloud._city_source(point,weather_dt,sun,physical_dt,fields,
                                  strength=strength,batched=True)
        if len(moon_rows):
            source=solar_source(cloud_depth[len(sun_rows):],np.exp(-air_depth[len(sun_rows):]),
                moon.visibility[moon_rows],np.clip(np.sum(ray[moon_rows]*moon_direction,axis=-1),-1,1),
                phase_g=phase_g,multiple_scattering=multiple)
            source+=moon.visibility[moon_rows,None]*moon_sky
            color[moon_rows]+=source*(moon.ratio[moon_rows,None]*gain)
        result[selection]=color
    return result
