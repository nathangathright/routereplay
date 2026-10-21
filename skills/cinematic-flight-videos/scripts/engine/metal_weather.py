"""Optional Metal preparation of immutable global cloud snapshots.

CPU code selects exact forecast brackets using float64 Unix timestamps. Only
relative seconds and interpolation weights reach the float32 GPU. The shader
mirrors the spherical midpoint wind transport and independent cover/profile
advection in weatherfields/cloudlayers; filtering source grids stays on CPU.
Resident source buffers are bounded and keep strong references to immutable
arrays; mutable inputs are never cached. CPU mode does not import MLX.
"""
from collections import OrderedDict
from functools import lru_cache
import numpy as np
from metal_compute import backend

_UPLOADS = OrderedDict()
_UPLOAD_LIMIT = 10


def clear_upload_cache():
    _UPLOADS.clear()


def _upload(arrays):
    arrays = tuple(np.asarray(a) for a in arrays)
    key = tuple(id(a) for a in arrays)
    immutable = all(not a.flags.writeable for a in arrays)
    if immutable and key in _UPLOADS:
        _UPLOADS.move_to_end(key)
        return _UPLOADS[key][1]
    if any(not np.isfinite(a).all() for a in arrays):
        raise ValueError('Weather fields must be finite')
    value = backend().array(np.concatenate([np.asarray(a, np.float32).ravel() for a in arrays]))
    if immutable:
        _UPLOADS[key] = arrays, value
        while len(_UPLOADS) > _UPLOAD_LIMIT: _UPLOADS.popitem(last=False)
    return value


_HEADER = r'''
int wrap_weather(int i,int n) { int r=i%n; return r<0?r+n:r; }
float grid_weather(const device float* f,float row,float col,int rows,int cols) {
    int r=int(metal::floor(row)),c=int(metal::floor(col));
    float y=row-float(r),x=col-float(c);
    int r0=wrap_weather(r,rows),r1=wrap_weather(r+1,rows);
    int c0=wrap_weather(c,cols),c1=wrap_weather(c+1,cols);
    return metal::mix(metal::mix(f[r0*cols+c0],f[r0*cols+c1],x),
                      metal::mix(f[r1*cols+c0],f[r1*cols+c1],x),y);
}
float2 angles_weather(float3 p) {
    return float2(metal::atan2(p.y,p.x),metal::atan2(p.z,metal::length(p.xy)));
}
float2 coords_weather(float2 a,float factor,float maxrow) {
    float lon=a.x*57.29577951308232f;
    lon=metal::fmod(lon,360.0f); if(lon<0.0f)lon+=360.0f;
    return float2(metal::clamp((90.0f-a.y*57.29577951308232f)*factor,0.0f,maxrow),lon*factor);
}
float volume_weather(const device float* f,float2 a,float level,int levels) {
    float2 c=coords_weather(a,2.0f,360.0f);
    int z=int(metal::floor(level)),next=metal::min(z+1,levels-1);
    return metal::mix(grid_weather(f+z*361*720,c.x,c.y,361,720),
                      grid_weather(f+next*361*720,c.x,c.y,361,720),level-float(z));
}
float2 wind_weather(const device float* wind,float2 a,float level,int index,float blend,int levels) {
    int stride=levels*361*720;
    float2 first=float2(volume_weather(wind+(index*2)*stride,a,level,levels),
                        volume_weather(wind+(index*2+1)*stride,a,level,levels));
    float2 last=float2(volume_weather(wind+((index+1)*2)*stride,a,level,levels),
                       volume_weather(wind+((index+1)*2+1)*stride,a,level,levels));
    // Separate multiplies mirror scipy float32 temporal interpolation.
    return first*(1.0f-blend)+last*blend;
}
float3 velocity_weather(float2 a,float2 w) {
    float so=metal::sin(a.x),co=metal::cos(a.x),sl=metal::sin(a.y),cl=metal::cos(a.y);
    return float3(-w.x*so-w.y*sl*co,w.x*co-w.y*sl*so,w.y*cl)/6371000.0f;
}
float2 displace_weather(float3 p,float2 a,float2 wind,float seconds) {
    float speed=metal::length(wind),angle=speed*seconds/6371000.0f;
    float3 tangent=velocity_weather(a,wind)*6371000.0f/metal::max(speed,1e-8f);
    return angles_weather(p*metal::cos(angle)+tangent*metal::sin(angle));
}
'''


@lru_cache(maxsize=1)
def _trace_kernel():
    return backend().fast.metal_kernel(name='flight_weather_midpoint',
        input_names=['points','wind','params'],output_names=['out'],header=_HEADER,
        source=r'''
        uint i=thread_position_in_grid.x; if(i>=COUNT*3)return;
        uint layer=i/COUNT; float level=params[5+layer];
        float3 point=float3(points[3*i],points[3*i+1],points[3*i+2]);
        float2 a=angles_weather(point);
        float2 w=wind_weather(wind,a,level,int(params[0]),params[1],LEVELS);
        float3 middle=metal::normalize(point+.5f*params[4]*velocity_weather(a,w));
        float2 ma=angles_weather(middle);
        float2 mw=wind_weather(wind,ma,level,int(params[2]),params[3],LEVELS);
        float3 result=metal::normalize(point+params[4]*velocity_weather(ma,mw));
        out[3*i]=result.x;out[3*i+1]=result.y;out[3*i+2]=result.z;
        ''')


