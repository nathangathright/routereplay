#!/usr/bin/env python3
"""Explicit local data adapters. Downloads use NOAA's bounded offline cache only."""
from __future__ import annotations
import argparse
from datetime import datetime,timedelta,timezone
import hashlib,json
from pathlib import Path
import numpy as np
from environmental_data import environment_metadata,provenance,write_environment
from dataset_netcdf import NetCDF,canonical_grid

NOAA_SOURCE={'url':'https://www.ncei.noaa.gov/products/weather-climate-models/global-forecast',
 'credit':'NOAA NCEP / NCEI Global Forecast System', 'license_url':'https://www.weather.gov/disclaimer',
 'notes':'Forecast model output, including archived runs; not observations or reanalysis. The visual conversion is not an official NOAA product.'}


def identity(path):
    path=Path(path);digest=hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''):digest.update(block)
    return {'name':path.name,'bytes':path.stat().st_size,'sha256':digest.hexdigest()}


def metadata(kind,source_kind,source,conversion,originals):
    from environmental_data import FIELDS
    return {'schema_version':1,'kind':kind,'source_kind':source_kind,'source':provenance(source),
            'units':{name:'1' for name in FIELDS[kind]},'conversion':conversion,'original_files':originals}


def import_aerosol(source_path,output,source,*,variable='TOTEXTTAU',source_kind):
    if variable not in ('TOTEXTTAU','aod550','od550aer'):
        raise ValueError('Supported aerosol variables are TOTEXTTAU, aod550 or od550aer at 550 nm')
    with NetCDF(source_path) as nc:
        (latname,lonname,timename),lat,lon,times=nc.coordinates()
        if nc.attr(variable,'units') not in ('1','dimensionless'):
            raise ValueError('Aerosol optical depth must be explicitly dimensionless')
        if variable!='TOTEXTTAU':
            if nc.attr(variable,'wavelength_nm')!=550:
                raise ValueError('Generic AOD fields need wavelength_nm=550; no wavelength inference')
        array=nc.read(variable,(timename,latname,lonname))
        lat,lon,array=canonical_grid(lat,lon,array)
    meta=metadata('aerosol',source_kind,source,
        'Total extinction aerosol optical depth at 550 nm; time/space interpolation only. Native time values are interpolation knots; time-averaged products retain their sample centers. Vertical aerosol shape, spectral conversion, phase and single-scatter albedo remain renderer assumptions.',[identity(source_path)])
    return write_environment(output,lat,lon,times,{'aod550':array},meta)


def surface_plan(initialization,start,end,provider='ncei-0p50'):
    from prepare_weather_bundle import plan
    from gfs_archive import provider_spec
    from environmental_data import MAX_BYTES
    p=plan(initialization,start,end,provider)
    if len(p['layer_hours'])>80:raise ValueError('Surface acquisition is limited to 80 states per invocation')
    spec=provider_spec(provider,initialization)
    arrays_bytes=len(p['layer_hours'])*spec['ni']*spec['nj']*2*4+(spec['ni']+spec['nj']+len(p['layer_hours']))*8
    # Reserve scalar Unicode metadata and NPZ headers before any request.
    decoded_bytes=arrays_bytes+1024*1024+8192
    if decoded_bytes>MAX_BYTES:raise ValueError('Planned surface output exceeds the 256 MiB decoded limit; shorten the interval before acquisition')
    return {'initialization':p['initialization'],'hours':p['layer_hours'],'provider':provider,
            'source_kind':'forecast','data_kind':p['data_kind'],'records':len(p['layer_hours'])*3,
            'output_array_bytes':arrays_bytes,'output_decoded_budget_bytes':decoded_bytes,
            'variables':{'LAND':'land/sea validity domain, 0 or 1','SNOD':'surface snow depth, m','ICEC':'surface sea-ice fraction, 1'},
            'availability':'Not checked until acquisition; missing dates/records fail without substitution.'}


def _surface_values(values,missing,variable,land=None):
    a=np.asarray(values,np.float32).copy();missing=np.asarray(missing,bool)
    if missing.shape!=a.shape:raise ValueError('Surface bitmap shape differs from values')
    if np.any(missing):
        if land is None or variable=='LAND':raise ValueError('Missing surface values require the verified same-time LAND domain')
        forbidden=(land>=.5) if variable=='SNOD' else (land<.5)
        if np.any(missing&forbidden):raise ValueError('Surface values are missing inside their applicable land/ocean domain')
        a[missing]=0
    if variable=='LAND' and np.any((a!=0)&(a!=1)):raise ValueError('GFS LAND must be binary 0=sea,1=land')
    if not np.isfinite(a).all() or np.any(a<0) or np.any(a>(100 if variable=='SNOD' else 1)):
        raise ValueError('Surface field contains invalid physical values')
    return a


