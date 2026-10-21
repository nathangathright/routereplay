"""Multi-stop, date-line, polar, repeated-city and long-layover regression matrix."""
from copy import deepcopy
from datetime import datetime,timedelta,timezone
import json
from pathlib import Path
import random
import sys
import unittest
from zoneinfo import ZoneInfo
import numpy as np
SCRIPTS=Path(__file__).resolve().parents[1]/'skills/route-replay/scripts'
sys.path[:0]=[str(SCRIPTS),str(SCRIPTS/'engine')]
from trip import trip_from_dict,load_trip,TripError
from motion import Motion
from labels import Labels
from frame_context import context_at
from flight_video import cache_key

AIRPORTS={
 'ORD':('Chicago',41.9742,-87.9073,'America/Chicago'),
 'SFO':('San Francisco',37.6213,-122.379,'America/Los_Angeles'),
 'AKL':('Auckland',-37.0082,174.785,'Pacific/Auckland'),
 'MEL':('Melbourne',-37.669,144.841,'Australia/Melbourne'),
 'LAX':('Los Angeles',33.9425,-118.408,'America/Los_Angeles'),
 'LHR':('London',51.47,-.4543,'Europe/London'),
 'HEL':('Helsinki',60.3172,24.9633,'Europe/Helsinki'),
 'NRT':('Tokyo',35.772,140.393,'Asia/Tokyo'),
 'ANC':('Anchorage',61.1743,-149.998,'America/Anchorage'),
 'SYD':('Sydney',-33.9399,151.1753,'Australia/Sydney'),
 'POA':('North pole synthetic A',89.95,-120,'UTC'),
 'POB':('North pole synthetic B',89.95,60,'UTC'),
}


def itinerary(route,begin=datetime(2030,11,1,18,tzinfo=timezone.utc),layover_hours=72,leg_hours=10):
    legs=[];cursor=begin
    types=['a321neo','777-200er','787-9','757-300']
    for i,(a,b) in enumerate(zip(route,route[1:])):
        arrival=cursor+timedelta(hours=leg_hours)
        legs.append({'from':a,'to':b,'departure':cursor.astimezone(ZoneInfo(AIRPORTS[a][3])).isoformat(),
                     'arrival':arrival.astimezone(ZoneInfo(AIRPORTS[b][3])).isoformat(),'aircraft':types[i%4]})
        cursor=arrival+timedelta(hours=layover_hours)
    return {'schema_version':1,'title':'Synthetic multi-stop validation',
            'airports':{a:dict(zip(('name','lat','lon','timezone'),AIRPORTS[a])) for a in set(route)},
            'flights':legs,'video':{'duration_s':30,'fps':12,'departure_hold_s':1,'arrival_hold_s':2,'layover_hold_s':2},
            'weather':{'mode':'clear'}}


