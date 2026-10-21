"""Portable cloud reconstruction checks; Metal prefix math uses CPU fixtures."""
from contextlib import ExitStack
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
# Import the transport without installing a trip or loading weather assets.
_names=('runtime','cloudvolume','cloudlayers','weatherfields')
_saved={name:sys.modules.get(name) for name in _names}
sys.modules['runtime']=SimpleNamespace(TRIP=SimpleNamespace(style={}),ASSETS=Path('/unused'),WEATHER=None)
try:
    for name in _names[1:]:sys.modules.pop(name,None)
    cloud=importlib.import_module('cloudvolume')
finally:
    for name,value in _saved.items():
        if value is None:sys.modules.pop(name,None)
        else:sys.modules[name]=value
from cloudview import integrate_cloud_view
from camera_geometry import pixel_rays, sphere_interval


def density(points,*args,**kwargs):
    return np.full(len(points),.00008,np.float32),points/np.linalg.norm(points,axis=-1,keepdims=True)


def source(points,*args,**kwargs):
    return np.broadcast_to(np.array([2.,.7,.2],np.float32),(len(points),3))


def prefix_fixture(points,steps,*args,**kwargs):
    sigma=np.full(steps.shape,.00008,np.float32)
    weights=np.zeros_like(steps);transmission=np.ones(len(points),np.float32)
    for j in range(steps.shape[1]):
        active=(steps[:,j]>0)&(transmission>1e-4)
        opacity=-np.expm1(-sigma[active,j]*steps[active,j])
        weights[active,j]=transmission[active]*opacity;transmission[active]*=1-opacity
    return sigma,weights,transmission


def radiance_fixture(colors,weights,offsets):
    result=np.zeros((len(offsets)-1,3),np.float32)
    for i,(a,b) in enumerate(zip(offsets[:-1],offsets[1:])):
        result[i]=np.sum(colors[a:b]*weights[a:b,None],axis=0)
    return result


class CloudGuideTests(unittest.TestCase):
    def setUp(self):
        self.stack=ExitStack();self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.dict('os.environ',{'FLIGHT_COMPUTE':'cpu','FLIGHT_CLOUD_VIEW':'reference'}))
        self.stack.enter_context(patch.object(cloud,'_density',side_effect=density))
        self.stack.enter_context(patch.object(cloud,'_sample_source',side_effect=source))
        self.origins=np.array([[0.,0.,1.04],[0.,0.,1.04],[0.,0.,1.04]])
        self.rays=np.tile([0.,0.,-1.],(3,1));self.sun=np.array([0.,0.,1.])
        self.start=np.array([.0099,.0099,.03]);self.stop=np.array([.04,.021,.02])

    def test_guide_is_optional_and_does_not_change_reference_transport(self):
        args=(self.origins,self.rays,self.start,self.stop,0,self.sun)
        original=cloud._integrate(*args,fields=(),substeps=2)
        guided=cloud._integrate(*args,fields=(),substeps=2,return_guide=True)
        self.assertEqual(len(original),2);self.assertEqual(len(guided),3)
        np.testing.assert_array_equal(original[0],guided[0]);np.testing.assert_array_equal(original[1],guided[1])
        self.assertTrue(np.all(guided[2][:2]>=self.start[:2]))
        self.assertTrue(np.all(guided[2][:2]<=self.stop[:2]))
        self.assertLess(guided[2][1],guided[2][0]);self.assertEqual(guided[2][2],0)
        np.testing.assert_array_equal(guided[0][2],0);self.assertEqual(guided[1][2],1)

    def test_mocked_metal_guide_matches_cpu_weights_and_preserves_clocks(self):
        physical=datetime(2032,11,17,tzinfo=timezone.utc)
        weather=datetime(2026,10,18,tzinfo=timezone.utc)
        args=(self.origins,self.rays,self.start,self.stop,weather,self.sun)
        expected=cloud._integrate(*args,fields=(),substeps=2,physical_dt=physical,return_guide=True)
        with patch.dict(sys.modules,{'cloudvolume':cloud,'weatherfields':cloud.weatherfields}),\
             patch('metal_clouds.cloud_view_prefix',side_effect=prefix_fixture),\
             patch('metal_clouds.cloud_view_radiance',side_effect=radiance_fixture),\
             patch.object(cloud,'_sample_source',side_effect=source) as sources:
            actual=integrate_cloud_view(*args,fields=(),substeps=2,physical_dt=physical,
                                        return_guide=True,tile_rays=2)
            unguided=integrate_cloud_view(*args,fields=(),substeps=2,physical_dt=physical,tile_rays=2)
        self.assertEqual(len(unguided),2)
        for a,b in zip(actual[:2],unguided):np.testing.assert_array_equal(a,b)
        for a,b in zip(actual,expected):np.testing.assert_allclose(a,b,atol=3e-7,rtol=2e-6)
        for call in sources.call_args_list:
            self.assertEqual(call.args[3],weather);self.assertEqual(call.kwargs['physical_dt'],physical)


