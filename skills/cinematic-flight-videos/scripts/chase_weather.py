"""Offline physical-scale cloud atlases for experimental local-camera scenes.

The source is the existing engine.cloudvolume._density field, including its
forecast constraints and seeded reconstruction. This module adds no clouds and
no opacity gain. ENU coordinates and extinction use physical metres; only the
query passed to the existing engine has its radial altitude exaggerated.
"""
from __future__ import annotations

from datetime import datetime,timezone
import hashlib
import json
import math
import os
from pathlib import Path
import sys

import numpy as np

EARTH_M=6_371_000.
MAX_VOXELS=2_000_000


def _instant(value):
    if not isinstance(value,datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError('Cloud atlas time must be a timezone-aware datetime')
    return value.astimezone(timezone.utc)


def enu_basis(lat_deg,lon_deg):
    """Rows are east, north, up in spherical physical ECEF coordinates."""
    if not np.isfinite([lat_deg,lon_deg]).all() or not -90<=lat_deg<=90:
        raise ValueError('ENU origin needs finite longitude and latitude within ±90 degrees')
    lat,lon=np.radians([lat_deg,lon_deg])
    return np.array([[-np.sin(lon),np.cos(lon),0.],
                     [-np.sin(lat)*np.cos(lon),-np.sin(lat)*np.sin(lon),np.cos(lat)],
                     [np.cos(lat)*np.cos(lon),np.cos(lat)*np.sin(lon),np.sin(lat)]],np.float64)


def enu_to_ecef(points_enu_m,origin_lat_deg,origin_lon_deg,origin_altitude_m=0.):
    """ENU tangent offsets to physical ECEF metres, retaining Earth curvature."""
    points=np.asarray(points_enu_m,np.float64)
    if points.ndim<1 or points.shape[-1]!=3 or not np.isfinite(points).all():
        raise ValueError('ENU points must be finite with final dimension three')
    if not math.isfinite(origin_altitude_m) or not -500<=origin_altitude_m<=20000:
        raise ValueError('ENU origin altitude must be within -500..20000 physical metres')
    basis=enu_basis(origin_lat_deg,origin_lon_deg)
    return (EARTH_M+origin_altitude_m)*basis[2]+points@basis


def physical_to_display(points_ecef_m,height_exaggeration):
    """Map only radial physical altitude into the existing density convention."""
    points=np.asarray(points_ecef_m,np.float64)
    if points.ndim<1 or points.shape[-1]!=3 or not np.isfinite(points).all():
        raise ValueError('ECEF points must be finite with final dimension three')
    if not math.isfinite(height_exaggeration) or height_exaggeration<=0:
        raise ValueError('Height exaggeration must be finite and positive')
    radius=np.linalg.norm(points,axis=-1,keepdims=True)
    if np.any(radius<EARTH_M-1000):
        raise ValueError('Cloud atlas point lies more than 1000 metres below the Earth datum')
    altitude=radius-EARTH_M
    return points/radius*(1+altitude*height_exaggeration/EARTH_M)


def sample_density(points_enu_m,*,origin_lat_deg,origin_lon_deg,origin_altitude_m=0.,
                   weather_dt,density_fn=None,height_exaggeration=None,chunk_size=65536):
    """Return float32 extinction in 1/physical metre at each supplied ENU point."""
    weather_dt=_instant(weather_dt)
    if type(chunk_size) is not int or not 1<=chunk_size<=262144:
        raise ValueError('Cloud atlas chunk_size must be within 1..262144')
    if density_fn is None or height_exaggeration is None:
        from cloudvolume import _density,HEIGHT_EXAGGERATION
        density_fn=_density if density_fn is None else density_fn
        height_exaggeration=HEIGHT_EXAGGERATION if height_exaggeration is None else height_exaggeration
    physical=enu_to_ecef(points_enu_m,origin_lat_deg,origin_lon_deg,origin_altitude_m)
    shape=physical.shape[:-1];flat=physical.reshape(-1,3);sigma=np.empty(len(flat),np.float32)
    for first in range(0,len(flat),chunk_size):
        query=physical_to_display(flat[first:first+chunk_size],height_exaggeration)
        result=density_fn(query,weather_dt,normals=False)
        values=np.asarray(result[0] if isinstance(result,tuple) else result,np.float32)
        if values.shape!=(len(query),) or not np.isfinite(values).all() or np.any(values<0):
            raise ValueError('Existing density sampler must return finite nonnegative extinction per point')
        sigma[first:first+len(query)]=values
    return sigma.reshape(shape)


def tiled_rgba(density):
    """Pack z slices into a bottom-left-origin float image, with one-pixel gutters."""
    density=np.asarray(density,np.float32)
    if density.ndim!=3 or not np.isfinite(density).all() or np.any(density<0):
        raise ValueError('Density must be a finite nonnegative (z,y,x) array')
    nz,ny,nx=density.shape
    if min(density.shape)<2 or density.size>MAX_VOXELS:
        raise ValueError('Density atlas shape exceeds its bounded voxel count')
    tiles_x=math.ceil(math.sqrt(nz));tiles_y=math.ceil(nz/tiles_x)
    stride_x,stride_y=nx+2,ny+2
    image=np.zeros((tiles_y*stride_y,tiles_x*stride_x,4),dtype='<f4');image[...,3]=1.
    for z in range(nz):
        tile=np.pad(density[z],1,mode='edge')
        x,y=(z%tiles_x)*stride_x,(z//tiles_x)*stride_y
        image[y:y+stride_y,x:x+stride_x,:3]=tile[...,None]
    layout={'width':image.shape[1],'height':image.shape[0],'channels':4,'dtype':'little-endian float32',
            'tiles_x':tiles_x,'tiles_y':tiles_y,'slice_stride_xy':[stride_x,stride_y],'gutter':1,
            'row_origin':'bottom-left','channel_semantics':'R=G=B=extinction per physical metre; A=1',
            'slice_order':'slice k at tile (k % tiles_x, floor(k / tiles_x)); low z first',
            'pixel_mapping':'For node (ix,iy) in slice k, pixel center = (tile_x*stride_x+1+ix+0.5, tile_y*stride_y+1+iy+0.5); divide by atlas width/height for UV.',
            'interpolation':'Map ENU into node coordinates (p-min)/(max-min)*(shape_xyz-1). Bilinear sample slices floor(z) and min(floor(z)+1,nz-1), then mix by fract(z). Return zero outside bounds; do not let texture repeat across tiles.'}
    return image,layout


def _sha(path):
    digest=hashlib.sha256()
    with Path(path).open('rb') as handle:
        for chunk in iter(lambda:handle.read(1024*1024),b''):digest.update(chunk)
    return digest.hexdigest()


def configure_runtime(trip_path,asset_dir,work_dir):
    """Configure the existing engine in a fresh process; never downloads data.

    Returns kwargs for bake_atlas: density_fn, height_exaggeration and source.
    Runtime imports are immutable; changing an already-loaded trip is rejected.
    """
    trip_path,asset_dir,work_dir=(Path(p).expanduser().resolve() for p in (trip_path,asset_dir,work_dir))
    if 'runtime' in sys.modules:
        runtime=sys.modules['runtime']
        from trip import load_trip
        # Environment strings may already have been overwritten by a caller;
        # compare the immutable objects actually imported by the density engine.
        if (runtime.TRIP.to_dict() != load_trip(trip_path).to_dict() or
                runtime.ASSETS.resolve() != asset_dir or runtime.WORK.resolve() != work_dir or
                runtime.BUNDLE != json.loads((asset_dir/'bundle.json').read_text())):
            raise ValueError('Cloud runtime already uses different inputs; prepare this atlas in a fresh process')
    engine=Path(__file__).resolve().parent/'engine'
    if str(engine) not in sys.path:sys.path.insert(0,str(engine))
    os.environ.update(FLIGHT_TRIP=str(trip_path),FLIGHT_ASSET_DIR=str(asset_dir),FLIGHT_WORK_DIR=str(work_dir),FLIGHT_COMPUTE='cpu')
    from cloudvolume import _density,HEIGHT_EXAGGERATION
    import runtime
    if runtime.TRIP.weather['mode']=='clear':
        raise ValueError('A density atlas requires an explicit prepared weather bundle, not clear mode')
    files=[]
    for entry in runtime.BUNDLE['weather']['files']:
        path=(asset_dir/entry['path']).resolve()
        if not path.is_relative_to(asset_dir) or not path.is_file():raise ValueError('Weather manifest must reference existing local bundle files')
        digest=_sha(path)
        if digest!=entry['sha256']:raise ValueError(f'Weather bundle hash mismatch: {entry["path"]}')
        files.append({'path':entry['path'],'sha256':digest,'bytes':path.stat().st_size})
    source={'trip_path':str(trip_path),'trip_sha256':_sha(trip_path),'bundle_path':str(asset_dir/'bundle.json'),
            'bundle_sha256':_sha(asset_dir/'bundle.json'),'weather_mode':runtime.TRIP.weather['mode'],
            'weather_model':runtime.BUNDLE['weather'].get('model'),'weather_files':files,
            'density_source':'engine.cloudvolume._density','density_source_sha256':_sha(engine/'cloudvolume.py'),
            'limitations':['Forecast fields constrain modeled seeded clouds; individual billows are not observations.',
                           'Spherical 6371000 m Earth and local tangent ENU; no ellipsoidal geodesy.',
                           'One immutable weather instant per atlas; use separately prepared endpoints only for an explicitly approximate temporal blend.']}
    return {'density_fn':_density,'height_exaggeration':HEIGHT_EXAGGERATION,'source':source}


def bake_atlas(output_prefix,*,origin_lat_deg,origin_lon_deg,origin_altitude_m=0.,
               bounds_enu_m,shape_zyx=(64,96,96),weather_dt,physical_dt=None,
               density_fn=None,height_exaggeration=None,source=None,write_rgba=True):
    """Bake bounded node-sampled density(z,y,x), JSON and optional raw float RGBA."""
    when=_instant(weather_dt);physical=_instant(physical_dt) if physical_dt is not None else None
    bounds=np.asarray(bounds_enu_m,np.float64)
    if bounds.shape!=(3,2) or not np.isfinite(bounds).all() or np.any(bounds[:,1]<=bounds[:,0]):
        raise ValueError('bounds_enu_m must be increasing finite [[east_min,max],[north_min,max],[up_min,max]]')
    if np.any(np.abs(bounds[:2])>60000) or bounds[2,0]<-500 or bounds[2,1]>20000:
        raise ValueError('Atlas bounds must stay within ±60 km horizontally and -500..20000 m up')
    shape=tuple(shape_zyx)
    if len(shape)!=3 or any(type(n) is not int or not 2<=n<=256 for n in shape) or math.prod(shape)>MAX_VOXELS:
        raise ValueError('Atlas needs 2..256 nodes per axis and at most 2000000 voxels')
    if density_fn is None or height_exaggeration is None:
        from cloudvolume import _density,HEIGHT_EXAGGERATION
        density_fn=_density if density_fn is None else density_fn
        height_exaggeration=HEIGHT_EXAGGERATION if height_exaggeration is None else height_exaggeration
    x,y,z=[np.linspace(*bound,n,dtype=np.float64) for bound,n in zip(bounds,shape[::-1])]
    # A single z plane bounds transient point memory independently of atlas size.
    xx,yy=np.meshgrid(x,y,indexing='xy');density=np.empty(shape,np.float32)
    for k,height in enumerate(z):
        points=np.stack((xx,yy,np.full_like(xx,height)),axis=-1)
        density[k]=sample_density(points,origin_lat_deg=origin_lat_deg,origin_lon_deg=origin_lon_deg,
                                  origin_altitude_m=origin_altitude_m,weather_dt=when,density_fn=density_fn,
                                  height_exaggeration=height_exaggeration)
    prefix=Path(output_prefix).expanduser().resolve();prefix.parent.mkdir(parents=True,exist_ok=True)
    archive=prefix.with_suffix('.npz');metadata_path=prefix.with_suffix('.json')
    np.savez_compressed(archive,density=density,x_m=x,y_m=y,z_m=z,
                        origin_ecef_m=enu_to_ecef(np.zeros(3),origin_lat_deg,origin_lon_deg,origin_altitude_m),
                        basis_enu_rows=enu_basis(origin_lat_deg,origin_lon_deg))
    atlas_record=None
    if write_rgba:
        rgba,layout=tiled_rgba(density);raw=prefix.with_suffix('.rgba.f32');rgba.tofile(raw)
        atlas_record=dict(layout,path=raw.name,sha256=_sha(raw),bytes=raw.stat().st_size)
    tau=np.sum((density[1:]+density[:-1])*.5*np.diff(z)[:,None,None],axis=0)
    metadata={'schema_version':1,'weather_utc':when.isoformat(),'physical_utc':physical.isoformat() if physical else None,
              'origin':{'lat_deg':float(origin_lat_deg),'lon_deg':float(origin_lon_deg),'altitude_m':float(origin_altitude_m)},
              'earth_radius_m':EARTH_M,'bounds_enu_m':bounds.tolist(),'shape_zyx':list(shape),
              'axis_order':'density[z,y,x]; x=east, y=north, z=up metres from tangent origin',
              'sampling':'inclusive bounds, node-centered; altitude query is radial ECEF height, not ENU z alone',
              'density_units':'inverse physical metre','density_gain':1.,'height_exaggeration_query_only':height_exaggeration,
              'weather_frozen':True,'source':source or {},
              'density_statistics':{'min':float(density.min()),'max':float(density.max()),'mean':float(density.mean()),
                                    'nonzero_fraction':float(np.mean(density>0)),'p99':float(np.quantile(density,.99)),
                                    'vertical_tau_max':float(tau.max()),'vertical_tau_mean':float(tau.mean())},
              'npz':{'path':archive.name,'sha256':_sha(archive),'bytes':archive.stat().st_size},'rgba_atlas':atlas_record}
    metadata_path.write_text(json.dumps(metadata,indent=2,allow_nan=False)+'\n')
    return metadata
