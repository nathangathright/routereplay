# Milestone-one decisions

These were open questions in [PLAN.md](../PLAN.md). Each records what was decided, why, and what remains to validate.

## Capability handoff, credential storage, recovery, and revocation

**Credentials.** Creating a draft returns two 256-bit bearer tokens: an edit credential (`rr_edit_…`: read and replace) and an owner credential (`rr_owner_…`: also publish, delete, and rotate the edit credential). The prefixes make accidental leaks easy to find with secret scanners. The service stores only SHA-256 hashes. Hashing without a slow KDF is appropriate because the tokens are random, not passwords. Comparisons are constant-time. Ordinary reads never return credentials, and every response carries a `capabilities` object, so agents do not infer authority from URL shape.

**Browser handoff.** The private preview link is `/s/{id}#k={edit credential}`. The fragment is never sent to the server and is excluded from `Referer`. The page:

1. Reads the fragment and immediately removes it with `history.replaceState` before any network request.
2. Calls `POST /api/v1/scenes/{id}/session` with `Authorization: Bearer` and the header `X-RouteReplay-Client: web`.
3. Receives an `HttpOnly; SameSite=Strict; Path=/api/v1/` session cookie (`Secure` on HTTPS) that lasts 7 days. Its random token is also stored only as a hash and is bound to the scene and the role that minted it.

Cookie-authenticated writes require the same custom header and a same-origin `Origin`, which a cross-site form or script cannot produce. Agents cannot mint cookie sessions; they keep using bearer credentials.

**Revocation.** `POST /api/v1/scenes/{id}/credentials/edit` (owner only) replaces the edit credential. It increments the draft's `edit_generation`, which immediately invalidates the old edit credential and every edit browser session. Deleting a draft removes its sessions. `DELETE /api/v1/scenes/{id}/session` signs a browser out.

**Recovery.** None, by design for the first release: there are no accounts. The agent docs tell agents to offer the owner credential to the creator for safekeeping and explain that a lost owner credential cannot be recovered. Losing only the edit credential is recoverable: the owner rotates it. Account-based recovery can be added later without changing the credential model; an account would hold owner capabilities.

**Idempotency.** Create and publish accept an `Idempotency-Key` (16–128 characters), retained for 24 hours. The scope is the operation, plus the draft for publishing. A retry with the same key and body replays the original response; a different body is rejected (`422`), and a concurrent duplicate gets `409 request_in_progress`. The create response contains credentials, so the stored replay is AES-GCM-encrypted with a key derived from the client's idempotency key, which the service never stores. Plaintext credentials never sit in D1.

**Still to validate:** whether creators actually keep owner credentials (watch for deletion and publication requests that cannot be fulfilled) and whether 7-day browser sessions are the right length.

## First supported creator agent

