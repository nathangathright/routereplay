"""Data-free lunar source limits, geometric clocks and directional-sky checks."""
from datetime import datetime, timedelta, timezone
from pathlib import Path
import importlib
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

ENGINE=Path(__file__).resolve().parents[1]/'skills/route-replay/scripts/engine'
sys.path.insert(0,str(ENGINE))
_names=('runtime','starfield','celestial','moonlighting','atmosphere','cloudlighting')
_saved={name:sys.modules.get(name) for name in _names}
for _name in _names:sys.modules.pop(_name,None)
sys.modules['runtime']=SimpleNamespace(TRIP=SimpleNamespace(style={}),ASSETS=Path('/unused'))
try:
    moon=importlib.import_module('moonlighting')
    lighting=importlib.import_module('cloudlighting')
finally:
    for _name,_module in _saved.items():
        if _module is None:sys.modules.pop(_name,None)
        else:sys.modules[_name]=_module

PHYSICAL=datetime(2024,11,17,tzinfo=timezone.utc)
MOON=np.array([0.,0.,384400.])


def sun_offset(degrees):
    angle=np.radians(degrees)
    return moon.AU_KM*np.array([np.sin(angle),0.,-np.cos(angle)])


class LunarGeometryTests(unittest.TestCase):
    def setUp(self):
        moon._frame_geometry.cache_clear()
        self.addCleanup(moon._frame_geometry.cache_clear)

    def state(self,points,sun=None,**kwargs):
        moon._frame_geometry.cache_clear()
        with patch.object(moon,'ephemeris',return_value=(MOON,sun_offset(5.) if sun is None else sun)):
            return moon.lunar_illumination(np.asarray(points,float),PHYSICAL,**kwargs)

    def test_phase_is_monotone_nonlinear_and_has_no_new_moon_floor(self):
        angles=np.linspace(0,np.pi,721);original=angles.copy()
        brightness=moon.phase_brightness(angles)
        np.testing.assert_array_equal(angles,original)
        self.assertTrue(np.isfinite(brightness).all())
        self.assertTrue(np.all(np.diff(brightness)<=0))
        self.assertEqual(float(brightness[0]),1.)
        self.assertEqual(float(brightness[-1]),0.)
        # A half-illuminated lunar disc is much dimmer than half a full Moon.
        self.assertLess(float(moon.phase_brightness(np.pi/2)),.2)
        for phase in (np.nan,-.01,np.pi+.01):
            with self.subTest(phase=phase),self.assertRaises(ValueError):
                moon.phase_brightness(phase)

    def test_disc_overlap_limits_are_bounded_continuous_and_scale_invariant(self):
        separation=np.linspace(0,.025,251)
        visible=moon.disc_visible_fraction(.004,.016,separation)
        self.assertEqual(float(visible[0]),0.)
        self.assertEqual(float(visible[-1]),1.)
        self.assertTrue(np.all(np.diff(visible)>=-1e-12))
        self.assertTrue(np.any((visible>0)&(visible<1)))
        np.testing.assert_allclose(visible,moon.disc_visible_fraction(.008,.032,2*separation),atol=1e-12)
        self.assertAlmostEqual(float(moon.disc_visible_fraction(.008,.004,0.)),.75)
        self.assertEqual(float(moon.disc_visible_fraction(.008,0.,0.)),1.)
        for contact in (.012,.020):
            samples=moon.disc_visible_fraction(.004,.016,contact+np.array([-1e-8,0,1e-8]))
            self.assertLess(float(np.ptp(samples)),1e-6)

    def test_lunar_eclipse_total_partial_clear_and_rotation_limits(self):
        self.assertEqual(moon.eclipse_transmission(MOON,sun_offset(0.)),0.)
        self.assertEqual(moon.eclipse_transmission(MOON,sun_offset(5.)),1.)
        self.assertEqual(moon.eclipse_transmission(MOON,-sun_offset(0.)),1.)
        offsets=np.linspace(.4,1.6,25)
        values=np.array([moon.eclipse_transmission(MOON,sun_offset(angle)) for angle in offsets])
        self.assertTrue(np.all(np.diff(values)>=-1e-12))
        self.assertTrue(np.any((values>0)&(values<1)))
        rotate=np.array([[0.,0.,1.],[1.,0.,0.],[0.,1.,0.]])
        np.testing.assert_allclose(moon.eclipse_transmission(rotate@MOON,rotate@sun_offset(1.)),
                                   moon.eclipse_transmission(MOON,sun_offset(1.)),atol=1e-12)

    def test_geometry_phase_and_total_eclipse_remove_light_without_hidden_floor(self):
        points=[[0.,0.,1.001]]
        full=self.state(points)
        quarter=self.state(points,sun_offset(90.))
        new=self.state(points,-sun_offset(0.))
        eclipsed=self.state(points,sun_offset(0.))
        self.assertGreater(float(full.ratio[0]),float(quarter.ratio[0]))
        self.assertGreater(float(quarter.ratio[0]),0.)
        self.assertGreater(float(full.illuminated_fraction[0]),.99)
        self.assertAlmostEqual(float(quarter.illuminated_fraction[0]),.5,delta=.002)
        np.testing.assert_array_equal(new.ratio,0.)
        np.testing.assert_array_equal(eclipsed.ratio,0.)
        self.assertEqual(eclipsed.eclipse_transmission,0.)
        self.assertTrue(np.all(new.visibility>0))  # A visible new Moon still emits no modeled light.

    def test_horizon_uses_finite_disc_and_does_not_hide_ratio(self):
        angle=np.radians(np.linspace(0,180,2001))
        points=np.column_stack((np.sin(angle),np.zeros_like(angle),np.cos(angle)))
        state=self.state(points)
        self.assertEqual(float(state.visibility[0]),1.)
        self.assertEqual(float(state.visibility[-1]),0.)
        self.assertTrue(np.all(np.diff(state.visibility)<=1e-10))
        self.assertGreater(np.count_nonzero((state.visibility>0)&(state.visibility<1)),2)
        self.assertLess(float(np.max(abs(np.diff(state.visibility)))),.3)
        self.assertTrue(np.all(state.ratio>0))  # Caller applies Earth visibility exactly once.

    def test_distance_obeys_inverse_square_and_angular_size(self):
        state=self.state([[0.,0.,1.],[0.,0.,1.2]])
        self.assertLess(float(state.distance_km[1]),float(state.distance_km[0]))
        self.assertGreater(float(state.angular_radius[1]),float(state.angular_radius[0]))
        np.testing.assert_allclose(state.phase_angle[0],state.phase_angle[1],atol=1e-14)
        np.testing.assert_allclose(state.ratio[1]/state.ratio[0],
                                   (state.distance_km[0]/state.distance_km[1])**2,rtol=1e-12)

    def test_height_exaggeration_is_removed_before_lunar_geometry(self):
        up=np.array([[1.,1.,1.],[.3,0.,1.]])
        up/=np.linalg.norm(up,axis=-1,keepdims=True)
        height=np.array([1.,3.])/moon.EARTH_KM
        actual=self.state(up*(1+height)[:,None])
        exaggerated=self.state(up*(1+12*height)[:,None],height_exaggeration=12.)
        for field in ('direction','ratio','visibility','angular_radius','phase_angle','distance_km'):
            np.testing.assert_allclose(getattr(exaggerated,field),getattr(actual,field),rtol=1e-12,atol=1e-14)

    def test_actual_utc_state_is_reorder_independent_and_does_not_mutate_inputs(self):
        points=np.array([[0.,0.,1.002],[1.001,0.,0.],[0.,-1.004,0.]])
        original=points.copy();later=PHYSICAL+timedelta(hours=1)
        values={stamp:moon.lunar_illumination(points,stamp) for stamp in (PHYSICAL,later)}
        equivalent=PHYSICAL.astimezone(timezone(timedelta(hours=-6)))
        for stamp in (later,equivalent,PHYSICAL):
            actual=moon.lunar_illumination(points[::-1],stamp)
            reference=values[stamp]
            for field in ('direction','ratio','visibility','angular_radius','phase_angle','illuminated_fraction','distance_km'):
                data=getattr(actual,field)
                np.testing.assert_array_equal(data[::-1],getattr(reference,field))
                self.assertFalse(data.flags.writeable)
        np.testing.assert_array_equal(points,original)
        self.assertGreater(float(np.max(abs(values[PHYSICAL].direction-values[later].direction))),.01)
        np.testing.assert_allclose(np.linalg.norm(values[PHYSICAL].direction,axis=-1),1.,atol=1e-14)

    def test_naive_clock_invalid_geometry_and_exaggeration_fail_clearly(self):
        with self.assertRaisesRegex(ValueError,'timezone-aware'):
            moon.lunar_illumination([[0,0,1]],PHYSICAL.replace(tzinfo=None))
        for points in ([[0,0,.99]],[[0,0,np.nan]]):
            with self.subTest(points=points),self.assertRaises(ValueError):
                moon.lunar_illumination(points,PHYSICAL)
        for scale in (0.,.99,np.nan):
            with self.subTest(scale=scale),self.assertRaises(ValueError):
                moon.lunar_illumination([[0,0,1]],PHYSICAL,height_exaggeration=scale)

    def test_per_point_sky_directions_match_individual_queries_without_mutation(self):
        points=np.array([[0.,0.,1.002],[1.001,0.,0.],[0.,-1.004,0.]])
        directions=np.array([[.2,.1,1.],[1.,-.2,.1],[.1,.3,1.]])*2
        original=directions.copy();batched=lighting.sky_samples(points,directions)
        separate=[lighting.sky_samples(points[index:index+1],direction) for index,direction in enumerate(directions)]
        for output in (0,1):
            np.testing.assert_allclose(batched[output],np.concatenate([value[output] for value in separate]),
                                       rtol=2e-6,atol=1e-8)
        np.testing.assert_array_equal(directions,original)


if __name__=='__main__':unittest.main()
