"""Editorial pacing changes one shared clock without changing itinerary timing."""
from copy import deepcopy
from dataclasses import replace
from datetime import datetime,timedelta,timezone
import json
import math
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

SCRIPTS=Path(__file__).resolve().parents[1]/'skills/cinematic-flight-videos/scripts'
sys.path.insert(0,str(SCRIPTS))
import pacing
from trajectory import Trajectory,Waypoint
from trip import load_trip,trip_from_dict,WEATHER_HOLD_MINUTES


def leg_fixture(rows=None,duration=600,max_gap=100):
    leg=load_trip(SCRIPTS.parent/'examples/sample-three-leg.json').legs[0]
    start=datetime(2031,1,5,16,tzinfo=timezone.utc)
    track=None if rows is None else Trajectory('Synthetic pacing fixture; not a recorded flight',max_gap,
        tuple(Waypoint(start+timedelta(seconds=t),lat,lon,alt) for t,lat,lon,alt in rows))
    return replace(leg,depart=start,arrive=start+timedelta(seconds=duration),trajectory=track)


def maneuver_leg():
    return leg_fixture([(0,0,0,0),(100,0,1,1500),(200,0,2,3000),(300,0,3,3000),
                        (400,1,3,3000),(500,2,3,1500),(600,3,3,0)])


def classic_inverse(p):
    low,high=0.,1.
    for _ in range(55):
        middle=(low+high)*.5
        if pacing._smooth(middle)<p:low=middle
        else:high=middle
    return (low+high)*.5


