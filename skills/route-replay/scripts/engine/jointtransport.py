"""Optional cloud/air transport through one ordered spherical volume.

Cloud and air extinction are added before every view-path transfer. Both direct
sources see the same cloud-plus-air Sun attenuation. Density, cinematic height
scales and scene-relative units match the layered path. Both paths share the
cloud lighting source and its legacy blend control. This couples single
scattering and extinction, not all light paths: finite-order solar scattering
and three-direction sky illumination remain approximations. City illumination
uses a bounded local ground-to-cloud closure;
terrain shadows and full surface-to-volume multiple bounce are not solved.
"""
import os
import numpy as np
from PIL import Image

import atmosphere as air
import cloudvolume as cloud
from camera_geometry import pixel_rays, sphere_interval
from quality import get_quality
from radiometry import TransportLayer, resize_float
from runtime import TRIP
from weatherfields import timestamp
from solar_visibility import solar_visibility, shadow_boundaries, split_intervals


def segment_transport(optical_depth, source_integral):
    """Exact constant-coefficient transfer for a mixed segment.

    Both inputs are RGB: optical depth is the *sum* of medium extinctions;
    source_integral is the sum of emission/scattering coefficients times path
    length. The thin limit is finite, including an empty segment.
    """
    tau=np.asarray(optical_depth,np.float64)
    source=np.asarray(source_integral,np.float64)
    if np.any(~np.isfinite(tau)) or np.any(tau<0) or np.any(~np.isfinite(source)) or np.any(source<0):
        raise ValueError('Segment optical depth and source must be finite and nonnegative')
    opacity=-np.expm1(-tau)
    integral=np.divide(opacity,tau,out=np.ones_like(tau),where=tau>0)
    return source*integral,np.exp(-tau)


def _radii(with_clouds,with_atmosphere):
    heights=[0.]
    if with_clouds:
        heights.extend(np.arange(0,cloud.MAX_ALTITUDE_M+cloud.VERTICAL_STEP_M,
                                 cloud.VERTICAL_STEP_M)*cloud.HEIGHT_EXAGGERATION/1000.)
    if with_atmosphere:
        # Resolve dense lower air as well as the much thinner upper atmosphere.
        heights.extend(np.array([0,1,2,4,8,16,32,64,100])*air.VISIBILITY_SCALE)
    return 1+np.unique(heights)/air.EARTH_KM


def _segments(origins,rays,radii,start,stop,substeps):
    """Near and far shell halves in camera order, including tangent rays."""
    intervals=[sphere_interval(origins,rays,radius) for radius in radii]
    closest=-np.sum(origins*rays,axis=-1)
    halves=[]
    for index in range(len(radii)-2,-1,-1):
        lower,upper=intervals[index],intervals[index+1]
        halves.append((upper[0],np.where(lower[2],lower[0],closest),upper[2]))
    for index in range(len(radii)-1):
        lower,upper=intervals[index],intervals[index+1]
        halves.append((np.where(lower[2],lower[1],closest),upper[1],upper[2]))
    for a,b,hit in halves:
        for j in range(substeps):
            begin=np.maximum(a+(b-a)*(j/substeps),start)
            end=np.minimum(a+(b-a)*((j+1)/substeps),stop)
            yield begin,end,hit&(end>begin)


def _air_coefficients(points):
    height=(np.linalg.norm(points,axis=-1)-1)*air.EARTH_KM
    valid=(height>=0)&(height<air.OUTER_KM-air.EARTH_KM)
    rayleigh=np.exp(-np.maximum(height,0)/air.H_R)*valid
    mie=np.exp(-np.maximum(height,0)/air.H_M)*valid
    return rayleigh,mie


def _cloud_density(points,dt,fields,strength,*,normals=False):
    radius=np.linalg.norm(points,axis=-1)
    inside=(radius>=1)&(radius<=1+cloud.MAX_ALTITUDE_M*cloud.HEIGHT_EXAGGERATION/cloud.EARTH_M)
    sigma=np.zeros(len(points),np.float64)
    normal=points/np.maximum(radius[:,None],1e-12)
    if np.any(inside):
        sigma[inside],normal[inside]=cloud._density(points[inside],dt,fields=fields,
                                                   normals=normals,strength=strength)
    return sigma,normal


