"""Bounded, fused Metal camera-ray atmospheric transport.

Float64 CPU geometry retains the exact terrain/aircraft depths, shadow cuts and
finite-Sun visibility. Dated aerosol and topocentric lunar sources use their
unchanged functions, in batches. One Metal invocation per tile evaluates clear
solar optical depth and accumulates every view segment in order. Solar samples
near a discontinuous density boundary use the original float64 solar integral
and correct only their weighted solar contribution, without resampling the Moon. No temporal cache enters
this path; ordinary CPU rendering never imports MLX.
"""
from functools import lru_cache
import os
import numpy as np

# Bound scratch arrays independently of image resolution. At high quality with
# both lunar/aerosol cuts a tile has at most 4096 * 72 view slots; only nonempty
# intervals are uploaded. The kernel writes seven floats per ray and seven per
# sample (old solar source, observer weight and an ambiguity flag).
TILE_RAYS = 4096


@lru_cache(maxsize=1)
def kernel():
    from metal_compute import backend
    return backend().fast.metal_kernel(name='flight_atmosphere_view',
        input_names=['points','segments','external','phases','offsets','sun','constants','columns'],
        output_names=['out','repairs'],source='''
        uint ray = thread_position_in_grid.x;
        if (ray+1 >= offsets_shape[0]) return;
        float3 beta = float3(constants[4],constants[5],constants[6]);
        float3 view_tau = float3(0.0f), radiance = float3(0.0f);
        float3 d = float3(sun[0],sun[1],sun[2]);
        float pr=phases[2*ray],pm=phases[2*ray+1],uncertain=0.0f;
        for (uint i=offsets[ray]; i<offsets[ray+1]; ++i) {
            float3 p = float3(points[3*i],points[3*i+1],points[3*i+2]);
            float step_km=segments[5*i],height=segments[5*i+1];
            float extent=segments[5*i+2],visibility=segments[5*i+3],hemisphere=segments[5*i+4];
            float sr=metal::exp(-height/constants[2])*step_km;
            float sm=metal::exp(-height/constants[3])*step_km;
            float3 extra=float3(external[9*i],external[9*i+1],external[9*i+2]);
            float3 extra_solar=float3(external[9*i+3],external[9*i+4],external[9*i+5]);
            float3 lunar=float3(external[9*i+6],external[9*i+7],external[9*i+8]);
            float solar_sr=0.0f,solar_sm=0.0f;
            bool looked_up=false,needs_repair=false;
            if (LOOKUP) {
                float radius=metal::length(p),solar_height=(radius-1.0f)*constants[0];
                float b=metal::dot(p,d),mu=b/radius;
                float outer=1.0f+constants[1]/constants[0];
                float delta=(outer-radius)*(outer+radius);
                float expected=delta/(metal::sqrt(metal::max(b*b+delta,0.0f))+b);
                if (solar_height>=.02f && solar_height<constants[1]-.02f && mu>=.02f && mu<=1.000001f
                        && metal::abs(metal::length(d)-1.0f)<1e-6f && extent>0.0f
                        && metal::abs(extent-expected)<2e-7f) {
                    float y=metal::log(1.0f+solar_height/4.0f)/metal::log(1.0f+constants[1]/4.0f)*511.0f;
                    float x=(metal::sqrt(metal::min(mu,1.0f))-metal::sqrt(.02f))/(1.0f-metal::sqrt(.02f))*511.0f;
                    uint iy=metal::min(uint(y),510u),ix=metal::min(uint(x),510u);
                    float fy=y-float(iy),fx=x-float(ix);
                    uint a=2u*(iy*512u+ix),c=a+1024u;
                    solar_sr=metal::mix(metal::mix(columns[a],columns[a+2],fx),metal::mix(columns[c],columns[c+2],fx),fy);
                    solar_sm=metal::mix(metal::mix(columns[a+1],columns[a+3],fx),metal::mix(columns[c+1],columns[c+3],fx),fy);
                    looked_up=true;
                }
            }
            if (!looked_up) {
                float solar_step=extent*constants[0]/SAMPLES;
                for (uint j=0; j<SAMPLES; ++j) {
                    float3 q=p+d*((float(j)+0.5f)*extent/SAMPLES);
                    float solar_height=(metal::length(q)-1.0f)*constants[0];
                    if (metal::abs(solar_height)<.02f || metal::abs(solar_height-constants[1])<.02f) needs_repair=true;
                    if (solar_height>=0.0f && solar_height<constants[1]) {
                        solar_sr+=metal::exp(-solar_height/constants[2])*solar_step;
                        solar_sm+=metal::exp(-solar_height/constants[3])*solar_step;
                    }
                }
            }
            float3 solar_tau=solar_sr*beta+solar_sm*constants[7]+extra_solar;
            float3 segment_tau=sr*beta+sm*constants[7]+extra;
            float3 observer=metal::exp(-(view_tau+0.5f*segment_tau));
            float3 scatter=sr*beta*pr+sm*constants[8]*pm+extra*constants[10]*pm;
            float3 single=metal::exp(-solar_tau)*visibility*scatter;
            float3 fraction=1.0f-metal::exp(-metal::min(solar_tau,float3(8.0f)));
            float3 secondary=(sr*beta+sm*constants[8])*(1.0f/(4.0f*M_PI_F));
            secondary*=constants[9]*fraction*hemisphere;
            radiance+=observer*(single+secondary+lunar);
            float3 repair_source=needs_repair ? single+secondary : float3(0.0f);
            float3 repair_observer=needs_repair ? observer : float3(0.0f);
            repairs[7*i]=repair_source.x;repairs[7*i+1]=repair_source.y;repairs[7*i+2]=repair_source.z;
            repairs[7*i+3]=repair_observer.x;repairs[7*i+4]=repair_observer.y;repairs[7*i+5]=repair_observer.z;
            repairs[7*i+6]=needs_repair ? 1.0f : 0.0f;
            if (needs_repair) uncertain=1.0f;
            view_tau+=segment_tau;
        }
        out[7*ray]=radiance.x;out[7*ray+1]=radiance.y;out[7*ray+2]=radiance.z;
        out[7*ray+3]=view_tau.x;out[7*ray+4]=view_tau.y;out[7*ray+5]=view_tau.z;
        out[7*ray+6]=uncertain;
        ''')


