"""Optional MLX Metal solar optical-depth kernel, with NumPy roundtrip API.

This module accelerates the nested atmospheric integral; metal_clouds also
accelerates cloud density and light paths, including the joint primary Sun.
Optional cloud view density/prefix integration is also accelerated. Geometry,
compositing, cache management and some lighting remain CPU code. MLX is imported
lazily; it is not a dependency of ordinary CPU rendering. Float32 GPU arithmetic
is numerically close to, but not bit-identical with, the float64 CPU reference.
"""
from functools import lru_cache
import importlib.metadata
import numpy as np


@lru_cache(maxsize=1)
def backend():
    try:
        import mlx.core as mx
        if not mx.metal.is_available():
            raise RuntimeError('MLX has no Metal device.')
    except (ImportError, OSError, RuntimeError) as exc:
        raise RuntimeError('Optional MLX Metal compute is unavailable; use --compute cpu.') from exc
    return mx


def device_info():
    mx=backend()
    device=mx.device_info() if hasattr(mx,'device_info') else mx.metal.device_info()
    return {'backend':'metal','mlx_version':importlib.metadata.version('mlx'),
            'device_name':device.get('device_name'),'architecture':device.get('architecture'),
            'precision':'float32','scope':'weather field preparation and wind backtraces, atmospheric solar optical depth, cloud density and cloud light-path optical depth (including joint primary Sun); optional batched atmosphere/cloud views and cloud sources'}


@lru_cache(maxsize=1)
def kernel():
    mx=backend()
    return mx.fast.metal_kernel(name='flight_atmosphere_solar_tau',
        input_names=['points','directions','lengths','constants','columns'],output_names=['out'],
        source='''
        uint i = thread_position_in_grid.x;
        if (i >= lengths_shape[0]) return;
        float3 p = float3(points[3*i], points[3*i+1], points[3*i+2]);
        float3 d = float3(directions[3*i], directions[3*i+1], directions[3*i+2]);
        float extent = metal::max(lengths[i], 0.0f);
        float step = extent * constants[0] / SAMPLES;
        float sr = 0.0f, sm = 0.0f, uncertain = 0.0f;
        if (LOOKUP) {
            float radius=metal::length(p),height=(radius-1.0f)*constants[0];
            float b=metal::dot(p,d),mu=b/radius;
            float outer=1.0f+constants[1]/constants[0];
            float delta=(outer-radius)*(outer+radius);
            float expected=delta/(metal::sqrt(metal::max(b*b+delta,0.0f))+b);
            // Near-ground float32 classification still uses the original
            // float64 repair below. Tangents and partial paths stay marched.
            if (height>=.02f && height<constants[1]-.02f && mu>=.02f && mu<=1.000001f
                    && metal::abs(metal::length(d)-1.0f)<1e-6f && extent>0.0f
                    && metal::abs(extent-expected)<2e-7f) {
                float y=metal::log(1.0f+height/4.0f)/metal::log(1.0f+constants[1]/4.0f)*511.0f;
                float x=(metal::sqrt(metal::min(mu,1.0f))-metal::sqrt(.02f))/(1.0f-metal::sqrt(.02f))*511.0f;
                uint iy=metal::min(uint(y),510u),ix=metal::min(uint(x),510u);
                float fy=y-float(iy),fx=x-float(ix);
                uint a=2u*(iy*512u+ix),c=a+1024u;
                sr=metal::mix(metal::mix(columns[a],columns[a+2],fx),metal::mix(columns[c],columns[c+2],fx),fy);
                sm=metal::mix(metal::mix(columns[a+1],columns[a+3],fx),metal::mix(columns[c+1],columns[c+3],fx),fy);
                out[4*i]=sr*constants[4]+sm*constants[7];
                out[4*i+1]=sr*constants[5]+sm*constants[7];
                out[4*i+2]=sr*constants[6]+sm*constants[7];
                out[4*i+3]=0.0f;
                return;
            }
        }
        for (uint j=0; j<SAMPLES; ++j) {
            float3 q = p + d * ((float(j)+0.5f)*extent/SAMPLES);
            float height = (metal::length(q)-1.0f)*constants[0];
            if (metal::abs(height) < 0.02f || metal::abs(height-constants[1]) < 0.02f) uncertain = 1.0f;
            if (height >= 0.0f && height < constants[1]) {
                sr += metal::exp(-height/constants[2])*step;
                sm += metal::exp(-height/constants[3])*step;
            }
        }
        out[4*i] = sr*constants[4] + sm*constants[7];
        out[4*i+1] = sr*constants[5] + sm*constants[7];
        out[4*i+2] = sr*constants[6] + sm*constants[7];
        out[4*i+3] = uncertain;
        ''')