@lru_cache(maxsize=1)
def _macro_kernel():
    return backend().fast.metal_kernel(name='flight_weather_macro',
        input_names=['points','angles','wind','covers','columns','params'],output_names=['out'],header=_HEADER,
        source=r'''
        uint i=thread_position_in_grid.x;if(i>=COUNT*3)return;
        uint layer=i/COUNT,location=i%COUNT;
        float3 p=float3(points[3*i],points[3*i+1],points[3*i+2]);
        float2 a=float2(angles[2*location],angles[2*location+1]);
        float2 w=wind_weather(wind,a,params[8+layer],0,params[0],LEVELS);
        float cover=0.0f,tau=0.0f,moment=0.0f;
        for(int side=0;side<2;++side) {
            float2 ca=displace_weather(p,a,w,params[3+side]);
            float2 cc=coords_weather(ca,4.0f,720.0f);
            float cv=grid_weather(covers+(layer*2+side)*721*1440,cc.x,cc.y,721,1440);
            cover+=cv*(side==0?1.0f-params[1]:params[1]);
            float2 pa=displace_weather(p,a,w,params[5+side]);
            float2 pc=coords_weather(pa,2.0f,360.0f);
            float weight=side==0?1.0f-params[2]:params[2];
            tau+=grid_weather(columns+(side*6+layer)*361*720,pc.x,pc.y,361,720)*weight;
            moment+=grid_weather(columns+(side*6+3+layer)*361*720,pc.x,pc.y,361,720)*weight;
        }
        out[3*i]=metal::clamp(cover,0.0f,1.0f);
        out[3*i+1]=metal::max(tau,0.0f);
        out[3*i+2]=tau>1e-6f?moment/metal::max(tau,1e-6f):(layer==0?1500.0f:(layer==1?5500.0f:12000.0f));
        ''')


def _boundaries(stamp, target, max_step_seconds=3600., max_steps=64):
    """Same epoch-anchored integration schedule as the CPU reference."""
    if stamp == target:return np.array([stamp],np.float64)
    count=max(1,int(np.ceil(abs(target-stamp)/max_step_seconds)))
    if count>max_steps:return np.linspace(stamp,target,max_steps+1)
    sign=1 if stamp>target else -1
    return np.r_[stamp,target+sign*np.arange(count-1,-1,-1)*max_step_seconds]


def _wind_buffers(weather, moments):
    u,v,times,heights=weather._winds()
    if u.ndim!=4 or u.shape!=v.shape or u.shape[2:]!=(361,720) or len(heights)!=u.shape[1]:
        raise ValueError('Metal weather requires the prepared half-degree wind grid; use --compute cpu')
    pairs=[weather.time_pair(times,float(moment)) for moment in moments]
    first=min(index for index,_ in pairs);last=max(index+1 for index,_ in pairs)
    arrays=[weather._wind_slice(component,index) for index in range(first,last+1) for component in (0,1)]
    return _upload(arrays),[(index-first,blend) for index,blend in pairs],heights


def _trace(points, stamp, target, weather, count):
    mx=backend();result=points
    schedule=_boundaries(stamp,target)
    for moment,end in zip(schedule[:-1],schedule[1:]):
        wind,pairs,heights=_wind_buffers(weather,(moment,moment+.5*(end-moment)))
        levels=np.interp((1500,5500,10500),heights,np.arange(len(heights)))
        params=mx.array([*pairs[0],*pairs[1],end-moment,*levels],dtype=mx.float32)
        result=_trace_kernel()(inputs=[result,wind,params],template=[('COUNT',count),('LEVELS',len(heights))],
            grid=(count*3,1,1),threadgroup=(256,1,1),output_shapes=[(3*count,3)],output_dtypes=[mx.float32],stream=mx.gpu)[0]
        # Bound the lazy graph even for 64-step legacy weather histories.
        mx.eval(result)
    return result


