"""Strict data import, dated sampling, and local/offline provider contracts."""
from datetime import datetime,timezone
import copy,json
from pathlib import Path
import subprocess,sys,tempfile,unittest
from unittest.mock import patch
import numpy as np
from PIL import Image,TiffImagePlugin
from scipy.io import netcdf_file
SCRIPTS=Path(__file__).resolve().parents[1]/'skills/route-replay/scripts'
sys.path.insert(0,str(SCRIPTS))
from environmental_data import (environment_metadata,read_environment,sample_environment,prepared_environment_sampler,
    validate_environment_coverage,write_environment)
from data_adapters import metadata,import_aerosol,import_dem,surface_plan
from dataset_netcdf import NetCDF,resample_global
from era5_import import import_era5,profile_from_pressure,PRESSURES
from data import weather_contract

SOURCE={'url':'https://example.org/synthetic-fixture','credit':'Synthetic test fixture',
        'license_url':'https://example.org/license','notes':'Generated unit-test data; not measurements.'}
ORIGINAL=[{'name':'synthetic.nc','bytes':100,'sha256':'a'*64}]
TIMES=np.array([datetime(2023,10,1,tzinfo=timezone.utc).timestamp(),datetime(2023,10,1,1,tzinfo=timezone.utc).timestamp()])


def nc_file(path,*,pressure=False,aerosol=False,bad_units=False):
    with netcdf_file(str(path),'w') as nc:
        for name,size in [('time',2),('latitude',3),('longitude',4)]:nc.createDimension(name,size)
        for name,values,units in [('time',[0,1],'hours since2023-10-01 00:00:00'),('latitude',[-90,0,90],'degrees_north'),('longitude',[-180,-90,0,90],'degrees_east')]:
            v=nc.createVariable(name,'d',(name,));v[:]=values;v.units=units.replace('since2023','since 2023')
        if aerosol:
            v=nc.createVariable('TOTEXTTAU','f',('time','latitude','longitude'));v.units='kg' if bad_units else '1'
            v[:]=np.broadcast_to(np.array([.1,.9])[:,None,None],(2,3,4));return
        if pressure:
            nc.createDimension('pressure_level',len(PRESSURES));v=nc.createVariable('pressure_level','d',('pressure_level',));v[:]=PRESSURES;v.units='hPa'
            height=np.array([100,800,1500,3000,5500,8000,10500,14000],np.float32)
            values={'z':height*9.80665,'t':np.full(8,270.),'cc':np.full(8,.4),'clwc':np.full(8,1e-5),'ciwc':np.full(8,1e-6),'u':np.arange(8)*2.,'v':np.full(8,-3.)}
            units={'z':'m**2 s**-2','t':'K','cc':'1','clwc':'kg kg**-1','ciwc':'kg kg**-1','u':'m s**-1','v':'m s**-1'}
            for name,level in values.items():
                v=nc.createVariable(name,'f',('time','pressure_level','latitude','longitude'));v.units=units[name]
                v[:]=np.broadcast_to(level[None,:,None,None],(2,8,3,4))
        else:
            for name,value in [('lcc',.2),('mcc',.4),('hcc',.6)]:
                v=nc.createVariable(name,'f',('time','latitude','longitude'));v.units='1';v[:]=value


def dem_file(path,*,nodata=False,crs=4326,raster_type=1,angular_units=9102):
    array=np.arange(16,dtype=np.float32).reshape(4,4)+100
    tags=TiffImagePlugin.ImageFileDirectory_v2()
    keys=[(1024,2),(1025,raster_type),(2048,crs),(2054,angular_units),(4096,3855),(4099,9001)]
    tags[34735]=(1,1,0,len(keys),*[item for key,value in keys for item in (key,0,1,value)])
    tags[33550]=(.01,.01,0.);tags[33922]=(0.,0.,0.,10.,45.,0.)
    if nodata:array[1,1]=-9999;tags[42113]='-9999'
    Image.fromarray(array).save(path,tiffinfo=tags)


