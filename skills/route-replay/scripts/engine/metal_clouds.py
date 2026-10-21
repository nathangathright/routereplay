"""Optional fused Metal cloud light-path integral; NumPy inputs and output.

View-path cloud density and joint primary solar depth share these kernels.
View prefix integration has an optional fused kernel; full source preparation
remains shared with the CPU reference. Immutable
weather snapshots and periodic textures are uploaded once (two cached entries
of each); mutable inputs are uploaded afresh. MLX is imported only on use.
The shader mirrors CPU density formulas. Any density/constants change must run
the real-Metal parity suite; CPU-only test skips cannot validate this backend.
"""
from collections import OrderedDict
from functools import lru_cache
import numpy as np
from camera_geometry import sphere_interval
from cloudshapes import billow_texture, CELL_SPACING_M, RADIAL_STRETCH, CELL_VOXELS
from metal_compute import backend
from cloud_occupancy import macro_support

EARTH_M=6_371_000.
_FIELD_CACHE=OrderedDict()
_TEXTURE_CACHE=OrderedDict()


def clear_upload_cache():
    """Release resident snapshots, useful between independent rendering jobs."""
    _FIELD_CACHE.clear();_TEXTURE_CACHE.clear()


def _remember(cache,key,value):
    cache[key]=value;cache.move_to_end(key)
    while len(cache)>2:cache.popitem(last=False)
    return value


def _fields(fields):
    if len(fields)!=3 or any(len(layer) not in (6,10) for layer in fields):
        raise ValueError('Expected three cloud layers with six or ten fields each')
    arrays=[np.asarray(a) for layer in fields for a in layer[:9 if len(layer)==10 else 6]]
    weights=tuple(float(layer[9]) if len(layer)==10 else 0. for layer in fields)
    key=tuple(id(a) for a in arrays)+weights
    immutable=all(not a.flags.writeable for a in arrays)
    if immutable and key in _FIELD_CACHE:
        _FIELD_CACHE.move_to_end(key)
        return _FIELD_CACHE[key][1:]
    shape=arrays[0].shape
    if (len(shape)!=2 or min(shape)<2 or any(a.shape!=shape for a in arrays)
            or any(not np.isfinite(a).all() for a in arrays)
            or any(not np.isfinite(w) or not 0<=w<=1 for w in weights)):
        raise ValueError('Cloud fields must have a common finite 2D grid and blend weights in [0, 1]')
    packed=np.stack([np.stack(layer[:9] if len(layer)==10 else (*layer,*layer[3:6])) for layer in fields]).astype(np.float32)
    mx=backend();result=(mx.array(packed.ravel()),mx.array(weights,dtype=mx.float32),mx.array(macro_support(fields)),shape)
    if immutable:_remember(_FIELD_CACHE,key,(arrays,*result))
    return result


def _textures(noise):
    billows=billow_texture()
    arrays=(np.asarray(noise),billows)
    if any(a.shape!=(64,64,64) for a in arrays):raise ValueError('Cloud textures must be 64 cubed')
    key=tuple(id(a) for a in arrays)
    immutable=all(not a.flags.writeable for a in arrays)
    if immutable and key in _TEXTURE_CACHE:
        _TEXTURE_CACHE.move_to_end(key);return _TEXTURE_CACHE[key][1]
    if any(not np.isfinite(a).all() for a in arrays):raise ValueError('Cloud textures must be finite')
    mx=backend();result=[mx.array(np.ascontiguousarray(a,dtype=np.float32).ravel()) for a in arrays]
    if immutable:_remember(_TEXTURE_CACHE,key,(arrays,result))
    return result