def _surface_record(archive,hour,variable,land=None):
    import eccodes
    path,record=archive.get_record(hour,variable,'surface');spec=archive.spec
    with path.open('rb') as f:
        message=eccodes.codes_grib_new_from_file(f)
        if message is None:raise ValueError('Missing GRIB message')
        try:
            get=lambda key:eccodes.codes_get(message,key)
            expected=archive.initialization+timedelta(hours=hour)
            checks={'dataDate':int(archive.initialization.strftime('%Y%m%d')),'dataTime':archive.initialization.hour*100,
                'validityDate':int(expected.strftime('%Y%m%d')),'validityTime':int(expected.strftime('%H%M')),
                'stepType':'instant','startStep':hour,'endStep':hour,'gridType':'regular_ll',
                'Ni':spec['ni'],'Nj':spec['nj'],'iDirectionIncrementInDegrees':spec['grid_degrees'],
                'jDirectionIncrementInDegrees':spec['grid_degrees'],'latitudeOfFirstGridPointInDegrees':90,
                'latitudeOfLastGridPointInDegrees':-90,'longitudeOfFirstGridPointInDegrees':0,
                'longitudeOfLastGridPointInDegrees':360-spec['grid_degrees'],'jScansPositively':0,
                'iScansNegatively':0,'jPointsAreConsecutive':0,'typeOfLevel':'surface'}
            for key,value in checks.items():
                if get(key)!=value:raise ValueError(f'GFS surface {key}={get(key)!r}, expected {value!r}')
            # Inventory labels alone cannot establish the decoded parameter.
            expected_param={'SNOD':(0,1,11),'ICEC':(10,2,0),'LAND':(2,0,0)}[variable]
            if tuple(get(k) for k in ('discipline','parameterCategory','parameterNumber'))!=expected_param:
                raise ValueError('GRIB parameter differs from requested surface field')
            units=get('units')
            if units not in ({'m'} if variable=='SNOD' else {'Proportion','(0 - 1)','1','(0=sea, 1=land)'}):
                raise ValueError(f'Unexpected {variable} units {units}')
            a=eccodes.codes_get_values(message).reshape(spec['nj'],spec['ni']).astype(np.float32)
            missing_count=int(get('numberOfMissing'))
            mask=np.asarray(eccodes.codes_get_array(message,'bitmap')).reshape(a.shape)==0 if missing_count else np.zeros(a.shape,bool)
            if int(mask.sum())!=missing_count:raise ValueError('Surface bitmap does not match declared missing count')
            a=_surface_values(a,mask,variable,land)
            return a,{**record,'units':units,'valid_time':expected.isoformat(),'outside_domain_missing_set_to_zero':missing_count},identity(path)
        finally:eccodes.codes_release(message)


def acquire_gfs_surface(initialization,start,end,output,cache_directory,*,provider='ncei-0p50',
                        offline=False,max_download_mib=32,max_cache_mib=256,full_snow_depth_m=.1):
    from gfs_archive import DownloadCache,GFSArchive
    plan=surface_plan(initialization,start,end,provider)
    if not np.isfinite(full_snow_depth_m) or not .01<=full_snow_depth_m<=1:
        raise ValueError('Modeled full-snow depth must be explicitly within 0.01–1 m')
    if not 1<=max_download_mib<=512 or not 1<=max_cache_mib<=4096:
        raise ValueError('Download/cache budgets must be within 1–512/4096 MiB')
    cache_path=Path(cache_directory);existing=sum(p.stat().st_size for p in cache_path.rglob('*') if p.is_file()) if cache_path.exists() else 0
    if existing>max_cache_mib*1024**2:raise ValueError('Local NOAA cache exceeds the configured storage budget; select a new cache or explicitly raise the limit')
    if existing+2_000_000*len(plan['hours'])>max_cache_mib*1024**2:
        raise ValueError('Planned inventory reserve exceeds the local cache storage budget')
    cache=DownloadCache(cache_path,offline=offline,max_download_bytes=int(max_download_mib*1024**2))
    archive=GFSArchive(provider,initialization,cache)
    records=[archive.describe(hour,var,'surface') for hour in plan['hours'] for var in ('LAND','SNOD','ICEC')]
    uncached=sum(r['bytes'] for r in records if cache.cached(r['source_url'],r['byte_range']) is None)
    # Reserve room for request metadata and inventories as well as exact payloads.
    if existing+uncached+len(records)*8192+2_000_000*len(plan['hours'])>max_cache_mib*1024**2:
        raise ValueError('Planned NOAA surface acquisition exceeds the local cache storage budget')
    snow=[];ice=[];provenance_records=[];originals=[]
    for hour in plan['hours']:
        land,lm,li=_surface_record(archive,hour,'LAND')
        sn,sm,si=_surface_record(archive,hour,'SNOD',land);ic,im,ii=_surface_record(archive,hour,'ICEC',land)
        snow.append(np.clip(sn/full_snow_depth_m,0,1));ice.append(ic)
        provenance_records.extend([lm,sm,im]);originals.extend([li,si,ii])
    init=archive.initialization;times=np.array([(init+timedelta(hours=h)).timestamp() for h in plan['hours']])
    note=f'SNOW_FRACTION=min(SNOD/{full_snow_depth_m:g}m,1) is a modeled visual snow-cover conversion, not measured fraction. ICEC is provider sea-ice fraction. Missing SNOD over sea and missing ICEC over land are zero only after checking same-time LAND; missing applicable-domain cells fail. Native regular grid retained; linear temporal/spatial interpolation.'
    meta=metadata('surface_conditions','forecast',NOAA_SOURCE,note,originals)
    meta.update({'provider':provider,'initialization':init.isoformat(),'forecast_hours':plan['hours'],
                 'snow_full_cover_depth_m':full_snow_depth_m,'acquisition':provenance_records})
    result=write_environment(output,np.linspace(90,-90,archive.spec['nj']),np.arange(archive.spec['ni'])*archive.spec['grid_degrees'],times,
                             {'snow_fraction':np.stack(snow),'sea_ice_fraction':np.stack(ice)},meta)
    return {'product':result,'downloaded_bytes':cache.downloaded_bytes,'network_requests':cache.network_requests,
            'planned_grib_bytes':sum(r['bytes'] for r in records),'offline':offline}


