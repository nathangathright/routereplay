"""Bounded, dated environmental fields shared by importers and rendering.

Fractions/AOD are dimensionless. Coordinates are global regular north-to-south
latitude, periodic longitude starting at zero, and explicit UTC timestamps.
No time extrapolation, gap filling, or missing-field fallback is permitted.
"""
from __future__ import annotations
from datetime import datetime, timezone
from functools import lru_cache
import json
from pathlib import Path
from urllib.parse import urlsplit
from zipfile import ZipFile, BadZipFile
import numpy as np

FIELDS={'aerosol':('aod550',),'surface_conditions':('snow_fraction','sea_ice_fraction')}
MAX_BYTES=256*1024*1024
MAX_FILE_BYTES=128*1024*1024
MAX_TIMES=240


def provenance(source):
    if not isinstance(source,dict) or set(source)!={'url','credit','license_url','notes'}:
        raise ValueError('Source requires exactly url, credit, license_url, notes')
    if any(not isinstance(v,str) or not v.strip() or len(v)>8192 for v in source.values()):
        raise ValueError('Source values must be nonempty bounded text')
    for key in ('url','license_url'):
        parts=urlsplit(source[key])
        if parts.scheme!='https' or not parts.netloc or parts.username or parts.password:
            raise ValueError('Source and license URLs must be HTTPS without credentials')
    return dict(source)


def timestamp(value):
    if isinstance(value,datetime):
        if value.tzinfo is None:raise ValueError('Environmental time must include a UTC offset')
        value=value.timestamp()
    elif isinstance(value,str):
        return timestamp(datetime.fromisoformat(value.replace('Z','+00:00')))
    value=float(value)
    if not np.isfinite(value):raise ValueError('Environmental time must be finite')
    return value


def _validate(latitude,longitude,timestamps,fields,metadata):
    if not isinstance(metadata,dict) or type(metadata.get('schema_version')) is not int or metadata.get('schema_version')!=1 or metadata.get('kind') not in FIELDS:
        raise ValueError('Unsupported environmental metadata schema or kind')
    kind=metadata['kind'];provenance(metadata.get('source'))
    if metadata.get('source_kind') not in ('forecast','reanalysis','observation','modeled'):
        raise ValueError('Environmental source_kind must describe the actual product')
    if metadata.get('units')!={field:'1' for field in FIELDS[kind]}:
        raise ValueError('Environmental output fields must have explicit dimensionless units 1')
    if not isinstance(metadata.get('conversion'),str) or not metadata['conversion'].strip():
        raise ValueError('Environmental conversion assumptions are required')
    original=metadata.get('original_files')
    if not isinstance(original,list) or not 1<=len(original)<=240:
        raise ValueError('Environmental provenance needs 1–240 original file identities')
    import re
    for record in original:
        if (not isinstance(record,dict) or set(record)!={'name','sha256','bytes'} or
            not isinstance(record['name'],str) or not record['name'] or len(record['name'])>512 or
            '/' in record['name'] or '\\' in record['name'] or
            not isinstance(record['sha256'],str) or not re.fullmatch('[0-9a-f]{64}',record['sha256']) or
            type(record['bytes']) is not int or record['bytes']<=0):
            raise ValueError('Invalid environmental original-file identity')
    lat=np.asarray(latitude,np.float64);lon=np.asarray(longitude,np.float64);times=np.asarray(timestamps,np.float64)
    if lat.ndim!=1 or not 3<=len(lat)<=721 or not np.allclose(lat,np.linspace(90,-90,len(lat)),atol=1e-7,rtol=0):
        raise ValueError('Latitude must be a global regular north-to-south grid including both poles')
    if lon.ndim!=1 or not 4<=len(lon)<=1440 or not np.allclose(lon,np.arange(len(lon))*360/len(lon),atol=1e-7,rtol=0):
        raise ValueError('Longitude must be global, periodic, and start at 0 without a duplicate endpoint')
    if (times.ndim!=1 or not 2<=len(times)<=MAX_TIMES or not np.isfinite(times).all() or
        np.any(np.diff(times)<=0) or np.any(np.diff(times)>24*3600) or
        times[0]<datetime(1900,1,1,tzinfo=timezone.utc).timestamp() or times[-1]>datetime(2200,1,1,tzinfo=timezone.utc).timestamp()):
        raise ValueError('Need 2–240 increasing dated UTC states, with gaps no larger than 24 hours')
    if set(fields)!=set(FIELDS[kind]):raise ValueError('Environmental fields do not match kind')
    arrays={}
    for name,value in fields.items():
        array=np.asarray(value,np.float32)
        maximum=20 if name=='aod550' else 1
        if array.shape!=(len(times),len(lat),len(lon)) or not np.isfinite(array).all() or np.any(array<0) or np.any(array>maximum):
            raise ValueError(f'{name} must match the dated grid, be finite, and lie in [0,{maximum}]')
        array.setflags(write=False);arrays[name]=array
    if sum(a.nbytes for a in arrays.values())+lat.nbytes+lon.nbytes+times.nbytes>MAX_BYTES:
        raise ValueError('Environmental arrays exceed the 256 MiB decoded limit; shorten the interval')
    for a in (lat,lon,times):a.setflags(write=False)
    return {'latitude':lat,'longitude':lon,'timestamps':times,'fields':arrays,'metadata':metadata}