class ItineraryEdgeTests(unittest.TestCase):
    def test_three_and_four_stop_routes_have_complete_chronology(self):
        for route in [('ORD','LHR','HEL','NRT','SFO'),('ORD','SFO','AKL','MEL','LAX','ORD')]:
            trip=trip_from_dict(itinerary(route));motion=Motion(trip)
            moments=[trip.travel_time(t) for t in np.linspace(0,trip.duration_s,601)]
            self.assertTrue(all(a<=b for a,b in zip(moments,moments[1:])))
            self.assertEqual(len(trip.legs),len(route)-1)
            self.assertEqual([a.code for a in trip.airport_sequence],list(route))
            for i,(start,end) in enumerate(trip.leg_intervals):
                self.assertEqual(trip.travel_time(start),trip.legs[i].depart)
                self.assertEqual(trip.travel_time(end),trip.legs[i].arrive)
                np.testing.assert_allclose(motion.camera(start)[2],motion.vectors[i],atol=1e-10)
                np.testing.assert_allclose(motion.camera(end)[2],motion.vectors[i+1],atol=1e-10)

    def test_long_layover_changes_sun_and_weather_without_moving_camera(self):
        trip=trip_from_dict(itinerary(('ORD','SFO','AKL'),layover_hours=79))
        motion=Motion(trip);end=trip.leg_intervals[0][1];following=trip.leg_intervals[1][0]
        a=context_at(motion,end+.25*(following-end));b=context_at(motion,end+.75*(following-end))
        np.testing.assert_allclose(a.camera_basis,b.camera_basis,atol=1e-10)
        self.assertGreater((b.physical_utc-a.physical_utc).total_seconds(),24*3600)
        self.assertGreater(np.linalg.norm(np.array(a.sun_world)-b.sun_world),.2)
        self.assertLess(a.weather_utc,b.weather_utc)

    def test_repeated_airport_labels_are_distinct_and_deterministic(self):
        trip=trip_from_dict(itinerary(('ORD','SFO','ORD','SFO','ORD')));labels=Labels(Motion(trip))
        self.assertEqual(len(labels.report()),5)
        self.assertTrue(all(x['first_visible_s'] is not None for x in labels.report()))
        cases=[(i,t) for i in range(5) for t in np.linspace(0,30,41)]
        expected={(i,t):labels.state(i,t) for i,t in cases}
        random.Random(91).shuffle(cases)
        self.assertEqual(expected,{(i,t):labels.state(i,t) for i,t in cases})

    def test_north_up_polar_route_and_exact_pole_crossing(self):
        for route in [('HEL','ANC'),('POA','POB')]:
            trip=trip_from_dict(itinerary(route));motion=Motion(trip)
            for t in np.linspace(0,30,121):
                matrix=np.array(motion.camera(t))
                self.assertTrue(np.isfinite(matrix).all())
                np.testing.assert_allclose(matrix@matrix.T,np.eye(3),atol=1e-10)
                self.assertGreaterEqual(matrix[1,2],-1e-10)
                self.assertTrue(np.isfinite(motion.heading(t)))

    def test_dateline_crossing_is_short_arc_and_no_longitude_jump_in_vectors(self):
        trip=trip_from_dict(itinerary(('NRT','ANC')));motion=Motion(trip)
        points=motion.route_points(0,501)
        self.assertLess(np.linalg.norm(np.diff(points,axis=0),axis=1).max(),.02)
        self.assertLess(trip.legs[0].angle,np.pi)

    def test_leap_day_year_boundary_and_southern_dst(self):
        for begin in [datetime(2028,2,28,23,tzinfo=timezone.utc),datetime(2030,12,31,23,tzinfo=timezone.utc),
                      datetime(2030,10,5,23,tzinfo=timezone.utc),datetime(2030,3,9,23,tzinfo=timezone.utc)]:
            trip=trip_from_dict(itinerary(('ORD','SYD','AKL','SFO','ORD'),begin=begin))
            self.assertEqual(trip.fingerprint,trip_from_dict(trip.to_dict()).fingerprint)
            self.assertEqual(trip.legs[0].arrive-trip.legs[0].depart,timedelta(hours=10))

    def test_zero_editorial_layovers_are_explicit_cuts(self):
        data=itinerary(('ORD','SFO','AKL','MEL','LAX','ORD'))
        data['video']['layover_hold_s']=0
        trip=trip_from_dict(data)
        for i in range(1,len(trip.legs)):
            t=trip.leg_intervals[i][0]
            self.assertEqual(trip.travel_time(t),trip.legs[i].depart)
            self.assertGreater(trip.travel_time(t),trip.travel_time(t-1e-8))

    def test_extreme_leg_lengths_keep_longest_apex_widest(self):
        trip=trip_from_dict(itinerary(('SFO','LAX','SYD','AKL')));motion=Motion(trip)
        radii=[motion.zoom((a+b)/2) for a,b in trip.leg_intervals]
        longest=int(np.argmax(motion.angles))
        self.assertAlmostEqual(radii[longest],trip.style['summit_radius'])
        self.assertGreater(radii[0],radii[longest]*2)

    def test_per_connection_holds_preserve_mixed_cut_chronology(self):
        data=itinerary(('ORD','SFO','AKL','MEL','LAX'),layover_hours=79)
        data['video']['layover_holds_s']=[0,5,1.5]
        trip=trip_from_dict(data)
        self.assertEqual(trip.effective_layover_holds_s,(0.,5.,1.5))
        for i,hold in enumerate(trip.effective_layover_holds_s):
            end=trip.leg_intervals[i][1];start=trip.leg_intervals[i+1][0]
            self.assertAlmostEqual(start-end,hold)
            self.assertEqual(trip.travel_time(start),trip.legs[i+1].depart)
            if hold:
                self.assertEqual(trip.travel_time(end),trip.legs[i].arrive)
                expected=trip.legs[i].arrive+(trip.legs[i+1].depart-trip.legs[i].arrive)/2
                self.assertEqual(trip.travel_time((end+start)/2),expected)
                self.assertEqual(trip.weather_time((end+start)/2),expected)
            else:
                self.assertEqual(trip.travel_time(end),trip.legs[i+1].depart)
                self.assertGreater(trip.travel_time(end),trip.travel_time(end-1e-7))
        self.assertEqual(trip.fingerprint,trip_from_dict(trip.to_dict()).fingerprint)
        self.assertEqual(trip.to_dict()['video']['layover_holds_s'],[0.,5.,1.5])
        self.assertEqual([row['presentation_mode'] for row in trip.to_plan()['connections']],
                         ['cut','animated_layover','animated_layover'])
        self.assertTrue(all(row['first_visible_s'] is not None for row in Labels(Motion(trip)).report()))

    def test_omitted_connection_list_preserves_scalar_defaults(self):
        data=itinerary(('ORD','SFO','AKL','MEL'))
        data['video']['layover_hold_s']=3.25
        old=trip_from_dict(data)
        self.assertIsNone(old.layover_holds_s)
        self.assertNotIn('layover_holds_s',old.to_dict()['video'])
        self.assertEqual(old.effective_layover_holds_s,(3.25,3.25))
        data['video']['layover_holds_s']=[3.25,3.25]
        explicit=trip_from_dict(data)
        self.assertEqual(old.leg_intervals,explicit.leg_intervals)
        for t in np.linspace(0,old.duration_s,61):
            self.assertEqual(old.travel_time(t),explicit.travel_time(t))
            self.assertEqual(old.weather_time(t),explicit.weather_time(t))
        data['video'].pop('duration_s')
        data['video']['layover_holds_s']=[0,7]
        derived=trip_from_dict(data)
        self.assertEqual(derived.duration_s,1+2+7+6*3)

    def test_connection_hold_validation_is_per_value_and_per_connection(self):
        for bad in [None,3,'3',[],[1],[1,2,3],[1,-.1],[1,True],[1,float('nan')],[1,float('inf')],[1,'2']]:
            with self.subTest(value=bad):
                data=itinerary(('ORD','SFO','AKL','MEL'))
                data['video']['layover_holds_s']=bad
                with self.assertRaisesRegex(TripError,'layover_holds_s'):
                    trip_from_dict(data)
        data=itinerary(('ORD','SFO'));data['video']['layover_holds_s']=[]
        self.assertEqual(trip_from_dict(data).effective_layover_holds_s,())
        data=itinerary(('ORD','SFO','AKL'));data['video']['layover_holds_s']=[1e-300]
        with self.assertRaisesRegex(TripError,'too short'):
            trip_from_dict(data)
        data['video']['layover_holds_s']=[40]
        with self.assertRaisesRegex(TripError,'combined holds'):
            trip_from_dict(data)

    def test_plan_warns_only_for_rapid_animated_layovers(self):
        data=itinerary(('ORD','SFO','AKL','MEL','LAX'),layover_hours=79)
        data['video']['layover_holds_s']=[2,4,0]
        trip=trip_from_dict(data);plan=trip.to_plan()
        self.assertEqual(len(plan['warnings']),1)
        warning=plan['warnings'][0]
        self.assertEqual(warning['connection_index'],0)
        self.assertEqual(warning['physical_hours_per_video_second'],39.5)
        self.assertIn('video.layover_holds_s[0]',warning['message'])
        self.assertIn('explicit cut',warning['message'])
        self.assertIsNone(plan['connections'][-1]['physical_hours_per_video_second'])
        self.assertEqual(trip.legs[-1].depart-trip.legs[-2].arrive,timedelta(hours=79))
        data['video']['layover_holds_s']=[79/24]*3
        self.assertEqual(trip_from_dict(data).to_plan()['warnings'],[])

    def test_quality_is_in_cache_identity_and_not_physics(self):
        trip=trip_from_dict(itinerary(('ORD','SFO')))
        environment={'packages':{'Pillow':'test'},'tools':{}}
        self.assertNotEqual(cache_key(trip,{},'diagram',environment,'preview'),cache_key(trip,{},'diagram',environment,'delivery'))
        from quality import get_quality
        self.assertGreater(get_quality('preview').terrain_scale,get_quality('delivery').terrain_scale)
        self.assertEqual(context_at(Motion(trip),5),context_at(Motion(trip),5))

if __name__=='__main__':unittest.main()
