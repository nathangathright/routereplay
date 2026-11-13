# Licensed asset and dependency inventory

Credits are served as plain text at `/acknowledgments`, from `src/server/acknowledgments.txt`. A small info icon in the homepage's bottom-right corner opens it in a new tab. Asset credits also ship in `public/assets/<version>/manifest.json`, separate from user journey specs. When a dependency or asset changes, update `acknowledgments.txt`; a test checks that every package in `package.json` `dependencies` is credited.
- **NASA imagery:** public domain, as a work of the US government (17 U.S.C. § 105), so no on-page credit is required. NASA asks for acknowledgment as a courtesy, and `/acknowledgments` provides it. NASA's logo must not be used, and nothing may imply NASA's endorsement.
- **NOAA elevation (ETOPO 2022):** public domain, also a US government work. `/acknowledgments` credits NOAA's National Centers for Environmental Information with the dataset's DOI, as NOAA asks.
- **Font:** Barlow Condensed's license, `BarlowCondensed-OFL.txt`, ships beside the font file.
- **Airport data:** `/acknowledgments` carries the MIT notice for mwgg/Airports.
- **MIT packages:** `/acknowledgments` carries each copyright line and the MIT permission notice, since the minified bundle drops license comments.

The pages carry no credit line beyond the homepage's info icon.

## Static assets (`public/assets/2026-11-12/`)