class GeneratedCameraTests(unittest.TestCase):
    def test_full_generated_pixels_match_reference_and_mocked_metal_quadrature(self):
        quality=SimpleNamespace(cloud_scale=1.,cloud_substeps=2)
        options=dict(size=(8,6),center=(4,3),include_foreground=False,physical_dt=2032)
        depth=np.full((6,8),.06,np.float32);depth[:,3]=.001
        options['surface_depth']=depth
        def render(mode,compute='cpu'):
            with patch.dict('os.environ',{'FLIGHT_COMPUTE':compute,'FLIGHT_CLOUD_VIEW':'batched',
                                         'FLIGHT_VOLUME_RECONSTRUCTION':mode}):
                return cloud.render_cloud_volume(np.eye(3),[0,0,1],2026,2000,10000,**options).layer
        with patch.object(cloud,'get_quality',return_value=quality),\
             patch('quality.get_quality',return_value=quality),\
             patch.object(cloud,'_frame_fields',return_value=()),\
             patch.object(cloud,'_density',side_effect=density),\
             patch.object(cloud,'_sample_source',side_effect=source),\
             patch.dict(sys.modules,{'cloudvolume':cloud,'weatherfields':cloud.weatherfields}),\
             patch('metal_clouds.cloud_view_prefix',side_effect=prefix_fixture),\
             patch('metal_clouds.cloud_view_radiance',side_effect=radiance_fixture):
            reference=render('reference');full=render('full');adaptive=render('adaptive');metal=render('full','metal')
        for actual in (full,adaptive):
            np.testing.assert_array_equal(actual.radiance,reference.radiance)
            np.testing.assert_array_equal(actual.transmittance,reference.transmittance)
        np.testing.assert_allclose(metal.radiance,full.radiance,atol=5e-7,rtol=2e-6)
        np.testing.assert_allclose(metal.transmittance,full.transmittance,atol=5e-7,rtol=2e-6)