def solar_optical_depth(points,sun,dt,*,fields=None,with_clouds=True,with_atmosphere=True,
                        cloud_strength=1.,cloud_samples=8,atmosphere_samples=10):
    """Cloud scalar and air RGB optical depth on the same normalized Sun ray.

    Each medium integrates only its sphere interval, including entry from
    outside that sphere. Solid-Earth visibility is handled by the caller.
    """
    points=np.asarray(points,np.float64).reshape(-1,3)
    air_tau=np.zeros((len(points),3),np.float64);cloud_tau=np.zeros(len(points),np.float64)
    if with_atmosphere:
        near,far,hit=sphere_interval(points,sun,air.OUTER_KM/air.EARTH_KM)
        active=hit&(far>near)
        if np.any(active):
            air_tau[active]=air.optical_depth(points[active]+sun*near[active,None],sun,
                                              far[active]-near[active],samples=atmosphere_samples,weather_dt=dt)
    if with_clouds and cloud_strength>0:
        outer=1+cloud.MAX_ALTITUDE_M*cloud.HEIGHT_EXAGGERATION/cloud.EARTH_M
        near,far,hit=sphere_interval(points,sun,outer)
        active=hit&(far>near)&(solar_visibility(points,sun)>0)
        if np.any(active):
            start=near[active];length=far[active]-start
            if os.environ.get('FLIGHT_COMPUTE','cpu')=='metal':
                from metal_clouds import cloud_interval_optical_depth
                selected_fields=cloud._frame_fields(timestamp(dt)) if fields is None else fields
                cloud_tau[active]=cloud_interval_optical_depth(points[active],sun,start,length/cloud_samples,
                    selected_fields,noise=cloud._NOISE,samples=cloud_samples,strength=cloud_strength,
                    height_exaggeration=cloud.HEIGHT_EXAGGERATION,morphology=TRIP.style.get('cloud_morphology',1.))
            else:
                step=length*cloud.EARTH_M/cloud.HEIGHT_EXAGGERATION/cloud_samples
                for index in range(cloud_samples):
                    query=points[active]+sun*(start+(index+.5)*length/cloud_samples)[:,None]
                    sigma,_=_cloud_density(query,dt,fields,cloud_strength)
                    cloud_tau[active]+=sigma*step
    return cloud_tau,air_tau