| File(s) | Source | License | Credit |
| --- | --- | --- | --- |
| `earth-day-<MM>-4096.webp`, `earth-day-<MM>-8192.webp` (MM = 01–12) | [Blue Marble: Next Generation base map](https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-map/), one 2004 composite per month, from the 21600×10800 (2 km per pixel) JPEGs on `assets.science.nasa.gov` | Public domain (NASA) | Reto Stöckli and Robert Simmon, NASA Earth Observatory |
| `earth-night-low.webp`, `earth-night-standard.webp` | [Black Marble 2016](https://commons.wikimedia.org/wiki/File:BlackMarble20161km.jpg) (NASA Earth Observatory, via Wikimedia Commons) at full resolution (43200×21600, 279 MB, SHA-1 checked against Commons), turned by `scripts/build-textures.py` into one channel of city-light level and averaged to 3600×1800 (standard, 244 KiB) and 2048×1024 (low, 100 KiB), lossless WebP | Public domain (NASA) | NASA Earth Observatory images by Joshua Stevens, using Suomi NPP VIIRS data from Miguel Román, NASA GSFC |
| `earth-night-detail-standard/`, `earth-night-detail-low/` (`N50W005.webp` and so on) | The same [Black Marble 2016](https://commons.wikimedia.org/wiki/File:BlackMarble20161km.jpg) at full resolution (43200×21600, 279 MB, SHA-1 checked against Commons), cut by `scripts/build-textures.py` into 5° tiles of the same light level: 1,213 tiles each, one per cell with any light. Standard is 608×608 (8.8 MiB in all), low 304×304 (3.1 MiB), lossless WebP | Public domain (NASA) | As for the night map |
| `earth-water-4096.webp`, `earth-water-8192.webp` | [Natural Earth](https://www.naturalearthdata.com/) 1:10m land, minor islands, Antarctic ice shelves, and lakes, rasterized by `scripts/build-textures.py` to four-level masks the size of each day texture: 4096×2048 (83 KiB) and 8192×4096 (205 KiB), lossless WebP | Public domain | Made with Natural Earth |
| `earth-relief-low.webp`, `earth-relief-standard.webp` | [ETOPO 2022](https://www.ncei.noaa.gov/products/etopo-global-relief-model) 15 arc-second global relief, read every 10th cell through [NOAA ERDDAP](https://coastwatch.pfeg.noaa.gov/erddap/griddap/ETOPO_2022_v1_15s.html) and turned by `scripts/build-textures.py` into the ground's normal at 12× relief: 4320×2160 (standard, 1,871 KiB) and 2160×1080 (low, 393 KiB), lossless WebP. Lakes come from Natural Earth's outlines | Public domain (NOAA) | NOAA National Centers for Environmental Information |
| `BarlowCondensed-SemiBold.ttf`, `BarlowCondensed-OFL.txt` | [Google Fonts Barlow Condensed](https://github.com/google/fonts/tree/main/ofl/barlowcondensed), copied unmodified (107 KiB, 51 KiB gzipped). The split-flap airport codes, standing in for the offline renderer's DIN Condensed Bold, which Apple doesn't license for redistribution. Added November 12, 2026; it joins this directory because it adds files and changes none. It replaced Dosis, which was removed from this directory on November 13, 2026, once nothing loaded it (no users yet, so no page still runs a build that did) | SIL Open Font License 1.1 (no Reserved Font Name) | The Barlow Project Authors |
| Aircraft models | Original procedural geometry built in code (`src/app/render/airframe.ts`) from published dimensions ([aircraft.md](aircraft.md)) | Project license | Dimensions from the manufacturers' airport planning documents |
| Train, bus, car, and ferry models | Original procedural geometry built in code (`src/app/render/vehicles.ts`) | Project license | Generic shapes, not any operator's vehicle |
| Star field | Generated from the scene seed | — | — |

`scripts/build-textures.py` downloads the sources into `.cache/textures`, builds the directory named by `ASSET_MANIFEST_VERSION` in `src/shared/scene/constants.ts`, copies the font and its license forward from the previous directory, and writes the manifest with SHA-256 hashes (`tests/surface.test.ts` checks them). It never touches older directories. NASA's own host (`assets.science.nasa.gov`, where the offline renderer also gets Blue Marble) was reachable on November 12, 2026; the night image still comes from Commons.

**Day texture choices** (November 12, 2026):

- **Monthly.** A journey shows the month of its first departure in the origin's local time (`journeySurfaceMonth`, from `departureLocal`), as the offline renderer does. The homepage shows the current UTC month. Only that month downloads. These are 2004 seasonal composites, not imagery from the trip date.
- **Base map, without topography or bathymetry.** The previous texture had both. Its shaded relief is lit from a fixed direction, which contradicts the scene's moving Sun. Its bathymetry draws sea-floor features that can't be seen from space, such as the Mendocino Fracture Zone as a hard line in the Pacific off San Francisco, right where journeys zoom in. The base map's oceans are a uniform dark navy, and mountains look flatter without the baked shading.
- **Two widths.** 8192×4096 gives about 1,300 texels per radian, which matches the close airport zoom (a 1,300-pixel globe radius on a 1,080-pixel short side). 4096×2048 is the low set for phones and the homepage's first paint. Standard quality falls back to 4096 where `MAX_TEXTURE_SIZE` is under 8192 (`dayTextureWidth`). WebP at quality 82 is about a third smaller than JPEG at the same setting; every browser with WebGL 2 decodes it. See [budgets.md](budgets.md) for sizes and GPU memory.

**Water mask choices** (November 12, 2026):

- **Texel for texel with the day texture.** The mask marks open water for sun glint and sky reflection. The 2048×1024 mask from 1:50m outlines put each texel 20 km across, so at airport zoom the glint ended at a blurred, misplaced coastline (cut off along eastern Cuba, for example). Each width now has its own mask, loaded with the day texture of the same width, from 1:10m outlines, whose detail (about 5 km) matches an 8192 texel.
- **What counts as land.** Natural Earth's minor islands (Bahamian cays, Florida Keys) and Antarctic ice shelves are added to its land. The day map shows the ice shelves white, so they shouldn't glint. Shallow banks, such as the Bahamas', stay water.
- **Four levels, lossless WebP.** Each texel is the share of a 4×4 supersample that is water, rounded to four levels, so the filtered edge falls within a quarter texel. Keeping all 17 levels smoothed the edge only slightly at the closest zoom for 60 % more bytes. Lossless WebP is about a fifth smaller than the same image as a PNG.
- **One channel on the GPU.** The loader keeps only the red channel (`RedFormat`), a quarter of the memory RGBA would take.
- **Same directory.** The masks have new names and every other file is unchanged, so they joined `2026-11-12`. The 2048×1024 `earth-water.png` they replace was removed rather than kept for pages still running the build that loaded it: with no users yet, there are none.

**Relief map choices** (November 12, 2026):

- **What it holds.** Not heights but the ground's normal: heights clamped at sea level and exaggerated 12× (the offline renderer's `relief_exaggeration`), as the normal's east component in red and north in green, stored as 128 + 127 × component and rounded to steps of 3. A normal map needs one texture read per pixel, and the GPU's filtering and mipmaps average normals, so distant views flatten correctly. A height map would need neighbouring reads matched to each mip level, and handling for the date line and poles in the shader.
- **Resolution.** Standard is the offline renderer's 5-arc-minute grid, 9.3 km at the equator: about 7 screen pixels per texel at the closest airport zoom and about one mid-flight. Each texel averages 2×2 samples taken every 2.5 arc minutes, or 4×4 for low. Low (18.5 km) suits phones, which render at a device pixel ratio of 1 (about 3.7 km per pixel at the closest zoom). 2880×1440 would halve the standard file, but mountains at the airport zoom turn noticeably softer.
- **Encoding.** Lossless WebP. Lossy WebP small enough to matter flattened gentle relief and drew block edges over the Sahara. Heights instead of normals came out about as large at matching precision (as a 16-bit PNG, or as deltas compressed with xz), and browsers can't upload a 16-bit PNG to WebGL as it is. Rounding to steps of 3 looked the same as unrounded normals in low-Sun tests and is a third smaller than steps of 1.
- **Water.** Oceans are flat because heights are clamped at sea level. ETOPO 2022 has the floors of some lakes (Baikal, the Great Lakes, the Caspian) instead of their surfaces, which would draw cliffs along their shores, so Natural Earth's 1:10m lakes (the water mask's), widened by a texel, are flat as well. The shader also keeps the sphere's normal wherever the water mask says water.
- **Poles.** A texel row spans less ground east to west toward the poles, so each row is averaged over about one texel's north–south length before slopes are taken.

**Night map choices** (November 13, 2026):

- **One light level, computed once.** The night maps and the night-detail tiles hold the same thing, one channel of city-light level proportional to the light emitted, computed per pixel of the full-resolution source (`night_light_level`). The global maps are that level averaged over 12 × 12 source pixels (standard) or about 21 × 21 (low), so they are exactly the tiles averaged (within 0.2/255 in tests over London, New York, and Delhi), and the hand-off between them can't change brightness. Until November 12 the maps were the colour image itself, a 3840-pixel Commons thumbnail, and the shader computed the level per texel; that thumbnail is no longer used.
- **The level.** NASA drew the lights over a faint bluish moonlit land, dim orange through yellow to white as they brighten. Their brightness is the pixel's luma above the land under them: NASA's grayscale Black Marble (lights only, the offline renderer's source) matches (luma − 0.114) / 0.886 within a few levels from dim orange to white. Faint lights are told from the land by their warmth, red less 0.55 × blue above 0.06, over 0.39, the test the shader used to make on its own. The lesser of the two counts, so the land drops out and every brighter light keeps its luma.
- **Why it changed.** The shader's old level was the warmth test alone, and warmth peaks at bright orange and falls toward white, so bright suburbs and white city centres both clipped to full level: a third of all lit pixels, which at 1 km made every city one flat cream. Now 10.5 % are at full level (where the source itself is white), and the median lit pixel gives 0.46 of the old full level's light (with the emission raised to keep the total) instead of 0.60.
- **No curve.** The level is the gray value as it is. The offline renderer raises NASA's gray to the power 0.82, which lifts suburbs toward their centres; 1.2 separated them more but lost the faintest towns and dimmed the scene by 12–16 %. City-light emission is raised to keep the world's total light ([decisions](decisions.md#city-lights-with-their-gradation)).
- **One channel, lossless.** Like the tiles: lossless WebP, uploaded as R8. Smaller than the JPEGs they replace (244 against 434 KiB, 100 against 129 KiB) and a quarter of their GPU memory.
- **Smooth where magnified.** The shader samples the global map through a cubic B-spline where it is magnified (the frame's edges near airports, beyond the detailed area), because bilinear sampling of a level map draws its 11 km texel grid as soft squares.

**Night-detail tile choices** (November 12, 2026):

- **Why.** At the closest airport framing a screen pixel is about 1.35 km, and the global night map's texel 11 km (standard) or 20 km (low), so towns drew as soft squares. The full-resolution Black Marble is 0.93 km per pixel; the whole map at that resolution is far too large to ship, but each journey only comes close to a few places, and the camera says which in advance ([decisions](decisions.md#sharp-city-lights-near-airports)).
- **What a tile holds.** One channel: the light level (see the night map choices above), per source pixel, stored as 0–255. It is proportional to emitted light, so the GPU's filtering and mipmaps average it correctly, and the global maps are these tiles averaged.
- **Layout.** 5° × 5° cells in latitude and longitude, named by their south-west corner (`N50W005` is 50–55°N, 5°W–0°). Each tile repeats 4 pixels (2 at low) of its neighbours on every side, so filtering is seamless across tile edges at the closest zoom; the poles repeat their edge row and longitude wraps. Standard keeps every source pixel (600 + 8 square); low averages 2 × 2 (300 + 4), for phones, whose pixels are about 3.7 km at the closest zoom.
- **Which cells.** Only cells with any light at all (1,213 of 2,592). Some hold only a few bright specks at sea, which the global map shows too; they are kept, so a tile's absence means darkness. `src/shared/scene/nightTiles.ts` (generated with the tiles) lists the cells as a bitmask, so journeys request only tiles that exist.
- **Encoding.** Lossless WebP. The tiles are mostly black, so lossy WebP at quality 90 came out barely smaller (53 against 55 KiB for London's tile), and lossy coding rings around bright cities: the level is stored in linear light, where an error of 1/255 near black can show as about 25/255 on screen. JPEG was larger still. Tiles average 7.4 KiB; dense ones reach about 146 KiB (the Ganges plain).
- **Manifest.** Each directory is one record, whose hash is the SHA-256 of a `sha256sum`-style listing of its tiles (`tests/surface.test.ts` recomputes it).
- **Building.** `python3 -I scripts/build-textures.py night night-detail` rebuilds the night maps, the tiles, and their records (about 4 minutes on 10 cores; decoding the source takes about 4 GB of memory). The other parts can be rebuilt the same way: `day`, `water`, `relief`. A partial build drops manifest records whose files are gone.

**Which directory loads.** Pages load the current `ASSET_MANIFEST_VERSION`, not the version a record pinned: the shaders are tuned for the current textures, and one maintainer supports one renderer at a time. The pinned version records what the journey was saved with. Old directories stay deployed so a page still running an earlier build keeps finding its files, and the published fixture's directory is checked to exist.

## Link-preview images (`public/share/`)

`home.jpg` (the homepage's tagline over the globe) and `journey.jpg` (the globe alone, used for every watch page) are 1200×630 screenshots of the homepage, made with `node scripts/browser/share-cards.mjs`. They show the static assets above, so they carry the same credits. `apple-touch-icon.png` is `favicon.svg` rendered at 180×180 on the page background. Chat apps cache preview images by URL, so give a replacement image a new file name and update `index.html` and `src/server/share.ts` to match.

## Weather (`/api/v1/weather/gfs/{cycle}/{hour}`)

| Source | License | Use |
| --- | --- | --- |
| [NOAA GFS on AWS Open Data](https://registry.opendata.aws/noaa-gfs-bdp-pds/) (`noaa-gfs-bdp-pds`), 1° `pgrb2.1p00` files | Public domain (NOAA data "can be used as desired"; NOAA asks for attribution, which `/acknowledgments` gives) | Total cloud water (`CWAT`) draws the clouds; the 700 hPa wind (`UGRD`, `VGRD`) moves them between time steps |

- Each response is three GRIB2 messages cut from one forecast file by HTTP range request, about 240 KB. The Worker only fetches and caches them; the browser decodes them (`src/shared/weather/grib2.ts`).
- Coverage: cycles from 12 UTC on 22 March 2021 (GFS v16; earlier files have a different layout and no analysis cloud fields) to 384 hours after the run a scene pinned when it was saved. Outside that, no clouds are drawn and agents get a `no_cloud_data` warning.
- These are model fields, not observations: the analysis for past times and a forecast for later ones. The pages say so.

## Airport lookup (`src/server/airports/airports.json`)

| Source | License | Use |
| --- | --- | --- |
| [OurAirports](https://ourairports.com/data/) `airports.csv` | Public domain | IATA codes, names, coordinates, service flags |
| [mwgg/Airports](https://github.com/mwgg/Airports) | MIT | IANA time zones |
| [@photostructure/tz-lookup](https://github.com/photostructure/tz-lookup) (build time only) | CC0-1.0 | Coordinate time-zone fallback for 278 airports missing a zone |

The table contains 5,405 airports: every IATA-coded large or medium airport, plus smaller ones with scheduled service. Its version (`YYYY-MM-DD.<source hash>`) is pinned into every normalized record. Rebuild with `npm run assets:airports`. `npm run gen` (part of test, typecheck, and build) turns it into one tab-separated string in `src/server/generated/airports.ts`, which the Worker binary-searches; see [Worker CPU](decisions.md#worker-cpu-within-the-free-plan).

## Runtime dependencies

| Package | License | Notes |
| --- | --- | --- |
| react, react-dom | MIT | |
| three | MIT | |
| @react-three/fiber | MIT | |
| remotion, @remotion/player, @remotion/three, @remotion/web-renderer | Remotion License | See below |
| mediabunny (via @remotion/web-renderer) | MPL-2.0 | Unmodified, bundled |
| @mediabunny/aac-encoder, flac-encoder, mp3-encoder | MPL-2.0, wrapping FFmpeg's AAC encoder and LAME (LGPL) and libFLAC (BSD) | **Not shipped.** Exports are silent (`muted: true`), so the web renderer never loads them; `vite.config.ts` aliases them to `src/app/noAudioEncoders.ts`. If exports ever gain audio, remove the alias and credit them |
| Bundled transitive packages: scheduler, use-sync-external-store, its-fine, react-use-measure, suspend-react, zustand | MIT | Checked against a production build's module list on November 11, 2026 |

## Remotion license

Checked on November 11, 2026 against [LICENSE.md](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md) and the [license FAQ](https://www.remotion.dev/docs/license/faq):

- The Free License covers "an individual, whether for personal or commercial use", for-profit organizations with up to 3 employees, and non-profits.
- The FAQ lists "Allowing users to create and render their own personalized video based on your Remotion template" as accepted use. That is what Route Replay's export does.
- Route Replay Web is maintained by one individual, so it qualifies. `src/app/export.ts` passes `licenseKey: 'free-license'`. Set `VITE_REMOTION_LICENSE_KEY` to a Company License key if ownership changes (for example, an organization with more than 3 employees takes over). Recheck on major Remotion upgrades.

Client-side rendering sends telemetry to Remotion that cannot be disabled ("we see which domains render how many videos"). The usage event includes the page origin and whether the render succeeded, never journey data. The CSP allows `https://www.remotion.pro` so the event can be sent. Mention this in the privacy notes.
