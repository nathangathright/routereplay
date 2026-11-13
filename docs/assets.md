# Licensed asset and dependency inventory

Credits are served as plain text at `/acknowledgments`, from `src/server/acknowledgments.txt`. A small info icon in the homepage's bottom-right corner opens it in a new tab. Asset credits also ship in `public/assets/<version>/manifest.json`, separate from user journey specs. When a dependency or asset changes, update `acknowledgments.txt`; a test checks that every package in `package.json` `dependencies` is credited.
- **NASA imagery:** public domain, as a work of the US government (17 U.S.C. § 105), so no on-page credit is required. NASA asks for acknowledgment as a courtesy, and `/acknowledgments` provides it. NASA's logo must not be used, and nothing may imply NASA's endorsement.
- **Dosis:** the font's license, `OFL.txt`, ships beside the font file.
- **Airport data:** `/acknowledgments` carries the MIT notice for mwgg/Airports.
- **MIT packages:** `/acknowledgments` carries each copyright line and the MIT permission notice, since the minified bundle drops license comments.

The pages carry no credit line beyond the homepage's info icon.

## Static assets (`public/assets/2026-11-12/`)

| File(s) | Source | License | Credit |
| --- | --- | --- | --- |
| `earth-day-<MM>-4096.webp`, `earth-day-<MM>-8192.webp` (MM = 01–12) | [Blue Marble: Next Generation base map](https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-map/), one 2004 composite per month, from the 21600×10800 (2 km per pixel) JPEGs on `assets.science.nasa.gov` | Public domain (NASA) | Reto Stöckli and Robert Simmon, NASA Earth Observatory |
| `earth-night-low.jpg`, `earth-night-standard.jpg` | [Black Marble 2016](https://commons.wikimedia.org/wiki/File:BlackMarble20161km.jpg) (NASA Earth Observatory, via Wikimedia Commons), unchanged from 2026-11-11 | Public domain (NASA) | NASA Earth Observatory images by Joshua Stevens, using Suomi NPP VIIRS data from Miguel Román, NASA GSFC |
| `earth-water.png` | [Natural Earth](https://www.naturalearthdata.com/) 1:50m land and lakes, rasterized by `scripts/build-textures.py` to a 2048×1024, four-level mask (46 KiB) | Public domain | Made with Natural Earth |
| `Dosis-Variable.ttf`, `OFL.txt` | [Google Fonts Dosis](https://github.com/google/fonts/tree/main/ofl/dosis), copied unmodified from the offline `routereplay` repository | SIL Open Font License 1.1 (no Reserved Font Name) | The Dosis Project Authors |
| Aircraft models | Original procedural geometry built in code (`src/app/render/airframe.ts`) from published dimensions ([aircraft.md](aircraft.md)) | Project license | Dimensions from the manufacturers' airport planning documents |
| Star field | Generated from the scene seed | — | — |

`scripts/build-textures.py` downloads the sources into `.cache/textures`, builds the directory named by `ASSET_MANIFEST_VERSION` in `src/shared/scene/constants.ts`, copies the font and its license forward from the previous directory, and writes the manifest with SHA-256 hashes (`tests/surface.test.ts` checks them). It never touches older directories. NASA's own host (`assets.science.nasa.gov`, where the offline renderer also gets Blue Marble) was reachable on November 12, 2026; the night image still comes from Commons.

**Day texture choices** (November 12, 2026):

- **Monthly.** A journey shows the month of its first departure in the origin's local time (`journeySurfaceMonth`, from `departureLocal`), as the offline renderer does. The homepage shows the current UTC month. Only that month downloads. These are 2004 seasonal composites, not imagery from the trip date.
- **Base map, without topography or bathymetry.** The previous texture had both. Its shaded relief is lit from a fixed direction, which contradicts the scene's moving Sun. Its bathymetry draws sea-floor features that can't be seen from space, such as the Mendocino Fracture Zone as a hard line in the Pacific off San Francisco, right where journeys zoom in. The base map's oceans are a uniform dark navy, and mountains look flatter without the baked shading.
- **Two widths.** 8192×4096 gives about 1,300 texels per radian, which matches the close airport zoom (a 1,300-pixel globe radius on a 1,080-pixel short side). 4096×2048 is the low set for phones and the homepage's first paint. Standard quality falls back to 4096 where `MAX_TEXTURE_SIZE` is under 8192 (`dayTextureWidth`). WebP at quality 82 is about a third smaller than JPEG at the same setting; every browser with WebGL 2 decodes it. See [budgets.md](budgets.md) for sizes and GPU memory.

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

The table contains 5,405 airports: every IATA-coded large or medium airport, plus smaller ones with scheduled service. Its version (`YYYY-MM-DD.<source hash>`) is pinned into every normalized record. Rebuild with `npm run assets:airports`.

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