def import_dem(source_path,output,source,*,vertical_datum):
    """Convert a bounded north-up WGS84 GeoTIFF; unsupported datums fail."""
    from PIL import Image
    from terrain_tiles import read_tile
    provenance(source)
    if vertical_datum!='EGM2008':
        raise ValueError('Only explicit EGM2008 orthometric metres are accepted; transform other datums externally, preserving that provenance')
    source_path=Path(source_path)
    if source_path.stat().st_size>256*1024**2:raise ValueError('DEM source exceeds 256 MiB; crop it first')
    with Image.open(source_path) as image:
        if image.format!='TIFF' or image.width<4 or image.height<4 or image.width*image.height>16_000_000:
            raise ValueError('DEM must be a TIFF at least 4 pixels per side and at most 16 million pixels')
        if getattr(image,'n_frames',1)!=1 or len(image.getbands())!=1:raise ValueError('DEM requires exactly one image and one band')
        tags=image.tag_v2
        keys=tuple(tags.get(34735,()))
        if len(keys)<4 or keys[:2]!=(1,1) or keys[2] not in (0,1) or len(keys)!=4+4*keys[3]:raise ValueError('DEM requires a valid GeoTIFF key directory')
        geokeys={}
        for n in range(keys[3]):
            key,location,count,value=keys[4+n*4:8+n*4]
            if key in geokeys:raise ValueError('Duplicate GeoTIFF key')
            if location==0 and count==1:geokeys[key]=value
        if geokeys.get(2048)!=4326 or geokeys.get(1024)!=2:
            raise ValueError('DEM horizontal CRS must be geographic WGS84 EPSG:4326; reproject externally')
        if geokeys.get(2054,9102)!=9102:raise ValueError('DEM geographic angular units must be degrees')
        if geokeys.get(1025) not in (1,2):raise ValueError('DEM must declare RasterPixelIsArea or RasterPixelIsPoint')
        if geokeys.get(4096,3855)!=3855 or geokeys.get(4099,9001)!=9001:
            raise ValueError('GeoTIFF vertical CRS/units contradict EGM2008 metres')
        scale=tuple(tags.get(33550,()));tie=tuple(tags.get(33922,()))
        if 34264 in tags or len(scale)!=3 or len(tie)!=6 or scale[0]<=0 or scale[1]<=0:
            raise ValueError('DEM needs a north-up scale/tiepoint transform; rotated grids are unsupported')
        raster_offset=.5 if geokeys[1025]==1 else 0.
        lon=tie[3]+(np.arange(image.width)+raster_offset-tie[0])*scale[0]
        lat=tie[4]-(np.arange(image.height)+raster_offset-tie[1])*scale[1]
        a=np.asarray(image,dtype=np.float32).copy()
        nodata=tags.get(42113)
        if nodata is not None:
            missing=float(str(nodata).strip('\x00'))
            if np.any(a==missing):raise ValueError('DEM has nodata holes; provide a valid cropped tile')
        if not np.isfinite(a).all():raise ValueError('DEM contains nonfinite heights')
    output=Path(output);output.parent.mkdir(parents=True,exist_ok=True)
    import tempfile
    with tempfile.NamedTemporaryFile(dir=output.parent,suffix='.npz',delete=False) as f:
        temporary=Path(f.name);np.savez_compressed(f,latitude=lat[::-1],longitude=lon,height_m=a[::-1],altitude_reference=np.asarray('MSL'))
    try:read_tile(temporary);temporary.replace(output)
    finally:
        if temporary.exists():temporary.unlink()
    record=identity(source_path)
    derived={**source,'notes':source['notes']+' EGM2008 orthometric metres retained as renderer MSL; source is a surface/terrain model according to its provider. Original SHA256='+record['sha256']+'. No reprojection, vertical datum conversion or nodata filling.'}
    return {'path':str(output),'source':derived,'original_file':record,'vertical_datum':'EGM2008','shape':list(a.shape),'units':'m'}


