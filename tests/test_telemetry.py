"""Physical telemetry, gap disclosure and cumulative multi-leg route distance."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import math
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

SCRIPTS=Path(__file__).resolve().parents[1]/'skills/route-replay/scripts'
sys.path.insert(0,str(SCRIPTS))
import telemetry
from trip import trip_from_dict,TripError

START=datetime(2026,1,1,tzinfo=timezone.utc)


def itinerary(duration_s=20.,minutes=60,origin_lon=0.,destination_lon=2.):
    return {'schema_version':1,'title':'Synthetic telemetry fixture',
        'airports':{code:{'name':code,'lat':0.,'lon':lon,'timezone':'UTC'}
                    for code,lon in (('AAA',origin_lon),('BBB',destination_lon))},
        'flights':[{'from':'AAA','to':'BBB','departure':START.isoformat(),
                    'arrival':(START+timedelta(minutes=minutes)).isoformat(),'aircraft':'a321neo'}],
        'video':{'duration_s':duration_s,'fps':30,'departure_hold_s':2.,
                 'arrival_hold_s':2.,'layover_hold_s':1.},'weather':{'mode':'clear'}}


def track(data,rows,max_gap_s):
    data['flights'][0]['trajectory']={'source':'Synthetic test waypoints; not measured flights',
        'altitude_reference':'MSL','max_gap_s':max_gap_s,
        'points':[{'time':(START+timedelta(minutes=minute)).isoformat(),
                   'lat':0.,'lon':lon,'altitude_m':height} for minute,lon,height in rows]}
    return trip_from_dict(data)


def video_time(trip,index,physical_seconds):
    """Invert only the public editorial clock, without assuming linear video."""
    low,high=trip.leg_intervals[index]
    fraction=physical_seconds/(trip.legs[index].arrive-trip.legs[index].depart).total_seconds()
    for _ in range(60):
        middle=(low+high)/2
        if trip.progress(index,middle)<fraction:low=middle
        else:high=middle
    return (low+high)/2


class TelemetryTests(unittest.TestCase):
    def test_untracked_flight_discloses_estimates_and_never_invents_airport_msl(self):
        trip=trip_from_dict(itinerary())
        mid=telemetry.sample(trip,video_time(trip,0,1800))
        distance=math.radians(2)*telemetry.EARTH_RADIUS_M
        self.assertEqual(mid['phase'],'flight');self.assertEqual(mid['mode'],'illustrative')
        self.assertAlmostEqual(mid['distance_m'],distance/2,places=6)
        self.assertAlmostEqual(mid['ground_speed_mps'],distance/3600,places=9)
        self.assertAlmostEqual(mid['altitude_m'],11000,places=8)
        self.assertEqual(mid['distance_basis'],'estimated')
        self.assertEqual(mid['speed_basis'],'estimated');self.assertEqual(mid['altitude_basis'],'illustrative')
        for t,phase in ((-1,'departure_hold'),(0,'departure_hold'),(20,'arrival_hold'),(100,'arrival_hold')):
            state=telemetry.sample(trip,t)
            self.assertEqual(state['phase'],phase);self.assertEqual(state['mode'],'hold')
            self.assertEqual(state['ground_speed_mps'],0);self.assertIsNone(state['altitude_m'])
        self.assertAlmostEqual(telemetry.sample(trip,20)['distance_m'],distance,places=6)
        self.assertIsNone(telemetry.sample(trip,trip.leg_intervals[0][0])['altitude_m'])
        for invalid in (float('nan'),float('inf'),True,'1'):
            with self.assertRaises(TripError):telemetry.sample(trip,invalid)

    def test_speed_is_independent_of_video_duration_and_easing(self):
        short=trip_from_dict(itinerary(20));long=trip_from_dict(itinerary(200))
        for seconds in (100.,900.,1800.,3000.):
            a=telemetry.sample(short,video_time(short,0,seconds))
            b=telemetry.sample(long,video_time(long,0,seconds))
            for key in ('distance_m','ground_speed_mps','altitude_m'):
                self.assertAlmostEqual(a[key],b[key],places=6)
            self.assertAlmostEqual(a['ground_speed_mps'],math.radians(2)*telemetry.EARTH_RADIUS_M/3600)

    def test_tracked_antimeridian_distance_altitude_and_physical_speed(self):
        trip=track(itinerary(minutes=20,origin_lon=179,destination_lon=-179),
                   [(0,179,125),(10,180,11000),(20,-179,140)],600)
        between=telemetry.sample(trip,video_time(trip,0,300))
        self.assertEqual(between['mode'],'interpolated')
        self.assertEqual(between['distance_basis'],'interpolated')
        self.assertAlmostEqual(between['altitude_m'],5562.5)
        expected=math.radians(1)*telemetry.EARTH_RADIUS_M/600
        self.assertAlmostEqual(between['ground_speed_mps'],expected)
        observed=telemetry.sample(trip,video_time(trip,0,600))
        self.assertEqual(observed['mode'],'observed');self.assertEqual(observed['altitude_m'],11000)
        self.assertAlmostEqual(observed['ground_speed_mps'],expected)
        self.assertEqual(telemetry.sample(trip,0)['altitude_m'],125)
        end=telemetry.sample(trip,20)
        self.assertEqual(end['altitude_m'],140);self.assertEqual(end['ground_speed_mps'],0)
        self.assertAlmostEqual(end['distance_m'],math.radians(2)*telemetry.EARTH_RADIUS_M)

    def test_long_gap_has_no_speed_or_altitude_but_exact_observation_is_retained(self):
        trip=track(itinerary(),[(0,0,120),(60,2,140)],300)
        state=telemetry.sample(trip,video_time(trip,0,1800))
        self.assertEqual(state['mode'],'gap');self.assertEqual(state['distance_basis'],'estimated')
        self.assertIsNone(state['ground_speed_mps']);self.assertIsNone(state['altitude_m'])
        first=telemetry.sample(trip,trip.leg_intervals[0][0])
        self.assertEqual(first['mode'],'observed');self.assertEqual(first['altitude_m'],120)
        self.assertIsNone(first['ground_speed_mps'])
        self.assertEqual(first['speed_basis'],'unavailable')

    def test_unobserved_terminals_are_gaps_and_estimation_persists_in_total_distance(self):
        trip=track(itinerary(),[(10,.3,5000),(20,.6,10000)],600)
        for seconds in (300,1800):
            state=telemetry.sample(trip,video_time(trip,0,seconds))
            self.assertEqual(state['mode'],'gap');self.assertIsNone(state['altitude_m'])
            self.assertIsNone(state['ground_speed_mps'])
        middle=telemetry.sample(trip,video_time(trip,0,900))
        self.assertEqual(middle['mode'],'interpolated');self.assertEqual(middle['altitude_m'],7500)
        self.assertEqual(middle['distance_basis'],'estimated')
        self.assertIsNone(telemetry.sample(trip,0)['altitude_m'])
        self.assertIsNone(telemetry.sample(trip,20)['altitude_m'])

    def test_stationary_samples_and_valid_neighbors_do_not_borrow_gap_speed(self):
        trip=track(itinerary(minutes=30),[(0,0,100),(5,0,100),(10,.5,9000),(30,2,100)],300)
        stopped=telemetry.sample(trip,video_time(trip,0,150))
        self.assertEqual(stopped['ground_speed_mps'],0)
        observed=telemetry.sample(trip,video_time(trip,0,600))
        self.assertEqual(observed['mode'],'observed')
        self.assertAlmostEqual(observed['ground_speed_mps'],math.radians(.5)*telemetry.EARTH_RADIUS_M/300)
        gap=telemetry.sample(trip,video_time(trip,0,900))
        self.assertIsNone(gap['ground_speed_mps'])

    def test_no_instant_airport_connector_when_observation_owns_departure(self):
        trip=track(itinerary(),[(0,.1,100),(60,1.9,150)],3600)
        self.assertEqual(telemetry.sample(trip,0)['distance_m'],0)
        self.assertAlmostEqual(telemetry.sample(trip,20)['distance_m'],math.radians(1.8)*telemetry.EARTH_RADIUS_M)

    def test_four_legs_long_layovers_and_zero_duration_connection(self):
        data=itinerary(duration_s=40)
        codes=('AAA','BBB','CCC','DDD','EEE')
        data['airports']={code:{'name':code,'lat':0,'lon':i*2,'timezone':'UTC'} for i,code in enumerate(codes)}
        data['flights']=[{'from':codes[i],'to':codes[i+1],
            'departure':(START+timedelta(days=2*i)).isoformat(),
            'arrival':(START+timedelta(days=2*i,hours=1)).isoformat(),'aircraft':'a321neo'} for i in range(4)]
        trip=trip_from_dict(data);leg_distance=math.radians(2)*telemetry.EARTH_RADIUS_M
        for i in range(4):
            state=telemetry.sample(trip,video_time(trip,i,1800))
            self.assertEqual(state['leg_index'],i)
            self.assertAlmostEqual(state['distance_m'],(i+.5)*leg_distance,places=5)
            if i<3:
                end=trip.leg_intervals[i][1];start=trip.leg_intervals[i+1][0]
                held=telemetry.sample(trip,(end+start)/2)
                self.assertEqual(held['phase'],'layover');self.assertEqual(held['ground_speed_mps'],0)
                self.assertIsNone(held['altitude_m'])
                self.assertAlmostEqual(held['distance_m'],(i+1)*leg_distance,places=5)
        self.assertAlmostEqual(telemetry.sample(trip,40)['distance_m'],4*leg_distance,places=5)
        data['video']['layover_hold_s']=0
        cut=trip_from_dict(data);boundary=cut.leg_intervals[1][0]
        state=telemetry.sample(cut,boundary)
        self.assertEqual(state['leg_index'],1);self.assertEqual(state['phase'],'flight')
        self.assertEqual(state['physical_time'],cut.legs[1].depart.isoformat().replace('+00:00','Z'))
        self.assertAlmostEqual(state['distance_m'],leg_distance,places=5)

    def test_layover_retains_only_observed_arrival_altitude(self):
        data=itinerary(duration_s=30)
        data['flights'].append({'from':'BBB','to':'AAA',
            'departure':(START+timedelta(days=2)).isoformat(),
            'arrival':(START+timedelta(days=2,hours=1)).isoformat(),'aircraft':'a321neo'})
        trip=track(data,[(0,0,250),(60,2,350)],3600)
        end=trip.leg_intervals[0][1];start=trip.leg_intervals[1][0]
        state=telemetry.sample(trip,(end+start)/2)
        self.assertEqual(state['phase'],'layover');self.assertEqual(state['ground_speed_mps'],0)
        self.assertEqual(state['altitude_m'],350);self.assertEqual(state['altitude_basis'],'observed')
        self.assertEqual(state['distance_basis'],'interpolated')
        departing=telemetry.sample(trip,start)
        self.assertEqual(departing['mode'],'illustrative')
        self.assertIsNone(departing['altitude_m'])

    def test_repeated_frames_use_cached_route_lengths(self):
        trip=track(itinerary(),[(0,0,100),(20,.5,10000),(40,1.5,10000),(60,2,100)],1200)
        telemetry.sample(trip,0)
        with patch.object(telemetry,'angular_distance',side_effect=AssertionError('route rescanned')):
            values=[telemetry.sample(trip,t/10)['distance_m'] for t in range(201)]
        self.assertTrue(all(a<=b for a,b in zip(values,values[1:])))

    def test_weather_replay_never_changes_telemetry(self):
        data=itinerary();actual=trip_from_dict(data)
        data=deepcopy(data);data['weather']={'mode':'illustrative_replay',
            'sample_start':'2020-01-01T00:00:00Z','sample_end':'2020-01-02T00:00:00Z'}
        replay=trip_from_dict(data)
        for t in (0,5,10,15,20):self.assertEqual(telemetry.sample(actual,t),telemetry.sample(replay,t))


if __name__=='__main__':unittest.main()
