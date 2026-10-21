"""Conservative coarse support for the continuous three-layer cloud density.

Each bilinear geographic cell stores 16 physical-kilometre altitude bits. A bit
may be set for empty space; an unset bit guarantees zero density. Bounds include
all four interpolation corners and the largest allowed morphology top, so this
optimization never lowers sampling near cloud edges or at the terminator.
"""
import numpy as np


def _corners(field):
    """The four corners used by grid-wrap bilinear sampling, including the seam."""
    value=np.asarray(field,np.float32)
    return value,np.roll(value,-1,axis=0),np.roll(value,-1,axis=1),np.roll(np.roll(value,-1,axis=0),-1,axis=1)


def macro_support(fields):
    """Return immutable uint32 masks matching the shared density's field grid."""
    if len(fields)!=3:raise ValueError('Cloud support requires three layers')
    shape=np.asarray(fields[0][0]).shape
    if len(shape)!=2 or min(shape)<2:raise ValueError('Cloud support needs a 2D macro grid')
    masks=np.zeros(shape,np.uint32)
    for index,layer in enumerate(fields):
        if len(layer)<3 or any(np.asarray(a).shape!=shape or not np.isfinite(a).all() for a in layer[:3]):
            raise ValueError('Cloud support fields must have a common finite grid')
        coverage=np.maximum.reduce(_corners(layer[0]))
        mass=np.maximum.reduce(_corners(layer[1]))
        centroid=np.asarray(layer[2],np.float32)
        # Clipping after interpolation stays between the clipped corner extrema.
        low=np.clip(np.minimum.reduce(_corners(centroid)),(900,3300,9000)[index],(3200,7800,13500)[index])
        high=np.clip(np.maximum.reduce(_corners(centroid)),(900,3300,9000)[index],(3200,7800,13500)[index])
        base=np.maximum(120,low-(700,1200,1500)[index])
        top=np.minimum(15900,high+(1700,2200,2500)[index]*1.9)
        occupied=(coverage>0)&(mass>0)
        for altitude in range(16):
            # Inclusive boundaries deliberately include neighboring bins. Tiny
            # position/interpolation roundoff can only add work, never a hole.
            intersects=occupied&(base<=(altitude+1)*1000+1)&(top>=altitude*1000-1)
            masks|=intersects.astype(np.uint32)<<np.uint32(altitude)
    masks.setflags(write=False)
    return masks
