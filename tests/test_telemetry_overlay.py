"""Rendered telemetry contracts: opt-in, physical units, fixed slots and font identity."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image, ImageChops

SCRIPTS=Path(__file__).resolve().parents[1]/'skills/cinematic-flight-videos/scripts'
sys.path[:0]=[str(SCRIPTS),str(SCRIPTS/'engine')]
from trip import load_trip,trip_from_dict,TripError
from telemetry_overlay import composite,readouts,_advance
from fonts import telemetry_font
from flight_video import cache_key,apply_telemetry_options
from types import SimpleNamespace


def fixture(enabled=True,units='aviation'):
    data=json.loads((SCRIPTS.parent/'examples/sample-single-leg.json').read_text())
    data['telemetry']={'enabled':enabled,'units':units}
    return trip_from_dict(data)


class TelemetryOverlayTests(unittest.TestCase):
    def test_configuration_is_optional_and_round_trips(self):
        original=load_trip(SCRIPTS.parent/'examples/sample-single-leg.json')
        self.assertIsNone(original.telemetry)
        self.assertNotIn('telemetry',original.to_dict())
        enabled=fixture()
        self.assertTrue(trip_from_dict(enabled.to_dict()).telemetry['enabled'])
        self.assertNotEqual(original.fingerprint,enabled.fingerprint)
        for invalid in [True,{'enabled':1},{'units':'mph'},{'position':'bottom'}]:
            data=original.to_dict();data['telemetry']=invalid
            with self.assertRaises(TripError):trip_from_dict(data)

    def test_units_and_missing_or_estimated_values(self):
        state={'distance_m':1852,'altitude_m':3048,'ground_speed_mps':185.2,
               'distance_basis':'estimated','altitude_basis':'observed','speed_basis':'derived'}
        rows=readouts(state)
        self.assertEqual(rows[0],('DISTANCE','1','NM',True))
        self.assertEqual(rows[1],('ALTITUDE · MSL','10,000','FT',False))
        self.assertEqual(rows[2],('GROUND SPEED','360','KT',False))
        state['altitude_m']=None
        self.assertEqual(readouts(state,'metric')[1][1],'—')
        self.assertEqual(readouts(state,'metric')[2][1:3],('667','KM/H'))

    def test_optional_overlay_leaves_default_pixels_unchanged(self):
        image=Image.new('RGB',(1080,1920),(180,210,240))
        self.assertIs(composite(image,fixture(False),2),image)
        self.assertIs(composite(image,fixture(),0),image)

    def test_safe_area_and_random_access_are_deterministic(self):
        image=Image.new('RGBA',(1080,1920),(90,120,150,255))
        trip=fixture()
        a=composite(image,trip,5)
        composite(image,trip,9)
        b=composite(image,trip,5)
        self.assertEqual(a.tobytes(),b.tobytes())
        box=ImageChops.difference(a.convert('RGB'),image.convert('RGB')).getbbox()
        self.assertIsNotNone(box)
        self.assertGreaterEqual(box[0],0)
        self.assertLessEqual(box[2],1020)
        self.assertGreaterEqual(box[1],180)
        self.assertLess(box[3],500) # no aircraft/airport/footer interference

    def test_digits_use_equal_advance_and_bundled_font_exists(self):
        font=telemetry_font(56)
        self.assertIn('Dosis',font.getname()[0])
        self.assertEqual(_advance('11111',font),_advance('88888',font))
        self.assertTrue((Path(font.path).parent/'OFL.txt').is_file())

    def test_cli_units_enable_and_explicit_disable_wins(self):
        trip=fixture(False)
        self.assertTrue(apply_telemetry_options(trip,SimpleNamespace(telemetry=None,telemetry_units='metric')).telemetry['enabled'])
        self.assertFalse(apply_telemetry_options(trip,SimpleNamespace(telemetry=False,telemetry_units='metric')).telemetry['enabled'])

    def test_font_override_participates_in_cache_identity(self):
        trip=fixture()
        environment={'packages':{'Pillow':'test'}}
        with patch.dict(os.environ,{},clear=False):
            os.environ.pop('FLIGHT_TELEMETRY_FONT',None)
            first=cache_key(trip,{},'diagram',environment)
            with tempfile.TemporaryDirectory() as tmp:
                alternate=Path(tmp)/'alternate.ttf'
                # Same font with valid trailing bytes still loads; contents must invalidate pixels.
                alternate.write_bytes(Path(telemetry_font(54).path).read_bytes()+b'identity-check')
                os.environ['FLIGHT_TELEMETRY_FONT']=str(alternate)
                second=cache_key(trip,{},'diagram',environment)
                self.assertNotEqual(first,second)
            os.environ['FLIGHT_TELEMETRY_FONT']='missing-telemetry-font.ttf'
            with self.assertRaisesRegex(ValueError,'FLIGHT_TELEMETRY_FONT'):
                cache_key(trip,{},'diagram',environment)
            # Disabled overlays need no telemetry font.
            cache_key(fixture(False),{},'diagram',environment)


if __name__=='__main__':unittest.main()
