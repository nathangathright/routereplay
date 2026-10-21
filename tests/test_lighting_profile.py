"""Local lighting evidence remains bounded, attributed, dated and reproducible."""
import copy
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import numpy as np

SCRIPTS=Path(__file__).resolve().parents[1]/'skills/cinematic-flight-videos/scripts'
sys.path.insert(0,str(SCRIPTS));sys.path.insert(0,str(SCRIPTS/'engine'))
import data
from lighting_profile import (read_profile,validate_profile,apply_profile,
                              apply_population_profile,xy_linear_rgb,LAMP_IDS)
from citypopulations import regional_populations,population_colors
from engine.lampspectra import LINEAR_PALETTE,LUMA


def example():
    return read_profile(SCRIPTS.parent/'examples/sample-lighting-profile.json')


def evaluate(profile,coordinates,when='2030-06-01T00:00:00Z'):
    points=np.radians(np.array(coordinates))
    lon,lat=points[:,0],points[:,1]
    priors=regional_populations(lon,lat)
    color=np.sum(population_colors(lon,lat,priors)*priors['shares'][...,None],axis=-2)
    return apply_profile(profile,lon,lat,datetime.fromisoformat(when.replace('Z','+00:00')),color,priors),color,priors


def population_example():
    profile=example();profile['schema_version']=2
    region=profile['regions'][0]
    for key in ['xy','shares','building_curfew','sign_curfew']:
        del region[key]
    region.update(lat=0,lon=0,radius_km=100,district_variation=0,
                  population_mixtures={'outdoor':{'sodium':.25,'led_3000':.75}})
    return validate_profile(profile)


def evaluate_populations(profile,coordinates,when='2030-06-01T00:00:00Z'):
    points=np.radians(np.asarray(coordinates))
    lon,lat=points[:,0],points[:,1]
    priors=regional_populations(lon,lat)
    colors=population_colors(lon,lat,priors)
    result=apply_population_profile(profile,lon,lat,datetime.fromisoformat(when.replace('Z','+00:00')),colors,priors)
    return result,colors,priors


