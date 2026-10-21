"""Unresolved cloud shape, renewal and coverage contracts without datasets."""
from unittest.mock import patch
import unittest
import numpy as np
from test_transport import cloud,weather,uniform_fields
from test_trip import sample,trip_from_dict,TripError
import cloudshapes as shapes


class MorphologyTests(unittest.TestCase):
    def test_style_is_explicit_and_cache_addressable(self):
        data=sample()
        self.assertEqual(trip_from_dict(data).style['cloud_morphology'],1)
        data.setdefault('style',{})['cloud_morphology']=0
        old=trip_from_dict(data)
        data['style']['cloud_morphology']=1
        self.assertNotEqual(old.fingerprint,trip_from_dict(data).fingerprint)
        for value in (-1,.5,2):
            data['style']['cloud_morphology']=value
            with self.assertRaises(TripError):trip_from_dict(data)

    def test_cellular_texture_is_periodic_and_immutable(self):
        texture=shapes.billow_texture()
        self.assertFalse(texture.flags.writeable)
        self.assertTrue(np.isfinite(texture).all())
        points=np.array([[63.9,11.,20.],[-.1,11.,20.]])
        result=shapes.sample_texture(texture,points,1.)
        np.testing.assert_allclose(result[0],result[1],atol=1e-7)
        self.assertGreater(float(texture.std()),.1)

    def test_sparse_forecast_carves_gaps_and_depth_is_not_extruded(self):
        rng=np.random.default_rng(1729)
        seed=rng.normal(size=(12000,3)).astype(np.float32)
        seed/=np.linalg.norm(seed,axis=1,keepdims=True)
        values=[]
        for cover in (.15,1.):
            values.append(shapes.density_shape(seed,np.full(len(seed),1800.),
                np.full(len(seed),1100.),np.full(len(seed),1800.),np.full(len(seed),cover),0,cloud._NOISE))
        self.assertGreater(np.mean(values[0]==0),.5)
        self.assertGreater(np.mean(values[1]>0),.9)
        self.assertGreater(float(values[1].mean()),float(values[0].mean()))
        deeper=shapes.density_shape(seed,np.full(len(seed),2800.),np.full(len(seed),1100.),
            np.full(len(seed),1800.),np.ones(len(seed)),0,cloud._NOISE)
        # Smooth sheets previously correlated >.96 after moving 1 km upward.
        self.assertLess(float(np.corrcoef(values[1],deeper)[0,1]),.9)
        self.assertTrue(np.isfinite(deeper).all())
        self.assertTrue((deeper>=0).all())

    def test_renewal_is_stationary_without_wind_and_frame_order_independent(self):
        points=cloud._unit(np.array([.41,-2.1,3.13]),np.array([.2,-.3,.7]))
        points*=1+np.array([1700,5200,10500])[:,None]*cloud.HEIGHT_EXAGGERATION/cloud.EARTH_M
        def macro(lo,la,t,layer):
            return np.ones_like(lo),np.full_like(lo,20.),np.full_like(lo,(1800,5500,11000)[layer])
        zero=lambda lo,la,h,t:(np.zeros_like(lo),np.zeros_like(lo))
        cloud._frame_fields.cache_clear()
        try:
            with patch.dict(cloud.TRIP.style,{'cloud_morphology':1}),\
                 patch.object(cloud,'sample_layer_fields',side_effect=macro),\
                 patch.object(weather,'sample_wind',side_effect=zero),\
                 patch.object(weather,'MATERIAL_REFERENCE',0.),patch.object(weather,'VALID_END',1e6):
                values={stamp:cloud._density(points,stamp)[0] for stamp in (0.,7200.,17000.,86400.)}
                # Only one material epoch exists before the first renewal.
                self.assertTrue(all(layer[9]==0 for layer in cloud._frame_fields(3600.)))
                for stamp in (86400.,0.,17000.,7200.):
                    np.testing.assert_array_equal(cloud._density(points,stamp)[0],values[stamp])
                    # Spherical backtrace round trips return float32 angles.
                    np.testing.assert_allclose(values[stamp],values[0.],rtol=1e-4,atol=1e-9)
        finally:cloud._frame_fields.cache_clear()

    def test_material_history_is_bounded_and_renewal_has_no_jump(self):
        first=5000.;queries=[]
        def wind(lo,la,h,t):
            queries.append(t)
            return 40*np.cos(la),np.zeros_like(lo)
        def macro(lo,la,t,layer):
            return np.ones_like(lo),np.full_like(lo,20.),np.full_like(lo,(1800,5500,11000)[layer])
        points=cloud._unit(np.array([.41,-2.1,3.13]),np.array([.2,-.3,.7]))
        points*=1+np.array([1700,5200,10500])[:,None]*cloud.HEIGHT_EXAGGERATION/cloud.EARTH_M
        cloud._frame_fields.cache_clear()
        try:
            with patch.dict(cloud.TRIP.style,{'cloud_morphology':1}),\
                 patch.object(cloud,'sample_layer_fields',side_effect=macro),\
                 patch.object(weather,'sample_wind',side_effect=wind),\
                 patch.object(weather,'MATERIAL_REFERENCE',first),patch.object(weather,'VALID_END',1e6):
                boundary=first+7200*10
                before=cloud._density(points,boundary-.1)[0]
                after=cloud._density(points,boundary+.1)[0]
                self.assertGreaterEqual(min(queries),boundary-14400)
                self.assertLessEqual(max(queries),boundary+.1)
                np.testing.assert_allclose(after,before,rtol=.002,atol=1e-7)
                for stamp in (first-1,1e6+1):
                    with self.assertRaisesRegex(ValueError,'verified weather coverage'):
                        cloud._frame_fields(stamp)
        finally:cloud._frame_fields.cache_clear()


if __name__=='__main__':unittest.main()