def integrate_joint_rays(origins,rays,sun,dt,*,depth=None,fields=None,with_clouds=True,
                         with_atmosphere=True,substeps=1,cloud_sun_samples=8,
                         atmosphere_sun_samples=10,cloud_strength=1.,cloud_phase_g=.65,
                         cloud_multiple_scattering=1.,atmosphere_strength=1.,
                         atmosphere_multiple_scattering=1.,atmosphere_saturation=1.,physical_dt=None,
                         cloud_lighting=1.,cloud_moonlight=None):
    """Joint view transport as N×3 radiance and RGB transmission arrays.

    Inputs use Earth radii and normalized world-space rays. Positive ``depth``
    terminates at the opaque surface; zero/infinity means no surface hit.
    ``fields`` may supply the cloud module's immutable per-time field tuple.
    Disabling clouds avoids weather I/O entirely. Disabling air is a numerical
    diagnostic; the public scene wrapper always includes air.
    """
    counts=(substeps,cloud_sun_samples,atmosphere_sun_samples)
    if any(not np.isfinite(x) or int(x)!=x or x<1 for x in counts):
        raise ValueError('Joint transport requires positive integer sample counts')
    substeps,cloud_sun_samples,atmosphere_sun_samples=map(int,counts)
    gains=(cloud_strength,cloud_multiple_scattering,atmosphere_strength,
           atmosphere_multiple_scattering,atmosphere_saturation)
    if any(not np.isfinite(x) or x<0 for x in gains) or not 0<=cloud_phase_g<=.95 or not 0<=cloud_lighting<=1:
        raise ValueError('Joint transport gains must be finite/nonnegative, phase g within [0,.95], and cloud lighting within [0,1]')
    if cloud_moonlight is not None and (not np.isfinite(cloud_moonlight) or not 0<=cloud_moonlight<=20000):
        raise ValueError('Cloud moonlight must be finite and in [0, 20000]')
    rays=np.asarray(rays,np.float64).reshape(-1,3)
    origins=np.broadcast_to(np.asarray(origins,np.float64),rays.shape)
    sun=np.asarray(sun,np.float64)
    if (sun.shape!=(3,) or not np.all(np.isfinite(sun)) or np.linalg.norm(sun)==0 or
            not np.all(np.isfinite(origins)) or not np.all(np.isfinite(rays)) or
            not np.allclose(np.linalg.norm(rays,axis=-1),1,atol=1e-5)):
        raise ValueError('Joint transport needs finite origins, unit rays and a nonzero Sun direction')
    # Correct only accepted floating-point drift; malformed directions still fail.
    rays=rays/np.linalg.norm(rays,axis=-1,keepdims=True)
    sun=sun/np.linalg.norm(sun)
    with_clouds=bool(with_clouds and cloud_strength>0)
    radiance=np.zeros((len(rays),3),np.float64);transmission=np.ones_like(radiance)
    if not with_clouds and not with_atmosphere:return radiance,transmission
    radii=_radii(with_clouds,with_atmosphere)
    start,stop,hit=sphere_interval(origins,rays,radii[-1])
    ground,_,ground_hit=sphere_interval(origins,rays,1.)
    stop=np.where(ground_hit,np.minimum(stop,ground),stop)
    if depth is not None:
        depth=np.broadcast_to(np.asarray(depth,np.float64).ravel(),start.shape)
        if np.any(np.isnan(depth)) or np.any(depth<0):raise ValueError('Depth must be nonnegative and not NaN')
        stop=np.where(depth>0,np.minimum(stop,depth),stop)
    active_path=hit&(stop>start)
    if not np.any(active_path):return radiance,transmission
    if with_clouds and fields is None:fields=cloud._frame_fields(timestamp(dt))
    mu=np.clip(rays@sun,-1,1)
    pr,pm=air.phase_rayleigh(mu),air.phase_mie(mu)
    probability=min(.60,.38*atmosphere_multiple_scattering)
    secondary_gain=probability/(1-probability)
    boundaries=shadow_boundaries(origins,rays,sun)
    moon_gain=TRIP.style.get('moonlight',4000.) if cloud_moonlight is None else cloud_moonlight
    if physical_dt is not None and moon_gain>0 and with_atmosphere:
        from moonlighting import _frame_geometry
        moon=_frame_geometry(physical_dt)[0]
        boundaries=np.column_stack((boundaries,shadow_boundaries(origins,rays,moon/np.linalg.norm(moon))))
    intervals=_segments(origins,rays,radii,start,stop,substeps)
    for begin,end,segment_hit in split_intervals(intervals,boundaries):
        active=active_path&segment_hit&(np.max(transmission,axis=-1)>1e-7)
        if not np.any(active):continue
        index=np.flatnonzero(active);step=end[active]-begin[active]
        point=origins[active]+rays[active]*((begin[active]+end[active])*.5)[:,None]
        cosine=(point@sun)/np.linalg.norm(point,axis=-1)
        tau_air=np.zeros((len(index),3));air_source=np.zeros_like(tau_air)
        tau_cloud=np.zeros(len(index));cloud_source=np.zeros_like(tau_air)
        solar_cloud,solar_air=solar_optical_depth(point,sun,dt,fields=fields,
            with_clouds=with_clouds,with_atmosphere=with_atmosphere,cloud_strength=cloud_strength,
            cloud_samples=cloud_sun_samples,atmosphere_samples=atmosphere_sun_samples)
        solar=np.exp(-solar_air-solar_cloud[:,None])
        solar*=solar_visibility(point,sun)[:,None]
        if with_atmosphere:
            sr,sm=_air_coefficients(point);sr*=step*air.EARTH_KM;sm*=step*air.EARTH_KM
            from environmentlighting import aerosol_segment_depth, SINGLE_SCATTER_ALBEDO
            extra_tau=aerosol_segment_depth(point,rays[index],step,dt)
            tau_air=sr[:,None]*air.BETA_R+sm[:,None]*air.MIE_EXTINCTION+extra_tau
            single=(sr[:,None]*air.BETA_R*pr[index,None]+sm[:,None]*air.BETA_M*pm[index,None])*solar
            single+=extra_tau*SINGLE_SCATTER_ALBEDO*pm[index,None]*solar
            hemisphere=cloud._smoothstep(-.18,.12,cosine)
            secondary=(sr[:,None]*air.BETA_R+sm[:,None]*air.BETA_M)/(4*np.pi)
            secondary*=secondary_gain*(1-np.exp(-np.minimum(solar_air,8)))*hemisphere[:,None]
            secondary*=np.exp(-solar_cloud[:,None])
            from lunar_scattering import atmosphere_source
            lunar=atmosphere_source(point,rays[index],sr,sm,physical_dt,dt,
                gain=moon_gain,with_clouds=with_clouds,samples=atmosphere_sun_samples,extra_tau=extra_tau,
                fields=fields,cloud_strength=cloud_strength,cloud_samples=cloud_sun_samples,
                shared_cloud_geometry=True)
            air_source=(single+secondary+lunar)*air.SOLAR_RADIANCE*atmosphere_strength
            luma=air_source@np.array([.2126,.7152,.0722])
            air_source=np.maximum(luma[:,None]+(air_source-luma[:,None])*atmosphere_saturation,0)
        if with_clouds:
            sigma,normal=_cloud_density(point,dt,fields,cloud_strength,normals=cloud_lighting<1)
            tau_cloud=sigma*step*cloud.EARTH_M/cloud.HEIGHT_EXAGGERATION
            color=np.zeros((len(point),3),np.float32)
            occupied=sigma>1e-9
            if np.any(occupied):
                color[occupied]=cloud._cloud_source(point[occupied],rays[index[occupied]],sun,dt,fields,
                    sigma[occupied],normal[occupied],solar_cloud[occupied],solar_air[occupied],
                    strength=cloud_strength,phase_g=cloud_phase_g,multiple_scattering=cloud_multiple_scattering,
                    lighting=cloud_lighting,with_atmosphere=with_atmosphere,
                    atmosphere_strength=atmosphere_strength,atmosphere_multiple_scattering=atmosphere_multiple_scattering,
                    atmosphere_saturation=atmosphere_saturation,sun_samples=cloud_sun_samples)
                color[occupied]+=cloud._city_source(point[occupied],dt,sun,physical_dt,fields,
                                                    strength=cloud_strength)
                color[occupied]+=cloud._moon_source(point[occupied],rays[index[occupied]],dt,physical_dt,fields,
                    strength=cloud_strength,moonlight=cloud_moonlight,phase_g=cloud_phase_g,
                    multiple_scattering=cloud_multiple_scattering,with_atmosphere=with_atmosphere,
                    atmosphere_strength=atmosphere_strength,atmosphere_multiple_scattering=atmosphere_multiple_scattering,
                    atmosphere_saturation=atmosphere_saturation,cloud_samples=cloud_sun_samples,
                    atmosphere_samples=atmosphere_sun_samples)
            cloud_source=tau_cloud[:,None]*color
        local_light,local_t=segment_transport(tau_air+tau_cloud[:,None],air_source+cloud_source)
        radiance[index]+=transmission[index]*local_light
        transmission[index]*=local_t
    return radiance.astype(np.float32),transmission.astype(np.float32)


