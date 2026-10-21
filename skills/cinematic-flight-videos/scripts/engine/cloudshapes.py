"""Seeded cellular cloud structure, independent of camera, lighting and time.

Forecast cover, mass and height constrain this reconstruction; individual
billows are illustrative. The periodic texture is built once, not searched for
nearest cells at every transport sample. All coordinates are physical metres.
"""
from functools import lru_cache
import numpy as np
from scipy.ndimage import map_coordinates

EARTH_M=6_371_000.
CELL_SPACING_M=(24000.,32000.,54000.)
RADIAL_STRETCH=(6.,8.,12.)
TEXTURE_SIZE=64
CELL_VOXELS=8


def smoothstep(a,b,x):
    value=np.clip((x-a)/(b-a),0,1)
    return value*value*(3-2*value)


@lru_cache(maxsize=1)
def billow_texture():
    """Periodic inverted nearest-feature distance with deterministic jitter."""
    axes=np.indices((TEXTURE_SIZE,)*3,dtype=np.float32)/CELL_VOXELS
    cell=np.floor(axes).astype(np.int32)
    best=np.full((TEXTURE_SIZE,)*3,np.inf,np.float32)
    # A fixed neighborhood gives bounded, periodic cellular structure.
    for x in (-1,0,1):
        for y in (-1,0,1):
            for z in (-1,0,1):
                neighbor=cell+np.array([x,y,z])[:,None,None,None]
                wrapped=(neighbor%(TEXTURE_SIZE//CELL_VOXELS)).astype(np.uint32)
                hashed=wrapped[0]*np.uint32(73856093)^wrapped[1]*np.uint32(19349663)^wrapped[2]*np.uint32(83492791)
                distance=np.zeros_like(best)
                for axis in range(3):
                    hashed^=hashed>>np.uint32(13)
                    hashed*=np.uint32(1274126177)
                    hashed^=hashed>>np.uint32(16)
                    jitter=.15+.7*(hashed&np.uint32(0x00ffffff)).astype(np.float32)/16777215.
                    distance+=(axes[axis]-neighbor[axis]-jitter)**2
                np.minimum(best,distance,out=best)
    value=np.asarray(np.clip(1-np.sqrt(best),0,1),np.float32)
    value.setflags(write=False)
    return value


def sample_texture(texture,points,voxel_size):
    return map_coordinates(texture,(points/voxel_size).T,order=1,mode='grid-wrap',prefilter=False)


def density_shape(seed,altitude,base,centroid,cover,layer,value_noise):
    """Return normalized vertical envelope times carved 3D billow structure."""
    top_depth=(1700.,2200.,2500.)[layer]
    material=seed*(EARTH_M+altitude[:,None]*RADIAL_STRETCH[layer])
    material+=np.array([183000.,97000.,251000.],np.float32)*layer
    scale=CELL_SPACING_M[layer]/CELL_VOXELS
    large=sample_texture(billow_texture(),material,scale)
    small=sample_texture(billow_texture(),material+np.array([7131.,12791.,3911.],np.float32),scale*.43)
    broad=sample_texture(value_noise,material,56000.)
    # Broad lobes determine silhouettes. Small lobes softly erode their edges,
    # with less cellular contrast in the thin upper layer.
    body=(.78*large+.22*broad) if layer<2 else (.45*large+.55*broad)
    top=np.minimum(15900.,centroid+top_depth*(.55+1.3*body))
    span=np.maximum(700.,top-base)
    fraction=np.clip((altitude-base)/span,0,1)
    envelope=30*fraction**2*(1-fraction)**2/span
    threshold=.68-.49*np.clip(cover,0,1)
    occupancy=smoothstep(threshold-.10,threshold+.10,body-.08*(1-small))
    # Coverage already modulates column mass upstream. A bounded compensation
    # avoids applying its full attenuation twice when carving empty pockets.
    structure=occupancy*(.8+.4*broad)/(.30+.70*np.clip(cover,0,1))
    return np.asarray(envelope*structure,np.float32)