_HEADER=r'''
float smooth_cloud(float a,float b,float x) {
    float v=metal::clamp((x-a)/(b-a),0.0f,1.0f);return v*v*(3.0f-2.0f*v);
}
int wrap_cloud(int i,int n) { int r=i%n;return r<0?r+n:r; }
float field_cloud(const device float* f,float row,float col,int rows,int cols) {
    int r=int(metal::floor(row)),c=int(metal::floor(col));float y=row-float(r),x=col-float(c);
    int r0=wrap_cloud(r,rows),r1=wrap_cloud(r+1,rows),c0=wrap_cloud(c,cols),c1=wrap_cloud(c+1,cols);
    return metal::mix(metal::mix(f[r0*cols+c0],f[r0*cols+c1],x),metal::mix(f[r1*cols+c0],f[r1*cols+c1],x),y);
}
float texture_cloud(const device float* f,float3 point) {
    float3 lower=metal::floor(point),fraction=point-lower;int3 q=int3(lower);
    int x0=q.x&63,x1=(q.x+1)&63,y0=q.y&63,y1=(q.y+1)&63,z0=q.z&63,z1=(q.z+1)&63;
    float a=metal::mix(f[(x0*64+y0)*64+z0],f[(x0*64+y0)*64+z1],fraction.z);
    float b=metal::mix(f[(x0*64+y1)*64+z0],f[(x0*64+y1)*64+z1],fraction.z);
    float c=metal::mix(f[(x1*64+y0)*64+z0],f[(x1*64+y0)*64+z1],fraction.z);
    float d=metal::mix(f[(x1*64+y1)*64+z0],f[(x1*64+y1)*64+z1],fraction.z);
    return metal::mix(metal::mix(a,b,fraction.y),metal::mix(c,d,fraction.y),fraction.x);
}
float shape_cloud(float3 seed,float altitude,float base,float centroid,float cover,int layer,
                  const device float* noise,const device float* billows,const device float* params,bool morphology) {
    float top_depth=params[layer*5+2];
    if (morphology) {
        float3 material=seed*(6371000.0f+altitude*params[layer*5+4])+float3(183000.0f,97000.0f,251000.0f)*float(layer);
        float scale=params[layer*5+3];
        float large=texture_cloud(billows,material/scale);
        float small=texture_cloud(billows,(material+float3(7131.0f,12791.0f,3911.0f))/(scale*.43f));
        float broad=texture_cloud(noise,material/56000.0f);
        float body=layer<2 ? .78f*large+.22f*broad : .45f*large+.55f*broad;
        float top=metal::min(15900.0f,centroid+top_depth*(.55f+1.3f*body));
        float span=metal::max(700.0f,top-base),fraction=metal::clamp((altitude-base)/span,0.0f,1.0f);
        float envelope=30.0f*fraction*fraction*(1.0f-fraction)*(1.0f-fraction)/span;
        float coverage=metal::clamp(cover,0.0f,1.0f),threshold=.68f-.49f*coverage;
        float occupancy=smooth_cloud(threshold-.10f,threshold+.10f,body-.08f*(1.0f-small));
        return envelope*occupancy*(.8f+.4f*broad)/(.30f+.70f*coverage);
    }
    float3 material=seed*(6371000.0f+altitude)+float3(183000.0f,97000.0f,251000.0f)*float(layer);
    float broad=texture_cloud(noise,material/56000.0f),middle=texture_cloud(noise,material/19000.0f),fine=texture_cloud(noise,material/6500.0f);
    float body=smooth_cloud(.25f,.72f,.67f*broad+.33f*middle);
    float top=metal::min(15900.0f,centroid+top_depth*(.45f+1.45f*body));
    float span=metal::max(700.0f,top-base),fraction=metal::clamp((altitude-base)/span,0.0f,1.0f);
    float shape=30.0f*fraction*fraction*(1.0f-fraction)*(1.0f-fraction)/span;
    float detail=.28f+1.55f*metal::pow(body,.85f)*(.75f+.5f*fine);
    detail=1.0f+(detail-1.0f)*smooth_cloud(0.0f,.18f,fraction);
    return detail*shape;
}
float density_cloud(float3 q,const device float* fields,float3 blend,const device uint* support,
                    const device float* noise,const device float* billows,const device float* params,
                    int rows,int cols,float strength,float exaggeration,bool morphology,bool occupancy) {
    float radius=metal::length(q),altitude=(radius-1.0f)*6371000.0f/exaggeration;
    if (altitude<=120.0f || altitude>=15900.0f)return 0.0f;
    float lat=metal::asin(metal::clamp(q.z/metal::max(radius,1e-8f),-1.0f,1.0f))*57.29577951308232f;
    float lon=(q.x==0.0f && q.y==0.0f) ? 0.0f : metal::atan2(q.y,q.x)*57.29577951308232f;
    if(lon<0.0f)lon+=360.0f;
    float row=metal::clamp((90.0f-lat)*float(rows-1)/180.0f,0.0f,float(rows-1)),col=lon*float(cols)/360.0f;
    if(occupancy) {
        uint bits=support[wrap_cloud(int(metal::floor(row)),rows)*cols+wrap_cloud(int(metal::floor(col)),cols)];
        if((bits & (1u << uint(altitude/1000.0f)))==0u)return 0.0f;
    }
    int size=rows*cols;float sigma=0.0f;
    for(int layer=0;layer<3;++layer) {
        const device float* field=fields+layer*9*size;
        float cover=field_cloud(field,row,col,rows,cols),raw=field_cloud(field+size,row,col,rows,cols);
        float centroid=field_cloud(field+2*size,row,col,rows,cols);
        float max_tau=params[layer*5],base_depth=params[layer*5+1],top_depth=params[layer*5+2];
        float exponent=-raw*.18f/max_tau;
        float attenuation=metal::abs(exponent)<.01f ? -exponent*(1.0f+exponent*(.5f+exponent/6.0f)) : 1.0f-metal::exp(exponent);
        float mass=max_tau*attenuation*metal::pow(cover,1.12f)*strength;
        float low=layer==0?900.0f:(layer==1?3300.0f:9000.0f),high=layer==0?3200.0f:(layer==1?7800.0f:13500.0f);
        centroid=metal::clamp(centroid,low,high);float base=metal::max(120.0f,centroid-base_depth);
        if(altitude<=base || altitude>=metal::min(15900.0f,centroid+top_depth*1.9f) || mass<=1e-7f)continue;
        float3 seed=float3(field_cloud(field+3*size,row,col,rows,cols),field_cloud(field+4*size,row,col,rows,cols),field_cloud(field+5*size,row,col,rows,cols));
        seed/=metal::max(metal::length(seed),1e-8f);
        float shape=shape_cloud(seed,altitude,base,centroid,cover,layer,noise,billows,params,morphology);
        if(morphology && blend[layer]>0.0f) {
            float3 second=float3(field_cloud(field+6*size,row,col,rows,cols),field_cloud(field+7*size,row,col,rows,cols),field_cloud(field+8*size,row,col,rows,cols));
            second/=metal::max(metal::length(second),1e-8f);
            float newer=shape_cloud(second,altitude,base,centroid,cover,layer,noise,billows,params,morphology);
            shape=shape*(1.0f-blend[layer])+newer*blend[layer];
        }
        sigma+=mass*shape;
    }
    return sigma;
}
'''


