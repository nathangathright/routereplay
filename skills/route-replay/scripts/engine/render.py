"""Shared CPU cinematic compositor. Configured by flight_video.py, never edited per trip."""
from functools import lru_cache
from datetime import timezone, timedelta
from calendar import isleap
import math
import os
import numpy as np
from PIL import Image
from scipy.io import netcdf_file
from scipy.ndimage import map_coordinates
from runtime import TRIP, BUNDLE, ASSETS, WORK, asset
from motion import Motion, unit, ease, slerp, basis
from starfield import star_radiance
from nightlighting import city_emission
from celestial import moon_transport
from atmosphere import atmosphere_transport
from cloudvolume import render_cloud_volume, cloud_shadow as forecast_cloud_shadow
from camera_geometry import distance as camera_distance, focal_length, pixel_rays, sphere_interval, project as camera_project
from radiometry import TransportLayer, srgb_to_linear, resize_float, source_over, display_image
from scene_cache import cached_scene
from scene_overlays import composite as composite_overlays, exposure_at
from quality import get_quality
from terrain_detail import terrain_sampler
from surfacelighting import ocean_reflection, lunar_surface_radiance
from moonlighting import lunar_incident

WITH_WEATHER=TRIP.weather['mode'] != 'clear'
TRANSPORT=os.environ.get('FLIGHT_TRANSPORT', 'layered')
if TRANSPORT not in ('layered', 'joint'):
    raise ValueError('FLIGHT_TRANSPORT must be layered or joint')
W,H,FPS,DURATION=1080,1920,TRIP.fps,TRIP.duration_s
FRAME_COUNT=TRIP.frame_count
CX,CY,R=540,960,460
BASE_R=R
AIRPORTS=[(a.code,a.name,a.lat,a.lon) for a in TRIP.airport_sequence]
LEGS=TRIP.leg_intervals
MOTION=Motion(TRIP)
V=MOTION.vectors
camera=MOTION.camera
flight_progress=TRIP.progress
travel_time=TRIP.travel_time
zoom=MOTION.zoom
flight_altitude=MOTION.altitude
plane_heading=MOTION.heading

def project(points, bs, raised=1):
    return camera_project(points,bs,R,raised=raised)

from astronomy import sun_direction




TEX=np.asarray(Image.open(asset('land_mask')).convert('RGB'))
TW,TH=TEX.shape[1],TEX.shape[0]
EARTH_RADIUS=6371000.0
RELIEF_EXAGGERATION=TRIP.style['relief_exaggeration']
with netcdf_file(asset('terrain'),mmap=False) as _nc:
    DEM=np.maximum(_nc.variables['z'][:],0).astype(np.float32)
    DEM_LAT=_nc.variables['latitude'][:].copy()
    DEM_LON=_nc.variables['longitude'][:].copy()
DEM_STEP=float(DEM_LAT[1]-DEM_LAT[0])
_north,_east=np.gradient(DEM,math.radians(DEM_STEP),math.radians(DEM_STEP))
SLOPE_N=(_north*(RELIEF_EXAGGERATION/EARTH_RADIUS)).astype(np.float32)
SLOPE_E=(_east*(RELIEF_EXAGGERATION/EARTH_RADIUS)/np.maximum(np.cos(np.radians(DEM_LAT)),.01)[:,None]).astype(np.float32)
del _north,_east
TERRAIN_TILES=tuple(str(ASSETS/record['path']) for record in BUNDLE.get('terrain_tiles',[]))
TERRAIN_SAMPLER=terrain_sampler(str(asset('terrain')),TERRAIN_TILES,
    str(ASSETS/BUNDLE['calibration']['path']) if BUNDLE.get('calibration') else None)
