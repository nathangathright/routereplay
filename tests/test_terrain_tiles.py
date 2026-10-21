"""Local DEM provenance, blending, surface normals and datum validation."""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile
import numpy as np
from scipy.io import netcdf_file
SCRIPTS=Path(__file__).resolve().parents[1]/'skills/route-replay/scripts'
sys.path[:0]=[str(SCRIPTS),str(SCRIPTS/'engine')]
from terrain_tiles import read_tile, tile_uncompressed_bytes, check_tile_budget
from terrain_detail import TerrainSampler
from motion import unit
import data


class TerrainTileTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.global_path=self.root/'global.nc'
        with netcdf_file(self.global_path,'w') as nc:
            nc.createDimension('latitude',19);nc.createDimension('longitude',36)
            nc.createVariable('latitude','d',('latitude',))[:]=np.linspace(-90,90,19)
            nc.createVariable('longitude','d',('longitude',))[:]=np.linspace(-180,170,36)
            nc.createVariable('z','f',('latitude','longitude'))[:]=100
        self.tile=self.root/'tile.npz'
        self.save_tile()

    def save_tile(self,**overrides):
        settings={'latitude':np.linspace(0,1,11),'longitude':np.linspace(10,11,11),
                  'height_m':np.repeat(np.linspace(1000,2000,11)[None,:],11,axis=0).astype('f4'),
                  'altitude_reference':'MSL'}
        settings.update(overrides);np.savez_compressed(self.tile,**settings)

    def test_detail_replaces_center_and_feathers_edges(self):
        sampler=TerrainSampler(self.global_path,(self.tile,))
        query=np.array([unit(.5,10.5),unit(0,10.5),unit(2,10.5)])
        np.testing.assert_allclose(sampler.sample(query),[1500,100,100],atol=.001)
        h,e,n=sampler.sample_with_slopes(np.array([unit(.5,10.5)]))
        self.assertGreater(e[0],.005)
        self.assertLess(abs(n[0]),1e-5)

    def test_no_seam_jump_at_tile_edge(self):
        sampler=TerrainSampler(self.global_path,(self.tile,))
        a,b=sampler.sample(np.array([unit(-1e-6,10.5),unit(1e-6,10.5)]))
        self.assertLess(abs(a-b),.001)

    def test_coastal_datum_matches_sea_level_rendered_grid(self):
        with netcdf_file(self.global_path,'a') as nc:
            nc.variables['z'][:,19]=-900  # 10 degrees east, beside 100 m land.
            nc.variables['z'][:,0]=-900   # Also exercise the date-line seam.
        for tiles in [(),(self.tile,)]:
            sampler=TerrainSampler(self.global_path,tiles)
            actual=sampler.sample(np.array([unit(5,5),unit(5,10),unit(5,175)]))
            # Halfway from land to a sea-level ocean cell stays 50 m high;
            # interpolating signed bathymetry first incorrectly produced 0 m.
            np.testing.assert_allclose(actual,[50,0,50],atol=.001)

    def test_nodata_nonuniform_grid_wrong_datum_rejected(self):
        cases=[{'height_m':np.full((11,11),np.nan)}, {'altitude_reference':'ellipsoid'},
               {'longitude':np.array([10,10.1,10.3,10.6])}, {'height_m':np.ones((9,10))}]
        for changes in cases:
            self.save_tile(**changes)
            with self.assertRaises(ValueError):read_tile(self.tile)

    def test_invalid_archive_has_actionable_error(self):
        self.tile.write_text('not a zip archive')
        with self.assertRaisesRegex(ValueError,'complete NPZ'):
            read_tile(self.tile)

    def test_archive_budget_counts_uncompressed_members_without_loading_arrays(self):
        with ZipFile(self.tile) as archive:
            total=sum(item.file_size for item in archive.infolist())
        with patch('terrain_tiles.np.load',side_effect=AssertionError('arrays loaded')):
            self.assertEqual(tile_uncompressed_bytes(self.tile),total)
            with patch('terrain_tiles.MAX_BUNDLE_UNCOMPRESSED_BYTES',2*total):
                self.assertEqual(check_tile_budget([self.tile,self.tile]),2*total)
            with patch('terrain_tiles.MAX_BUNDLE_UNCOMPRESSED_BYTES',2*total-1):
                with self.assertRaisesRegex(ValueError,'512 MiB bundle limit'):
                    check_tile_budget([self.tile,self.tile])
            with patch('terrain_tiles.MAX_TILE_UNCOMPRESSED_BYTES',total-1):
                with self.assertRaisesRegex(ValueError,'256 MiB'):
                    read_tile(self.tile)

    def test_finer_cell_spacing_wins_regardless_of_tile_footprint(self):
        # Large fine grid must override small coarse grid in their shared core.
        coarse=self.root/'small-coarse.npz'
        fine=self.root/'large-fine.npz'
        np.savez_compressed(coarse,latitude=np.linspace(0,1,5),longitude=np.linspace(10,11,5),
                            height_m=np.full((5,5),400.),altitude_reference='MSL')
        np.savez_compressed(fine,latitude=np.linspace(-1,2,61),longitude=np.linspace(9,12,61),
                            height_m=np.full((61,61),1800.),altitude_reference='MSL')
        for order in [(fine,coarse),(coarse,fine)]:
            sampler=TerrainSampler(self.global_path,order)
            self.assertAlmostEqual(float(sampler.sample(unit(.5,10.5))),1800.,places=3)

    def test_attach_changes_fingerprint_and_hash_tampering_rejected(self):
        legacy=self.root/'source'
        for name,spec in data.static_specs(11).items():
            path=legacy/spec['path'];path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(name.encode())
        bundle_dir=self.root/'bundle'
        before=data.import_bundle(legacy,bundle_dir,11)
        source={'url':'https://example.org/synthetic','credit':'Synthetic test fixture',
                'license_url':'https://example.org/license','notes':'Synthetic MSL hill; not measured terrain'}
        after=data.attach_terrain_tile(bundle_dir,self.tile,source)
        self.assertNotEqual(data.bundle_fingerprint(before),data.bundle_fingerprint(after))
        self.assertEqual(len(after['terrain_tiles']),1)
        self.assertEqual(len(data.attach_terrain_tile(bundle_dir,self.tile,source)['terrain_tiles']),1)
        target=bundle_dir/after['terrain_tiles'][0]['path']
        raw=bytearray(target.read_bytes());raw[-1]^=1;target.write_bytes(raw)
        with self.assertRaisesRegex(ValueError,'hash changed'):data.read_bundle(bundle_dir)

if __name__=='__main__':unittest.main()