The first supported creators are Claude agents (Claude Code harness, Opus and Sonnet) that make HTTP requests with `curl`. They completed create, revise, and publish from the hosted instructions alone; see [verification.md](verification.md). (Plan 1's optional skill, which they also installed and used, was later removed; see below.) For live-page tools, Chrome with native WebMCP (`--enable-features=WebMCP`) passed a full walkthrough. No compatibility is claimed for any other agent or browser until it passes the same walkthroughs. A chat product that can only fetch URLs cannot create journeys; the docs tell agents to say so plainly.

## Preview refresh: push instead of polling

*Revised November 11, 2026.* The preview first used visibility-gated polling: 3 s while the creator was active, 8 s when quiet, then a stop. That cost up to 1,200 Function requests per active preview-hour, and revisions took up to 8 seconds to appear.

It now uses push. Each draft has a `SceneLive` Durable Object. An open preview holds one hibernating WebSocket to it (`GET /api/v1/scenes/{id}/live`, authorized like any draft read, same-origin only). After any successful change (replace, publish, delete, or edit-key rotation), the API posts `{"type":"changed"}` to the object, which relays it. The page then refetches the draft once through the normal read.

The cost:
- About two requests to open the socket.
- One request per change, plus one refetch per open preview.
- Nothing while idle: hibernating objects aren't billed for duration, and messages sent to browsers are free.

A closed socket reconnects after 3 seconds and refetches. There is deliberately no polling fallback: this isn't a mission-critical tool, so environments that block WebSockets aren't accommodated.

## No installable skill

*Decided November 11, 2026 (plan 2, A4).* Plan 1 offered an optional `routereplay-web` skill through the Get Started prompt. It was removed:

- It added a question before the first journey. In the creator-driven run, declining it was the creator's first answer.
- Only some agents can install skills, so it was a second path, and installed copies went stale within an hour.
- Its one real benefit, recognizing a Route Replay request in a later session without the address, matters little for an occasional-use tool. A returning creator copies the prompt again.

The prompt is now "Help me create a journey in Route Replay. Read {origin}/agent-docs and follow it. If your browser or web reader can't open it, fetch it with a direct HTTP request." The last sentence was added November 12, 2026, after ChatGPT's Mac app gave up when its web reader and cloud browser refused the new domain. Both only load links already in OpenAI's public web index. The same agent's direct HTTP request worked. Since every agent reads the hosted docs at the start of a session, plan 2's proposed version headers and "docs updated" notice were dropped too. Copies installed during plan 1 testing still work: they defer to `/agent-docs`.

## Notes pinned to a moment (plan 2, A6): not adopted

*Decided November 11, 2026, after milestones 8 and 9; confirmed by the owner the same day.* Plan 2 proposed letting the creator attach short notes to a moment in the preview, which agents would read as `notes[]`. It was to be adopted only if viewer context alone did not resolve "this part" requests.

**Outcome: not adopted.** Viewer context was enough in ten of the eleven sessions that tested it:
- **A fresh Claude agent:** the creator paused partway through the second flight and said only "Slow down this part a bit". The agent named the leg it assumed ("since your preview was paused about halfway through it") and made the right change. When asked to "show me the layover", it moved the creator's view there.
- **A live Codex session:** "Can this bit stay on screen longer?" became "You've paused at the Singapore stop", and the stop was lengthened.
- **A separate live Claude Code session (Sonnet):** "this part with all the city lights" became "You were paused partway across the night-time Atlantic on the Boston to Reykjavik flight".
- **A live Codex Terra session:** "You're paused halfway across the Pacific, so I'll slow down the Vancouver-to-Tokyo flight."
- **A separate live Claude Code session (Haiku):** asked to *speed up* "this part", it shortened the flight it found the creator paused on.
- **Five later sessions (Sonnet twice, and Codex Terra, Astra, and Sol in full walkthroughs)** also resolved it.
- **The one miss** was a Terra agent dropped mid-conversation that never consulted the service and asked which part. The create response's `next` now points agents to `viewer.at`, and the same model then resolved it. A notes feature wouldn't have helped an agent that doesn't look.
- No walkthrough agent (Claude or Codex) asked for a way to receive notes.

**Why not build notes anyway:**
- **A chat box by another name.** A text field on the preview would duplicate the conversation the creator already has with their agent, close to plan 1's rule against one.
- **Stored text.** Notes would be the first creator-written text kept in D1, with retention and abuse handling to match.
- **Another thing to check.** Agents would need one more place to look.

Viewer context already tells the agent *where*. The creator tells their agent *what*, in the conversation they already have.

**Revisit if:**
- In real sessions, agents ask "which part?" even though a preview is paused.
- Creators want to mark several moments at once ("here, and also here"), which a single paused position can't express.
- Creators review a draft without their agent present.

## Hosting address: `routereplay.video`

*Decided November 12, 2026.* The owner bought `routereplay.video` as a memorable address for sharing, and the Worker serves it as a custom domain. `PUBLIC_ORIGIN` makes every generated link (watch, preview, docs, schema) use it. The `workers.dev` address keeps serving, so earlier watch links and the old `pages.dev` redirect still work. The zone's Browser Integrity Check is turned off so HTTP libraries with default User-Agents reach the API; `workers.dev` can't do that, which was one reason to move ([runbook](runbook.md)).

*Before that (November 11, 2026, plan 2, question 4):* the service stayed at `routereplay-web.resonantconcepts.workers.dev`. A custom domain cost money and added DNS, certificate, and WAF setup, and the 1010 error was handled by telling agents to send a descriptive User-Agent; all ten agent sessions in plan 2's verification did, and none hit it.

## Real clouds from NOAA's GFS model

*Decided November 12, 2026.* Journeys and the homepage draw real clouds: NOAA's GFS model analysis for past times and its forecast for upcoming ones, at the journey's own times.

- **Why GFS:** it is global, public domain, covers March 2021 to 16 days ahead in one archive, and a single field can be cut out of a forecast file by range request. Satellite sources were weaker fits: NASA's geostationary layers are regional and keep about a month; NOAA's global mosaic misses the poles and ships as NetCDF; ready-made cloud maps carry EUMETSAT terms and show only the present.
- **Cloud water, not cloud cover:** cover reads 100 % under thin cirrus, which made the planet look overcast. Column cloud water tracks how thick, and so how bright, clouds look from space. Opacity is 1 − e^(−30 · kg/m²).
- **Motion:** each 3-hour step also carries the 700 hPa wind, which moves the clouds between steps (at most 3 hours from each step), as the offline renderer's wind advection does. The procedural detail drifts with the wind and renews every 3 hours so it never smears.
- **Reproducible:** every save pins the newest complete run (`environment.cloudRun`), so a published video always draws the same sky. Save again closer to a trip for a fresher forecast.
- **Cost:** about 240 KB per 3-hour step, one Worker request each, decoded in the browser. See [budgets.md](budgets.md).

`environment.weather` is `clouds` by default; `omitted` draws none.

## Physically based atmosphere

*Decided November 12, 2026.* The air is drawn with single Rayleigh and Mie scattering using the offline renderer's constants (`routereplay` `atmosphere.py`), replacing a hand-tuned blue rim and twilight band.

- **What it shows:** blue haze over the day side, a white-blue limb, red and gold where sunlight grazes through the terminator, the Earth's shadow on the air, a glow around the Sun near the limb, and stars and ground dimmed by the air in front of them.
- **How it fits a phone:** one pass per pixel with 8 steps along the view ray, split at its lowest point. Each step's optical depth is exact, from the Chapman function: its large-radius form with a closed-form error-function approximation, within −0.6 % to +5 % of numerical integration at every angle. Sunlight at each step is reddened by its own path and blocked by the planet with a finite solar disc. The offline renderer's bounded secondary-scattering term is kept.
- **One deliberate difference:** sunlight uses an irradiance of π, the same units the ground is shaded in (a white surface facing the Sun reads 1). The offline renderer's 11.4 suits its own exposure and tone mapping; here it buried the ground under a bright blue veil.
- **Limits:** transmittance through the air is applied as one grey value (WebGL can't multiply the frame by a colour and add light in one pass).

## Water that reflects the sky

*Decided November 12, 2026.* Open water reflects the sky as well as the Sun, so the ocean brightens and turns pale blue toward the limb instead of staying one flat navy. The glint now stops at real coastlines too, from a water mask as sharp as the day texture ([assets.md](assets.md#static-assets-publicassets2026-11-12)).

- **How much it reflects:** the glint's own rough water (GGX with α = 0.09, Schlick Fresnel with 2 % at normal incidence, Smith masking), integrated over an even sky. A fitted curve, 0.02 + 0.539 k / (1 + k) with k = 2.29 (1 − cos θ)^5.41, stays within 0.01 of that integral: 2 % looking straight down, 5 % at 60°, 19 % at 75°, and 38 % at grazing. Smooth-water Fresnel would reach 100 % at the limb and turn it into a mirror of the white horizon.
- **What it reflects:** the sky in the mirror direction, from single scattering by air and haze with the atmosphere's constants and phase functions, in closed form for a flat, evenly mixed atmosphere: E · Σ βᵢ · columnᵢ · phaseᵢ · (e^−a − e^−b) / (b − a). Here a is the optical depth of the Sun's path to the water, b that of the reflected ray (both from the same Chapman columns as the atmosphere), and E the solar irradiance, π. The sky comes out deep blue overhead, paler toward the horizon, and orange toward a Sun near the horizon: a grazing reflection toward a Sun 1° up is five times redder than bluer. The views this camera takes rarely show that last case, so near sunset the visible change is mostly a smooth fade.
- **How it combines:** the day map's water colour is mixed toward the reflected sky by mask × reflectance, because light the surface reflects replaces light from below it. The Sun's disc isn't part of the sky; the glint carries it and is added on top unchanged, so the two never overlap. Haze's forward peak brightens the water around the glint slightly. There is no cloud shadow, because the sky still lights water in a cloud's shadow. The reflection belongs to the day term, so it fades across the terminator band with the rest of the sunlit ground and is gone 6° past sunset.
- **No moonlit sky.** The atmosphere doesn't draw moonlit air either, so a moonlit sky in the water would have nothing matching it above.
- **Cost:** only on water by day: two more air columns (the reflected ray's and the sunlight's), about 150 arithmetic operations, and no texture reads.
- **Limits:** no secondary scattering, so the twilight sky in the water is a little dark; one sky direction per pixel, not an average over the rough lobe; and because the atmosphere's heights are spread 7.2×, a grazing ray crosses about 13 air masses rather than about 35, so horizon skies come out a little bluer than real ones.

## Exposure, moonlight, and lights at night

*Decided November 12, 2026.* The globe is lit and exposed like the offline renderer's (`routereplay` `radiometry.py`, `scene_overlays.py`, `moonlighting.py`, `nightlighting.py`, `citypopulations.py`, `cityglow.py`).

- **Tone mapping:** per-channel Reinhard, x/(1 + x), applied to the ground, clouds, and air. Labels, routes, the Sun's disc, the Moon, and stars are drawn as they are and skip it. Each layer is tone mapped before blending, as three.js does on screen, rather than in a separate HDR pass.
- **Exposure:** a coarse meter of the sunlit globe in the frame's centre square sets a target that puts it at middle grey, between 0.8 and 2.2. The exposure follows the target in log space with a 0.75 s time constant and never looks ahead.
  - **Journeys:** metered once per frame over the whole timeline, in order (`exposureAt`), so seeking, playback, and export all give the same value. A 2-minute journey meters in about 80 ms, the first time it plays.
  - **Homepage:** metered live from the dragged camera.
- **Moonlight:** the Moon lights the ground, ocean glint, and clouds at its real phase (Krisciunas & Schaefer's curve) and distance. It is 4000× brighter than real moonlight, the offline renderer's choice: about 1 % of sunlight at full Moon.
- **Journeys draw the Sun and Moon** at their true places, as the homepage does.
- **City lights:** the night map gives only where lights are and how bright.
  - **Colour:** regional mixes of sodium, warm, and neutral lamps.
  - **Switching:** street lights come on at about 16 lux of sky light (later at dawn), and building lights at 100 lux. Thresholds vary across a seeded noise field identical to the offline renderer's.
  - **Schedule:** buildings and signs go dark after a regional curfew in local solar time.
- **Cloud lighting:** sunlight reaches cloud tops through the same air as the atmosphere, so decks near the terminator turn gold and stay lit a few degrees past the ground's. Billow tops facing the light catch more of it ([cloud tops lit as shapes](#cloud-tops-lit-as-shapes)), and city light glows up through thin cloud.

Deliberate differences:
- **Lamp colours** are our own blackbody derivations (2000, 3000, 4000, and 5000 K, unit luminance). The offline renderer's CIE-derived palette is CC BY-SA.
- **Always-on lights** switch off by day with the building lights, so no specks of city light show on sunlit ground.
- **Night map:** the source map has a faint bluish land base under the lights, so the shader keeps only light warmer than that base.

## Terrain relief lit by the Sun and Moon

*Decided November 12, 2026.* The ground is shaded with a normal tilted by real terrain, as in the offline renderer (`routereplay` `render.py`, `terrain()` and its shading). Mountains catch a low Sun on one side and fall into shade on the other, and the shading turns as the Sun moves. Before this, the globe was lit as a smooth sphere and mountains showed only through the day map's colours.

- **Data:** NOAA ETOPO 2022, clamped at sea level, sampled every 2.5 arc minutes and averaged to 5′ (standard, the offline renderer's grid) and 10′ (low). Lakes are flat. [assets.md](assets.md) covers the encoding and sizes.
- **Model:** the normal is (−12 ∂h/∂east, −12 ∂h/∂north, 1), normalized, with heights and distances in metres on a 6,371 km sphere. 12 is the offline renderer's default `relief_exaggeration`, and the scene's aircraft altitude uses the same factor. The build bakes it into the map, so changing it means rebuilding the asset.
- **What uses it:** the sunlit Lambert term and the moonlit one. Everything else keeps the sphere's normal, so the terminator stays where it is and water stays flat:
  - the day–night blend and the twilight band;
  - sunlight reddened by the air (which also cuts it off past the terminator);
  - cloud shadows;
  - ocean glint and wherever the water mask says water;
  - city-light switching.
- **Exposure** still meters a smooth sphere, as the offline renderer's proxy does, so the timeline's golden states don't change.
- **Cost:** per ground pixel, one more texture read and about 20 arithmetic operations. GPU memory: two-channel textures of 24 MiB (standard) and 6 MiB (low). Downloads: 1,871 KiB (standard) and 393 KiB (low).

Not ported from the offline renderer:
- **Night-side relief fill:** a fixed light from the south-east that scales the night floor by 0.77–1.12. At this scene's night levels it changed 99 % of pixels by 2/255 or less. It would also bring back a fixed light direction, the reason the shaded day map was dropped. Moonlight shows the relief at night instead.
- **Cast shadows:** the offline renderer traces the terrain for moonlight. Here only slopes turned away from a light go dark.
- **Raised terrain:** the offline renderer intersects the exaggerated terrain itself. Here the globe stays a sphere, so ridges don't stand out at the limb.

## Cloud tops lit as shapes

*Decided November 13, 2026.* Cloud tops are lit as billows: sides facing the Sun catch more light and sides turned away fall into soft shade, so decks read as volumes instead of flat blotches. The effect is strongest at sunrise and sunset and faint at noon. It replaces the earlier "lee" shading, which compared the cloud water a short step toward the light with the water here.

- **Height:** a cloud top stands as high as the cloud is thick (cloud water × the billow noise that already shapes its opacity). Only lighting uses this; the shell stays a sphere.
- **Normal:** tilted by the billow noise's gradient, times the cloud water, times `CLOUD_RELIEF` = 0.05 Earth radii per unit of thickness. Slopes are capped at 1.5 (`MAX_CLOUD_SLOPE`). The offline renderer tilts its billow normals the same way (`cloudvolume.py`, `BILLOW_NORMAL_RELIEF_M`), but inside a ray-marched volume this scene can't afford.
- **Gradient for free:** the 32³ noise texture now carries its gradient in G, B, and A beside the noise in R. That is a central difference, smoothed [1, 2, 1] / 4 across the other two axes (a 3D Sobel filter). The gradient arrives with the noise reads the shader already makes, so there are no extra texture reads. Plain central differences showed the lattice as facets under a low Sun.
- **Light:** the level deck's light, unchanged (it catches light a little past its horizon, reddened through the air), times e^(2.5 (N·l − n·l)) (`CLOUD_SHADING`). N is the tilted normal and n the shell's. For a tilt θ toward the light, the exponent is about 2.5 θ cos(elevation), so the contrast peaks at sunrise and sunset by itself. The result is smooth and never black. Flat decks get exactly what they did before, so the gold terminator, noon brightness, and the ground's cloud shadows (which read only the cloud water) are unchanged. Moonlight is shaded the same way.
- **Cost:** per cloud pixel, the "lee" shading's extra cubic read of the cloud field is gone: 10 texture reads for the Sun, and 10 more under moonlight. In their place come about 30 arithmetic operations, and the noise texture grows from 32 KiB to 128 KiB (RGBA). Frame times didn't measurably change ([budgets.md](budgets.md#frame-time)).

Not done:
- **Deck-scale slopes from the cloud water.** Screen-space derivatives of the cloud water are free, but they come per 2×2-pixel block, which a low Sun turned into visible steps. Finite differences of the smooth field would cost 20 more texture reads per pixel. Edges of decks still thin out through their opacity.
- **Shadows cast by one billow on another,** as the offline renderer's volume gives. Only slopes turned away from the light darken.

## The aircraft's shadow

*Decided November 13, 2026.* The aircraft casts a soft shadow on the ground, the cloud tops, and the air over them. It shows where the plane is relative to the Sun: beside it at midday, about a length off at low Sun, and touching the wheels on the ground. The offline renderer casts none on the world, only the airframe's shadow on itself.

- **A stylized height.** The aircraft is an icon drawn hundreds of kilometres long, and its display height is small beside its length on long legs and large on short ones. A physically placed shadow would hide under the icon or land far from it. So the shadow is cast as if the plane flew `SHADOW_HEIGHT` = 0.3 of its own lengths above its parked height at cruise, in proportion to its share of cruise height while climbing and descending. It is cast along the Sun, raised to at least `SHADOW_LOWEST_SUN` = 27°. That puts it about 0.3 lengths off at 45° and never more than about 0.7 lengths away. On the ground it is cast from the parked height, so it touches the plane.
- **A silhouette, not a shadow map.** Each type's plan view is rasterized once, in JavaScript: the airframe's triangles without the propeller discs, 4×4 samples per texel, on a 128² mask 1.4 lengths across, softened by a box blur of radius 2 applied twice. It is the same on every device, so preview and export agree. A shadow map would need another render pass every frame. Projecting the airframe's mesh would need a stencil buffer to keep overlapping faces from darkening twice, and couldn't see the cloud layer's opacity.
- **Drawn in the shaders that are already there.** The ground, cloud, and air shaders each find where the ray from their point toward the light crosses the silhouette, which lies level at the shadow height above the point below the plane. All three use that one footprint, so the shadow reads as one: on clear ground, on cloud tops, or both, weighed by the cloud's opacity. The plane is always drawn above the clouds, so it shades them even when parked under the deck.
- **What it takes away:** `SHADOW_DEPTH` = 75 % of direct sunlight on the ground and cloud tops, and 75 % of the light the air scatters over the footprint. That last part is a stylized shadow volume. Without it, the haze laid over the ground left the shadow only 1–14 % darker than its surroundings in test frames, and it disappeared over the sea.
- **When it shows.** It fades in as the Sun climbs from the horizon to 20° above the plane (`SHADOW_FULL_SUN`), so it is gone at night and never sits where a low Sun couldn't put it. While one type dissolves into the next at a stop, each type's silhouette is weighted like the airframe. Train, bus, car, and ferry vehicles cast their own shadows and none of this. The homepage's planes cast it too (up to `MAX_CASTERS` = 3 at once).
- **Cost:** per ground, cloud, and air pixel, three uniform tests. Within a shadow's reach, about 30 arithmetic operations and one texture read per aircraft. The ground shader binds three more textures (13 of the 16 a phone guarantees). Masks are 16 KiB each, kept for the page's life like the airframes. Frame times didn't measurably change ([budgets.md](budgets.md#frame-time)).

Limits:
- **No moonlight shadow.**
- **Near the limb,** the air's share follows the ground point the view ray reaches, so a shadow there darkens a long grazing column of air. The journey camera keeps the plane in the frame's centre, so this shows only on the homepage, and only rarely.

## Sharp city lights near airports

*Decided November 12, 2026.* Journeys draw city lights from the full-resolution Black Marble (about 0.93 km per pixel) where the camera comes close, and from the global night map everywhere else. At the closest airport framing a screen pixel is about 1.35 km, and the global map's texel 11 km (standard) or 20 km (low), so towns drew as soft squares 8–15 pixels across. Now they are points, and roads and coastlines show.

- **Tiles.** 5° cells of the shader's light level, one channel, only for cells with light (1,215 of 2,592): 7.7 MiB for the world at standard, 3.2 MiB at low (half resolution). Encoding and layout: [assets.md](assets.md#static-assets-publicassets2026-11-12).
- **Plan.** The camera is a function of the timeline, so before playback the planner (`src/shared/timeline/nightDetail.ts`) steps through every frame, takes the circle of ground where that frame draws detail, and lists the cells it touches in the order first needed (by frame, then nearest first). Cells without a tile are part of the plan too: they are known to be dark and cost nothing. Nearby airports share cells. The plan stops at 128 tiles, so a long trip keeps its first airports sharp and draws later ones from the global map.
- **Where the detail shows.** By ground scale: kilometres per pixel of a 1080-pixel short side, as if the point were at the frame's centre (the camera's distance divided by the cosine of the viewing angle, over the 771-pixel focal length). The detail is whole below 4 km per pixel and gone at 6 (`DETAIL_FADE_KM_PER_PX`). At the closest framing that is 1,210 km around the airport, gone by 1,540 km (the left and right edges of a 16:9 frame); as the camera climbs it lasts at the frame's centre until the global map is magnified only 2×. It depends only on the camera and the ground, not the screen's resolution or shape, so export and preview agree, and the planner covers the same circle the shader uses.
- **Fading out.** At that circle's edge, and where a neighbouring cell isn't covered (a coverage flag in the index texture, filtered across the outer eighth of a cell), the tile first blurs toward the global map's resolution by raising its mip level, and only then gives way to the global map. A plain crossfade overlaid crisp points on soft squares and read as a line.
- **GPU.** One texture array (R8 with mipmaps) holding the plan's tiles in plan order, and an index texture (RG8, 4 texels per cell side) giving each cell's layer and coverage. Per ground pixel: two index reads, one array read where the detail shows, and about 20 arithmetic operations. The derivatives for the array's mip level come from the globe's texture coordinates, not from the tile's, which jump at cell edges.
- **Loading.** Tiles are fetched 8 at a time in plan order, decoded through an `OffscreenCanvas`, and uploaded one layer at a time. Playback waits for the first frame's tiles (the start hold sits at the first airport) and shows the rest as they arrive; export waits for every tile. The homepage loads none. Costs per journey: [budgets.md](budgets.md#startup-transfer).
- **Same light, same colours.** The tiles store the level the shader computed from the night map's colour, so lamp colours, switching, and curfews are unchanged, and the cloud layer's glow still uses the global map. Averaged to the global map's resolution, the tiles carry 0–13 % more light, from small towns the coarse map's threshold drops.

Not done:
- **Tiles for the frame's shape.** The detailed area is a circle sized for a 16:9 frame's width, so a landscape frame loads tiles above and below its edges that it never shows, and the corners of a 16:9 frame (out to 1,920 km) and the far ends of a tall phone's frame blur into the global map. Planning per frame shape would make the plan depend on the viewport.
- **Reusing layers.** A trip with more than 128 tiles' worth of airports could evict tiles it has passed, but seeking back would then need them again mid-playback.
- **A softer light mapping.** The mapping saturates: most lit pixels reach full level, which at 11 km was hidden by the blur. At 1 km, city centres and dense suburbs look flat. Changing it would change the global map's look too.

## One camera: the offline renderer's

*Decided November 12, 2026.* Journeys use one camera, ported from the offline renderer (`routereplay` `motion.py` and `camera_geometry.py`). The three presets (`overview`, `follow`, `cinematic`) and `presentation.camera` are gone. Renderer 2.0.0.

- **Framing:** the camera looks straight down at the aircraft, north up, and stays over the airport during holds and stops.
- **Zoom:** at airports the globe's radius spans 1300 px of a 1080 px short side (70° across it). Mid-flight it pulls back toward 440 px, scaled by the leg's length as a share of the trip's longest. Long legs show the whole Earth; short hops barely leave the ground.
- **Pacing:** smootherstep (C2) easing on every flight and stop. Leg time is weighted by the square root of distance (unchanged). The defaults match the offline renderer: 1.6 s start hold, 1.3 s stops, 2.7 s end hold, and 6 s per leg.
- **Aircraft:** a constant-size icon, about 15 % of the short side, as the offline renderer's sprite is. Display altitude is 11 km × 12 × sin(π · progress).
- **Field of view:** 70° across the short side whatever the screen's shape, so a phone sees the same ground across its width as a landscape video sees top to bottom.

**Aircraft by type.** Each leg names its ICAO type designator (`legs[].aircraft`, required), and the scene draws that type. As in the offline renderer, an unsupported type fails validation instead of being swapped silently, and at a connection between different types one aircraft dissolves into the next through the middle half of the stop. The library covers 61 designators in 15 families (the offline renderer has five types). There are no liveries: matching is by type, not airline or registration. Models are drawn the same length on screen, so proportions tell types apart. Banking waits for recorded tracks: the offline renderer banks only along a supplied trajectory, never on a great circle.

**One clock (a deliberate difference).** The offline renderer freezes time during the start and end holds, so the Sun stands still while the camera and clouds still move. Here, each hold covers 20 minutes of real time (before departure, after arrival), and the Sun, Moon, stars, and clouds all follow it. Stops already ran on real time.

Layover warnings now measure rate, not length: `compressed_connection` fires when a stop passes more than 24 hours a second, the rate at which day and night start to flicker.

## Surface legs: one marker for every mode

*Decided November 12, 2026 (prototype).* A journey can include train, bus, car, and ferry legs between its flights. Plan 1 deferred other modes "until their route and timing semantics are designed". These are those semantics, kept as close to a flight's as possible so that no mode needs its own model or rules. Renderer 2.1.0.

- **Why:** legs must connect, so a trip with ground travel between two flights (land in Auckland, leave from Queenstown) couldn't be one journey at all.
- **Shape:** a leg has exactly one of `aircraft` (a flight) or `mode` (`train`, `bus`, `car`, `ferry`). Everything else is a flight's: IATA codes at both ends, local times with offsets, connected and non-overlapping legs.
- **Places:** stations and terminals are stood for by the nearest airport's code. At the airports' zoom a pixel is about 5 km, so a station 10–20 km from its airport is off by a few pixels, and labels keep showing three-letter codes. A `place` with coordinates would add free text and a time-zone lookup for little visible gain; add it only if the airport table can't stand in somewhere.
- **One look for every mode** (superseded the same day: each mode now draws its own vehicle, see [Train, bus, car, and ferry models](#train-bus-car-and-ferry-models)): the aircraft dissolves into a marker (white centre, gold ring) at the connection, and the marker moves along the ground with no cruise height. Consecutive surface legs keep the same marker, so nothing dissolves from train to ferry. The mode is a word in the route summary and storyboards, not a drawing. It is a closed list, not free text, so no creator-written text is stored ([notes](#notes-pinned-to-a-moment-plan-2-a6-not-adopted)), and per-mode icons can come later without a schema change.
- **Route shape: looked up, not straight.** A straight line put the train across the sea and the bus over the Alps. When a journey is saved, the server traces each surface leg along OpenStreetMap: railways through BRouter's `rail` profile (brouter.de), roads through OSRM's car profile (routing.openstreetmap.de, run by FOSSGIS), and ferries through the same car profile, kept only when most of the route is a ferry line, then the foot profile for passenger-only ferries. The route is simplified to 0.5 km (a tenth of a pixel at the closest zoom), stored as an encoded polyline in `normalized.legs[].path` from airport to airport, and drawn and animated in place of the great circle. The router picks the fastest way; a trip that went another way is split at the places it stopped. A `via` list of waypoints is the next step if that proves too coarse.
- **Never blocking:** a lookup failure saves the journey with a straight line and a warning (`route_not_found`, or `route_unavailable` to retry on the next save). Results that end more than 50 km from their airports, or run more than 4× the straight distance plus 50 km, count as not found: the router found some other network.
- **Fair use of community services:** lookups run only on create and replace (never on `/validate`), one at a time, after the rate limits; a leg keeps its route on later saves while its mode and airports don't change; results are cached at the edge for 30 days (not-found for a day) and shared between drafts; and all drafts together get 1,000 lookups a day (`ROUTE_LOOKUPS_PER_DAY`). `SURFACE_ROUTING=off` turns lookups off. At scale, run our own BRouter and OSRM or pay a provider.
- **CPU:** a free-plan Worker has 10 ms of CPU per request. BRouter returns about 1 KB per km of track; a 657 km route (633 KB) reads and simplifies in about 2.5 ms in a warm isolate, almost all of it `JSON.parse`. Rail responses over 1.5 MB (about 1,500 km) are drawn straight rather than risk failing the save. See [Worker CPU](#worker-cpu-within-the-free-plan).
- **Attribution:** the routes are produced from OpenStreetMap (ODbL). Whenever a leg has a route, the watch and draft pages show "Map data © OpenStreetMap contributors" in the corner of the stage (the route summary carries it too, for screen readers and the fallback), and the acknowledgments page lists OpenStreetMap, BRouter, and OSRM. Exported videos carry no credit yet; that is an open question.
- **Timing:** surface legs may take up to 7 days (flights 30 hours). Their default screen weight is at least 0.5, because distance weighting gives a 70 km ferry crossing about a twelfth of a Pacific flight's time and it flashes past in a second. Speed warnings use ground bounds: over 350 km/h, or under 5 km/h on legs over 12 hours. `long_block_time` doesn't apply.
- **Storyboards:** a surface leg in motion has phase `surface` (flights keep `flight`), the summary names the mode ("By ferry WLG → PCN, 50% of the way"), and the sketch draws the route dotted.
- **Compatibility:** the field is optional and journeys with only flights evaluate exactly as before, so the published fixture's pinned states are unchanged and this is a minor renderer bump.

## Train, bus, car, and ferry models

*Decided November 12, 2026.* Each surface mode draws its own vehicle in place of the gold marker. They are built in code in the aircraft library's style (`src/app/render/vehicles.ts`): rounded sections lofted along the body, with no model files. The camera looks straight down, so the plan view tells them apart:

- **Train:** a locomotive with a sloping gold nose and a dark windscreen, then three white cars with grey roof ridges, joined by dark gangways. Each car is its own body, placed on the route behind the one in front, so the train bends with the line.
- **Bus:** a coach 3.3 times as long as it is wide. It has a long, flat white roof over a dark band of windows that wraps round a deep windscreen, and a gold roof pod.
- **Car:** 2.2 times as long as it is wide: a red body with a dark glass cabin between the bonnet and the boot.
- **Ferry:** a navy hull with a pointed bow, grey open decks, a white deckhouse, dark bridge windows facing forward, and a gold funnel. While it is under way, a V-shaped wake trails behind it along the route. The wake stays on the ferry's own leg, so leaving port it grows from the terminal instead of reaching back over the land.

Other choices:

- **Size:** constant on screen, like the aircraft, but about a third of its size. The car is 4.0 % of the frame's short side, the bus 5.2 %, the ferry 5.4 %, and the whole train 10.7 % (each car 2.4 %). At the closest zoom (about 1.3 km a pixel at 1080p) a single vehicle is 58–78 km long.
  - Ground legs are short. Wellington to Picton is 99 km, so a plane-sized ferry (15 %, about 220 km) would cover Cook Strait and both shores.
  - Much smaller and the shapes stop reading. At 720p the car is 29 by 13 pixels, about the least that still shows its cabin, and the ferry's 39 pixels show its bow, deckhouse, and funnel.
  - The old marker was 4.2 % across, so a vehicle hides about as much of the route as it did. On a crossing as short as Cook Strait the ferry still covers much of the route at the airports' zoom. That is accepted.
- **On the route:** each body stands with its front and rear on its own line: its leg's track, joined with any legs either side travelled the same way (`src/shared/timeline/journeyPath.ts`).
  - So it points along the chord of its own length of road, railway, or ferry line. The tangent of one 0.5 km segment of the traced route would make it jitter.
  - Beyond the line's ends the bodies carry straight on, in the direction of the line's first or last 30 km. Traced routes start and end at airports, often with a short connector to the station at an angle to the line. While a flight dissolves into a train, the cars wait straight back from the station along the railway's direction rather than along the flight's ground track. Arriving, the locomotive's nose carries on past the station rather than turning onto the next leg's route. (November 13, 2026; the first version let them run onto neighbouring legs.)
  - Legs of the same mode in a row (train after train) share one line, so the cars wait on the railway they arrived on and follow it out again.
- **Light:** the aircraft's lighting.
  - They are lit by the Sun, and dim to the aircraft's night tint once the Sun sets where they are.
  - By day they are 20 % brighter than their paint. The aircraft gets sky light from the atmosphere drawn over it; the vehicles are drawn after the atmosphere.
  - After dusk they show lamps: headlights and tail lights on the road, the locomotive's headlights and the cars' window lights on the train, and navigation and deck lights on the ferry. Without the lamps, a vehicle disappears on the night side.
- **Shadow:** each body sits on a soft dark patch reaching about 0.6 % of the short side beyond it, as the marker had a halo. At a phone's pixel ratio of 1 a vehicle is only about 20 pixels long, and without the edge the shadow gives it, a grey roof was lost against land, sea, and cloud. It also darkens the gaps between a train's cars.
- **Layering:** the marker's. A vehicle draws over the airport dots, so one waiting at a station covers its dot, and under the label panels. The bodies write depth, so the route ribbon never draws over them.
- **Dissolves:** each mode is its own craft in the timeline (`train`, `bus`, `car`, `ferry`, beside the aircraft designators). The aircraft dissolves into a train, a train into a ferry, and a ferry into a bus through the middle half of the stop, as at a change of aircraft type. Two legs with the same mode keep the same vehicle.
- **Cost:** each body is merged geometry with vertex colours, drawn in one call.
  - A car is 432 triangles, a bus 672, a ferry 1,104 plus a 168-triangle wake, and a train 3,888 across four bodies. A 787 is 4,670.
  - By day a vehicle takes two draw calls per body, one for the body and one for its shadow (eight for the train), plus one for the ferry's wake. The marker took one. After dusk, each body adds one call for its lamps.
  - Geometry is built once per mode and kept; each vehicle owns only its materials. Records and flight-only golden states are unchanged, so the renderer stays 2.1.0 ([compatibility.md](compatibility.md)).

## Airport labels and route lines: the offline renderer's

*Decided November 12, 2026.* Airport labels, airport markers, and route lines are drawn as in the offline renderer (`routereplay` `labels.py`, `scene_overlays.py`, and its presentation contract). Before, each code sat in a rounded gold-edged panel just above a gold dot on its airport, fading in at mid-flight and out at 30 % of the next leg, and the route was a gold ribbon with a faint dashed path ahead. Renderer 2.2.0. Sizes below are pixels of a frame whose short side is 1080, scaled to the screen's short side as the field of view is.

- **Split-flap codes.** A 220×120 panel of three 66×108 cards, 5 apart in a 6-pixel border. Cards are dark painted metal, lighter on the upper leaf, with letters in (248, 247, 241) and hinge pins at the split. When a label appears its cards turn over from blank: an upper leaf falls about the axle over 0.52 s, accelerating (angle π(0.55u + 0.45u²)), its back carrying the new letter's lower half; cards start 0.11 s apart and all have turned by 0.74 s. The flip is timed by the label's age in presentation seconds, so preview, seeking, and export agree. Each panel is a canvas texture at the screen's resolution, redrawn only while its cards turn: about 0.1–0.4 ms a frame at 720p–1080p and 1 ms at a 2,160-pixel short side, then nothing.
- **Font.** The offline renderer uses Apple's DIN Condensed Bold, which can't be redistributed. Barlow Condensed SemiBold (OFL) at 103 px, narrowed to 88 %, matches its cap height and width.
- **Placement and timing.** Only the current leg's endpoints are introduced. A destination's label appears on the first frame its airport is on screen during the incoming flight (12 px inside the frame, 6 % of the way in from the limb). Until arrival it holds a fixed slot chosen before playback: left or right by the route's direction on screen at mid-flight, upper and lower lanes alternating by visit, scored to keep clear of the aircraft's central 224-pixel square and 18 px from the airport's path. At arrival its anchor locks to the ground under the panel; it stays put through the stop, then recedes with the ground, scaled by depth and fading out between 30 % and 12 % of its size. A departed visit retires before the leg after next begins, fading over its last 0.3 s. For the offline renderer's ORD→SFO→AKL demo at 9:16, the slots and the first and last frames of every label match its `labels.json` exactly (`tests/labels.test.ts`).
  - The layout depends on the frame's shape, as the offline renderer's depends on its 1080×1920 frame, so a landscape and a portrait export can choose different slots. Storyboards describe 16:9.
  - Two labels can show at once (a departing one recedes while the next is introduced), never more, and only the current leg's endpoints (`tests/warnings.test.ts`). Plan 2's `label_crowding` warning still isn't needed.
- **Airport markers: kept, in the offline renderer's form.** A 13-pixel dot inside a 27-pixel ring at 63 % opacity, pale blue-grey (171, 200, 206) until the aircraft arrives and the accent (255, 169, 116) after, shown while the airport's label shows and the airport is on screen. A 1-pixel leader line at 35 % of the label's opacity joins it to the nearest point of the panel. For 1.7 s after each arrival a 3-pixel ring grows from the airport (radius 14 + 29t) and fades from 71 % opacity. Markers, leaders, and rings are drawn over the ground, clouds, and route but under the aircraft: each pixel takes the depth of the ground beneath it, so only the aircraft hides it, as the offline renderer restores the aircraft over them. Train, bus, car, and ferry models draw after them (render orders 5–7 for markers, 10.35–10.6 for vehicles), so a vehicle waiting at a station covers its dot, and the panels draw over both (20).
  - Why: the panel no longer sits on its airport. On an approach it holds a slot that can be 300 px or more away, and without the dot its leader line ends in empty sea or among city lights, so nothing shows which place the code names. The contract's leader lines and its marker clearance assume a marker, and the offline renderer draws one. Comparison screenshots with and without the dot were made for this decision; removing the marker is one line in `Labels.tsx`.
- **Route lines.** Still only the flown part, ending at the aircraft, but the dashed path ahead is gone: the offline renderer draws none, and the destination's label and marker show where the flight is going. The line is 5 px of the accent over a glow, a 16-pixel line at 59 % opacity blurred by a Gaussian of σ = 11 px. As in Pillow's blur, colour and alpha blur separately, so the glow warms dark ground and dims bright ground slightly. Widths stay constant on screen at every zoom (before, they were in world units and shrank toward the limb). The accent replaces gold (`#ffc76b` → `#ffa974`).
- **Ground legs** (the offline renderer has none) take the same colour and glow, with the line drawn as 6-pixel dots every 12 px, as storyboard sketches already mark them. Dots are spaced along the ground at the airports' zoom, so they close up slightly while the camera climbs on a long ground leg. The glow follows a copy of the route sampled every 20 px, so a winding road doesn't fold the wide glow over itself.
- **Deliberate differences.** Routes stay at the aircraft's display height (11 km × 12 at mid-flight) rather than the offline renderer's 5.5 % of Earth's radius, so the line meets the 3D aircraft. Panels and lines are anti-aliased, and panel positions snap to screen pixels rather than to the 1080-pixel frame's.
- **Compatibility.** Label timing changed, so the published fixture's golden label states and storyboard were regenerated; see [compatibility.md](compatibility.md) for why this is a minor version.

## Scenes have no frame shape

*Decided November 12, 2026.* A scene doesn't record an aspect ratio. The watch page fills the screen edge to edge. Viewers pick 16:9, 1:1, or 9:16 (and 720p or 1080p) only when they export a video.

- `presentation.aspectRatio` is rejected as an unknown field, like `presentation.camera`.
- Storyboards describe the 16:9 framing.
- The watch page keeps only a "make your own" button, share, export, and a play/pause button that appears on tap. The title, route summary, and data notes remain for screen readers and in the page title.
- The draft page has the same stage (November 12, 2026). Its top left shows the title and "Draft · Edited 5m ago" instead of the + button. Its top right shows Publish, with no confirmation step, in place of Share. Once the shown revision has a watch link, Share takes its place again. Export is unchanged. "Your agent is working" floats at the bottom. The list of earlier watch links and the quality menu are gone; agents still list publications through the API. A publication now changes the draft's ETag, so an open draft notices when the agent publishes.

## Watch pages: out of search, previewed in chats

*Decided November 12, 2026.* Watch pages stay out of search results but carry a full link preview, so a link pasted into a group chat shows the journey.

- **Not indexed.** A journey is someone's itinerary, often a future trip, so an indexed watch page would announce when they're away. Watch pages, draft previews, and every `/api/*` response (snapshots and storyboards included) send `noindex` as a meta tag or an `X-Robots-Tag` header. `robots.txt` still allows everything: chat apps' preview fetchers obey it but ignore `noindex`.
- **Google's video results were out of reach anyway.** They need a video file or an embeddable player that Google can fetch, and the watch page draws on a canvas. Key moments also need videos of at least 30 seconds; journeys run about 15–25.
- **What the preview says.** The Worker writes the page's title, description, Open Graph, and Twitter card tags (`src/server/share.ts`) in place of the homepage's, which sit between the `share:start` and `share:end` comments in `index.html`. The title is the journey's (`journeyTitle` in `src/shared/scene/title.ts`, which the pages use too). The description lists the stops by city and the total distance. It doesn't count legs, so it stays right once legs can travel by land or sea. Dates are left out because chat apps keep their copy of a preview after the owner deletes the journey. Draft previews get the homepage card.
- **One image for every journey.** `public/share/journey.jpg` is the homepage globe without text, made by `scripts/browser/share-cards.mjs`. A picture of each journey's route would have to be rendered outside the Worker: on the Workers Free plan, rasterizing an image there exceeds the CPU limit. One way is for the draft page, which is usually open when a journey is published, to render a still and upload it to R2.
- **Status codes.** A missing journey's page returns 404 and a deleted one's 410, both `noindex` and without journey details. Watch pages revalidate on every view (`public, no-cache`), like the snapshot, so deletion takes effect at once. Any other unknown path gets `public/404.html` with a 404 (`not_found_handling = "404-page"`) instead of the app shell with a 200, so the app no longer has a not-found view of its own.

## Asset set

- **Day:** NASA Blue Marble Next Generation with topography and bathymetry, 3600×1800.
- **Night:** NASA Black Marble 2016, 3840 px source, plus 5° tiles of the full-resolution image (43200 px) for journeys' close views ([sharp city lights](#sharp-city-lights-near-airports)).
- **Water:** Natural Earth 1:10m land, islands, ice shelves, and lakes, rasterized to a mask the size of each day texture (4096×2048, 83 KiB; 8192×4096, 205 KiB) for ocean glint and sky reflection.
- **Relief:** NOAA ETOPO 2022 elevation (public domain), stored as the ground's normal at 12× relief ([terrain relief](#terrain-relief-lit-by-the-sun-and-moon)).
- Both are public domain and resampled into **low** (2048×1024, 415 KiB total) and **standard** (3600×1800, 1.3 MiB total) sets.
- **Font:** the unmodified Dosis variable font (OFL) for airport codes.
- **Aircraft:** a library of original procedural models generated in code from published dimensions, one per ICAO type designator ([aircraft.md](aircraft.md)), so they need no model files or licenses.

See [assets.md](assets.md).

## Supported-version and retention policy

- Scene schema v1 is the only authoring version. Unknown versions fail with `unsupported_version`.
- Every normalized record pins `rendererVersion` (semver), `assetManifestVersion`, and `airportDataVersion`. The player plays records with a supported schema version and the same renderer major version. A saved published fixture and its golden evaluated states (`tests/fixtures/publication-v1*.json`) must keep passing. Any change that would alter them requires a renderer major bump and keeping the old asset manifest directory. See [compatibility.md](compatibility.md).
- Drafts are deleted after 180 days without changes unless they have publications. Published snapshots stay until the owner deletes the draft; they are never expired to save storage. Revisions keep the last 50 per draft.
- One maintainer can support one schema version and one renderer major at a time. Add a second only alongside a migration plan.

## Worker CPU within the free plan

*Decided November 12, 2026.* Requests must fit the Workers Free plan's 10 ms of CPU, even while the account pays for more. Measurements are in [budgets.md](budgets.md#worker-cpu-cloudflare-free-plan-10-ms-a-request).

- **The airport table is one string.** `scripts/generate.mjs` turns `airports.json` into tab-separated lines in code order (`src/server/generated/airports.ts`), and `lookupAirport` binary-searches it. As 5,405 objects copied into a `Map`, it cost the first save in every isolate 3–4 ms of CPU, counting the garbage collection it set off. At today's traffic, many requests arrive in a fresh isolate.
- **Saves make fewer D1 round trips.** A create counts both rate limits in one batch and doesn't list publications for a brand-new draft. A replace doesn't read back the row it wrote.
- **Route lookups stay in the save.** In a warm isolate the Worker's own work for a lookup is about 2.5 ms per 650 km of rail, almost all of it parsing BRouter's answer, which should leave room for routes of several hundred kilometres. In a fresh isolate a lookup goes over, but lookups happen about once per route, per Cloudflare location, per 30 days (edge caches can evict sooner), which should stay within Cloudflare's allowance for infrequent overruns. Production numbers are pending. The alternatives:
  - Finishing the lookup in `ctx.waitUntil` doesn't help: that work runs as part of the same request, against the same 10 ms.
  - A Durable Object call is a separate request, but on the free plan it has the same 10 ms, and it adds a hop. A service binding to ourselves isn't documented to get its own CPU budget.
  - Lowering `MAX_RAIL_RESPONSE_CHARS` would fit every warm lookup with more room, but long train legs would be drawn straight.
- **If production shows recurring overruns from lookups:** first store finished routes in D1, so each route is looked up once rather than once per location per month. Then lower the rail cap.

## Deployment shape

*Revised November 11, 2026.* One Cloudflare Worker (`src/server/worker.ts`) serves the static app (Workers Static Assets), the API, and the `SceneLive` Durable Object, with one D1 database.
- `assets.run_worker_first` in `wrangler.toml` limits Worker invocations to the API, docs, schema, and the two dynamic page routes. Every other static file, including textures, is served without running the Worker.
- `_headers` still applies the security headers to static files.

The site launched on Cloudflare Pages with one Pages Function. It moved because Pages can't define Durable Objects: keeping Pages would have meant a second Worker just for live updates. The public API didn't change. The old `routereplay-web.pages.dev` project now only redirects every path with a 308 to the Worker, so earlier watch links, preview links, and saved docs URLs keep working.

## A journey from plain text: the homepage chat (`/api/v1/compose`)

*Proposed November 13, 2026; built the same day as the homepage chat, not yet deployed.* PLAN.md has Route Replay pay for no model inference: the visitor's own agent researches the trip and posts a spec. That leaves out people whose chat app can only fetch URLs, and people with no agent. Get started on the homepage now opens a chat where they describe the trip instead (`src/app/components/ComposeChat.tsx`, `src/server/compose/`, eval in `scripts/compose-eval/`).

**How it works.** The model's job stays small and everything checkable stays in the Worker:

1. **Extract:** a Workers AI model copies the text into a small JSON "intent", with schema-constrained output (`src/server/compose/intent.ts`). Each leg has its mode, places as written with the model's IATA code beside them, local dates and times as written, flight number, and aircraft as written. It never computes offsets or arrival dates.
2. **Resolve, without the model** (`resolve.ts`):
   - Airports come from the airport table. A code the person wrote wins. Cities with several airports (a short table: London, New York, Tokyo, Paris and others) get a question for flights. For train, bus, car and ferry legs they stand in at the city-centre airport.
   - When the model's code doesn't match the written name, a search of the table by name decides.
   - UTC offsets come from each airport's zone.
   - A flight's arrival date is the only date that gives a positive flight time under 24 hours. That gets date-line crossings right; models got them wrong.
   - The aircraft as written maps to a supported designator.
   - An aircraft or year the text never mentions is discarded and asked about.
3. **Validate** with `validateScene`. Missing times, dates, years and aircraft, and unnamed airports in multi-airport cities, become specific questions. Nothing is saved.

**Measured** (39 synthetic itineraries: 27 used to tune the resolver, then 12 written afterwards as a held-out check; local `wrangler dev` calling the remote models, November 13, 2026):

| Model (Workers AI) | Tuning | Held out | Leg accuracy | Invented values | Median / p90 latency | Neurons per request |
| --- | --- | --- | --- | --- | --- | --- |
| `@cf/google/gemma-4-26b-a4b-it` (thinking off) | 27/27 | 11/12 | 60/63 | 0 | 3.9 / 6.8 s | 8.8 (6.6–13.7) |
| `@cf/openai/gpt-oss-20b` | 27/27 | 10/12 | 59/63 | 0 | 4.1 / 7.7 s | 23 |
| `@cf/zai-org/glm-4.7-flash` | 26/27 | 7/12 | 54/63 | 0 | 3.2 / 5.7 s | 9.3 |
| `@cf/ibm-granite/granite-4.0-h-micro` | 22/27 | 7/12 | 51/63 | 0 | 6.3 / 9.4 s | 2.6 |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 26/27 | — | 41/45 | 0 | 5.0 / 7.3 s | 45 |
| `@cf/openai/gpt-oss-120b` | 24/27 | — | 42/45 | 0 | 5.4 / 17.9 s | 49 |
| `@cf/meta/llama-4-scout-17b-16e-instruct` | 22/27 | — | 36/45 | 0 | 21.9 / 36.4 s | 25 |

- **The resolver matters more than the model.** With a first, simpler resolver the same model output scored 22/27 for gemma and 13/27 for granite. Models put city codes, made-up codes or nothing for stations, and "helpfully" moved date-line arrivals to the wrong day. Granite also invented an aircraft and a year.
- **A second run of gemma** over all 39 cases gave the same 38/39.
- **One repair round** (feeding validation problems back to the model) never triggered for gemma, and changed nothing for granite, so it was dropped.
- **Claude** wasn't run: no Anthropic credentials were available. `scripts/compose-eval/run.mjs --models claude-haiku-5-5` runs it with a key, capped at US$0.50 a run. Estimated from the measured prompt sizes, Claude Haiku 5.5 at low effort costs about US$0.0002–0.0003 a request. The Anthropic SDK would add 880 KiB to the Worker bundle, about 6.5 ms of parsing in every fresh isolate for every endpoint, so it stays out of the Worker.
- **Worker CPU** (V8 profiles in local workerd): compose takes a median of 2.8–3.1 ms warm, at most 6 ms; a three-message conversation 1.6–2.1 ms. `/api/v1/validate` takes 0.65 ms on the same specs, and a flights-only create 1.3–2.6 ms.
  - The first request in a fresh isolate took 17 ms. 10 ms of that is the first `Intl.DateTimeFormat` per time zone, which every save path pays and which production processes mostly have loaded already (see [budgets](budgets.md#worker-cpu-cloudflare-free-plan-10-ms-a-request)).
  - Searching the airport table by name first cost 1–2 ms a search with a regular expression. It is now an `indexOf` over a lower-cased copy made once per isolate.
  - The prototype adds 25 KiB to the bundle (635 KiB), about 0.5 ms of parsing per fresh isolate.

**Cost.** Gemma averages 8.8 neurons a request. Workers AI includes 10,000 neurons a day on every plan, account-wide, so even 1,000 requests a day (8,800 neurons) fit. Beyond the free allowance a request costs about US$0.0001, so 1,000 extra a day would cost about US$3 a month. Each request also writes two D1 rate-limit rows.

**Trade-offs against PLAN.md:**
- Route Replay pays for inference, though within the free allowance at expected volume.
- It handles itinerary text, which is personal data.
- It owns extraction quality instead of the visitor's agent. An agent that can post specs still does better research: it can look up aircraft types and fill gaps. Compose only asks.

**As built:**
- **The conversation is the client's.** The endpoint keeps nothing between messages; the page sends the whole conversation each time, `{"messages": [{"role": "user" | "assistant", "content": "…"}]}`, ending with the person's message, at most 4,000 characters in all. One message goes to the model as written (as evaluated); a longer conversation goes as a transcript ("Traveller: …", "Route Replay: …"), so "Heathrow" answers "Which airport in London?". The resolver's guards (a year, airport code or aircraft must appear in the text) read only the person's own messages. The model is fixed (`MODEL` in `models.ts`); a request can't choose it. The endpoint on the full eval set after these changes: 38/39, no invented values.
- **Responses.** `{status: "ready" | "needs_info", questions, legs, spec, airports, issues, warnings, limits}`: `legs` is a plain summary for the person ("Melbourne (MEL) → San Francisco (SFO)", "Fri 5 Mar 2027, 10:15 → 06:05", "Boeing 787-9"), present when ready, with `spec` complete. A spec that fails validation with no open question comes back as `needs_info`, the issue's message as the question. `GET /api/v1/compose` returns `limits` without using a message.
- **Limits.** The existing D1 counters (`countLimits` and `peekLimits` in `guards.ts`): 20 messages per client an hour and 800 a day for everyone (`COMPOSE_LIMIT_PER_HOUR`, `COMPOSE_LIMIT_PER_DAY`), which keeps a typical day inside the free neurons. Every response, errors included (as `error.limits`), says `{remaining, perHour, resetsAt, reached?}`; the page shows "17 messages remaining" under each message. A request rejected before it reaches the model (malformed, too long) doesn't use a message; a model failure does. Once `remaining` is 0, or on `429 rate_limited` (`reached: "client"` or `"everyone"`), the chat suggests copying the agent prompt, with the button, and disables the message box until `resetsAt`. AI Gateway adds nothing needed: its rate limits are per gateway, not per client; caching doesn't help unique texts; and its logging would store itineraries. Add Turnstile only if abuse appears.
- **Publish rights, through the existing credentials.** When the person taps Create draft, the page creates the draft with `POST /api/v1/scenes` (with an `Idempotency-Key`), exactly as an agent would, then opens `/s/{id}#k=<owner credential>`. The draft page's handshake already accepts either credential after `#`: it removes it from the address bar, exchanges it at `POST /api/v1/scenes/{id}/session` for an `HttpOnly` cookie session with that credential's role, and an owner session shows Publish, Share and Export, and may edit (`PUT`). Nothing new was added to the credential scheme.
  - **Limit: the session is the person's only key.** It lasts 7 days in that browser. After that, or on another device, they can watch only what they published; they can't publish again, delete, or hand the draft to an agent, because the service keeps only hashes and the owner credential was shown only to the page. Options, not built: show the private link in the chat with a copy button before opening the draft (the advice agents give: keep it somewhere safe), or have the draft page offer it once, while it still holds the credential from the fragment.
- **Secrets:** none. Workers AI is a binding (`[ai]` in `wrangler.toml`).
- **Privacy wording,** in the chat's first message: "To read your itinerary, Route Replay sends the text to Cloudflare Workers AI, on the same network that hosts this site. Neither Cloudflare nor Route Replay keeps the text or uses it to train models." This rests on Cloudflare's Workers AI data-usage page (no retention after the request, no training) and on the Worker never logging request bodies. The conversation lives only in the page; a draft keeps airports, times, aircraft and a title made from the place names.
- **The drawer.** A half-height modal `<dialog>` over the turning globe, in the export drawer's style. Focus goes into it (the message box, or the heading on touch screens, so the keyboard doesn't cover the introduction), Escape and the close button close it and return focus to Get started, and the thread is an `aria-live` log. Enter sends, Shift+Enter starts a new line. On a phone, `visualViewport` keeps the sheet above the on-screen keyboard. Trackpad scrolling inside the sheet scrolls the chat; over the backdrop it still turns the globe.

**Unproven:**
- Real itineraries. The test set is synthetic and English, and the resolver was tuned on most of it.
- Production latency and CPU.
- The question-and-answer loop as people use it, and the drawer with a real phone keyboard (checked by setting the values `visualViewport` reports, not on a device).
- Claude's accuracy.
- How long gemma-4 stays on Workers AI: several models there retire on November 20, 2026. Rerun the eval before switching models.