HAS_TERRAIN_DETAIL=bool(TERRAIN_TILES or TERRAIN_SAMPLER.has_calibration)
MAX_TERRAIN_HEIGHT=TERRAIN_SAMPLER.max_elevation_m
OUTER_RADIUS=1+MAX_TERRAIN_HEIGHT*RELIEF_EXAGGERATION/EARTH_RADIUS+.0002
N=2*math.ceil(BASE_R*OUTER_RADIUS)+4
Y,X=np.mgrid[:N,:N].astype(np.float32)
SX=(X-(N-1)/2)/R; SY=((N-1)/2-Y)/R
RR=SX*SX+SY*SY
INSIDE=RR<OUTER_RADIUS**2
ZX=SX[INSIDE]; ZY=SY[INSIDE]; RHO2=RR[INSIDE]
ZZ=np.sqrt(np.maximum(0,OUTER_RADIUS**2-RHO2))
OCEAN=np.array([14,49,68],np.float32)
LAND=np.array([83,147,144],np.float32)
SURFACE=srgb_to_linear(np.asarray(Image.open(asset('surface')).convert('RGB'),dtype=np.float32)/255)
SURFACE_H,SURFACE_W=SURFACE.shape[:2]

def surface_color(lon,lat):
    """Historical seasonal NASA albedo; texels centered on the global grid."""
    x=((lon/(2*np.pi)+.5)*SURFACE_W-.5)%SURFACE_W
    y=np.clip((.5-lat/np.pi)*SURFACE_H-.5,0,SURFACE_H-1)
    ix=np.floor(x).astype(np.int32); iy=np.floor(y).astype(np.int32)
    fx=(x-ix)[:,None];fy=(y-iy)[:,None]
    nx=(ix+1)%SURFACE_W;ny=np.minimum(iy+1,SURFACE_H-1)
    return (SURFACE[iy,ix]*(1-fx)*(1-fy)+SURFACE[iy,nx]*fx*(1-fy)
            +SURFACE[ny,ix]*(1-fx)*fy+SURFACE[ny,nx]*fx*fy)

def cloud_shadow(world,height,sun,dt):
    return forecast_cloud_shadow(world,height,sun,dt)

def terrain(world):
    lon=np.arctan2(world[:,1],world[:,0])
    lat=np.arcsin(np.clip(world[:,2],-1,1))
    coords=np.array([
        np.clip((np.degrees(lat)-DEM_LAT[0])/DEM_STEP,0,DEM.shape[0]-1),
        ((np.degrees(lon)-DEM_LON[0])/DEM_STEP)%DEM.shape[1],
    ],dtype=np.float32)
    height=map_coordinates(DEM,coords,order=1,mode='grid-wrap',prefilter=False)
    east=map_coordinates(SLOPE_E,coords,order=1,mode='grid-wrap',prefilter=False)
    north=map_coordinates(SLOPE_N,coords,order=1,mode='grid-wrap',prefilter=False)
    if HAS_TERRAIN_DETAIL:
        height,east,north=TERRAIN_SAMPLER.sample_with_slopes(world)
        east*=RELIEF_EXAGGERATION
        north*=RELIEF_EXAGGERATION
    return height,east,north,lon,lat

def terrain_surface(bs):
    # Every pass uses the same finite perspective observer and normalized rays.
    # Work at 720px wide, then antialias to the final canvas.
    quality=get_quality()
    origin_local,rays_local=pixel_rays(R,scale=quality.terrain_scale)
    near,far,mask=sphere_interval(origin_local,rays_local,OUTER_RADIUS)
    origin=origin_local@np.asarray(bs,dtype=np.float32)
    rays=rays_local[mask]@np.asarray(bs,dtype=np.float32)
    low=near[mask].copy()
    sea_near,_,sea_hit=sphere_interval(origin_local,rays_local,1.)
    high=np.where(sea_hit[mask],sea_near[mask],-np.sum(origin*rays,axis=1))
    def radial_error(t,indices=None):
        selected=rays if indices is None else rays[indices]
        point=origin+t[:,None]*selected
        radial=np.linalg.norm(point,axis=1)
        direction=point/radial[:,None]
        lon=np.arctan2(direction[:,1],direction[:,0])
        lat=np.arcsin(np.clip(direction[:,2],-1,1))
        coords=np.array([np.clip((np.degrees(lat)-DEM_LAT[0])/DEM_STEP,0,DEM.shape[0]-1),
                         ((np.degrees(lon)-DEM_LON[0])/DEM_STEP)%DEM.shape[1]],dtype=np.float32)
        height=(TERRAIN_SAMPLER.sample(direction) if HAS_TERRAIN_DETAIL else
                map_coordinates(DEM,coords,order=1,mode='grid-wrap',prefilter=False))
        return radial-1-height*(RELIEF_EXAGGERATION/EARTH_RADIUS)
    # Bracket the radial surface between the outer envelope and sea/closest
    # approach. Bisection avoids Newton holes on steep, exaggerated ridges.
    visible=sea_hit[mask].copy()
    # A ray that misses sea level can still cross an elevated ridge before or
    # after closest approach. Find the first crossing across the full envelope.
    limb=np.flatnonzero(~sea_hit[mask])
    if len(limb):
        entry=near[mask][limb]
        exit=far[mask][limb]
        previous=entry.copy()
        unresolved=np.ones(len(limb),bool)
        for k in range(1,quality.limb_steps+1):
            sample=entry+(exit-entry)*(k/quality.limb_steps)
            crosses=unresolved & (radial_error(sample,limb)<=0)
            low[limb[crosses]]=previous[crosses]
            high[limb[crosses]]=sample[crosses]
            visible[limb[crosses]]=True
            unresolved[crosses]=False
            previous=sample
            if not np.any(unresolved):break
    for _ in range(quality.terrain_bisections):
        middle=(low+high)*.5
        outside=radial_error(middle)>0
        low=np.where(outside,middle,low)
        high=np.where(outside,high,middle)
    distance=(low+high)*.5
    point=origin+distance[:,None]*rays
    radius=np.linalg.norm(point,axis=1)
    world=point/radius[:,None]
    height,east,north,lon,lat=terrain(world)
    return world,height,east,north,lon,lat,visible,mask,distance,-rays

