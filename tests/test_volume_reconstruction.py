"""CPU analytic checks for stateless depth-aware volume reconstruction."""
from pathlib import Path
import sys
import unittest

import numpy as np

ENGINE = Path(__file__).resolve().parents[1]/'skills'/'cinematic-flight-videos'/'scripts'/'engine'
sys.path.insert(0, str(ENGINE))
from camera_geometry import pixel_rays, pixel_rays_at
from volume_reconstruction import (_blend_weight, _grid_coordinates,
                                   reconstruct_transport, sample_depth)


def constant_samples(light=(12., .5, .003), transmission=(.4,)):
    def sample(xy):
        return np.broadcast_to(light, (len(xy), 3)), np.broadcast_to(transmission, (len(xy), len(transmission)))
    return sample


class VolumeReconstructionTests(unittest.TestCase):
    def test_explicit_camera_positions_match_coarse_and_full_rays(self):
        for size, center, scale in (((19, 27), (9.5, 13.5), 3),
                                     ((17, 23), (6.25, 7.5), 2.7),
                                     ((224, 224), (112, 112), 2),
                                     ((13, 7), (6.5, 3.5), 1)):
            with self.subTest(size=size, scale=scale):
                origin, rays = pixel_rays(340, size, center, scale=scale)
                xy = _grid_coordinates(size, rays.shape[:2])
                actual_origin, actual_rays = pixel_rays_at(340, xy, center)
                np.testing.assert_array_equal(origin, actual_origin)
                np.testing.assert_array_equal(rays.reshape(-1, 3), actual_rays)

    def test_full_evaluates_each_output_pixel_exactly_once_in_bounded_batches(self):
        seen = []
        def sample(xy):
            self.assertLessEqual(len(xy), 11)
            seen.extend(xy.tolist())
            light = np.stack([xy[:, 0]**2, xy[:, 1], xy[:, 0]*xy[:, 1]], axis=-1)
            return light, np.exp(-xy[:, :1]/20)
        layer = reconstruct_transport((13, 7), 4, sample, mode='full', batch_size=11)
        expected_xy = _grid_coordinates((13, 7), (7, 13))
        np.testing.assert_array_equal(np.asarray(seen), expected_xy)
        np.testing.assert_array_equal(layer.radiance[..., 0].ravel(), expected_xy[:, 0]**2)
        np.testing.assert_array_equal(layer.radiance[..., 1].ravel(), expected_xy[:, 1])
        self.assertEqual(layer.transmittance.shape, (7, 13, 1))

    def test_constant_hdr_fields_and_rgb_transmission_use_sparse_work(self):
        counts = []
        sample = constant_samples((25., .4, .002), (.25, .5, .75))
        def counted(xy):
            counts.append(len(xy))
            return sample(xy)
        layer = reconstruct_transport((31, 19), 4, counted, batch_size=13)
        np.testing.assert_allclose(layer.radiance, np.broadcast_to([25., .4, .002], (19, 31, 3)), rtol=2e-6)
        np.testing.assert_allclose(layer.transmittance, np.broadcast_to([.25, .5, .75], (19, 31, 3)), rtol=2e-6)
        self.assertEqual(sum(counts), 8*5+7*4)
        self.assertLessEqual(max(counts), 13)
        self.assertGreater(float(layer.radiance.max()), 1)

    def test_identity_transport_for_odd_and_one_dimensional_crops(self):
        for size in ((1, 1), (1, 17), (19, 1), (7, 13), (223, 225)):
            with self.subTest(size=size):
                layer = reconstruct_transport(size, 3, constant_samples((0, 0, 0), (1,)))
                np.testing.assert_array_equal(layer.radiance, 0)
                np.testing.assert_allclose(layer.transmittance, 1, atol=2e-7)
                self.assertEqual(layer.radiance.shape, (size[1], size[0], 3))

    def test_full_depth_recovers_thin_opaque_object_missing_from_coarse_grid(self):
        size = (31, 17)
        depth = np.full((17, 31), 2., np.float32)
        depth[:, 15] = .01
        def sample(xy):
            near = sample_depth(depth, xy) < 1
            return np.where(near[:, None], [9., 2., .2], [0., 0., 0.]), np.where(near, .2, 1.)
        layer = reconstruct_transport(size, 6, sample, opaque_depth=depth)
        expected = reconstruct_transport(size, 6, sample, mode='full')
        np.testing.assert_allclose(layer.radiance, expected.radiance, atol=1e-6)
        np.testing.assert_allclose(layer.transmittance, expected.transmittance, atol=1e-6)

    def test_no_cross_depth_bleed_and_zero_infinity_nohit_are_equivalent(self):
        depth = np.full((13, 29), 2., np.float32)
        depth[:, 12:] = 0
        def sample(xy):
            hit = sample_depth(depth, xy) > 0
            return np.where(hit[:, None], [8., 1., .5], [0., 0., 2.]), np.where(hit, .1, .8)
        zero = reconstruct_transport((29, 13), 4, sample, opaque_depth=depth)
        infinite = reconstruct_transport((29, 13), 4, sample, opaque_depth=np.where(depth > 0, depth, np.inf))
        full = reconstruct_transport((29, 13), 4, sample, mode='full')
        np.testing.assert_allclose(zero.radiance, full.radiance, atol=2e-6)
        np.testing.assert_allclose(zero.transmittance, full.transmittance, atol=2e-6)
        np.testing.assert_array_equal(zero.radiance, infinite.radiance)
        np.testing.assert_array_equal(zero.transmittance, infinite.transmittance)

    def test_support_mask_preserves_limb_identity_and_narrow_intervals(self):
        support = np.zeros((19, 31), bool)
        support[5:15, 15] = True
        layer = reconstruct_transport((31, 19), 6, constant_samples((5, 2, 1), (.2,)), support_mask=support)
        np.testing.assert_array_equal(layer.radiance[~support], 0)
        np.testing.assert_array_equal(layer.transmittance[~support], 1)
        np.testing.assert_allclose(layer.radiance[support], np.broadcast_to([5, 2, 1], (10, 3)))
        np.testing.assert_allclose(layer.transmittance[support], .2)

    def test_fractional_coarse_rays_use_exact_geometry_at_a_limb(self):
        size = (15, 11)
        # Coarse centre x=3.75 is outside, but its nearest output pixel x=3.5
        # is inside. Assigning that coarse sample the output guide causes bleed.
        def geometry(xy):
            hit = xy[:, 0] < 3.6
            return np.where(hit, 1., np.inf), np.ones(len(xy), bool)
        def sample(xy):
            hit = xy[:, 0] < 3.6
            return np.where(hit[:, None], [8., 1., .5], [0., 0., 2.]), np.where(hit, .1, .8)
        full_xy = _grid_coordinates(size, (size[1], size[0]))
        opaque, support = geometry(full_xy)
        kwargs = dict(opaque_depth=opaque.reshape(size[1], size[0]),
                      support_mask=support.reshape(size[1], size[0]))
        calls = []
        def counted(xy):
            self.assertLessEqual(len(xy), 2)
            calls.extend(xy.tolist())
            return geometry(xy)
        adaptive = reconstruct_transport(size, 8, sample, sample_geometry=counted,
                                          batch_size=2, **kwargs)
        full = reconstruct_transport(size, 8, sample, mode='full')
        rounded_guides = reconstruct_transport(size, 8, sample, **kwargs)
        self.assertGreater(float(np.max(np.abs(rounded_guides.radiance-full.radiance))), 1)
        np.testing.assert_allclose(adaptive.radiance, full.radiance, atol=2e-6)
        np.testing.assert_allclose(adaptive.transmittance, full.transmittance, atol=2e-6)
        np.testing.assert_array_equal(calls, _grid_coordinates(size, (2, 2)))

    def test_geometry_callback_contract_and_full_bypass(self):
        size = (9, 7)
        depth = np.ones((7, 9), np.float32)
        support = np.ones((7, 9), bool)
        sample = constant_samples()
        invalid = (
            lambda xy: [np.ones(len(xy))],
            lambda xy: (None, np.ones(len(xy), bool)),
            lambda xy: (np.ones((len(xy), 1)), np.ones(len(xy), bool)),
            lambda xy: (np.full(len(xy), -1), np.ones(len(xy), bool)),
            lambda xy: (np.ones(len(xy)), np.full(len(xy), 2)),
        )
        for callback in invalid:
            with self.assertRaises(ValueError):
                reconstruct_transport(size, 3, sample, opaque_depth=depth,
                    support_mask=support, sample_geometry=callback)
        def unused(xy):
            self.fail('full-grid sampling must not request reconstruction guides')
        reconstruct_transport(size, 3, sample, mode='full', sample_geometry=unused)
        reconstruct_transport(size, 3, sample, sample_geometry=lambda xy: (None, None))

    def test_fixed_scout_detects_a_cloud_band_missed_by_coarse_samples(self):
        size, scale = (32, 16), 8
        # Coarse x centres are 4,12,20,28; fixed scout positions include x=8.
        def sample(xy):
            cloud = np.exp(-((xy[:, 0]-8)/.8)**2)
            return cloud[:, None]*np.array([5, 2, 1]), 1-.8*cloud, np.where(cloud > 0, 2., 0.)
        layer = reconstruct_transport(size, scale, sample)
        full = reconstruct_transport(size, scale, sample, mode='full')
        self.assertGreater(float(layer.radiance[:, 7:9].max()), 3.)
        np.testing.assert_allclose(layer.radiance[:, 7:9], full.radiance[:, 7:9], atol=1e-6)

    def test_cloud_distance_variation_is_confident_only_with_opacity(self):
        counts = []
        def sample(xy):
            counts.append(len(xy))
            distance = np.where(xy[:, 0] < 16, .1, 10.)
            return np.zeros((len(xy), 3)), np.ones(len(xy)), distance
        layer = reconstruct_transport((32, 16), 4, sample)
        self.assertEqual(sum(counts), 8*4+7*3)
        np.testing.assert_array_equal(layer.radiance, 0)
        np.testing.assert_allclose(layer.transmittance, 1, atol=2e-7)
        opaque_counts = []
        def cloudy(xy):
            opaque_counts.append(len(xy))
            light, _, guide = sample(xy)
            return light+1, np.full(len(xy), .3), guide
        reconstruct_transport((32, 16), 4, cloudy)
        self.assertGreater(sum(opaque_counts), 8*4+7*3)

    def test_activation_is_smooth_across_sampling_threshold(self):
        epsilon = 1e-5
        values = _blend_weight(np.array([.25-epsilon, .25, .25+epsilon, 1-epsilon, 1, 1+epsilon]))
        self.assertEqual(values[0], 0)
        self.assertEqual(values[1], 0)
        self.assertLess(values[2], 1e-8)
        self.assertLess(1-values[3], 1e-8)
        self.assertEqual(values[4], 1)
        self.assertEqual(values[5], 1)
        def frame(amplitude):
            def sample(xy):
                cloud = amplitude*(.5+.5*np.sin(xy[:, 0]*1.1))
                return np.repeat(cloud[:, None], 3, axis=1), 1-cloud
            return reconstruct_transport((17, 9), 4, sample).radiance
        previous = frame(0.)
        for amplitude in np.linspace(.0002, .04, 200):
            current = frame(amplitude)
            self.assertLess(float(np.max(np.abs(current-previous))), .001)
            previous = current

    def test_frame_order_and_batch_size_do_not_change_results(self):
        def frame(time, batch_size):
            def sample(xy):
                opacity = .2+.15*np.sin(xy[:, 0]*.3+time)*np.cos(xy[:, 1]*.4)
                return opacity[:, None]*[3., .5, 1.], 1-opacity, .5+.1*np.sin(xy[:, 1]*.1+time)
            return reconstruct_transport((27, 15), 4, sample, batch_size=batch_size)
        initial = {time: frame(time, 4096) for time in (0., .1, .7, 2.)}
        for time in (.7, 0., 2., .1):
            repeated = frame(time, 13)
            np.testing.assert_array_equal(repeated.radiance, initial[time].radiance)
            np.testing.assert_array_equal(repeated.transmittance, initial[time].transmittance)

    def test_sparse_refinements_fill_batches_without_changing_rays_or_results(self):
        size = (64, 48)
        def run(batch_size):
            calls = []
            def sample(xy):
                calls.append(xy.copy())
                cloud = .15*np.exp(-((xy[:, 0]-28)/3)**2)
                return cloud[:, None]*[3., .5, 1.], 1-cloud, np.full(len(xy), 2.)
            layer = reconstruct_transport(size, 4, sample, batch_size=batch_size)
            # Coarse and scout positions are integers for this divisible grid;
            # only the additional output rays have half-integer coordinates.
            exact_calls = [xy for xy in calls if np.all(xy % 1 == .5)]
            return layer, calls, exact_calls
        reference, reference_calls, reference_exact = run(4096)
        actual, actual_calls, actual_exact = run(64)
        self.assertGreater(len(actual_exact), 2)
        self.assertTrue(all(len(xy) == 64 for xy in actual_exact[:-1]))
        self.assertLessEqual(len(actual_exact[-1]), 64)
        self.assertTrue(all(len(xy) <= 64 for xy in actual_calls))
        reference_rays = np.concatenate(reference_exact)
        actual_rays = np.concatenate(actual_exact)
        np.testing.assert_array_equal(actual_rays, reference_rays)
        self.assertEqual(sum(map(len, actual_calls)), sum(map(len, reference_calls)))
        self.assertLess(len(actual_rays), size[0]*size[1])
        # Refinements remain in increasing output-index order, without repeats.
        indices = (actual_rays[:, 1]-.5)*size[0]+actual_rays[:, 0]-.5
        self.assertTrue(np.all(np.diff(indices) > 0))
        np.testing.assert_array_equal(actual.radiance, reference.radiance)
        np.testing.assert_array_equal(actual.transmittance, reference.transmittance)

    def test_nearest_depth_sampling_and_validation(self):
        depth = np.array([[0., 1., np.inf], [2., 3., 4.]])
        np.testing.assert_array_equal(sample_depth(depth, [[.5, .5], [1., 1.], [9, 9], [-1, -1]]), [0, 3, 4, 0])
        self.assertIsNone(sample_depth(None, np.zeros((2, 2))))
        good = constant_samples()
        for kwargs in ({'size': (0, 2)}, {'scale': 0}, {'scale': np.inf}, {'batch_size': 0},
                       {'mode': 'reference'}, {'opaque_depth': np.zeros((2, 2))},
                       {'support_mask': np.zeros((2, 2))}, {'opaque_depth': np.full((7, 9), np.nan)},
                       {'opaque_depth': np.full((7, 9), -1)}):
            arguments = dict(size=(9, 7), scale=3, sample_rays=good)
            arguments.update(kwargs)
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                reconstruct_transport(**arguments)
        for bad in (lambda xy: (np.zeros((len(xy), 2)), np.ones(len(xy))),
                    lambda xy: (np.zeros((len(xy), 3)), np.ones((len(xy), 2))),
                    lambda xy: (np.full((len(xy), 3), np.nan), np.ones(len(xy))),
                    lambda xy: (np.zeros((len(xy), 3)), np.ones(len(xy)), [1, 2])):
            with self.assertRaises(ValueError):
                reconstruct_transport((9, 7), 3, bad)


if __name__ == '__main__':
    unittest.main()
