"""Small strict CF-NetCDF reader; classic files use SciPy, HDF5 needs netCDF4.

Reads only requested variables/slices. No credential handling, calendar guessing,
missing-value interpolation, or coordinate reprojection is performed here.
"""
from datetime import datetime, timezone
from pathlib import Path
import re
import numpy as np

MAX_INPUT_BYTES=2*1024**3
MAX_READ_BYTES=256*1024**2


def text(value):
    return value.decode('utf-8') if isinstance(value,bytes) else str(value)


class NetCDF:
    def __init__(self,path):
        self.path=Path(path)
        if not self.path.is_file() or self.path.stat().st_size>MAX_INPUT_BYTES:
            raise ValueError('NetCDF input must be a local file no larger than 2 GiB; split larger requests')
        with self.path.open('rb') as f:magic=f.read(8)
        self.classic=magic.startswith(b'CDF')
        if self.classic:
            from scipy.io import netcdf_file
            self.dataset=netcdf_file(str(self.path),'r',mmap=True)
        elif magic==b'\x89HDF\r\n\x1a\n':
            try:from netCDF4 import Dataset
            except ImportError as exc:raise ValueError('NetCDF4/HDF5 input requires optional netCDF4; classic NetCDF uses SciPy') from exc
            self.dataset=Dataset(str(self.path),'r')
        else:raise ValueError('Input is not classic NetCDF or NetCDF4/HDF5')

    def __enter__(self):return self
    def __exit__(self,*args):self.dataset.close()

    def name(self,*aliases):
        names=[n for n in aliases if n in self.dataset.variables]
        if len(names)!=1:raise ValueError('Expected exactly one NetCDF variable from '+', '.join(aliases))
        return names[0]

    def attr(self,name,attribute,default=None):
        value=getattr(self.dataset.variables[name],attribute,default)
        return text(value) if isinstance(value,(str,bytes)) else value

    def read(self,name,dimensions=None,selection=None):
        if name not in self.dataset.variables:raise ValueError(f'Missing NetCDF variable {name}')
        var=self.dataset.variables[name];dims=tuple(map(text,var.dimensions))
        if dimensions is not None and set(dims)!=set(dimensions):
            raise ValueError(f'{name} dimensions {dims} differ from required {dimensions}; select one experiment/member explicitly')
        selectors=[];remaining=[];count=1
        for dim,size in zip(dims,var.shape):
            choice=(selection or {}).get(dim,slice(None));selectors.append(choice)
            if isinstance(choice,int):
                if not 0<=choice<size:raise ValueError('NetCDF time/level index out of range')
            else:
                n=len(range(*choice.indices(size)));count*=n;remaining.append(dim)
        if count*8>MAX_READ_BYTES:raise ValueError('Requested NetCDF slice exceeds 256 MiB decoded limit')
        raw=var[tuple(selectors)]
        if np.ma.isMaskedArray(raw) and np.ma.getmaskarray(raw).any():raise ValueError(f'{name} has missing/masked values')
        array=np.asarray(raw).copy()
        if array.dtype.kind not in 'fiu':raise ValueError(f'{name} must be numeric')
        if self.classic:
            for missing in ('_FillValue','missing_value'):
                fill=getattr(var,missing,None)
                if fill is not None and np.isin(array,np.asarray(fill)).any():raise ValueError(f'{name} has missing values')
            array=array.astype(np.float64)*float(getattr(var,'scale_factor',1))+float(getattr(var,'add_offset',0))
        if not np.isfinite(array).all():raise ValueError(f'{name} contains nonfinite values')
        if dimensions is not None:
            target=[dim for dim in dimensions if not isinstance((selection or {}).get(dim),int)]
            array=np.transpose(array,[remaining.index(dim) for dim in target])
        return np.asarray(array,np.float64)

    def coordinates(self):
        lat_name=self.name('latitude','lat');lon_name=self.name('longitude','lon');time_name=self.name('valid_time','time')
        for name,units in ((lat_name,('degrees_north','degree_north')),(lon_name,('degrees_east','degree_east'))):
            if self.attr(name,'units') not in units:raise ValueError(f'{name} needs explicit geographic degree units')
        lat=self.read(lat_name);lon=self.read(lon_name)
        times=cf_times(self.read(time_name),self.attr(time_name,'units'),self.attr(time_name,'calendar','standard'))
        return (lat_name,lon_name,time_name),lat,lon,times


def cf_times(values,units,calendar='standard'):
    if calendar not in ('standard','gregorian','proleptic_gregorian'):
        raise ValueError('Only Gregorian UTC NetCDF calendars are supported')
    match=re.fullmatch(r'(seconds|minutes|hours|days) since (.+)',units or '')
    if not match:raise ValueError('NetCDF time needs explicit seconds/hours/days since a UTC epoch')
    raw=match[2].strip().replace(' UTC','+00:00').replace('Z','+00:00')
    epoch=datetime.fromisoformat(raw)
    # CF reference dates without an offset are UTC, unlike trip timestamps.
    if epoch.tzinfo is None:epoch=epoch.replace(tzinfo=timezone.utc)
    values=np.asarray(values,np.float64)
    if values.ndim!=1 or len(values)<2 or not np.isfinite(values).all():raise ValueError('NetCDF time must contain at least two finite UTC states')
    seconds=values*{'seconds':1,'minutes':60,'hours':3600,'days':86400}[match[1]]+epoch.timestamp()
    if np.any(np.diff(seconds)<=0):raise ValueError('NetCDF time must increase strictly')
    return seconds


def canonical_grid(lat,lon,values):
    """Reorder a global regular grid, rejecting holes and duplicate longitude."""
    lat=np.asarray(lat,np.float64);lon=np.asarray(lon,np.float64);values=np.asarray(values)
    if lat.ndim!=1 or lon.ndim!=1 or len(lat)<3 or len(lon)<4 or values.shape[-2:]!=(len(lat),len(lon)):
        raise ValueError('NetCDF fields need global 1D latitude/longitude coordinate axes')
    iy=np.argsort(-lat);ix=np.argsort(lon%360);lat=lat[iy];lon=(lon%360)[ix]
    if not np.allclose(lat,np.linspace(90,-90,len(lat)),atol=1e-6,rtol=0):raise ValueError('Latitude must be regular and include both poles; regional fields are not global substitutes')
    if not np.allclose(lon,np.arange(len(lon))*360/len(lon),atol=1e-6,rtol=0):raise ValueError('Longitude must be regular, periodic, include 0, and omit a duplicate 360 endpoint')
    return lat,lon,np.take(np.take(values,iy,axis=-2),ix,axis=-1)


def resample_global(values,rows,columns):
    """Bilinear global regridding with periodic longitude and exact pole samples."""
    values=np.asarray(values,np.float32);h,w=values.shape[-2:]
    y=np.linspace(0,h-1,rows);x=np.arange(columns)*w/columns
    y0=np.floor(y).astype(int);y1=np.minimum(y0+1,h-1);fy=(y-y0)[:,None]
    x0=np.floor(x).astype(int)%w;x1=(x0+1)%w;fx=x-np.floor(x)
    return ((values[...,y0[:,None],x0]*(1-fx)+values[...,y0[:,None],x1]*fx)*(1-fy)+
            (values[...,y1[:,None],x0]*(1-fx)+values[...,y1[:,None],x1]*fx)*fy).astype(np.float32)