def joint_transport(bs,sun,dt,radius,size=(1080,1920),center=(540,960),surface_depth=None,
                    *,depth=None,camera_rays=None,scale=None,sensor_width=1080,with_clouds=True,
                    substeps=None,cloud_sun_samples=None,atmosphere_sun_samples=None,physical_dt=None):
    """Scene/crop TransportLayer; use once instead of the two separate layers.

    A crop retains sensor_width=1080 and can use scale=1 with the same filled
    aircraft depth as the existing pipeline. Apply the returned source only to
    aircraft alpha; no opacity/alpha is inferred from RGB transmission here.
    """
    quality=get_quality()
    if depth is not None and surface_depth is not None:raise ValueError('Pass depth or surface_depth, not both')
    depth=surface_depth if depth is None else depth
    if camera_rays is None:
        origin,rays=pixel_rays(radius,size,center,scale=quality.atmosphere_scale if scale is None else scale,
                               sensor_width=sensor_width)
        origin=origin@np.asarray(bs);rays=rays@np.asarray(bs)
    else:origin,rays=map(np.asarray,camera_rays)
    shape=rays.shape[:2]
    if depth is not None:
        if np.asarray(depth).ndim!=2:raise ValueError('Depth must be a 2D ray-distance image')
        depth=resize_float(np.asarray(depth,np.float32),(shape[1],shape[0]),Image.Resampling.NEAREST).ravel()
    if origin.shape!=(3,):origin=origin.reshape(-1,3)
    light,transmission=integrate_joint_rays(origin,rays.reshape(-1,3),sun,dt,depth=depth,
        with_clouds=with_clouds,substeps=quality.cloud_substeps if substeps is None else substeps,
        cloud_sun_samples=quality.cloud_sun_steps if cloud_sun_samples is None else cloud_sun_samples,
        atmosphere_sun_samples=quality.atmosphere_sun_steps if atmosphere_sun_samples is None else atmosphere_sun_samples,
        cloud_strength=TRIP.style.get('cloud_strength',1.),cloud_phase_g=TRIP.style.get('cloud_phase_g',.65),
        cloud_multiple_scattering=TRIP.style.get('cloud_multiple_scattering',1.),
        cloud_lighting=TRIP.style.get('cloud_lighting',1.),
        cloud_moonlight=TRIP.style.get('moonlight',4000.),
        atmosphere_strength=TRIP.style.get('atmosphere_strength',1.),
        atmosphere_multiple_scattering=TRIP.style.get('atmosphere_multiple_scattering',1.),
        atmosphere_saturation=TRIP.style.get('atmosphere_saturation',1.),physical_dt=physical_dt)
    return TransportLayer(resize_float(light.reshape(*shape,3),size),
                          np.clip(resize_float(transmission.reshape(*shape,3),size),0,1))
