"""Modeled physical-clock attitude, spherical geometry and pose cache contracts."""
import ast
from copy import deepcopy
from datetime import datetime,timedelta,timezone
import importlib.util
import math
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import numpy as np

SCRIPTS=Path(__file__).resolve().parents[1]/'skills/cinematic-flight-videos/scripts'
ENGINE=SCRIPTS/'engine'
sys.path[:0]=[str(SCRIPTS),str(ENGINE)]
from trip import trip_from_dict,load_trip
from motion import Motion,unit,slerp
from frame_context import context_at

START=datetime(2026,1,1,tzinfo=timezone.utc)
DEFAULT={'enabled':True,'strength':1.,'max_bank_deg':25.,'max_pitch_deg':12.}


def itinerary(rows,*,gap=400.,video_duration=20.,attitude=True):
    data={'schema_version':1,'title':'Synthetic attitude fixture',
        'airports':{code:{'name':code,'lat':row[1],'lon':row[2],'timezone':'UTC'}
                    for code,row in (('AAA',rows[0]),('BBB',rows[-1]))},
        'flights':[{'from':'AAA','to':'BBB','departure':START.isoformat(),
            'arrival':(START+timedelta(seconds=rows[-1][0])).isoformat(),'aircraft':'a321neo',
            'trajectory':{'source':'Synthetic attitude test track','altitude_reference':'MSL',
                'max_gap_s':gap,'points':[{'time':(START+timedelta(seconds=s)).isoformat(),
                    'lat':lat,'lon':lon,'altitude_m':height} for s,lat,lon,height in rows]}}],
        'video':{'duration_s':video_duration,'fps':30,'departure_hold_s':2.,
                 'arrival_hold_s':2.,'layover_hold_s':1.},'weather':{'mode':'clear'}}
    if attitude:data['attitude']=DEFAULT.copy()
    return data


def at_seconds(trip,seconds,index=0):
    low,high=trip.leg_intervals[index]
    fraction=seconds/(trip.legs[index].arrive-trip.legs[index].depart).total_seconds()
    for _ in range(60):
        middle=(low+high)/2
        if trip.progress(index,middle)<fraction:low=middle
        else:high=middle
    return (low+high)/2


def aircraft_module():
    spec=importlib.util.spec_from_file_location('attitude_aircraft_test',ENGINE/'aircraft.py')
    module=importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules,{'runtime':SimpleNamespace(AIRCRAFT_DIR=Path('/unused'),
            AIRCRAFT_MODE='diagram'),spec.name:module}):
        spec.loader.exec_module(module)
    return module


