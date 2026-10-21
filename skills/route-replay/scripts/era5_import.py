"""Convert user-acquired ERA5 pressure/single-level NetCDF to weather bundles.

No CDS credentials, licence acceptance, provider requests, or date substitution.
The original files and their declared source/license are retained in provenance.
"""
from datetime import datetime,timezone
import hashlib,json,tempfile
from pathlib import Path
import numpy as np
from dataset_netcdf import MAX_INPUT_BYTES,NetCDF,canonical_grid,resample_global
from environmental_data import provenance

PRESSURES=[1000,925,850,700,500,350,250,150]
ALTITUDES=np.arange(0,16001,1000,dtype=np.float32)
UNITS={'z':{'m**2 s**-2','m2 s-2','m^2 s^-2'},'t':{'K'},'cc':{'1','(0 - 1)'},
       'clwc':{'kg kg**-1','kg kg-1','kg/kg','1'},'ciwc':{'kg kg**-1','kg kg-1','kg/kg','1'},
       'u':{'m s**-1','m s-1','m/s'},'v':{'m s**-1','m s-1','m/s'}}


def profile_from_pressure(fields,pressure_hpa=PRESSURES):
    """Condensate→modeled extinction, then geometric-height interpolation."""
    expected={k for k in UNITS}
    if set(fields)!=expected:raise ValueError('ERA5 profile needs z,t,cc,clwc,ciwc,u,v')
    shape=fields['z'].shape
    if any(np.shape(a)!=shape or not np.isfinite(a).all() for a in fields.values()) or len(shape)!=3 or shape[0]!=len(pressure_hpa):
        raise ValueError('ERA5 pressure variables must share finite level/latitude/longitude grids')
    ranges={'t':(150,350),'cc':(0,1),'clwc':(0,.05),'ciwc':(0,.05),'u':(-200,200),'v':(-200,200),'z':(-20000,300000)}
    for name,(low,high) in ranges.items():
        if np.any(fields[name]<low) or np.any(fields[name]>high):raise ValueError(f'ERA5 {name} outside supported physical range')
    geopotential_height=fields['z']/9.80665
    height=6_371_000*geopotential_height/(6_371_000-geopotential_height)
    if not np.all(np.diff(height,axis=0)>0):raise ValueError('ERA5 pressure surfaces must be vertically ordered')
    density=np.asarray(pressure_hpa,np.float32)[:,None,None]*100/(287.05*fields['t'])
    liquid=fields['clwc']*density*(3/(2*1000*10e-6));ice=fields['ciwc']*density*(3/(2*917*30e-6))
    extinction=liquid+ice;source={'extinction':extinction,'coverage':fields['cc'],'ice_fraction':ice/np.maximum(extinction,1e-10)}
    arrays={k:[] for k in source};rows,cols=np.indices(shape[1:])
    for altitude in ALTITUDES:
        index=np.clip(np.sum(height<=altitude,axis=0)-1,0,len(pressure_hpa)-2)
        low,high=height[index,rows,cols],height[index+1,rows,cols]
        fraction=np.clip((altitude-low)/np.maximum(high-low,1),0,1)
        support=np.clip((altitude-height[0]+750)/750,0,1)*np.clip((height[-1]+1000-altitude)/1000,0,1)
        for name,values in source.items():
            result=values[index,rows,cols]*(1-fraction)+values[index+1,rows,cols]*fraction
            if name!='ice_fraction':result*=support
            arrays[name].append(result.astype(np.float16))
    arrays={k:np.stack(v) for k,v in arrays.items()};sigma=arrays['extinction'].astype(np.float32)
    above=np.zeros_like(sigma);above[:-1]=np.cumsum(((sigma[:-1]+sigma[1:])*500)[::-1],axis=0)[::-1]
    arrays['tau_above']=above.astype(np.float16);tau=[];centroid=[]
    for first,last in ((0,3),(3,8),(8,16)):
        altitude=ALTITUDES[first:last+1,None,None];field=sigma[first:last+1]
        column=np.trapezoid(field,altitude,axis=0)
        center=np.trapezoid(field*altitude,altitude,axis=0)/np.maximum(column,1e-8)
        tau.append(column.astype(np.float16));centroid.append(np.where(column>1e-7,center,(first+last)*500).astype(np.float16))
    arrays.update(column_tau=np.stack(tau),column_height=np.stack(centroid),altitudes_m=ALTITUDES)
    if any(not np.isfinite(a).all() for a in arrays.values()):raise ValueError('ERA5 reconstruction overflowed supported float16 profile range')
    return arrays


def _write_npz(path,**values):
    with Path(path).open('wb') as f:np.savez_compressed(f,**values)


