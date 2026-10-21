"""Offline, equal-luminance lamp colors derived from CIE reference spectra.

Python code: repository MIT license. Derived numerical palette: CC BY-SA 4.0,
attributed to the International Commission on Illumination (CIE), 2018/2019.
https://creativecommons.org/licenses/by-sa/4.0/

Sources, licenses, original hashes, actual spectral CCTs and reproducible
conversion: references/lamp-spectra.md and references/lamp-spectra/derive.py.
DOIs: 10.25039/CIE.DS.dhcw57sd, 10.25039/CIE.DS.f6rvvnev,
10.25039/CIE.DS.xvudnb9b. CIE does not endorse this renderer.

IDs denote nominal families, not exact Kelvin targets or a fixture inventory.
These are photopic emission colors, not blackbody guesses, measured city CCTs,
or spectra for wavelength-dependent scattering. Mix in linear space. Values
above one are intentional; exposure and display encoding belong downstream.
"""
import numpy as np


LAMP_IDS = ('sodium', 'led_2700', 'led_3000', 'led_4000', 'led_5000', 'metal_halide')
LUMA = np.array([.2126, .7152, .0722], np.float32)
# CIE HP1, LED-B1/B2/B3/B4, HP4. Approximate spectral CCTs, respectively:
# 1962.3, 2733.3, 2997.5, 4102.7, 5109.1, 4004.3 K. See the reference method.
# CIE XYZ -> linear sRGB; negative HP1 blue (-1.54e-5) projected to zero;
# then normalize each row to RGB @ LUMA == 1. No high clipping or gamma.
LINEAR_PALETTE = np.array([
    [2.558904552847, .637551582864, 0.],
    [1.919555549781, .806266015542, .211371686997],
    [1.779284357473, .840392849400, .286359829784],
    [1.394624109866, .926309121623, .567958870609],
    [1.191388714467, .965407652793, .779102576547],
    [1.401032302721, .929469926662, .517778959738],
], np.float32)
LUMA.setflags(write=False)
LINEAR_PALETTE.setflags(write=False)
