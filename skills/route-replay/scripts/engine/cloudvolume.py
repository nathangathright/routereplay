"""Wind-advected cloud transport in scene-relative linear RGB.

GFS cover and condensate constrain seeded, unresolved billows; they do not
observe individual clouds. One continuous density drives view extinction,
aircraft occlusion and Sun shadows. Immutable per-time macro/material maps are
shared by every ray. New billow material renews smoothly with bounded wind
history; the legacy reconstruction retains its original seed epoch. Solar
quadrature and local multiple scattering remain explicit approximations.

Cloud geometry is exaggerated 12x and optical path lengths compensated by 12.
"""
from dataclasses import dataclass
from functools import lru_cache
import os
import numpy as np
from PIL import Image
from scipy.ndimage import map_coordinates, gaussian_filter, distance_transform_edt
from camera_geometry import pixel_rays, sphere_interval
from cloudlayers import sample_layer_fields
from weatherfields import backtrace_coordinates, timestamp
import weatherfields
from cloudshapes import density_shape
from radiometry import TransportLayer, resize_float, linear_to_srgb
from quality import get_quality
from runtime import TRIP
from solar_visibility import solar_visibility, shadow_boundaries, split_intervals

EARTH_M=6_371_000.0
HEIGHT_EXAGGERATION=max(1.,float(TRIP.style.get('relief_exaggeration',12.)))
MAX_ALTITUDE_M=16000.
COLUMN_EXTINCTION_SCALE=.18
LAYER_MAX_OPTICAL_DEPTHS=(6.,4.,2.)
LAYER_BASE_DEPTHS_M=(700.,1200.,1500.)
LAYER_TOP_DEPTHS_M=(1700.,2200.,2500.)
BILLOW_NORMAL_RELIEF_M=110000.0
VERTICAL_STEP_M=1000.0
AIRCRAFT_CROP=224
MACRO_GRID_DEGREES=1.0
MATERIAL_INTERVAL_SECONDS=7200.
_noise_grid=np.indices((64,64,64),dtype=np.uint32)
_noise_hash=(_noise_grid[0]*np.uint32(73856093)^_noise_grid[1]*np.uint32(19349663)^_noise_grid[2]*np.uint32(83492791))
_noise_hash^=_noise_hash>>np.uint32(13);_noise_hash*=np.uint32(1274126177);_noise_hash^=_noise_hash>>np.uint32(16)
_NOISE=gaussian_filter((_noise_hash&np.uint32(0x00ffffff)).astype(np.float32)/16777215,.32,mode='wrap')
_NOISE_GRAD=tuple((np.roll(_NOISE,-1,axis=i)-np.roll(_NOISE,1,axis=i))*.5 for i in range(3))
_NOISE.setflags(write=False)
del _noise_grid,_noise_hash


@dataclass(frozen=True)
class CloudVolumeResult:
    layer: TransportLayer
    foreground_layer: TransportLayer

    # Display-only compatibility. The compositor consumes the float fields.
    @property
    def clouds(self):
        return _legacy_rgba(self.layer)

    @property
    def foreground(self):
        return _legacy_rgba(self.foreground_layer)

    @property
    def transmittance(self):
        return Image.fromarray(np.uint8(np.clip(self.foreground_layer.transmittance[...,0]*255+.5,0,255)))

    @property
    def foreground_radiance(self):
        return Image.fromarray(np.uint8(np.clip(linear_to_srgb(self.foreground_layer.radiance)*255,0,255)))

    def __iter__(self):
        yield self.clouds
        yield self.transmittance


def _legacy_rgba(layer):
    alpha=1-layer.transmittance[...,:1]
    straight=layer.radiance/np.maximum(alpha,1e-8)
    return Image.fromarray(np.uint8(np.clip(np.concatenate([linear_to_srgb(straight),alpha],axis=-1)*255,0,255)))


def _smoothstep(a,b,x):
    x=np.clip((x-a)/(b-a),0,1)
    return x*x*(3-2*x)


def _geographic(points):
    radii=np.linalg.norm(points,axis=-1)
    lon=np.arctan2(points[:,1],points[:,0])
    lat=np.arcsin(np.clip(points[:,2]/np.maximum(radii,1e-8),-1,1))
    return lon,lat,(radii-1)*EARTH_M/HEIGHT_EXAGGERATION,radii


def _unit(lon,lat):
    return np.stack([np.cos(lat)*np.cos(lon),np.cos(lat)*np.sin(lon),np.sin(lat)],axis=-1)