def globe_radiance(bs,sun,dt,return_depth=False,weather_dt=None):
    right,up,forward=bs
    world,height,slope_e,slope_n,lon,lat,visible,mask,ray_distance,view=terrain_surface(bs)
    tx=(lon/(2*np.pi)+.5)*(TW-1); ty=(.5-lat/np.pi)*(TH-1)
    ix=tx.astype(np.int32); iy=ty.astype(np.int32)
    fx=(tx-ix)[:,None]; fy=(ty-iy)[:,None]
    ix2=np.minimum(ix+1,TW-1); iy2=np.minimum(iy+1,TH-1)
    v=(TEX[iy,ix]*(1-fx)*(1-fy)+TEX[iy,ix2]*fx*(1-fy)+TEX[iy2,ix]*(1-fx)*fy+TEX[iy2,ix2]*fx*fy)/255
    land=v[:,0:1]; coast=v[:,1:2]; grid=v[:,2:3]
    solar_cosine=world@sun
    sl,cl=np.sin(lon),np.cos(lon)
    sp,cp=np.sin(lat),np.cos(lat)
    east_sun=-sl*sun[0]+cl*sun[1]
    north_sun=-sp*cl*sun[0]-sp*sl*sun[1]+cp*sun[2]
    normal_length=np.sqrt(1+slope_e*slope_e+slope_n*slope_n)
    surface_sun=(solar_cosine-slope_e*east_sun-slope_n*north_sun)/normal_length
    # A narrow civil-twilight band makes the terminator readable without
    # changing its geographic position. Night retains enough map detail.
    daylight=ease((solar_cosine+.105)/.21)[:,None]
    shadow=cloud_shadow(world,height,sun,weather_dt or dt) if WITH_WEATHER else np.ones(len(world))
    diffuse=(.035+.965*np.maximum(surface_sun,0)*shadow)[:,None]
    from environmentlighting import surface_conditions, aerosol_incident
    albedo,water=surface_conditions(surface_color(lon,lat),land,lon,lat,weather_dt or dt)
    surface_points=world*(1+height*max(1,RELIEF_EXAGGERATION)/EARTH_RADIUS)[:,None]
    aerosol_sun=aerosol_incident(surface_points,sun,weather_dt or dt)
    day=albedo*diffuse*aerosol_sun
    day+=ocean_reflection(world,sun,view)*water*shadow[:,None]*aerosol_sun
    night=albedo*.018+srgb_to_linear(np.array([2,6,12])/255)
    view_depth=np.maximum(0,np.sum(world*view,axis=1))
    # Very low cartographic fill preserves terrain readability on the night side.
    relief_fill=np.clip((1-.48*slope_e+.48*slope_n)/normal_length,.35,1.35)
    night*= ((.72+.28*view_depth)*(.65+.35*relief_fill))[:,None]
    # In lunar mode retain only a small readability floor. Do not stack the
    # old cartographic fill onto directional moonlight; zero restores legacy.
    moon_gain=TRIP.style['moonlight']
    if moon_gain>0:night*=.20
    col=night*(1-daylight)+day*daylight
    if moon_gain>0:
        scale=max(1.,RELIEF_EXAGGERATION)
        physical_world=world.astype(np.float64)
        physical_world/=np.linalg.norm(physical_world,axis=-1,keepdims=True)
        points=physical_world*(1+height*scale/EARTH_RADIUS)[:,None]
        lunar,incident=lunar_incident(points,dt,weather_dt or dt,strength=moon_gain,
                                      height_exaggeration=scale,with_weather=WITH_WEATHER)
        from lunar_scattering import terrain_visibility as lunar_terrain_visibility
        shadowed=(np.max(incident,axis=-1)>0)&(land[:,0]>.05)
        if np.any(shadowed):
            physical=physical_world[shadowed]*(1+height[shadowed]/EARTH_RADIUS)[:,None]
            incident[shadowed]*=lunar_terrain_visibility(physical,lunar.direction[shadowed],
                lunar.angular_radius[shadowed],TERRAIN_SAMPLER.sample)[:,None]
        east=np.stack((-sl,cl,np.zeros_like(sl)),axis=-1)
        north=np.stack((-sp*cl,-sp*sl,cp),axis=-1)
        normals=(world-slope_e[:,None]*east-slope_n[:,None]*north)/normal_length[:,None]
        col+=lunar_surface_radiance(world,normals,view,albedo,1-water,lunar.direction,incident)
        from lunar_scattering import surface_bounce
        col+=surface_bounce(world,normals,albedo,lunar.direction,incident)*(1-water)
    twilight=np.exp(-(solar_cosine/.065)**2)[:,None]
    col+=twilight*srgb_to_linear(np.array([21,10,3])/255)
    # Distinguish local dawn from dusk independently of the camera/flight.
    sun_delta=sun_direction(dt+timedelta(seconds=60))-sun_direction(dt-timedelta(seconds=60))
    solar_rate=np.degrees((world@sun_delta)/120 / np.sqrt(np.maximum(1-solar_cosine**2,1e-8)))*3600
    col+=city_emission(lon,lat,solar_cosine,solar_rate,physical_dt=dt,weather_dt=weather_dt or dt)
    radiance=np.zeros((*mask.shape,3),dtype=np.float32)
    alpha=np.zeros((*mask.shape,1),dtype=np.float32)
    radiance[mask]=col*visible[:,None]
    alpha[mask,0]=visible
    result=TransportLayer(np.maximum(resize_float(radiance,(W,H)),0),
                          1-np.clip(resize_float(alpha,(W,H)),0,1))
    if return_depth:
        depth=np.zeros(mask.shape,np.float32)
        depth[mask]=np.where(visible,ray_distance,0)
        return result,resize_float(depth,(W,H),Image.Resampling.NEAREST)
    return result


