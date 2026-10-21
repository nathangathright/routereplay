"""Curved atmospheric transport with bounded approximate multiple scattering.

Rayleigh/Mie optical depth follows spherical paths, including Earth shadow and
terrain/aircraft termination. The secondary-light term is a bounded local
isotropic closure, not a full angular scattering solution or calibrated sky.
A cinematic 7.2x height spread compensates extinction by 7.2. All output remains
scene-relative linear RGB; exposure, tone mapping and gamma belong to display.
"""
import os
import numpy as np
from PIL import Image
from camera_geometry import pixel_rays, sphere_interval
from radiometry import TransportLayer, resize_float, linear_to_srgb
from quality import get_quality
from runtime import TRIP
from solar_visibility import solar_visibility, shadow_boundaries

EARTH_KM=6371.0
VISIBILITY_SCALE=7.2
OUTER_KM=EARTH_KM+100.*VISIBILITY_SCALE
H_R=8.*VISIBILITY_SCALE
H_M=1.2*VISIBILITY_SCALE
BETA_R=np.array([.0058,.0135,.0331],np.float32)/VISIBILITY_SCALE
BETA_M=.0030/VISIBILITY_SCALE
MIE_EXTINCTION=BETA_M/.9
SOLAR_RADIANCE=11.4


def phase_rayleigh(mu):
    return 3/(16*np.pi)*(1+np.asarray(mu)**2)


def phase_mie(mu,g=.76):
    return (1-g*g)/(4*np.pi*np.maximum(1+g*g-2*g*np.asarray(mu),1e-8)**1.5)


def earth_shadow(points,sun):
    """Opaque unit-Earth intersection along a normalized Sun direction."""
    points=np.asarray(points,np.float64);sun=np.asarray(sun,np.float64)
    toward=points@sun
    return (toward<0)&(np.sum(points*points,axis=-1)-toward*toward<1.)


def optical_depth(points,directions,length,*,samples=10,weather_dt=None,method=None):
    """Spherical atmospheric optical depth for forward normalized-ray segments.

    Points and lengths use Earth radii. Integration excludes density below
    ground, leaving solid-body visibility to the explicit Earth-shadow test.
    """
    if samples<1:raise ValueError('Optical depth requires positive samples')
    from environmentlighting import aerosol_optical_depth, product
    extra=(aerosol_optical_depth(points,directions,length,weather_dt,samples=int(samples))
           if weather_dt is not None and product('aerosol') is not None else None)
    selected=method or os.environ.get('FLIGHT_ATMOSPHERE_METHOD','integrate')
    if selected not in ('integrate','lookup'):
        raise ValueError('Atmosphere method must be integrate or lookup')
    if selected=='lookup' and os.environ.get('FLIGHT_COMPUTE','cpu')!='metal':
        from atmosphere_lookup import optical_depth_lookup
        result,eligible=optical_depth_lookup(points,directions,length,samples=samples,
            constants=[EARTH_KM,OUTER_KM-EARTH_KM,H_R,H_M,*BETA_R,MIE_EXTINCTION])
        if np.any(eligible):
            if not np.all(eligible):
                shape=eligible.shape
                p=np.broadcast_to(np.asarray(points),shape+(3,))[~eligible]
                d=np.broadcast_to(np.asarray(directions),shape+(3,))[~eligible]
                extent=np.broadcast_to(np.asarray(length),shape)[~eligible]
                result[~eligible]=optical_depth(p,d,extent,samples=samples,method='integrate')
            return result if extra is None else result+extra
    if os.environ.get('FLIGHT_COMPUTE','cpu') == 'metal':
        from metal_compute import optical_depth as metal_optical_depth
        result=metal_optical_depth(points,directions,length,samples=samples,
            constants=[EARTH_KM,OUTER_KM-EARTH_KM,H_R,H_M,*BETA_R,MIE_EXTINCTION],
            lookup=selected=='lookup')
        return result if extra is None else result+extra
    points=np.asarray(points,np.float64);directions=np.asarray(directions,np.float64)
    length=np.maximum(np.asarray(length,np.float64),0)
    sr=np.zeros_like(length);sm=np.zeros_like(length);step=length*EARTH_KM/samples
    for index in range(samples):
        query=points+directions*((index+.5)*length/samples)[...,None]
        height=(np.linalg.norm(query,axis=-1)-1)*EARTH_KM
        valid=(height>=0)&(height<OUTER_KM-EARTH_KM)
        sr+=np.exp(-np.maximum(height,0)/H_R)*step*valid
        sm+=np.exp(-np.maximum(height,0)/H_M)*step*valid
    result=sr[...,None]*BETA_R+sm[...,None]*MIE_EXTINCTION
    return result if extra is None else result+extra


