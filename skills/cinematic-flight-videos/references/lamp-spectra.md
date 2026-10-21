# Reference-spectrum lamp palette

`scripts/engine/lampspectra.py` contains six linear sRGB emission colors, each normalized to unit luminance using the renderer's `LUMA = (0.2126, 0.7152, 0.0722)`. Runtime needs only the small constants and existing NumPy dependency. No spectra are downloaded or integrated during rendering.

These are representative lamp families, not a measured global fixture inventory. A region's mixture, neighborhood variation, schedules and absolute emission remain separate modeled inputs. Historical satellite brightness cannot determine a lamp's spectrum. These RGB values also do not implement spectral atmospheric scattering, material metamerism, color rendering indices or mesopic observer adaptation.

| Runtime ID | CIE reference | CCT from this spectral integration, approximately | Source family |
| --- | --- | ---: | --- |
| `sodium` | HP1 | 1962 K | Standard high-pressure sodium |
| `led_2700` | LED-B1 | 2733 K | Phosphor-converted LED |
| `led_3000` | LED-B2 | 2998 K | Phosphor-converted LED |
| `led_4000` | LED-B3 | 4103 K | Phosphor-converted LED |
| `led_5000` | LED-B4 | 5109 K | Phosphor-converted LED |
| `metal_halide` | HP4 | 4004 K | One high-pressure metal-halide reference |

The LED suffixes are nominal family labels; no spectrum is adjusted to force an exact Kelvin target. HP1 is not low-pressure monochromatic sodium. HP4 is one of several CIE metal-halide references and does not represent every metal-halide fixture. CCT alone does not capture spectral differences or green/magenta offsets.

## Sources and rights

The following original CSV files and their CIE metadata are included unchanged in `lamp-spectra/`. Their SHA-256 hashes appear in `lamp-spectra/palette.json` and are verified by the reproduction tool. The data hashes also match the hashes published in CIE's own metadata.

- CIE 2018, *Relative spectral power distributions of illuminants representing typical LED lamps, 1nm spacing*, International Commission on Illumination, Vienna, Austria. [Dataset and citation](https://cie.co.at/datatable/relative-spectral-power-distributions-illuminants-representing-typical-led-lamps-1nm), [DOI 10.25039/CIE.DS.dhcw57sd](https://doi.org/10.25039/CIE.DS.dhcw57sd). Original source: CIE 015:2018, tables 12.1/12.2 and associated spreadsheet.
- CIE 2018, *Relative spectral power distributions of high pressure discharge lamp illuminants*, International Commission on Illumination, Vienna, Austria. [Dataset and citation](https://cie.co.at/datatable/relative-spectral-power-distributions-high-pressure-discharge-lamp-illuminants), [DOI 10.25039/CIE.DS.f6rvvnev](https://doi.org/10.25039/CIE.DS.f6rvvnev). Original source: CIE 015:2018, table 11.
- CIE 2019, *Colour-matching functions of CIE 1931 standard colorimetric observer*, International Commission on Illumination, Vienna, Austria. [Dataset and citation](https://cie.co.at/datatable/cie-1931-colour-matching-functions-2-degree-observer), [DOI 10.25039/CIE.DS.xvudnb9b](https://doi.org/10.25039/CIE.DS.xvudnb9b). Original source: CIE 018:2019, table 6.

All three datasets' metadata specify **Creative Commons Attribution-ShareAlike 4.0 International**: [license](https://creativecommons.org/licenses/by-sa/4.0/), [legal code](https://creativecommons.org/licenses/by-sa/4.0/legalcode.en). The bundled CIE tables, metadata and derived numerical palette are provided under that license, separately from the repository's MIT Python code. Retain this attribution, source links, license and change description when redistributing or adapting the data. CIE has not endorsed the palette or this renderer.

Changes made to derive the palette: select the six columns above; interpolate the high-pressure data; integrate each spectrum against the standard observer; convert to linear sRGB; project the tiny negative sodium blue component to zero; normalize luminance; round the recorded reference values and store runtime values as float32. `palette.json` records the original XYZ/xy, pre-projection RGB, approximate CCT and final RGB so the numerical changes can be inspected.

## Conversion

1. Use the CIE 1931 2° color-matching functions at 1 nm from 360–830 nm. LED input uses CIE's supplied 1 nm dataset. High-pressure input is linearly interpolated from its 5 nm samples, as its metadata specifies. Source spectra are zero outside their 380–780 nm support; no endpoint extension or invented ultraviolet/infrared power is used.
2. Compute `XYZ = sum(S(lambda) * [x_bar, y_bar, z_bar]) * 1 nm`, then divide by `Y`. This is photopic relative colorimetry, not absolute watts or lumens. The endpoints have zero source power, so rectangular and trapezoidal sums over this grid agree.
3. Apply the XYZ-to-linear-sRGB matrix in equation 7 of the [ICC sRGB characterization](https://registry.color.org/rgb-registry/files/sRGB.pdf). Do not chromatically adapt each lamp to D65: that would remove its emission color. D65 specifies the RGB basis. No display black offset, nonlinear transfer function or exposure is applied to these scene emission values.
4. Project negative RGB components to zero, then divide each RGB row by its dot product with `LUMA`. Only HP1 needs projection: its blue component is approximately −0.00001543 before projection. The slight chromaticity change is recorded rather than hidden. Components above one remain unclipped; the renderer handles display mapping after composition.
5. For descriptive CCT metadata only, find the nearest Planckian chromaticity in CIE 1960 `u,v` space. Planck spectra use SI defining constants and the same 360–830 nm CMFs. A bounded golden-section search covers 1000–25000 K. These calculated CCTs are approximate and are not a claim to reproduce a separately rounded publication table. The recorded distance to the Planckian locus is unsigned.

## Reproduce and validate

From the installed skill directory, run:

```sh
python3 references/lamp-spectra/derive.py --check
```

This is entirely offline. It checks all six original file hashes, recomputes the reference record and checks the runtime palette. `--write` regenerates only `lamp-spectra/palette.json`; it does not silently change renderer code. With no arguments the tool prints the derived record.

Portable tests independently integrate the bundled sources, check fixed spectral/chromaticity anchors, equal-luminance mixing, warm-to-neutral LED ordering, finite nonnegative HDR values, and constant-array write protection. The three CSVs and three metadata files total approximately 105 KB. They are provenance and reproduction inputs; runtime does not read them.