@lru_cache(maxsize=1)
def _kernel():
    return backend().fast.metal_kernel(name='flight_cloud_light_tau',
        input_names=['points','directions','intervals','fields','blend','support','noise','billows','params','constants'],
        output_names=['out'],header=_HEADER,source=r'''
        uint i=thread_position_in_grid.x;if(i>=points_shape[0])return;
        float3 p=float3(points[3*i],points[3*i+1],points[3*i+2]);
        float3 d=float3(directions[3*i],directions[3*i+1],directions[3*i+2]);
        float start=intervals[2*i],step=intervals[2*i+1],tau=0.0f;
        for(uint j=0;j<SAMPLES;++j) {
            float3 q=p+d*(start+(float(j)+.5f)*step);
            tau+=density_cloud(q,fields,float3(blend[0],blend[1],blend[2]),support,noise,billows,params,int(constants[0]),int(constants[1]),constants[2],constants[3],MORPHOLOGY,OCCUPANCY)*step*6371000.0f/constants[3];
        }
        out[i]=tau;
        ''')


def cloud_optical_depth(points,directions,fields,*,noise,samples,strength=1.,height_exaggeration=12.,morphology=1):
    """Cloud-only shell integral, including CPU/GPU transfer and synchronization.

    Inputs use Earth radii and unit directions, as the NumPy reference does.
    Field/texture uploads are reused only when all source arrays are read-only.
    Backend errors propagate; callers must select/fallback before rendering.
    """
    if isinstance(samples,bool) or not isinstance(samples,(int,np.integer)) or samples<1:
        raise ValueError('Cloud light integration requires positive integer samples')
    if morphology not in (0,1):raise ValueError('Cloud morphology must be zero or one')
    if not np.isfinite(strength) or strength<0 or not np.isfinite(height_exaggeration) or height_exaggeration<1:
        raise ValueError('Cloud strength and height exaggeration must be finite and nonnegative (height at least one)')
    points=np.asarray(points,np.float32)
    if points.ndim!=2 or points.shape[-1]!=3:raise ValueError('Expected cloud points shaped (N, 3)')
    directions=np.broadcast_to(np.asarray(directions,np.float32),points.shape)
    if not np.isfinite(points).all() or not np.isfinite(directions).all():raise ValueError('Cloud rays must be finite')
    tau=np.zeros(len(points),np.float32)
    if not len(points) or strength==0:return tau
    # Preserve CPU hit classification near grazing boundaries. This cheap
    # geometric step avoids making tangent paths backend-dependent.
    near,far,hit=sphere_interval(points,directions,1+16000.*height_exaggeration/EARTH_M)
    active=hit&(far>near)
    if not np.any(active):return tau
    start=near[active];step=(far[active]-start)/samples
    tau[active]=cloud_interval_optical_depth(points[active],directions[active],start,step,fields,
        noise=noise,samples=samples,strength=strength,height_exaggeration=height_exaggeration,morphology=morphology)
    return tau