def integrate_atmosphere_rays(origins,rays,sun,*,depth=None,view_samples=24,
                              sun_samples=10,strength=1.,multiple_scattering=1.,saturation=1.,
                              physical_dt=None,weather_dt=None,with_clouds=False,moon_gain=None):
    """Pure spherical transport for arbitrary rays, returned as N×3 arrays.

    ``depth`` is positive distance to an opaque hit (zero/infinity means none).
    Multiple scattering is an isotropic local closure with a maximum return
    probability .60. Its geometric series is bounded, including in twilight.
    """
    if view_samples<1 or sun_samples<1:raise ValueError('Atmosphere requires positive sample counts')
    if min(strength,multiple_scattering,saturation)<0:raise ValueError('Atmosphere gains must be nonnegative')
    rays=np.asarray(rays,np.float64).reshape(-1,3)
    rays=rays/np.linalg.norm(rays,axis=-1,keepdims=True)
    origins=np.broadcast_to(np.asarray(origins,np.float64),rays.shape)
    sun=np.asarray(sun,np.float64);sun=sun/np.linalg.norm(sun)
    near,far,hit=sphere_interval(origins,rays,OUTER_KM/EARTH_KM)
    ground,_,ground_hit=sphere_interval(origins,rays,1.)
    end=np.where(ground_hit,np.minimum(ground,far),far)
    if depth is not None:
        depth=np.broadcast_to(np.asarray(depth,np.float64).ravel(),near.shape)
        end=np.where(depth>0,np.minimum(end,depth),end)
    valid=hit&(end>near)
    light=np.zeros((len(rays),3),np.float32);transmission=np.ones((len(rays),3),np.float32)
    if not np.any(valid):return light,transmission
    ray,origin=rays[valid],origins[valid];start=near[valid]
    gain=TRIP.style.get('moonlight',4000.) if moon_gain is None else moon_gain
    from environmentlighting import product, AEROSOL_HEIGHT_KM
    # Retain the uniform budget, inserting analytic shadow crossings. Extra
    # intervals collapse continuously as a boundary enters/leaves the path.
    # This resolves the discontinuous source without globally oversampling.
    edges=start[:,None]+(end[valid]-start)[:,None]*np.linspace(0,1,view_samples+1)
    crossings=np.clip(shadow_boundaries(origin,ray,sun),start[:,None],end[valid,None])
    if physical_dt is not None and gain>0:
        from moonlighting import _frame_geometry
        moon=_frame_geometry(physical_dt)[0]
        # Parallel lunar center crossings improve quadrature; the actual source
        # below retains finite-distance parallax and physical-height visibility.
        lunar_crossings=np.clip(shadow_boundaries(origin,ray,moon/np.linalg.norm(moon)),start[:,None],end[valid,None])
        crossings=np.column_stack((crossings,lunar_crossings))
    if weather_dt is not None and product('aerosol') is not None:
        # Resolve the exponential aerosol layer independently of the coarse
        # camera budget. Dense lower intervals and widening high intervals
        # preserve the column with Gaussian segment integration, without a
        # large per-ray table of nearly empty upper-atmosphere shells.
        extra=[]
        for height in np.array([0.,.5,1.,2.,3.,4.,6.,8.,12.,16.])*AEROSOL_HEIGHT_KM:
            a,b,hit=sphere_interval(origin,ray,1+height/EARTH_KM)
            for boundary in (a,b):
                extra.append(np.clip(np.where(hit,boundary,start),start,end[valid]))
        crossings=np.column_stack((crossings,*extra))
    edges=np.sort(np.column_stack((edges,crossings)),axis=-1)
    selected=os.environ.get('FLIGHT_ATMOSPHERE_VIEW','reference')
    if selected not in ('reference','batched'):
        raise ValueError('Atmosphere view must be reference or batched')
    integrator=_integrate_atmosphere_segments
    if selected=='batched' and os.environ.get('FLIGHT_COMPUTE','cpu')=='metal':
        from metal_atmosphere import integrate_segments
        integrator=integrate_segments
    radiance,view_tau=integrator(origin,ray,sun,edges,sun_samples=sun_samples,
        multiple_scattering=multiple_scattering,physical_dt=physical_dt,
        weather_dt=weather_dt,with_clouds=with_clouds,gain=gain)
    radiance*=SOLAR_RADIANCE*strength
    luma=radiance@np.array([.2126,.7152,.0722])
    radiance=np.maximum(luma[:,None]+(radiance-luma[:,None])*saturation,0)
    light[valid]=radiance;transmission[valid]=np.exp(-view_tau)
    return light,transmission