def globe(bs,sun,dt,return_depth=False,weather_dt=None):
    """Display preview compatibility; all scene compositing uses globe_radiance."""
    result=globe_radiance(bs,sun,dt,return_depth=return_depth,weather_dt=weather_dt)
    layer,depth=result if return_depth else (result,None)
    image=display_image(layer.radiance)
    image.putalpha(Image.fromarray(np.rint((1-layer.transmittance[...,0])*255).astype(np.uint8)))
    return (image,Image.fromarray(depth)) if return_depth else image









def scene(t):
    """Display scene preview; internal cached backgrounds remain immutable HDR."""
    radiance,clouds,_,_=_scene(float(t))
    return display_image(radiance,exposure_at(t)),clouds


def aircraft_altitude(t,bs):
    # Motion accepts local terrain when available; recorded trajectories retain
    # their specified MSL altitude. Older callers use the zero-ground fallback.
    ground=float(TERRAIN_SAMPLER.sample(bs[2]))
    return MOTION.altitude(t,ground)


@lru_cache(maxsize=2)
def _scene(t,with_aircraft=True):
    global R
    R=zoom(t)
    bs=camera(t)
    dt=travel_time(t)
    weather_dt=TRIP.weather_time(t)
    sun=sun_direction(dt)
    radiance=star_radiance(bs,dt,R)
    radiance=moon_transport(bs,dt,R).over(radiance)
    ground,depth=globe_radiance(bs,sun,dt,return_depth=True,weather_dt=weather_dt)
    radiance=ground.over(radiance)
    altitude=aircraft_altitude(t,bs)
    plane=transport_depth=None
    if with_aircraft:
        from aircraft import plane_radiance,anchor_depth
        tick=int(np.clip(round(t*FPS),0,FRAME_COUNT-1))
        plane=plane_radiance(MOTION,t,tick,altitude_m=altitude*max(1,RELIEF_EXAGGERATION))
        transport_depth=np.where(np.isfinite(plane.depth),plane.depth,
                                 anchor_depth(R,altitude*max(1,RELIEF_EXAGGERATION)))
    cloud_result=None
    if TRANSPORT == 'joint':
        from jointtransport import joint_transport
        radiance=joint_transport(bs,sun,weather_dt,R,surface_depth=depth,
                                 with_clouds=WITH_WEATHER,physical_dt=dt).over(radiance)
    elif WITH_WEATHER:
        cloud_result=render_cloud_volume(bs,sun,weather_dt,R,altitude,
                                        surface_depth=depth,aircraft_depth=transport_depth,
                                        include_foreground=with_aircraft,physical_dt=dt)
        radiance=cloud_result.layer.over(radiance)
    if TRANSPORT == 'layered':
        radiance=atmosphere_transport(bs,sun,R,surface_depth=depth,physical_dt=dt,
            weather_dt=weather_dt,with_clouds=WITH_WEATHER).over(radiance)
    radiance.setflags(write=False)
    depth.setflags(write=False)
    return radiance,cloud_result,depth,plane