class EnvironmentTests(unittest.TestCase):
    def setUp(self):self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
    def tearDown(self):self.temp.cleanup()
    def write(self,**changes):
        args={'latitude':np.array([90,0,-90]),'longitude':np.arange(4)*90,'timestamps':TIMES,
              'fields':{'aod550':np.broadcast_to(np.array([0.,1.])[:,None,None],(2,3,4))},
              'metadata':metadata('aerosol','modeled',SOURCE,'Synthetic AOD fixture',ORIGINAL)}
        args.update(changes);path=self.root/'aerosol.npz';write_environment(path,**args);return path
    def test_exact_endpoints_and_intermediate_time_with_no_extrapolation(self):
        path=self.write()
        for seconds,want in [(0,0),(1800,.5),(3600,1)]:
            np.testing.assert_allclose(sample_environment(path,np.array([-np.pi,np.pi,0]),[0,np.pi/2,-np.pi/2],TIMES[0]+seconds)['aod550'],want)
        with self.assertRaisesRegex(ValueError,'outside'):sample_environment(path,0,0,TIMES[0]-1)
        with self.assertRaisesRegex(ValueError,'no date substitution'):validate_environment_coverage(path,TIMES[0],TIMES[-1]+1)
        meta=validate_environment_coverage(path,TIMES[0],TIMES[-1]);self.assertEqual(meta['shape'],[2,3,4])
    def test_grid_units_missing_values_and_provenance_are_rejected(self):
        for changes in [{'latitude':[80,0,-90]},{'longitude':[0,90,180,360]}, {'timestamps':TIMES[::-1]},
                        {'timestamps':[TIMES[0],TIMES[0]+25*3600]}, {'fields':{'aod550':np.full((2,3,4),np.nan)}}]:
            with self.subTest(changes=list(changes)),self.assertRaises(ValueError):self.write(**changes)
        meta=metadata('aerosol','modeled',SOURCE,'fixture',ORIGINAL);meta['units']={'aod550':'m'}
        with self.assertRaises(ValueError):self.write(metadata=meta)
        meta['units']={'aod550':'1'};meta['source']['license_url']=''
        with self.assertRaises(ValueError):self.write(metadata=meta)
    def test_metadata_must_be_a_versioned_json_object(self):
        meta=metadata('aerosol','modeled',SOURCE,'fixture',ORIGINAL);meta['schema_version']=True
        with self.assertRaises(ValueError):self.write(metadata=meta)
        path=self.write()
        with np.load(path) as data:arrays={k:data[k] for k in data.files}
        arrays['metadata']=np.asarray('[]');np.savez(path,**arrays)
        with self.assertRaisesRegex(ValueError,'JSON object'):read_environment(path)

    def test_periodic_longitude_and_call_order(self):
        values=np.tile(np.array([0.,1.,0.,1.]),(2,3,1));path=self.write(fields={'aod550':values})
        lon=np.radians([-45,0,45,315,360]);expected=[.5,0,.5,.5,0]
        first=sample_environment(path,lon,0,TIMES[0])['aod550'];np.testing.assert_allclose(first,expected)
        np.testing.assert_array_equal(first,sample_environment(path,lon[::-1],0,TIMES[0])['aod550'][::-1])
    def test_prepared_sampler_matches_public_sampling_without_subsequent_file_access(self):
        first=np.tile(np.array([0.,1.,0.,1.]),(3,1));values=np.stack([first,first+2])
        path=self.write(fields={'aod550':values});when=TIMES[0]+900
        lon=np.radians([-45,0,45,315,360]);lat=np.array([[0],[np.pi/2],[-np.pi/2]])
        expected=sample_environment(path,lon,lat,when)['aod550']
        np.testing.assert_array_equal(expected,np.tile([1.,.5,1.,1.,.5],(3,1)))
        sampler=prepared_environment_sampler(path,when)
        # A prepared query is a stable snapshot even after its source disappears.
        path.unlink()
        with patch.object(Path,'resolve',side_effect=AssertionError('No resolve per query')), \
             patch.object(Path,'stat',side_effect=AssertionError('No stat per query')), \
             patch('environmental_data.read_environment',side_effect=AssertionError('No load per query')), \
             patch('numpy.load',side_effect=AssertionError('No NPZ read per query')):
            np.testing.assert_array_equal(sampler(lon,lat)['aod550'],expected)
            np.testing.assert_array_equal(sampler(lon[::-1],lat)['aod550'][:,::-1],expected)
            result=sampler(lon,lat)['aod550'];result[:]=99
            np.testing.assert_array_equal(sampler(lon,lat)['aod550'],expected)

    def test_prepared_sampler_validates_time_once_and_keeps_query_validation(self):
        path=self.write()
        for when in (TIMES[0]-1,TIMES[-1]+1,np.nan,datetime(2023,10,1)):
            with self.subTest(when=when),self.assertRaises(ValueError):prepared_environment_sampler(path,when)
        for when,want in ((TIMES[0],0),(TIMES[-1],1)):
            sampler=prepared_environment_sampler(path,when)
            with patch('environmental_data.timestamp',side_effect=AssertionError('No date conversion per query')):
                self.assertEqual(sampler(0,0)['aod550'],want)
            with self.assertRaises(ValueError):sampler(np.nan,0)
            with self.assertRaises(ValueError):sampler(0,2)

    def test_decoded_archive_budget_and_wrong_array_names_fail(self):
        path=self.write()
        with patch('environmental_data.MAX_BYTES',100),self.assertRaisesRegex(ValueError,'decoded'):read_environment(path)
        with np.load(path) as data:arrays={k:data[k] for k in data.files}
        arrays['unrecognized']=np.array([1]);np.savez(path,**arrays)
        with self.assertRaisesRegex(ValueError,'Unexpected'):read_environment(path)
    def test_netcdf_aerosol_import_and_wrong_units(self):
        source=self.root/'source.nc';nc_file(source,aerosol=True);output=self.root/'out.npz'
        result=import_aerosol(source,output,SOURCE,source_kind='reanalysis');self.assertEqual(result['source_kind'],'reanalysis')
        self.assertAlmostEqual(float(sample_environment(output,0,0,TIMES[0]+1800)['aod550']),.5,places=6)
        self.assertEqual(result['original_files'][0]['name'],'source.nc')
        nc_file(source,aerosol=True,bad_units=True)
        with self.assertRaisesRegex(ValueError,'dimensionless'):import_aerosol(source,output,SOURCE,source_kind='reanalysis')
    def test_unsupported_calendar_missing_grid_and_nonfinite_queries(self):
        source=self.root/'source.nc';nc_file(source,aerosol=True)
        with netcdf_file(str(source),'a') as nc:nc.variables['time'].calendar='360_day'
        with self.assertRaisesRegex(ValueError,'Gregorian'):import_aerosol(source,self.root/'out.npz',SOURCE,source_kind='reanalysis')
        path=self.write()
        with self.assertRaises(ValueError):sample_environment(path,np.nan,0,TIMES[0])
        with self.assertRaises(ValueError):sample_environment(path,0,2,TIMES[0])


