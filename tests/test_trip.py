"""Itinerary, clock, and cache identity contracts; no render assets required."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import importlib.util
import json
import math
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "skills" / "cinematic-flight-videos"
MODULE_PATH = SKILL / "scripts" / "trip.py"
sys.path.insert(0,str(SKILL / "scripts"))
spec = importlib.util.spec_from_file_location("cinematic_trip", MODULE_PATH)
trip_module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = trip_module
spec.loader.exec_module(trip_module)
load_trip = trip_module.load_trip
trip_from_dict = trip_module.trip_from_dict
TripError = trip_module.TripError


def sample(name="sample-three-leg.json"):
    return json.loads((SKILL / "examples" / name).read_text())


class TripTests(unittest.TestCase):
    def test_single_leg_crosses_dateline_with_utc_duration(self):
        trip = load_trip(SKILL / "examples" / "sample-single-leg.json")
        self.assertEqual([a.code for a in trip.airport_sequence], ["LAX", "AKL"])
        self.assertEqual(trip.legs[0].arrive - trip.legs[0].depart, timedelta(hours=14))
        self.assertEqual(trip.frame_count, 360)
        self.assertEqual(trip.active_leg(-100), 0)
        self.assertEqual(trip.active_leg(100), 0)
        self.assertEqual(trip.progress(0, -1), 0)
        self.assertEqual(trip.progress(0, 100), 1)
        self.assertLess(trip.legs[0].angle, math.pi)

    def test_three_legs_share_remaining_time_by_sqrt_distance(self):
        trip = trip_from_dict(sample())
        self.assertEqual(len(trip.leg_intervals), 3)
        self.assertEqual(len(trip.airport_sequence), 4)
        self.assertEqual(len(trip.utc_times), 6)
        self.assertEqual(trip.leg_intervals[0][0], 1.6)
        self.assertAlmostEqual(trip.leg_intervals[-1][1], 24 - 2.7)
        widths = [end - start for start, end in trip.leg_intervals]
        self.assertAlmostEqual(widths[1] / widths[0], math.sqrt(trip.legs[1].angle / trip.legs[0].angle))
        for previous, following in zip(trip.leg_intervals, trip.leg_intervals[1:]):
            self.assertAlmostEqual(following[0] - previous[1], 1.3)

    def test_physical_clock_continuity_and_layover(self):
        trip = trip_from_dict(sample())
        self.assertEqual(trip.travel_time(-1), trip.legs[0].depart)
        self.assertEqual(trip.travel_time(100), trip.legs[-1].arrive)
        for index, (start, end) in enumerate(trip.leg_intervals):
            self.assertEqual(trip.travel_time(start), trip.legs[index].depart)
            self.assertEqual(trip.travel_time(end), trip.legs[index].arrive)
            self.assertEqual(trip.active_leg(start), index)
        first_end, next_start = trip.leg_intervals[0][1], trip.leg_intervals[1][0]
        mid = (first_end + next_start) / 2
        expected = trip.legs[0].arrive + (trip.legs[1].depart - trip.legs[0].arrive) / 2
        self.assertLess(abs((trip.travel_time(mid) - expected).total_seconds()), 0.00001)
        self.assertEqual(trip.active_leg(mid), 0)
        times = [trip.travel_time(i / 30) for i in range(trip.frame_count)]
        self.assertTrue(all(a <= b for a, b in zip(times, times[1:])))

    def test_weather_animates_holds_without_changing_physical_clock(self):
        trip = trip_from_dict(sample())
        self.assertEqual(trip.weather_time(0), trip.legs[0].depart - timedelta(minutes=20))
        self.assertEqual(trip.weather_time(trip.duration_s), trip.legs[-1].arrive + timedelta(minutes=20))
        self.assertLess(trip.weather_time(0), trip.weather_time(0.8))
        self.assertEqual(trip.travel_time(0), trip.travel_time(0.8))
        self.assertLess(trip.weather_time(23), trip.weather_time(24))
        self.assertEqual(trip.travel_time(23), trip.travel_time(24))

    def test_explicit_weather_replay_only_remaps_weather(self):
        data = sample()
        actual = trip_from_dict(data)
        data["weather"] = {"mode": "illustrative_replay", "sample_start": "2020-05-01T00:00:00Z", "sample_end": "2020-05-02T00:00:00Z"}
        trip = trip_from_dict(data)
        self.assertEqual(trip.weather_time(0), datetime(2020, 5, 1, tzinfo=timezone.utc))
        self.assertEqual(trip.weather_time(24), datetime(2020, 5, 2, tzinfo=timezone.utc))
        self.assertEqual(trip.travel_time(10), actual.travel_time(10))
        data["weather"]["mode"] = "forecast"
        with self.assertRaisesRegex(TripError, "only valid for illustrative_replay"):
            trip_from_dict(data)

    def test_zero_holds_are_valid(self):
        data = sample()
        data["video"].update(departure_hold_s=0, arrival_hold_s=0, layover_hold_s=0)
        trip = trip_from_dict(data)
        self.assertEqual(trip.leg_intervals[0][0], 0)
        self.assertEqual(trip.leg_intervals[-1][1], 24)
        self.assertEqual(trip.weather_time(0), trip.travel_time(0))
        self.assertEqual(trip.weather_time(24), trip.travel_time(24))
        for index in range(1, len(trip.legs)):
            self.assertEqual(trip.travel_time(trip.leg_intervals[index][0]), trip.legs[index].depart)

    def test_repeat_airport_visits_keep_occurrences(self):
        data = sample()
        data["flights"] = data["flights"][:1] + [{"from": "SFO", "to": "ORD", "departure": "2031-01-06T10:00:00-08:00", "arrival": "2031-01-06T16:00:00-06:00", "aircraft": "757-300"}]
        trip = trip_from_dict(data)
        self.assertEqual([a.code for a in trip.airport_sequence], ["ORD", "SFO", "ORD"])
        self.assertEqual(len(trip.leg_intervals), 2)

    def test_dst_ambiguous_hour_accepts_either_correct_offset(self):
        data = sample()
        data["flights"] = [{"from": "ORD", "to": "SFO", "departure": "2030-11-03T01:30:00-05:00", "arrival": "2030-11-03T10:00:00-08:00", "aircraft": "a321neo"}]
        early = trip_from_dict(data)
        data["flights"][0]["departure"] = "2030-11-03T01:30:00-06:00"
        late = trip_from_dict(data)
        self.assertEqual(late.legs[0].depart - early.legs[0].depart, timedelta(hours=1))

    def test_dst_nonexistent_time_and_wrong_offset_rejected(self):
        data = sample()
        data["flights"] = [{"from": "ORD", "to": "SFO", "departure": "2030-03-10T02:30:00-06:00", "arrival": "2030-03-10T10:00:00-07:00", "aircraft": "a321neo"}]
        with self.assertRaisesRegex(TripError, "daylight-saving"):
            trip_from_dict(data)
        data["flights"][0]["departure"] = "2030-06-01T10:00:00-06:00"
        with self.assertRaisesRegex(TripError, "does not match"):
            trip_from_dict(data)

    def test_missing_offset_rejected(self):
        data = sample()
        data["flights"][0]["departure"] = "2031-01-05T10:00:00"
        with self.assertRaisesRegex(TripError, "explicit UTC offset"):
            trip_from_dict(data)

    def test_bad_chronology_and_disconnected_route_rejected(self):
        for key, value, message in [("arrival", "2031-01-05T07:00:00-08:00", "later than departure"), ("aircraft", "mysteryjet", "a321neo")]:
            data = sample()
            data["flights"][0][key] = value
            with self.subTest(key=key), self.assertRaisesRegex(TripError, message):
                trip_from_dict(data)
        data = sample()
        data["flights"][1]["departure"] = "2031-01-05T12:00:00-08:00"
        with self.assertRaisesRegex(TripError, "previous flight arrives"):
            trip_from_dict(data)
        data = sample()
        data["flights"][1]["from"] = "ORD"
        data["flights"][1]["departure"] = "2031-01-05T19:00:00-06:00"
        with self.assertRaisesRegex(TripError, "connected route"):
            trip_from_dict(data)

    def test_coincident_and_antipodal_routes_rejected(self):
        for lat, lon, message in [(41.9742, -87.9073, "coincident"), (-41.9742, 92.0927, "antipodal")]:
            data = sample()
            data["airports"]["SFO"].update(lat=lat, lon=lon)
            with self.subTest(message=message), self.assertRaisesRegex(TripError, message):
                trip_from_dict(data)

    def test_coordinates_and_settings_validate(self):
        for key, value in [("lat", float("nan")), ("lat", 91), ("lon", 181)]:
            data = sample()
            data["airports"]["ORD"][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(TripError):
                trip_from_dict(data)
        data = sample()
        data["video"]["duration_s"] = 6
        with self.assertRaisesRegex(TripError, "combined holds"):
            trip_from_dict(data)
        data = sample()
        data["video"]["fpx"] = 30
        with self.assertRaisesRegex(TripError, "Unknown video field"):
            trip_from_dict(data)

    def test_fingerprint_changes_for_date_and_style_but_not_dict_order(self):
        data = sample()
        trip = trip_from_dict(data)
        reversed_keys = dict(reversed(list(data.items())))
        reversed_keys["airports"] = dict(reversed(list(data["airports"].items())))
        self.assertEqual(trip.fingerprint, trip_from_dict(reversed_keys).fingerprint)
        changed = deepcopy(data)
        for leg in changed["flights"]:
            for key in ("departure", "arrival"):
                leg[key] = leg[key].replace("2031-", "2032-")
        self.assertNotEqual(trip.fingerprint, trip_from_dict(changed).fingerprint)
        changed = deepcopy(data)
        changed["style"]["relief_exaggeration"] = 1
        self.assertNotEqual(trip.fingerprint, trip_from_dict(changed).fingerprint)

    def test_normalized_roundtrip_and_derived_duration(self):
        data = sample()
        del data["video"]
        trip = trip_from_dict(data)
        self.assertAlmostEqual(trip.duration_s, 24.9)
        normalized = trip_from_dict(json.loads(json.dumps(trip.to_dict())))
        self.assertEqual(trip.fingerprint, normalized.fingerprint)
        self.assertEqual(trip.to_plan()["route"], ["ORD", "SFO", "AKL", "MEL"])

    def test_moonlight_range_roundtrip_and_cache_identity(self):
        data = sample()
        data.setdefault("style", {}).pop("moonlight", None)
        default = trip_from_dict(data)
        self.assertEqual(default.style["moonlight"], 4000.)
        fingerprints = {default.fingerprint}
        for gain in (0., 1., 20000.):
            with self.subTest(gain=gain):
                data["style"]["moonlight"] = gain
                trip = trip_from_dict(data)
                normalized = trip_from_dict(json.loads(json.dumps(trip.to_dict())))
                self.assertEqual(normalized.style["moonlight"], gain)
                self.assertEqual(normalized.fingerprint, trip.fingerprint)
                fingerprints.add(trip.fingerprint)
        self.assertEqual(len(fingerprints), 4)
        for invalid in (-1., float("nan"), 20000.01):
            data["style"]["moonlight"] = invalid
            with self.subTest(invalid=invalid), self.assertRaises(TripError):
                trip_from_dict(data)

    def test_legacy_cloud_moonlight_normalizes_to_shared_setting(self):
        data=sample()
        data['style']={'cloud_moonlight':123.}
        legacy=trip_from_dict(data)
        self.assertEqual(legacy.style['moonlight'],123.)
        self.assertNotIn('cloud_moonlight',legacy.to_dict()['style'])
        data['style']={'moonlight':123.}
        self.assertEqual(legacy.fingerprint,trip_from_dict(data).fingerprint)
        data['style']['cloud_moonlight']=124.
        with self.assertRaises(TripError):trip_from_dict(data)


if __name__ == "__main__":
    unittest.main()
