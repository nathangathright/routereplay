"""Local calibration validation, shared terrain footprint and Blender consumers."""
import ast
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace as NS
import unittest
from unittest.mock import patch
import numpy as np
from scipy.io import netcdf_file
SCRIPTS=Path(__file__).resolve().parents[1]/'skills/cinematic-flight-videos/scripts'
sys.path[:0]=[str(SCRIPTS),str(SCRIPTS/'engine')]
from calibration import validate_profile,read_profile,profile_summary,apply_surveys
from terrain_detail import TerrainSampler,terrain_sampler
from motion import unit
from lighting_profile import validate_profile as validate_lighting

SOURCE={'url':'https://example.org/local-evidence','credit':'Synthetic test fixture','license_url':'https://example.org/license','notes':'Illustrative fixture, not a real measurement.'}


def profile():
    return {'schema_version':1,'title':'Synthetic calibration fixture','source':SOURCE.copy(),
        'surveys':[{'id':'test-control','code':'TEST','lat':0.,'lon':179.999,'radius_m':1000.,'elevation_m':234.,'datum':'MSL','basis':'measured','source':SOURCE.copy(),'notes':'Synthetic point-control fixture.','observed_at':'2025-01-01T00:00:00Z','uncertainty_m':2.}],
        'materials':{'a321neo':{'paint':{'linear_rgb':[.05,.12,.65],'roughness':.65,'metallic':.02,'basis':'measured','observed_at':'2025-01-01T00:00:00Z','source':SOURCE.copy(),'notes':'Synthetic material fixture.','uncertainty':{'linear_rgb':[.01,.01,.02],'roughness':.05,'metallic':.01,'notes':'Synthetic absolute error bounds.'}}}}}


def aircraft_function(name,environment):
    path=SCRIPTS/'engine/aircraft_blender.py'
    node=next(n for n in ast.parse(path.read_text()).body if isinstance(n,ast.FunctionDef) and n.name==name)
    exec(compile(ast.Module(body=[node],type_ignores=[]),str(path),'exec'),environment)
    return environment[name]


class CalibrationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        self.path=self.root/'calibration.json';self.path.write_text(json.dumps(profile()))
        self.dem=self.root/'terrain.nc'
        with netcdf_file(self.dem,'w') as nc:
            nc.createDimension('latitude',19);nc.createDimension('longitude',36)
            nc.createVariable('latitude','d',('latitude',))[:]=np.linspace(-90,90,19)
            nc.createVariable('longitude','d',('longitude',))[:]=np.linspace(-180,170,36)
            nc.createVariable('z','f',('latitude','longitude'))[:]=100

    def test_evidence_dates_and_uncertainty_are_retained_without_inventing_validity(self):
        loaded=read_profile(self.path);self.assertEqual(loaded,profile())
        summary=profile_summary(loaded);self.assertEqual(summary['max_elevation_m'],234.)
        self.assertIn('does not assert current verification',summary['date_scope'])
        self.assertNotIn('valid_until',loaded['surveys'][0])
        changed=copy.deepcopy(loaded);changed['surveys'][0]['uncertainty_m']=50.
        point=np.array([unit(0,179.999)])
        np.testing.assert_array_equal(apply_surveys(loaded,point,[100]),apply_surveys(changed,point,[100]))

    def test_measured_inputs_require_evidence_and_supported_datum(self):
        for key in ('observed_at','uncertainty_m'):
            value=profile();del value['surveys'][0][key]
            with self.assertRaises(ValueError):validate_profile(value)
        for key in ('observed_at','uncertainty'):
            value=profile();del value['materials']['a321neo']['paint'][key]
            with self.assertRaises(ValueError):validate_profile(value)
        for key,value in [('datum','ellipsoid'),('elevation_m',-3),('elevation_m',float('nan')),('radius_m',10),('observed_at','2026-01-01')]:
            record=profile();record['surveys'][0][key]=value
            with self.assertRaises(ValueError):validate_profile(record)
        value=profile();value['surveys'][0]['basis']='modeled';del value['surveys'][0]['observed_at'];del value['surveys'][0]['uncertainty_m'];validate_profile(value)

    def test_overlap_and_unrecognized_material_channels_are_rejected(self):
        value=profile();other=copy.deepcopy(value['surveys'][0]);other['id']='other';value['surveys'].append(other)
        with self.assertRaisesRegex(ValueError,'overlap'):validate_profile(value)
        for mutation in (lambda v:v['materials']['a321neo']['paint'].update(roughness=True),
                         lambda v:v['materials']['a321neo']['paint'].update(linear_rgb=[2,0,0]),
                         lambda v:v['materials']['a321neo'].update(livery={}),
                         lambda v:v.update(extra=True)):
            value=profile();mutation(value)
            with self.assertRaises(ValueError):validate_profile(value)

    def test_shared_terrain_core_feather_dateline_and_slopes(self):
        sampler=TerrainSampler(self.dem,calibration_path=self.path)
        self.assertTrue(sampler.has_calibration);self.assertEqual(sampler.max_elevation_m,234.)
        distances=np.array([0.,400.,750.,1000.,1001.])
        longitudes=(179.999+np.degrees(distances/6371000)+180)%360-180
        points=np.array([unit(0,lon) for lon in longitudes])
        np.testing.assert_allclose(sampler.sample(points),[234,234,167,100,100],atol=.001)
        height,east,north=sampler.sample_with_slopes(points[:3])
        np.testing.assert_allclose(height,sampler.sample(points[:3]),atol=1e-8)
        self.assertAlmostEqual(east[0],0,places=8);self.assertAlmostEqual(north[0],0,places=8)
        self.assertLess(east[2],0)
        outside=np.array([unit(0,179.999+np.degrees(1000.01/6371000))])
        inside=np.array([unit(0,179.999+np.degrees(999.99/6371000))])
        self.assertLess(float(abs(sampler.sample(outside)-sampler.sample(inside))[0]),1e-5)
        np.testing.assert_array_equal(TerrainSampler(self.dem).sample(points),100)

    def test_cloud_city_glow_reuses_calibrated_terrain_sampler(self):
        path=SCRIPTS/'engine/cloudvolume.py'
        node=next(n for n in ast.parse(path.read_text()).body
                  if isinstance(n,ast.FunctionDef) and n.name=='_city_source')
        environment=dict(np=np,TRIP=NS(style={'cloud_city_glow':2.}),HEIGHT_EXAGGERATION=12.)
        exec(compile(ast.Module(body=[node],type_ignores=[]),str(path),'exec'),environment)
        expected=terrain_sampler(str(self.dem),(),str(self.path))
        points=np.array([unit(0,179.999)])
        def illumination(query,source,density,**kwargs):
            self.assertIs(kwargs['ground_height'].__self__,expected)
            np.testing.assert_allclose(kwargs['ground_height'](points),234.)
            return np.zeros((len(query),3))
        runtime=NS(ASSETS=self.root,BUNDLE={'calibration':{'path':self.path.name}},
                   asset=lambda name:self.dem)
        with patch.dict(sys.modules,{'runtime':runtime,
                'nightlighting':NS(city_emission=lambda *a,**k:None)}),\
             patch('cityglow.ground_illumination',side_effect=illumination) as scatter:
            environment['_city_source'](points,None,[0,0,1],object(),())
        scatter.assert_called_once()

    def test_material_values_reach_named_shader_slots_and_retain_evidence(self):
        (self.root/'bundle.json').write_text(json.dumps({'calibration':{'path':'calibration.json'}}))
        inputs={name:NS(default_value=None) for name in ('Base Color','Roughness','Metallic')}
        mat=NS(diffuse_color=None,node_tree=NS(nodes={'Principled BSDF':NS(inputs=inputs)}))
        env=dict(os=os,Path=Path,json=json,VARIANT='a321neo',MATERIAL_CALIBRATION={})
        apply=aircraft_function('apply_material_calibration',env)
        with patch.dict(os.environ,{'FLIGHT_ASSET_DIR':str(self.root)}):apply({'paint':mat})
        self.assertEqual(inputs['Base Color'].default_value,(.05,.12,.65,1.));self.assertEqual(inputs['Roughness'].default_value,.65)
        self.assertEqual(env['MATERIAL_CALIBRATION']['slots']['paint']['basis'],'measured')

    def test_sun_rgb_accepts_complete_extinction_and_rejects_bad_values(self):
        solar=aircraft_function('solar_light_state',{'np':np})
        self.assertEqual(solar({}),(1.,1.,1.));self.assertEqual(solar({'sun_rgb':[0,.5,1]}),(0.,.5,1.))
        for rgb in ([1,2,0],[1,-.1,0],[float('nan'),1,1],[1,1]):
            with self.assertRaises(ValueError):solar({'sun_rgb':rgb})

    def test_regional_light_uncertainty_is_optional_metadata(self):
        value={'schema_version':1,'title':'Fixture','source':SOURCE,'regions':[{'id':'region','lat':0,'lon':0,'radius_km':10,'valid_from':'2020-01-01T00:00:00Z','valid_until':'2030-01-01T00:00:00Z','basis':'measured','notes':'Fixture','xy':[.3,.3],'observed_at':'2025-01-01T00:00:00Z','uncertainty':{'xy':[.01,.02],'population_fraction':.1,'schedule_hours':1.,'notes':'Declared absolute bounds.'}}]}
        self.assertIs(validate_lighting(value),value)
        value['regions'][0]['uncertainty']['population_fraction']=2
        with self.assertRaises(ValueError):validate_lighting(value)


if __name__=='__main__':unittest.main()
