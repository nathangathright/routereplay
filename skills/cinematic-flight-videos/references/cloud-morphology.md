# Cloud morphology

`style.cloud_morphology=1` reconstructs rounded billows with gaps from forecast coverage, condensate and layer heights. `0` selects the earlier value-noise sheets and long-lived material coordinates for comparisons. This is a discrete choice, independent of cloud lighting and exposure.

## Shape and motion

A deterministic periodic cellular texture supplies rounded lobes. A second cellular frequency softly erodes their edges; smooth value noise varies the larger structure. Low, middle and high layers use different horizontal scales and radial stretching, giving the volume variation through its depth. Coverage carves openings instead of leaving an unconditional opacity floor. Billow structure also varies the upper envelope.

Two Earth-coordinate material charts follow the forecast winds. Their origins advance every two hours, anchored to the bundle's verified coverage start. Smooth weights blend their finished densities, with zero slope at each transition. No chart accumulates more than four hours of deformation. This prevents small procedural features from stretching indefinitely during long trips. With zero wind, both charts sample the same stationary texture.

Immutable half-degree maps accelerate the forecast and material lookups. Density itself is evaluated continuously at each ray sample. Camera extinction, aircraft occlusion, Sun and Moon attenuation, sky paths and ground shadows all query this same reconstruction. Both transport modes and all quality profiles share it. Frame order does not change the result, and wind queries stay within verified coverage.

## Limits and validation

Individual billows and their lifetimes are artistic choices, not observed cloud geometry. GFS supplies the larger coverage, condensate, height and wind structure. Coverage carving changes the reconstructed optical mass, especially for broken cloud; a bounded compensation reduces that effect but does not normalize each column. Finite cloud steps, texture interpolation and the material maps limit the smallest reliable features. The model does not simulate fluid dynamics, precipitation or microphysics.

Compare matched full-globe and approach frames, then moving twilight and arrival segments. Keep astronomy, weather times, exposure, camera and lighting controls fixed. Numerical checks cover sparse-cloud gaps, vertical structure, periodic texture seams, zero-wind stationarity, bounded history, continuous chart renewal, deterministic frame order and shared extinction. Preserve earlier films when changing this default.

The design follows the broad shape/detail separation discussed in Guerrilla's [Nubis Evolved](https://www.guerrilla-games.com/read/nubis-evolved) and [Nubis³](https://www.guerrilla-games.com/read/nubis-cubed). The cellular reconstruction and short-lived material charts here are local implementations, not reproductions of those renderers.
