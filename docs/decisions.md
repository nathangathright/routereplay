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

## Cloudflare Web Analytics

*Decided November 13, 2026.* The zone's Web Analytics injects Cloudflare's beacon into every HTML page, and the CSP blocked it, so it had recorded nothing. The owner chose to keep it: `script-src` allows `https://static.cloudflareinsights.com` (in `src/server/security.ts` and `public/_headers`). The beacon (checked in its 2026.10.1 build) needs nothing else: it posts to `/cdn-cgi/rum` on the same origin, because the injected config sets `version` (without it, it would post to `cloudflareinsights.com`). It uses no `eval`, workers or images. It removes the query and fragment from the page address and referrer it reports, which matters because draft links carry the owner credential in `#k=`, and the chat moves the page to such a link with `pushState`, which the beacon's single-page mode follows. The privacy notes in `agent/reference.md` say so. Turning it off instead is a dashboard setting (Web Analytics → the site → automatic setup), with no code change.

## The homepage globe starts over the visitor

*Decided November 13, 2026.* The homepage globe used to open over the middle of the contiguous United States for everyone. Now it opens over the visitor's approximate location. Cloudflare estimates that from the IP address on every request (`request.cf.latitude` and `longitude`), with no permission prompt. The Worker now serves `/` (it's in `run_worker_first`), rounds the location to whole degrees and writes it into that visitor's copy of the page as `<meta name="visitor-location">`, which `IdleEarth.tsx` reads before the first frame, so the view never jumps. The location isn't stored or logged. Without one (an address Cloudflare can't place, or `npm run dev`, which has no Worker), the globe opens over the United States as before.

- **Written into the page rather than fetched from the API.** The two cost the same one Worker request per homepage view, but a fetch adds a round trip, and the globe would either wait for it or jump once it arrived. Browser geolocation would ask for permission, and `Permissions-Policy` turns it off anyway.
- **Each copy is for one visitor:** `cache-control: private, no-cache` with no ETag. The Worker fetches the shell without the browser's `If-None-Match`, so a copy cached before this change, without a location, isn't kept in use by a 304.
- **Cost:** one Worker request and well under a millisecond of CPU per homepage view ([budgets](budgets.md#request-budget-cloudflare-free-tier)).
- **Share cards keep the default view.** `scripts/browser/share-cards.mjs` removes the tag before the app reads it, so the cards show North America wherever they're captured.

## Real clouds from NOAA's GFS model

*Decided November 12, 2026.* Journeys and the homepage draw real clouds: NOAA's GFS model analysis for past times and its forecast for upcoming ones, at the journey's own times.

- **Why GFS:** it is global, public domain, covers March 2021 to 16 days ahead in one archive, and a single field can be cut out of a forecast file by range request. Satellite sources were weaker fits: NASA's geostationary layers are regional and keep about a month; NOAA's global mosaic misses the poles and ships as NetCDF; ready-made cloud maps carry EUMETSAT terms and show only the present.
- **Cloud water, not cloud cover:** cover reads 100 % under thin cirrus, which made the planet look overcast. Column cloud water tracks how thick, and so how bright, clouds look from space. Opacity is 1 − e^(−30 · kg/m²).
- **Motion:** each 3-hour step also carries the 700 hPa wind, which moves the clouds between steps (at most 3 hours from each step), as the offline renderer's wind advection does. The procedural detail drifts with the wind and renews every 3 hours so it never smears.
- **Reproducible:** every save pins the newest complete run (`environment.cloudRun`), so a published video always draws the same sky. Save again closer to a trip for a fresher forecast.
- **Cost:** about 240 KB per 3-hour step, one Worker request each, decoded in the browser (about 430 KB since the [high cloud layer](#a-high-cloud-layer)). See [budgets.md](budgets.md).

`environment.weather` is `clouds` by default; `omitted` draws none.

## Physically based atmosphere

*Decided November 12, 2026.* The air is drawn with single Rayleigh and Mie scattering using the offline renderer's constants (`routereplay` `atmosphere.py`), replacing a hand-tuned blue rim and twilight band.

- **What it shows:** blue haze over the day side, a white-blue limb, red and gold where sunlight grazes through the terminator, the Earth's shadow on the air, a glow around the Sun near the limb, and stars and ground dimmed by the air in front of them.
- **How it fits a phone:** one pass per pixel with 8 steps along the view ray, split at its lowest point (4 on each side; a ray that meets the ground ends before its lowest point, so it takes 4). Since November 13, 2026 a second, cheaper draw applies the transmittance first ([one linear composite](#one-linear-composite-tone-mapped-once)). Each step's optical depth is exact, from the Chapman function: its large-radius form with a closed-form error-function approximation, within −0.6 % to +5 % of numerical integration at every angle. Sunlight at each step is reddened by its own path and blocked by the planet with a finite solar disc. The offline renderer's bounded secondary-scattering term is kept.
- **One deliberate difference:** sunlight uses an irradiance of π, the same units the ground is shaded in (a white surface facing the Sun reads 1). The offline renderer's 11.4 suits its own exposure and tone mapping; here it buried the ground under a bright blue veil. (That was with each layer tone mapped and blended in sRGB-encoded values. Composited in linear light, 11.4 still veils the ground: at Singapore's noon the sea went from (35, 53, 84) to (60, 86, 119).)
  - **Since November 14, 2026, π at the ground.** The ground takes a high Sun *at the ground* as white, after one column of air, but the air took π as sunlight *above* it. In linear light the air's sunlight is now π × (1.05, 1.12, 1.31), the same sunlight in the ground's units ([the air and clouds in the ground's units](#the-air-and-clouds-in-the-grounds-units)). That is 31 % more blue light, not a veil: the noon sea matches the build before the linear composite. Drawn the old way, the air keeps π.
- **Transmittance per colour** since November 13, 2026: the frame is composited in linear light, where the air takes two draws, one multiplying what lies behind by its transmittance and one adding its light ([one linear composite](#one-linear-composite-tone-mapped-once)). Where half floats can't be rendered it is still one grey value, since blending can't multiply the frame by a colour and add light in one pass. Since November 14, 2026, the ground and clouds are dimmed by the air's diffuse transmittance, which keeps light the air scatters forward; only rays over the limb, to the stars and the Moon, lose it all.

## Water that reflects the sky

*Decided November 12, 2026.* Open water reflects the sky as well as the Sun, so the ocean brightens and turns pale blue toward the limb instead of staying one flat navy. The glint now stops at real coastlines too, from a water mask as sharp as the day texture ([assets.md](assets.md#static-assets-publicassets2026-11-12)).

- **How much it reflects:** the glint's own rough water (GGX with α = 0.09, Schlick Fresnel with 2 % at normal incidence, Smith masking), integrated over an even sky. A fitted curve, 0.02 + 0.539 k / (1 + k) with k = 2.29 (1 − cos θ)^5.41, stays within 0.01 of that integral: 2 % looking straight down, 5 % at 60°, 19 % at 75°, and 38 % at grazing. Smooth-water Fresnel would reach 100 % at the limb and turn it into a mirror of the white horizon.
- **What it reflects:** the sky in the mirror direction, from single scattering by air and haze with the atmosphere's constants and phase functions, in closed form for a flat, evenly mixed atmosphere: E · Σ βᵢ · columnᵢ · phaseᵢ · (e^−a − e^−b) / (b − a). Here a is the optical depth of the Sun's path to the water, b that of the reflected ray (both from the same Chapman columns as the atmosphere), and E the solar irradiance above the air, π (in linear light since November 14, 2026, π × (1.05, 1.12, 1.31), as for the [atmosphere](#physically-based-atmosphere)). The sky comes out deep blue overhead, paler toward the horizon, and orange toward a Sun near the horizon: a grazing reflection toward a Sun 1° up is five times redder than bluer. The views this camera takes rarely show that last case, so near sunset the visible change is mostly a smooth fade.
- **How it combines:** the day map's water colour is mixed toward the reflected sky by mask × reflectance, because light the surface reflects replaces light from below it. The Sun's disc isn't part of the sky; the glint carries it and is added on top unchanged, so the two never overlap. Haze's forward peak brightens the water around the glint slightly. There is no cloud shadow, because the sky still lights water in a cloud's shadow. The reflection belongs to the day term, so it fades across the terminator band with the rest of the sunlit ground and is gone 6° past sunset.
- **No moonlit sky.** The atmosphere doesn't draw moonlit air either, so a moonlit sky in the water would have nothing matching it above.
- **Cost:** only on water by day: two more air columns (the reflected ray's and the sunlight's), about 150 arithmetic operations, and no texture reads.
- **Limits:** no secondary scattering, so the twilight sky in the water is a little dark; one sky direction per pixel, not an average over the rough lobe; and because the atmosphere's heights are spread 7.2×, a grazing ray crosses about 13 air masses rather than about 35, so horizon skies come out a little bluer than real ones.

## Exposure, moonlight, and lights at night

*Decided November 12, 2026.* The globe is lit and exposed like the offline renderer's (`routereplay` `radiometry.py`, `scene_overlays.py`, `moonlighting.py`, `nightlighting.py`, `citypopulations.py`, `cityglow.py`).

- **Tone mapping:** per-channel Reinhard, x/(1 + x), applied once, to the composited scene: ground, clouds, air, and aircraft (since November 13, 2026; before, each layer was tone mapped before blending, as three.js does on screen). Labels, markers, routes, the Sun's disc, and the vehicles are drawn after it; the Moon and stars keep their display values, converted to the light that tone maps back to them ([one linear composite](#one-linear-composite-tone-mapped-once)).
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
- **City-light level and emission:** the source map draws the lights over a faint bluish land, so the level drops that land; and city light is 1.47× the offline renderer's emission, to keep the night side as bright as it was before the level stopped saturating ([city lights with their gradation](#city-lights-with-their-gradation)).

## One linear composite, tone mapped once

*Decided November 13, 2026.* The scene is composited in linear light and tone mapped once, as in the offline renderer (`routereplay` `radiometry.py`). The stars, the Moon, the ground, clouds, air, and aircraft are drawn into a half-float target, where layers add and multiply as light does. Then one exposure, one per-channel Reinhard shoulder, and the sRGB encoding make the frame. Labels, markers, route lines, the Sun's disc and glare, the vehicles, and the homepage's button are drawn after that, straight into the frame, as the offline renderer adds its labels and routes after its display transform. Before, each layer was tone mapped on its own and blended in sRGB-encoded values, as three.js does on screen (`src/app/render/display.tsx`).

- **Which is which:** three.js's own split. Opaque materials are scene light and go into the target; transparent ones are graphics and are drawn after the tone-map pass, where three.js still tone maps the materials that ask for it (the vehicles, the propeller discs, the ferry's wake), with the frame's exposure, as before. three.js already draws every opaque object before every transparent one, so the draw order, and every depth relationship, is unchanged. The aircraft's navigation lights became transparent to stay graphics.
- **Depth:** the tone-map pass writes the scene's depth back into the frame. So the aircraft still hides the airport markers (which take the ground's depth) and the route line, and the Earth still hides the setting Sun's disc.
- **Graphics look as before.** They are drawn the same way into the same kind of frame: the label panels' pixels are unchanged.
- **Stars and the Moon** sit behind the air, so they stay in the scene, but their colours are display values, not light. Each is converted to the light that the tone-map pass turns back into the value it had (Reinhard inverted at the frame's exposure, capped at 0.996, which still encodes to 255; `src/app/render/toneMap.ts`). In empty sky they look as before, except that faint star halos now add to the sky in linear light (a few levels, in under 1 % of sky pixels). Through the air they are now dimmed colour by colour. The empty sky is cleared the same way, so it stays `#02040a` at every exposure.
- **The air's transmittance is per colour.** The air takes two draws: its transmittance multiplies what lies behind (blend `ZERO, SRC_COLOR`), then its in-scattered light is added (`ONE, ONE`). The transmittance draw needs no march: the march's segments telescope, so it is four Chapman columns. One grey draw, as before but in linear light, measured 0.9 ms less at 2560×1440 ([budgets.md](budgets.md#frame-time)).
- **The frame is opaque.** The cloud layer's blending also blended alpha, so the old canvas was translucent wherever cloud was (72 % of the pixels at Singapore's start, alpha down to 198/255). Preview and export composited that differently: exported frames differed from the preview by a mean of 2–9 levels (24–34 dB). The tone-map pass writes alpha 1, and exported frames now match the preview at 43–49 dB, as H.264 allows.
- **Without colour-renderable half floats** (`EXT_color_buffer_float` or `EXT_color_buffer_half_float`, and a complete RGBA16F framebuffer), the frame is drawn as before: straight to the canvas, each layer tone mapped, and the air as one premultiplied draw with a grey transmittance. That path renders the 14 test frames pixel for pixel as the previous build did, and keeps its own constants since the [noon retune](#the-air-and-clouds-in-the-grounds-units) (`LINEAR_SCENE`). `?display-referred` forces it, for comparisons. An 8-bit target was not an option: it can't hold light above 1, and dark gradients band in 8-bit linear values. iOS Safari has reported both extensions since iOS 16.4 (half floats since 15.4). iPhones lack only blending into 32-bit floats (`EXT_float_blend`), which this doesn't use. Not yet confirmed on a real iPhone; the fallback is mainly for old Android GPUs.

What changes at identical frames (Chrome, the preview's 896×720 scene, November 13 journeys), as first merged; [the air and clouds in the ground's units](#the-air-and-clouds-in-the-grounds-units) (November 14) then brought noon back:

- **Clouds no longer clip.** A sunlit deck at Singapore's noon was (211, 230, 250): the air's light, added in encoded values to a cloud already near white, pushed it to a clipped blue-white. It is now (197, 193, 181), the colour of the sunlight that reaches it, warmed by the air. Clouds get no sky light yet, which would cool them. (Since November 14: (220, 220, 221) in the cores, slightly cool in the mid-tones.)
- **The air's light weighs less.** Added in encoded values, a little light lifted dark ground several times its linear amount; added as light, it is a blue tint. The sea at noon is about as it was, (32, 48, 70) against (35, 53, 84); land loses some of its blue-green lift.
- **Long paths through the air are reddened.** Toward the limb and the terminator, what lies behind the air loses blue before red, as through real air. Ground and clouds there turn gold, most on the homepage's whole globe, where the old limb was white-blue.
- **Overall:** daylight frames carry 21–27 % less light at noon and 32–44 % less under a low Sun (linear mean). Night frames change by −21 % to +11 %; thin cloud over city lights now blends in linear light and glows a little more.
- **Exposure was not retuned.**
  - A blanket 1.33× brings noon back (0.86–0.91 of its old light, sea and land within a few levels) but brightens nights by a third.
  - Raising middle grey and the lower bound would brighten only frames below the 2.2 cap. Low-Sun daylight frames, which lost the most, already sit at the cap with the nights.
  - Most of the loss is clouds, whose lighting is being reworked separately (sky light).
  - The air's strength was tuned to the old blending. Composited in linear light, twice its light (2π) brings the noon globe back to 0.82–0.90 of its old light, with the sea and limb close to before and no veil; the offline renderer's 11.4 veils it.
  - So the next step is to retune the air's strength and the clouds' light together, not the camera's exposure. (Done on November 14: the cause was the units the air and clouds were lit in, not the air's strength, and exposure stayed.)
- **The homepage's button** is a graphic and is unchanged; its label tone (`faceLuminance`, `labelTone`) reads only the button's own lights and matched at noon, dusk, and night.

Cost: one more full-frame pass and a multisampled half-float target; [budgets.md](budgets.md#frame-time) has the measurements.

Not done:
- **Splitting the air at the cloud deck,** so clouds are seen through only the air above them. In this geometry 36 % of the Rayleigh column and 95 % of the haze lie below the deck's exaggerated 25 km top, and the per-colour transmittance reddens clouds with that air. Drawing the air in two layers around the deck (four draws) changed cloud colour by at most 5/255 in blue, for 2.2 ms more at 2560×1440.
- **Dual-source blending** (`WEBGL_blend_func_extended`) could multiply and add in one draw. Chrome exposes it; WebKit implemented it in 2023 behind its draft-extensions flag, and whether iOS Safari ships it is unconfirmed. It would save at most the transmittance draw, about 0.9 ms at 2560×1440, and three.js has no `SRC1` blend factors, so it needs raw WebGL calls around three.js's state cache.
- **Bloom.** Ocean glint and city lights are now light above display white, so a bloom pass (a half-float mip chain between the scene and the tone-map pass) would act on them. The Sun's disc would first have to move into the scene as light, replacing its glare sprite.

## The air and clouds in the ground's units

*Decided November 14, 2026.* After the [linear composite](#one-linear-composite-tone-mapped-once), noon looked wrong: clouds were a warm beige-grey, about (197, 193, 181), noon frames carried 21–27 % less light, and the whole globe had a strong gold limb. The cause was units, not the air's strength or the exposure.

- **Two units of sunlight.** The ground takes a white surface under a high Sun as 1 *at the ground*, after one column of air (`groundLight` divides by that column's transmittance), and the aircraft's paint does the same. The air's march, the cloud deck's sunlight, and their sky table took π as sunlight *above* the air. Measured in the ground's units, they were lit (0.95, 0.89, 0.76) as brightly: 5 % less red, 24 % less blue.
- **Why it showed only now.** Each layer used to be tone mapped on its own, and the air's light was added in display values, which clipped cloud tops to blue-white. In one linear buffer, the deck got yellowish sunlight, the air dimmed it again on the way up as if it were a narrow beam, and nothing added the blue back. A numeric model of the shaders gave (205, 202, 193) for a noon deck, against (208, 205, 197) measured.

Changes (`lighting.ts`, `Earth.tsx`, `Clouds.tsx`, `skyLight.ts`, `airLight.ts`, `craftLight.ts`):

- **Sunlight above the air, in the ground's units:** π × (1.05, 1.12, 1.31), the inverse of one vertical column's transmittance (`SUN_ABOVE_AIR`). It lights the air's march, the water's reflected sky, the deck's and the high layer's sunlight, and their sky light. The sky table stays in its own units, and `skyLight()` scales it.
- **Ground and clouds are seen through the air's diffuse transmittance** (`surfaceExtinction`). The air scatters light out of a view ray, but the lit surface beside the ray sends about as much into it. So only what the air turns back is lost: half of what air scatters (Rayleigh), 6.3 % of what haze scatters (Henyey–Greenstein, g = 0.76), plus what haze absorbs. Looking straight down, blue passes 0.88 instead of 0.77. Rays over the limb, to the stars and the Moon, keep the full extinction, and the two meet over the deck's height.
- **The deck's own light, returned by the air above it.** The clear air above the deck scatters part of the deck's light back down: (0.028, 0.060, 0.130), its spherical albedo from single scattering (`airAboveAlbedo`). The deck reflects that too, so its light is divided by 1 − S × albedo. For the high layer, S is (0.012, 0.027, 0.062).
- **`CLOUD_BRIGHTNESS` 2.4 → 3.2.** In the old frame, the air's light added in display values lifted cloud tops toward white. In linear light a deck carries its own brightness. The sea and land already matched the old build at the same exposure, so the clouds, not the camera, take the difference.
- **The aircraft:** its sky is in the same units, with `SKY_GAIN` 3 → 2.7 to keep the offline renderer's luminance of 0.13 by day, and 30 % of its colour kept instead of 35 %: (0.11, 0.13, 0.18) at noon. Light from a deck below is in the deck's units, with its return.
- **Drawn the old way, nothing changes.** These constants are switched by a `LINEAR_SCENE` shader define. `?display-referred` renders six test frames as the build before this change did, to within 4 levels in a few aircraft pixels (mean difference under 0.01): the aircraft's light is worked out on the CPU for both ways of drawing.

Kept as it was:

- **Exposure.** Noon moments meter 0.88–0.90 and the whole globe at noon 1.33, so raising the lower bound (0.8) wouldn't touch them. Low-Sun, sunset, dusk, and night frames sit at the 2.2 cap. Raising middle grey would brighten the sea and land past the old build, which they now match. The meter's proxy (`exposure.ts`) is still the ground's, and is unchanged.
- **The air's strength.** The air is still at π, now in the ground's units. Doubling it, tried before, hazed the globe.
- **Sky light on clouds at the cloud's albedo.** At the deck's gain it added 2 % blue to a noon deck and turned the gold band along the terminator blue-grey ([sky light on clouds](#sky-light-on-clouds)).

At identical frames (Chrome, 1280×720 at DPR 1, the same GFS run). "Before" is the build before the linear composite, sky light, cellular billows, and the high layer, so cloud shapes differ from it. Each figure is mean linear luminance, then the ratio to before:

| Moment | Before | Merged | Now |
| --- | --- | --- | --- |
| Noon, whole globe (Singapore–Hong Kong) | 0.071 | 0.063 (0.89) | 0.081 (1.13) |
| Noon, whole globe (London–Johannesburg) | 0.119 | 0.088 (0.74) | 0.107 (0.90) |
| Noon, over cloud (Singapore)¹ | 0.221 | 0.249 (1.13) | 0.321 (1.45) |
| Low Sun over broken cloud (London–Frankfurt) | 0.165–0.218 | 0.66–0.68 | 0.82–0.84 |
| Sunset at the terminator (Delhi–Mumbai) | 0.047 | 0.71 | 0.84 |
| The plane at sunset (London–Frankfurt) | 0.069–0.115 | 0.64–0.70 | 0.78–0.85 |
| Night, city lights (New York–Boston) | 0.016–0.020 | 0.82–1.21 | 0.90–1.28 |
| Full Moon, the plane (New York–London) | 0.0115 | 0.98 | 1.19 |
| Airport close-up with labels (London) | 0.364–0.452 | 0.63–0.68 | 0.79–0.85 |
| Homepage at noon, dusk, night | 0.073, 0.025, 0.0039 | 0.79, 0.86, 1.06 | 0.97, 1.05, 1.11 |

¹ The merged builds draw more cloud here than the old one.

- **Clouds at noon:** the brightest cloud is (220, 220, 221) and the lit mid-tones slightly cool, (167, 170, 176) on the homepage (merged: (211, 207, 199) and (155, 155, 152)). Reinhard's shoulder pulls the bright cores toward neutral.
- **Open sea at noon:** (47, 67, 95) on the whole globe, against (45, 67, 97) before and (46, 63, 84) merged.
- **The limb at noon** is blue-white again. Gold stays where sunlight really grazes: decks along the terminator, which are white on the day side.
- **Dusk and night keep their light.** The gold-lit plane and the moonlit plane are unchanged. Moonlit decks are a neutral grey instead of brown, and 10–20 % brighter.
- **Export** of Singapore–Hong Kong (720p) matches the preview at 41–49 dB, mean luminance within 0.1 %.

Cost: per air pixel, a few more operations in the transmittance draw; per cloud pixel, one division. GPU time didn't measurably change ([budgets.md](budgets.md#frame-time)).

Limits:
- **City lights at night lose less light to the air** (night frames +5–9 %). Diffuse transmittance assumes the ground around a point is lit like it, and a city's surroundings are dark.
- **Clouds are still seen through the whole column of air,** including the 36 % below the deck ([not done above](#one-linear-composite-tone-mapped-once)).
- **Low-Sun daylight frames carry 15–20 % less light than before.** Their clouds were clipped to white then.

## Hardware tiers, and cleaner exports

*Decided November 15, 2026; phase 1 of the hardware-tiers design.* The app now recognises how capable a device is, in three tiers, and exports from laptops and desktops draw several jittered samples per frame. A tier changes fidelity only: every tier draws the same moment, from the same `evaluate(timeline, t)`, exposure, and seeds, with nothing carried from one frame to the next. Nobody's playback changes in this phase.

| | Phone | Laptop | Desktop |
| --- | --- | --- | --- |
| Was | `low` | `standard` | new |
| Earth textures | low | standard | standard |
| Pixel ratio | 1 | the screen's, at most 2 | the screen's, at most 3 |
| Globe segments | 72 | 144 | 144 |
| Atmosphere march | 8 steps | 8 | 12 |
| Aircraft self-shadow maps | 512² | 512² | 1024² |
| City-light tiles per journey | 128 | 128 | 256 |
| Export samples per frame | 1 | up to 8 | up to 8 |

- **Phone and laptop are the old constants, one for one** (`src/app/tier.ts`; a test pins each). At one sample the paused preview renders pixel for pixel as the build before it, at both tiers: 0 differing pixels in 56 frames of five journeys, including the airport close-up and city lights at night ([verification.md](verification.md#hardware-tiers-phase-1)).
- **Desktop is reached only with `?tier=desktop`** for now, so its cost can be measured before anything promotes a device to it. A startup benchmark and automatic promotion are phase 2.
- **Choosing a tier.** The old phone rule (screen's short side under 600 px, 4 GB of memory or less, 4 cores or fewer), plus the GPU: a software renderer (SwiftShader, llvmpipe, the Basic Render Driver, or a browser that refuses a context with `failIfMajorPerformanceCaveat`), or no complete RGBA16F framebuffer, also means phone. Everything else starts at laptop. The renderer string is used only to spot software rendering, never as a list of good GPUs: Safari answers "Apple GPU" and lists go stale. One throwaway context answers all of it, and also gives the largest texture size, which `maxTextureSize()` used to make its own context for.
- **Stepping down.** Playback below 20 fps for 3 seconds steps one tier down, desktop to laptop to phone, as `standard` stepped to `low`, and is now remembered in `localStorage` (`rr.tier`) for that GPU and renderer version, for a week. Before, a laptop that had to step down started at `standard` again on the next visit and stuttered for 3 seconds again.
- **Overrides:** `?tier=phone|laptop|desktop` starts there; `?samples=N` (1–32) draws previews and exports with N samples; `?debug` pins laptop (or the `?tier` given) and one sample, so frame comparisons don't drift with the machine. `?measure` shows the tier and why it was chosen.
- **No tier in the timeline.** `buildTimeline`, `evaluate`, `exposureAt`, label layout and storyboards take no tier, and nothing under `src/shared` imports the app (a test reads every file). `planNightDetail` takes only a cap, and its order doesn't depend on it. The golden states and the storyboard fixture are unchanged.

**Exports: jittered samples, averaged after tone mapping.**

- **How** (`display.tsx`): the scene light is drawn N times at the same moment, the image shifted by a sub-pixel offset each time (a fixed Halton (2, 3) table inside ±½ pixel, the centre last; `jitter.ts`). Each sample is tone mapped and added at 1/N into one more half-float target, and that average is encoded to sRGB once. Labels, routes and the other graphics are drawn once, unjittered, over the result, tested against the centre sample's depth, as before. World matrices and the aircraft's shadow maps update on the first sample only. One sample is the old path, untouched; without half floats it is always one.
- **Tone mapped before averaging,** so a bright edge stays as bright as the share of the pixel it covers: a glint over one eighth of a pixel adds an eighth of its display value, where averaging the light first would turn the whole pixel white (`toneMap.test.ts`).
- **No temporal antialiasing.** It feeds each frame from the one before, so seeking and playing would draw different pixels.
- **How many samples.** Every export already began with a 15-frame probe export. It still does, at one sample, and the probe must still decode. Where the tier offers more than one sample, two more 8-frame renders at the most samples offered (8), one from the start and one mid-journey, time a sample; the slower of the two stands for the journey. The export takes the most samples whose projected length, times 1.5, fits the budget: the larger of 90 s and three times the clip. A phone offers one sample, so it probes and exports exactly as before.
  - **Why two ranges.** The first version timed 16 samples mid-journey only, as the design proposed, to catch whole-globe flight frames that the start hold under-predicts. In all three test journeys it was the other way round: at 16 samples the start's close airport framing cost 34–42 ms a frame at 720p, mid-journey 24–34 ms. Projections came out at 0.56–0.80 of the actual export, outside the margin. With both ranges they came out at 0.70–1.24 of it, inside.
  - The page's export report (`page.export` for browser tools) carries `samples` and `msPerFrame`, and the console logs the probe's timing and choice.
- **What it changes.** Mostly city lights, which lose their pixel speckle, and the airframe's and clouds' edges, which 4× multisampling already smoothed. The paused preview at 8 samples against 1 differs at 44.6–55.5 dB, a mean of 0.1–0.4 levels; 16 against 8 only at 55–59 dB. H.264 hides part of it in the file.
- **Cost** ([budgets.md](budgets.md#export-duration)): on the M1 Max a 10-second journey that took 6 s from Export to file takes about 8–9 s at 720p and 15–17 s at 1080p at 8 samples. One more half-float target the size of the frame: 7 MiB at 720p, 16 MiB at 1080p.
- **At most 8 samples** (the owner's decision, November 16, 2026). The tiers first offered 16, and the probe chose 16 for every test journey: about 18 s at 720p and 31 s at 1080p, 1.7–2× the time of 8, for a difference of 55–59 dB, part of which H.264 hides. `?samples=16` (up to 32) still draws more for a comparison.

**Desktop.**

- **12 atmosphere steps, not the design's 16.** More steps change the air's light only where sunlight grazes the terminator, and there the 8-step march is a little too bright. At deep dusk over Johannesburg, 16 steps made the frame 3.4 % darker than laptop's 8, outside the ±3 % that tiers may differ by; 12 steps made it 2.5 % darker. The march converges to about 4 % darker than 8 steps, so phase 2 has to choose: retune the art direction to the converged air on every tier, or keep 8 as the look and give desktop no extra steps.
- **1024² aircraft shadow maps** keep the same soft radius on the airframe in twice the texels, and 256 city-light tiles (WebGL 2's least `MAX_ARRAY_TEXTURE_LAYERS`) keep more airports sharp on long trips.

Not done (later phases of the design):
- A startup benchmark that promotes capable devices to desktop, a GPU-timer governor that steps down earlier than frame rate, and a WebGPU adapter hint.
- An export budget override (`?export-budget=`), the samples in the MP4's metadata, more atmosphere steps in exports, and motion blur from the same accumulation loop with a time offset per sample.

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
- **Gradient for free:** the 32³ noise texture now carries its gradient in G, B, and A beside the noise in R (since November 13, a 64³ cellular texture with the same layout; see [cellular billows](#cellular-billows-with-real-gaps)). That is a central difference, smoothed [1, 2, 1] / 4 across the other two axes (a 3D Sobel filter). The gradient arrives with the noise reads the shader already makes, so there are no extra texture reads. Plain central differences showed the lattice as facets under a low Sun.
- **Light:** the level deck's light, unchanged (it catches light a little past its horizon, reddened through the air), times e^(2.5 (N·l − n·l)) (`CLOUD_SHADING`). N is the tilted normal and n the shell's. For a tilt θ toward the light, the exponent is about 2.5 θ cos(elevation), so the contrast peaks at sunrise and sunset by itself. The result is smooth and never black. Flat decks get exactly what they did before, so the gold terminator, noon brightness, and the ground's cloud shadows (which read only the cloud water) are unchanged. Moonlight is shaded the same way.
- **Cost:** per cloud pixel, the "lee" shading's extra cubic read of the cloud field is gone: 10 texture reads for the Sun, and 10 more under moonlight. In their place come about 30 arithmetic operations, and the noise texture grows from 32 KiB to 128 KiB (RGBA). Frame times didn't measurably change ([budgets.md](budgets.md#frame-time)).

Not done:
- **Deck-scale slopes from the cloud water.** Screen-space derivatives of the cloud water are free, but they come per 2×2-pixel block, which a low Sun turned into visible steps. Finite differences of the smooth field would cost 20 more texture reads per pixel. Edges of decks still thin out through their opacity.
- **Shadows cast by one billow on another,** as the offline renderer's volume gives. Only slopes turned away from the light darken.

## Sky light on clouds

*Decided November 13, 2026.* Cloud tops are lit by the clear sky above them as well as by the Sun, the Moon, and city light. Billow sides turned away from the Sun take on the sky's blue-grey, and decks stay faintly blue for a few degrees after the Sun has set on them, where they used to only dim. The offline renderer lights its cloud volume the same way (`routereplay` `cloudlighting.py`, `cloud-lighting.md`).

- **The table:** sky radiance toward the zenith and at 45° toward and away from the Sun's bearing, at 64 solar elevations from −17° to 90° (evenly in its sine, so finest near the horizon). There is one set of rows per cloud layer, at the layer's height. It comes from the atmosphere's own model: the same Rayleigh and Mie constants, phase functions, exact Chapman columns, solar disc, and bounded secondary scattering as `AIR_GLSL` and the atmosphere shader, integrated in 96 segments per ray. JavaScript builds it once per page, in about 5 ms (`skyLight.ts`), and uploads it as a 64×6 half-float texture (3 KiB). `tests/skyLight.test.ts` checks that its constants match `AIR_GLSL`.
- **What it gives:** at the deck's height, a deep blue zenith (about 0.008, 0.018, 0.042 in linear RGB with the Sun 45° up, where a white surface facing the Sun above the air reads 1; in linear light since November 14, 2026, × (1.05, 1.12, 1.31), in the [ground's units](#the-air-and-clouds-in-the-grounds-units)), brighter toward a low Sun than away from it. It stays lit and blue until the Sun is 6–8° below the deck's horizon, mostly from the atmosphere's secondary-scattering term. Above the deck there is little haze, so the sky there is darker and bluer than seen from the ground.
- **Slopes:** each of the three directions is shaded with the same slope term as the Sun, e^(2.5 (N·d − n·d)), and weighted by its cosine from the vertical (1 at the zenith, 0.707 at 45°), so an even sky L lights a level top with L. A slope turned from the Sun faces the away-from-Sun sky and loses the Sun at once, so it turns blue-grey.
- **Thinning with thickness:** per unit of opacity, thick cloud reflects less sky light than thin cloud, because light from the sky is lost on its way down to the depth the view reaches. The share is the column integral of single scattering, (1 − e^(−τ(1 + k/μ))) / ((1 + k/μ)(1 − e^(−τ))), for the cloud's optical depth τ (from its opacity), the direction's cosine μ, and the offline renderer's blend of direct (80 %, k = 1) and more diffuse penetration (20 %, k = 0.35). Thin cloud keeps all of it; thick cloud about half from the zenith and 45 % from the sides.
- **One deliberate difference:** sky light is reflected at the cloud's albedo (0.55–1, from its density), not with the sunlit deck's gain `CLOUD_BRIGHTNESS` = 2.4. With the gain, the per-layer tone map turned the gold band along the terminator a pale blue-white. At the cloud's albedo the band keeps its warmth, and the twilight band beyond it still shows. Checked again in linear light on November 14, 2026 (gain 3.2 there): the gain still turned the band blue-grey, and cooled a noon deck by only 2 % in blue.
- **Moonlight:** the Moon lights the same sky, through the same table, scaled like its direct light (only while it is up). The atmosphere still draws no moonlit air ([Water that reflects the sky](#water-that-reflects-the-sky)), so this only tints the shaded sides of moonlit decks.
- **Cost:** per cloud pixel, 3 more texture reads of the tiny table (6 under moonlight) and about 70 arithmetic operations, 11 of them exponentials. GPU memory: 3 KiB. Frame times didn't measurably change ([budgets.md](budgets.md#frame-time)).

Not adopted:
- **A phase function on the direct Sun** (the offline renderer's 65 % isotropic and 35 % Henyey–Greenstein, g = 0.65). This camera looks down at the deck, so the scattering angle stays within about 30° of side-on. Normalized, the phase changed the test frames by at most 1.3/255 on average, a slight brightening of the terminator band. Only views across the terminator toward a Sun behind the globe would show a silver lining, and this camera rarely takes them. Unnormalized, it would have dimmed every deck by about a quarter.

## Cellular billows with real gaps

*Decided November 13, 2026; carving revised November 14, 2026.* Cloud detail comes from a cellular texture of rounded lobes instead of value noise, and coverage carves real gaps. Broken cloud now reads as separate cumulus heads with clear sky between them, where it used to be a soft, mottled sheet with a thin floor of opacity everywhere the model had any cloud water. The offline renderer reconstructs its billows the same way (`routereplay` `cloudshapes.py`, `cloud-morphology.md`), in a volume this scene can't afford.

- **The texture** (`cloudShapes.ts`): 64³ texels that tile, built once per page from a fixed seed. Each cell of a 16³ lattice holds one jittered point and a flat-topped dome around it, h (1 − (d/r)⁴), with its own height h (0.6–1) and radius 0.9 cells. Domes merge through a smooth maximum, so lobes stand as rounded heads with soft valleys between them, where a plain nearest-point (Worley) field has creases. A broad, smooth value noise (30 %, 4 cells to a tile) gathers lobes into clusters. The shell slices through the 3D domes, so lobes come in many sizes. The layout is the old one: lobes in R and their analytic gradient in G, B, and A.
- **Shape:** lobes about 100 km across (the texture repeats every 1,600 km), eroded at their edges by the same texture 2.6× finer (about 38 km): lobes − 0.3 × (1 − finer lobes). That is still 2 reads per copy.
- **Gaps:** the model's opacity splits into cover and thickness. Lobes cover a fraction water^0.3 of the sky, so thin cloud breaks into faint, scattered lobes with clear sky between them and thick cloud closes into a deck. A lobe is carved at the shape value that the chosen fraction of the texture exceeds. Those levels come from the texture's own distribution, measured at 40,000 seeded points (33 values per table, passed as uniforms), so any cover is exact. Rims are soft and translucent, cores opaque. A second table holds the mean of the carved lobes at each level, and lobes are as opaque as keeps the area's mean opacity the model's.
- **No pulsing:** each of the two drifting copies is carved before the two are blended. Blending first would narrow the shape's spread halfway through each renewal, and cover would dip every 90 minutes of model time.
- **Relief:** tops rise 0.006 Earth radii (38 km) per unit of the shape, times the lobe's thickness. A lobe stands about 19 km above its surroundings, 1.6 km of real cloud at the scene's 12× height exaggeration, close to real cumulus. The old relief (`CLOUD_RELIEF` = 0.05) assumed noise far gentler than these domes.
- **Unchanged:** wind drift, the two-copy renewal every 3 hours, the lighting from [cloud tops lit as shapes](#cloud-tops-lit-as-shapes), and the ground's cloud shadows, which read only the model's cloud water.

**Carving without the grid (November 14, 2026).** The first version showed the texture's grid. Close up, lobe edges ran in stair steps and square notches lined up with north and east. In whole-globe views, broken cloud turned into salt-and-pepper speckle with square holes. Two causes:
- **Facets:** a dome's flat top fell to its base within about one 25 km texel, and the texture's axes were the Earth frame's. Trilinear filtering draws a drop that steep, and any contour carved through it, as facets along the texel grid, so edges stepped along north and east.
- **Aliasing:** in a whole-globe view a lobe spans about 9 pixels, the finer octave about 3.5, and a texel 2–3. Carving every pixel separately sampled detail smaller than the pixel, so it aliased into speckle.

The carving now:
- **Bakes a smoother field:** the lobes are smoothed [1, 6, 1] / 8 along each axis, so a dome's edge spans about two texels. Their gradient was already smoothed [1, 2, 1] / 4, which keeps its creases from showing as seams under a low Sun. Smoothing the lobes that much too blurred them into a soft, featureless mush.
- **Breaks the alignment:** the lookup is turned by a fixed rotation, and the finer octave by another. Any facets that survive filtering no longer line up with each other, or with north and east. Nudging the finer octave's lookup along the coarse lobes' gradient also worked. It cost a dependent texture read, though, and the rotations alone were enough.
- **Antialiases each edge:** a lobe's rim widens by what one pixel spans of the shape being carved (`fwidth`), so edges stay about a pixel soft at any distance.
- **Fades detail too small to draw:** the shader measures how many pixels a lobe spans. As that falls, carving fades toward its mean, from per-level tables, so mean opacity doesn't change:
  - **Finer octave:** fades over 3–8 pixels per finer lobe. Its share goes to the lobes alone, carved at their own levels.
  - **Lobes:** fade over 4–16 pixels per lobe.
  - **Result:** close-ups and regional views draw full detail. A whole-globe view shows the soft deck with gentle broken texture, not speckle.
- **Cost:** per cloud pixel, the same 4 reads of the 3D texture. About 50 arithmetic operations: four carvings, one lookup of the level table (both levels and both means packed in one vec4 per level), two rotations, and screen-space derivatives. GPU memory is unchanged: 1 MiB for the texture, plus 33 uniform vectors for the table. Building the texture and its tables takes about 100–165 ms on a heavily loaded M1 Max (texture 80–135 ms, tables 20–30 ms; more on a phone), once per page. It starts when the first weather step is requested, so it overlaps the download. See [budgets.md](budgets.md#frame-time) for frame times.

Limits:
- **The 1° grid still shows** in the shape of large thin areas: carving follows the cubic-smoothed model field, so thin cloud's lobes cluster in soft squares a degree across.
- **Lobes are softer close up** than in the first version, since the smoothing that removes the facets also rounds the domes' edges.
- **The high layer shares the texture,** so its streaks are smoothed slightly too.

## A high cloud layer

*Decided November 13, 2026.* Thin, streaky high cloud (cirrus) is drawn on its own shell above the main deck, moved by the wind near the jet stream. It shifts against the deck as the camera climbs and descends, and it shades the deck and the ground. The offline renderer draws low, middle, and high cloud at 1.5, 5.5, and 10.5 km, each moved by its own wind (`routereplay` `cloudlayers.py`).

- **Which field:** the ice mixing ratio (`ICMR`) at 200, 300, and 400 hPa, from the same 1° forecast file. Each level stands for a 100 hPa slab (150–450 hPa, about 6.5–13.5 km), so the ice water path is Σ q × 10⁴ Pa / g. The optical depth is 3 IWP / (2 ρ r), for ice of density 917 kg/m³ and effective radius 30 µm, the offline renderer's assumption: 54.5 per kg/m². Compared on the 12 UTC 12 November 2026 run (3-hour forecast):
  - **High cloud cover (`HCDC`) over-reports thin cirrus,** as cloud cover did for the deck. It is over 50 % on 38 % of the globe, but the median optical depth of the ice there is only 0.2, and on a third of that area it is under 0.1.
  - **Three levels capture the ice path:** 200, 300, and 400 hPa correlate at 0.988 with the path over every level from 100 to 450 hPa. Two levels (250, 350) reach 0.972; 300 hPa alone, 0.90.
  - **Cloud water already counts ice:** column cloud water matches the liquid plus ice paths (correlation 0.95, ratio of means 0.995), and about 14 % of it is ice above 400 hPa. So the deck now draws cloud water less the high layer's ice. Each kilogram of ice is drawn once, on the layer where it sits, and thick anvils move from the deck to the high layer.
  - **Upper-level snow (`SNMR`)** adds about a quarter more mass above 450 hPa. It is left out: the model's snow is precipitating ice, not the cloud a viewer sees.
- **Opacity:** ice scatters mostly forward, so it turns back far less light than a water cloud of the same optical depth, and hides little of what lies below. The layer's opacity is 1 − e^(−0.25 τ). Thin cirrus (τ ≈ 0.3) gives a faint 7 % veil, τ ≈ 3 about half, and anvils (τ ≈ 10 and more) are opaque. Single scattering gives about (1 − g) / 2 ≈ 0.15 for ice's asymmetry g ≈ 0.75; 0.25 lets thin cirrus read at globe scale.
- **Motion:** the 250 hPa wind, near the jet stream, carries the layer between steps exactly as the 700 hPa wind carries the deck. It is stored at 1.2 m/s a step (±152 m/s), since jet cores pass the deck's ±77 m/s.
- **Height:** 10.5 km at the scene's 12× exaggeration, like the aircraft: radius 1.0198. That is 95 km over the deck and just under a plane at cruise (1.0207). Its light and sky are taken at 10.5 km in the air's own convention (7.2×), so its sunsets redden like the air around it. At the drawn height it would have 89 % of the air below it and stay white through sunset.
- **Streaks:** the billows' lobes (about 130 km across), averaged over three points 40 minutes of 250 hPa wind apart, a short line integral along the flow. Under a 40–70 m/s jet, streaks run 300–500 km long; where the air is still, they stay round. Streaks gather the ice along them and thin it between them, keeping about the area's mean opacity. Two copies drift and renew like the deck's. Shearing the texture along the wind instead (sliding its coordinate by a second read) folded it into dark squiggles where the shear changed fast.
- **Lighting:** like the deck without billows: sunlight reddened by the air above the layer, its own row of the sky table, and the Moon. In linear light, as for the deck, the air above returns a little of its light ([the air and clouds in the ground's units](#the-air-and-clouds-in-the-grounds-units)).
- **Shadows:** where the light crosses the layer, it takes away up to 50 % of the direct light on the deck and the ground (`cirrusShadow`, in the shared cloud GLSL). Forward scattering passes the rest.
- **Texture units:** none added. The layer's opacity rides in the G channel of each step's cloud texture (now RG8), and the 250 hPa wind in B and A of its wind texture (now RGBA8). The ground shader still binds 13 of the 16 units a phone guarantees.
- **Data:** five more GRIB2 messages per step: ice at three levels (26–43 KB each, about 110 KB) and the 250 hPa wind (about 106 KB). Responses grew from about 190–245 KB to 400–470 KB per step, still one Worker request. The Worker makes six range requests per uncached step instead of two (plus the index), in parallel. The high layer's messages are optional: a file without them still draws its deck. The path became `/api/v1/weather/gfs-layers/{cycle}/{hour}`, because the old responses are cached as immutable. Every GFS v16 file from 22 March 2021 to 384-hour forecasts carries these fields (checked at both ends of the archive and in between).
- **Cost:** 0–2 ms more GPU time per frame on an M1 Max, and about 0.3 ms in phone emulation ([budgets.md](budgets.md#frame-time)). Per frame, the high layer is one more blended shell over the whole globe. Where it has no ice it costs 10 texture reads (its cubic opacity field and the wind) and then discards the pixel. Where it has ice: 21 reads (6 of them the 3D texture, 3 the sky table) and about 120 arithmetic operations. Its shadow adds 4 reads per light to every deck and ground pixel. GPU memory: weather textures double, to 382 KiB per step (9.0 MiB for a journey's 24 steps at most). Decoding a step in the browser takes about 12 ms instead of 5 on an M1 Max.

Limits:
- **Not a third layer:** low and middle cloud still share the deck. GFS's layer cover fields over-report as `HCDC` does, and splitting the liquid by level would need more downloads.
- **No billows or relief on the high layer,** and no city glow from below; anvils look smooth.
- **The deck stays at one height:** the ice moved off it leaves its other cloud in place.
- **At the limb,** the layer shows as a thin arc where it still catches twilight over the night side, 95 km above the deck.

## The aircraft's shadow

*Decided November 13, 2026.* The aircraft casts a soft shadow on the ground, the cloud tops, and the air over them. It shows where the plane is relative to the Sun: beside it at midday, about a length off at low Sun, and touching the wheels on the ground. The offline renderer casts none on the world, only the airframe's shadow on itself.

- **A stylized height.** The aircraft is an icon drawn hundreds of kilometres long, and its display height is small beside its length on long legs and large on short ones. A physically placed shadow would hide under the icon or land far from it. So the shadow is cast as if the plane flew `SHADOW_HEIGHT` = 0.3 of its own lengths above its parked height at cruise, in proportion to its share of cruise height while climbing and descending. It is cast along the Sun, raised to at least `SHADOW_LOWEST_SUN` = 27°. That puts it about 0.3 lengths off at 45° and never more than about 0.7 lengths away. On the ground it is cast from the parked height, so it touches the plane.
- **A silhouette, not a shadow map.** Each type's plan view is rasterized once, in JavaScript: the airframe's triangles without the propeller discs, 4×4 samples per texel, on a 128² mask 1.4 lengths across, softened by a box blur of radius 2 applied twice (since renderer 2.4, three blurs on a 160² mask 2 lengths across, so the shadow softens with height; see [below](#no-towers-an-electric-blue-accent-and-shadows-that-soften-with-height)). It is the same on every device, so preview and export agree. A shadow map would need another render pass every frame. Projecting the airframe's mesh would need a stencil buffer to keep overlapping faces from darkening twice, and couldn't see the cloud layer's opacity.
- **Drawn in the shaders that are already there.** The ground, cloud, and air shaders each find where the ray from their point toward the light crosses the silhouette, which lies level at the shadow height above the point below the plane. All three use that one footprint, so the shadow reads as one: on clear ground, on cloud tops, or both, weighed by the cloud's opacity. The plane is always drawn above the clouds, so it shades them even when parked under the deck. (Reversed on November 15, 2026: under the deck, the shadow stays off its tops; see [aircraft under the cloud deck](#aircraft-under-the-cloud-deck).)
- **What it takes away:** `SHADOW_DEPTH` = 75 % of direct sunlight on the ground and cloud tops, and 75 % of the light the air scatters over the footprint. That last part is a stylized shadow volume. Without it, the haze laid over the ground left the shadow only 1–14 % darker than its surroundings in test frames, and it disappeared over the sea.
- **When it shows.** It fades in as the Sun climbs from the horizon to 20° above the plane (`SHADOW_FULL_SUN`), so it is gone at night and never sits where a low Sun couldn't put it. While one type dissolves into the next at a stop, each type's silhouette is weighted like the airframe. Train, bus, car, and ferry vehicles cast their own shadows and none of this. The homepage's planes cast it too (up to `MAX_CASTERS` = 3 at once).
- **Cost:** per ground, cloud, and air pixel, three uniform tests. Within a shadow's reach, about 30 arithmetic operations and one texture read per aircraft. The ground shader binds three more textures (13 of the 16 a phone guarantees). Masks are 16 KiB each (100 KiB since 2.4), kept for the page's life like the airframes. Frame times didn't measurably change ([budgets.md](budgets.md#frame-time)).

Limits:
- **No moonlight shadow.**
- **Near the limb,** the air's share follows the ground point the view ray reaches, so a shadow there darkens a long grazing column of air. The journey camera keeps the plane in the frame's centre, so this shows only on the homepage, and only rarely.

## The aircraft in the scene's own light

*Decided November 13, 2026.* The aircraft, and the train, bus, car, and ferry models, are lit by the same Sun, Moon, air, and clouds as the globe, and the aircraft shades itself, as the offline renderer's Cycles pass does (`routereplay` `aircraft_blender.py`, `aircraft_night.py`). Before, a plain white directional light (2.4) and ambient light (0.5) lit them, and after sunset their paint was multiplied by a fixed blue tint. So at golden hour the cloud tops below turned gold while the plane stayed white, and then it dropped to dim blue over about 1° of Sun. A midday frame looks as it did; the change shows at twilight and at night.

- **Once a frame, on the CPU.** `craftLight.ts` works out a handful of lights for the craft's place and time, and one paint shader (`craftPaint.ts`) uses them. No material in the scene is lit by three.js lights any more.
- **Sunlight through the same air as the cloud tops:** AIR_GLSL's Chapman columns and extinction, ported to TypeScript (`airLight.ts`; a test checks the constants match the shader's), times the share of the Sun's disc above the limb. It is taken relative to an overhead Sun, as the ground's light is, so white paint stays white at noon and a parked plane gets exactly the ground's light.
- **At the plane's real height.** The display height is 12× real so the icon stands clear of the ground, and the drawn air is spread 7.2×, so light is taken at 0.6 of the display height. At its display height a cruising plane would sit above nine-tenths of the air and stay nearly white until the deck below it had gone dark. At its real height it turns gold with the deck, a little behind it as a higher object should, and loses the Sun 9° after the ground does (11.7° before).
- **Sky light from above:** clear skylight on the ground under the plane, at the Sun's elevation: single scattering with the atmosphere's constants and its bounded secondary term, averaged over the sky with a cosine weight (30 rays of 8 steps, cached every half degree of Sun). At the plane's own height there is little air above it, and its shaded paint went almost black.
  - ×3, to the brightness of the offline renderer's aircraft sky (luminance 0.13 by day). Since November 14, 2026 the sky is in the [ground's units](#the-air-and-clouds-in-the-grounds-units), 10 % brighter, so ×2.7.
  - 35 % of its colour kept: light scattered more than once whitens real skylight to about 12,000 K, and single scattering alone left shaded paint deep blue. It read (0.10, 0.13, 0.17) at noon; since November 14, with 30 % kept, (0.11, 0.13, 0.18). It fades through twilight with the drawn air, gone 12° after sunset.
- **Light from below:** what the plane flies over, lit by the Sun, the Moon, and the sky. Where the cloud layer is, its opacity under the plane comes from the frame's GFS fields, carried by the wind as in the cloud shader (one CPU sample a frame), and a thick deck reflects 0.75 (since November 14, 2026, lit in the ground's units, with the light the air above returns to it, as in the cloud shader). Once the plane climbs over the high layer ([above](#a-high-cloud-layer)), its ice counts too, as cover over the deck, sampled along its own 250 hPa wind. Elsewhere it is the day map's colour. The air between dims it and adds the haze's own glow. A plane over a sunlit deck is lit from below; over the sea, hardly at all.
  - The day map's colour comes from its 256 × 128 mip level, drawn into a small target on the GPU and read back once per texture. Shrinking the image on a 2D canvas took 90–200 ms of main-thread time.
- **Moonlight** at its phase and distance, 4000× real, as on the globe.
- **A night rig:** the offline renderer's aircraft-only lights at strength 1. A key of (0.12, 0.14, 0.18) and a fill of (0.025, 0.03, 0.04) fade in as the local Sun goes from 2° to 12° below the horizon, with the navigation lights.
  - The key comes from the Moon when it is high (elevation sine 0.25) and bright (10 % of a full Moon's light), and otherwise from high on the frame's left. Directions are in the frame's terms, x right, y up the screen, z toward the camera, so on the homepage, where planes are seen at an angle, the rig lights the side the camera sees.
  - Why not the Moon alone: at 1 % of sunlight, it would leave the plane darker under a full Moon than the rig leaves it under no Moon. So the rig stays on, and the Moon steers it and adds its own light, as in the offline renderer.
- **Self-shadows:** a 512² shadow map fitted to the airframe's bounding sphere (about 400 texels per length), so wings, engines, and the tail shade the fuselage at low Sun. It follows the Sun while any of it shows, then the night key, whose shadow comes in over the next 1.5° of the Sun's descent, so a plane never renders two. Edges are soft: eight hardware-filtered taps in a fixed pattern, the same on every frame (1.2 texels for the Sun's disc, 4 for the broad night key).
  - The maps come from zero-intensity three.js directional lights. Each aircraft has a layer of its own (1–31), so only its airframe draws into its maps and only it reads them. While one type dissolves into the next, each shades only itself, and neither's wings print on the other.
  - Propeller discs are a mesh of their own and cast nothing. The ground, clouds, and air keep their stylized aircraft shadow, unchanged.
- **Reflections:** the paint reflects the two skies, above and below, with Schlick's Fresnel blurred by its roughness. No environment map.
- **Vehicles** get the same light and reflections, without shadow maps (at 20–80 pixels long, a self-shadow doesn't show). Their 1.2 daylight boost is gone.
- **Calibration:** at midday a plane measures within about ±10 % of before on screen (slightly brighter at cruise, slightly darker parked), with a little more shading on its far side.

Cost:
- **CPU:** about 4 µs a frame, 12 µs while the sky cache fills; each new half degree of Sun costs about 0.6 ms once, at most two a frame. The day map's grid is one draw and one read back per texture, about 10 ms; if the texture isn't on the GPU yet, its upload happens there instead of in the first frame.
- **GPU:** one extra pass of the airframe (up to 4,670 triangles for a 787) into a 512² depth map per aircraft, two while a connection dissolves types. The paint adds 8 shadow taps and four GGX lights per airframe pixel. Whole-frame GPU time didn't measurably change, except about +1 ms at 1280×720 DPR 2 during the dissolve at a stop ([budgets.md](budgets.md#frame-time)).
- **Memory:** 2 MiB per shadow map (depth, and the colour attachment three.js adds): 2–4 MiB per aircraft, up to 12 MiB with the homepage's three planes. Maps are freed with their plane.

Limits:
- No shadow from the fill or the Moon's own light, and cloud never shades the plane: it is drawn above the clouds. (Since November 15, 2026, a plane under the deck is veiled by it and its direct light dimmed; see [aircraft under the cloud deck](#aircraft-under-the-cloud-deck).)
- The sky light has no direction across the sky, so the bright horizon toward a setting Sun warms the plane only through the Sun's own light.
- From straight above at sunset the light grazes the wings and the top of the fuselage. The gold shows on the fuselage's sunward side and the nacelles, as in the offline renderer, more than on the wings.
- `sunlight.ts` (the homepage button's light) keeps its own simpler model.

## Aircraft under the cloud deck

*Decided November 15, 2026.* An aircraft under the cloud deck is drawn under it. Until now a plane was always drawn over the cloud layer, by decision ([the aircraft's shadow](#the-aircrafts-shadow)), so a plane landing under an overcast looked as if it landed on the clouds, its shadow on their tops. Now it sinks into the deck on the descent and breaks out above it on the climb. The offline renderer does the same: it composites the cloud between the camera and the plane over the plane (`routereplay` `cloudvolume.py`'s foreground layer, `render.py`), and ties cloud crossings "to aircraft altitude rather than icon size" (`aircraft_blender.py`). Renderer 2.6.0.

- **Submersion comes from altitude, not geometry** (`cloudCrossing.ts`). It is 0 at or above the deck's top (25.5 km as drawn, 2.1 km real), rises smoothly to 1 a kilometre of real cloud (12 km drawn) below it, and uses the plane's display altitude. The icon is drawn tens of kilometres tall at an airport, so a depth test against the shell would cut through its fuselage.
- **The deck, drawn again over the plane.** A second mesh with the airframe's geometry and placement draws right after the paint, only where the paint is the front-most surface: the same depth, from the same vertex expression, `invariant` in both shaders. For each pixel it finds where the view ray meets the deck's shell and runs the deck's own shader there. That shader is now one function, `deck(n)` in `DECK_GLSL`, shared by the deck and its veil, with the same lobes and gaps, sunlight, sky light, Moon, and city glow. The veil is drawn over the plane at the cloud's density × `VEIL_MAX` × submersion. So broken cloud veils only where a lobe covers the plane, and a moonlit deck veils it in moonlight. While one type dissolves into the next at a stop, hashed alpha discards the same pixels as the paint.
- **The plane under the deck is lit as the ground under it is** (`craftLight.ts`):
  - Direct Sun and Moon keep what the ground keeps under the same cloud: 1 − 0.54 × the cloud water where the light crosses the deck's top, scaled by submersion.
  - The clear sky above gives way to the deck's grey base, at the sky's luminance, plus the quarter of the lost direct light that the deck passes on diffusely (1 − its albedo of 0.75).
  - From below it sees the ground, not the deck's bright top.
  - Above the deck, and under clear sky, its light is exactly what it was (`tests/app/cloudCrossing.test.ts`).
- **Lamps and propeller discs** are graphics drawn after the tone-map pass, so they would show over the veil. They fade by the veil's average over the plane, taken from the deck's mean opacity there on the CPU.

The owner's decisions:

1. **A plane under thick cloud shows faintly through it, never fully hidden.** `VEIL_MAX` = 0.65, chosen by looking at an A350 parked under London's overcast: at 0.65 it reads as a pale aircraft in the cloud. Thinner or broken cloud veils less, in proportion to its density.
2. **The shadow stays off the cloud tops while the plane is under them.** The deck's shader weighs it by 1 − submersion, so it lands on the tops as the plane breaks out, sharp at first and softening as the plane climbs. The air over the footprint, the shadow's stylized volume, is weighed by 1 − the deck over the plane (submersion × its opacity there): under a deck that volume is hidden. The ground keeps its shadow, which its cloud shadow already dims (`planeShadow.ts` `ShadowSurface`).
3. **Crossings keep the existing altitude profile.** `evaluate()` is unchanged, so the golden states and the storyboard fixture are too. On a default 6 s leg the climb crosses the deck between 0.16 and 0.20 of the leg's screen time, about 0.26 s or 8 frames at 30 fps, and the descent mirrors it.
4. **No wake, canal, or hole punched in the deck behind the plane.**

Where else it applies:

- **Train, bus, car, and ferry legs** are always on the ground, so under the deck, and take the same rule with a lighter cap, `VEHICLE_VEIL_MAX` = 0.35 (the owner's decision, November 16, 2026). A vehicle stays under the deck for its whole leg while its route line and labels stay crisp over the cloud, so at the planes' 0.65 it read as a ghost for the whole video. At 0.35 a ferry under Helsinki's overcast on 12 November reads as a solid boat under thin cloud, with its shadow showing; its hull is about 15 levels darker than at 0.65. Their veil draws as graphics between the body and its lamps, tone mapped as it draws, like the vehicle itself. Their drop shadow, wake, and lamps fade by the veil's average.
- **The homepage's planes** fly at 0.006 Earth radii, above the deck's top (0.004). They carry the same veil, which never shows, and still shade the deck's tops.
- **The high layer veils nothing.** A plane is under it (10.5 km, 126 km as drawn) until it is 40 % of the way to cruise, almost half of every leg (u ≈ 0.45), so a veil would hide planes under anvils for half the flight. Over the tropics a plane at the gate therefore still sits on the anvils. At Singapore on 12 November the deck's opacity at the airport was 0–0.09 and the high layer's 0.48–0.99, and the before and after frames look the same.

Checked in Chrome at 1280×720, on journeys from real GFS steps, frame by frame through each crossing:

- **London under an overcast** (London–New York, 6 November): parked, the A350 is a pale shape in the cloud, with no shadow on the tops. Climbing out, it brightens over about 8 frames while its shadow appears beside it, and is clear of the deck by 2.82 s.
- **Broken cumulus** (Hong Kong–Bangkok, 12 November): only the parts of the plane over a lobe are veiled. At Hong Kong's gate that is the right wing alone.
- **A moonlit deck at dawn** (New York–London, 25–26 October): the plane takes on the deck's grey-gold as it sinks into it.
- **Phones** (390×844, low quality, DPR 1): the same, at about 700 veiled pixels.

Cost: per veiled pixel, the deck's shader once more and a ray–sphere intersection: about 8,400 pixels at 2560×1440 at the gate (0.23 % of the frame), none above the deck. Directly measured, it is within the run-to-run noise of whole-frame GPU timing; scaled from the deck's own cost per pixel, about 0.005 ms ([budgets.md](budgets.md#frame-time)). On the CPU, the plane's light takes 0.6 µs more under the deck, and setting a veil's uniforms 0.4 µs a frame. No textures or downloads are added.

Limits:

- **The veil has no air in front of it.** The plane is drawn after the air, so its veil is the deck as it leaves the cloud, not as seen through the air. Composited in linear light the difference is small: the veil's cloud comes out at (221, 221, 220) beside the deck's (213, 213, 213) at London's gate. In the fallback without half floats (`?display-referred`) the air is one premultiplied draw in display values that tints the deck to (210, 228, 247), while the veil stays (198, 197, 191). There a veiled plane reads as a grey shape rather than as cloud, and looks less sunk. Sharing the atmosphere's march as a function and adding its light over the veil would fix it.
- **A vehicle under an overcast stays veiled for the whole leg,** while its route line, markers, and labels stay crisp above the cloud. On a New York–Philadelphia train under a full deck, the train was a faint shape the whole way at the planes' cap; the lighter vehicle cap keeps it the subject, though still under the cloud.
- **The crossing is brief:** about 0.26 s on a default leg.
- **The deck's top is the drawn shell,** at 2.1 km real, not the real cloud top. GFS's cloud ceiling and liquid-water profile could place real tops for the steps near airports, about 0.5–1 MB more for a one-leg trip.
- **Lamps fade by the average veil over the plane,** not lamp by lamp, so a lamp over a gap in broken cloud fades too.
- **The vehicles' veil compiles when the first surface leg starts,** as their paint does. The aircraft's compiles with the first frame drawn with clouds, since every flight starts at a gate under the deck's top.

## Sharp city lights near airports

*Decided November 12, 2026.* Journeys draw city lights from the full-resolution Black Marble (about 0.93 km per pixel) where the camera comes close, and from the global night map everywhere else. At the closest airport framing a screen pixel is about 1.35 km, and the global map's texel 11 km (standard) or 20 km (low), so towns drew as soft squares 8–15 pixels across. Now they are points, and roads and coastlines show.

- **Tiles.** 5° cells of the city-light level, one channel, only for cells with light (1,213 of 2,592): 8.8 MiB for the world at standard, 3.1 MiB at low (half resolution). Encoding and layout: [assets.md](assets.md#static-assets-publicassets2026-11-12).
- **Plan.** The camera is a function of the timeline, so before playback the planner (`src/shared/timeline/nightDetail.ts`) steps through every frame, takes the circle of ground where that frame draws detail, and lists the cells it touches in the order first needed (by frame, then nearest first). Cells without a tile are part of the plan too: they are known to be dark and cost nothing. Nearby airports share cells. The plan stops at 128 tiles, so a long trip keeps its first airports sharp and draws later ones from the global map.
- **Where the detail shows.** By ground scale: kilometres per pixel of a 1080-pixel short side, as if the point were at the frame's centre (the camera's distance divided by the cosine of the viewing angle, over the 771-pixel focal length). The detail is whole below 4 km per pixel and gone at 6 (`DETAIL_FADE_KM_PER_PX`). At the closest framing that is 1,210 km around the airport, gone by 1,540 km (the left and right edges of a 16:9 frame); as the camera climbs it lasts at the frame's centre until the global map is magnified only 2×. It depends only on the camera and the ground, not the screen's resolution or shape, so export and preview agree, and the planner covers the same circle the shader uses.
- **Fading out.** At that circle's edge, and where a neighbouring cell isn't covered (a coverage flag in the index texture, filtered across the outer eighth of a cell), the tile first blurs toward the global map's resolution by raising its mip level, and only then gives way to the global map. A plain crossfade overlaid crisp points on soft squares and read as a line.
- **GPU.** One texture array (R8 with mipmaps) holding the plan's tiles in plan order, and an index texture (RG8, 4 texels per cell side) giving each cell's layer and coverage. Per ground pixel: two index reads, one array read where the detail shows, and about 20 arithmetic operations. The derivatives for the array's mip level come from the globe's texture coordinates, not from the tile's, which jump at cell edges.
- **Loading.** Tiles are fetched 8 at a time in plan order, decoded through an `OffscreenCanvas`, and uploaded one layer at a time. Playback waits for the first frame's tiles (the start hold sits at the first airport) and shows the rest as they arrive; export waits for every tile. The homepage loads none. Costs per journey: [budgets.md](budgets.md#startup-transfer).
- **Same light, same colours.** The tiles and the global night maps hold the same light level, and the global maps are the tiles averaged, so lamp colours, switching, and curfews are unchanged across the hand-off, and the cloud layer's glow still uses the global map ([city lights with their gradation](#city-lights-with-their-gradation)).

Not done:
- **Tiles for the frame's shape.** The detailed area is a circle sized for a 16:9 frame's width, so a landscape frame loads tiles above and below its edges that it never shows, and the corners of a 16:9 frame (out to 1,920 km) and the far ends of a tall phone's frame blur into the global map. Planning per frame shape would make the plan depend on the viewport.
- **Reusing layers.** A trip with more than 128 tiles' worth of airports could evict tiles it has passed, but seeking back would then need them again mid-playback.

## City lights with their gradation

*Decided November 13, 2026.* City lights keep the gradation NASA drew: bright centres, dimmer suburbs, and structure inside big cities, near airports and from orbit alike.

- **What was wrong.** The level came from the night map's warmth alone (red less 0.55 × blue), which peaks at bright orange and falls toward white. So bright suburbs and white city centres both clipped to full level: a third of all lit pixels. At the global map's 11 km it was hidden by the blur; at 1 km every city was one flat cream, and from orbit the global map's threshold dropped most small towns.
- **The level now.** The pixel's luma above the moonlit land under the lights, which matches NASA's grayscale Black Marble (the offline renderer's source) within a few levels from dim orange to white, with the warmth test kept only where it is smaller, to tell faint lights from the land. 10.5 % of lit pixels are now at full level, where the source itself is white. The level is used as it is: the offline renderer's power of 0.82 lifted suburbs toward their centres, and 1.2 lost the faintest towns. [assets.md](assets.md#static-assets-publicassets2026-11-12) has the details.
- **Computed once, offline.** `scripts/build-textures.py` computes the level per pixel of the full-resolution Black Marble. The night-detail tiles store it, and the global night maps are it averaged (3600×1800 and 2048×1024, one channel), so the global maps are the tiles averaged and the hand-off can't change brightness. The shaders read the level directly; nothing in them separates lights from land any more. The global maps also come from the full-resolution image now, not a 3840-pixel thumbnail, so towns too small for the old threshold glow faintly from orbit, and their download and GPU memory are smaller (see [budgets.md](budgets.md)).
- **Brightness.** The new levels carry 0.679 of the old total light, so city-light emission is 0.45 / 0.679 (the offline renderer's 0.45 is the numerator). Centres are brighter than before and suburbs a little dimmer. Mean screen luminance moved by −4 % to −1 % at the closest airport framings, +1 % to +2 % mid-flight, and +15 % on the homepage globe, where the small towns now show.
- **Sampling.** Where the global map is magnified (the frame's edges near airports, beyond the detailed area), the shader samples it through a cubic B-spline; bilinear sampling of a level map draws its texel grid as soft squares. The old map hid that grid behind its threshold.
- **Unchanged:** lamp colours, regional mixes, switching at dusk and dawn, curfews, twilight, and city light glowing up through cloud.

## One camera: the offline renderer's

*Decided November 12, 2026.* Journeys use one camera, ported from the offline renderer (`routereplay` `motion.py` and `camera_geometry.py`). The three presets (`overview`, `follow`, `cinematic`) and `presentation.camera` are gone. Renderer 2.0.0.

- **Framing:** the camera looks straight down at the aircraft, north up, and stays over the airport during holds and stops.
- **Zoom:** at airports the globe's radius spans 1300 px of a 1080 px short side (70° across it). Mid-flight it pulls back toward 440 px, scaled by the leg's length as a share of the trip's longest. Long legs show the whole Earth; short hops barely leave the ground. (Train, bus, car, and ferry legs no longer pull back this way: see [surface legs filmed like a drone](#surface-legs-filmed-like-a-drone).)
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
- **Never blocking:** a lookup failure saves the journey with a straight line and a warning (`route_not_found`, or `route_unavailable` to retry on the next save). Results that end more than 50 km from their airports, or run more than 4× the straight distance plus 50 km, count as not found: the router found some other network. Since November 15, 2026, BRouter giving up on a search for time counts as unavailable, not as not found ([below](#surface-legs-filmed-like-a-drone)).
- **Fair use of community services:** lookups run only on create and replace (never on `/validate`), one at a time, after the rate limits; a leg keeps its route on later saves while its mode and airports don't change; results are cached at the edge for 30 days (not-found for a day) and shared between drafts; and all drafts together get 1,000 lookups a day (`ROUTE_LOOKUPS_PER_DAY`). `SURFACE_ROUTING=off` turns lookups off. At scale, run our own BRouter and OSRM or pay a provider.
- **CPU:** a free-plan Worker has 10 ms of CPU per request. BRouter returns about 1 KB per km of track; a 657 km route (633 KB) reads and simplifies in about 2.5 ms in a warm isolate, almost all of it `JSON.parse`. Rail responses over 1.5 MB (about 1,500 km) are drawn straight rather than risk failing the save. See [Worker CPU](#worker-cpu-within-the-free-plan).
- **Attribution:** the routes are produced from OpenStreetMap (ODbL). Whenever a leg has a route, the watch and draft pages show "Map data © OpenStreetMap contributors" in the corner of the stage (the route summary carries it too, for screen readers and the fallback), and the acknowledgments page lists OpenStreetMap, BRouter, and OSRM. Exported videos carry no credit yet; that is an open question.
- **Timing:** surface legs may take up to 7 days (flights 30 hours). Their default screen weight is at least 0.5, because distance weighting gives a 70 km ferry crossing about a twelfth of a Pacific flight's time and it flashes past in a second. Speed warnings use ground bounds: over 350 km/h, or under 5 km/h on legs over 12 hours. `long_block_time` doesn't apply.
- **Storyboards:** a surface leg in motion has phase `surface` (flights keep `flight`), the summary names the mode ("By ferry WLG → PCN, 50% of the way"), and the sketch draws the route dotted.
- **Compatibility:** the field is optional and journeys with only flights evaluate exactly as before, so the published fixture's pinned states are unchanged and this is a minor renderer bump.

## Train, bus, car, and ferry models

*Decided November 12, 2026.* Each surface mode draws its own vehicle in place of the gold marker. They are built in code in the aircraft library's style (`src/app/render/vehicles.ts`): rounded sections lofted along the body, with no model files. The camera looks straight down, so the plan view tells them apart:

- **Train:** a locomotive with a sloping blue nose (gold before renderer 2.4) and a dark windscreen, then three white cars with grey roof ridges, joined by dark gangways. Each car is its own body, placed on the route behind the one in front, so the train bends with the line.
- **Bus:** a coach 3.3 times as long as it is wide. It has a long, flat white roof over a dark band of windows that wraps round a deep windscreen, and a blue roof pod.
- **Car:** 2.2 times as long as it is wide: a red body with a dark glass cabin between the bonnet and the boot.
- **Ferry:** a navy hull with a pointed bow, grey open decks, a white deckhouse, dark bridge windows facing forward, and a blue funnel. While it is under way, a V-shaped wake trails behind it along the route. The wake stays on the ferry's own leg, so leaving port it grows from the terminal instead of reaching back over the land.

Other choices:

- **Size:** constant on screen, like the aircraft, but about a third of its size. The car is 4.0 % of the frame's short side, the bus 5.2 %, the ferry 5.4 %, and the whole train 10.7 % (each car 2.4 %). At the closest zoom (about 1.3 km a pixel at 1080p) a single vehicle is 58–78 km long.
  - Ground legs are short. Wellington to Picton is 99 km, so a plane-sized ferry (15 %, about 220 km) would cover Cook Strait and both shores.
  - Much smaller and the shapes stop reading. At 720p the car is 29 by 13 pixels, about the least that still shows its cabin, and the ferry's 39 pixels show its bow, deckhouse, and funnel.
  - The old marker was 4.2 % across, so a vehicle hides about as much of the route as it did. On a crossing as short as Cook Strait the ferry still covers much of the route at the airports' zoom. That is accepted.
- **On the route:** each body stands with its front and rear on its own line: its leg's track, joined with any legs either side travelled the same way (`src/shared/timeline/journeyPath.ts`).
  - So it points along the chord of its own length of road, railway, or ferry line. The tangent of one 0.5 km segment of the traced route would make it jitter.
  - Beyond the line's ends the bodies carry straight on, in the direction of the line's first or last 30 km. Traced routes start and end at airports, often with a short connector to the station at an angle to the line. While a flight dissolves into a train, the cars wait straight back from the station along the railway's direction rather than along the flight's ground track. Arriving, the locomotive's nose carries on past the station rather than turning onto the next leg's route. (November 13, 2026; the first version let them run onto neighbouring legs.)
  - Legs of the same mode in a row (train after train) share one line, so the cars wait on the railway they arrived on and follow it out again.
- **Light:** the aircraft's lighting. (Since November 13, 2026, the scene's own Sun, Moon, sky, and night rig, without the self-shadow; see [above](#the-aircraft-in-the-scenes-own-light). The night tint and the 1.2 daylight boost below are gone.)
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

## Surface legs filmed like a drone

*Decided November 15, 2026.* Train, bus, car, and ferry legs used the flight's camera, so they looked like a plane taking off and landing. The camera climbed by 4p(1 − p) toward a whole-globe view, scaled by the leg's share of the trip's longest leg, and the vehicle eased with a flight's smootherstep. In a ferry-and-bus trip (Helsinki–Tallinn, then 282 km to Riga) the bus was the longest leg, so mid-ride the camera showed the whole Earth; a single 204 km train from Zurich to Milan did the same. The camera also sat exactly over the vehicle on its traced route, so every bend in a road or railway swung the whole shot sideways. The owner asked for surface legs that don't take off or land, and for a camera that glides like a drone shot where the path is shaky. Renderer 2.6.0 (`src/shared/timeline/evaluate.ts`, `src/shared/geo/smoothPath.ts`).

- **Zoom from the leg alone.** The camera stays at the airports' zoom: a 1300-pixel globe radius, which shows about 760 km from the frame's centre to its nearer edges.
  - It rises only where the ground straight below would otherwise cross the frame faster than a tenth of the short side a second (`SURFACE_SCREEN_SPEED`, 108 px/s at 1080p). The two heights are joined by an eighth-power mean, so the height follows the speed smoothly, is exactly the airports' at a standstill, and rises by under 1 % until the speed nears the limit.
  - It depends only on the leg's route length, its screen time, and how fast the vehicle is going at that moment. The trip's other legs don't enter.
  - None of the test legs comes near the limit. The fastest, Madrid–Barcelona (613 km of track in 7.1 s), peaks at 68 px/s, and its view widens from 759 to 769 km. Moscow–Vladivostok by train in 10 s would rise to 1.9 Earth radii from the centre, about what a long flight shows.
  - It can't zoom in closer than the airports: a pixel there is already 1.3 km, and a texel of the 8192-pixel day map is 4.9 km.
- **Pacing.** The vehicle gets up to speed over the first fifth of the leg's screen time (its speed follows a smoothstep), runs steady at 1.25 times its average, and slows the same way over the last fifth (`surfaceProgress`). It starts and stops with no speed or acceleration, so the camera is at rest over the station when a hold or stop begins. A flight's smootherstep peaks at 1.875 times its average and spends 31 % of its time on the first 18 % of the route, which read as a climb.
- **The camera glides; the vehicle keeps to the route.** The vehicle stands on the traced route, heading along it, as before. The camera is over the route smoothed along its length (`SmoothPath`): the tent-weighted mean of the route within ±w of the vehicle. The window w is half the ground that half the frame's short side spans straight below the camera, about 360 km at the airports' zoom. It is smoothly capped at the route's length.
  - Bends much shorter than w average away. The 246 km railway from Zurich to Milan becomes one gentle curve, and the TGV's 770 km to Marseille one long arc.
  - The mean is symmetric, so the camera neither lags nor leads. The shot stays north up and straight down.
  - A surface leg without a traced route has no bends to smooth, so its camera stays over the vehicle.
- **Safe area.** No point within ±w along the route lies farther from the vehicle than its distance along the route, so the camera stays within w/3 of the vehicle however the route winds or doubles back.
  - That keeps the vehicle within a twelfth of the short side of the frame's centre (90 px at 1080p). The safe area the tests check is an eighth (135 px; `SURFACE_SAFE_RADIUS`). The vehicle's centre also stays inside the 224-pixel square that the label slots keep clear for the aircraft.
  - On the test routes the vehicle drifted at most 31 px from the centre.
- **Ends and joins.** Beyond each end, the route is point-reflected through the end.
  - So the camera is exactly over the station at both ends of the leg, and near them it still cuts corners rather than stopping short.
  - Start and end holds, and stops between a surface leg and a flight in either order, join without a jump in position, zoom, or the up vector. The camera is at rest at each join. The tests check every boundary of three such trips.
- **Deterministic.** The mean is exact for the route taken as chords: a second difference of the route's twice-integrated position, from prefix integrals built with the timeline.
  - So it is a pure function of the record and the time. There is no frame-to-frame filter state, and no sampling grid to alias the wiggles.
  - Its position, speed, and acceleration are continuous.
  - Storyboards (`camera.centerLat`, `centerLon`, `viewRadiusKm`), labels, exposure metering, and the night-detail plan all read the same camera.
- **Measured motion.** Sampling the frame's centre at 240 Hz from `evaluate`, on the five traced test routes longer than 100 km:
  - Its direction of travel used to swing by up to 67–175° within one 30 fps frame. Now it swings by at most 0.36°.
  - Peak acceleration across the screen went from 921–11,318 px/s² to 4–73 px/s². What remains is the vehicle getting up to speed and slowing down.
- **Labels are unchanged,** but a departed label behaves differently over a surface leg. It is pinned to the ground and, with no climb, no longer shrinks away.
  - It stays full size and slides off the frame as the camera moves on. Tallinn's label does this as the bus heads south to Riga.
  - Heading toward it, perspective grows it slightly, and the rule that a departed label never grows back retires it over 0.3 s. Helsinki's goes 0.2–0.4 s after the ferry sails south, toward the ground under it.
- **Flights' pull-back still counts surface legs.** The longest leg that scales a flight's climb includes surface legs, measured by straight-line distance as before. A flight's climb shows its length against the whole trip. If a 9,000 km train ride didn't count, a 600 km hop after it would climb to the whole globe, as if it were the trip's longest leg. Flights in mixed trips are unchanged.
- **Route lookups that time out.** brouter.de answers HTTP 400, its status for "no route", also when it gives up on a search because it is busy ("operation killed by thread-priority-watchdog after 3 seconds").
  - On November 15 it did so for Oslo S–Bergen, Voss–Bergen, and Voss–Flesland within minutes of each other.
  - The save cached such an answer as not found for a day, and told the agent no railway existed.
  - Those answers now count as unavailable: not cached, retried on the next save, and reported with `route_unavailable`.
- **Cost.** A storyboard on the test routes costs 0.02–0.2 ms more warm, and 0.5–1.4 ms more in a fresh process, where they took 7–9 ms already. On the largest record possible (12 winding 1,500-point routes in 120 s) it costs 0.3 ms more warm, and 7.6 ms more in a fresh process, where it was already more than twice over the free plan's 10 ms. See [budgets.md](budgets.md#worker-cpu-cloudflare-free-plan-10-ms-a-request).
  - Nearly all of it is evaluating the camera once per frame for the label layout before the code is optimized. Building the integrals is about 0.5 ms for those twelve routes.
  - A first version cost 2 ms more warm on that record. Building the reflections from the route's own integrals rather than copying the route three times saved part of it. The rest was offset by no longer building a throwaway great circle for every pair of route points in `PathTrack.fromPoints`.
- **Compatibility.** This changes how every journey with a surface leg plays, which [compatibility.md](compatibility.md) calls a major change. It stays a minor version, as 2.2 and 2.3 did: there are no users yet, and a major would make every saved journey unplayable. Flight-only journeys evaluate exactly as before, so the published fixture's golden states and storyboard are unchanged.

When a route isn't found, the leg is still drawn straight between its airports, now filmed low. Nothing is invented: a road under a train, or a railway the router didn't return, would show a line the trip didn't take. What remains:

- **Airports that aren't on the network.** The airports stand in for stations, so the router starts where the airport is.
  - Bergen's airport, Flesland, is on the Bybanen light rail. BRouter traced Flesland to Bergen station, and Oslo S to Voss. But Oslo's airport to Bergen came back "no track found at pass=0" from both Flesland and Bergen station, while Voss–Bergen kept timing out. So it isn't clear whether that is a gap in the rail profile's network or the time limit again.
  - The fix that wouldn't invent anything is to let a leg name its stations: an optional coordinate, or a `via` list, at either end (see [Surface legs](#surface-legs-one-marker-for-every-mode)). It needs a schema field and agent docs, so it is a product decision.
- **Long rail routes.** Responses over 1.5 MB (about 1,500 km of track) are still drawn straight to fit the save's CPU budget ([Worker CPU](#worker-cpu-within-the-free-plan)).
- **Retrying a timed-out lookup within the same save** would double the load on a busy community server and add up to 10 s to the save. The next save retries instead.
- **Zooming in on short legs.** A 34 km drive to Annecy is 25 px long at the airports' zoom, shorter than the car. Showing it closer needs sharper ground imagery than the day map.

## Airport labels and route lines: the offline renderer's

*Decided November 12, 2026.* Airport labels, airport markers, and route lines are drawn as in the offline renderer (`routereplay` `labels.py`, `scene_overlays.py`, and its presentation contract). Before, each code sat in a rounded gold-edged panel just above a gold dot on its airport, fading in at mid-flight and out at 30 % of the next leg, and the route was a gold ribbon with a faint dashed path ahead. Renderer 2.2.0. Sizes below are pixels of a frame whose short side is 1080, scaled to the screen's short side as the field of view is.

- **Split-flap codes.** A 220×120 panel of three 66×108 cards, 5 apart in a 6-pixel border. Cards are dark painted metal, lighter on the upper leaf, with letters in (248, 247, 241) and hinge pins at the split. When a label appears its cards turn over from blank: an upper leaf falls about the axle over 0.52 s, accelerating (angle π(0.55u + 0.45u²)), its back carrying the new letter's lower half; cards start 0.11 s apart and all have turned by 0.74 s. The flip is timed by the label's age in presentation seconds, so preview, seeking, and export agree. Each panel is a canvas texture at the screen's resolution, redrawn only while its cards turn: about 0.1–0.4 ms a frame at 720p–1080p and 1 ms at a 2,160-pixel short side, then nothing.
- **Font.** The offline renderer uses Apple's DIN Condensed Bold, which can't be redistributed. Barlow Condensed SemiBold (OFL) at 103 px, narrowed to 88 %, matches its cap height and width.
- **Placement and timing.** Only the current leg's endpoints are introduced. A destination's label appears on the first frame its airport is on screen during the incoming flight (12 px inside the frame, 6 % of the way in from the limb). Until arrival it holds a fixed slot chosen before playback: left or right by the route's direction on screen at mid-flight, upper and lower lanes alternating by visit, scored to keep clear of the aircraft's central 224-pixel square and 18 px from the airport's path. At arrival its anchor locks to the ground under the panel; it stays put through the stop, then recedes with the ground, scaled by depth and fading out between 30 % and 12 % of its size. A departed visit retires before the leg after next begins, fading over its last 0.3 s. For the offline renderer's ORD→SFO→AKL demo at 9:16, the slots and the first and last frames of every label match its `labels.json` exactly (`tests/labels.test.ts`). Since renderer 2.3 a departed label also retires as soon as it would grow back ([below](#airport-towers-and-labels-that-stay-gone)).
  - The layout depends on the frame's shape, as the offline renderer's depends on its 1080×1920 frame, so a landscape and a portrait export can choose different slots. Storyboards describe 16:9.
  - Two labels can show at once (a departing one recedes while the next is introduced), never more, and only the current leg's endpoints (`tests/warnings.test.ts`). Plan 2's `label_crowding` warning still isn't needed.
- **Airport markers: kept, in the offline renderer's form.** (Renderer 2.3 gave airports a control tower and dropped the leader lines; 2.4 removed the towers and the arrival ring, so every place has this dot again, in the new accent once reached. See [below](#no-towers-an-electric-blue-accent-and-shadows-that-soften-with-height).) A 13-pixel dot inside a 27-pixel ring at 63 % opacity, pale blue-grey (171, 200, 206) until the aircraft arrives and the accent (255, 169, 116) after, shown while the airport's label shows and the airport is on screen. A 1-pixel leader line at 35 % of the label's opacity joins it to the nearest point of the panel. For 1.7 s after each arrival a 3-pixel ring grows from the airport (radius 14 + 29t) and fades from 71 % opacity. Markers, leaders, and rings are drawn over the ground, clouds, and route but under the aircraft: each pixel takes the depth of the ground beneath it, so only the aircraft hides it, as the offline renderer restores the aircraft over them. Train, bus, car, and ferry models draw after them (render orders 5–7 for markers, 10.35–10.6 for vehicles), so a vehicle waiting at a station covers its dot, and the panels draw over both (20).
  - Why: the panel no longer sits on its airport. On an approach it holds a slot that can be 300 px or more away, and without the dot its leader line ends in empty sea or among city lights, so nothing shows which place the code names. The contract's leader lines and its marker clearance assume a marker, and the offline renderer draws one. Comparison screenshots with and without the dot were made for this decision; removing the marker is one line in `Labels.tsx`.
- **Route lines.** Still only the flown part, ending at the aircraft, but the dashed path ahead is gone: the offline renderer draws none, and the destination's label and marker show where the flight is going. The line is 5 px of the accent over a glow, a 16-pixel line at 59 % opacity blurred by a Gaussian of σ = 11 px. As in Pillow's blur, colour and alpha blur separately, so the glow warms dark ground and dims bright ground slightly. Widths stay constant on screen at every zoom (before, they were in world units and shrank toward the limb). The accent replaces gold (`#ffc76b` → `#ffa974`); since renderer 2.4 it is an electric blue, `#2e8cff`.
- **Ground legs** (the offline renderer has none) take the same colour and glow, with the line drawn as 6-pixel dots every 12 px, as storyboard sketches already mark them. Dots are spaced along the ground at the airports' zoom, so they close up slightly while the camera climbs on a long ground leg. The glow follows a copy of the route sampled every 20 px, so a winding road doesn't fold the wide glow over itself.
- **Deliberate differences.** Routes stay at the aircraft's display height (11 km × 12 at mid-flight) rather than the offline renderer's 5.5 % of Earth's radius, so the line meets the 3D aircraft. Panels and lines are anti-aliased, and panel positions snap to screen pixels rather than to the 1080-pixel frame's.
- **Compatibility.** Label timing changed, so the published fixture's golden label states and storyboard were regenerated; see [compatibility.md](compatibility.md) for why this is a minor version.

## Airport towers, and labels that stay gone

*Superseded in part the same day by renderer 2.4: the towers and the arrival ring are gone ([below](#no-towers-an-electric-blue-accent-and-shadows-that-soften-with-height)). Labels that stay gone still apply.*

*Decided November 13, 2026.* The owner asked for a small 3D air-traffic-control tower in place of the ring marker under each label, no leader lines, and departed labels that don't come back. Renderer 2.3.0. Sizes are fractions of the frame's short side.

- **The tower** (`src/app/render/towerModel.ts`, `Tower.tsx`) is built in code like the aircraft and vehicles and stays the same size on screen: a 4.2 × 2.2 % base building to one side, a slim shaft, a gallery 3.6 % across, ten panes of glass sloping in toward a 2.4 % roof, a mast, and a gold beacon, 4.7 % tall in all. From overhead it reads as a roof inside a dark ring of glass inside the grey gallery, with the beacon at its centre.
- **Shadow.** It casts a soft shadow away from the Sun, 70 % dark: the shaft, cab, and base building swept along the light. The shadow is what shows the tower's height. Like the aircraft's shadow, it is placed for legibility rather than physically: cast as if the Sun were between 27° and 45° high, so it reaches at least one tower height out from under the cab and never more than about two. It fades in over the first 20° of the real Sun's height. Over dark forest or sea it is faint.
- **Light.** Lit like the vehicles: the scene's Sun and ambient light, the night tint after sunset, and 1.2 × the paint by day. After dusk (the Sun 2° to 12° below the horizon, as for the aircraft and vehicles) the glass glows warm, ten window lamps ring the cab, and the beacon flashes white and then green every 2 s. The flashes are timed by the label's age in presentation seconds.
- **Reached or not.** The roof takes the old marker's colours: pale blue-grey (171, 200, 206) until the aircraft arrives, the accent (255, 169, 116) after. At night it is lit to 30 % of its colour, so the state still reads. The arrival pulse is unchanged: a ring that grows from the airport for 1.7 s.
- **Lifetime:** as the marker's. It shows while the airport's label shows and the airport is in front of the limb, dissolving in over the label's first 0.3 s, out with the label, and near the limb.
- **Layering.** The tower is drawn over the ground, clouds, route, and arrival ring (render orders 7.8–8.5), and under the aircraft, the vehicles (10.35–10.6), and the panels (20).
  - It is drawn at full height but takes its depth from a copy squashed into the shell between 1.0002 and 1.0012 Earth radii. That is below the lowest point of a parked aircraft (1.0015) and of a vehicle (1.0016), so a waiting plane, train, or ferry always covers it, while the tower still hides its own far side.
  - Like anything tall in perspective, it leans out from the frame's centre, by about 5 % of its distance from it. Near the limb it shows in profile.
- **Stations keep the dot.** A place no flight touches, a station or ferry terminal standing for its nearest airport, keeps the offline renderer's 13-pixel dot in a 27-pixel ring.
  - Why: screenshots of Brussels with a train waiting and Picton with the ferry docked, each both ways, showed both markers mostly covered by the vehicle. The tower's base building and dark cab ring stuck out around a 15-pixel ferry hull and added clutter, and a tower says "airport" at a harbour or a railway station.
  - A place a flight touches anywhere in the journey gets a tower on every visit.
- **No leader lines.** The 1-pixel line from the marker to its panel is gone. Slots are unchanged and still keep 18 px clear of the airport's path.
- **Labels that stay gone** (a deliberate difference from the offline renderer). A departed label now retires on the first frame it would grow back, when the camera starts down toward the next airport after climbing away. It keeps the size it had shrunk to and fades out over 0.3 s.
  - Before, on a short or north–south hop such as Auckland to Wellington, the old label shrank and faded as the camera climbed, then grew back to full size beside the new one as the camera came down.
  - Retirement before the leg after next still applies, and a repeated airport still gets a new label on each visit.
  - In the published fixture's golden states, only ORD at frame 150 changed: it no longer comes back as the camera descends to SFO.
- **Cost.** A tower is 320 triangles and 4 draw calls by day (shadow, body, glass, roof), 5 after dusk (lamps); at most two show at once. Laying out the labels does no more work than before: first-keyframe medians of 1.0, 1.1, 1.8, and 3.4 ms for 18, 30, 60, and 120 s journeys (Node, warm), as on 2.2.
- **Storyboard sketch.** Routes take the accent over a soft glow (a 7-pixel line at 45 %, blurred by 2.5 px), with ground legs dotted. Airports are drawn as the tower from above (glass ring, accent roof, gold beacon) and stations as the ringed dot; the header adds "ringed dots: stations" when there are any.
- **Dosis removed.** Nothing has loaded it since the split-flap labels arrived. The font, its license, its manifest entry, its build-script entry, and its credit are gone from the current asset directory. The older 2026-11-11 directory is left as it was.

## No towers, an electric-blue accent, and shadows that soften with height

*Decided November 13, 2026.* The owner asked to remove the control towers and the ring that grows under the aircraft at each arrival, to replace the peach accent and the gold everywhere with an electric blue, and for the aircraft's shadow to grow more diffuse the higher the plane flies. Renderer 2.4.0.

- **Markers.** Every place, airport or station, has the offline renderer's 13-pixel dot in a 27-pixel ring again, with no leader line, under the same layering as 2.3: a waiting aircraft, train, or ferry covers it. `towerModel.ts` and `Tower.tsx` are gone.
- **No arrival ring.** The ring that grew from an airport for 1.7 s after each arrival is gone. `evaluate` no longer returns pulses, and labels no longer record whether their place is an airport.
- **Electric blue.** The accent is `#2e8cff` (46, 140, 255): the route line and its glow, a reached marker, and the storyboard sketch. A marker not yet reached stays pale blue-grey (171, 200, 206). The gold trim takes it too: the aircraft's tail stripe, the train's nose, the bus's roof pod, and the ferry's funnel. So do the page's older styles (links, focus rings, primary buttons, the spinner, the progress bar, the current leg's border, the 404 page's focus ring), the favicon, and the home-screen icon. The chat keeps shadcn's stock theme. The offline renderer's accent is still peach (255, 169, 116), a deliberate difference.
- **Shadows that soften with height.** Each type's mask holds three blurs of its silhouette, one per colour channel: box blurs of radius 2 (twice), 4, and 8 (three times each) texels, on a 160² mask 2 lengths across so the widest still fits. The shaders blend from the sharpest on the ground, through the middle at half cruise height, to the softest at cruise, following the same share of cruise height that raises the shadow. At cruise it is about twice as wide and peaks at about two-thirds of the parked shadow's darkness, so it reads as a soft patch beside the plane; parked, its edges are crisp.
  - Cost: one more uniform per aircraft and no more texture reads, since the three levels share one texel. Masks are 100 KiB each instead of 16 KiB.
- **Storyboard sketch.** Every place is the ringed dot in the accent; the header no longer explains station dots.
- **Compatibility.** The golden states and storyboard fixture are unchanged, so this is a minor version ([compatibility.md](compatibility.md)).

## Scenes have no frame shape

*Decided November 12, 2026.* A scene doesn't record an aspect ratio. The watch page fills the screen edge to edge. Viewers pick 16:9, 1:1, or 9:16 (and 720p or 1080p) only when they export a video.

- `presentation.aspectRatio` is rejected as an unknown field, like `presentation.camera`.
- Storyboards describe the 16:9 framing.
- The watch page keeps only a "make your own" button, share, export, and a play/pause button that appears on tap. The title, route summary, and data notes remain for screen readers and in the page title.
- The draft page has the same stage (November 12, 2026). Its top left showed the title and "Draft · Edited 5m ago" instead of the + button (since November 13, 2026, nothing: the chat's title bar names the trip, and the title stays for screen readers, as on the watch page). Its top right shows Publish, with no confirmation step, in place of Share. Once the shown revision has a watch link, Share takes its place again. Export is unchanged. "Your agent is working" floats at the bottom. The list of earlier watch links and the quality menu are gone; agents still list publications through the API. A publication now changes the draft's ETag, so an open draft notices when the agent publishes.

## Watch pages: out of search, previewed in chats

*Decided November 12, 2026.* Watch pages stay out of search results but carry a full link preview, so a link pasted into a group chat shows the journey.

- **Not indexed.** A journey is someone's itinerary, often a future trip, so an indexed watch page would announce when they're away. Watch pages, draft previews, and every `/api/*` response (snapshots and storyboards included) send `noindex` as a meta tag or an `X-Robots-Tag` header. `robots.txt` still allows everything: chat apps' preview fetchers obey it but ignore `noindex`.
- **Google's video results were out of reach anyway.** They need a video file or an embeddable player that Google can fetch, and the watch page draws on a canvas. Key moments also need videos of at least 30 seconds; journeys run about 15–25.
- **What the preview says.** The Worker writes the page's title, description, Open Graph, and Twitter card tags (`src/server/share.ts`) in place of the homepage's, which sit between the `share:start` and `share:end` comments in `index.html`. The title is the journey's (`journeyTitle` in `src/shared/scene/title.ts`, which the pages use too). The description lists the stops by city and the total distance. It doesn't count legs, so it stays right once legs can travel by land or sea. Dates are left out because chat apps keep their copy of a preview after the owner deletes the journey. Draft previews get the homepage card.
- **One image for every journey.** `public/share/journey-<date>.jpg` is the homepage globe without text, made by `scripts/browser/share-cards.mjs`. A picture of each journey's route would have to be rendered outside the Worker: on the Workers Free plan, rasterizing an image there exceeds the CPU limit. One way is for the draft page, which is usually open when a journey is published, to render a still and upload it to R2.
- **Status codes.** A missing journey's page returns 404 and a deleted one's 410, both `noindex` and without journey details. Watch pages revalidate on every view (`public, no-cache`), like the snapshot, so deletion takes effect at once. Any other unknown path gets `public/404.html` with a 404 (`not_found_handling = "404-page"`) instead of the app shell with a 200, so the app no longer has a not-found view of its own.

## Asset set

- **Day:** NASA Blue Marble Next Generation with topography and bathymetry, 3600×1800.
- **Night:** NASA Black Marble 2016 at full resolution (43200 px), as one channel of city-light level: global maps (3600 and 2048 px) and 5° tiles for journeys' close views ([sharp city lights](#sharp-city-lights-near-airports), [gradation](#city-lights-with-their-gradation)).
- **Water:** Natural Earth 1:10m land, islands, ice shelves, and lakes, rasterized to a mask the size of each day texture (4096×2048, 83 KiB; 8192×4096, 205 KiB) for ocean glint and sky reflection.
- **Relief:** NOAA ETOPO 2022 elevation (public domain), stored as the ground's normal at 12× relief ([terrain relief](#terrain-relief-lit-by-the-sun-and-moon)).
- Both are public domain and resampled into **low** (2048×1024, 415 KiB total) and **standard** (3600×1800, 1.3 MiB total) sets.
- **Font:** Barlow Condensed SemiBold (OFL), unmodified, for the split-flap airport codes ([labels](#airport-labels-and-route-lines-the-offline-renderers)).
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
- `assets.run_worker_first` in `wrangler.toml` limits Worker invocations to the API, docs, schema, the two dynamic page routes, and the homepage (since November 13, 2026, so the globe can start over the visitor). Every other static file, including textures, is served without running the Worker.
- `_headers` still applies the security headers to static files.

The site launched on Cloudflare Pages with one Pages Function. It moved because Pages can't define Durable Objects: keeping Pages would have meant a second Worker just for live updates. The public API didn't change. The old `routereplay-web.pages.dev` project now only redirects every path with a 308 to the Worker, so earlier watch links, preview links, and saved docs URLs keep working.

## A journey from plain text: the homepage chat (`/api/v1/compose`)

*Proposed, built and deployed November 13, 2026; reshaped the same day after a real trip ([below](#reshaped-after-a-real-trip)).* PLAN.md has Route Replay pay for no model inference: the visitor's own agent researches the trip and posts a spec. That leaves out people whose chat app can only fetch URLs, and people with no agent. Get started on the homepage now opens a chat where they describe the trip instead (`src/app/components/ChatPanel.tsx`, `src/server/compose/`, eval in `scripts/compose-eval/`). Since the same day the chat sits beside the scene and edits the draft it makes ([below](#one-workspace-the-chat-beside-the-scene)).

**How it works.** The model's job stays small and everything checkable stays in the Worker:

1. **Extract:** a Workers AI model copies the text into a small JSON "intent", with schema-constrained output (`src/server/compose/intent.ts`). Each leg has its mode, places as written with the model's IATA code beside them, local dates and times as written, flight number, and aircraft as written. It never computes offsets or arrival dates.
2. **Resolve, without the model** (`resolve.ts`):
   - Airports come from the airport table. A code the person wrote wins. Cities with several airports (a short table: London, New York, Tokyo, Paris and others) get a question for flights. For train, bus, car and ferry legs they stand in at the city-centre airport.
   - When the model's code doesn't match the written name, a search of the table by name decides.
   - UTC offsets come from each airport's zone.
   - A flight's arrival date is the only date that gives a positive flight time under 24 hours. That gets date-line crossings right; models got them wrong.
   - The aircraft as written maps to a supported designator. A family name ("A350", "787") takes its most commonly flown member.
   - A year the text never mentions is discarded and asked about. So is an aircraft, but it isn't asked about: a typical one takes its place (see below).
3. **Validate** with `validateScene`. Missing times, dates and years, and unnamed airports in multi-airport cities, become questions, one line per leg. Nothing is saved.

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
- It owns extraction quality instead of the visitor's agent. An agent that can post specs still does better research: it can look up schedules and aircraft types. Compose can't, so it hands that research to the visitor's own AI (below).

**As built:**
- **The conversation is the client's.** The endpoint keeps nothing between messages; the page sends the whole conversation each time, `{"messages": [{"role": "user" | "assistant", "content": "…"}]}`, ending with the person's message, at most 4,000 characters in all. One message goes to the model as written (as evaluated); a longer conversation goes as a transcript ("Traveller: …", "Route Replay: …"), so "Heathrow" answers "Which airport in London?". The resolver's guards (a year, airport code or aircraft must appear in the text) read only the person's own messages. The model is fixed (`MODEL` in `models.ts`); a request can't choose it. The endpoint on the full eval set after these changes: 38/39, no invented values.
- **Responses.** `{status: "ready" | "needs_info", questions, legs, spec, assumed, airports, issues, warnings, limits}`. `questions` has one entry per leg that still needs something, plus any about the whole trip (the year): `{leg, about: "AA 100, JFK → LHR, Sat 12 Jun 2027", needs: ["local departure and arrival times"], choices?, question, fields: ["0.departure", "0.arrival"], lookup}`. `choices` lists the options for a need answered by picking one (`{need: 0, options: ["Heathrow (LHR)", "Gatwick (LGW)", …]}` for "which London airport", or last year, this year and next for the year); `question`, which the conversation sends back, still spells them out. `lookup` says whether an AI with web search could find part of the answer. `legs` is a plain summary for the person ("Melbourne (MEL) → San Francisco (SFO)", "Fri 5 Mar 2027, 10:15 → 06:05", "Boeing 787-9", `typical` when assumed), present when ready, with `spec` complete. `assumed` lists the values the text didn't give (`"0.aircraft"`). A spec that fails validation with no open question comes back as `needs_info`, the issue's message as its leg's question. `GET /api/v1/compose` returns `limits` without using a message.
- **Limits.** The existing D1 counters (`countLimits` and `peekLimits` in `guards.ts`): 20 messages per client an hour and 800 a day for everyone (`COMPOSE_LIMIT_PER_HOUR`, `COMPOSE_LIMIT_PER_DAY`), which keeps a typical day inside the free neurons. Every response, errors included (as `error.limits`), says `{remaining, perHour, resetsAt, reached?}`; the page shows it in a usage chip beside the message box. A request rejected before it reaches the model (malformed, too long) doesn't use a message; a model failure does. Once `remaining` is 0, or on `429 rate_limited` (`reached: "client"` or `"everyone"`), the chat suggests copying the agent prompt, with the button, and disables the message box until `resetsAt`. AI Gateway adds nothing needed: its rate limits are per gateway, not per client; caching doesn't help unique texts; and its logging would store itineraries. Add Turnstile only if abuse appears.
- **Publish rights, through the existing credentials.** When the journey is complete, the page creates the draft with `POST /api/v1/scenes` (with an `Idempotency-Key`), exactly as an agent would, then moves to `/s/{id}#k=<owner credential>` without reloading. The draft page's handshake already accepts either credential after `#`: it removes it from the address bar, exchanges it at `POST /api/v1/scenes/{id}/session` for an `HttpOnly` cookie session with that credential's role, and an owner session shows Publish, Share and Export, and may edit (`PUT`). Nothing new was added to the credential scheme.
  - **The session is the person's only key.** It lasts 7 days in that browser. After that, or on another device, they can watch only what they published; they can't publish again, delete, or hand the draft to an agent, because the service keeps only hashes and the owner credential was shown only to the page. So the chat offers the private link while the page still holds the credential from the fragment: whenever the draft arrives with an owner credential (only a chat-made draft hands one to a person), the trip's menu (the title at the top of the chat, with ⋮ after it) has Copy private link, and copying it says in the chat that anyone with the link can edit, publish or delete the draft. Reloading the page, which no longer has the fragment, removes it, and the link is never stored.
- **Secrets:** none. Workers AI is a binding (`[ai]` in `wrangler.toml`).
- **Privacy wording,** in full in the chat's questions and answers (`src/app/faq.ts`): "To read it, Route Replay sends the text to Cloudflare Workers AI, on the same network that hosts this site. Neither Cloudflare nor Route Replay keeps the text or uses it to train models." The chat's first message says it in one line, and "More about privacy" opens that answer. This rests on Cloudflare's Workers AI data-usage page (no retention after the request, no training) and on the Worker never logging request bodies. The conversation lives only in the browser; a draft keeps airports, times, aircraft and a title made from the place names. The questions and answers also say who can see a draft, how long it's kept (its numbers come from `src/shared/retention.ts`, which the server enforces), and where routes and clouds come from.
- **Questions and answers without the model.** They were a plain-text page at `/faq`; now the ? button in the chat's title bar slides them over the chat as a second drawer, an accordion of 13 questions in three sections. They're answered in the page: no request, no message used, nothing sent to the model, and nothing added to the conversation, so they work after the limit is reached. A question typed into the message box still goes to the model like any message; matching typed text against the questions was rejected, because short change requests in a draft ("make it a wide-body") look like questions. The privacy text is now only in the app, so it needs JavaScript and has no link of its own; that was judged acceptable. `/faq` gets the 404 page.
- **The chat panel.** Focus goes to the message box when it opens (to the heading on touch screens, so the keyboard doesn't cover the introduction), closing it returns focus to Get started, and the thread is an `aria-live` log. Enter sends, Shift+Enter starts a new line. On a phone, `visualViewport` keeps the drawer above the on-screen keyboard. Trackpad scrolling over the chat scrolls it; over the stage it still turns the globe.

### Reshaped after a real trip

The owner's first real try was a ten-leg trip written the way people jot one down: flight numbers and dates, then trains, a ferry and buses by place name, with no times or aircraft. The chat answered with 30 questions, three per leg. Most were research (schedules, timetables, aircraft types) that the visitor's own AI could do and the chat can't. The test set had hidden this: it was mostly booking confirmations with their times. One answer was also wrong: the ferry's destination, a region with no airport of its name, became an airport in another country about 4,700 km away, and the next train would have started there.

Changes, the same day:
- **One question per leg,** such as "AA 100, JFK → LHR, Sat 12 Jun 2027: local departure and arrival times". A place asked about once isn't asked again on the next leg. That trip now gets 10 lines (about 800 characters, which the conversation sends back) instead of 30.
- **The aircraft is never a question.** It only changes the model drawn. When the text doesn't name one, or names one Route Replay doesn't draw, the flight gets an Airbus A320neo up to 4,000 km and a Boeing 787-9 beyond, shown as "typical" with a note that naming the type changes it.
- **Research goes to the visitor's AI.** When any question can be looked up, the chat offers "Copy request for your AI". The request carries the trip as written, the open questions, what to look up, a reminder to ask the traveller for dates and to say so rather than guess, and a one-line-per-leg answer format to paste back into the chat. Chat apps that can only read pages can do this, so it reaches the visitors who can't use the agent prompt. Pasting a plausible answer for the same trip came back ready to create, with every aircraft named and every place found.
- **Places on the ground.** The resolver, not the model, had picked the wrong airport: no airport has the region's name, so it fell back to airports with the name's first word ("South") and took the one nearest the leg's other end. Now:
  - A weak word ("south", "new", "san", "port" and the like) never names a place on its own.
  - A train, bus, car or ferry leg longer than its mode allows (train 7,500 km, bus and car 5,000, ferry 2,500, great-circle) has a misplaced end. The less certain end is replaced by the model's own airport if that fits, or else asked about, along with the same place on the neighbouring leg.
  - The airport search ignores accents, so "Cancun" and "Cancún" both find CUN. Folding the table costs about 2 ms once per isolate, the same as the lower-casing it already did.
  - The prompt is unchanged. Asking the model for a best guess at the nearest airport for every station, port or town made gemma leave more of them blank (13 of 28 on the eval's ground legs, against 5 of 30), so the change was dropped. A place the model leaves blank and the table can't find, like one small town in that trip, is a question the visitor's AI can answer.

- **Measured after the changes** (same setup as above, with one new notes-style case added to the tuning set: flight numbers and dates, trains and a ferry by place name, no times or aircraft): 40/40 cases, no invented values, 67/68 legs right, median 3.8 s and p90 6.9 s, 9.4 neurons a request. The resolver takes 0.25 ms a request warm.

**Unproven:**
- Real itineraries. The test set is synthetic and English, and the resolver was tuned on most of it.
- Production latency and CPU.
- The question-and-answer loop as people use it, and the drawer with a real phone keyboard (checked by setting the values `visualViewport` reports, not on a device).
- Editing a draft an agent made, by chat, beyond a change of times: the conversation starts from the draft's legs as summary lines, which the model reads as well as any itinerary in the tests, but no eval case covers it.
- Claude's accuracy.
- How long gemma-4 stays on Workers AI: several models there retire on November 20, 2026. Rerun the eval before switching models.

### One workspace: the chat beside the scene

*Built November 13, 2026, after the reshape.* The chat was a drawer over the homepage that ended in a Create draft button, and a draft opened as a separate page. Now `/` and `/s/{id}` are one workspace (`src/app/Studio.tsx`), and the chat stays beside the scene from the first message to the finished draft:

- **Layout.** At 900 px wide and up, the chat is a left rail (340–420 px) and the scene takes the rest of the window. Narrower, it's a drawer from the bottom, collapsible to its title bar, and the scene takes the space above the bar, reaching 20 px under it so it shows in the bar's rounded corners. Expanded, the drawer fills the screen (it took 56% of the height, at least 380 px, until November 13), and expanding scrolls the conversation to its newest message.
  - **The scene floats over the chat** in a small window, like a video's picture-in-picture (`src/app/pip.ts`). It shrinks into the window as the drawer opens and grows back as it closes. It can be dragged anywhere between the title bar and the message box, and settles against the nearer side; a fling carries it. A tap, or Enter on the window, collapses the drawer so the scene has the screen again. It starts just above the message box on the right, where a short conversation leaves the most room, and stays there as the message box grows or the keyboard opens.
  - **Scaled, not resized.** The stage keeps the size it has with the drawer collapsed, and a CSS transform shrinks it to at most 260 px on its longer side (at most 34 % of the stage). The canvas, the player's composition, and the labels' layout never change, so a draft made while the window shows is laid out for the full screen, and moving between the two is only compositing. For this, the player and the homepage globe measure their layout size, not their size on screen. A chat that is still writing a trip shows the draft appearing in the window.
  - The stage is `inert` while it is a window; the window's touch target, a button over it, takes the input. As a window it is drawn over the drawer, and it goes back under the collapsed bar only once it has grown out again, so both moves play over the chat. A draft opens with the rail shown, or the drawer collapsed, so the journey has the screen. The rail can be hidden; a button over the scene shows it again.
- **The homepage.** One Get started button, the one the globe lights as an object in its sunlight (the agent prompt moved into the chat's first message). It opens the rail; the hero fades, and the camera moves from the hero framing (Earth rising from the bottom) to the whole globe centred in the space left, filling 80% of its shorter side. The globe still turns under a drag and a trackpad swipe. R3F's canvas normally waits until resizing stops before it resizes, which left the globe off-centre while the rail slid open; the homepage canvas now resizes every frame (16.7 ms frames during the slide in headless Chrome).
- **The page becomes the draft.** When a reply is complete, the chat creates the draft and moves the page to `/s/{id}` (with `history.pushState`, so Back returns to the homepage). The draft's player fades in over the globe, which is then let go; its code (the Remotion chunk) is fetched as soon as the chat opens.
- **Edits.** Every later message updates the same draft with `PUT` and its revision. Rather than the whole conversation, the request starts with the draft's legs as summary lines, sent as the traveller's own words (they are the traveller's saved trip, and the resolver's guards accept only years, codes and aircraft the traveller wrote), then what was said since. That keeps long conversations inside the 4,000 characters and includes changes an agent made meanwhile; it also works on drafts an agent made. The new legs replace the old; the draft's title, look and weather stay, and so does timing tied to leg ids that are still there.
  - **Conflicts** (changed November 13, 2026; before, a conflict was reapplied once to the newer draft). The save names the revision whose legs started the request, not the one on screen when the reply comes back. If anyone saved in between, the reply came from the older trip, so saving it would quietly undo their change. The chat leaves it: the reply says so, the thread shows the trip as it is now, and an "Apply my change again" suggestion sends the same request again (it uses a message) starting from that trip. Agent docs tell agents the same: reapply, never overwrite.
- **Changes from elsewhere** (November 13, 2026). A revision the chat didn't make (an agent, another window, the page's browser tools) arrives over the draft's live socket and shows in the thread: "Your trip was changed outside this chat", with the legs as they are now. The chat's own saves record their revision before the page shows it, so they never appear as outside changes. Readings and these entries keep their revision in the stored conversation, so a draft opened again says if it changed while it was closed. They don't restart the conversation sent with the next message, which starts from the trip as it is now anyway: questions about a change still in progress keep their context.
- **An agent at work** (November 13, 2026). An agent's "working" activity shows in the chat as shadcn's Item with a Spinner above the message box ("Your agent is working" and the agent's message), while the chat is on screen: on desktop with the rail shown, on phones with the drawer expanded, where the floating scene is too small to read. Otherwise the scene shows it as before. When an agent shows the creator a moment, a phone's drawer collapses so the scene has the screen.
- **Why the chat doesn't send messages over the socket.** Each message is one request and one structured reply, with nothing to stream; HTTP gives each its rate limit and error, and works before a draft (and its Durable Object) exists. The socket only brings the chat what happens elsewhere.
- **Memory.** A draft's conversation is kept in this browser's `localStorage` (never the private link), so it's there when the draft is opened again. A new trip starts a fresh chat on the homepage.
- **Publish and Export in the chat.** On a draft, the suggestion row above the message box offers Publish and Export video, in place of the buttons over the scene, but only when the draft on screen is settled: not while a message is being read or saved, while questions about a change are open, while a change is being typed, while an agent is working on the draft, or after a change that didn't save, since publishing or exporting then would capture a version about to change. Publish reads "Publish changes" once an earlier version has a watch link, and becomes Share link once the version on screen is published (except straight after the reply that shows the link). Export video steps aside right after an export, whose card has its own "Export another". Each is answered in the chat: Publish with the watch link as shadcn's Item, the trip's name over its address (the two lines open it; Copy and Share sit beside them as icon buttons). Export first asks the shape and quality, in a two-step questionnaire in place of the message box (the screen's shape and 720p picked to start); the choice then shows as the person's message. While the browser check and the export run, their progress and Cancel take the message box's place too; the reply then shows the video as an Item, the trip's name over its size and frame ("3.5 MB · 1280 × 720"), the whole row downloading the file under its descriptive name, then Export another. The watch page keeps its Share button and Export drawer.
- **Questions to answer in place.** The latest questions are shadcn's Questionnaire (on `@shadcn/react`), the counterpart of an agent's ask-the-user tool, and like that tool it takes the message box's place while it waits; the thread keeps a short list of what's needed. One step at a time, with progress ("Question 2 of 5"), letter shortcuts, and Skip, Previous and Next. A leg's options to pick (`choices`: the airport, the year) are one step each, with a box for something else; what has to be typed (dates, times, places) is another. Skipping the last step sends what's answered. The answers become one message, a line per leg, as the person might have typed it ("Flight, London → New York, Mon 3 May 2027: Heathrow (LHR); 08:20 → 11:05"). A minimize button in its corner brings the message box back, and so does Copy request for your AI, in the thread after the list of what's needed (to paste the AI's answer into); an "Answer the questions" suggestion reopens the questionnaire. The export questionnaire minimizes the same way.
- **What happened to a message.** While a message is read, and after, the reply starts with AI Elements' Task (shadcn's Trace): "Reading your itinerary" with "Sending to Cloudflare Workers AI" and the conversation's length, then, once done, a single line that opens to what the reply found and what was saved: the legs by how they were travelled, the airports they were placed at, the questions still open, and "Made the draft" or "Updated the draft". Plan was the other candidate; it suits steps known before the work starts, and here they come from the reply.
- **The trip's menu.** On a draft, the title is a button with ⋮ after it (since November 13, 2026; before, ⋮ was a separate button, set apart from the title). Its menu has New trip, Copy private link (while the page holds it), Share public link (once a version is published) and, for the owner, Delete trip, which asks first in an alert dialog: deleting removes the draft and its watch links for everyone, and the page returns to the homepage without the draft in its history.
- **The title bar's actions** (November 13, 2026). The same on the homepage as on a draft. On desktop: the title's menu button on the left, its words in line with the conversation, then Questions and answers and Hide chat. On phones the bar is three columns with equal sides, so the title stays centred: Collapse on the left, the title's menu button in the middle (its menu centred under it), Questions and answers on the right (an empty cell when collapsed). The homepage drawer's separate Close went; collapsing does its job. Before a draft exists, Start over is a suggestion rather than a button in the bar, offered once the person has said something, not while it's being read or saved, and not at the hour's limit, where it would only clear the limit's note and its prompt for their own agent. It keeps whatever is in the message box, which is often the new trip. A draft has New trip in its menu instead.
- **Usage.** A usage chip in the message box's footer (AI Elements' Context: a hover card with a progress bar) says how much of this hour's messages the browser has left ("80% remaining"); the meter runs down as messages are sent. Hovering shows the count and when more come. It replaced the "17 messages remaining" line under each message. A conversation over 4,000 characters still gets its own warning beside it.
- **Links in the chat** take the colour of the text around them, as the stock components expect: the site's older global rule colours links in its accent, which turned these cards' text electric blue (November 13, 2026).
- **Components.** Tailwind CSS 4 and shadcn/ui in its stock form: the base-nova style on Base UI primitives, the neutral dark theme and Geist, with `cn` from shadcn's package. The chat's conversation, messages, message box, suggestions and usage chip are AI Elements, copied and trimmed: no Markdown renderer, no motion library (the shimmer is a CSS animation) and no `ai` package. Questions use shadcn's Questionnaire. The site's own stylesheet sits in Tailwind's components layer, so utilities still win on the shadcn components. `shadcn/tailwind.css` is copied in rather than installing the `shadcn` package, whose CLI dependencies carry audit advisories.
- **Cost.** The homepage's JavaScript grew from 360 to 432 KB gzipped (396 KB before the questionnaire and the usage chip's hover card, which brings Base UI's positioning code), its CSS from 4 to 12 KB, and the chat's text loads Geist (29 KB, Latin). The landing page still doesn't load Remotion until the chat opens.


## Browser tools that share the page (WebMCP)

November 13, 2026. An audit in Chrome's native WebMCP found the draft preview's four tools worked, but knew nothing of the page they shared: the chat, the person using it, and the live socket. `set_scene` dropped the save's warnings, `get_scene` left out the leg weights the pacing recipe needs, `publish_scene` made a new link on every call, `seek_scene` (the documented way to inspect a moment) moved the creator's view, and the homepage and watch pages offered nothing.

- **Every page offers tools.** The homepage: `lookup_airport` and `create_scene`, after which the page becomes the draft's, with a fresh chat, as for a draft the chat makes; the credentials stay in the page, and the person can copy the private link from the chat. A draft: `get_scene`, `set_scene`, `get_revisions`, `get_storyboard`, `control_playback`, `export_video`, and `publish_scene` for the owner. A watch page: `get_scene`, `get_storyboard`, `control_playback` and `export_video`, whose results are marked as someone else's words (the title is the maker's). A tool with the same name does the same thing on both pages.
- **One meeting point.** The draft hook (`src/app/draft.ts`) is where the chat, the socket and the tools meet. The chat registers a bridge there: its state, and its Publish and Export. The tools read it, and their activity joins an HTTP agent's.
- **The tools wait for the chat.** `set_scene`, `publish_scene` and `export_video` return `creator_editing` while the chat is reading a message or saving its change. A save in that window would turn the person's request into a conflict, and "Apply my change again" costs them a message. Typing and open questions are reported in `get_scene`, not blocked: the chat starts from the trip as it is when the message is sent.
- **The chat knows the agent.** Each call shows "Your agent is working" (with "Changing your trip" or "Publishing your trip" while those run, lapsing 15 s after the last call), which holds back the chat's Publish and Export as an HTTP agent's activity does. A tool's save shows as "Your agent changed your trip" rather than "outside this chat". An agent's publish or export is answered in the thread as the person's would be, after a line saying the agent asked, and the rail opens if hidden, since the link and the file are there.
- **Looking and showing are separate.** `get_storyboard` describes moments without touching the view, computed in the page from the shared storyboard code. `control_playback` seeks, plays or pauses, only when the person asks, and through the same `showMoment` an HTTP seek uses, so a phone's drawer collapses for both.
- **One link per revision.** Publishing a revision that already has a watch link returns it (`200`, `existing: true`) and doesn't wake open previews. A revision is immutable, so a second link would show the same thing, and an agent and the chat can both be asked to publish.
- **A refetch of the same revision keeps the scene.** The draft ignores a late response for an earlier revision, and keeps the object it is drawing when a refetch brings the same revision with the same links, taking only the newer ETag. Before, a tool's save came back through the socket's refetch as an equal but new object, and the player could wait out its 15 s for the replaced one to render, reporting `assetsReady: false`.
- **Answers an agent can act on.** `set_scene` returns the save's warnings and next steps in tool terms, and a conflict carries the current spec. `get_scene` gives each leg's weight, screen seconds, and aircraft or mode, and the airports' names and zones.
- **Exports.** The export runner and its phases moved from the chat's components to `exportOptions.ts` (`useExportJob`), shared by the watch page's drawer, which a tool can open with a choice made, and the chat, which runs a draft's exports.
- **Cost.** The tools' code loads only where `document.modelContext` exists (`offerTools`): 7.8 KB gzipped on a draft or watch page, 1.4 KB on the homepage. Elsewhere draft pages are 1.9 KB lighter than before (the old tools always loaded), watch pages 0.1 KB heavier, and the homepage 0.8 KB. No Worker requests were added: storyboards and warnings for the tools are computed in the page, and publishing reads one indexed row first.