def _integrate_atmosphere_segments(origin,ray,sun,edges,*,sun_samples,
        multiple_scattering,physical_dt,weather_dt,with_clouds,gain):
    """Reference front-to-back transport over already clipped float64 intervals."""
    from environmentlighting import aerosol_segment_depth, SINGLE_SCATTER_ALBEDO
    from lunar_scattering import atmosphere_source
    mu=np.clip(ray@sun,-1,1);pr,pm=phase_rayleigh(mu),phase_mie(mu)
    view_tau=np.zeros((len(ray),3),np.float64);radiance=np.zeros_like(view_tau)
    probability=min(.60,.38*multiple_scattering)
    secondary_gain=probability/(1-probability)
    for begin,finish in zip(edges[:,:-1].T,edges[:,1:].T):
        active=finish>begin
        if not np.any(active):continue
        step=finish[active]-begin[active];step_km=step*EARTH_KM
        point=origin[active]+ray[active]*((begin[active]+finish[active])*.5)[:,None]
        height=np.maximum((np.linalg.norm(point,axis=-1)-1)*EARTH_KM,0)
        sr=np.exp(-height/H_R)*step_km;sm=np.exp(-height/H_M)*step_km
        extra_tau=aerosol_segment_depth(point,ray[active],step,weather_dt)
        segment_tau=sr[:,None]*BETA_R+sm[:,None]*MIE_EXTINCTION+extra_tau
        observer=np.exp(-(view_tau[active]+.5*segment_tau))
        _,solar_length,_=sphere_interval(point,sun,OUTER_KM/EARTH_KM)
        solar_tau=optical_depth(point,sun,solar_length,samples=sun_samples,weather_dt=weather_dt)
        solar=np.exp(-solar_tau)*solar_visibility(point,sun)[:,None]
        scatter=sr[:,None]*BETA_R*pr[active,None]+sm[:,None]*BETA_M*pm[active,None]
        scatter+=extra_tau*SINGLE_SCATTER_ALBEDO*pm[active,None]
        single=solar*scatter
        # Lit upper atmosphere remains visible briefly past the geometric
        # terminator. The local hemispheric illumination proxy vanishes by
        # ~10 degrees of solar depression, preventing a uniform night rim.
        cosine=(point@sun)/np.linalg.norm(point,axis=-1)
        hemisphere=np.clip((cosine+.18)/.30,0,1)
        hemisphere=hemisphere*hemisphere*(3-2*hemisphere)
        scattered_fraction=1-np.exp(-np.minimum(solar_tau,8))
        secondary=(sr[:,None]*BETA_R+sm[:,None]*BETA_M)/(4*np.pi)
        secondary*=secondary_gain*scattered_fraction*hemisphere[:,None]
        lunar=atmosphere_source(point,ray[active],sr,sm,physical_dt,weather_dt,
            gain=gain,with_clouds=with_clouds,samples=sun_samples,extra_tau=extra_tau)
        radiance[active]+=observer*(single+secondary+lunar)
        view_tau[active]+=segment_tau
    return radiance,view_tau


