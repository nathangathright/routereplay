"""Recorded paths preserve input evidence and disclose gaps; no data bundle needed."""
from copy import deepcopy
from datetime import datetime,timedelta,timezone
import json
from pathlib import Path
import sys
import tempfile
import unittest
import numpy as np
SCRIPTS=Path(__file__).resolve().parents[1]/'skills/cinematic-flight-videos/scripts'
sys.path[:0]=[str(SCRIPTS),str(SCRIPTS/'engine')]
from trip import load_trip,trip_from_dict,TripError
from motion import Motion,unit,slerp
from trajectory import read_csv
from frame_context import context_at


def recorded():
    data=load_trip(SCRIPTS.parent/'examples/sample-three-leg.json').to_dict()
    data['flights']=data['flights'][:1]
    leg=data['flights'][0]
    depart=datetime.fromisoformat(leg['departure']).astimezone(timezone.utc)
    arrive=datetime.fromisoformat(leg['arrival']).astimezone(timezone.utc)
    points=[]
    for p,lat,lon,alt in [(0,41.9742,-87.9073,210),(.25,45,-98,7000),(.5,46,-108,11000),(.75,42,-118,8000),(1,37.6213,-122.379,4)]:
        points.append({'time':(depart+(arrive-depart)*p).isoformat(),'lat':lat,'lon':lon,'altitude_m':alt})
    leg['trajectory']={'source':'Synthetic fixture; not a recorded flight','altitude_reference':'MSL','max_gap_s':7200,'points':points}
    return data


class TrajectoryTests(unittest.TestCase):
    def test_waypoints_and_altitudes_preserved(self):
        trip=trip_from_dict(recorded());motion=Motion(trip)
        leg=trip.legs[0]
        for point in leg.trajectory.points:
            p=(point.time-leg.depart)/(leg.arrive-leg.depart)
            state=motion.trajectory_state(0,p)
            np.testing.assert_allclose(state['position'],unit(point.lat,point.lon),atol=1e-12)
            self.assertEqual(state['altitude_m'],point.altitude_m)
            self.assertTrue(state['observed'])
        self.assertEqual(trip.fingerprint,trip_from_dict(trip.to_dict()).fingerprint)

    def test_recorded_turn_differs_from_great_circle(self):
        trip=trip_from_dict(recorded());motion=Motion(trip)
        point=motion.route_position(0,.5)
        self.assertGreater(np.linalg.norm(point-slerp(motion.vectors[0],motion.vectors[1],.5)),.03)
        self.assertGreater(abs(motion.route_heading(0,.2)-motion.route_heading(0,.7)),10)

    def test_gap_is_explicit_and_interpolation_stays_finite(self):
        data=recorded();data['flights'][0]['trajectory']['max_gap_s']=60
        trip=trip_from_dict(data);motion=Motion(trip)
        self.assertEqual(len(trip.to_plan()['flights'][0]['trajectory_gaps']),4)
        state=motion.trajectory_state(0,.3)
        self.assertEqual(state['mode'],'gap_interpolation')
        self.assertTrue(np.isfinite(state['position']).all())

    def test_missing_takeoff_and_landing_are_declared(self):
        data=recorded();data['flights'][0]['trajectory']['points']=data['flights'][0]['trajectory']['points'][1:-1]
        trip=trip_from_dict(data);motion=Motion(trip)
        gaps=trip.to_plan()['flights'][0]['trajectory_gaps']
        self.assertEqual([g['reason'] for g in gaps],['before_first_observation','after_last_observation'])
        np.testing.assert_allclose(motion.route_position(0,0),motion.vectors[0])
        np.testing.assert_allclose(motion.route_position(0,1),motion.vectors[1])

    def test_bad_observations_rejected(self):
        for mutate in [lambda rows:rows.reverse(),lambda rows:rows[1].update(time=rows[0]['time']),
                       lambda rows:rows[1].update(lat=float('nan')),lambda rows:rows[1].update(altitude_m=35000),
                       lambda rows:rows[1].update(time='2031-01-05T12:00:00')]:
            data=recorded();mutate(data['flights'][0]['trajectory']['points'])
            with self.assertRaises(TripError):trip_from_dict(data)
        data=recorded();data['flights'][0]['trajectory']['altitude_reference']='pressure_feet'
        with self.assertRaisesRegex(TripError,'MSL'):trip_from_dict(data)

    def test_same_position_samples_do_not_produce_nan(self):
        data=recorded();rows=data['flights'][0]['trajectory']['points']
        rows[2].update(lat=rows[1]['lat'],lon=rows[1]['lon'])
        motion=Motion(trip_from_dict(data))
        self.assertTrue(np.isfinite(motion.route_heading(0,.35)))
        self.assertAlmostEqual(np.linalg.norm(motion.route_position(0,.35)),1)

    def test_csv_requires_units_and_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'track.csv'
            path.write_text('time,lat,lon,altitude_m\n2030-01-01T00:00:00Z,1,179,100\n2030-01-01T00:10:00Z,2,-179,3000\n')
            result=read_csv(path,'Synthetic CSV')
            self.assertEqual(result['points'][1]['altitude_m'],3000)
            with self.assertRaisesRegex(ValueError,'source'):read_csv(path,'')

    def test_physical_and_rendered_altitude_are_separate(self):
        trip=trip_from_dict(recorded());motion=Motion(trip)
        middle=sum(trip.leg_intervals[0])/2
        class Ground:
            def sample(self,position):return 500.
        ctx=context_at(motion,middle,Ground())
        self.assertAlmostEqual(ctx.aircraft_altitude_m,11000)
        self.assertAlmostEqual(ctx.rendered_altitude_m,132000)
        self.assertAlmostEqual(ctx.to_dict()['terrain_clearance_m'],10500)

    def test_csv_short_extra_and_blank_rows_have_actionable_errors(self):
        import subprocess
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'track.csv'
            for row in ['2030-01-01T00:00:00Z,1,2',
                        '2030-01-01T00:00:00Z,1,2,100,extra',
                        '2030-01-01T00:00:00Z,1,2,',
                        '2030-01-01T00:00:00Z,north,2,100']:
                path.write_text('time,lat,lon,altitude_m\n'+row+'\n')
                with self.assertRaisesRegex(ValueError,'CSV row 2'):
                    read_csv(path,'Synthetic malformed CSV')
                result=subprocess.run([sys.executable,str(SCRIPTS/'trajectory.py'),str(path),
                                       '--source','Synthetic malformed CSV'],capture_output=True,text=True)
                self.assertEqual(result.returncode,2)
                self.assertIn('CSV row 2',result.stderr)
                self.assertNotIn('Traceback',result.stderr)

    def test_fingerprint_contains_track_coordinates(self):
        data=recorded();one=trip_from_dict(data)
        data['flights'][0]['trajectory']['points'][2]['lat']+=1
        self.assertNotEqual(one.fingerprint,trip_from_dict(data).fingerprint)

if __name__=='__main__':unittest.main()
