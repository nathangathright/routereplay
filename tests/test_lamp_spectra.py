"""Offline source/colorimetric anchors for the reference-spectrum palette."""
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

import numpy as np

SKILL = Path(__file__).resolve().parents[1]/'skills/route-replay'
DATA = SKILL/'references/lamp-spectra'
spec = importlib.util.spec_from_file_location('lampspectra', SKILL/'scripts/engine/lampspectra.py')
lamps = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lamps)


class LampSpectrumTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.record = json.loads((DATA/'palette.json').read_text())
        cls.cmf = np.loadtxt(DATA/'CIE_xyz_1931_2deg.csv', delimiter=',')
        cls.led = np.loadtxt(DATA/'CIE_illum_LEDs_1nm.csv', delimiter=',')
        cls.hp = np.loadtxt(DATA/'CIE_illum_HPs.csv', delimiter=',')

    def test_api_is_finite_nonnegative_unit_luminance_and_preserves_hdr(self):
        self.assertEqual(lamps.LAMP_IDS, ('sodium', 'led_2700', 'led_3000',
            'led_4000', 'led_5000', 'metal_halide'))
        self.assertEqual(lamps.LINEAR_PALETTE.shape, (6, 3))
        self.assertEqual(lamps.LINEAR_PALETTE.dtype, np.float32)
        self.assertTrue(np.isfinite(lamps.LINEAR_PALETTE).all())
        self.assertTrue(np.all(lamps.LINEAR_PALETTE >= 0))
        np.testing.assert_allclose(lamps.LINEAR_PALETTE@lamps.LUMA, 1., atol=1e-7, rtol=0)
        self.assertGreater(float(lamps.LINEAR_PALETTE[0, 0]), 2.5)
        self.assertFalse(lamps.LINEAR_PALETTE.flags.writeable)
        self.assertFalse(lamps.LUMA.flags.writeable)
        with self.assertRaises(ValueError):
            lamps.LINEAR_PALETTE[0, 0] = 0.

    def test_nominal_families_retain_distinct_spectral_colors(self):
        led = lamps.LINEAR_PALETTE[1:5]
        self.assertTrue(np.all(np.diff(led[:, 0]) < 0))
        self.assertTrue(np.all(np.diff(led[:, 2]) > 0))
        self.assertTrue(np.all(np.diff(led[:, 0]/led[:, 2]) < 0))
        self.assertEqual(float(lamps.LINEAR_PALETTE[0, 2]), 0.)
        # Similar CCT does not make HP4's line-rich spectrum LED-B3.
        self.assertGreater(float(np.linalg.norm(lamps.LINEAR_PALETTE[5]-led[2])), .04)
        actual = [row['cct_approx_kelvin'] for row in self.record['lamps']]
        np.testing.assert_allclose(actual, [1962, 2733, 2998, 4103, 5109, 4004], atol=.5, rtol=0)
        self.assertNotEqual(actual[3], 4000.)
        self.assertEqual([row['source_column'] for row in self.record['lamps']],
                         ['HP1', 'LED-B1', 'LED-B2', 'LED-B3', 'LED-B4', 'HP4'])

    def test_original_sources_and_metadata_keep_their_verified_hashes_and_license(self):
        for filename, checksum in self.record['source_sha256'].items():
            with self.subTest(filename=filename):
                self.assertEqual(hashlib.sha256((DATA/filename).read_bytes()).hexdigest(), checksum)
        for filename in ('CIE_illum_LEDs_1nm.csv_metadata.json',
                         'CIE_illum_HPs.csv_metadata_v2.json', 'CIE_xyz_1931_2deg.csv_metadata.json'):
            metadata = json.loads((DATA/filename).read_text())
            self.assertEqual(metadata['rightsList'][0]['rightsIdentifier'], 'CC BY-SA 4.0')
            source = metadata['alternateIdentifiers'][0]['alternateIdentifier']
            declared = {row['hashMethod']: row['checksum'] for row in metadata['checksums']}
            self.assertEqual(declared['sha256'], self.record['source_sha256'][source])
        self.assertEqual(self.record['data_license'], 'CC-BY-SA-4.0')

    def test_cie_published_sample_rows_and_sampling_intervals(self):
        # Fixed validation rows published in the original metadata, independent
        # of the derived palette and its generator's matrix/integration code.
        np.testing.assert_allclose(self.hp[self.hp[:, 0] == 520][0],
            [520, 2.10, 20.02, 34.22, 34.45, 48.70], rtol=0, atol=1e-12)
        np.testing.assert_allclose(self.led[self.led[:, 0] == 499][0, :5],
            [499, 5.27849870402826, 5.80305826764525, 8.74284284007122, 5.51509371133012],
            rtol=0, atol=1e-12)
        np.testing.assert_allclose(self.cmf[self.cmf[:, 0] == 479][0],
            [479, .1042979, .1334528, .8566193], rtol=0, atol=1e-12)
        for table, step, first, last in ((self.hp, 5, 380, 780), (self.led, 1, 380, 780),
                                        (self.cmf, 1, 360, 830)):
            np.testing.assert_array_equal(np.diff(table[:, 0]), step)
            self.assertEqual(float(table[0, 0]), first)
            self.assertEqual(float(table[-1, 0]), last)
            self.assertTrue(np.isfinite(table).all())
            self.assertTrue(np.all(table >= 0))

    def test_independent_spectral_integration_matches_chromaticity_and_rgb_anchors(self):
        # Trapezoidal quadrature is independent of the generator's rectangular
        # sum. All source powers vanish at the observer grid's end points.
        selected = ((self.hp, 1), (self.led, 1), (self.led, 2),
                    (self.led, 3), (self.led, 4), (self.hp, 4))
        xyz = []
        for table, column in selected:
            spectrum = np.interp(self.cmf[:, 0], table[:, 0], table[:, column], left=0., right=0.)
            product = spectrum[:, None]*self.cmf[:, 1:]
            value = np.sum((product[1:]+product[:-1])*.5, axis=0)
            xyz.append(value/value[1])
        xyz = np.asarray(xyz)
        xy = xyz[:, :2]/xyz.sum(axis=1, keepdims=True)
        np.testing.assert_allclose(xy, [
            [.532779969, .415170682], [.455964326, .407803523],
            [.435669726, .401173118], [.375605283, .372289034],
            [.342176821, .350165310], [.381083451, .379707658]], rtol=0, atol=1e-9)
        np.testing.assert_allclose(xyz, [row['xyz_y1'] for row in self.record['lamps']],
                                   rtol=0, atol=1e-11)
        # Fixed HDR RGB anchors catch gamma encoding, adaptation to white,
        # normalization by maximum channel, or accidental source-column swaps.
        np.testing.assert_allclose(lamps.LINEAR_PALETTE, [
            [2.55890455, .63755158, 0.], [1.91955555, .80626602, .21137169],
            [1.77928436, .84039285, .28635983], [1.39462411, .92630912, .56795887],
            [1.19138871, .96540765, .77910258], [1.40103230, .92946993, .51777896]],
            rtol=0, atol=2e-7)
        raw = np.asarray([row['rgb_before_nonnegative_projection'] for row in self.record['lamps']])
        self.assertEqual(np.count_nonzero(raw < 0), 1)
        self.assertAlmostEqual(float(raw[0, 2]), -.000015428567, places=12)

    def test_luminance_mixtures_are_linear_and_order_independent(self):
        weights = np.array([[1., 0., 0., 0., 0., 0.], [.1, .2, .3, .1, .2, .1],
                            [0., 0., 0., .4, .1, .5]], np.float32)
        emitted = weights@lamps.LINEAR_PALETTE
        np.testing.assert_allclose(emitted@lamps.LUMA, weights.sum(axis=1), atol=2e-7, rtol=0)
        shuffled = np.array([5, 1, 4, 0, 3, 2])
        np.testing.assert_allclose(emitted, weights[:, shuffled]@lamps.LINEAR_PALETTE[shuffled],
                                   atol=2e-7, rtol=0)
        scale = np.array([0., .23, 4.], np.float32)
        np.testing.assert_allclose((scale[:, None]*emitted)@lamps.LUMA, scale, atol=5e-7, rtol=0)


if __name__ == '__main__':
    unittest.main()