def atmosphere_transport(bs,sun,radius,size=(1080,1920),center=(540,960),surface_depth=None,
                         *,depth=None,camera_rays=None,scale=None,sensor_width=1080,
                         view_samples=None,sun_samples=None,strength=None,multiple_scattering=None,
                         saturation=None,physical_dt=None,weather_dt=None,with_clouds=False):
    """Return a float RGB transport layer clipped by terrain or aircraft depth.

    Geometry is the shared perspective camera. Optional ``camera_rays`` are
    world-space (origin,H×W×3 normalized directions). ``size`` and ``center``
    permit the 224×224 aircraft crop while retaining the full sensor width.
    Spatial reconstruction changes only generated camera-ray sampling; an
    explicit ray grid retains its original integration and resizing contract.
    """
    quality=get_quality()
    if depth is not None and surface_depth is not None:raise ValueError('Pass depth or surface_depth, not both')
    depth=surface_depth if depth is None else depth
    selected=os.environ.get('FLIGHT_VOLUME_RECONSTRUCTION','reference')
    if selected not in ('reference','adaptive','full'):
        raise ValueError('Volume reconstruction must be reference, adaptive or full')
    options=dict(
        view_samples=quality.atmosphere_view_steps if view_samples is None else view_samples,
        sun_samples=quality.atmosphere_sun_steps if sun_samples is None else sun_samples,
        strength=TRIP.style.get('atmosphere_strength',1.) if strength is None else strength,
        multiple_scattering=TRIP.style.get('atmosphere_multiple_scattering',1.) if multiple_scattering is None else multiple_scattering,
        saturation=TRIP.style.get('atmosphere_saturation',1.) if saturation is None else saturation,
        physical_dt=physical_dt,weather_dt=weather_dt,with_clouds=with_clouds)
    if camera_rays is None:
        requested_scale=quality.atmosphere_scale if scale is None else scale
        if selected in ('adaptive','full') and requested_scale>1:
            return _reconstruct_atmosphere(bs,sun,radius,size,center,depth,
                scale=requested_scale,sensor_width=sensor_width,mode=selected,**options)
        if selected=='full':scale=1
    if camera_rays is None:
        origin,rays=pixel_rays(radius,size,center,scale=quality.atmosphere_scale if scale is None else scale,
                               sensor_width=sensor_width)
        origin=origin@np.asarray(bs);rays=rays@np.asarray(bs)
    else:origin,rays=map(np.asarray,camera_rays)
    shape=rays.shape[:2]
    if depth is not None:
        if np.asarray(depth).ndim!=2:raise ValueError('Depth must be a 2D ray-distance image')
        depth=resize_float(np.asarray(depth,np.float32),(shape[1],shape[0]),Image.Resampling.NEAREST).ravel()
    light,transmission=integrate_atmosphere_rays(origin,rays.reshape(-1,3),sun,depth=depth,**options)
    return TransportLayer(resize_float(light.reshape(*shape,3),size),
                          np.clip(resize_float(transmission.reshape(*shape,3),size),0,1))


def _reconstruct_atmosphere(bs,sun,radius,size,center,depth,*,scale,sensor_width,mode,**options):
    """Reconstruct unchanged air transport with exact opaque/shell guides."""
    from camera_geometry import pixel_rays_at
    from volume_reconstruction import reconstruct_transport, sample_depth
    if depth is not None:
        if np.asarray(depth).ndim!=2:raise ValueError('Depth must be a 2D ray-distance image')
        depth=resize_float(np.asarray(depth,np.float32),size,Image.Resampling.NEAREST)
    basis=np.asarray(bs)

    def sample(xy):
        origin,rays=pixel_rays_at(radius,xy,center=center,sensor_width=sensor_width)
        return integrate_atmosphere_rays(origin@basis,rays@basis,sun,
            depth=None if depth is None else sample_depth(depth,xy),**options)

    if mode=='full':
        return reconstruct_transport(size,scale,sample,mode='full')

    def geometry(xy):
        # Classify the ray actually sampled, including fractional coarse centres.
        # User depth retains the same nearest-output-pixel lookup as transport.
        origin,rays=pixel_rays_at(radius,xy,center=center,sensor_width=sensor_width)
        origin=np.asarray(origin@basis,np.float64);rays=np.asarray(rays@basis,np.float64)
        rays/=np.linalg.norm(rays,axis=-1,keepdims=True)
        near,far,hit=sphere_interval(origin,rays,OUTER_KM/EARTH_KM)
        ground,_,ground_hit=sphere_interval(origin,rays,1.)
        endpoint=np.where(ground_hit,ground,np.inf)
        if depth is not None:
            limit=sample_depth(depth,xy)
            endpoint=np.where(limit>0,np.minimum(endpoint,limit),endpoint)
        return endpoint,hit&(np.minimum(endpoint,far)>near)

    # Tile output geometry to avoid full-frame float64 ray grids.
    width,height=size
    opaque=np.empty(width*height,np.float64);support=np.empty(width*height,bool)
    for begin in range(0,width*height,65536):
        indices=np.arange(begin,min(begin+65536,width*height))
        xy=np.column_stack((indices%width+.5,indices//width+.5)).astype(np.float32)
        opaque[indices],support[indices]=geometry(xy)
    return reconstruct_transport(size,scale,sample,opaque_depth=opaque.reshape(height,width),
        support_mask=support.reshape(height,width),sample_geometry=geometry,mode='adaptive')


def atmosphere_layer(*args,**kwargs):
    """Legacy display-only RGBA approximation; use atmosphere_transport."""
    layer=atmosphere_transport(*args,**kwargs)
    alpha=1-np.mean(layer.transmittance,axis=-1,keepdims=True)
    straight=layer.radiance/np.maximum(alpha,1e-8)
    return Image.fromarray(np.uint8(np.clip(np.concatenate([linear_to_srgb(straight),alpha],axis=-1)*255,0,255)))