def _composite_scene(t):
    """Linear HDR scene including the aircraft and all foreground extinction."""
    global R
    radiance,cloud_result,depth,plane=_scene(float(t))
    radiance=radiance.copy()
    R=zoom(t)
    bs=camera(t)
    # Terrain occlusion uses the metre-scale airframe footprint. Its enlarged
    # display footprint is still used by the cloud and atmosphere view paths.
    top,left=CY-112,CX-112
    from aircraft import terrain_visibility
    in_front=terrain_visibility(plane,R,aircraft_altitude(t,bs),max(1,RELIEF_EXAGGERATION),
                                bs,TERRAIN_SAMPLER.sample)
    alpha=plane.alpha*in_front[...,None]
    light=plane.radiance*in_front[...,None]
    if cloud_result is not None:
        foreground=cloud_result.foreground_layer
        light=foreground.radiance*alpha+foreground.transmittance*light
    from aircraft import anchor_depth
    transport_depth=np.where(np.isfinite(plane.depth),plane.depth,
        anchor_depth(R,aircraft_altitude(t,bs)*max(1,RELIEF_EXAGGERATION)))
    if TRANSPORT == 'joint':
        from jointtransport import joint_transport
        haze=joint_transport(bs,sun_direction(travel_time(t)),TRIP.weather_time(t),R,
                             size=(224,224),center=(112,112),depth=transport_depth,
                             sensor_width=1080,scale=1,with_clouds=WITH_WEATHER,physical_dt=travel_time(t))
    else:
        haze=atmosphere_transport(bs,sun_direction(travel_time(t)),R,
                                  size=(224,224),center=(112,112),depth=transport_depth,
                                  sensor_width=1080,scale=1,physical_dt=travel_time(t),
                                  weather_dt=TRIP.weather_time(t),with_clouds=WITH_WEATHER)
    light=haze.radiance*alpha+haze.transmittance*light
    background=radiance[top:top+224,left:left+224]
    radiance[top:top+224,left:left+224]=source_over(light,alpha,background)
    return radiance,alpha


def frame(t):
    """Reuse the expensive HDR scene; apply current exposure and overlays."""
    radiance,alpha=cached_scene(float(t),lambda:_composite_scene(float(t)))
    return composite_overlays(t,radiance,alpha)