class CloudReconstructionTests(unittest.TestCase):
    def setUp(self):
        self.stack=ExitStack();self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.dict('os.environ',{'FLIGHT_COMPUTE':'cpu','FLIGHT_CLOUD_VIEW':'reference',
                                                        'FLIGHT_VOLUME_RECONSTRUCTION':'reference'}))
        self.quality=SimpleNamespace(cloud_scale=3.,cloud_substeps=1)
        self.stack.enter_context(patch.object(cloud,'get_quality',return_value=self.quality))
        self.fields=object()
        self.stack.enter_context(patch.object(cloud,'_frame_fields',return_value=self.fields))
        self.stack.enter_context(patch.object(cloud,'AIRCRAFT_CROP',4))
        self.calls=[]
        self.stack.enter_context(patch.object(cloud,'_integrate',side_effect=self.integrate))
        self.origin=np.array([0.,0.,1.04],np.float32)
        self.rays=np.tile([0.,0.,-1.],(6,8,1)).astype(np.float32)
        self.stack.enter_context(patch('camera_geometry.pixel_rays_at',
            side_effect=lambda radius,xy,**kw:(self.origin,np.tile([0.,0.,-1.],(len(xy),1)).astype(np.float32))))
        self.weather=datetime(2026,10,18,tzinfo=timezone.utc)
        self.physical=datetime(2032,11,17,tzinfo=timezone.utc)

    def integrate(self,origins,rays,start,stop,when,sun,**kwargs):
        self.calls.append((origins.copy(),rays.copy(),start.copy(),stop.copy(),when,kwargs))
        opacity=-np.expm1(-np.maximum(stop-start,0)*30)
        light=opacity[:,None]*np.array([2.,.7,.2],np.float32)
        result=(light.astype(np.float32),(1-opacity).astype(np.float32))
        return (*result,((start+stop)*.5).astype(np.float32)) if kwargs.get('return_guide') else result

    def render(self,mode,**kwargs):
        options=dict(size=(8,6),center=(4,3),
                     include_foreground=False,physical_dt=self.physical)
        options.update(kwargs)
        with patch.dict('os.environ',{'FLIGHT_VOLUME_RECONSTRUCTION':mode}):
            return cloud.render_cloud_volume(np.eye(3),[0,0,1],self.weather,500,10000,**options)

    def test_reference_keeps_existing_resize_and_never_enters_reconstruction(self):
        coarse=self.rays[::3,::3]
        with patch.object(cloud,'_reconstructed_layer',side_effect=AssertionError('reference changed')):
            actual=self.render('reference',camera_rays=(self.origin,coarse)).layer
        origins=np.broadcast_to(self.origin,(coarse.size//3,3));rays=coarse.reshape(-1,3)
        entry,exit,hit=sphere_interval(origins,rays,1+cloud.MAX_ALTITUDE_M*cloud.HEIGHT_EXAGGERATION/cloud.EARTH_M)
        stop,_,_=sphere_interval(origins,rays,1)
        light,t=self.integrate(origins,rays,entry,np.minimum(stop,exit),self.weather,[0,0,1])
        expected=cloud._layer(light,t,coarse.shape[:2],(8,6))
        np.testing.assert_array_equal(actual.radiance,expected.radiance)
        np.testing.assert_array_equal(actual.transmittance,expected.transmittance)
        self.assertFalse(self.calls[0][-1].get('return_guide',False))

    def test_full_and_adaptive_clip_active_medium_and_keep_both_clocks(self):
        depth=np.full((6,8),.021,np.float32);depth[:,2:4]=.005;depth[:,6:]=0
        for mode in ('adaptive','full'):
            with self.subTest(mode=mode):
                self.calls.clear();result=self.render(mode,surface_depth=depth)
                self.assertEqual(result.layer.radiance.shape,(6,8,3))
                self.assertEqual(result.layer.transmittance.shape,(6,8,1))
                np.testing.assert_array_equal(result.layer.radiance[:,2:4],0)
                np.testing.assert_array_equal(result.layer.transmittance[:,2:4],1)
                self.assertTrue(np.all(result.layer.transmittance[:,:2]<1))
                self.assertTrue(np.all(result.layer.transmittance[:,6:]<result.layer.transmittance[:,:2]))
                np.testing.assert_array_equal(result.foreground_layer.transmittance,1)
                self.assertTrue(self.calls)
                for _,_,start,stop,when,kw in self.calls:
                    self.assertEqual(when,self.weather);self.assertEqual(kw['physical_dt'],self.physical)
                    self.assertIs(kw['fields'],self.fields)
                    self.assertTrue(np.all(stop>start));self.assertTrue(kw['return_guide'])

    def test_full_resolution_foreground_uses_exact_crop_and_retains_depth_extension(self):
        canvas=np.full((6,8),np.inf,np.float32)
        canvas[1:5,2:6]=np.linspace(.012,.029,16,dtype=np.float32).reshape(4,4)
        canvas[2,3]=np.inf;canvas[3,4]=0;canvas[4,5]=.005
        crop=canvas[1:5,2:6]
        foreground_rays=np.tile([0.,0.,-1.],(4,4,1)).astype(np.float32)
        for mode in ('adaptive','full'):
            with self.subTest(mode=mode),patch.object(cloud,'pixel_rays',return_value=(self.origin,foreground_rays)) as pixels:
                actual=self.render(mode,aircraft_depth=canvas,include_foreground=True).foreground_layer
                cropped=self.render(mode,aircraft_depth=crop,include_foreground=True).foreground_layer
                np.testing.assert_array_equal(actual.radiance,cropped.radiance)
                np.testing.assert_array_equal(actual.transmittance,cropped.transmittance)
                self.assertTrue(all(call.kwargs['scale']==1 for call in pixels.call_args_list))
                filled=cloud._extend_aircraft_depth(crop)
                valid=np.isfinite(crop)&(crop>0)
                np.testing.assert_array_equal(filled[valid],crop[valid])
                empty=filled<=.0099
                np.testing.assert_array_equal(actual.radiance[empty],0)
                np.testing.assert_array_equal(actual.transmittance[empty],1)
                entry,_,_=sphere_interval(self.origin,foreground_rays,1+cloud.MAX_ALTITUDE_M*cloud.HEIGHT_EXAGGERATION/cloud.EARTH_M)
                expected=np.exp(-30*(filled[~empty]-entry[~empty]))
                np.testing.assert_allclose(actual.transmittance[...,0][~empty],expected,atol=1e-7)

    def test_full_and_adaptive_keep_altitude_fallback_for_missing_aircraft_depth(self):
        foreground_rays=np.tile([0.,0.,-1.],(4,4,1)).astype(np.float32)
        with patch.object(cloud,'pixel_rays',return_value=(self.origin,foreground_rays)):
            adaptive=self.render('adaptive',include_foreground=True).foreground_layer
            full=self.render('full',include_foreground=True).foreground_layer
        np.testing.assert_array_equal(adaptive.radiance,full.radiance)
        np.testing.assert_array_equal(adaptive.transmittance,full.transmittance)
        self.assertTrue(np.all(full.transmittance<1))

    def test_custom_ray_grid_preserves_supplied_resolution_and_resize_in_all_modes(self):
        coarse=self.rays[::2,::2]
        expected=self.render('reference',camera_rays=(self.origin,coarse)).layer
        for mode in ('adaptive','full'):
            with patch.object(cloud,'_reconstructed_layer',side_effect=AssertionError('supplied rays must be preserved')):
                actual=self.render(mode,camera_rays=(self.origin,coarse)).layer
            np.testing.assert_array_equal(actual.radiance,expected.radiance)
            np.testing.assert_array_equal(actual.transmittance,expected.transmittance)
        with self.assertRaisesRegex(ValueError,'FLIGHT_VOLUME_RECONSTRUCTION'):
            self.render('invalid')


class CloudLimbReconstructionTests(unittest.TestCase):
    def test_analytic_earth_clipping_guides_reconstruction_without_terrain_depth(self):
        # A thin homogeneous medium exposes cross-limb mixing even when its
        # transport/distance variation is too small to request exact rays.
        size=(65,49);center=(32.5,24.5);radius=22.
        quality=SimpleNamespace(cloud_scale=6.,cloud_substeps=1)
        def uniform_density(points,*args,**kwargs):
            sigma=np.full(len(points),.15*cloud.HEIGHT_EXAGGERATION/cloud.EARTH_M,np.float32)
            return sigma,np.zeros_like(points)
        def unit_source(points,*args,**kwargs):
            return np.ones((len(points),3),np.float32)
        origin,rays=pixel_rays(radius,size,center)
        _,_,ground=sphere_interval(origin,rays)
        boundary=np.zeros_like(ground)
        boundary[1:]|=ground[1:]!=ground[:-1];boundary[:-1]|=ground[1:]!=ground[:-1]
        boundary[:,1:]|=ground[:,1:]!=ground[:,:-1];boundary[:,:-1]|=ground[:,1:]!=ground[:,:-1]
        with patch.dict('os.environ',{'FLIGHT_COMPUTE':'cpu','FLIGHT_CLOUD_VIEW':'reference'}), \
             patch.object(cloud,'_frame_fields',return_value=()), \
             patch.object(cloud,'_density',side_effect=uniform_density), \
             patch.object(cloud,'_sample_source',side_effect=unit_source), \
             patch.object(cloud,'get_quality',return_value=quality):
            for depth in (None,np.zeros((49,65),np.float32)):
                layers=[]
                for mode in ('adaptive','full'):
                    with patch.dict('os.environ',{'FLIGHT_VOLUME_RECONSTRUCTION':mode}):
                        layers.append(cloud.render_cloud_volume(np.eye(3),[0,0,1],0,radius,10000,
                            size=size,center=center,surface_depth=depth,include_foreground=False).layer)
                # At the axial limbs the fractional coarse rays and output
                # rays have opposite Earth-hit classifications.
                np.testing.assert_allclose(layers[0].radiance[[2,46],32],layers[1].radiance[[2,46],32],
                    atol=2e-6,rtol=2e-5)
                np.testing.assert_allclose(layers[0].transmittance[[2,46],32],layers[1].transmittance[[2,46],32],
                    atol=2e-6,rtol=2e-5)
                self.assertLess(float(np.max(np.abs(layers[0].radiance-layers[1].radiance)[boundary])),.001)


if __name__=='__main__':unittest.main()
