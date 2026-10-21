"""Portable bundle tests: no private assets, old Git tags or network required."""
from datetime import datetime, timedelta, timezone
from contextlib import redirect_stderr
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZIP_DEFLATED, ZipFile

SCRIPTS = Path(__file__).resolve().parents[1] / "skills" / "route-replay" / "scripts"
sys.path.insert(0, str(SCRIPTS))
import data
import prepare_weather_bundle as preparation


def write_npy(archive, name, shape, values=None):
    """Small synthetic NPY fixtures; stream compressed zero fields without NumPy."""
    import math
    import struct
    scalar = values is not None
    descr = "<f8" if scalar else "<f2"
    header = repr({"descr": descr, "fortran_order": False, "shape": shape}).encode("ascii")
    header += b" " * ((64 - (10 + len(header) + 1) % 64) % 64) + b"\n"
    with archive.open(name + ".npy", "w") as handle:
        handle.write(b"\x93NUMPY\x01\x00" + struct.pack("<H", len(header)) + header)
        if scalar:
            handle.write(struct.pack("<" + "d" * len(values), *values))
        else:
            remaining = math.prod(shape) * 2
            zeros = bytes(1024 * 1024)
            while remaining:
                chunk = zeros[:min(remaining, len(zeros))]
                handle.write(chunk)
                remaining -= len(chunk)


def make_weather(root, init):
    root.mkdir(parents=True)
    # Deliberately different coverage ranges to test their intersection.
    layers, winds, profiles = [0, 1, 2, 3], [1, 2, 3], [0, 3]
    with ZipFile(root / "cloud-layers.npz", "w", compression=ZIP_DEFLATED) as archive:
        write_npy(archive, "coverage", (len(layers), 3, 721, 1440))
        write_npy(archive, "timestamps", (len(layers),), [(init+timedelta(hours=h)).timestamp() for h in layers])
    with ZipFile(root / "cloud-winds.npz", "w", compression=ZIP_DEFLATED) as archive:
        for name in ("u", "v"):
            write_npy(archive, name, (len(winds), 3, 361, 720))
        write_npy(archive, "representative_heights_m", (3,), [1500, 5500, 10500])
        write_npy(archive, "timestamps", (len(winds),), [(init+timedelta(hours=h)).timestamp() for h in winds])
    for hour in profiles:
        with ZipFile(root / f"cloud-profile-f{hour:03d}.npz", "w", compression=ZIP_DEFLATED) as archive:
            for name in ("extinction", "coverage", "ice_fraction", "tau_above"):
                write_npy(archive, name, (17, 361, 720))
            for name in ("column_tau", "column_height"):
                write_npy(archive, name, (3, 361, 720))
            write_npy(archive, "altitudes_m", (17,), list(range(0, 16001, 1000)))
            write_npy(archive, "timestamp", (), [(init+timedelta(hours=hour)).timestamp()])
    data.write_json(root / "cloud-layers-source.json", {
        "model": "NOAA GFS", "initialization": init.isoformat(), "forecast_hours": layers})
    data.write_json(root / "cloud-profile-source.json", {
        "model": "NOAA GFS", "initialization": init.isoformat(),
        "wind_forecast_hours": winds, "profile_forecast_hours": profiles})


class BundleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = tempfile.TemporaryDirectory()
        cls.fixture_root = Path(cls.fixture.name)
        cls.init = datetime(2028, 2, 3, 6, tzinfo=timezone.utc)
        make_weather(cls.fixture_root / "weather", cls.init)

    @classmethod
    def tearDownClass(cls):
        cls.fixture.cleanup()

    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.root = Path(self.work.name)
        self.legacy, self.bundle = self.root / "source", self.root / "bundle"
        for name, spec in data.static_specs(2).items():
            path = self.legacy / spec["path"]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes((name + " fixture data").encode())
        # Private material must never cross the import boundary.
        (self.legacy / "booking.json").write_text('{"private": true}')
        data.import_bundle(self.legacy, self.bundle, 2)

    def attach(self):
        source = self.root / "weather-source"
        shutil.copytree(self.fixture_root / "weather", source)
        return source, data.attach_weather(self.bundle, source)

    def test_static_bundle_is_portable_and_content_addressed(self):
        first = data.read_bundle(self.bundle)
        moved = self.root / "moved"
        shutil.copytree(self.bundle, moved)
        second = data.read_bundle(moved / "bundle.json")
        self.assertEqual(data.bundle_fingerprint(first), data.bundle_fingerprint(second))
        self.assertFalse((self.bundle / "booking.json").exists())
        self.assertNotIn(str(self.legacy), json.dumps(first))
        for record in first["assets"].values():
            self.assertFalse(Path(record["path"]).is_absolute())

    def test_local_aircraft_attachment_preserves_bytes_and_metadata_identity(self):
        from test_aircraft_assets import write_synthetic_glb, model_metadata
        glb=self.root/'model.glb';write_synthetic_glb(glb)
        metadata=model_metadata()
        first=data.attach_aircraft_model(self.bundle,'a321neo',glb,metadata)
        record=first['aircraft_models']['a321neo']
        self.assertEqual((self.bundle/record['path']).read_bytes(),glb.read_bytes())
        self.assertNotIn(str(self.root),json.dumps(first))
        metadata['length_m']*=1.1;metadata['wingspan_m']*=1.1
        second=data.attach_aircraft_model(self.bundle,'a321neo',glb,metadata)
        self.assertEqual(record['sha256'],second['aircraft_models']['a321neo']['sha256'])
        self.assertNotEqual(data.bundle_fingerprint(first),data.bundle_fingerprint(second))
        moved=self.root/'relocated';shutil.copytree(self.bundle,moved)
        self.assertEqual(data.bundle_fingerprint(second),data.bundle_fingerprint(data.read_bundle(moved)))

    def test_standalone_data_cli_without_inherited_module_paths(self):
        commands = [
            ['attach-lighting', str(self.bundle), str(SCRIPTS.parent/'examples/sample-lighting-profile.json')],
            ['verify', str(self.bundle)],
        ]
        for command in commands:
            result = subprocess.run([sys.executable, '-E', str(SCRIPTS/'data.py'), *command],
                                    cwd=self.root, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('lighting_profile', data.read_bundle(self.bundle))

    def test_local_aircraft_failure_leaves_bundle_unchanged(self):
        from test_aircraft_assets import model_metadata
        glb=self.root/'bad.glb';glb.write_bytes(b'not a glb')
        original=(self.bundle/'bundle.json').read_bytes()
        with self.assertRaises(ValueError):data.attach_aircraft_model(self.bundle,'a321neo',glb,model_metadata())
        self.assertEqual((self.bundle/'bundle.json').read_bytes(),original)

    def test_environment_attachment_changes_identity_and_checks_dates_even_in_clear_mode(self):
        import numpy as np
        from environmental_data import write_environment
        original=data.read_bundle(self.bundle)
        path=self.root/'aerosol.npz'
        source={'url':'https://example.org/source','credit':'Synthetic test fixture',
                'license_url':'https://example.org/license','notes':'No observed data'}
        metadata={'schema_version':1,'kind':'aerosol','source_kind':'modeled','source':source,
                  'units':{'aod550':'1'},'conversion':'Synthetic test',
                  'original_files':[{'name':'fixture','sha256':'0'*64,'bytes':1}]}
        write_environment(path,[90,0,-90],[0,90,180,270],
            [self.init.timestamp(),(self.init+timedelta(hours=3)).timestamp()],
            {'aod550':np.full((2,3,4),.2)},metadata)
        changed=data.attach_environment(self.bundle,path)
        self.assertNotEqual(data.bundle_fingerprint(original),data.bundle_fingerprint(changed))
        data.validate_bundle(self.bundle,'clear',self.init,self.init+timedelta(hours=3),2)
        with self.assertRaisesRegex(ValueError,'cover'):
            data.validate_bundle(self.bundle,'clear',self.init,self.init+timedelta(hours=4),2)
        moved=self.root/'moved';shutil.copytree(self.bundle,moved)
        self.assertEqual(data.bundle_fingerprint(changed),data.bundle_fingerprint(data.read_bundle(moved)))
        before=(self.bundle/'bundle.json').read_bytes()
        bad=self.root/'invalid.npz';bad.write_bytes(b'not a dataset')
        with self.assertRaises(ValueError):data.attach_environment(self.bundle,bad)
        self.assertEqual((self.bundle/'bundle.json').read_bytes(),before)

    def test_calibration_attachment_is_validated_relocatable_and_content_addressed(self):
        source={'url':'https://example.org/source','credit':'Synthetic test fixture',
                'license_url':'https://example.org/license','notes':'Modeled test'}
        profile={'schema_version':1,'title':'Fixture','source':source,'materials':{},
                 'surveys':[{'id':'fixture','lat':20,'lon':30,'radius_m':100,
                             'elevation_m':200,'datum':'MSL','basis':'modeled',
                             'source':source,'notes':'Synthetic'}]}
        path=self.root/'calibration.json';path.write_text(json.dumps(profile))
        before=data.bundle_fingerprint(data.read_bundle(self.bundle))
        bundle=data.attach_calibration(self.bundle,path)
        self.assertNotEqual(data.bundle_fingerprint(bundle),before)
        moved=self.root/'moved';shutil.copytree(self.bundle,moved)
        self.assertEqual(data.bundle_fingerprint(bundle),data.bundle_fingerprint(data.read_bundle(moved)))
        original=(self.bundle/'bundle.json').read_bytes()
        profile['surveys'][0]['datum']='ellipsoid';path.write_text(json.dumps(profile))
        with self.assertRaises(ValueError):data.attach_calibration(self.bundle,path)
        self.assertEqual((self.bundle/'bundle.json').read_bytes(),original)

    def test_explicit_archive_provider_survives_weather_attachment(self):
        source=self.root/'archive-weather';shutil.copytree(self.fixture_root/'weather',source)
        path=source/'cloud-layers-source.json';metadata=json.loads(path.read_text())
        provider={'url':'https://www.ncei.noaa.gov/synthetic-fixture','credit':'NCEI fixture',
                  'license_url':'https://www.ncei.noaa.gov/products/weather-climate-models/global-forecast',
                  'notes':'Synthetic archive metadata; not an AWS object.'}
        metadata['provider']=provider;data.write_json(path,metadata)
        result=data.attach_weather(self.bundle,source)
        self.assertEqual(result['weather']['source_mode'],'forecast')
        self.assertTrue(all(r['source']==provider for r in result['weather']['files']))

    def test_hash_detects_same_size_corruption(self):
        path = self.bundle / "map.png"
        original = path.read_bytes()
        path.write_bytes(b"X" + original[1:])
        with self.assertRaisesRegex(ValueError, "hash changed"):
            data.read_bundle(self.bundle)
        # Worker fast path follows full preflight, retaining metadata checks.
        data.read_bundle(self.bundle, verify_hashes=False)

    def make_tile(self):
        import numpy as np
        tile=self.root/'tile.npz'
        np.savez_compressed(tile,latitude=np.linspace(0,1,4),longitude=np.linspace(10,11,4),
                            height_m=np.full((4,4),100.),altitude_reference='MSL')
        source={'url':'https://example.org/tile','credit':'Synthetic fixture',
                'license_url':'https://example.org/license','notes':'Synthetic MSL terrain'}
        return tile,source

    def test_worker_bundle_read_does_not_decompress_terrain_tiles(self):
        tile,source=self.make_tile()
        data.attach_terrain_tile(self.bundle,tile,source)
        with patch('terrain_tiles.read_tile',side_effect=AssertionError('tile arrays loaded')):
            data.read_bundle(self.bundle,verify_hashes=False)
            with self.assertRaisesRegex(AssertionError,'tile arrays loaded'):
                data.read_bundle(self.bundle)
        record=data.read_bundle(self.bundle)['terrain_tiles'][0]
        (self.bundle/record['path']).unlink()
        with self.assertRaisesRegex(ValueError,'Missing asset'):
            data.read_bundle(self.bundle,verify_hashes=False)

    def test_attached_tile_hashes_and_validates_the_staged_bytes(self):
        import numpy as np
        tile,source=self.make_tile()
        original_digest=data.sha256(tile)
        real_copy=shutil.copy2
        def change_source_then_copy(src,dst):
            np.savez_compressed(src,latitude=np.linspace(0,1,4),longitude=np.linspace(10,11,4),
                                height_m=np.full((4,4),200.),altitude_reference='MSL')
            return real_copy(src,dst)
        with patch('data.shutil.copy2',side_effect=change_source_then_copy):
            bundle=data.attach_terrain_tile(self.bundle,tile,source)
        record=bundle['terrain_tiles'][0]
        self.assertNotEqual(original_digest,record['sha256'])
        self.assertEqual(Path(record['path']).stem,record['sha256'])
        self.assertEqual(data.sha256(self.bundle/record['path']),record['sha256'])
        self.assertEqual(list(self.bundle.glob('.terrain-stage-*')),[])

    def test_invalid_copied_tile_does_not_publish_manifest(self):
        tile,source=self.make_tile()
        original=(self.bundle/'bundle.json').read_bytes()
        def corrupt_copy(src,dst):
            Path(dst).write_bytes(b'not a terrain archive')
        with patch('data.shutil.copy2',side_effect=corrupt_copy):
            with self.assertRaisesRegex(ValueError,'complete NPZ'):
                data.attach_terrain_tile(self.bundle,tile,source)
        self.assertEqual((self.bundle/'bundle.json').read_bytes(),original)
        self.assertEqual(list(self.bundle.glob('.terrain-stage-*')),[])
        self.assertFalse((self.bundle/'terrain-tiles').exists())

    def test_terrain_source_requires_exact_nonempty_string_fields(self):
        tile,valid=self.make_tile()
        cases=[(None,'must be an object'),([], 'must be an object'),
               ('source','must be an object'),(False,'must be an object'),
               ({**valid,'extra':'unexpected'},'Unexpected terrain source key'),
               ({k:v for k,v in valid.items() if k!='url'},'requires nonempty'),
               ({**valid,'credit':'  '},'requires nonempty'),
               ({**valid,'notes':[]},'requires nonempty')]
        with patch('data.read_bundle',side_effect=AssertionError('bundle read before source validation')):
            for source,message in cases:
                with self.subTest(source=source),self.assertRaisesRegex(ValueError,message):
                    data.attach_terrain_tile(self.bundle,tile,source)
        source_json=self.root/'invalid-source.json';source_json.write_text('[]')
        error=io.StringIO()
        args=['data.py','attach-terrain',str(self.bundle),str(tile),'--source-json',str(source_json)]
        with patch.object(sys,'argv',args),redirect_stderr(error),self.assertRaises(SystemExit) as caught:
            data.main()
        self.assertEqual(caught.exception.code,1)
        self.assertIn('Terrain source JSON must be an object',error.getvalue())
        self.assertNotIn('Traceback',error.getvalue())

    def test_aggregate_terrain_budget_precedes_bundle_decompression(self):
        from terrain_tiles import tile_uncompressed_bytes
        tile,source=self.make_tile()
        bundle=data.attach_terrain_tile(self.bundle,tile,source)
        second=self.bundle/'terrain-tiles/second.npz';shutil.copy2(tile,second)
        bundle['terrain_tiles'].append(data.file_record(self.bundle,'terrain-tiles/second.npz',source))
        data.write_json(self.bundle/'bundle.json',bundle)
        # Both small, valid arrays fit separately but exceed a reduced test
        # budget together. This exercises ordering without allocating 512 MiB.
        with patch('terrain_tiles.MAX_BUNDLE_UNCOMPRESSED_BYTES',2*tile_uncompressed_bytes(tile)-1), \
             patch('terrain_tiles.read_tile',side_effect=AssertionError('arrays decompressed')):
            for verify_hashes in (True,False):
                with self.subTest(verify_hashes=verify_hashes),self.assertRaisesRegex(ValueError,'512 MiB bundle limit'):
                    data.read_bundle(self.bundle,verify_hashes=verify_hashes)

    def test_attachment_checks_combined_budget_before_loading_existing_tiles(self):
        import numpy as np
        from terrain_tiles import tile_uncompressed_bytes
        tile,source=self.make_tile()
        bundle=data.attach_terrain_tile(self.bundle,tile,source)
        existing=self.bundle/bundle['terrain_tiles'][0]['path']
        np.savez_compressed(tile,latitude=np.linspace(0,1,4),longitude=np.linspace(10,11,4),
                            height_m=np.full((4,4),200.),altitude_reference='MSL')
        original=(self.bundle/'bundle.json').read_bytes()
        budget=tile_uncompressed_bytes(existing)+tile_uncompressed_bytes(tile)-1
        with patch('terrain_tiles.MAX_BUNDLE_UNCOMPRESSED_BYTES',budget), \
             patch('terrain_tiles.read_tile',side_effect=AssertionError('arrays decompressed')):
            with self.assertRaisesRegex(ValueError,'512 MiB bundle limit'):
                data.attach_terrain_tile(self.bundle,tile,source)
        self.assertEqual((self.bundle/'bundle.json').read_bytes(),original)
        self.assertEqual(list((self.bundle/'terrain-tiles').iterdir()),[existing])
        self.assertEqual(list(self.bundle.glob('.terrain-stage-*')),[])

    def test_failed_terrain_publication_removes_only_a_new_asset(self):
        tile,source=self.make_tile()
        target=self.bundle/'terrain-tiles'/(data.sha256(tile)+'.npz')
        original=(self.bundle/'bundle.json').read_bytes()
        for preexisting in (False,True):
            if preexisting:
                target.parent.mkdir(exist_ok=True);shutil.copy2(tile,target)
            with self.subTest(preexisting=preexisting), \
                 patch('data.write_json',side_effect=OSError('Simulated manifest write failure')):
                with self.assertRaisesRegex(OSError,'Simulated'):
                    data.attach_terrain_tile(self.bundle,tile,source)
            self.assertEqual((self.bundle/'bundle.json').read_bytes(),original)
            self.assertEqual(target.exists(),preexisting)
            if preexisting:self.assertEqual(target.read_bytes(),tile.read_bytes())
            self.assertEqual(list(self.bundle.glob('.terrain-stage-*')),[])

    def test_missing_asset_is_fatal(self):
        (self.bundle / "stars/catalog.gz").unlink()
        with self.assertRaisesRegex(ValueError, "Missing asset"):
            data.read_bundle(self.bundle)

    def test_relative_path_traversal_and_external_symlinks_rejected(self):
        for path in ("../outside", "/outside", "weather/../../outside", "C:\\outside"):
            with self.assertRaises(ValueError):
                data.safe_path(self.bundle, path)
        (self.bundle / "map.png").unlink()
        (self.bundle / "map.png").symlink_to(self.legacy / "map.png")
        with self.assertRaisesRegex(ValueError, "leaves its directory"):
            data.read_bundle(self.bundle)

    def test_clear_requires_static_data_and_selected_month(self):
        data.validate_bundle(self.bundle, "clear", self.init, self.init, 2)
        with self.assertRaisesRegex(ValueError, "surface month"):
            data.validate_bundle(self.bundle, "clear", self.init, self.init, 3)
        with self.assertRaisesRegex(ValueError, "no weather"):
            data.validate_bundle(self.bundle, "forecast", self.init, self.init, 2)

    def test_new_initialization_and_coverage_intersection(self):
        _, bundle = self.attach()
        weather = bundle["weather"]
        self.assertEqual(weather["initialization"], self.init.isoformat())
        self.assertEqual(weather["valid_start"], (self.init + timedelta(hours=1)).isoformat())
        self.assertEqual(weather["valid_end"], (self.init + timedelta(hours=3)).isoformat())
        data.validate_bundle(self.bundle, "forecast", self.init+timedelta(hours=1), self.init+timedelta(hours=3), 2)

    def test_stale_weather_and_uncovered_holds_fail(self):
        self.attach()
        for start, end in ((self.init, self.init+timedelta(hours=2)),
                           (self.init+timedelta(hours=1), self.init+timedelta(hours=3, minutes=20)),
                           (self.init+timedelta(days=1), self.init+timedelta(days=1, hours=2))):
            with self.assertRaisesRegex(ValueError, "no clamping or date substitution"):
                data.validate_bundle(self.bundle, "forecast", start, end, 2)

    def test_replay_uses_explicit_sample_clock_not_flight_clock(self):
        self.attach()
        data.validate_bundle(self.bundle, "illustrative_replay", self.init+timedelta(hours=1), self.init+timedelta(hours=3), 2)
        with self.assertRaisesRegex(ValueError, "no clamping"):
            data.validate_bundle(self.bundle, "illustrative_replay", self.init+timedelta(days=100), self.init+timedelta(days=101), 2)

    def test_forecast_cannot_be_relabelled_as_historical(self):
        source, _ = self.attach()
        with self.assertRaisesRegex(ValueError, "do not relabel"):
            data.weather_contract(source, source_mode="historical")
        with self.assertRaisesRegex(ValueError, "supplied data is forecast"):
            data.validate_bundle(self.bundle, "historical", self.init+timedelta(hours=1), self.init+timedelta(hours=3), 2)

    def test_custom_historical_provider_keeps_its_provenance(self):
        source, _ = self.attach()
        provider = {'url':'https://example.invalid/reanalysis', 'credit':'Synthetic historical fixture',
                    'license_url':'https://example.invalid/terms', 'notes':'Fixture only; not NOAA GFS.'}
        for name in ('cloud-layers-source.json','cloud-profile-source.json'):
            path = source/name
            metadata = json.loads(path.read_text())
            metadata.update(model='Historical fixture', source_mode='historical', provider=provider)
            data.write_json(path,metadata)
        bundle = data.attach_weather(self.bundle,source,'historical')
        self.assertTrue(all(record['source'] == provider for record in bundle['weather']['files']))
        data.validate_bundle(self.bundle,'historical',self.init+timedelta(hours=1),self.init+timedelta(hours=3),2)

    def test_failed_weather_publication_restores_previous_bundle(self):
        source, original = self.attach()
        real_write = data.write_json
        def fail_manifest(path,value):
            if Path(path).name == 'bundle.json':
                raise OSError('Simulated manifest write failure')
            real_write(path,value)
        with patch.object(data,'write_json',side_effect=fail_manifest):
            with self.assertRaisesRegex(OSError,'Simulated'):
                data.attach_weather(self.bundle,source)
        self.assertEqual(original, data.read_bundle(self.bundle))

    def test_metadata_cannot_move_npz_data_to_a_different_run(self):
        source, _ = self.attach()
        for filename in ("cloud-layers-source.json", "cloud-profile-source.json"):
            path = source / filename
            meta = json.loads(path.read_text())
            meta["initialization"] = (self.init+timedelta(days=1)).isoformat()
            data.write_json(path, meta)
        with self.assertRaisesRegex(ValueError, "NPZ timestamps disagree"):
            data.weather_contract(source)

    def test_changed_file_changes_fingerprint_after_explicit_reimport(self):
        first = data.read_bundle(self.bundle)
        (self.legacy / "map.png").write_bytes(b"different source mask")
        second = data.import_bundle(self.legacy, self.root / "other-bundle", 2)
        self.assertNotEqual(data.bundle_fingerprint(first), data.bundle_fingerprint(second))

    def test_naive_and_reverse_weather_clock_rejected(self):
        with self.assertRaisesRegex(ValueError, "explicit UTC offset"):
            data.validate_bundle(self.bundle, "clear", datetime(2028, 2, 3), self.init, 2)
        with self.assertRaisesRegex(ValueError, "precedes"):
            data.validate_bundle(self.bundle, "clear", self.init, self.init-timedelta(hours=1), 2)

    def test_all_month_urls_and_bounds(self):
        for month in range(1, 13):
            spec = data.static_specs(month)["surface"]
            self.assertIn(f"world.2004{month:02d}.", spec["source"]["url"])
        for month in (0, 13, 1.0, True, None):
            with self.assertRaises(ValueError):
                data.static_specs(month)

    def test_download_failure_does_not_publish_partial_file(self):
        class Response(io.BytesIO):
            status = 200
            headers = {"Content-Length": "10"}
        with patch.object(data, "urlopen", return_value=Response(b"short")):
            with self.assertRaisesRegex(ValueError, "Incomplete download"):
                data.download("https://example.invalid/data", self.root / "download")
        self.assertFalse((self.root / "download").exists())
        self.assertFalse((self.root / "download.part").exists())


class WeatherPlanTests(unittest.TestCase):
    def test_hourly_and_three_hour_schedule_brackets_exact_interval(self):
        init = datetime(2028, 1, 1, 0, tzinfo=timezone.utc)
        result = preparation.plan(init, init+timedelta(hours=119, minutes=30), init+timedelta(hours=125))
        self.assertEqual(result["layer_hours"], [119, 120, 123, 126])
        self.assertEqual(result["profile_hours"], [117, 120, 123, 126])
        self.assertEqual(result["bounded_grib_records"], 4*9+4*40)

    def test_invalid_run_or_horizon_is_not_automatically_shifted(self):
        init = datetime(2028, 1, 1, 6, tzinfo=timezone.utc)
        for run, start, end in ((init+timedelta(hours=1), init+timedelta(hours=1), init+timedelta(hours=2)),
                                 (init, init-timedelta(hours=1), init+timedelta(hours=1)),
                                 (init, init, init+timedelta(hours=385))):
            with self.assertRaises(ValueError):
                preparation.plan(run, start, end)


if __name__ == "__main__":
    unittest.main()