class AircraftAttitudeTests(unittest.TestCase):
    def test_right_and_left_turns_have_correct_bank_sign_and_smooth_cap(self):
        for sign in (-1,1):
            data=itinerary([(0,-.2,0,10000),(300,0,0,10000),(600,0,sign*.2,10000)])
            trip=trip_from_dict(data);motion=Motion(trip)
            pose=motion.attitude(at_seconds(trip,300))
            # Sparse five-minute observations support a broad, conservative turn.
            self.assertGreater(sign*pose['bank_deg'],1.)
            self.assertLess(abs(pose['bank_deg']),25.)
            self.assertAlmostEqual(pose['pitch_deg'],0,places=9)
            self.assertEqual(pose['mode'],'modeled_trajectory')
            before=motion.attitude(at_seconds(trip,299.99))
            after=motion.attitude(at_seconds(trip,300.01))
            self.assertLess(abs(before['bank_deg']-after['bank_deg']),.1)

    def test_climb_descent_follow_physical_altitude_slope(self):
        trip=trip_from_dict(itinerary([(0,0,0,100),(300,0,1,11000),(600,0,2,100)]))
        motion=Motion(trip)
        up=motion.attitude(at_seconds(trip,150));down=motion.attitude(at_seconds(trip,450))
        self.assertGreater(up['pitch_deg'],0);self.assertLess(down['pitch_deg'],0)
        self.assertAlmostEqual(up['pitch_deg'],-down['pitch_deg'],places=8)
        self.assertAlmostEqual(up['bank_deg'],0,places=8)
        self.assertLess(abs(up['pitch_deg']),12)

    def test_great_circle_never_banks_for_meridian_convergence_dateline_or_pole(self):
        for a,b in (((70,160),(75,-160)),((75,-90),(75,90)),((0,179),(0,-179))):
            rows=[]
            for index in range(5):
                point=slerp(unit(*a),unit(*b),index/4)
                rows.append((index*150,math.degrees(math.asin(np.clip(point[2],-1,1))),
                             math.degrees(math.atan2(point[1],point[0])),10000))
            trip=trip_from_dict(itinerary(rows,gap=150));motion=Motion(trip)
            for seconds in (75,150,225,300,375,450,525):
                with self.subTest(route=(a,b),seconds=seconds):
                    pose=motion.attitude(at_seconds(trip,seconds))
                    self.assertAlmostEqual(pose['bank_deg'],0,places=6)
                    self.assertAlmostEqual(pose['pitch_deg'],0,places=8)

    def test_video_speed_and_weather_replay_do_not_change_pose(self):
        rows=[(0,-.2,0,100),(300,0,0,10000),(600,0,.2,100)]
        first=trip_from_dict(itinerary(rows));data=itinerary(rows,video_duration=100)
        data['weather']={'mode':'illustrative_replay','sample_start':'2020-01-01T00:00:00Z',
                         'sample_end':'2020-01-02T00:00:00Z'}
        second=trip_from_dict(data);a,b=Motion(first),Motion(second)
        for seconds in (100,290,300,310,500):
            self.assertEqual(a.attitude(at_seconds(first,seconds)),b.attitude(at_seconds(second,seconds)))

    def test_gaps_stationary_intervals_and_all_holds_are_level(self):
        data=itinerary([(0,-.2,0,100),(60,-.2,0,100),(120,0,0,5000),
                        (600,0,.2,5000),(660,0,.3,100)],gap=120)
        trip=trip_from_dict(data);motion=Motion(trip)
        for seconds,mode in ((30,'stationary'),(300,'gap')):
            self.assertEqual(motion.attitude(at_seconds(trip,seconds)),
                             {'bank_deg':0.,'pitch_deg':0.,'mode':mode})
        # Fade toward either edge of the one supported, moving interval.
        near=motion.attitude(at_seconds(trip,60.1))
        center=motion.attitude(at_seconds(trip,90))
        self.assertLess(abs(near['pitch_deg']),abs(center['pitch_deg'])/1000)
        route=load_trip(SCRIPTS.parent/'examples/sample-three-leg.json').to_dict()
        route['attitude']=DEFAULT.copy();multi=trip_from_dict(route);motion=Motion(multi)
        times=[0.,multi.duration_s]
        times.extend((previous[1]+following[0])/2 for previous,following in zip(multi.leg_intervals,multi.leg_intervals[1:]))
        for t in times:
            self.assertEqual(motion.attitude(t),{'bank_deg':0.,'pitch_deg':0.,'mode':'hold'})

    def test_disabled_strength_and_caps_preserve_level_default(self):
        data=itinerary([(0,-.2,0,100),(300,0,0,10000),(600,0,.2,100)])
        for setting in (None,{'enabled':False},dict(DEFAULT,strength=0),dict(DEFAULT,max_bank_deg=0,max_pitch_deg=0)):
            configured=deepcopy(data)
            if setting is None:configured.pop('attitude')
            else:configured['attitude']=setting
            trip=trip_from_dict(configured);pose=Motion(trip).attitude(at_seconds(trip,300))
            self.assertEqual(pose['bank_deg'],0);self.assertEqual(pose['pitch_deg'],0)
        data['attitude'].update(strength=3,max_bank_deg=7,max_pitch_deg=3)
        trip=trip_from_dict(data);motion=Motion(trip)
        for seconds in (150,300,450):
            pose=motion.attitude(at_seconds(trip,seconds))
            self.assertLessEqual(abs(pose['bank_deg']),7);self.assertLessEqual(abs(pose['pitch_deg']),3)

    def test_untracked_great_circle_pitch_is_explicitly_illustrative(self):
        data=itinerary([(0,0,0,0),(600,0,2,0)]);data['flights'][0].pop('trajectory')
        trip=trip_from_dict(data);motion=Motion(trip)
        first=motion.attitude(at_seconds(trip,150));last=motion.attitude(at_seconds(trip,450))
        self.assertEqual(first['mode'],'illustrative');self.assertAlmostEqual(first['bank_deg'],0)
        self.assertGreater(first['pitch_deg'],0);self.assertLess(last['pitch_deg'],0)
        self.assertAlmostEqual(first['pitch_deg'],-last['pitch_deg'],places=8)

    def test_frame_context_exports_identical_pose(self):
        trip=trip_from_dict(itinerary([(0,-.2,0,10000),(300,0,0,10000),(600,0,.2,10000)]))
        motion=Motion(trip);t=at_seconds(trip,300);pose=motion.attitude(t)
        context=context_at(motion,t);record=context.to_dict()
        self.assertEqual(record['bank_deg'],pose['bank_deg'])
        self.assertEqual(record['pitch_deg'],pose['pitch_deg'])
        self.assertEqual(record['attitude_mode'],pose['mode'])

    def test_long_haul_waypoint_noise_does_not_alias_into_bank_impulses(self):
        rng=np.random.default_rng(3482)
        first,last=unit(37.6,-122.4),unit(-36.8,174.8)
        normal=np.cross(first,last);normal/=np.linalg.norm(normal)
        rows=[]
        for index in range(601):
            point=slerp(first,last,index/600)
            jitter=0. if index in (0,600) else rng.normal(0,1000)/6371000.
            point=point*math.cos(jitter)+normal*math.sin(jitter)
            rows.append((index*60,math.degrees(math.asin(point[2])),
                         math.degrees(math.atan2(point[1],point[0])),10000))
        trip=trip_from_dict(itinerary(rows,gap=60));motion=Motion(trip)
        start,end=trip.leg_intervals[0]
        banks=np.array([motion.attitude(t)['bank_deg'] for t in np.arange(start,end,1/trip.fps)])
        # The former +/-15s estimator peaks near 19 degrees and has 230 jumps
        # above 3 degrees on this deterministic 10h route / 20s film.
        self.assertLess(np.max(np.abs(banks)),1.5)
        self.assertLess(np.max(np.abs(np.diff(banks))),2.)
        slower=trip_from_dict(itinerary(rows,gap=60,video_duration=100));other=Motion(slower)
        for seconds in (300,1234,18000,28345,35700):
            self.assertEqual(motion.attitude(at_seconds(trip,seconds)),
                             other.attitude(at_seconds(slower,seconds)))

    def test_sustained_physical_turns_remain_visible_and_stable(self):
        # Geodesic stepping with a known clockwise turn rate. Both a short
        # maneuver and a long-haul turn must survive the physical-space fit.
        for duration,turn_length in ((1800,300),(36000,1200)):
            for sign in (-1,1):
                point=unit(0,0);tangent=np.array([0.,0.,1.]);rows=[]
                turn_start=(duration-turn_length)/2
                speed=220.;step=15.;angle=speed*step/6371000.
                rate=sign*math.pi/(2*turn_length)
                for index in range(int(duration/step)+1):
                    seconds=index*step
                    rows.append((seconds,math.degrees(math.asin(point[2])),
                                 math.degrees(math.atan2(point[1],point[0])),10000))
                    heading=rate*step if turn_start<=seconds<turn_start+turn_length else 0.
                    tangent=tangent*math.cos(heading/2)+np.cross(tangent,point)*math.sin(heading/2)
                    previous=point
                    point=point*math.cos(angle)+tangent*math.sin(angle)
                    tangent=tangent*math.cos(angle)-previous*math.sin(angle)
                    tangent=tangent*math.cos(heading/2)+np.cross(tangent,point)*math.sin(heading/2)
                    point/=np.linalg.norm(point);tangent/=np.linalg.norm(tangent)
                trip=trip_from_dict(itinerary(rows,gap=step));motion=Motion(trip)
                expected=25*math.tanh(math.degrees(math.atan(speed*rate/9.80665))/25)
                banks=[motion.attitude(at_seconds(trip,seconds))['bank_deg']
                       for seconds in np.linspace(duration/2-turn_length*.1,duration/2+turn_length*.1,9)]
                for bank in banks:self.assertAlmostEqual(bank,expected,delta=.15)
                self.assertLess(np.ptp(banks),.1)
                self.assertGreater(min(sign*bank for bank in banks),1.)

    def test_cache_angles_are_required_validated_and_survive_resampling(self):
        aircraft=aircraft_module()
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'frame.npz'
            fields=dict(schema_version=np.int32(2),radiance=np.ones((4,4,3)),
                alpha=np.ones((4,4,1)),depth=np.full((4,4),.5),model_camera_height_m=300.,
                ground_clearance_m=5.)
            np.savez_compressed(path,**fields)
            with self.assertRaisesRegex(ValueError,'rebuild with Cycles'):aircraft._cached_layer(str(path))
            np.savez_compressed(path,**fields,bank_deg=23.,pitch_deg=-7.)
            layer=aircraft._cached_layer(str(path));resized=aircraft._resize_layer(layer,(2,2))
            self.assertEqual((resized.bank_deg,resized.pitch_deg),(23.,-7.))
            bad=Path(temporary)/'bad.npz';np.savez_compressed(bad,**fields,bank_deg=float('nan'),pitch_deg=0.)
            with self.assertRaisesRegex(ValueError,'rebuild with Cycles'):aircraft._cached_layer(str(bad))

    def test_blender_pose_state_defaults_to_level_and_rejects_invalid_angles(self):
        path=ENGINE/'aircraft_blender.py'
        node=next(n for n in ast.parse(path.read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='attitude_state')
        scope={'math':math,'np':np}
        exec(compile(ast.Module(body=[node],type_ignores=[]),str(path),'exec'),scope)
        state=scope['attitude_state']
        self.assertEqual(state({}),(0.,0.))
        self.assertEqual(state({'bank_deg':25,'pitch_deg':-12}),(25.,-12.))
        for value in (float('nan'),float('inf'),90,-90,True,'3'):
            with self.assertRaises(ValueError):state({'bank_deg':value})


if __name__=='__main__':unittest.main()