def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__);commands=p.add_subparsers(dest='command',required=True)
    g=commands.add_parser('gfs-surface');g.add_argument('--initialization',required=True);g.add_argument('--start',required=True);g.add_argument('--end',required=True)
    g.add_argument('--provider',choices=['nodd-0p25','ncei-0p50'],default='ncei-0p50');g.add_argument('--output',type=Path)
    g.add_argument('--cache-directory',type=Path);g.add_argument('--offline',action='store_true');g.add_argument('--plan',action='store_true')
    g.add_argument('--max-download-mib',type=int,default=32);g.add_argument('--max-cache-mib',type=int,default=256);g.add_argument('--full-snow-depth-m',type=float,default=.1)
    a=commands.add_parser('import-aerosol');a.add_argument('input',type=Path);a.add_argument('--output',type=Path,required=True);a.add_argument('--source-json',type=Path,required=True)
    a.add_argument('--variable',default='TOTEXTTAU');a.add_argument('--source-kind',choices=['forecast','reanalysis','observation','modeled'],required=True)
    d=commands.add_parser('import-dem');d.add_argument('input',type=Path);d.add_argument('--output',type=Path,required=True);d.add_argument('--source-json',type=Path,required=True);d.add_argument('--vertical-datum',required=True)
    e=commands.add_parser('import-era5');e.add_argument('--pressure',type=Path,required=True);e.add_argument('--single-level',type=Path,required=True);e.add_argument('--destination',type=Path,required=True);e.add_argument('--source-json',type=Path,required=True)
    i=commands.add_parser('inspect');i.add_argument('input',type=Path)
    for command in (g,a,d,e):command.add_argument('--bundle',type=Path,help='Optionally validate and attach to this prepared bundle')
    d.add_argument('--source-output',type=Path,help='Write derived DEM provenance for a later attach-terrain call')
    args=p.parse_args(argv)
    try:
        if getattr(args,'bundle',None) is not None and not getattr(args,'plan',False):
            from data import read_bundle
            read_bundle(args.bundle)
        if args.command=='gfs-surface':
            if args.plan:result=surface_plan(args.initialization,args.start,args.end,args.provider)
            else:
                if args.output is None or args.cache_directory is None:raise ValueError('Acquisition needs --output and --cache-directory')
                result=acquire_gfs_surface(args.initialization,args.start,args.end,args.output,args.cache_directory,provider=args.provider,offline=args.offline,max_download_mib=args.max_download_mib,max_cache_mib=args.max_cache_mib,full_snow_depth_m=args.full_snow_depth_m)
        elif args.command=='inspect':result=environment_metadata(args.input)
        else:
            if args.source_json.stat().st_size>64*1024:raise ValueError('Source JSON exceeds 64 KiB')
            source=provenance(json.loads(args.source_json.read_text()))
            if args.command=='import-aerosol':result=import_aerosol(args.input,args.output,source,variable=args.variable,source_kind=args.source_kind)
            elif args.command=='import-dem':result=import_dem(args.input,args.output,source,vertical_datum=args.vertical_datum)
            else:
                from era5_import import import_era5
                result=import_era5(args.pressure,args.single_level,args.destination,source)
        if args.command=='import-dem' and args.source_output is not None:
            from data import write_json
            write_json(args.source_output,result['source'])
        if getattr(args,'bundle',None) is not None and not getattr(args,'plan',False):
            if args.command in ('gfs-surface','import-aerosol'):
                from data import attach_environment
                attach_environment(args.bundle,args.output)
            elif args.command=='import-dem':
                from data import attach_terrain_tile
                attach_terrain_tile(args.bundle,args.output,result['source'])
            elif args.command=='import-era5':
                from data import attach_weather
                attach_weather(args.bundle,args.destination,source_mode='historical')
            result['attached_bundle']=str(args.bundle)
        print(json.dumps(result,indent=2,allow_nan=False));return 0
    except (ValueError,OSError,ImportError) as exc:p.exit(1,str(exc)+'\n')


if __name__=='__main__':raise SystemExit(main())
