"""Portable local DEM tile format: height_m[latitude,longitude], degrees, MSL."""
from pathlib import Path
import numpy as np
from zipfile import ZipFile, BadZipFile

MAX_TILE_UNCOMPRESSED_BYTES=256*1024*1024
MAX_BUNDLE_UNCOMPRESSED_BYTES=512*1024*1024


def tile_uncompressed_bytes(path):
    """Inspect the ZIP directory without decompressing any terrain arrays."""
    try:
        with ZipFile(path) as archive:
            size=sum(item.file_size for item in archive.infolist())
    except (BadZipFile,EOFError) as exc:
        raise ValueError('Terrain tile must be a valid, complete NPZ archive') from exc
    if size>MAX_TILE_UNCOMPRESSED_BYTES:
        raise ValueError('Terrain tile expands beyond 256 MiB; split it into smaller tiles')
    return size


def check_tile_budget(paths):
    """Reject oversized bundles before any tile arrays are decompressed."""
    total=0
    for path in paths:
        total+=tile_uncompressed_bytes(path)
        if total>MAX_BUNDLE_UNCOMPRESSED_BYTES:
            raise ValueError('Terrain tiles expand beyond the 512 MiB bundle limit; reduce tile size or count')
    return total


def _read_tile(path):
    path=Path(path)
    tile_uncompressed_bytes(path)
    with np.load(path,allow_pickle=False) as data:
        if set(data.files) != {'latitude','longitude','height_m','altitude_reference'}:
            raise ValueError('Terrain tile requires latitude, longitude, height_m, altitude_reference only')
        if str(data['altitude_reference']) != 'MSL':
            raise ValueError('Terrain tile altitude_reference must be MSL')
        lat=np.asarray(data['latitude'],np.float64)
        lon=np.asarray(data['longitude'],np.float64)
        height=np.asarray(data['height_m'],np.float32)
    for coordinates,name,minimum,maximum in [(lat,'latitude',-90,90),(lon,'longitude',-180,180)]:
        if coordinates.ndim!=1 or len(coordinates)<4 or not np.isfinite(coordinates).all() or coordinates[0]<minimum or coordinates[-1]>maximum:
            raise ValueError(f'Terrain {name} must contain at least four finite coordinates within [{minimum},{maximum}]')
        steps=np.diff(coordinates)
        if np.any(steps<=0) or not np.allclose(steps,steps[0],rtol=1e-5,atol=1e-9):
            raise ValueError(f'Terrain {name} must be an increasing regular grid; split date-line tiles')
    if height.shape!=(len(lat),len(lon)) or not np.isfinite(height).all() or np.any((height < -12000)|(height > 10000)):
        raise ValueError('Terrain heights must match coordinates, be finite MSL metres, and contain no nodata holes')
    return lat,lon,height


def read_tile(path):
    try:
        return _read_tile(path)
    except (BadZipFile,EOFError) as exc:
        raise ValueError('Terrain tile must be a valid, complete NPZ archive') from exc