class LightingProfileTests(unittest.TestCase):
    def test_d65_and_saturated_colors_preserve_unit_luminance(self):
        self.assertTrue(np.allclose(xy_linear_rgb([.3127,.3290]),1,atol=.0003))
        for xy in [[.4,.4],[.7,.2],[.01,.01]]:
            rgb=xy_linear_rgb(xy)
            self.assertTrue(np.isfinite(rgb).all() and (rgb>=0).all())
            self.assertAlmostEqual(float(rgb@np.array([.2126,.7152,.0722])),1)

    def test_region_and_calendar_limits_keep_default_priors(self):
        p=example()
        (changed,priors),base,original=evaluate(p,[[174,-41],[0,0]])
        self.assertFalse(np.allclose(changed[0],base[0]))
        np.testing.assert_array_equal(changed[1],base[1])
        np.testing.assert_allclose(priors['shares'][0],p['regions'][0]['shares'])
        np.testing.assert_array_equal(original['shares'][1],priors['shares'][1])
        for stamp in ['2029-12-31T23:59:59Z','2031-01-01T00:00:00Z']:
            (changed,priors),base,original=evaluate(p,[[174,-41]],stamp)
            np.testing.assert_array_equal(changed,base)
            np.testing.assert_array_equal(priors['shares'],original['shares'])

    def test_color_measurements_do_not_invent_population_or_schedule_evidence(self):
        p=example()
        for key in ['shares','building_curfew','sign_curfew']:
            del p['regions'][0][key]
        validate_profile(p)
        (colors,priors),base,original=evaluate(p,[[174,-41]])
        self.assertFalse(np.allclose(colors,base))
        for key in ['shares','building_curfew','sign_curfew']:
            np.testing.assert_array_equal(priors[key],original[key])

    def test_geography_is_continuous_at_dateline_and_overlap_order_independent(self):
        p=example();p['regions'][0].update(lat=0,lon=180,radius_km=400)
        second=copy.deepcopy(p['regions'][0]);second.update(id='second',xy=[.3127,.3290],shares=[.2,.3,.4,.1]);p['regions'].append(second)
        first=evaluate(p,[[179.999,0],[-179.999,0]])[0]
        p['regions'].reverse();other=evaluate(p,[[179.999,0],[-179.999,0]])[0]
        np.testing.assert_array_equal(first[0],other[0]);np.testing.assert_allclose(first[0][0],first[0][1])
        np.testing.assert_allclose(first[1]['shares'].sum(axis=-1),1)

    def test_spatial_feather_and_default_input_are_not_mutated(self):
        p=example();p['regions'][0].update(lat=0,lon=0,radius_km=100)
        (colors,priors),base,original=evaluate(p,[[0,0],[.81,0],[1,0]])
        weight=(colors[1,0]-base[1,0])/(colors[0,0]-base[1,0])
        self.assertGreater(weight,0);self.assertLess(weight,1)
        np.testing.assert_array_equal(colors[2],base[2])
        self.assertFalse(np.array_equal(priors['shares'][0],original['shares'][0]))
        self.assertIsNot(priors,original)

    def test_rejects_invalid_evidence_dates_geometry_and_population(self):
        for key,value in [('xy',[.8,.8]),('lat',True),('radius_km',float('nan')),('shares',[.5,.5,.5,.5]),
                          ('valid_until','2029-01-01T00:00:00Z'),('valid_from','2030-01-01'),('basis','observed-ish')]:
            with self.subTest(key=key):
                p=example();p['regions'][0][key]=value
                with self.assertRaises(ValueError):validate_profile(p)
        p=example();p['source']=[]
        with self.assertRaises(ValueError):validate_profile(p)

    def test_population_schema_rejects_ambiguous_or_invalid_mixtures(self):
        invalid=[{}, {'roads':{'sodium':1}}, {'outdoor':{}},
                 {'outdoor':{'unknown':1}}, {'outdoor':{'sodium':True}},
                 {'outdoor':{'sodium':-.1,'led_3000':1.1}},
                 {'outdoor':{'sodium':.9}}, {'outdoor':{'sodium':float('nan')}},
                 {'outdoor':[1]}]
        for mixture in invalid:
            with self.subTest(mixture=mixture):
                p=population_example();p['regions'][0]['population_mixtures']=mixture
                with self.assertRaises(ValueError):validate_profile(p)
        for variation in [-.1,.501,True,float('inf')]:
            p=population_example();p['regions'][0]['district_variation']=variation
            with self.assertRaises(ValueError):validate_profile(p)
        p=population_example();p['regions'][0]['xy']=[.4,.4]
        with self.assertRaisesRegex(ValueError,'exactly one'):validate_profile(p)
        p=population_example();del p['regions'][0]['population_mixtures']
        with self.assertRaisesRegex(ValueError,'exactly one'):validate_profile(p)
        p=example();p['schema_version']=2;p['regions'][0]['district_variation']=.2
        with self.assertRaisesRegex(ValueError,'only to population_mixtures'):validate_profile(p)
        p=population_example();p['regions'][0]['source']={'url':'missing attribution'}
        with self.assertRaises(ValueError):validate_profile(p)
        p=population_example();p['regions'][0]['notes']='x'*(256*1024)
        with self.assertRaisesRegex(ValueError,'256 KiB'):validate_profile(p)
        p=population_example();p['schema_version']=1
        with self.assertRaises(ValueError):validate_profile(p)

    def test_population_colors_change_only_requested_channels_and_preserve_luminance(self):
        p=population_example()
        (colors,priors),base,original=evaluate_populations(p,[[0,0],[.81,0],[2,0]])
        expected=.25*LINEAR_PALETTE[0]+.75*LINEAR_PALETTE[2]
        np.testing.assert_allclose(colors[0,0],expected,rtol=1e-6)
        self.assertFalse(np.array_equal(colors[1,0],base[1,0]))
        np.testing.assert_array_equal(colors[2],base[2])
        np.testing.assert_array_equal(colors[:,1:],base[:,1:])
        for key in original:
            np.testing.assert_array_equal(priors[key],original[key])
        np.testing.assert_allclose(colors@LUMA,1,rtol=2e-7)
        self.assertFalse(np.shares_memory(colors,base))
        with self.assertRaisesRegex(ValueError,'apply_population_profile'):
            evaluate(p,[[0,0]])

    def test_common_xy_keeps_version_one_results_for_all_four_populations(self):
        p=example();p['regions'][0].update(lat=0,lon=0,radius_km=100)
        lon=np.radians(np.array([0,.81,2]));lat=np.zeros(3)
        priors=regional_populations(lon,lat);base=np.tile(xy_linear_rgb([.3127,.3290]),(3,1)).astype(np.float32)
        when=datetime(2030,6,1,tzinfo=timezone.utc)
        old,old_priors=apply_profile(p,lon,lat,when,base,priors)
        colors=np.repeat(base[:,None,:],4,axis=1)
        for version in [1,2]:
            p['schema_version']=version;validate_profile(p)
            actual,new_priors=apply_population_profile(p,lon,lat,when,colors,priors)
            np.testing.assert_array_equal(actual,np.repeat(old[:,None,:],4,axis=1))
            for key in old_priors:
                np.testing.assert_array_equal(new_priors[key],old_priors[key])

    def test_population_overlap_is_order_independent_and_does_not_dilute_other_channels(self):
        p=population_example();first=p['regions'][0]
        second=copy.deepcopy(first);second.update(id='building',population_mixtures={'building':{'led_5000':1}},building_curfew=26)
        third=copy.deepcopy(first);third.update(id='outdoor-second',population_mixtures={'outdoor':{'metal_halide':1}},sign_curfew=25)
        p['regions'] += [second,third];validate_profile(p)
        result,base,original=evaluate_populations(p,[[0,0],[.81,0]])
        p['regions'].reverse();reordered=evaluate_populations(p,[[0,0],[.81,0]])[0]
        np.testing.assert_array_equal(result[0],reordered[0])
        expected=(.25*LINEAR_PALETTE[0]+.75*LINEAR_PALETTE[2]+LINEAR_PALETTE[5])/2
        np.testing.assert_allclose(result[0][0,0],expected,rtol=1e-6)
        np.testing.assert_array_equal(result[0][0,1],LINEAR_PALETTE[4])
        np.testing.assert_array_equal(result[0][:,2:],base[:,2:])
        self.assertEqual(result[1]['building_curfew'][0],26)
        self.assertEqual(result[1]['sign_curfew'][0],25)
        np.testing.assert_array_equal(result[1]['shares'],original['shares'])

    def test_district_field_is_seam_safe_time_independent_and_evaluated_only_in_region(self):
        from engine.citypopulations import geographic_noise
        p=population_example();p['regions'][0].update(lon=180,radius_km=400,district_variation=.2)
        coords=[[179.999999,0],[-179.999999,0],[179,.1],[0,0]]
        with patch('engine.citypopulations.geographic_noise',wraps=geographic_noise) as noise:
            first,base,_=evaluate_populations(p,coords)
        self.assertEqual(noise.call_count,1)
        self.assertEqual(noise.call_args.args[0].shape,(3,3))
        np.testing.assert_allclose(first[0][0],first[0][1],rtol=2e-7)
        repeated=evaluate_populations(p,list(reversed(coords)),'2030-12-01T03:00:00Z')[0][0][::-1]
        np.testing.assert_array_equal(first[0],repeated)
        self.assertFalse(np.array_equal(first[0][0,0],first[0][2,0]))
        np.testing.assert_allclose(first[0]@LUMA,1,rtol=2e-7)
        np.testing.assert_array_equal(first[0][3],base[3])
        for stamp in ['2029-12-31T23:59:59Z','2031-01-01T00:00:00Z']:
            with patch('engine.citypopulations.geographic_noise') as noise:
                (actual,priors),base,original=evaluate_populations(p,coords,stamp)
            noise.assert_not_called();np.testing.assert_array_equal(actual,base)
            self.assertIs(priors,original)

    def test_district_variation_is_bounded_and_single_lamps_need_no_noise(self):
        p=population_example();p['regions'][0]['district_variation']=.5
        for value in [0.,1.]:
            with patch('engine.citypopulations.geographic_noise',return_value=np.array([value])):
                actual=evaluate_populations(p,[[0,0]])[0][0][0,0]
            weights=np.array([.25,.75])*(1+.5*(2*value-1)*np.array([-1.,-.2]))
            expected=(weights/weights.sum())@LINEAR_PALETTE[[0,2]]
            np.testing.assert_allclose(actual,expected,rtol=1e-6)
        for lamp,index in zip(LAMP_IDS,range(len(LAMP_IDS))):
            p['regions'][0]['population_mixtures']={'outdoor':{lamp:1.,'led_3000':0.}} if lamp!='led_3000' else {'outdoor':{lamp:1.}}
            with patch('engine.citypopulations.geographic_noise') as noise:
                actual=evaluate_populations(p,[[0,0]])[0][0][0,0]
            noise.assert_not_called();np.testing.assert_array_equal(actual,LINEAR_PALETTE[index])

    def test_city_example_has_explicit_2026_scope_and_does_not_tint_airports(self):
        p=read_profile(SCRIPTS.parent/'examples/city-lighting-chicago-auckland.json')
        coords=[[-87.6298,41.8781],[174.7633,-36.8485],[-87.9073,41.9742],[174.785,-37.0082]]
        (colors,priors),base,original=evaluate_populations(p,coords,'2026-10-19T12:00:00Z')
        self.assertFalse(np.array_equal(colors[:2,0],base[:2,0]))
        np.testing.assert_array_equal(colors[:,1:],base[:,1:])
        np.testing.assert_array_equal(colors[2:],base[2:])
        for region in p['regions']:
            self.assertEqual(region['basis'],'modeled')
            self.assertEqual(set(region['population_mixtures']),{'outdoor'})
            self.assertIn('source',region)
        (inactive,_),base,_=evaluate_populations(p,coords,'2030-06-01T00:00:00Z')
        np.testing.assert_array_equal(inactive,base)

    def test_schema_validation_runs_without_numpy_or_engine_imports(self):
        code='''
import sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
class NoEngine:
    def find_spec(self, fullname, path=None, target=None):
        if fullname == 'numpy' or fullname == 'engine' or fullname.startswith('engine.'):
            raise AssertionError('Validation imported '+fullname)
sys.meta_path.insert(0,NoEngine())
from lighting_profile import read_profile
p=read_profile(Path(sys.argv[1]).parent/'examples/city-lighting-chicago-auckland.json')
assert p['schema_version']==2
'''
        result=subprocess.run([sys.executable,'-E','-c',code,str(SCRIPTS)],capture_output=True,text=True,timeout=30)
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)

    def test_bundle_attachment_relocation_and_integrity(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);source=root/'source';source.mkdir()
            for spec in data.static_specs(6).values():
                path=source/spec['path'];path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'fixture')
            bundle=root/'bundle';old=data.import_bundle(source,bundle,6)
            attached=data.attach_lighting_profile(bundle,SCRIPTS.parent/'examples/sample-lighting-profile.json')
            self.assertNotEqual(data.bundle_fingerprint(old),data.bundle_fingerprint(attached))
            self.assertNotIn(str(root),json.dumps(attached))
            moved=root/'moved';shutil.copytree(bundle,moved)
            self.assertEqual(data.bundle_fingerprint(attached),data.bundle_fingerprint(data.read_bundle(moved)))
            record=attached['lighting_profile'];path=moved/record['path'];raw=path.read_bytes();path.write_bytes(raw.replace(b'600.0',b'601.0'))
            with self.assertRaisesRegex(ValueError,'hash changed'):data.read_bundle(moved)

    def test_failed_publication_keeps_existing_manifest_and_no_new_asset(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);source=root/'source';source.mkdir()
            for spec in data.static_specs(6).values():
                path=source/spec['path'];path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'fixture')
            bundle=root/'bundle';data.import_bundle(source,bundle,6);old=(bundle/'bundle.json').read_bytes()
            with patch('data.write_json',side_effect=OSError('disk failure')):
                with self.assertRaises(OSError):data.attach_lighting_profile(bundle,SCRIPTS.parent/'examples/sample-lighting-profile.json')
            self.assertEqual(old,(bundle/'bundle.json').read_bytes());self.assertEqual(list((bundle/'lighting').glob('*')),[])

    def test_atomic_json_failure_cleans_up_and_preserves_old_file(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'data.json';path.write_text('{"old":true}')
            with self.assertRaises(ValueError):data.write_json(path,{'invalid':float('nan')})
            self.assertEqual(path.read_text(),'{"old":true}');self.assertEqual(list(Path(temp).iterdir()),[path])

    def test_fresh_worker_loads_profile_for_emission_but_not_undated_diagnostics(self):
        code = '''
import sys, json
from pathlib import Path
from types import SimpleNamespace
from datetime import datetime, timezone
import numpy as np
from PIL import Image
sys.path[:0] = [sys.argv[1], str(Path(sys.argv[1])/'engine')]
root=Path(sys.argv[2]); (root/'nightlights').mkdir()
Image.new('L',(8,4),255).save(root/'nightlights/BlackMarble_2016_gray_8192.png')
profile=json.loads((Path(sys.argv[1]).parent/'examples/sample-lighting-profile.json').read_text())
(root/'profile.json').write_text(json.dumps(profile))
sys.modules['runtime']=SimpleNamespace(ASSETS=root, BUNDLE={'lighting_profile':{'path':'profile.json'}},
                                     TRIP=SimpleNamespace(style={}))
import nightlighting as lights
from lighting_profile import xy_linear_rgb
lights._timeline=lambda:SimpleNamespace(sample=lambda lon,lat,when:np.ones((len(lon),2)))
lon=np.radians(np.array([174.]));lat=np.radians(np.array([-41.]))
color=lights.city_emission(lon,lat,-.8,physical_dt=datetime(2030,6,1,tzinfo=timezone.utc))[0]
np.testing.assert_allclose(color/(color@np.array([.2126,.7152,.0722])),xy_linear_rgb(profile['regions'][0]['xy']),rtol=1e-6)
diagnostic=lights.city_emission(lon,lat,-.8)
lights._lighting_profile=lambda:None
np.testing.assert_array_equal(diagnostic,lights.city_emission(lon,lat,-.8))
print('worker profile passed')
'''
        with tempfile.TemporaryDirectory() as temp:
            result=subprocess.run([sys.executable,'-E','-c',code,str(SCRIPTS),temp],
                                  cwd=temp,capture_output=True,text=True,timeout=30)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