class TerrainAdapterTests(unittest.TestCase):
    def test_geotiff_pixel_centers_datum_and_nodata(self):
        from terrain_tiles import read_tile
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);source=root/'tile.tif';output=root/'tile.npz';dem_file(source)
            result=import_dem(source,output,SOURCE,vertical_datum='EGM2008');lat,lon,height=read_tile(output)
            np.testing.assert_allclose(lat,[44.965,44.975,44.985,44.995]);np.testing.assert_allclose(lon,[10.005,10.015,10.025,10.035])
            self.assertEqual(height[0,0],112);self.assertEqual(result['vertical_datum'],'EGM2008')
            with self.assertRaisesRegex(ValueError,'transform other datums'):import_dem(source,output,SOURCE,vertical_datum='ellipsoid')
            dem_file(source,nodata=True)
            with self.assertRaisesRegex(ValueError,'nodata'):import_dem(source,output,SOURCE,vertical_datum='EGM2008')
            dem_file(source,angular_units=9101)
            with self.assertRaisesRegex(ValueError,'degrees'):import_dem(source,output,SOURCE,vertical_datum='EGM2008')
            dem_file(source,crs=3857)
            with self.assertRaisesRegex(ValueError,'EPSG:4326'):import_dem(source,output,SOURCE,vertical_datum='EGM2008')
    def test_raster_point_does_not_get_half_pixel_shift(self):
        from terrain_tiles import read_tile
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);dem_file(root/'tile.tif',raster_type=2)
            import_dem(root/'tile.tif',root/'tile.npz',SOURCE,vertical_datum='EGM2008')
            lat,lon,_=read_tile(root/'tile.npz');self.assertEqual(lat[-1],45);self.assertEqual(lon[0],10)