@lru_cache(maxsize=4)
def _column_upload(samples,constants):
    from atmosphere_lookup import column_table
    return backend().array(column_table(samples,constants).astype(np.float32))


def optical_depth(points,directions,length,*,samples=10,constants,lookup=False):
    """Same spherical midpoint integral as atmosphere.optical_depth.

    constants = Earth km, outer height km, Rayleigh/Mie scale heights km,
    three Rayleigh coefficients, and Mie extinction coefficient.
    Inputs and returned arrays are CPU NumPy values, including synchronization.
    """
    if isinstance(samples,bool) or not isinstance(samples,(int,np.integer)) or samples<1:
        raise ValueError('Optical depth requires positive integer samples')
    original_points,original_directions,original_length=points,directions,length
    original_constants=np.asarray(constants,np.float64)
    length=np.asarray(length,np.float32)
    shape=length.shape
    points=np.broadcast_to(np.asarray(points,np.float32),shape+(3,))
    directions=np.broadcast_to(np.asarray(directions,np.float32),shape+(3,))
    constants=np.asarray(constants,np.float32)
    if constants.shape!=(8,) or not np.isfinite(constants).all():
        raise ValueError('Expected eight finite atmosphere constants')
    if not length.size:return np.empty(shape+(3,),np.float32)
    mx=backend()
    arrays=[mx.array(np.ascontiguousarray(value)) for value in
            (points.reshape(-1,3),directions.reshape(-1,3),length.ravel(),constants)]
    arrays.append(_column_upload(int(samples),tuple(original_constants)) if lookup else mx.array([0.],dtype=mx.float32))
    output=kernel()(inputs=arrays,template=[('SAMPLES',int(samples)),('LOOKUP',bool(lookup))],
                    grid=(length.size,1,1),threadgroup=(256,1,1),
                    output_shapes=[(length.size,4)],output_dtypes=[mx.float32],stream=mx.gpu)[0]
    # Array conversion synchronizes and includes the GPU->CPU boundary.
    result=np.array(output)
    uncertain=result[:,3]>0
    if np.any(uncertain):
        # Float32 cannot decide the discontinuous ground/outer density mask at
        # millimetre-to-metre distances reliably. Re-evaluate only rays with a
        # sample within 20 m of either boundary using original float64 inputs.
        # This prevents sparse bright/dark pixels without moving the boundary.
        p=np.broadcast_to(np.asarray(original_points,np.float64),shape+(3,)).reshape(-1,3)[uncertain]
        d=np.broadcast_to(np.asarray(original_directions,np.float64),shape+(3,)).reshape(-1,3)[uncertain]
        extent=np.maximum(np.asarray(original_length,np.float64).ravel()[uncertain],0)
        earth,outer,hr,hm,*coeff=original_constants
        sr=np.zeros(len(p));sm=np.zeros(len(p));step=extent*earth/samples
        for index in range(samples):
            query=p+d*((index+.5)*extent/samples)[:,None]
            height=(np.linalg.norm(query,axis=-1)-1)*earth
            valid=(height>=0)&(height<outer)
            sr+=np.exp(-np.maximum(height,0)/hr)*step*valid
            sm+=np.exp(-np.maximum(height,0)/hm)*step*valid
        result[uncertain,:3]=sr[:,None]*np.asarray(coeff[:3])+sm[:,None]*coeff[3]
    return result[:,:3].copy().reshape(shape+(3,))
