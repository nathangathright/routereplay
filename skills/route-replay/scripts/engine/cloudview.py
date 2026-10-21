"""Tiled cloud view integration with a fused Metal density/prefix pass.

The CPU retains exact spherical-shell, finite-Sun and opaque-depth boundaries.
One GPU invocation walks each view ray front to back, evaluates shared density,
and records only contributions before the existing transmittance cutoff. The
complete solar, sky, lunar and city sources then run as a batch, preserving their
physical/weather clocks. A second GPU pass sums those weighted sources per ray.
This is not a fully GPU lighting solver: city/sky/lunar source preparation and
geometry still use CPU code. Tiling bounds scratch memory independently of film
resolution and never reuses previous-frame pixels.
"""
import numpy as np

from camera_geometry import sphere_interval
from solar_visibility import shadow_boundaries, split_intervals

# A delivery tile has about 2e5 samples before penumbra subdivision. This avoids
# multiplying all of a 1080p frame's samples by the many lighting scratch arrays.
TILE_RAYS = 4096


def view_samples(origins, rays, start, stop, sun, *, substeps, height_exaggeration,
                 earth_m=6371000., max_altitude_m=16000., vertical_step_m=1000.):
    """Return ray-major sample positions and physical steps, including exact cuts.

    Zero steps are inactive slots. Geometry retains the caller's precision;
    only the density kernel converts positions to float32, as the reference does.
    Samples stay in front-to-back order, including limb rays crossing both
    halves. The aircraft/terrain stop is already clipped by the caller.
    """
    rays=np.asarray(rays).reshape(-1,3)
    origins=np.broadcast_to(np.asarray(origins),rays.shape)
    start=np.broadcast_to(np.asarray(start),(len(rays),))
    stop=np.broadcast_to(np.asarray(stop),(len(rays),))
    if isinstance(substeps,bool) or int(substeps)!=substeps or substeps<1:
        raise ValueError('Cloud view substeps must be a positive integer')
    heights=np.arange(0,max_altitude_m+vertical_step_m,vertical_step_m)
    intervals=[sphere_interval(origins,rays,1+h*height_exaggeration/earth_m) for h in heights]
    closest=-np.sum(origins*rays,axis=-1)
    pieces=[]
    for index in range(len(heights)-2,-1,-1):
        lower,upper=intervals[index],intervals[index+1]
        pieces.append((upper[0],np.where(lower[2],lower[0],closest),upper[2]))
    for index in range(len(heights)-1):
        lower,upper=intervals[index],intervals[index+1]
        pieces.append((np.where(lower[2],lower[1],closest),upper[1],upper[2]))
    def intervals_in_order():
        for a,b,hit in pieces:
            for j in range(int(substeps)):
                begin=np.maximum(a+(b-a)*(j/substeps),start)
                end=np.minimum(a+(b-a)*((j+1)/substeps),stop)
                yield begin,end,hit
    positions=[];steps=[]
    for begin,end,hit in split_intervals(intervals_in_order(),shadow_boundaries(origins,rays,sun)):
        active=hit&(end>begin)
        # Avoid inf/NaN arithmetic for rays missing this shell. Inactive positions
        # have zero length and are never sampled by the GPU.
        middle=np.where(active,(np.where(active,begin,0)+np.where(active,end,0))*.5,0)
        positions.append(origins+rays*middle[:,None])
        steps.append(np.where(active,end-begin,0)*earth_m/height_exaggeration)
    if not positions:return np.empty((len(rays),0,3),np.float32),np.empty((len(rays),0),np.float32)
    return np.stack(positions,axis=1),np.asarray(np.stack(steps,axis=1),np.float32)


def integrate_cloud_view(origins,rays,start,stop,dt,sun,*,fields=None,substeps=None,
                         sun_samples=None,strength=None,physical_dt=None,tile_rays=TILE_RAYS,
                         return_guide=False):
    """Complete cloud-only view integration with reference lighting sources.

    Called only for Metal + cloud_lighting=1; legacy normal-based lighting keeps
    its reference integrator. Backend errors propagate rather than change output
    halfway through a movie. Finite solar visibility is still evaluated by the
    full source functions, not inferred from the density/prefix kernel.
    ``return_guide`` appends the opacity-weighted sample distance in Earth radii;
    zero means no cloud contribution. It reuses the bounded prefix tile.
    """
    import cloudvolume as cloud
    from metal_clouds import cloud_view_prefix, cloud_view_radiance
    from quality import get_quality
    from weatherfields import timestamp
    rays=np.asarray(rays).reshape(-1,3)
    origins=np.broadcast_to(np.asarray(origins),rays.shape)
    start=np.broadcast_to(np.asarray(start),(len(rays),))
    stop=np.broadcast_to(np.asarray(stop),(len(rays),))
    if isinstance(tile_rays,bool) or int(tile_rays)!=tile_rays or tile_rays<1:
        raise ValueError('Cloud view tile must have a positive integer ray count')
    fields=cloud._frame_fields(timestamp(dt)) if fields is None else fields
    substeps=get_quality().cloud_substeps if substeps is None else substeps
    strength=cloud.TRIP.style.get('cloud_strength',1.) if strength is None else strength
    radiance=np.zeros((len(rays),3),np.float32);transmission=np.ones(len(rays),np.float32)
    guide=np.zeros(len(rays),np.float32) if return_guide else None
    for offset in range(0,len(rays),int(tile_rays)):
        selected=slice(offset,offset+int(tile_rays));local_rays=rays[selected]
        positions,steps=view_samples(origins[selected],local_rays,start[selected],stop[selected],sun,
            substeps=substeps,height_exaggeration=cloud.HEIGHT_EXAGGERATION,
            earth_m=cloud.EARTH_M,max_altitude_m=cloud.MAX_ALTITUDE_M,vertical_step_m=cloud.VERTICAL_STEP_M)
        if not steps.shape[1]:continue
        sigma,weights,transmission[selected]=cloud_view_prefix(positions,steps,fields,noise=cloud._NOISE,
            strength=strength,height_exaggeration=cloud.HEIGHT_EXAGGERATION,
            morphology=cloud.TRIP.style.get('cloud_morphology',1.))
        row,column=np.nonzero(weights>0)
        if not len(row):continue
        points=positions[row,column];ray=local_rays[row]
        if return_guide:
            distance=np.sum((points-origins[selected][row])*ray,axis=-1)
            mass=np.bincount(row,weights=weights[row,column],minlength=len(local_rays))
            moment=np.bincount(row,weights=weights[row,column]*distance,minlength=len(local_rays))
            guide[selected]=np.divide(moment,mass,out=np.zeros_like(moment),where=mass>0)
        up=points/np.maximum(np.linalg.norm(points,axis=-1,keepdims=True),1e-8)
        colors=cloud._sample_source(points,ray,sun,dt,fields,sigma[row,column],up,
            strength=strength,sun_samples=sun_samples,physical_dt=physical_dt)
        offsets=np.concatenate(([0],np.cumsum(np.bincount(row,minlength=len(local_rays))))).astype(np.uint32)
        radiance[selected]=cloud_view_radiance(colors,weights[row,column],offsets)
    return (radiance,transmission,guide) if return_guide else (radiance,transmission)
