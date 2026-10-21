"""Storytelling controls retain clocks, references and older opt-out behavior."""
from contextlib import redirect_stdout
from datetime import timedelta
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]/'skills/route-replay/scripts'
sys.path.insert(0, str(SCRIPTS))
from trip import load_trip, trip_from_dict, TripError
from flight_video import main


def fixture():
    return json.loads((SCRIPTS.parent/'examples/sample-three-leg.json').read_text())


class StorytellingTests(unittest.TestCase):
    def test_default_serialization_and_progress_are_preserved(self):
        from trip import smootherstep
        trip = trip_from_dict(fixture())
        self.assertNotIn('attitude', trip.to_dict())
        self.assertNotIn('moments', trip.to_dict())
        self.assertNotIn('pacing', trip.to_dict()['video'])
        for i, (start, end) in enumerate(trip.leg_intervals):
            for u in (0, .01, .3, .5, .9, 1):
                self.assertAlmostEqual(trip.progress(i, start+(end-start)*u), smootherstep(u), places=14)

    def test_inverse_clocks_and_holds_for_both_pacing_modes(self):
        for mode in ('classic', 'highlights'):
            data = fixture();data['video']['pacing'] = mode
            trip = trip_from_dict(data)
            baseline = trip_from_dict(fixture())
            self.assertEqual(trip.leg_intervals, baseline.leg_intervals)
            for i, leg in enumerate(trip.legs):
                for fraction in (0, .0001, .1, .5, .9, .9999, 1):
                    instant = leg.depart+(leg.arrive-leg.depart)*fraction
                    time = trip.presentation_time(instant, i)
                    # Nonzero layovers make the endpoint physical instant unambiguous.
                    self.assertLess(abs((trip.travel_time(time)-instant).total_seconds()), .01)
            self.assertEqual(trip.travel_time(0), trip.legs[0].depart)
            self.assertEqual(trip.travel_time(trip.duration_s), trip.legs[-1].arrive)
            self.assertNotEqual(trip.weather_time(trip.duration_s-.1), trip.weather_time(trip.duration_s))

    def test_configuration_rejects_invalid_pose_and_pacing(self):
        for attitude in ({'enabled': 1}, {'strength': -1}, {'strength': float('nan')},
                         {'max_bank_deg': 46}, {'max_pitch_deg': 26}, {'mystery': 2}):
            data = fixture();data['attitude'] = attitude
            with self.assertRaises(TripError):trip_from_dict(data)
        data = fixture();data['video']['pacing'] = 'fast'
        with self.assertRaises(TripError):trip_from_dict(data)

    def test_cli_override_preserves_input_and_resolves_media_before_snapshot(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve();path = root/'trip.json';data = fixture()
            data['moments'] = [{'flight': 1, 'time': data['flights'][0]['departure'],
                                'path': 'photo.jpg', 'duration_s': 1}]
            path.write_text(json.dumps(data));before = path.read_bytes()
            with redirect_stdout(io.StringIO()) as out:
                main(['plan', str(path), '--aircraft-motion', '--pacing', 'highlights', '--telemetry'])
            plan = json.loads(out.getvalue())
            self.assertTrue(plan['attitude']['enabled'])
            self.assertEqual(plan['pacing'], 'highlights')
            self.assertTrue(plan['telemetry']['enabled'])
            self.assertEqual(Path(plan['moments'][0]['path']), root/'photo.jpg')
            self.assertEqual(path.read_bytes(), before)
            trip = load_trip(path);snapshot = root/'cache'/'trip.json';snapshot.parent.mkdir()
            snapshot.write_text(json.dumps(trip.to_dict()))
            self.assertEqual(load_trip(snapshot).moments[0]['path'], str(root/'photo.jpg'))

    def test_media_content_changes_cache_and_preparation_rejects_mixed_snapshot(self):
        from PIL import Image
        from media_moments import media_identity
        from flight_video import cache_key, prepare_media
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve();photo = root/'photo.png'
            Image.new('RGB', (24, 24), 'red').save(photo)
            data = fixture()
            data['moments'] = [{'flight': 1, 'time': data['flights'][0]['departure'],
                                'path': str(photo), 'duration_s': 1}]
            trip = trip_from_dict(data)
            environment = {'packages': {'Pillow': 'fixture'}}
            before = cache_key(trip, {}, 'diagram', environment)
            expected = media_identity(trip)
            (root/'provenance.json').write_text(json.dumps({'media_identity': expected}))
            tick = round((trip.leg_intervals[0][0]+.5)*trip.fps)
            result = prepare_media(trip, root, [tick])
            self.assertEqual(result['identity'], expected)
            Image.new('RGB', (24, 24), 'blue').save(photo)
            self.assertNotEqual(before, cache_key(trip, {}, 'diagram', environment))
            with self.assertRaisesRegex(ValueError, 'identity|changed'):
                prepare_media(trip, root, [tick])

    def test_inverse_rejects_ambiguous_or_outside_instants(self):
        trip = trip_from_dict(fixture());leg = trip.legs[0]
        for instant, index in ((leg.depart.replace(tzinfo=None), 0), (leg.depart, True),
                               (leg.depart-timedelta(seconds=1), 0), (leg.depart, -1)):
            with self.assertRaises(TripError):trip.presentation_time(instant, index)


if __name__ == '__main__':unittest.main()