class PacingTests(unittest.TestCase):
    def test_monotone_bounded_forward_and_inverse(self):
        for leg in (leg_fixture(),maneuver_leg()):
            values=[pacing.progress(leg,i/2000) for i in range(2001)]
            self.assertEqual((values[0],values[-1]),(0.,1.))
            self.assertTrue(all(a<b for a,b in zip(values,values[1:])))
            for physical in (.00001,.01,.1,.2,.5,.8,.99,.99999):
                presentation=pacing.inverse_progress(leg,physical)
                self.assertAlmostEqual(pacing.progress(leg,presentation),physical,places=12)
            self.assertEqual(pacing.progress(leg,-5),0.)
            self.assertEqual(pacing.progress(leg,5),1.)
            self.assertEqual(pacing.inverse_progress(leg,-5),0.)
            self.assertEqual(pacing.inverse_progress(leg,5),1.)
        for value in (True,None,'0.1',float('inf'),float('nan')):
            with self.assertRaises(ValueError):pacing.progress(leg,value)
            with self.assertRaises(ValueError):pacing.inverse_progress(leg,value)

    def test_velocity_is_continuous_without_phase_boundary_stops(self):
        leg=maneuver_leg();compiled=pacing._compiled(leg);step=1e-7
        for physical in compiled.y[1:-1]:
            u=pacing.inverse_progress(leg,physical)
            center=pacing.progress(leg,u)
            left=(center-pacing.progress(leg,u-step))/step
            right=(pacing.progress(leg,u+step)-center)/step
            self.assertGreater(min(left,right),0)
            self.assertAlmostEqual(left,right,delta=2e-4)
        # Quintic easing yields vanishing endpoint velocity AND acceleration.
        step=1e-4
        for endpoint,direction in ((0,1),(1,-1)):
            a=pacing.progress(leg,endpoint)
            b=pacing.progress(leg,endpoint+direction*step)
            c=pacing.progress(leg,endpoint+direction*2*step)
            self.assertLess(abs((b-a)/step),1e-5)
            self.assertLess(abs((c-2*b+a)/step**2),.03)

    def test_untracked_endpoint_emphasis_is_honest_and_effective(self):
        leg=leg_fixture();report=pacing.plan(leg)
        self.assertEqual(report['basis'],'artistic_endpoint_emphasis_only')
        self.assertEqual(report['usable_coverage_fraction'],0)
        self.assertEqual([a['phase'] for a in report['anchors']],['departure_endpoint','arrival_endpoint'])
        self.assertTrue(all(a['basis']=='artistic_endpoint_emphasis' for a in report['anchors']))
        self.assertGreater(pacing.inverse_progress(leg,.1),classic_inverse(.1))
        self.assertGreater(1-pacing.inverse_progress(leg,.9),1-classic_inverse(.9))
        json.dumps(report,allow_nan=False)

    def test_supported_altitude_trends_and_turn_get_attention(self):
        leg=maneuver_leg();report=pacing.plan(leg)
        anchors=report['anchors']
        self.assertEqual(report['usable_coverage_fraction'],1)
        self.assertEqual({a['phase'] for a in anchors},{'departure_endpoint','arrival_endpoint','climb','descent','turn'})
        self.assertEqual([a['altitude_change_m'] for a in anchors if a['phase']=='climb'],[3000])
        self.assertEqual([a['altitude_change_m'] for a in anchors if a['phase']=='descent'],[-3000])
        turn=next(a for a in anchors if a['phase']=='turn')
        self.assertAlmostEqual(turn['turn_degrees'],90,places=8)
        self.assertEqual(turn['physical_center'],.5)
        straight=replace(leg,trajectory=replace(leg.trajectory,points=tuple(
            replace(p,lat=0,lon=index) for index,p in enumerate(leg.trajectory.points))))
        turn_time=pacing.inverse_progress(leg,.6)-pacing.inverse_progress(leg,.4)
        straight_time=pacing.inverse_progress(straight,.6)-pacing.inverse_progress(straight,.4)
        self.assertGreater(turn_time,straight_time)
        self.assertIn('Synthetic pacing fixture',report['source'])

    def test_gaps_exclude_cues_and_exact_threshold_is_contiguous(self):
        rows=[(0,0,0,0),(100,0,1,1000),(500,0,20,1000),(600,0,21,0)]
        leg=leg_fixture(rows);report=pacing.plan(leg)
        self.assertAlmostEqual(report['usable_coverage_fraction'],1/3)
        self.assertEqual(report['uncovered_intervals'],[{'physical_start':1/6,'physical_end':5/6}])
        observed=[a for a in report['anchors'] if a['basis']!='artistic_endpoint_emphasis']
        self.assertEqual({a['phase'] for a in observed},{'climb','descent'})
        for cue in observed:
            self.assertTrue(cue['physical_end']<=1/6 or cue['physical_start']>=5/6)
        sparse=pacing.plan(replace(leg,trajectory=replace(leg.trajectory,max_gap_s=99.999)))
        self.assertEqual(sparse['usable_coverage_fraction'],0)
        self.assertEqual(sparse['basis'],'artistic_endpoint_emphasis_only')

    def test_missing_endpoints_and_singleton_observations_are_not_detected_phases(self):
        leg=leg_fixture([(50,0,0,0),(150,0,1,1000),(400,10,10,2000)],max_gap=100)
        report=pacing.plan(leg)
        self.assertEqual(report['uncovered_intervals'],[
            {'physical_start':0.,'physical_end':50/600},
            {'physical_start':150/600,'physical_end':1.}])
        self.assertEqual([a['phase'] for a in report['anchors'] if a['basis']!='artistic_endpoint_emphasis'],['climb'])
        self.assertNotIn('takeoff',[a['phase'] for a in report['anchors']])

    def test_exact_observation_does_not_consult_next_gapped_segment(self):
        # The helper must return an endpoint directly, even when the next sample
        # lies across a gap and would have an ambiguous spherical interpolation.
        points=((0.,pacing._vector(0,0),0.),(100.,pacing._vector(0,1),1000.),
                (500.,pacing._vector(0,-179),1000.),(600.,pacing._vector(0,-178),0.))
        self.assertEqual(pacing._interpolate(tuple(p[0] for p in points),points,100.),(points[1][1],1000.))

    def test_dateline_straight_and_stationary_tracks_do_not_create_turns(self):
        for coordinates in ([(0,178),(0,179),(0,180),(0,-179),(0,-178)],[(50,150)]*5):
            leg=leg_fixture([(i*100,lat,lon,3000) for i,(lat,lon) in enumerate(coordinates)],duration=400)
            self.assertEqual(len(pacing.plan(leg)['anchors']),2)
            self.assertTrue(all(math.isfinite(pacing.progress(leg,i/100)) for i in range(101)))
        turn=leg_fixture([(0,0,179,3000),(100,0,180,3000),(200,1,-180,3000)],duration=200)
        self.assertAlmostEqual(next(a['turn_degrees'] for a in pacing.plan(turn)['anchors'] if a['phase']=='turn'),90)

    def test_short_flight_and_too_short_observed_change_use_endpoint_fallback(self):
        leg=leg_fixture([(0,0,0,0),(5,0,.01,1000),(10,0,.02,0)],duration=10,max_gap=5)
        self.assertEqual(len(pacing.plan(leg)['anchors']),2)
        values=[pacing.progress(leg,i/100) for i in range(101)]
        self.assertTrue(all(a<b for a,b in zip(values,values[1:])))

    def test_portable_storytelling_example_has_supported_cues(self):
        trip=load_trip(SCRIPTS.parent/'examples/sample-storytelling.json')
        report=pacing.plan(trip.legs[0])
        self.assertEqual(trip.pacing,'highlights')
        self.assertTrue(trip.attitude['enabled'])
        self.assertTrue(trip.telemetry['enabled'])
        self.assertEqual(report['usable_coverage_fraction'],1)
        self.assertEqual(report['physical_duration_s'],900)
        self.assertIn('Entirely synthetic',report['source'])
        self.assertEqual({a['phase'] for a in report['anchors']},
                         {'departure_endpoint','arrival_endpoint','climb','descent','turn'})

    def test_cache_is_bounded_identity_safe_and_reports_are_fresh(self):
        leg=maneuver_leg();reference=pacing.plan(leg)
        reference['anchors'][0]['physical_start']=-1
        with patch.object(pacing,'_compile',side_effect=AssertionError('Unexpected recompilation')):
            self.assertEqual(pacing.plan(leg)['anchors'][0]['physical_start'],0.)
            for u in (.9,.1,.5,.9):self.assertEqual(pacing.progress(leg,u),pacing.progress(leg,u))
        changed=replace(leg,trajectory=None)
        self.assertNotEqual(pacing.plan(leg)['basis'],pacing.plan(changed)['basis'])
        for index in range(pacing.CACHE_SIZE+5):pacing.progress(replace(leg,aircraft=str(index)),.5)
        self.assertEqual(len(pacing._CACHE),pacing.CACHE_SIZE)
        self.assertEqual(pacing.plan(leg)['anchors'][0]['physical_start'],0.)

    def test_coincident_cue_knots_have_no_zero_width_intervals(self):
        # At 1200 seconds, a turn window begins at .18, also an endpoint cue edge.
        leg=leg_fixture([(0,0,0,0),(216,0,1,1000),(276,0,2,1000),
                         (336,1,2,1000),(1200,2,2,0)],duration=1200,max_gap=1000)
        compiled=pacing._compiled(leg)
        self.assertTrue(all(a<b for a,b in zip(compiled.x,compiled.x[1:])))
        self.assertTrue(all(a<b for a,b in zip(compiled.y,compiled.y[1:])))
        self.assertTrue(math.isfinite(pacing.progress(leg,.4)))

    def test_three_and_four_leg_intervals_holds_and_clocks_are_preserved(self):
        for example,count in [('sample-three-leg.json',3),('sample-four-stop.json',4)]:
            data=load_trip(SCRIPTS.parent/'examples'/example).to_dict()
            data['flights']=data['flights'][:count]
            data['video'].pop('layover_holds_s',None)
            original=deepcopy(data);classic=trip_from_dict(data)
            data['video']['pacing']='highlights';highlights=trip_from_dict(data)
            self.assertEqual(highlights.leg_intervals,classic.leg_intervals)
            self.assertEqual(highlights.duration_s,classic.duration_s)
            self.assertEqual(highlights.layover_holds_s,classic.layover_holds_s)
            holds=[(0,highlights.leg_intervals[0][0]),(highlights.leg_intervals[-1][1],highlights.duration_s)]
            holds.extend((a[1],b[0]) for a,b in zip(highlights.leg_intervals,highlights.leg_intervals[1:]))
            for start,end in holds:
                for p in (0,.25,.5,.75,1):
                    t=start+(end-start)*p
                    self.assertEqual(highlights.travel_time(t),classic.travel_time(t))
                    self.assertEqual(highlights.weather_time(t),classic.weather_time(t))
            for index,((start,end),leg) in enumerate(zip(highlights.leg_intervals,highlights.legs)):
                for u in (0,.13,.41,.77,1):
                    t=start+(end-start)*u;p=pacing.progress(leg,u)
                    self.assertAlmostEqual(highlights.progress(index,t),p)
                    expected=leg.depart+(leg.arrive-leg.depart)*p
                    self.assertLess(abs((highlights.travel_time(t)-expected).total_seconds()),1e-5)
                    self.assertEqual(highlights.weather_time(t),highlights.travel_time(t))
            self.assertEqual(original['flights'],data['flights'])
            self.assertEqual(highlights.fingerprint,trip_from_dict(highlights.to_dict()).fingerprint)

    def test_inverse_physical_instant_is_independent_of_film_duration(self):
        data=load_trip(SCRIPTS.parent/'examples/sample-three-leg.json').to_dict()
        data['video']['pacing']='highlights'
        short=trip_from_dict(data);data['video']['duration_s']*=2;long=trip_from_dict(data)
        for index,leg in enumerate(short.legs):
            for physical in (0,.01,.25,.5,.93,1):
                instant=leg.depart+(leg.arrive-leg.depart)*physical
                normalized=[]
                for trip in (short,long):
                    t=trip.presentation_time(instant,index);start,end=trip.leg_intervals[index]
                    normalized.append((t-start)/(end-start))
                    self.assertLess(abs((trip.travel_time(t)-instant).total_seconds()),1e-5)
                self.assertAlmostEqual(*normalized,places=12)

    def test_illustrative_weather_replay_uses_same_highlight_physical_clock(self):
        data=load_trip(SCRIPTS.parent/'examples/sample-three-leg.json').to_dict()
        data['video']['pacing']='highlights'
        data['weather']={'mode':'illustrative_replay','sample_start':'2023-11-01T00:00:00Z',
                         'sample_end':'2023-11-03T00:00:00Z'}
        trip=trip_from_dict(data)
        physical_first=trip.legs[0].depart-timedelta(minutes=WEATHER_HOLD_MINUTES)
        physical_last=trip.legs[-1].arrive+timedelta(minutes=WEATHER_HOLD_MINUTES)
        sample_first=datetime(2023,11,1,tzinfo=timezone.utc)
        sample_last=datetime(2023,11,3,tzinfo=timezone.utc)
        for start,end in trip.leg_intervals:
            t=start+(end-start)*.32
            fraction=(trip.travel_time(t)-physical_first)/(physical_last-physical_first)
            expected=sample_first+(sample_last-sample_first)*fraction
            self.assertLess(abs((trip.weather_time(t)-expected).total_seconds()),1e-5)


if __name__=='__main__':unittest.main()