class Era5AdapterTests(unittest.TestCase):
    def test_regridding_keeps_samples_and_wraps_longitude(self):
        a=np.array([[0,1,0,1],[2,3,2,3],[4,5,4,5]],np.float32)
        b=resample_global(a,5,8);np.testing.assert_array_equal(b[::2,::2],a)
        np.testing.assert_allclose(b[:,7],b[:,1])
    def test_complete_import_runtime_contract_and_offline_reuse(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);pressure=root/'pressure.nc';single=root/'single.nc';destination=root/'weather'
            nc_file(pressure,pressure=True);nc_file(single)
            result=import_era5(pressure,single,destination,SOURCE)
            self.assertEqual(result['weather']['source_mode'],'historical');self.assertFalse(result['reused'])
            self.assertEqual(result['weather'],weather_contract(destination,'historical'))
            with patch('urllib.request.urlopen',side_effect=AssertionError('No network')):
                cached=import_era5(pressure,single,destination,SOURCE)
            self.assertTrue(cached['reused']);self.assertEqual(cached['network_requests'],0)
            with np.load(destination/'cloud-winds.npz') as data:
                np.testing.assert_allclose(data['u'][0,:,0,0],[4,8,12]);self.assertEqual(data['u'].shape,(2,3,361,720))
            (destination/'runtime.json').write_text('{}')
            with self.assertRaisesRegex(ValueError,'Cached ERA5'):import_era5(pressure,single,destination,SOURCE)
    def test_era5_input_bound_precedes_hashing(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);nc_file(root/'p.nc',pressure=True);nc_file(root/'s.nc')
            with patch('era5_import.MAX_INPUT_BYTES',100),patch('data_adapters.identity',side_effect=AssertionError('Do not hash oversized inputs')):
                with self.assertRaisesRegex(ValueError,'2 GiB'):import_era5(root/'p.nc',root/'s.nc',root/'out',SOURCE)

    def test_mismatched_dates_are_not_substituted(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);nc_file(root/'p.nc',pressure=True);nc_file(root/'s.nc')
            with netcdf_file(str(root/'s.nc'),'a') as nc:nc.variables['time'][:]=[3,4]
            with self.assertRaisesRegex(ValueError,'timestamps differ'):import_era5(root/'p.nc',root/'s.nc',root/'out',SOURCE)
            self.assertFalse((root/'out').exists())
    def test_profile_rejects_bad_physical_units_and_preserves_integral(self):
        fields={'z':np.array([100,800,1500,3000,5500,8000,10500,14000])[:,None,None]*9.80665,
                't':np.full((8,1,1),270.),'cc':np.full((8,1,1),.4),'clwc':np.full((8,1,1),1e-5),
                'ciwc':np.zeros((8,1,1)),'u':np.zeros((8,1,1)),'v':np.zeros((8,1,1))}
        profile=profile_from_pressure(fields);tau=profile['tau_above'][:,0,0]
        self.assertTrue(np.all(np.diff(tau)<=0));self.assertEqual(tau[-1],0)
        self.assertEqual(tau[0],np.float16(np.trapezoid(profile['extinction'][:,0,0].astype(np.float32),profile['altitudes_m'])))
        fields['t'][:]=0
        with self.assertRaisesRegex(ValueError,'physical range'):profile_from_pressure(fields)


