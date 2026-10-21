"""Lunar terrain response and compositor invariants without assets or Blender."""
import ast
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

import numpy as np
from PIL import Image

ENGINE=Path(__file__).resolve().parents[1]/'skills/route-replay/scripts/engine'
sys.path.insert(0,str(ENGINE))
from radiometry import TransportLayer,resize_float,srgb_to_linear
from surfacelighting import lunar_surface_radiance,ocean_reflection


class SurfaceResponseTests(unittest.TestCase):
    def test_terrain_slope_faces_the_actual_moon_without_camera_fill(self):
        world=np.tile([0.,0.,1.],(3,1));view=world.copy()
        normals=np.array([[1.,0.,1.],[0.,0.,1.],[-1.,0.,1.]])
        normals/=np.linalg.norm(normals,axis=-1,keepdims=True)
        direction=np.tile([1.,0.,1.],(3,1))/np.sqrt(2)
        light=lunar_surface_radiance(world,normals,view,np.ones((3,3)),np.ones((3,1)),
                                     direction,np.ones((3,3)))
        self.assertTrue(np.all(light[0]>light[1]))
        self.assertTrue(np.all(light[1]>light[2]))
        np.testing.assert_allclose(light[2],0.,atol=1e-15)
        reversed_view=lunar_surface_radiance(world,normals,-view,np.ones((3,3)),np.ones((3,1)),
                                             direction,np.ones((3,3)))
        np.testing.assert_array_equal(reversed_view,light)

    def test_zero_incident_has_no_surface_or_ocean_floor(self):
        world=np.tile([0.,0.,1.],(2,1))
        # Horizon/eclipse/zero-gain gating belongs to lunar_incident. No surface
        # material may create light after that source has become zero.
        result=lunar_surface_radiance(world,world,world,np.ones((2,3)),np.array([[1.],[0.]]),
                                      world,np.zeros((2,3)))
        np.testing.assert_array_equal(result,0.)

    def test_gain_is_linear_preserves_incident_color_and_does_not_clip_hdr(self):
        world=np.tile([0.,0.,1.],(2,1));land=np.array([[1.],[0.]])
        incident=np.tile([4.,2.,0.],(2,1));albedo=np.ones((2,3))
        result=lunar_surface_radiance(world,world,world,albedo,land,world,incident)
        half=lunar_surface_radiance(world,world,world,albedo,land,world,.5*incident)
        np.testing.assert_allclose(half,.5*result,rtol=1e-12)
        np.testing.assert_allclose(result[:,0],2*result[:,1],rtol=1e-12)
        np.testing.assert_array_equal(result[:,2],0.)
        self.assertGreater(float(result.max()),1.)

    def test_ocean_glint_tracks_light_and_view_and_is_masked_on_land(self):
        world=np.tile([0.,0.,1.],(2,1));direction=np.tile([.6,0.,.8],(2,1))
        view=np.array([[-.6,0.,.8],[.6,0.,.8]])
        args=(world,world,view,np.zeros((2,3)))
        water=lunar_surface_radiance(*args,np.zeros((2,1)),direction,np.ones((2,3)))
        land=lunar_surface_radiance(*args,np.ones((2,1)),direction,np.ones((2,3)))
        self.assertTrue(np.all(water[0]>100*water[1]))
        np.testing.assert_array_equal(land,0.)
        below=lunar_surface_radiance(*args,np.zeros((2,1)),-direction,np.ones((2,3)))
        np.testing.assert_array_equal(below,0.)

    def test_existing_sun_ocean_lobe_is_preserved_at_representative_views(self):
        # Anchors captured from the preceding render.ocean_reflection function:
        # oblique, specular alignment, nadir view, and back-facing observer.
        world=np.tile([0.,0.,1.],(4,1));sun=np.array([.6,0.,.8])
        view=np.array([[.6,0.,.8],[-.6,0.,.8],[0.,0.,1.],[0.,0.,-1.]])
        expected=np.array([[.0002127531992470946,.00020424307127721083,.00018296775135250137],
                           [.43922438664790786,.4216554111819915,.3777329725172007],
                           [.0019741153994012207,.0018951507834251717,.0016977392434850498],
                           [0.,0.,0.]])
        np.testing.assert_allclose(ocean_reflection(world,sun,view),expected,rtol=1e-12,atol=1e-15)

    def test_point_order_and_repeated_evaluation_do_not_mutate_inputs(self):
        world=np.tile([0.,0.,1.],(3,1));normals=world.copy()
        view=np.array([[.6,0.,.8],[-.6,0.,.8],[0.,0.,1.]])
        albedo=np.array([[.3,.4,.5],[.1,.2,.3],[.6,.5,.4]])
        land=np.array([[0.],[.5],[1.]]);direction=np.tile([.6,0.,.8],(3,1))
        incident=np.array([[.2,.3,.4],[.1,.2,.3],[2.,1.,.5]])
        arrays=(world,normals,view,albedo,land,direction,incident)
        originals=tuple(array.copy() for array in arrays)
        first=lunar_surface_radiance(*arrays)
        reversed_result=lunar_surface_radiance(*(array[::-1] for array in arrays))
        np.testing.assert_array_equal(reversed_result[::-1],first)
        np.testing.assert_array_equal(lunar_surface_radiance(*arrays),first)
        for array,original in zip(arrays,originals):np.testing.assert_array_equal(array,original)