@lru_cache(maxsize=2)
def _frame_fields(stamp):
    """Immutable global coverage, mass, centroid and material coordinates.

    Renewing two material charts every two hours bounds their age to four
    hours. Blend finished densities, never coordinates. Zero wind gives the
    same fixed texture in both charts. Anchor changes have zero blend slope.
    Coverage and mass still follow the dated forecast, independently.
    """
    morphology=TRIP.style.get('cloud_morphology',1.)
    if not weatherfields.MATERIAL_REFERENCE<=stamp<=weatherfields.VALID_END:
        raise ValueError('Cloud material time lies outside verified weather coverage')
    step=.5 if morphology else MACRO_GRID_DEGREES
    lat,lon=np.mgrid[90:-90-step/2:-step,0:360:step]
    shape=lon.shape;lo,la=np.radians(lon.ravel()),np.radians(lat.ravel())
    elapsed=stamp-weatherfields.MATERIAL_REFERENCE
    interval=int(np.floor(elapsed/MATERIAL_INTERVAL_SECONDS))
    current=weatherfields.MATERIAL_REFERENCE+interval*MATERIAL_INTERVAL_SECONDS
    previous=max(weatherfields.MATERIAL_REFERENCE,current-MATERIAL_INTERVAL_SECONDS)
    # The first interval has only one seed epoch; avoid sampling it twice.
    blend=0. if previous==current else float(_smoothstep(0.,1.,(stamp-current)/MATERIAL_INTERVAL_SECONDS))
    if os.environ.get('FLIGHT_COMPUTE','cpu')=='metal':
        from metal_weather import frame_fields
        import cloudlayers
        return frame_fields(lo,la,stamp,shape=shape,morphology=morphology,
            previous=previous,current=current,blend=blend,weather=weatherfields,layers=cloudlayers)
    layers=[]
    for layer,height in enumerate((1500,5500,10500)):
        cover,mass,centroid=sample_layer_fields(lo,la,stamp,layer)
        seed=_unit(*backtrace_coordinates(lo,la,height,stamp,reference=previous if morphology else None))
        values=(cover,mass,centroid,*seed.T)
        if morphology:
            newer=seed if previous==current else _unit(*backtrace_coordinates(lo,la,height,stamp,reference=current))
            values=(*values,*newer.T)
        arrays=[np.asarray(a,np.float32).reshape(shape) for a in values]
        for array in arrays:array.setflags(write=False)
        if morphology:arrays.append(blend)
        layers.append(tuple(arrays))
    return tuple(layers)


def _sample_field(field,coords):
    return map_coordinates(field,coords,order=1,mode='grid-wrap',prefilter=False)


def _noise3(points,scale):
    return map_coordinates(_NOISE,(points/scale).T,order=1,mode='grid-wrap',prefilter=False)


def _noise_gradient(points,scale):
    coordinates=(points/scale).T
    return np.stack([map_coordinates(field,coordinates,order=1,mode='grid-wrap',prefilter=False)
                     for field in _NOISE_GRAD],axis=-1)/scale


