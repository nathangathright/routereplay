"""Terrain datum sampling shared by aircraft preparation and the globe.

The global 5 arc-minute ETOPO grid is a coarse terrain prior, not airport survey
height. Optional local tiles may improve a viewport without changing its datum.
"""
from functools import lru_cache
from pathlib import Path
import numpy as np
from scipy.io import netcdf_file
from scipy.ndimage import map_coordinates


class TerrainSampler:
    def __init__(self, path, tiles=(), calibration_path=None):
        from terrain_tiles import read_tile
        from calibration import read_profile
        self.calibration=read_profile(calibration_path) if calibration_path is not None else None
        self.has_calibration=bool(self.calibration and self.calibration['surveys'])
        self.tiles=sorted((read_tile(tile) for tile in tiles),key=lambda tile:float((tile[0][1]-tile[0][0])*(tile[1][1]-tile[1][0])),reverse=True)
        with netcdf_file(Path(path),mmap=False) as nc:
            # Match render.DEM: ocean cells represent sea level before spatial
            # interpolation, so bathymetry cannot pull coastal land below it.
            self.height=np.maximum(np.asarray(nc.variables['z'][:],np.float32),0)
            self.lat=np.asarray(nc.variables['latitude'][:],np.float64).copy()
            self.lon=np.asarray(nc.variables['longitude'][:],np.float64).copy()
        if self.height.shape != (len(self.lat),len(self.lon)) or len(self.lat)<2 or len(self.lon)<2:
            raise ValueError('Terrain must have z(latitude,longitude) on a regular global grid')
        self.max_elevation_m=max([float(self.height.max())]+[float(tile[2].max()) for tile in self.tiles]+([s['elevation_m'] for s in self.calibration['surveys']] if self.calibration else []))
        self.lat_step=float(self.lat[1]-self.lat[0])
        self.lon_step=float(self.lon[1]-self.lon[0])
        if self.lat_step <= 0 or self.lon_step <= 0 or not np.allclose(np.diff(self.lat),self.lat_step) or not np.allclose(np.diff(self.lon),self.lon_step):
            raise ValueError('Terrain coordinates must be increasing and uniformly spaced')

    def sample(self, points):
        points=np.asarray(points,dtype=float)
        shape=points.shape[:-1]
        points=points.reshape(-1,3)
        norm=np.linalg.norm(points,axis=1)
        if np.any(~np.isfinite(points)) or np.any(norm==0):
            raise ValueError('Terrain query needs finite nonzero Earth-centered positions')
        lat=np.degrees(np.arcsin(np.clip(points[:,2]/norm,-1,1)))
        lon=np.degrees(np.arctan2(points[:,1],points[:,0]))
        coords=np.array([np.clip((lat-self.lat[0])/self.lat_step,0,len(self.lat)-1),
                         ((lon-self.lon[0])/self.lon_step)%len(self.lon)])
        # Bathymetry is not exposed land; sea level is the ground datum offshore.
        value=map_coordinates(self.height,coords,order=1,mode='grid-wrap',prefilter=False)
        for tile_lat,tile_lon,tile_height in self.tiles:
            inside=(lat>=tile_lat[0])&(lat<=tile_lat[-1])&(lon>=tile_lon[0])&(lon<=tile_lon[-1])
            if not np.any(inside):continue
            yy=(lat[inside]-tile_lat[0])/(tile_lat[1]-tile_lat[0])
            xx=(lon[inside]-tile_lon[0])/(tile_lon[1]-tile_lon[0])
            detail=map_coordinates(tile_height,np.array([yy,xx]),order=1,mode='nearest',prefilter=False)
            edge=np.minimum.reduce([yy,xx,len(tile_lat)-1-yy,len(tile_lon)-1-xx])
            weight=np.clip(edge/2,0,1);weight=weight*weight*(3-2*weight)
            value[inside]=value[inside]*(1-weight)+detail*weight
        value=np.maximum(value,0)
        if self.has_calibration:
            from calibration import apply_surveys
            value=apply_surveys(self.calibration,points,value)
        return value.reshape(shape)

    def sample_with_slopes(self, points):
        points=np.asarray(points,float)
        points=points/np.linalg.norm(points,axis=-1,keepdims=True)
        lon=np.arctan2(points[...,1],points[...,0])
        east=np.stack([-np.sin(lon),np.cos(lon),np.zeros_like(lon)],axis=-1)
        north=np.cross(points,east)
        # Local detail drives lighting normals too. A short central difference
        # crosses the same feathered boundaries as ray-intersection queries.
        angular_step=100./6371000.
        sample=lambda direction:self.sample(points*np.cos(angular_step)+direction*np.sin(angular_step))
        slope_e=(sample(east)-sample(-east))/200.
        slope_n=(sample(north)-sample(-north))/200.
        return self.sample(points),slope_e,slope_n


@lru_cache(maxsize=2)
def terrain_sampler(path, tiles=(), calibration_path=None):
    return TerrainSampler(path,tiles,calibration_path)