def globe_fixture():
    """Execute the actual source function against a three-hit terrain fixture."""
    path=ENGINE/'render.py'
    node=next(node for node in ast.parse(path.read_text()).body
              if isinstance(node,ast.FunctionDef) and node.name=='globe_radiance')
    world=np.tile([1.,0.,0.],(3,1));height=np.array([0.,1000.,2000.])
    slope_e=np.array([0.,.2,-.3]);slope_n=np.array([.1,0.,-.1])
    mask=np.array([[True,True],[False,True]]);visible=np.array([True,False,True])
    depths=np.array([.2,.4,.6]);zero=np.zeros(3)
    surface=(world,height,slope_e,slope_n,zero,zero,visible,mask,depths,world)
    physical=datetime(2024,11,17,tzinfo=timezone.utc)
    weather=datetime(2026,10,18,tzinfo=timezone.utc)
    city=Mock(return_value=np.tile([.5,.2,.1],(3,1)))
    def incident(points,physical_dt,weather_dt,*,strength,**kwargs):
        return SimpleNamespace(direction=world.copy(),angular_radius=np.full(3,.0045)),np.tile([.002,.001,.0005],(3,1))*strength
    lunar=Mock(side_effect=incident)
    scope={'np':np,'Image':Image,'timedelta':timedelta,'TRIP':SimpleNamespace(style={'moonlight':1.}),
           'terrain_surface':lambda bs:surface,'TW':2,'TH':2,'W':2,'H':2,
           'TEX':np.broadcast_to([255,0,0],(2,2,3)),
           'surface_color':lambda lon,lat:np.tile([.4,.5,.6],(3,1)),
           'ease':lambda value:np.clip(value,0,1)**2*(3-2*np.clip(value,0,1)),
           'cloud_shadow':Mock(return_value=np.ones(3)),'WITH_WEATHER':True,
           'ocean_reflection':ocean_reflection,'srgb_to_linear':srgb_to_linear,
           'sun_direction':lambda dt:np.array([-1.,0.,0.]),'city_emission':city,
           'RELIEF_EXAGGERATION':12.,'EARTH_RADIUS':6371000.,'lunar_incident':lunar,
           'lunar_surface_radiance':lunar_surface_radiance,
           'TERRAIN_SAMPLER':SimpleNamespace(sample=lambda p:np.zeros(len(p))),
           'TransportLayer':TransportLayer,'resize_float':resize_float}
    exec(compile(ast.Module(body=[node],type_ignores=[]),str(path),'exec'),scope)
    return scope,physical,weather,city,lunar,surface


class GlobeSourceTests(unittest.TestCase):
    def test_lunar_gain_changes_radiance_without_changing_coverage_or_depth(self):
        scope,physical,weather,city,lunar,surface=globe_fixture();values={}
        for gain in (0.,1.,4000.):
            scope['TRIP'].style['moonlight']=gain
            values[gain]=scope['globe_radiance'](np.eye(3),np.array([-1.,0.,0.]),physical,
                                               weather_dt=weather,return_depth=True)
        self.assertEqual(lunar.call_count,2)
        for gain in (1.,4000.):
            np.testing.assert_array_equal(values[gain][0].transmittance,values[0.][0].transmittance)
            np.testing.assert_array_equal(values[gain][1],values[0.][1])
        self.assertTrue(np.all(values[4000.][0].radiance[[0,1],[0,1]]>values[1.][0].radiance[[0,1],[0,1]]))
        np.testing.assert_array_equal(values[4000.][0].radiance[0,1],0.)
        np.testing.assert_array_equal(values[4000.][0].radiance[1,0],0.)
        np.testing.assert_array_equal(values[4000.][1],np.array([[.2,0.],[0.,.6]],np.float32))

    def test_city_emission_remains_additive_and_unscaled_in_every_lunar_mode(self):
        scope,physical,weather,city,lunar,surface=globe_fixture()
        emitted=np.array([.5,.2,.1]);expected=np.zeros((2,2,3))
        expected[0,0]=emitted;expected[1,1]=emitted
        for gain in (0.,1.,4000.):
            with self.subTest(gain=gain):
                scope['TRIP'].style['moonlight']=gain
                city.return_value=np.zeros((3,3))
                dark=scope['globe_radiance'](np.eye(3),np.array([-1.,0.,0.]),physical,weather_dt=weather)
                city.return_value=np.tile(emitted,(3,1))
                lit=scope['globe_radiance'](np.eye(3),np.array([-1.,0.,0.]),physical,weather_dt=weather)
                np.testing.assert_allclose(lit.radiance-dark.radiance,expected,rtol=2e-6,atol=2e-7)
                np.testing.assert_array_equal(lit.transmittance,dark.transmittance)
                self.assertEqual(city.call_args.kwargs['physical_dt'],physical)
                self.assertEqual(city.call_args.kwargs['weather_dt'],weather)

    def test_surface_incident_receives_physical_height_and_distinct_clocks(self):
        scope,physical,weather,city,lunar,surface=globe_fixture()
        for with_weather in (True,False):
            scope['WITH_WEATHER']=with_weather
            scope['globe_radiance'](np.eye(3),np.array([-1.,0.,0.]),physical,weather_dt=weather)
            args,kwargs=lunar.call_args
            self.assertEqual(args[1:],(physical,weather))
            np.testing.assert_allclose((np.linalg.norm(args[0],axis=-1)-1)*6371000/kwargs['height_exaggeration'],
                                       surface[1],atol=1e-8)
            self.assertEqual(kwargs['with_weather'],with_weather)
            self.assertEqual(kwargs['strength'],1.)
        lunar.reset_mock();scope['TRIP'].style['moonlight']=0.
        scope['globe_radiance'](np.eye(3),np.array([-1.,0.,0.]),physical,weather_dt=weather)
        lunar.assert_not_called()


if __name__=='__main__':unittest.main()