def _density(points,dt,*,fields=None,normals=False,strength=None):
    """Return the sole extinction coefficient (1/physical meter) and normal.

    No camera, ray type or frame-order state affects density. Artistic cloud
    strength changes optical mass consistently for camera and Sun paths.
    """
    points=np.asarray(points,np.float32)
    fields=_frame_fields(timestamp(dt)) if fields is None else fields
    strength=TRIP.style.get('cloud_strength',1.) if strength is None else strength
    morphology=TRIP.style.get('cloud_morphology',1.)
    # Warm M1 Max measurements favor fused density above 1,024 points; small
    # CPU batches avoid dispatch overhead. This is not an error fallback.
    if os.environ.get('FLIGHT_COMPUTE','cpu')=='metal' and not normals and len(points)>=1024:
        from metal_clouds import cloud_density
        sigma=cloud_density(points,fields,noise=_NOISE,strength=strength,
            height_exaggeration=HEIGHT_EXAGGERATION,morphology=morphology)
        up=points/np.maximum(np.linalg.norm(points,axis=-1,keepdims=True),1e-8)
        return sigma,up
    lon,lat,altitude,radii=_geographic(points)
    up=points/np.maximum(radii[:,None],1e-8)
    rows,columns=fields[0][0].shape
    coords=np.array([np.clip((90-np.degrees(lat))*((rows-1)/180),0,rows-1),
                     (np.degrees(lon)%360)*(columns/360)],np.float32)
    sigma=np.zeros(len(points),np.float32);weighted_normal=np.zeros_like(points)
    for layer,(max_tau,base_depth,top_depth) in enumerate(zip(LAYER_MAX_OPTICAL_DEPTHS,LAYER_BASE_DEPTHS_M,LAYER_TOP_DEPTHS_M)):
        cover,raw,centroid=(_sample_field(field,coords) for field in fields[layer][:3])
        mass=max_tau*(-np.expm1(-raw*COLUMN_EXTINCTION_SCALE/max_tau))*cover**1.12*strength
        centroid=np.clip(centroid,(900,3300,9000)[layer],(3200,7800,13500)[layer])
        base=np.maximum(120,centroid-base_depth)
        active=(altitude>base)&(altitude<np.minimum(15900,centroid+top_depth*1.9))&(mass>1e-7)
        if not np.any(active):continue
        seed=np.stack([_sample_field(field,coords[:,active]) for field in fields[layer][3:6]],axis=-1)
        seed/=np.maximum(np.linalg.norm(seed,axis=-1,keepdims=True),1e-8)
        if morphology:
            shape=density_shape(seed,altitude[active],base[active],centroid[active],cover[active],layer,_NOISE)
            if len(fields[layer])>6 and fields[layer][9]>0:
                newer=np.stack([_sample_field(field,coords[:,active]) for field in fields[layer][6:9]],axis=-1)
                newer/=np.maximum(np.linalg.norm(newer,axis=-1,keepdims=True),1e-8)
                second=density_shape(newer,altitude[active],base[active],centroid[active],cover[active],layer,_NOISE)
                blend=fields[layer][9]
                shape=shape*(1-blend)+second*blend
            local_sigma=mass[active]*shape
        else:
            material=seed*(EARTH_M+altitude[active,None])+np.array([183000,97000,251000])*layer
            broad=_noise3(material,56000);middle=_noise3(material,19000);fine=_noise3(material,6500)
            body=_smoothstep(.25,.72,.67*broad+.33*middle)
            top=np.minimum(15900,centroid[active]+top_depth*(.45+1.45*body))
            span=np.maximum(700,top-base[active]);fraction=np.clip((altitude[active]-base[active])/span,0,1)
            shape=30*fraction**2*(1-fraction)**2/span
            detail=.28+1.55*body**.85*(.75+.5*fine)
            detail=1+(detail-1)*_smoothstep(0,.18,fraction)
            local_sigma=mass[active]*detail*shape
        sigma[active]+=local_sigma
        if normals:
            material=seed*(EARTH_M+altitude[active,None])+np.array([183000,97000,251000])*layer
            gradient=.67*_noise_gradient(material,56000)+.33*_noise_gradient(material,19000)
            lateral=gradient-up[active]*np.sum(gradient*up[active],axis=-1)[:,None]
            normal=up[active]-BILLOW_NORMAL_RELIEF_M*lateral
            normal/=np.maximum(np.linalg.norm(normal,axis=-1,keepdims=True),1e-8)
            weighted_normal[active]+=normal*local_sigma[:,None]
    normal=np.where((sigma>1e-10)[:,None],weighted_normal/np.maximum(sigma[:,None],1e-10),up) if normals else up
    normal/=np.maximum(np.linalg.norm(normal,axis=-1,keepdims=True),1e-8)
    return sigma,normal


def _earth_shadow(points,sun):
    dot=points@sun
    return (dot<0)&(np.sum(points*points,axis=-1)-dot*dot<1)


def _cloud_optical_depth(points,directions,dt,*,fields=None,samples=None,strength=None):
    """Cloud-only depth to the forward shell exit; no visibility or air factor."""
    points=np.asarray(points,np.float32)
    directions=np.broadcast_to(np.asarray(directions,np.float32),points.shape)
    count=get_quality().cloud_sun_steps if samples is None else int(samples)
    if count<1:raise ValueError('Cloud light integration requires positive samples')
    fields=_frame_fields(timestamp(dt)) if fields is None else fields
    if os.environ.get('FLIGHT_COMPUTE','cpu')=='metal':
        from metal_clouds import cloud_optical_depth
        return cloud_optical_depth(points,directions,fields,noise=_NOISE,samples=count,
            strength=TRIP.style.get('cloud_strength',1.) if strength is None else strength,
            height_exaggeration=HEIGHT_EXAGGERATION,morphology=TRIP.style.get('cloud_morphology',1.))
    near,far,hit=sphere_interval(points,directions,1+MAX_ALTITUDE_M*HEIGHT_EXAGGERATION/EARTH_M)
    tau=np.zeros(len(points),np.float32)
    active=hit&(far>near)
    if np.any(active):
        start=near[active];step=(far[active]-start)/count
        for index in range(count):
            query=points[active]+directions[active]*(start+(index+.5)*step)[:,None]
            sigma,_=_density(query,dt,fields=fields,strength=strength)
            tau[active]+=sigma*step*EARTH_M/HEIGHT_EXAGGERATION
    return tau


def _solar_transmission(points,sun,dt,*,fields=None,samples=None,strength=None):
    """Direct solar transmission for ground shadows; geometry applied once."""
    points=np.asarray(points,np.float32);sun=np.asarray(sun,np.float32)
    sun=sun/np.linalg.norm(sun)
    visibility=solar_visibility(points,sun)
    result=np.zeros(len(points),np.float32);lit=visibility>0
    if np.any(lit):
        tau=_cloud_optical_depth(points[lit],sun,dt,fields=fields,samples=samples,strength=strength)
        result[lit]=np.exp(-tau)*visibility[lit]
    return result


