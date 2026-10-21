"""Reproduce the compact lamp palette offline using bundled CIE tables.

Code: repository MIT license. Source/derived numerical data: CIE CC BY-SA 4.0;
see ../lamp-spectra.md. This tool uses only NumPy and Python's standard library.
Run with --write to update palette.json, or --check to verify it and the module.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
LUMA = np.array([.2126, .7152, .0722])
# ICC's sRGB characterization, equation 7. No adaptation, OETF or high clipping.
XYZ_TO_RGB = np.array([[3.2406255, -1.5372080, -.4986286],
                       [-.9689307, 1.8757561, .0415175],
                       [.0557101, -.2040211, 1.0569959]])
SOURCE_HASHES = {
    'CIE_illum_LEDs_1nm.csv': '2a065526e1502f138d5b96aa8c9b337320e08667aac028ab5ad428bf1179a4b7',
    'CIE_illum_HPs.csv': '035e09d62b27f4b1e362ff1ba99a50235f0d7886c2781c50d49851b6e4bb4552',
    'CIE_xyz_1931_2deg.csv': 'fa663e3535a7e0763a745993a1f0a192eb0275ac46ad2d1befd7626841e713c1',
    'CIE_illum_LEDs_1nm.csv_metadata.json': '8e95fe131cfff2534aa161846b1b7d113f74781338e85787104661b887f8ff48',
    'CIE_illum_HPs.csv_metadata_v2.json': 'd72f68dcbae8c0bc9361a399e172e8f9beb61dc59119620047538df4840c39b3',
    'CIE_xyz_1931_2deg.csv_metadata.json': '03abcaecf4e63d77045ef57c4514b52c8bb1a46dd18e1f93a50044a0f4f481c8',
}
# These are representative choices, not surveyed city fixtures or exact CCTs.
SELECTION = (
    ('sodium', 'CIE_illum_HPs.csv', 'HP1', 1),
    ('led_2700', 'CIE_illum_LEDs_1nm.csv', 'LED-B1', 1),
    ('led_3000', 'CIE_illum_LEDs_1nm.csv', 'LED-B2', 2),
    ('led_4000', 'CIE_illum_LEDs_1nm.csv', 'LED-B3', 3),
    ('led_5000', 'CIE_illum_LEDs_1nm.csv', 'LED-B4', 4),
    ('metal_halide', 'CIE_illum_HPs.csv', 'HP4', 4),
)


def uv1960(xyz):
    x, y, z = xyz
    return np.array([4*x, 6*y])/(x+15*y+3*z)


def approximate_cct(xyz, cmf):
    """Nearest Planckian point in CIE 1960 uv; descriptive metadata only.

    Integrate Planck's law against the same 360–830 nm CMFs; minimize squared
    uv distance over 1000–25000 K with bounded golden-section search. This is
    not a reproduction of the publication's rounded CCT table or a CRI model.
    """
    wavelength = cmf[:, 0]*1e-9
    c2 = 6.62607015e-34*299792458/1.380649e-23  # h*c/k, SI defining constants.
    target = uv1960(xyz)
    def distance(log_temperature):
        power = wavelength**-5/np.expm1(c2/(wavelength*np.exp(log_temperature)))
        return float(np.sum((uv1960(power@cmf[:, 1:])-target)**2))
    lo, hi = np.log(1000.), np.log(25000.)
    fraction = (np.sqrt(5.)-1.)/2.
    a, b = hi-fraction*(hi-lo), lo+fraction*(hi-lo)
    fa, fb = distance(a), distance(b)
    for _ in range(96):
        if fa < fb:
            hi, b, fb = b, a, fa
            a = hi-fraction*(hi-lo)
            fa = distance(a)
        else:
            lo, a, fa = a, b, fb
            b = lo+fraction*(hi-lo)
            fb = distance(b)
    value = (lo+hi)/2.
    return round(float(np.exp(value)), 1), round(float(np.sqrt(distance(value))), 8)


def derive():
    for name, digest in SOURCE_HASHES.items():
        if hashlib.sha256((ROOT/name).read_bytes()).hexdigest() != digest:
            raise ValueError(f'CIE source hash mismatch: {name}')
    cmf = np.loadtxt(ROOT/'CIE_xyz_1931_2deg.csv', delimiter=',')
    tables = {name: np.loadtxt(ROOT/name, delimiter=',') for name in
              ('CIE_illum_LEDs_1nm.csv', 'CIE_illum_HPs.csv')}
    result = []
    for identity, filename, source_id, column in SELECTION:
        table = tables[filename]
        power = np.interp(cmf[:, 0], table[:, 0], table[:, column], left=0., right=0.)
        xyz = power@cmf[:, 1:]  # 1 nm rectangular integration; zero at both ends.
        xyz /= xyz[1]
        raw = XYZ_TO_RGB@xyz
        nonnegative = np.maximum(raw, 0.)
        rgb = nonnegative/(nonnegative@LUMA)
        cct, uv_distance = approximate_cct(xyz, cmf)
        result.append({'id': identity, 'source_file': filename, 'source_column': source_id,
            'xyz_y1': np.round(xyz, 12).tolist(), 'xy': np.round(xyz[:2]/xyz.sum(), 12).tolist(),
            'cct_approx_kelvin': cct, 'planckian_uv_distance': uv_distance,
            'rgb_before_nonnegative_projection': np.round(raw, 12).tolist(),
            'linear_rgb_y1': np.round(rgb, 12).tolist()})
    return {'schema': 1, 'data_license': 'CC-BY-SA-4.0',
        'attribution': 'Derived from International Commission on Illumination (CIE) datasets; see ../lamp-spectra.md.',
        'source_base_url': 'https://files.cie.co.at/Publications-datasets/',
        'source_sha256': SOURCE_HASHES, 'luma': LUMA.tolist(),
        'xyz_to_linear_srgb': XYZ_TO_RGB.tolist(), 'lamps': result}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--write', action='store_true')
    group.add_argument('--check', action='store_true')
    args = parser.parse_args()
    result = derive()
    if args.write:
        (ROOT/'palette.json').write_text(json.dumps(result, indent=2)+'\n')
    if args.check:
        saved = json.loads((ROOT/'palette.json').read_text())
        if result != saved:
            raise ValueError('Derived reference differs from palette.json')
        path = ROOT.parents[1]/'scripts/engine/lampspectra.py'
        spec = importlib.util.spec_from_file_location('lampspectra', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        expected = np.array([lamp['linear_rgb_y1'] for lamp in result['lamps']], np.float32)
        if module.LAMP_IDS != tuple(lamp['id'] for lamp in result['lamps']):
            raise ValueError('Runtime lamp IDs differ from reference')
        np.testing.assert_array_equal(module.LINEAR_PALETTE, expected)
        np.testing.assert_array_equal(module.LUMA, LUMA.astype(np.float32))
        print('Source hashes, reference derivation and runtime palette verified.')
    else:
        print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