def _density_inputs(fields,noise,strength,height_exaggeration,morphology):
    if morphology not in (0,1):raise ValueError('Cloud morphology must be zero or one')
    if not np.isfinite(strength) or strength<0 or not np.isfinite(height_exaggeration) or height_exaggeration<1:
        raise ValueError('Cloud strength must be nonnegative and height exaggeration at least one')
    mx=backend();packed,blend,support,(rows,cols)=_fields(fields);textures=_textures(noise)
    parameters=np.array(list(zip((6.,4.,2.),(700.,1200.,1500.),(1700.,2200.,2500.),
                                 np.asarray(CELL_SPACING_M)/CELL_VOXELS,RADIAL_STRETCH)),np.float32).ravel()
    return [packed,blend,support,*textures,mx.array(parameters),mx.array([rows,cols,strength,height_exaggeration],dtype=mx.float32)]


def cloud_interval_optical_depth(points,directions,start,step,fields,*,noise,samples,strength=1.,height_exaggeration=12.,morphology=1):
    """Fused midpoint integral over caller-clipped intervals, in Earth radii.

    Joint transport computes intervals and finite-Sun visibility on the CPU
    before calling this function. Each ray has one start and one per-sample
    step. No geometry or visibility is recomputed on the GPU.
    """
    if isinstance(samples,bool) or not isinstance(samples,(int,np.integer)) or samples<1:
        raise ValueError('Cloud light integration requires positive integer samples')
    points=np.asarray(points,np.float32)
    if points.ndim!=2 or points.shape[-1]!=3:raise ValueError('Expected cloud points shaped (N, 3)')
    directions=np.broadcast_to(np.asarray(directions,np.float32),points.shape)
    start=np.broadcast_to(np.asarray(start,np.float32),(len(points),));step=np.broadcast_to(np.asarray(step,np.float32),(len(points),))
    if any(not np.isfinite(a).all() for a in (points,directions,start,step)) or np.any(start<0) or np.any(step<0):
        raise ValueError('Cloud rays and nonnegative intervals must be finite')
    if not len(points):return np.empty(0,np.float32)
    mx=backend()
    arrays=[mx.array(np.ascontiguousarray(a,dtype=np.float32)) for a in (points,directions,np.stack([start,step],axis=-1))]
    arrays.extend(_density_inputs(fields,noise,strength,height_exaggeration,morphology))
    result=_kernel()(inputs=arrays,template=[('SAMPLES',int(samples)),('MORPHOLOGY',bool(morphology)),('OCCUPANCY',True)],
                     grid=(len(points),1,1),threadgroup=(256,1,1),output_shapes=[(len(points),)],output_dtypes=[mx.float32],stream=mx.gpu)[0]
    return np.array(result)