def frame_fields(lon,lat,stamp,*,shape,morphology,previous,current,blend,weather,layers):
    """Return the cloudvolume tuple contract with no timestamp quantization.

    Supports both renewable material charts and the legacy fixed epoch. Source
    forecast data is process-immutable, just as in the CPU runtime. Unsupported
    grids fail explicitly instead of silently switching implementations.
    """
    stamp=float(stamp)
    if not weather.MATERIAL_REFERENCE<=stamp<=weather.VALID_END:
        raise ValueError('Cloud material time lies outside verified weather coverage')
    lon,lat=np.broadcast_arrays(np.asarray(lon,np.float64),np.asarray(lat,np.float64))
    count=lon.size
    if count<1 or len(shape)!=2 or np.prod(shape)!=count or not np.isfinite(lon).all() or not np.isfinite(lat).all():
        raise ValueError('Expected finite geographic coordinates matching the output grid')
    mx=backend()
    unit=np.stack([np.cos(lat)*np.cos(lon),np.cos(lat)*np.sin(lon),np.sin(lat)],axis=-1).reshape(-1,3)
    points=mx.array(np.tile(unit,(3,1)).astype(np.float32))
    angles=mx.array(np.stack([lon.ravel(),lat.ravel()],axis=-1).astype(np.float32))
    wind,pairs,heights=_wind_buffers(weather,(stamp,))
    coverage,times=layers._forecast()
    if coverage.ndim!=4 or coverage.shape[1:]!=(3,721,1440):
        raise ValueError('Metal weather requires the prepared quarter-degree cover grid; use --compute cpu')
    cover_stamp=float(np.clip(stamp,times[0],times[-1]));ci,ca=weather.time_pair(times,cover_stamp)
    profile_stamp=float(np.clip(stamp,weather.PROFILE_TIMES[0],weather.PROFILE_TIMES[-1]))
    pi,pa=weather.time_pair(weather.PROFILE_TIMES,profile_stamp)
    cover_arrays=[layers._float_field(index,layer) for layer in range(3) for index in (ci,ci+1)]
    if any(a.shape!=(721,1440) for a in cover_arrays):
        raise ValueError('Metal weather requires the prepared quarter-degree cover fields; use --compute cpu')
    column_arrays=[array for index in (pi,pi+1) for array in layers._column_fields(int(weather.PROFILE_HOURS[index]))]
    if any(a.shape!=(3,361,720) for a in column_arrays):
        raise ValueError('Metal weather requires the prepared half-degree column grid; use --compute cpu')
    levels=np.interp((1500,5500,10500),heights,np.arange(len(heights)))
    params=mx.array([pairs[0][1],ca,pa,*(times[ci:ci+2]-cover_stamp),
        *(weather.PROFILE_TIMES[pi:pi+2]-profile_stamp),0.,*levels],dtype=mx.float32)
    macro=_macro_kernel()(inputs=[points,angles,wind,_upload(cover_arrays),_upload(column_arrays),params],
        template=[('COUNT',count),('LEVELS',len(heights))],grid=(count*3,1,1),threadgroup=(256,1,1),
        output_shapes=[(3*count,3)],output_dtypes=[mx.float32],stream=mx.gpu)[0]
    old=_trace(points,stamp,previous if morphology else weather.MATERIAL_REFERENCE,weather,count)
    new=old if previous==current else (_trace(points,stamp,current,weather,count) if morphology else old)
    mx.eval(macro,old,new)
    same_chart=new is old
    macro=np.array(macro).reshape(3,count,3);old=np.array(old).reshape(3,count,3)
    new=old if same_chart else np.array(new).reshape(3,count,3)
    # Spherical displacement is ill-conditioned at the exact poles, and the
    # empty-column height branch magnifies tiny float32 mass errors. Re-evaluate
    # only these sparse boundaries with the CPU reference (as other Metal
    # integrals do for tangent geometry), rather than silently changing them.
    polar=np.abs(lat.ravel())>np.radians(89.999)
    for layer in range(3):
        tau=macro[layer,:,1]
        uncertain=polar|((tau>1e-7)&(tau<1e-4))
        if np.any(uncertain):
            fixed=layers.sample_layer_fields(lon.ravel()[uncertain],lat.ravel()[uncertain],stamp,layer)
            macro[layer,uncertain]=np.stack(fixed,axis=-1)
    output=[]
    for layer in range(3):
        values=(*macro[layer].T,*old[layer].T)
        if morphology:values=(*values,*new[layer].T)
        arrays=[np.ascontiguousarray(a.reshape(shape)) for a in values]
        for array in arrays:array.setflags(write=False)
        output.append(tuple(arrays) if not morphology else (*arrays,float(blend)))
    return tuple(output)


def probe():
    """Compile/evaluate both kernels before choosing an auto/Metal render job."""
    mx=backend()
    points=mx.array([[1.,0.,0.]]*3,dtype=mx.float32)
    wind=mx.zeros((4*361*720,),dtype=mx.float32)
    trace=_trace_kernel()(inputs=[points,wind,mx.array([0.,0.,0.,0.,-60.,0.,0.,0.],dtype=mx.float32)],
        template=[('COUNT',1),('LEVELS',1)],grid=(3,1,1),threadgroup=(32,1,1),
        output_shapes=[(3,3)],output_dtypes=[mx.float32],stream=mx.gpu)[0]
    macro=_macro_kernel()(inputs=[points,mx.zeros((1,2),dtype=mx.float32),wind,
        mx.zeros((6*721*1440,),dtype=mx.float32),mx.zeros((12*361*720,),dtype=mx.float32),
        mx.zeros((11,),dtype=mx.float32)],template=[('COUNT',1),('LEVELS',1)],
        grid=(3,1,1),threadgroup=(32,1,1),output_shapes=[(3,3)],output_dtypes=[mx.float32],stream=mx.gpu)[0]
    if not np.isfinite(np.array(trace)).all() or not np.isfinite(np.array(macro)).all():
        raise RuntimeError('Metal weather probe returned nonfinite fields')
