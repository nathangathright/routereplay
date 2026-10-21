# Cloud lighting

The default `style.cloud_lighting=1` shades the existing weather-constrained volume using its optical depth. It changes source light only. Weather, density, advection, geometry, camera exposure and view-path opacity are unchanged. `0` selects the earlier pseudo-normal shading and fixed ambient color; values between 0 and 1 blend the two source terms. City illumination is added separately in both cases.

## Solar light

The primary phase is a normalized mixture of 65% isotropic and 35% Henyey–Greenstein scattering. Rays point from the camera toward a sample, so the phase cosine is `dot(ray, sample_to_sun)`: positive one means looking toward the Sun. The atmosphere's scene-relative solar scale supplies the radiance normalization.

Three finite secondary terms halve effective cloud optical depth and phase anisotropy per order. Their weights decrease geometrically, with a bounded ratio controlled by `cloud_multiple_scattering` and the Sun-path interaction probability. This improves penetration without a uniform ambient floor. Clear-air RGB transmission and solar-disc visibility multiply the completed series exactly once. Reddening is preserved, and the source vanishes in the opaque limit or with no incident Sun.

This is a local approximation using one Sun-path integral, not a calibrated, energy-conserving solution for all scattering paths. At maximum cinematic settings it remains finite but can exceed a physical energy budget.

## Sky light

An immutable lookup samples the existing curved-atmosphere integrator across 15 displayed heights and 29 solar elevations. It provides radiance toward the zenith and at 45 degrees toward/away from the Sun's horizontal bearing. The three positive solid-angle weights total `2π`; the cloud phase includes its `1/(4π)` normalization. Bilinear lookup interpolation is continuous, and the side directions smoothly collapse toward zenith near solar zenith/nadir where horizontal bearing is undefined.

At each occupied cloud sample, live paths through the same weather density attenuate the three incoming sky directions. A bounded blend of direct and more diffuse penetration tends to zero in thick cloud. Physical UTC still determines the Sun, while weather UTC moves the density. No temporal accumulation or frame-order state is involved.

The lookup follows the atmosphere's existing cinematic height convention. It approximates the upper hemisphere with three directions; it omits below-horizontal sky visible from altitude, neighboring-cloud bounce and calibrated airglow. [Lunar illumination](moonlight.md) reuses this lookup, scaled by dated lunar flux, and is added independently. Cloud without solar, lunar or city illumination remains dark.

## Cost and deployment

The lookup is created locally once per atmosphere-style combination and cached for at most four combinations per process. No extra dataset, network service, GPU requirement or external runtime is added. Directional cloud paths use the existing density, with sample count derived from the selected quality profile. Removing fake-normal evaluation saves some density-gradient work; measure matched frames to determine the net cost on a particular machine.

Layered and joint transport share the source helper. The layered path now includes clear-air Sun attenuation for cloud illumination; the atmosphere's view attenuation remains a separate pass. Joint transport retains combined view extinction and its existing solar integrals. Neither path changes view termination at the aircraft or terrain.

## Research basis

Guerrilla's [Nubis Evolved](https://www.guerrilla-games.com/read/nubis-evolved) discusses separate direct and secondary cloud scattering. [Nubis³](https://www.guerrilla-games.com/read/nubis-cubed) discusses directional ambient attenuation and cloud-specific lighting. The finite-order series and small atmosphere lookup implemented here are local adaptations, not a reproduction of Guerrilla's renderer.

Validation should compare identical daylight, sunset and city-lit night frames, then a moving twilight sequence. Numeric checks cover unchanged transmission and depth clipping, color and visibility factors, finite HDR, dark limits, continuous sky interpolation and deterministic reordered queries. Keep cloud-shape changes out of this comparison.