@lru_cache(maxsize=1)
def _density_kernel():
    return backend().fast.metal_kernel(name='flight_cloud_density',
        input_names=['points','fields','blend','support','noise','billows','params','constants'],output_names=['out'],header=_HEADER,source=r'''
        uint i=thread_position_in_grid.x;if(i>=points_shape[0])return;
        float3 q=float3(points[3*i],points[3*i+1],points[3*i+2]);
        out[i]=density_cloud(q,fields,float3(blend[0],blend[1],blend[2]),support,noise,billows,params,
            int(constants[0]),int(constants[1]),constants[2],constants[3],MORPHOLOGY,OCCUPANCY);
        ''')


def cloud_density(points,fields,*,noise,strength=1.,height_exaggeration=12.,morphology=1,occupancy=True):
    """Shared extinction coefficient in inverse physical metres; no normals."""
    points=np.asarray(points,np.float32)
    if points.ndim!=2 or points.shape[-1]!=3 or not np.isfinite(points).all():
        raise ValueError('Expected finite cloud points shaped (N, 3)')
    if not len(points):return np.empty(0,np.float32)
    mx=backend()
    arrays=[mx.array(np.ascontiguousarray(points)),*_density_inputs(fields,noise,strength,height_exaggeration,morphology)]
    result=_density_kernel()(inputs=arrays,template=[('MORPHOLOGY',bool(morphology)),('OCCUPANCY',bool(occupancy))],grid=(len(points),1,1),
        threadgroup=(256,1,1),output_shapes=[(len(points),)],output_dtypes=[mx.float32],stream=mx.gpu)[0]
    return np.array(result)


def probe():
    """Compile/evaluate both density models without loading a trip or weather."""
    layers=[]
    for height in (1500.,5500.,10500.):
        arrays=[np.full((3,4),value,np.float32) for value in (1.,3.,height,0.,0.,1.)]
        for array in arrays:array.setflags(write=False)
        layers.append(tuple(arrays))
    noise=np.full((64,64,64),.5,np.float32);noise.setflags(write=False)
    for morphology in (0,1):
        result=cloud_optical_depth([[0.,0.,1.002]],[0.,0.,1.],layers,noise=noise,samples=4,morphology=morphology)
        density=cloud_density([[0.,0.,1.004]],layers,noise=noise,morphology=morphology)
        if not np.isfinite(density).all() or not np.all(density>=0):raise RuntimeError('Metal cloud density probe returned invalid extinction')
        if result.shape!=(1,) or not np.isfinite(result).all() or not np.all(result>=0):
            raise RuntimeError('Metal cloud light-path probe returned invalid optical depth')
    sigma,weight,transmission=cloud_view_prefix(np.array([[[0.,0.,1.004]]]),np.array([[500.]]),
        layers,noise=noise)
    color=cloud_view_radiance(np.ones((1,3),np.float32),weight.ravel(),[0,1])
    if (not all(np.isfinite(a).all() for a in (sigma,weight,transmission,color))
            or not np.all((transmission>=0)&(transmission<=1))):
        raise RuntimeError('Metal cloud view probe returned invalid transport')
    clear_upload_cache()


@lru_cache(maxsize=1)
def _view_prefix_kernel():
    return backend().fast.metal_kernel(name='flight_cloud_view_prefix',
        input_names=['points','steps','fields','blend','support','noise','billows','params','constants'],
        output_names=['density','weight','transmission'],header=_HEADER,source=r'''
        uint i=thread_position_in_grid.x;if(i>=steps_shape[0])return;
        uint slots=steps_shape[1];float t=1.0f;
        for(uint j=0;j<slots;++j) {
            uint k=i*slots+j;float sigma=0.0f,w=0.0f;
            if(steps[k]>0.0f && t>1e-4f) {
                float3 p=float3(points[3*k],points[3*k+1],points[3*k+2]);
                sigma=density_cloud(p,fields,float3(blend[0],blend[1],blend[2]),support,noise,billows,params,
                    int(constants[0]),int(constants[1]),constants[2],constants[3],MORPHOLOGY,OCCUPANCY);
                if(sigma>1e-9f) {
                    float tau=sigma*steps[k];
                    float opacity=tau<.01f ? tau*(1.0f-tau*(.5f-tau/6.0f)) : 1.0f-metal::exp(-tau);
                    w=t*opacity;t*=1.0f-opacity;
                }
            }
            density[k]=sigma;weight[k]=w;
        }
        transmission[i]=t;
        ''')


