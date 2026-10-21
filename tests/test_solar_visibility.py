"""Analytic shadow crossings and temporal/spatial terminator regressions."""
from pathlib import Path
import sys
import unittest

import numpy as np

ENGINE=Path(__file__).resolve().parents[1]/'skills'/'cinematic-flight-videos'/'scripts'/'engine'
sys.path.insert(0,str(ENGINE))
from solar_visibility import SUN_ANGULAR_RADIUS, solar_visibility, shadow_boundaries, split_intervals


class SolarVisibilityTests(unittest.TestCase):
    def test_disc_area_is_continuous_and_has_correct_limits(self):
        angle=np.linspace(-2*SUN_ANGULAR_RADIUS,2*SUN_ANGULAR_RADIUS,1001)
        points=np.column_stack((np.cos(angle),np.zeros(len(angle)),np.sin(angle)))
        actual=solar_visibility(points,[0,0,1])
        self.assertEqual(actual[0],0);self.assertEqual(actual[-1],1)
        self.assertAlmostEqual(actual[500],.5)
        self.assertTrue(np.all(np.diff(actual)>=-1e-10))
        self.assertLess(np.max(np.diff(actual)),.003)
        np.testing.assert_allclose(actual+actual[::-1],1,atol=4e-6)
        np.testing.assert_array_equal(solar_visibility([[0,0,.5]],[0,0,1]),0)

    def test_two_shadow_crossings_tangent_and_parallel_rays(self):
        origins=np.array([[-2,0,-2],[-2,1,-2],[1,0,-2],[2,0,-2]])
        rays=np.array([[1,0,0],[1,0,0],[0,0,1],[0,0,1]])
        roots=shadow_boundaries(origins,rays,[0,0,1])
        # Columns 2:4 are the central disc's cylinder intersections.
        np.testing.assert_allclose(np.sort(roots[0,2:4]),[1,3],atol=1e-12)
        np.testing.assert_allclose(roots[1,2:4],[2,2],atol=1e-12)
        self.assertFalse(np.any(np.isfinite(roots[3])))
        self.assertFalse(np.any(np.isnan(roots)))

    def test_random_crossings_satisfy_apparent_limb_equation(self):
        rng=np.random.default_rng(77)
        origins=rng.normal(size=(4000,3));origins*=1.2/np.linalg.norm(origins,axis=-1,keepdims=True)
        rays=rng.normal(size=origins.shape);rays/=np.linalg.norm(rays,axis=-1,keepdims=True)
        sun=np.array([.8,.3,-.2]);sun/=np.linalg.norm(sun)
        roots=shadow_boundaries(origins,rays,sun)
        self.assertGreater(np.count_nonzero(np.isfinite(roots)),500)
        for column,angle in enumerate(np.repeat([-SUN_ANGULAR_RADIUS,0,SUN_ANGULAR_RADIUS],2)):
            hit=np.isfinite(roots[:,column])
            point=origins[hit]+rays[hit]*roots[hit,column,None]
            radius=np.linalg.norm(point,axis=-1)
            clearance=np.arcsin(np.clip(point@sun/radius,-1,1))+np.arccos(1/np.maximum(radius,1))
            np.testing.assert_allclose(clearance,angle,atol=2e-9)

    def test_partition_preserves_depth_and_integrates_shadow_fraction(self):
        origins=np.array([[-2,0,-2],[-2,0,-2],[-2,0,-2]])
        rays=np.tile([1,0,0],(3,1));sun=np.array([0,0,1])
        start=np.zeros(3);stop=np.array([4.,1.5,.5])
        boundaries=shadow_boundaries(origins,rays,sun)
        length=np.zeros(3);lit=np.zeros(3);last=start.copy()
        for a,b,hit in split_intervals([(start,stop,np.ones(3,bool))],boundaries):
            self.assertTrue(np.all(a[hit]>=last[hit]-1e-12))
            self.assertTrue(np.all(b[hit]<=stop[hit]))
            length[hit]+=b[hit]-a[hit];last[hit]=b[hit]
            midpoint=origins[hit]+rays[hit]*((a[hit]+b[hit])*.5)[:,None]
            lit[hit]+=(b[hit]-a[hit])*solar_visibility(midpoint,sun)
        np.testing.assert_allclose(length,stop,atol=1e-12)
        # Dense quadrature is an independent integration reference, including
        # a path ending in shadow and an opaque hit before any shadow.
        t=(np.arange(100000)+.5)/100000*stop[:,None]
        points=origins[:,None,:]+rays[:,None,:]*t[:,:,None]
        reference=np.mean(solar_visibility(points,sun),axis=1)*stop
        np.testing.assert_allclose(lit,reference,atol=1e-5)

    def test_low_budget_atmosphere_has_no_stepwise_shadow_bands(self):
        # Imported test fixture keeps the runtime data/config isolated.
        from test_transport import atmosphere
        rays=np.column_stack((np.linspace(-.5,.5,1000),np.zeros(1000),-np.ones(1000)))
        rays/=np.linalg.norm(rays,axis=-1,keepdims=True)
        args=([0,0,1.2],rays,[1,0,-.25])
        low=atmosphere.integrate_atmosphere_rays(*args,view_samples=12,sun_samples=32)[0]
        high=atmosphere.integrate_atmosphere_rays(*args,view_samples=256,sun_samples=32)[0]
        self.assertLess(float(np.sqrt(np.mean((low-high)**2))),4e-5)
        self.assertLess(float(np.max(np.abs(np.diff(low,n=2,axis=0)))),1e-4)
        # One moving ray/Sun sequence must match the same rays in any order;
        # this catches stochastic dithering/state or adjacent-frame history.
        for index in (750,249,500,249):
            one=atmosphere.integrate_atmosphere_rays(args[0],rays[index:index+1],args[2],
                view_samples=12,sun_samples=32)[0]
            np.testing.assert_array_equal(one[0],low[index])

    def test_moving_sun_does_not_make_coarse_samples_flash(self):
        from test_transport import atmosphere
        rays=np.array([[0,0,-1.],[.25,0,-1.],[-.25,0,-1.]])
        rays/=np.linalg.norm(rays,axis=-1,keepdims=True)
        frames=np.array([atmosphere.integrate_atmosphere_rays([0,0,1.2],rays,[1,0,angle],
            view_samples=12,sun_samples=32)[0] for angle in np.linspace(-.27,-.23,61)])
        self.assertLess(float(np.max(np.abs(np.diff(frames,axis=0)))),1e-4)
        self.assertLess(float(np.max(np.abs(np.diff(frames,n=2,axis=0)))),1e-5)


if __name__=='__main__':unittest.main()
