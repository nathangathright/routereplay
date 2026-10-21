"""The experimental chase fixture uses physical seconds and shared metric ENU."""
from dataclasses import replace
import json
import math
from pathlib import Path
import random
import sys
import unittest
import numpy as np

ENGINE=Path(__file__).resolve().parents[1]/'skills/cinematic-flight-videos/scripts/engine'
sys.path.insert(0,str(ENGINE))
from chase_camera import (ChaseCamera,ChaseConfig,EARTH_M,GRAVITY_MPS2,
                          enu_basis,enu_to_ecef,ecef_to_enu,look_at)


class ChaseCameraTests(unittest.TestCase):
    def setUp(self):
        self.config=ChaseConfig(37.6,-122.4,10500.,40.,240.)

    def test_basis_round_trip_poles_and_antimeridian(self):
        points=np.array([[0,0,0],[1000,-250,10500],[-500,1200,5000.]])
        for lat,lon in ((0,0),(37.6,-122.4),(-36.8,179.999),(90,180),(-90,-180)):
            basis=enu_basis(lat,lon)
            np.testing.assert_allclose(basis.T@basis,np.eye(3),atol=1e-14)
            self.assertAlmostEqual(np.linalg.det(basis),1.)
            ecef=enu_to_ecef(points,lat,lon,origin_altitude_m=100)
            np.testing.assert_allclose(ecef_to_enu(ecef,lat,lon,100),points,atol=2e-9)
            self.assertAlmostEqual(np.linalg.norm(ecef[0]),EARTH_M+100)

    def test_poses_are_right_handed_centered_and_level_horizon(self):
        rig=ChaseCamera(self.config)
        for t in np.linspace(0,6,19):
            sample=rig.sample(t)
            for key in ('aircraft_rotation','camera_rotation'):
                matrix=np.array(sample[key]);np.testing.assert_allclose(matrix.T@matrix,np.eye(3),atol=1e-14)
                self.assertAlmostEqual(np.linalg.det(matrix),1.)
            camera=np.array(sample['camera_position_m']);target=np.array(sample['camera_target_m'])
            matrix=np.array(sample['camera_rotation'])
            projection=(target-camera)@matrix
            np.testing.assert_allclose(projection[:2],0,atol=1e-12)
            self.assertLess(projection[2],0)
            self.assertAlmostEqual(matrix[2,0],0.) # Horizontal ENU horizon has no camera roll.
            self.assertGreater(matrix[2,1],0.)
            np.testing.assert_allclose(sample['camera_up'],matrix[:,1])
            self.assertEqual(sample['mode'],'modeled_chase_maneuver')
            json.dumps(sample,allow_nan=False)

    def test_rear_port_above_offset_and_bank_sign(self):
        sample=ChaseCamera(replace(self.config,heading_deg=0,heading_lag_s=0)).sample(0)
        delta=np.array(sample['camera_position_m'])-sample['aircraft_position_m']
        self.assertLess(delta[0],0);self.assertLess(delta[1],0);self.assertGreater(delta[2],0)
        self.assertAlmostEqual(np.linalg.norm(delta),45*3.4)
        self.assertAlmostEqual(math.degrees(math.atan2(-delta[0],-delta[1])),25)
        self.assertAlmostEqual(math.degrees(math.asin(delta[2]/np.linalg.norm(delta))),12)
        self.assertLess(sample['aircraft_rotation'][2][0],0) # Positive bank puts starboard wing down.
        self.assertEqual(sample['aircraft_rotation'][2][1],0)

    def test_straight_path_and_constant_turn_match_analytic_motion(self):
        straight=ChaseCamera(replace(self.config,bank_deg=0,heading_deg=90))
        np.testing.assert_allclose(straight.sample(6)['aircraft_position_m'],[1440,0,10500],atol=1e-10)
        for bank in (-15,15):
            cfg=replace(self.config,bank_deg=bank,bank_envelope='steady')
            rig=ChaseCamera(cfg);omega=GRAVITY_MPS2*math.tan(math.radians(bank))/cfg.speed_mps
            theta0=math.radians(cfg.heading_deg)
            for t in (0.,1.3,3.,6.):
                theta=theta0+omega*t
                expected=[cfg.speed_mps*(math.cos(theta0)-math.cos(theta))/omega,
                          cfg.speed_mps*(math.sin(theta)-math.sin(theta0))/omega,cfg.altitude_m]
                sample=rig.sample(t)
                np.testing.assert_allclose(sample['aircraft_position_m'],expected,atol=5e-11)
                self.assertAlmostEqual(sample['heading_deg'],math.degrees(theta))
                self.assertAlmostEqual(sample['bank_deg'],bank)

    def test_smooth_rollout_has_coherent_speed_turn_and_continuity(self):
        rig=ChaseCamera(self.config)
        self.assertAlmostEqual(rig.sample(0)['bank_deg'],15)
        self.assertAlmostEqual(rig.sample(6)['bank_deg'],0)
        for t in (0.1,1.,3.,5.9):
            before,center,after=(rig.sample(s) for s in (t-1e-3,t,t+1e-3))
            velocity=(np.array(after['aircraft_position_m'])-before['aircraft_position_m'])/.002
            self.assertAlmostEqual(np.linalg.norm(velocity),240,places=6)
            rate=math.radians(after['heading_deg']-before['heading_deg'])/.002
            self.assertAlmostEqual(rate,GRAVITY_MPS2*math.tan(math.radians(center['bank_deg']))/240,places=8)
            self.assertLess(np.linalg.norm(np.array(after['camera_position_m'])-before['camera_position_m']),.5)
            self.assertLess(abs(after['bank_deg']-before['bank_deg']),.01)
        # The rollout turns only as much as a real 240m/s coordinated maneuver.
        self.assertGreater(rig.sample(6)['heading_deg']-40,1.)
        self.assertLess(rig.sample(6)['heading_deg']-40,3.)

    def test_random_access_and_output_fps_do_not_change_pose(self):
        rig=ChaseCamera(self.config)
        times=[0.,.1,1.25,3.,5.5,6.]
        expected={t:rig.sample(t) for t in times}
        random.Random(7).shuffle(times)
        for t in times:self.assertEqual(rig.sample(t),expected[t])
        for fps in (24,30,60):
            for frame in (0,fps,3*fps,6*fps):
                self.assertEqual(rig.sample(frame/fps),ChaseCamera(self.config).sample(frame/fps))
        # Sampling an endpoint first cannot initialize a mutable spring.
        other=ChaseCamera(self.config);other.sample(6)
        self.assertEqual(other.sample(0),expected[0.])

    def test_camera_and_conservative_aircraft_bounds_clear_spherical_ground(self):
        for altitude in (100,1000,10500):
            cfg=replace(self.config,altitude_m=altitude)
            for t in (0,3,6):
                sample=ChaseCamera(cfg).sample(t)
                center=np.array(sample['aircraft_position_m']);rotation=np.array(sample['aircraft_rotation'])
                # Conservative 45m-wide body box exceeds this fixture's actual
                # aircraft dimensions, testing clearance after the bank transform.
                corners=np.array([[x,y,z] for x in (-22.5,22.5) for y in (-22.5,22.5) for z in (-5,5)])
                vertices=corners@rotation.T+center
                world=enu_to_ecef(vertices,cfg.origin_lat_deg,cfg.origin_lon_deg)
                self.assertGreater(np.min(np.linalg.norm(world,axis=-1)-EARTH_M),80)
                eye=enu_to_ecef(sample['camera_position_m'],cfg.origin_lat_deg,cfg.origin_lon_deg)
                self.assertGreater(np.linalg.norm(eye)-EARTH_M,altitude)

    def test_invalid_inputs_raise_without_degenerate_camera_roll(self):
        for kwargs in ({'speed_mps':0},{'bank_deg':90},{'duration_s':0},{'duration_s':121},
                       {'elevation_deg':90},{'port_azimuth_deg':-1},{'heading_lag_s':3},
                       {'altitude_m':-1},{'heading_deg':float('nan')},{'speed_mps':True},{'speed_mps':.1}):
            with self.subTest(kwargs=kwargs),self.assertRaises(ValueError):replace(self.config,**kwargs)
        rig=ChaseCamera(self.config)
        for t in (-1,7,float('nan'),True):
            with self.assertRaises(ValueError):rig.sample(t)
        for target,up in (([0,0,0],[0,0,1]),([0,0,1],[0,0,1]),([1,0,0],[0,0,0])):
            with self.assertRaises(ValueError):look_at([0,0,0],target,up)


if __name__=='__main__':unittest.main()