def _run(points,segments,external,phases,offsets,sun,constants,*,samples,lookup):
    """Private typed boundary: compact row-major samples, uint32 ray offsets."""
    from metal_compute import backend, _column_upload
    mx=backend()
    count=len(offsets)-1
    arrays=[mx.array(np.ascontiguousarray(value,dtype=np.float32))
            for value in (points,segments,external,phases)]
    arrays.extend((mx.array(np.ascontiguousarray(offsets,dtype=np.uint32)),
        mx.array(np.asarray(sun,np.float32)),mx.array(np.asarray(constants,np.float32))))
    arrays.append(_column_upload(int(samples),tuple(constants[:8])) if lookup
                  else mx.array([0.],dtype=mx.float32))
    output=kernel()(inputs=arrays,template=[('SAMPLES',int(samples)),('LOOKUP',bool(lookup))],
        grid=(count,1,1),threadgroup=(256,1,1),output_shapes=[(count,7),(len(points),7)],
        output_dtypes=[mx.float32,mx.float32],stream=mx.gpu)
    mx.eval(*output)
    return tuple(np.array(value) for value in output)


def integrate_segments(origins,rays,sun,edges,*,sun_samples,multiple_scattering,
        physical_dt,weather_dt,with_clouds,gain,tile_rays=TILE_RAYS):
    """Integrate exact, already clipped view intervals, preserving dated sources.

    Returns radiance before the common solar/exposure gain and cumulative RGB
    optical depth. This is used only when both Metal and batched view are opted
    in. Kernel or source failures propagate; there is no silent backend change.
    """
    import atmosphere as air
    from camera_geometry import sphere_interval
    from solar_visibility import solar_visibility
    from environmentlighting import (product,aerosol_segment_depth,
        aerosol_optical_depth,SINGLE_SCATTER_ALBEDO)
    from lunar_scattering import atmosphere_source
    if isinstance(tile_rays,bool) or not isinstance(tile_rays,(int,np.integer)) or tile_rays<1:
        raise ValueError('Atmosphere tile must have a positive integer ray count')
    if isinstance(sun_samples,bool) or not isinstance(sun_samples,(int,np.integer)) or sun_samples<1:
        raise ValueError('Atmosphere requires positive integer solar samples')
    method=os.environ.get('FLIGHT_ATMOSPHERE_METHOD','integrate')
    if method not in ('integrate','lookup'):
        raise ValueError('Atmosphere method must be integrate or lookup')
    probability=min(.60,.38*multiple_scattering)
    constants=[air.EARTH_KM,air.OUTER_KM-air.EARTH_KM,air.H_R,air.H_M,
        *air.BETA_R,air.MIE_EXTINCTION,air.BETA_M,probability/(1-probability),SINGLE_SCATTER_ALBEDO]
    radiance=np.zeros((len(rays),3),np.float64);tau=np.zeros_like(radiance)
    has_aerosol=weather_dt is not None and product('aerosol') is not None
    for offset in range(0,len(rays),int(tile_rays)):
        selected=slice(offset,offset+int(tile_rays))
        ray=rays[selected];origin=origins[selected];local=edges[selected]
        row,column=np.nonzero(local[:,1:]>local[:,:-1])
        if not len(row):continue
        begin=local[row,column];finish=local[row,column+1];step=finish-begin
        points=origin[row]+ray[row]*((begin+finish)*.5)[:,None]
        radius=np.linalg.norm(points,axis=-1)
        height=np.maximum((radius-1)*air.EARTH_KM,0)
        _,solar_length,_=sphere_interval(points,sun,air.OUTER_KM/air.EARTH_KM)
        hemisphere=np.clip(((points@sun)/radius+.18)/.30,0,1)
        hemisphere=hemisphere*hemisphere*(3-2*hemisphere)
        segments=np.column_stack((step*air.EARTH_KM,height,solar_length,
            solar_visibility(points,sun),hemisphere))
        external=np.zeros((len(row),9),np.float64)
        if has_aerosol:
            external[:,:3]=aerosol_segment_depth(points,ray[row],step,weather_dt)
            external[:,3:6]=aerosol_optical_depth(points,sun,solar_length,weather_dt,samples=int(sun_samples))
        if physical_dt is not None and gain!=0:
            sr=np.exp(-height/air.H_R)*step*air.EARTH_KM
            sm=np.exp(-height/air.H_M)*step*air.EARTH_KM
            external[:,6:]=atmosphere_source(points,ray[row],sr,sm,physical_dt,weather_dt,
                gain=gain,with_clouds=with_clouds,samples=int(sun_samples),extra_tau=external[:,:3])
        mu=np.clip(ray@sun,-1,1)
        phases=np.column_stack((air.phase_rayleigh(mu),air.phase_mie(mu)))
        offsets=np.concatenate(([0],np.cumsum(np.bincount(row,minlength=len(ray))))).astype(np.uint32)
        output,repairs=_run(points,segments,external,phases,offsets,sun,constants,
            samples=sun_samples,lookup=method=='lookup')
        radiance[selected]=output[:,:3];tau[selected]=output[:,3:6]
        uncertain=repairs[:,6]>0
        if np.any(uncertain):
            # Only solar depth has a discontinuous float32 mask. Reuse the
            # exact original sample geometry and existing optical-depth repair,
            # then replace its weighted contribution. Segment extinction and
            # lunar light are unaffected and need no second evaluation.
            from metal_compute import optical_depth
            solar_tau=optical_depth(points[uncertain],sun,solar_length[uncertain],
                samples=sun_samples,constants=constants[:8],lookup=method=='lookup')
            solar_tau=solar_tau+external[uncertain,3:6]
            sr=np.exp(-height[uncertain]/air.H_R)*segments[uncertain,0]
            sm=np.exp(-height[uncertain]/air.H_M)*segments[uncertain,0]
            pr,pm=phases[row[uncertain]].T
            scatter=sr[:,None]*air.BETA_R*pr[:,None]+sm[:,None]*air.BETA_M*pm[:,None]
            scatter+=external[uncertain,:3]*SINGLE_SCATTER_ALBEDO*pm[:,None]
            single=np.exp(-solar_tau)*segments[uncertain,3,None]*scatter
            secondary=(sr[:,None]*air.BETA_R+sm[:,None]*air.BETA_M)/(4*np.pi)
            secondary*=constants[9]*(1-np.exp(-np.minimum(solar_tau,8)))*hemisphere[uncertain,None]
            delta=repairs[uncertain,3:6]*(single+secondary-repairs[uncertain,:3])
            # np.add.at preserves deterministic front-to-back order when a ray
            # has more than one uncertain solar sample.
            np.add.at(radiance,offset+row[uncertain],delta)
    return radiance,tau


def probe():
    """Compile and verify the optional camera kernel without a trip/data bundle."""
    constants=[6371.,720.,57.6,8.64,.0058/7.2,.0135/7.2,.0331/7.2,
        .0030/7.2/.9,.0030/7.2,.38/.62,.90]
    # Nonzero, zero-length and empty rays cover source output and ray bounds.
    # Compile both specializations now, including the asset-free clear-air LUT.
    for lookup in (False,True):
        result,repairs=_run(np.array([[0.,0.,1.01],[0.,0.,1.01]]),
            np.array([[1.,63.71,.1,1.,1.],[0.,63.71,.1,1.,1.]]),
            np.zeros((2,9)),np.ones((3,2)),np.array([0,1,2,2],np.uint32),
            np.array([0.,0.,1.]),constants,samples=6,lookup=lookup)
        if (result.shape!=(3,7) or not np.isfinite(result).all()
                or repairs.shape!=(2,7) or not np.isfinite(repairs).all()
                or np.any(result[0,:6]<=0) or np.any(result[1:,:6]!=0)):
            raise RuntimeError('Metal atmosphere camera probe returned invalid transport')
    return {'kernel':'atmosphere_view','rays':3,'samples':2,'precision':'float32'}