class AdapterCLITests(unittest.TestCase):
    def test_provider_missing_values_are_allowed_only_outside_applicable_domain(self):
        from data_adapters import _surface_values
        land=np.array([[0,1],[1,0]],np.float32);missing=land==0
        snow=np.where(missing,9999,.2)
        np.testing.assert_array_equal(_surface_values(snow,missing,'SNOD',land),np.where(missing,0,np.float32(.2)))
        with self.assertRaisesRegex(ValueError,'applicable'):_surface_values(snow,~missing,'SNOD',land)
        with self.assertRaisesRegex(ValueError,'same-time LAND'):_surface_values(snow,missing,'SNOD')
        ice=np.where(land==1,9999,.8)
        np.testing.assert_array_equal(_surface_values(ice,land==1,'ICEC',land),np.where(land==1,0,np.float32(.8)))
        with self.assertRaises(ValueError):_surface_values(np.full((2,2),2),np.zeros((2,2),bool),'ICEC',land)

    def test_cache_limit_is_checked_before_network_and_bad_bundle_before_conversion(self):
        from data_adapters import acquire_gfs_surface,main
        with tempfile.TemporaryDirectory() as folder:
            with patch('gfs_archive.DownloadCache',side_effect=AssertionError('No cache/network yet')):
                with self.assertRaisesRegex(ValueError,'inventory reserve'):
                    acquire_gfs_surface('2023-10-01T00:00:00Z','2023-10-01T03:00:00Z','2023-10-01T06:00:00Z',Path(folder)/'out.npz',folder,max_cache_mib=1)
            with patch('data.read_bundle',side_effect=ValueError('Bad destination')),patch('data_adapters.acquire_gfs_surface',side_effect=AssertionError('No acquisition')):
                with self.assertRaises(SystemExit):
                    main(['gfs-surface','--initialization','2023-10-01T00:00:00Z','--start','2023-10-01T03:00:00Z','--end','2023-10-01T06:00:00Z','--bundle',folder,'--output',folder+'/out.npz','--cache-directory',folder])

    def test_oversized_surface_grid_fails_before_cache_or_network(self):
        from data_adapters import acquire_gfs_surface
        with tempfile.TemporaryDirectory() as folder:
            with patch('gfs_archive.DownloadCache',side_effect=AssertionError('No cache/network yet')):
                with self.assertRaisesRegex(ValueError,'Planned surface output'):
                    acquire_gfs_surface('2023-10-01T00:00:00Z','2023-10-01T00:00:00Z','2023-10-02T12:00:00Z',Path(folder)/'out.npz',folder,provider='nodd-0p25')
        result=surface_plan('2023-10-01T00:00:00Z','2023-10-01T03:00:00Z','2023-10-01T06:00:00Z')
        self.assertLess(result['output_array_bytes'],result['output_decoded_budget_bytes'])
        self.assertLess(result['output_decoded_budget_bytes'],256*1024*1024)

    def test_plan_is_explicit_bounded_and_has_no_fetch(self):
        with patch('gfs_archive.DownloadCache',side_effect=AssertionError('No acquisition')):
            result=surface_plan('2023-10-01T00:00:00Z','2023-10-01T03:00:00Z','2023-10-01T06:00:00Z')
        self.assertEqual(result['hours'],[3,6]);self.assertEqual(result['records'],6)
        run=subprocess.run([sys.executable,str(SCRIPTS/'data_adapters.py'),'gfs-surface','--initialization','2023-10-01T00:00:00Z','--start','2023-10-01T03:00:00Z','--end','2023-10-01T06:00:00Z','--plan'],capture_output=True,text=True)
        self.assertEqual(run.returncode,0,run.stderr);self.assertEqual(json.loads(run.stdout)['records'],6)
        with self.assertRaises(ValueError):surface_plan('2023-10-01T01:00:00Z','2023-10-01T03:00:00Z','2023-10-01T06:00:00Z')


if __name__=='__main__':unittest.main()
