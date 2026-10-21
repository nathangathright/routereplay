# Shared lunar lighting

`style.moonlight` controls one lunar source shared by clouds, terrain, ocean and Cycles aircraft. Cloud transport supports both layered and joint modes. Its default is 4000, an explicit cinematic multiplier on a much weaker reference lunar flux. Set it to 1 for the unboosted model, 0 to disable it, or another value up to 20000. These scene-relative values are not calibrated exposure or photometry. Solar shading, city emission, weather density, aircraft depth and the exposure curve retain their existing contracts. Lunar light changes radiance, not medium density; inserting lunar shadow crossings can slightly improve numerical view integration. The older `cloud_moonlight` key is accepted as an alias and normalized to `moonlight`; conflicting values are rejected.

## Geometry and flux

The source reuses the finite-distance Moon and Sun ephemerides used by the visible lunar disc. Physical UTC drives astronomy; weather UTC drives cloud attenuation. Each shaded point has its own topocentric Moon direction, phase angle and inverse-square distance factor. A nonlinear phase-brightness law makes quarter Moon much dimmer than half of full Moon. A near-new taper removes the residual empirical-fit floor.

Lunar horizon visibility uses the apparent disc area above a spherical Earth limb. The sample's displayed height is converted back to physical altitude before geometry is evaluated, so cinematic cloud elevation cannot make a geometrically hidden Moon illuminate clouds. The uniform-disc horizon approximation does not resolve the crescent's orientation at the limb. Atmospheric refraction and earthshine are omitted. Surface and aircraft direct light additionally sample nearby terrain for lunar mountain shadows.

An approximate eclipse calculation attenuates the source when Earth blocks sunlight reaching the lunar disc. It omits refracted red light during totality. The same eclipse factor applies to illumination across Earth; it does not re-shade the existing visible Moon disc.

## Cloud transport

The dated flux scales the existing finite-order volume scattering source. Direct light follows the topocentric Moon direction through the live cloud density and curved RGB atmospheric extinction. Sky light reuses the three-direction atmospheric lookup, oriented toward the Moon and attenuated through the same clouds. Local lunar-disc visibility scales both terms once; lunar twilight after moonset is deliberately omitted. The lookup and extinction retain the renderer's cinematic height conventions.

Incident lunar RGB is neutral before atmospheric attenuation, not a measured spectrum. Direct light can redden near the horizon; scattered sky light can add blue. There is no fixed blue ambient floor or additional night mask. Moonlight still contributes weakly during daytime when it is above the horizon.

## Terrain, ocean and aircraft

The shared incident-light helper applies phase, distance, horizon visibility, cinematic gain and direct air/cloud extinction once. Terrain uses its relief normal for diffuse reflection. Ocean reflection uses the existing GGX water lobe with neutral lunar input, so the highlight follows the Moon and viewing direction. Its roughness is an artistic constant, not dated wind data.

Cycles receives the same incident RGB and topocentric direction at the physical aircraft anchor, transformed into camera coordinates. A finite-angle directional light casts mesh self-shadows; its angular diameter follows lunar distance. The sampled illumination is uniform across the metre-scale aircraft. Lunar fields enter aircraft deduplication, and source/config hashes invalidate older work caches. The explicit 2D diagram mode remains a layout proof, not a lunar material/shadow proof.

When moonlight is enabled, terrain and aircraft retain 20% of their old artificial night fill for readability. At zero, legacy fill returns. Consequently comparing zero against a positive gain includes this fill change; comparing positive gains isolates flux scaling. Daytime Sun illumination and city emission are unaffected. A Moon below the horizon adds zero direct light, leaving a darker night rather than an unmotivated fill.

Cloud rays use the existing exaggerated-height density field, recovering physical height before remapping to that field. Atmospheric extinction retains the renderer's cinematic height convention. The camera-facing atmosphere now scatters lunar light in both layered and joint modes, clipped by the same terrain/aircraft depth as sunlight. Topocentric lunar visibility uses physical air height (displayed air height divided by 7.2). Direct Moon rays see shared air, optional aerosol and cloud extinction. Parallel geocentric shadow crossings refine the view quadrature; source evaluation still uses finite-distance geometry. This is scattered light, not a screen-space halo. Layered air still sits in front of its separate cloud layer; joint mode shares view extinction.

Terrain and aircraft lunar shadows sample 16 exponentially spaced physical ray distances from 20 m to 50 km. The finite lunar disc smooths the sampled horizon. A 2 m origin bias avoids self-intersection; narrow unsampled ridges and terrain beyond 50 km can be missed. These shadows use physical metres and the same local DEM/survey sampler as aircraft clearance, never cinematic terrain height.

Tilted land surfaces receive one bounded local diffuse bounce. Its unresolved neighbor is assumed to share the receiver's albedo, its view factor is capped at 0.18, and the result scales with the square of albedo and actual horizontal lunar illumination. Flat ground and a hidden Moon produce no ground bounce. This is a local radiosity approximation, not a traced terrain-to-terrain path or measured indirect light. Aircraft receive direct lunar light and nearby terrain blocking; their indirect environment remains the existing modeled reflection approximation.

## Verification

Use matched frames with the Moon above and below the horizon, different phases, and eclipse geometry. Check the unboosted reference as well as the cinematic setting. Weather, camera and exposure must remain fixed within each pair. Rebuild Cycles frames separately for each setting; toggling the globe setting against a reused aircraft cache cannot validate aircraft illumination. Tests verify deterministic queries, phase and distance limits, horizon and eclipse extinction, independent physical/weather clocks, source scaling, depth termination, bounded bounce, ridge blocking and unchanged physical extinction.

## Sources and approximation

The reference full-Moon flux is 2.5×10⁻⁶ of sunlight at 1 AU. NASA's [Moon fact sheet](https://nssdc.gsfc.nasa.gov/planetary/factsheet/moonfact.html) and [Sun fact sheet](https://nssdc.gsfc.nasa.gov/planetary/factsheet/sunfact.html) give the approximate visual magnitudes and body dimensions used for this scale. The default gain therefore raises reference full-Moon illumination to roughly 1% of the Sun before attenuation.

[Krisciunas and Schaefer (1991), equation 9](https://articles.adsabs.harvard.edu/pdf/1991PASP..103.1033K) supplies the nonlinear visual phase curve. Quarter Moon is approximately 9% of full brightness in this model. The published opposition enhancement is omitted, and the taper beyond 150° phase angle is our extrapolation. The RGB source is a visual-band approximation rather than a spectral integration.

[ERFA Moon98](https://github.com/liberfa/erfa/blob/master/src/moon98.c), derived from SOFA, provides the lunar position. The existing ephemeris assumes UT1=UTC and zero polar motion, omitting light-time and aberration. Eclipse attenuation averages finite Sun/Earth disc overlap at 128 samples on the geocentrically visible lunar hemisphere. [NASA's eclipse appearance discussion](https://eclipse.gsfc.nasa.gov/LEcat5/appearance.html) describes the refracted light omitted during totality.