def import_era5(pressure_path,single_level_path,destination,source):
    from data_adapters import identity
    from data import weather_contract,write_json
    source=provenance(source);destination=Path(destination)
    if any(not Path(p).is_file() or Path(p).stat().st_size>MAX_INPUT_BYTES for p in (pressure_path,single_level_path)):
        raise ValueError('ERA5 inputs must each be local files no larger than 2 GiB')
    originals=[identity(pressure_path),identity(single_level_path)]
    converter=hashlib.sha256(Path(__file__).read_bytes()+Path(__file__).with_name('dataset_netcdf.py').read_bytes()).hexdigest()
    expected={'schema_version':1,'original_files':originals,'provider':source,'converter_sha256':converter}
    cache_path=destination/'import-cache.json'
    if destination.exists() and any(destination.iterdir()):
        if not cache_path.is_file():raise ValueError('Destination already contains another product; select an empty directory')
        cached=json.loads(cache_path.read_text())
        if cached.get('identity')!=expected:raise ValueError('ERA5 destination belongs to different inputs, provenance or converter; select another directory')
        for record in cached['files']:
            if identity(destination/record['name'])!=record:raise ValueError('Cached ERA5 conversion changed; no silent rebuild')
        return {'weather':weather_contract(destination,'historical'),'reused':True,'network_requests':0}
    destination.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.era5-',dir=destination.parent) as temp:
        work=Path(temp)
        with NetCDF(pressure_path) as pressure,NetCDF(single_level_path) as single:
            (plat,plon,ptime),lat,lon,times=pressure.coordinates()
            (slat,slon,stime),lat2,lon2,times2=single.coordinates()
            if not np.array_equal(times,times2):raise ValueError('ERA5 pressure and single-level UTC timestamps differ')
            if not 2<=len(times)<=25 or np.any(np.diff(times)>3*3600):raise ValueError('ERA5 import supports 2–25 states with at most 3 h gaps; split longer products')
            hours=(times-times[0])/3600
            if not np.allclose(hours,np.round(hours),atol=1e-8,rtol=0) or np.any(np.abs(times%3600)>1e-6):
                raise ValueError('ERA5 states must be on exact UTC hours')
            hours=np.round(hours).astype(int).tolist();init=datetime.fromtimestamp(times[0],timezone.utc).isoformat()
            level_name=pressure.name('pressure_level','level');levels=pressure.read(level_name)
            if levels.ndim!=1 or pressure.attr(level_name,'units') not in ('hPa','millibars','mbar'):
                raise ValueError('ERA5 pressure levels must be a 1D hPa axis')
            level_indices=[]
            for value in PRESSURES:
                matches=np.flatnonzero(np.isclose(levels,value,atol=1e-6,rtol=0))
                if len(matches)!=1:raise ValueError(f'ERA5 requires pressure level {value} hPa exactly once')
                level_indices.append(int(matches[0]))
            for name,units in UNITS.items():
                if pressure.attr(name,'units') not in units:raise ValueError(f'Unexpected ERA5 {name} units')
            for name in ('lcc','mcc','hcc'):
                if single.attr(name,'units') not in ('1','(0 - 1)'):raise ValueError('ERA5 layer coverage must be fractional')
            coverage=[];wind_u=[];wind_v=[]
            for time_index,hour in enumerate(hours):
                fields={}
                for name in UNITS:
                    raw=pressure.read(name,(ptime,level_name,plat,plon),{ptime:time_index})
                    raw=raw[level_indices]
                    _,_,raw=canonical_grid(lat,lon,raw)
                    fields[name]=resample_global(raw,361,720)
                profile=profile_from_pressure(fields)
                _write_npz(work/f'cloud-profile-f{hour:03d}.npz',**profile,timestamp=np.float64(times[time_index]))
                wind_indices=[PRESSURES.index(x) for x in (850,500,250)]
                wind_u.append(fields['u'][wind_indices].astype(np.float16));wind_v.append(fields['v'][wind_indices].astype(np.float16))
                layers=[]
                for name in ('lcc','mcc','hcc'):
                    raw=single.read(name,(stime,slat,slon),{stime:time_index})
                    if np.any(raw<0) or np.any(raw>1):raise ValueError('ERA5 layer coverage outside fractional units')
                    _,_,raw=canonical_grid(lat2,lon2,raw)
                    layers.append(resample_global(raw,721,1440).astype(np.float16))
                coverage.append(np.stack(layers))
            _write_npz(work/'cloud-layers.npz',coverage=np.stack(coverage),timestamps=times)
            _write_npz(work/'cloud-winds.npz',u=np.stack(wind_u),v=np.stack(wind_v),timestamps=times,
                       representative_heights_m=np.array([1500,5500,10500],np.float32))
            note=('Local import of user-acquired ERA5 reanalysis. initialization is the first state/time-origin, not a forecast initialization. '
                  'Global grids are bilinearly reconstructed to 0.25° cover / 0.5° profiles with periodic longitude, no added observed detail. '
                  'Geopotential divided by 9.80665 then converted to geometric height. Condensate extinction assumes 10 µm liquid / 30 µm ice radii; '
                  'winds at 850/500/250 hPa represent 1500/5500/10500 m; profiles sampled every 1 km with endpoint fades. These are visualization assumptions.')
            shared={'model':'ECMWF ERA5','initialization':init,'source_mode':'historical','data_kind':'reanalysis',
                    'provider':{**source,'notes':source['notes']+' '+note},'original_files':originals,'conversion':note}
            write_json(work/'cloud-layers-source.json',{**shared,'forecast_hours':hours,'variables':['lcc','mcc','hcc'],'coverage_units':'fraction'})
            write_json(work/'cloud-profile-source.json',{**shared,'wind_forecast_hours':hours,'profile_forecast_hours':hours,
                'pressure_levels_hpa':PRESSURES,'profile_altitudes_m':ALTITUDES.tolist(),'liquid_effective_radius_m':10e-6,'ice_effective_radius_m':30e-6})
        runtime=weather_contract(work,'historical');write_json(work/'runtime.json',runtime)
        generated=[identity(p) for p in sorted(work.iterdir()) if p.is_file()]
        write_json(work/'import-cache.json',{'identity':expected,'files':generated})
        if destination.exists():destination.rmdir()
        work.rename(destination)
    return {'weather':runtime,'reused':False,'network_requests':0}