def cloud_view_prefix(points,steps,fields,*,noise,strength=1.,height_exaggeration=12.,morphology=1):
    """Fuse all ordered view density samples and prefix transmission per ray.

    CPU-supplied positions/steps preserve exact clipped shell/penumbra geometry.
    Zero-length slots, empty density and already opaque rays consume no lighting
    work. The 1e-4 termination and 1e-9 occupancy cutoffs match the reference.
    """
    points=np.asarray(points,np.float32);steps=np.asarray(steps,np.float32)
    if points.ndim!=3 or points.shape[-1]!=3 or steps.shape!=points.shape[:2]:
        raise ValueError('Cloud view expects points (rays, slots, 3) and matching steps')
    if not np.isfinite(points).all() or not np.isfinite(steps).all() or np.any(steps<0):
        raise ValueError('Cloud view points and nonnegative steps must be finite')
    if not steps.size:return np.zeros_like(steps),np.zeros_like(steps),np.ones(len(steps),np.float32)
    mx=backend()
    arrays=[mx.array(np.ascontiguousarray(points)),mx.array(np.ascontiguousarray(steps)),
            *_density_inputs(fields,noise,strength,height_exaggeration,morphology)]
    result=_view_prefix_kernel()(inputs=arrays,template=[('MORPHOLOGY',bool(morphology)),('OCCUPANCY',True)],
        grid=(len(steps),1,1),threadgroup=(128,1,1),
        output_shapes=[steps.shape,steps.shape,(len(steps),)],output_dtypes=[mx.float32]*3,stream=mx.gpu)
    mx.eval(*result)
    return tuple(np.array(value) for value in result)


@lru_cache(maxsize=1)
def _view_radiance_kernel():
    return backend().fast.metal_kernel(name='flight_cloud_view_radiance',
        input_names=['colors','weights','offsets'],output_names=['radiance'],source=r'''
        uint i=thread_position_in_grid.x;if(i+1>=offsets_shape[0])return;
        float3 value=float3(0.0f);
        for(uint j=offsets[i];j<offsets[i+1];++j)
            value+=weights[j]*float3(colors[3*j],colors[3*j+1],colors[3*j+2]);
        radiance[3*i]=value.x;radiance[3*i+1]=value.y;radiance[3*i+2]=value.z;
        ''')


def cloud_view_radiance(colors,weights,offsets):
    """Finish front-to-back integration using already complete source colors."""
    colors=np.asarray(colors,np.float32);weights=np.asarray(weights,np.float32)
    raw=np.asarray(offsets)
    if (colors.ndim!=2 or colors.shape[-1]!=3 or weights.shape!=(len(colors),) or raw.ndim!=1
            or not len(raw) or not np.issubdtype(raw.dtype,np.integer) or raw[0]!=0
            or raw[-1]!=len(colors) or np.any(np.diff(raw.astype(np.int64))<0)):
        raise ValueError('Cloud radiance needs RGB samples, weights and ordered sample offsets')
    if any(not np.isfinite(a).all() or np.any(a<0) for a in (colors,weights)):
        raise ValueError('Cloud radiance colors and weights must be finite and nonnegative')
    if len(raw)==1:return np.empty((0,3),np.float32)
    mx=backend();offsets=np.asarray(raw,np.uint32)
    arrays=[mx.array(np.ascontiguousarray(a)) for a in (colors,weights,offsets)]
    result=_view_radiance_kernel()(inputs=arrays,grid=(len(raw)-1,1,1),threadgroup=(128,1,1),
        output_shapes=[(len(raw)-1,3)],output_dtypes=[mx.float32],stream=mx.gpu)[0]
    return np.array(result)