def _cloud_source(points,rays,sun,dt,fields,sigma,normal,solar_cloud,solar_air,*,
                  strength=None,phase_g=None,multiple_scattering=None,lighting=None,
                  with_atmosphere=True,atmosphere_strength=None,
                  atmosphere_multiple_scattering=None,atmosphere_saturation=None,legacy_air=True,
                  sun_samples=None):
    """Shared source RGB before view opacity, with a legacy blend for comparison.

    The new lighting uses cloud optical depth, never invented surface normals.
    Sky lobes use clear-air transport plus live cloud paths. They approximate
    angular illumination; neither sky nor solar secondary terms solve global
    multiple scattering. City illumination is added independently by callers.
    """
    gain=TRIP.style.get('cloud_lighting',1.) if lighting is None else lighting
    g=TRIP.style.get('cloud_phase_g',.65) if phase_g is None else phase_g
    ms=TRIP.style.get('cloud_multiple_scattering',1.) if multiple_scattering is None else multiple_scattering
    visibility=solar_visibility(points,sun)
    mu=np.clip(rays@sun,-1,1)
    color=np.zeros((len(points),3),np.float32)
    if gain<1:
        solar=np.exp(-(solar_air if legacy_air else 0)-solar_cloud[:,None])*visibility[:,None]
        cosine=(points@sun)/np.linalg.norm(points,axis=-1)
        daylight=_smoothstep(-.08,.12,cosine)
        facing=np.clip((normal@sun+.35)/1.35,0,1)
        phase=(1-g*g)/np.maximum(1+g*g-2*g*mu,1e-6)**1.5
        fill=min(.65,.20*ms)*(1-np.mean(solar,axis=-1))*(-np.expm1(-sigma*1700))*daylight
        legacy=daylight[:,None]*np.array([.075,.10,.15])+np.array([.002,.004,.008])
        legacy+=solar*((.25+.75*facing)*(.65+.35*phase))[:,None]*np.array([1.10,1.06,.98])
        legacy+=fill[:,None]*np.array([.85,.92,1.])
        color+=(1-gain)*legacy
    if gain>0:
        from cloudlighting import solar_source,sky_samples
        upgraded=solar_source(solar_cloud,np.exp(-solar_air),visibility,mu,
                              phase_g=g,multiple_scattering=ms)
        if with_atmosphere:
            sky_strength=TRIP.style.get('atmosphere_strength',1.) if atmosphere_strength is None else atmosphere_strength
            sky_ms=TRIP.style.get('atmosphere_multiple_scattering',1.) if atmosphere_multiple_scattering is None else atmosphere_multiple_scattering
            sky_saturation=TRIP.style.get('atmosphere_saturation',1.) if atmosphere_saturation is None else atmosphere_saturation
            directions,incoming,weights=sky_samples(points,sun,strength=sky_strength,
                multiple_scattering=sky_ms,saturation=sky_saturation)
            upgraded+=_sky_source(points,rays,directions,incoming,weights,dt,fields,
                                  strength=strength,multiple_scattering=ms,samples=sun_samples)
        color+=gain*upgraded
    return color


