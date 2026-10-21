"""Lunar air source, physical terrain shadows and bounded bounce regressions."""
from datetime import datetime, timezone
import importlib
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import numpy as np

ENGINE=Path(__file__).resolve().parents[1]/'skills/route-replay/scripts/engine'
sys.path.insert(0,str(ENGINE))
import lunar_scattering as lunar
from solar_visibility import shadow_boundaries


class LunarScatteringTests(unittest.TestCase):
    def test_bounce_has_no_ambient_floor_is_bounded_and_obeys_albedo(self):
        world=np.tile([0.,0.,1.],(3,1))
        normals=np.array([[0,0,1],[.8,0,.6],[1,0,0]])
        incident=np.tile([.1,.2,.3],(3,1))
        white=lunar.surface_bounce(world,normals,np.ones((3,3)),world,incident)
        np.testing.assert_array_equal(white[0],0)
        self.assertTrue(np.all(white<=.18*incident))
        grey=lunar.surface_bounce(world,normals,np.full((3,3),.5),world,incident)
        np.testing.assert_allclose(grey,.25*white)
        np.testing.assert_array_equal(lunar.surface_bounce(world,normals,np.ones((3,3)),
                                                         -world,incident),0)
        np.testing.assert_array_equal(lunar.surface_bounce(world,normals,np.ones((3,3)),
                                                         world,incident*0),0)

    def test_terrain_blocks_low_moon_but_not_high_aircraft_or_zenith(self):
        points=np.array([[0.,0.,1.],[0.,0.,1+10000/6371000]])
        low=np.array([1.,0.,.01]);low/=np.linalg.norm(low)
        def ridge(query):
            distance=np.arctan2(query[:,0],query[:,2])*6371000
            return np.where((distance>1000)&(distance<10000),1000.,0.)
        visibility=lunar.terrain_visibility(points,low,.0045,ridge)
        np.testing.assert_allclose(visibility,[0,1])
        clear=lunar.terrain_visibility(points,[0,0,1],.0045,ridge)
        np.testing.assert_array_equal(clear,1)
        # Fractional horizon coverage should change continuously, not switch
        # a whole ray on/off when a ridge grazes the lunar disc.
        heights=np.linspace(2.,2.4,81)
        fractions=[lunar.terrain_visibility(points[:1],low,.0045,
                     lambda q,h=h:np.full(len(q),h))[0] for h in heights]
        self.assertTrue(any(0<v<1 for v in fractions))
        self.assertTrue(np.all(np.diff(fractions)<=1e-12))

    def test_source_uses_distinct_clocks_linear_flux_and_shared_extinction(self):
        physical=datetime(2030,1,1,tzinfo=timezone.utc)
        weather=datetime(2026,1,1,tzinfo=timezone.utc)
        point=np.array([[0.,0.,1.001],[0.,0.,1.002]])
        direction=np.tile([0.,0.,1.],(2,1))
        geometry=SimpleNamespace(direction=direction,visibility=np.array([1.,0.]),ratio=np.full(2,2e-6))
        calls=[];cloud_calls=[];fields=(object(),)
        air=SimpleNamespace(VISIBILITY_SCALE=7.2,OUTER_KM=7091,EARTH_KM=6371,
            BETA_R=np.array([.01,.02,.03]),BETA_M=.001,
            phase_rayleigh=lambda mu:np.ones(len(mu)),phase_mie=lambda mu:np.ones(len(mu)),
            optical_depth=lambda *a,**k:(calls.append(k) or np.tile([.1,.2,.3],(len(a[0]),1))))
        def cloud_depth(p,d,t,**kwargs):
            self.assertEqual(t,weather)
            self.assertIs(kwargs['fields'],fields)
            self.assertEqual(kwargs['strength'],.27)
            self.assertEqual(kwargs['samples'],4)
            cloud_calls.append(kwargs)
            return np.full(len(p),.4)
        clouds=SimpleNamespace(_cloud_optical_depth=cloud_depth,HEIGHT_EXAGGERATION=12.)
        moon=SimpleNamespace(lunar_illumination=lambda p,t,**k:
            (self.assertEqual(t,physical) or geometry))
        with patch.dict(sys.modules,{'atmosphere':air,'cloudvolume':clouds,'moonlighting':moon}):
            small=lunar.atmosphere_source(point,-direction,np.ones(2),np.ones(2),
                physical,weather,gain=1,fields=fields,cloud_strength=.27,cloud_samples=4)
            big=lunar.atmosphere_source(point,-direction,np.ones(2),np.ones(2),
                physical,weather,gain=4000,fields=fields,cloud_strength=.27,cloud_samples=4)
        np.testing.assert_allclose(big,small*4000)
        np.testing.assert_array_equal(big[1],0)
        np.testing.assert_allclose(small[0],2e-6*np.array([.011,.021,.031])*np.exp(-np.array([.5,.6,.7])))
        self.assertEqual(calls[0]['weather_dt'],weather)
        self.assertEqual(calls[0]['samples'],10)
        self.assertEqual(len(cloud_calls),2)

    def test_layered_cloud_query_preserves_physical_height_and_joint_shares_display_height(self):
        physical_heights=np.array([0.,10000.,20000.])
        point=np.column_stack((np.zeros((3,2)),1+physical_heights*7.2/6371000.))
        direction=np.tile([0.,0.,1.],(3,1));cloud_queries=[];air_queries=[]
        air=SimpleNamespace(VISIBILITY_SCALE=7.2,OUTER_KM=7091,EARTH_KM=6371,
            BETA_R=np.ones(3),BETA_M=0.,
            phase_rayleigh=lambda mu:np.ones(len(mu)),phase_mie=lambda mu:np.ones(len(mu)),
            optical_depth=lambda p,*a,**k:(air_queries.append(p.copy()) or np.zeros((len(p),3))))
        clouds=SimpleNamespace(HEIGHT_EXAGGERATION=12.,
            _cloud_optical_depth=lambda p,*a,**k:
                (cloud_queries.append(p.copy()) or np.zeros(len(p))))
        moon=SimpleNamespace(lunar_illumination=lambda p,*a,**k:
            SimpleNamespace(direction=direction,visibility=np.ones(3),ratio=np.ones(3)))
        with patch.dict(sys.modules,{'atmosphere':air,'cloudvolume':clouds,'moonlighting':moon}):
            for shared in (False,True):
                lunar.atmosphere_source(point,-direction,np.ones(3),np.zeros(3),
                    datetime(2026,1,1,tzinfo=timezone.utc),None,gain=1,
                    shared_cloud_geometry=shared)
        # Air optical depth always uses its incoming display coordinates.
        for query in air_queries:np.testing.assert_array_equal(query,point)
        layered_physical_m=(np.linalg.norm(cloud_queries[0],axis=-1)-1)*6371000./12.
        np.testing.assert_allclose(layered_physical_m,physical_heights,atol=1e-8)
        np.testing.assert_array_equal(cloud_queries[1],point)

    def test_air_source_excludes_subground_roundoff_without_reindexing_rays(self):
        point=np.array([[0.,0.,1-1e-15],[0.,0.,1.],[0.,0.,1.002]])
        direction=np.tile([0.,0.,1.],(3,1))
        air=SimpleNamespace(VISIBILITY_SCALE=7.2,OUTER_KM=7091,EARTH_KM=6371,
            BETA_R=np.ones(3),BETA_M=0.,
            phase_rayleigh=lambda mu:np.ones(len(mu)),phase_mie=lambda mu:np.ones(len(mu)),
            optical_depth=lambda p,*a,**k:np.zeros((len(p),3)))
        def illumination(p,t,**kwargs):
            np.testing.assert_array_equal(p,point[1:])
            return SimpleNamespace(direction=direction[1:],visibility=np.ones(2),
                                   ratio=np.array([2e-6,3e-6]))
        with patch.dict(sys.modules,{'atmosphere':air,
                'moonlighting':SimpleNamespace(lunar_illumination=illumination)}):
            actual=lunar.atmosphere_source(point,-direction,np.array([10.,20.,30.]),
                np.zeros(3),datetime(2026,1,1,tzinfo=timezone.utc),None,
                gain=1,with_clouds=False)
        np.testing.assert_array_equal(actual[0],0)
        np.testing.assert_allclose(actual[1:],np.broadcast_to([[4e-5],[9e-5]],(2,3)))

    def test_camera_lunar_scattering_adds_light_without_changing_depth_or_opacity(self):
        names=('runtime','atmosphere','moonlighting','celestial','starfield')
        saved={name:sys.modules.get(name) for name in names}
        for name in names:sys.modules.pop(name,None)
        runtime=SimpleNamespace(TRIP=SimpleNamespace(style={}),ASSETS=Path('/unused'),BUNDLE={})
        try:
            sys.modules['runtime']=runtime
            air=importlib.import_module('atmosphere')
            moon=importlib.import_module('moonlighting')
            dt=datetime(2026,10,26,tzinfo=timezone.utc)
            center=moon._frame_geometry(dt)[0]
            up=center/np.linalg.norm(center)
            origin=up*1.2;rays=np.array([-up,-up])
            args=dict(depth=np.array([.19,.195]),view_samples=10,sun_samples=6,
                      physical_dt=dt,weather_dt=dt,with_clouds=False)
            dark,trans=air.integrate_atmosphere_rays(origin,rays,-up,moon_gain=0,**args)
            lit,trans2=air.integrate_atmosphere_rays(origin,rays,-up,moon_gain=4000,**args)
            self.assertTrue(np.all(lit>dark))
            # Added shadow quadrature may change numerical extinction slightly;
            # both should converge to the identical physical atmosphere.
            np.testing.assert_allclose(trans,trans2,rtol=2e-3,atol=1e-6)
            self.assertTrue(np.all(trans2[0]>=trans2[1]))
        finally:
            for name,value in saved.items():
                if value is None:sys.modules.pop(name,None)
                else:sys.modules[name]=value


if __name__=='__main__':unittest.main()