def read_environment(path):
    path=Path(path)
    if not path.is_file() or path.stat().st_size>MAX_FILE_BYTES:
        raise ValueError('Environmental NPZ exceeds the 128 MiB file limit or is missing')
    try:
        with ZipFile(path) as archive:
            names=[i.filename for i in archive.infolist()]
            if len(names)!=len(set(names)) or sum(i.file_size for i in archive.infolist())>MAX_BYTES:
                raise ValueError('Environmental NPZ has duplicate entries or exceeds decoded size budget')
        with np.load(path,allow_pickle=False) as values:
            if 'metadata' not in values or values['metadata'].shape!=() or values['metadata'].dtype.kind not in 'US':
                raise ValueError('Environmental metadata must be scalar JSON text')
            text=str(values['metadata'])
            if len(text)>256*1024:raise ValueError('Environmental metadata exceeds 256 KiB')
            metadata=json.loads(text)
            if not isinstance(metadata,dict):raise ValueError('Environmental metadata must be a JSON object')
            kind=metadata.get('kind')
            if kind not in FIELDS or set(values.files)!=set(FIELDS[kind])|{'latitude','longitude','timestamps','metadata'}:
                raise ValueError('Unexpected environmental NPZ arrays')
            return _validate(values['latitude'],values['longitude'],values['timestamps'],
                             {k:values[k] for k in FIELDS[kind]},metadata)
    except (BadZipFile,EOFError,json.JSONDecodeError) as exc:
        raise ValueError('Invalid environmental NPZ/JSON') from exc


def environment_metadata(path):
    data=read_environment(path);times=data['timestamps']
    return {**data['metadata'],'valid_start':datetime.fromtimestamp(times[0],timezone.utc).isoformat(),
            'valid_end':datetime.fromtimestamp(times[-1],timezone.utc).isoformat(),
            'shape':[len(times),len(data['latitude']),len(data['longitude'])]}


def validate_environment_coverage(path,start_dt,end_dt):
    meta=environment_metadata(path);start,end=timestamp(start_dt),timestamp(end_dt)
    if end<start or start<timestamp(meta['valid_start']) or end>timestamp(meta['valid_end']):
        raise ValueError(f"Environmental data covers {meta['valid_start']} through {meta['valid_end']}; no date substitution or clamping")
    return meta


def write_environment(path,latitude,longitude,timestamps,fields,metadata):
    data=_validate(latitude,longitude,timestamps,fields,metadata)
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    import tempfile
    temporary=None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent,prefix='.environment-',suffix='.npz',delete=False) as out:
            temporary=Path(out.name)
            np.savez_compressed(out,latitude=data['latitude'],longitude=data['longitude'],timestamps=data['timestamps'],
                                metadata=np.asarray(json.dumps(metadata,sort_keys=True,allow_nan=False)),**data['fields'])
        read_environment(temporary);temporary.replace(path)
    finally:
        if temporary is not None and temporary.exists():temporary.unlink()
    return environment_metadata(path)


@lru_cache(maxsize=2)
def _cached(path,mtime,size):
    return read_environment(path)


def prepared_environment_sampler(path,when):
    """Validate one file/time snapshot and return a filesystem-free spatial query.

    The callable retains readonly source planes and the original interpolation
    order. Recreate it to observe a changed file; rendering caches it only for
    immutable, already-validated content-addressed bundle products.
    """
    path=Path(path).resolve();stat=path.stat();data=_cached(str(path),stat.st_mtime_ns,stat.st_size)
    times=data['timestamps'];t=timestamp(when)
    if t<times[0] or t>times[-1]:raise ValueError('Environmental sample is outside supplied dates')
    i=min(max(int(np.searchsorted(times,t))-1,0),len(times)-2);f=(t-times[i])/(times[i+1]-times[i])
    h,w=len(data['latitude']),len(data['longitude'])
    planes={key:(a[i],a[i+1]) for key,a in data['fields'].items()}

    def sample(lon_radians,lat_radians):
        lon,lat=np.broadcast_arrays(np.asarray(lon_radians,np.float64),np.asarray(lat_radians,np.float64))
        if not np.isfinite(lon).all() or not np.isfinite(lat).all() or np.any(np.abs(lat)>np.pi/2+1e-12):
            raise ValueError('Environmental sample coordinates must be finite longitude/latitude radians')
        x=(np.degrees(lon)%360)*w/360;y=np.clip((90-np.degrees(lat))*(h-1)/180,0,h-1)
        x0=np.floor(x).astype(int)%w;x1=(x0+1)%w;y0=np.floor(y).astype(int);y1=np.minimum(y0+1,h-1)
        fx=x-np.floor(x);fy=y-y0
        def spatial(a):return (a[y0,x0]*(1-fx)+a[y0,x1]*fx)*(1-fy)+(a[y1,x0]*(1-fx)+a[y1,x1]*fx)*fy
        return {key:spatial(first)*(1-f)+spatial(second)*f for key,(first,second) in planes.items()}
    return sample


def sample_environment(path,lon_radians,lat_radians,when):
    return prepared_environment_sampler(path,when)(lon_radians,lat_radians)