def _sky_source(points,rays,directions,incoming,weights,dt,fields,*,strength=None,
                multiple_scattering=1.,samples=None):
    """Attenuate incident sky RGB through the shared cloud field."""
    color=np.zeros((len(points),3),np.float32)
    budget=get_quality().cloud_sun_steps if samples is None else int(samples)
    count=min(budget,max(4,budget//2))
    for index,weight in enumerate(weights):
        active=np.any(incoming[:,index]>1e-7,axis=-1)
        if not np.any(active):continue
        tau=_cloud_optical_depth(points[active],directions[active,index],dt,fields=fields,
            samples=count,strength=strength)
        secondary=min(.6,.2*multiple_scattering)
        penetration=(1-secondary)*np.exp(-tau)+secondary*np.exp(-.35*tau)
        cosine=np.clip(np.sum(rays[active]*directions[active,index],axis=-1),-1,1)
        phase=(1-.2**2)/(1+.2**2-2*.2*cosine)**1.5
        color[active]+=(weight/(4*np.pi))*incoming[active,index]*(penetration*phase)[:,None]
    return color


def _moon_source(points,rays,dt,physical_dt,fields,*,strength=None,moonlight=None,
                 phase_g=None,multiple_scattering=None,with_atmosphere=True,
                 atmosphere_strength=None,atmosphere_multiple_scattering=None,
                 atmosphere_saturation=None,cloud_samples=None,atmosphere_samples=None):
    """Dated lunar illumination, independent of solar shading and city glow.

    Physical UTC sets the Moon; weather UTC samples extinction. This changes
    cloud source RGB only, never view opacity or surface/aircraft illumination.
    """
    gain=TRIP.style.get('moonlight',4000.) if moonlight is None else moonlight
    color=np.zeros((len(points),3),np.float32)
    if not np.isfinite(gain) or not 0<=gain<=20000:
        raise ValueError('Cloud moonlight must be finite and in [0, 20000]')
    if physical_dt is None or gain==0 or len(points)==0:return color
    from moonlighting import lunar_illumination
    from cloudlighting import solar_source,sky_samples
    state=lunar_illumination(points,physical_dt,height_exaggeration=HEIGHT_EXAGGERATION)
    # Keep this source additive, including in solar-shadowed daytime cloud.
    # A Sun-relative cutoff would also make lunar gain nonlinear near its gate.
    active=(state.ratio>0)&(state.visibility>0)
    if not np.any(active):return color
    query=points[active];ray=rays[active];direction=state.direction[active]
    ratio=state.ratio[active]*gain
    visible=state.visibility[active]
    g=TRIP.style.get('cloud_phase_g',.65) if phase_g is None else phase_g
    ms=TRIP.style.get('cloud_multiple_scattering',1.) if multiple_scattering is None else multiple_scattering
    tau=_cloud_optical_depth(query,direction,dt,fields=fields,strength=strength,samples=cloud_samples)
    transmission=np.ones((len(query),3),np.float32)
    if with_atmosphere:
        import atmosphere as air
        _,length,_=sphere_interval(query,direction,air.OUTER_KM/air.EARTH_KM)
        transmission=np.exp(-air.optical_depth(query,direction,length,
            samples=get_quality().atmosphere_sun_steps if atmosphere_samples is None else atmosphere_samples,weather_dt=dt))
    mu=np.clip(np.sum(ray*direction,axis=-1),-1,1)
    source=solar_source(tau,transmission,visible,mu,phase_g=g,multiple_scattering=ms)
    if with_atmosphere:
        sky_strength=TRIP.style.get('atmosphere_strength',1.) if atmosphere_strength is None else atmosphere_strength
        sky_ms=TRIP.style.get('atmosphere_multiple_scattering',1.) if atmosphere_multiple_scattering is None else atmosphere_multiple_scattering
        sky_saturation=TRIP.style.get('atmosphere_saturation',1.) if atmosphere_saturation is None else atmosphere_saturation
        directions,incoming,weights=sky_samples(query,direction,strength=sky_strength,
            multiple_scattering=sky_ms,saturation=sky_saturation)
        # Deliberately omit lunar twilight below the local physical horizon.
        # Scale after cloud attenuation, preserving linearity even at gain 1.
        source+=visible[:,None]*_sky_source(query,ray,directions,incoming,weights,dt,fields,
                                           strength=strength,multiple_scattering=ms,samples=cloud_samples)
    color[active]=source*ratio[:,None]
    return color


def cloud_shadow(world,height,sun,dt,*,diffuse_floor=.46,strength=None):
    """Ground-light multiplier from shared density; diffuse floor is cinematic.

    ``diffuse_floor=0`` exposes direct beam transmission for numerical checks.
    The default retains diffuse skylight under an opaque cloud.
    """
    points=np.asarray(world)*(1+np.asarray(height)*HEIGHT_EXAGGERATION/EARTH_M)[...,None]
    result=np.ones(len(points),np.float32);daylight=(points@sun)>0
    if np.any(daylight):result[daylight]=_solar_transmission(points[daylight],sun,dt,strength=strength)
    return diffuse_floor+(1-diffuse_floor)*result


def _city_source(points,dt,sun,physical_dt,fields,*,strength=None,batched=False):
    """Dated ground emission scattered through the same weather density.

    Omitting physical_dt disables this source for isolated transport diagnostics.
    Production always supplies the physical clock separately from weather UTC.
    """
    gain=TRIP.style.get('cloud_city_glow',2.)
    if physical_dt is None or gain==0:
        return np.zeros((len(points),3),np.float32)
    from cityglow import ground_illumination
    from nightlighting import city_emission
    from terrain_detail import terrain_sampler
    from runtime import asset,ASSETS,BUNDLE
    sampler=terrain_sampler(str(asset('terrain')),tuple(str(ASSETS/record['path'])
                            for record in BUNDLE.get('terrain_tiles',[])),
                            str(ASSETS/BUNDLE['calibration']['path']) if BUNDLE.get('calibration') else None)
    def source(lon,lat):
        return city_emission(lon,lat,_unit(lon,lat)@sun,
                             physical_dt=physical_dt,weather_dt=dt)
    def density(query):
        return _density(query,dt,fields=fields,strength=strength)[0]
    return ground_illumination(points,source,density,height_exaggeration=HEIGHT_EXAGGERATION,
                               strength=gain,ground_height=sampler.sample,batched=batched)


def _sample_source(points,rays,sun,dt,fields,sigma,normal,*,strength=None,
                   sun_samples=None,physical_dt=None):
    """Complete existing source, shared by reference and batched view paths."""
    lighting=TRIP.style.get('cloud_lighting',1.)
    if (lighting==1 and os.environ.get('FLIGHT_COMPUTE','cpu')=='metal' and
            os.environ.get('FLIGHT_CLOUD_SOURCE','reference')=='batched'):
        from cloudlighting import sample_source_batched
        import cloudvolume as cloud
        return sample_source_batched(cloud,points,rays,sun,dt,fields,
            strength=strength,sun_samples=sun_samples,physical_dt=physical_dt)
    solar_cloud=np.zeros(len(points),np.float32)
    lit=solar_visibility(points,sun)>0
    if np.any(lit):
        solar_cloud[lit]=_cloud_optical_depth(points[lit],sun,dt,fields=fields,
            samples=sun_samples,strength=strength)
    solar_air=np.zeros((len(points),3),np.float32)
    if lighting>0 and np.any(lit):
        import atmosphere as air
        _,length,_=sphere_interval(points[lit],sun,air.OUTER_KM/air.EARTH_KM)
        solar_air[lit]=air.optical_depth(points[lit],sun,length,
                                       samples=get_quality().atmosphere_sun_steps,weather_dt=dt)
    color=_cloud_source(points,rays,sun,dt,fields,sigma,normal,solar_cloud,solar_air,
                        strength=strength,legacy_air=False,sun_samples=sun_samples)
    color+=_city_source(points,dt,sun,physical_dt,fields,strength=strength)
    color+=_moon_source(points,rays,dt,physical_dt,fields,strength=strength,
                        cloud_samples=sun_samples)
    return color


def _integrate(origins,rays,start,stop,dt,sun,*,fields=None,substeps=None,sun_samples=None,strength=None,
               physical_dt=None,return_guide=False):
    """Integrate exact cloud quadrature, optionally returning its mean distance.

    The guide uses the same front-to-back opacity weights as radiance, in Earth
    radii along a normalized camera ray. Empty rays have guide zero.
    """
    if (os.environ.get('FLIGHT_COMPUTE','cpu')=='metal' and
            os.environ.get('FLIGHT_CLOUD_VIEW','reference')=='batched' and
            TRIP.style.get('cloud_lighting',1.)==1):
        from cloudview import integrate_cloud_view
        return integrate_cloud_view(origins,rays,start,stop,dt,sun,fields=fields,
            substeps=substeps,sun_samples=sun_samples,strength=strength,physical_dt=physical_dt,
            return_guide=return_guide)
    count=len(rays);transmission=np.ones(count,np.float32);radiance=np.zeros((count,3),np.float32)
    if return_guide:
        guide_moment=np.zeros(count,np.float64);guide_mass=np.zeros(count,np.float64)
    fields=_frame_fields(timestamp(dt)) if fields is None else fields
    substeps=get_quality().cloud_substeps if substeps is None else int(substeps)
    heights=np.arange(0,MAX_ALTITUDE_M+VERTICAL_STEP_M,VERTICAL_STEP_M)
    intervals=[sphere_interval(origins,rays,1+h*HEIGHT_EXAGGERATION/EARTH_M) for h in heights]
    closest=-np.sum(origins*rays,axis=-1);pieces=[]
    for index in range(len(heights)-2,-1,-1):
        lower,upper=intervals[index],intervals[index+1]
        pieces.append((upper[0],np.where(lower[2],lower[0],closest),upper[2]))
    for index in range(len(heights)-1):
        lower,upper=intervals[index],intervals[index+1]
        pieces.append((np.where(lower[2],lower[1],closest),upper[1],upper[2]))
    def view_intervals():
        for a,b,hit in pieces:
            for j in range(substeps):
                begin=np.maximum(a+(b-a)*(j/substeps),start)
                end=np.minimum(a+(b-a)*((j+1)/substeps),stop)
                yield begin,end,hit
    boundaries=shadow_boundaries(origins,rays,sun)
    for begin,end,hit in split_intervals(view_intervals(),boundaries):
        active=hit&(end>begin)&(transmission>1e-4)
        if not np.any(active):continue
        indices=np.flatnonzero(active)
        physical_step=(end[active]-begin[active])*EARTH_M/HEIGHT_EXAGGERATION
        points=origins[active]+rays[active]*((begin[active]+end[active])*.5)[:,None]
        lighting=TRIP.style.get('cloud_lighting',1.)
        sigma,normal=_density(points,dt,fields=fields,normals=lighting<1,strength=strength)
        occupied=sigma>1e-9
        if not np.any(occupied):continue
        points=points[occupied];normal=normal[occupied];sigma=sigma[occupied]
        physical_step=physical_step[occupied];indices=indices[occupied]
        color=_sample_source(points,rays[indices],sun,dt,fields,sigma,normal,
            strength=strength,sun_samples=sun_samples,physical_dt=physical_dt)
        opacity=-np.expm1(-sigma*physical_step)
        if return_guide:
            weights=transmission[indices]*opacity
            sample_distance=((begin[active]+end[active])*.5)[occupied]
            guide_moment[indices]+=weights*sample_distance
            guide_mass[indices]+=weights
        radiance[indices]+=transmission[indices,None]*opacity[:,None]*color
        transmission[indices]*=1-opacity
    if return_guide:
        guide=np.divide(guide_moment,guide_mass,out=np.zeros_like(guide_moment),where=guide_mass>0)
        return radiance,transmission,guide.astype(np.float32)
    return radiance,transmission


def _depth_array(depth,shape):
    value=np.asarray(depth,dtype=np.float32)
    if value.ndim!=2:raise ValueError('Depth must be an H×W ray-distance image')
    return resize_float(value,(shape[1],shape[0]),Image.Resampling.NEAREST)


def _extend_aircraft_depth(depth):
    """Extend opaque depth through transparent crop pixels before resampling.

    Only the aircraft alpha consumes this transport. Extending its nearest
    valid depth prevents background/cloud depth at empty pixels from bleeding
    into the aircraft silhouette when the lower-resolution pass is enlarged.
    Every observed opaque depth is preserved exactly.
    """
    value=np.asarray(depth,np.float32)
    valid=np.isfinite(value)&(value>0)
    if np.all(valid) or not np.any(valid):return value
    nearest=distance_transform_edt(~valid,return_distances=False,return_indices=True)
    return value[tuple(nearest)]


def _layer(radiance,transmission,shape,size):
    return TransportLayer(resize_float(radiance.reshape(*shape,3),size),
                          np.clip(resize_float(transmission.reshape(*shape,1),size),0,1))


def _reconstructed_layer(bs,sun,dt,radius,size,center,surface_depth,fields,
                         physical_dt,mode,scale):
    """Sample unchanged volume quadrature at reconstruction-requested rays."""
    from camera_geometry import pixel_rays_at
    from volume_reconstruction import reconstruct_transport, sample_depth
    if surface_depth is not None and np.asarray(surface_depth).shape!=(size[1],size[0]):
        raise ValueError('surface_depth must match output canvas')
    outer=1+MAX_ALTITUDE_M*HEIGHT_EXAGGERATION/EARTH_M
    def geometry(xy):
        lo,ld=pixel_rays_at(radius,xy,center=center)
        rays=ld@bs;origins=np.broadcast_to(lo@bs,rays.shape)
        entry,exit,hit=sphere_interval(origins,rays,outer)
        ground,_,ground_hit=sphere_interval(origins,rays,1)
        stop=np.where(ground_hit,np.minimum(exit,ground),exit)
        opaque=np.where(ground_hit,ground,np.inf)
        if surface_depth is not None:
            depth=sample_depth(surface_depth,xy)
            stop=np.where(depth>0,np.minimum(stop,depth),stop)
            opaque=np.where(depth>0,np.minimum(opaque,depth),opaque)
        active=hit&(stop>entry)
        return origins,rays,entry,stop,active,opaque
    def sample(xy):
        origins,rays,entry,stop,active,_=geometry(xy)
        radiance=np.zeros((len(rays),3),np.float32);transmission=np.ones(len(rays),np.float32)
        guide=np.zeros(len(rays),np.float32)
        if np.any(active):
            radiance[active],transmission[active],guide[active]=_integrate(
                origins[active],rays[active],entry[active],stop[active],dt,sun,
                fields=fields,physical_dt=physical_dt,return_guide=True)
        return radiance,transmission,guide
    def sample_geometry(xy):
        # Fractional coarse rays can lie on the opposite side of the analytic
        # limb from the nearest output pixel. Keep their exact classification.
        *_,active,opaque=geometry(xy)
        return opaque,active
    support=None;opaque=surface_depth
    if mode=='adaptive':
        # Geometry is inexpensive and bounded. Exact full-canvas support avoids
        # giving empty sky or terrain-blocked cloud segments any coarse opacity.
        support=np.zeros(size[0]*size[1],bool)
        opaque=np.empty(len(support),np.float32)
        for offset in range(0,len(support),4096):
            index=np.arange(offset,min(offset+4096,len(support)))
            xy=np.column_stack((index%size[0]+.5,index//size[0]+.5)).astype(np.float32)
            opaque[index],support[index]=sample_geometry(xy)
        support=support.reshape(size[1],size[0])
        opaque=opaque.reshape(size[1],size[0])
    return reconstruct_transport(tuple(size),scale,sample,opaque_depth=opaque,
                                 support_mask=support,sample_geometry=sample_geometry,mode=mode)


def render_cloud_volume(bs,sun,dt,radius,plane_altitude_m,size=(1080,1920),center=(540,960),
                        surface_depth=None,camera_rays=None,plane_depth=None,*,aircraft_depth=None,
                        include_foreground=True,physical_dt=None):
    """Full-frame and 224-pixel aircraft-prefix transport, without tone/gamma.

    Depth arrays/PIL F images are normalized-ray distances in Earth radii; zero
    is no opaque hit. Aircraft depth can be a full canvas or the centered crop.
    ``aircraft_depth`` is an alias for the older ``plane_depth`` argument.
    Background-only previews can disable the unused foreground ray pass.
    Adaptive/full reconstruction changes spatial sampling only; aircraft paths
    use exact output pixels in both modes, with the existing view quadrature.
    """
    quality=get_quality();bs,sun=np.asarray(bs,np.float32),np.asarray(sun,np.float32)
    sun=sun/np.linalg.norm(sun)
    mode=os.environ.get('FLIGHT_VOLUME_RECONSTRUCTION','reference')
    if mode not in ('reference','adaptive','full'):
        raise ValueError('FLIGHT_VOLUME_RECONSTRUCTION must be reference, adaptive or full')
    if aircraft_depth is not None:
        if plane_depth is not None:raise ValueError('Pass only aircraft_depth or plane_depth')
        plane_depth=aircraft_depth
    outer=1+MAX_ALTITUDE_M*HEIGHT_EXAGGERATION/EARTH_M
    fields=_frame_fields(timestamp(dt))
    # An explicit ray grid owns its sampling resolution. Keep its longstanding
    # integration/resize contract; screen-pixel reconstruction is meaningful
    # only when this function also owns the finite-camera ray generation.
    if mode=='reference' or camera_rays is not None:
        if camera_rays is None:
            lo,ld=pixel_rays(radius,size,center,scale=quality.cloud_scale)
            origin,directions=lo@bs,ld@bs
        else:origin,directions=map(np.asarray,camera_rays)
        shape=directions.shape[:2];rays=directions.reshape(-1,3)
        origins=np.broadcast_to(origin,rays.shape) if origin.shape==(3,) else origin.reshape(-1,3)
        entry,exit,hit=sphere_interval(origins,rays,outer)
        ground,_,ground_hit=sphere_interval(origins,rays,1)
        stop=np.where(ground_hit,np.minimum(exit,ground),exit)
        if surface_depth is not None:
            if np.asarray(surface_depth).shape!=(size[1],size[0]):raise ValueError('surface_depth must match output canvas')
            depth=_depth_array(surface_depth,shape).ravel();stop=np.where(depth>0,np.minimum(stop,depth),stop)
        active=hit&(stop>entry);radiance=np.zeros((len(rays),3),np.float32);transmission=np.ones(len(rays),np.float32)
        if np.any(active):
            radiance[active],transmission[active]=_integrate(origins[active],rays[active],entry[active],stop[active],dt,sun,
                                                           fields=fields,physical_dt=physical_dt)
        layer=_layer(radiance,transmission,shape,tuple(size))
    else:
        layer=_reconstructed_layer(bs,sun,dt,radius,size,center,surface_depth,
                                   fields,physical_dt,mode,quality.cloud_scale)
    crop=AIRCRAFT_CROP
    if not include_foreground:
        identity=TransportLayer(np.zeros((crop,crop,3),np.float32),np.ones((crop,crop,1),np.float32))
        return CloudVolumeResult(layer,identity)
    foreground_scale=max(1.,quality.cloud_scale/1.5) if mode=='reference' else 1
    lo,ld=pixel_rays(radius,(crop,crop),(crop/2,crop/2),scale=foreground_scale)
    rays=(ld@bs).reshape(-1,3);origins=np.broadcast_to(lo@bs,rays.shape);shape=ld.shape[:2]
    entry,exit,hit=sphere_interval(origins,rays,outer)
    if plane_depth is not None:
        value=np.asarray(plane_depth,np.float32)
        if value.shape==(size[1],size[0]):
            x,y=int(center[0]-crop/2),int(center[1]-crop/2);value=value[y:y+crop,x:x+crop]
        if value.shape!=(crop,crop):raise ValueError('aircraft depth must match the canvas or 224×224 crop')
        depth=_depth_array(_extend_aircraft_depth(value),shape).ravel();depth=np.where(depth>0,depth,np.inf)
    else:depth,_,_=sphere_interval(origins,rays,1+max(0,plane_altitude_m)*HEIGHT_EXAGGERATION/EARTH_M)
    stop=np.minimum(exit,depth);active=hit&(stop>entry)
    radiance=np.zeros((len(rays),3),np.float32);transmission=np.ones(len(rays),np.float32)
    if np.any(active):
        radiance[active],transmission[active]=_integrate(origins[active],rays[active],entry[active],stop[active],dt,sun,
                                                       fields=fields,physical_dt=physical_dt)
    return CloudVolumeResult(layer,_layer(radiance,transmission,shape,(crop,crop)))
