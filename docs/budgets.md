# Measured budgets

Measured on November 11, 2026:

- **Laptop:** the production build in desktop Chrome on an Apple M1 Max laptop.
- **Real phone:** an iPhone on iOS 27.3 (WebKit) against production. See [verification.md](verification.md#representative-phone-real-device) for the full table.
- **Emulated phone:** Chrome DevTools emulation (390×844 at 3×, 4–6× CPU throttling, Fast 4G), kept for comparison.

## Startup transfer

Gzip sizes from `dist/` (Cloudflare serves Brotli where supported, which is smaller):

| Page | JavaScript + CSS | Font | Textures | First-view total |
| --- | --- | --- | --- | --- |
| Landing | 318 KiB (`index` 316 + CSS 2) | — | 0.96–1.09 MiB low (this month's 4096 day texture, night, water mask, relief), then 3.6–4.0 MiB more for standard on capable devices | ~1.3–1.4 MiB (low) |
| Watch or preview | 318 + 133 (`JourneyStage`: Remotion and the player) + 1–5 (page) | 51 KiB (Barlow Condensed) | 0.96–1.09 MiB low / 3.6–4.0 MiB standard | ~1.5–1.7 MiB low / ~4.2–4.6 MiB standard |
| Export (on demand) | +117 KiB (`@remotion/web-renderer` + mediabunny core) | — | standard set | Loaded only when Export is pressed |

Real iPhone, cold load over Wi-Fi: **919 KiB**, first journey frame at **981 ms**. Emulated phone (Fast 4G, 4× CPU): a cold load transferred **916 KiB**: JS 317 + 120 + 2, font 59, low textures 415, snapshot and HTML 2. The globe appeared **2.6 s** after navigation.

**Textures** (November 12, 2026, from `public/assets/2026-11-12/manifest.json`; the device measurements above predate them and used a 415 KiB low and 1.3 MiB standard set). Each page downloads one month of the Blue Marble day texture: the journey's first departure month, or the current month on the homepage.

| Set | Day texture (by month) | Night | Water mask | Relief | Total |
| --- | --- | --- | --- | --- | --- |
| Low | 4096×2048 WebP, 408–541 KiB | 2048×1024 lossless WebP, 100 KiB | 4096×2048 WebP, 83 KiB | 2160×1080 lossless WebP, 393 KiB | 0.96–1.09 MiB |
| Standard | 8192×4096 WebP, 1,369–1,786 KiB | 3600×1800 lossless WebP, 244 KiB | 8192×4096 WebP, 205 KiB | 4320×2160 lossless WebP, 1,871 KiB | 3.6–4.0 MiB |

Standard falls back to the 4096 day texture and water mask on devices whose largest WebGL texture is under 8192. December and January are the largest files and July and August the smallest, probably because northern snow cover adds detail. The whole directory, all 12 months at both widths, is 25 MiB on the server.

The landing page does not download Remotion: the player pages are code-split. Muted export does not load the audio encoder chunks (aac, mp3, flac; 470 KiB gzip).

**Night detail** (November 12, 2026; tiles rebuilt November 13 with the new light level, about 15–25 % larger): journeys also download full-resolution city-light tiles around their airports ([assets.md](assets.md#static-assets-publicassets2026-11-12)), in the order the camera reaches them. Playback starts once the first frame's tiles are in (34–45 in the journeys below); the rest arrive while it plays. Export waits for all of them. The homepage downloads none. From each journey's plan and the tile files:

| Journey | Tiles | Standard | Low | Before the first frame: tiles, standard / low |
| --- | --- | --- | --- | --- |
| JFK → BOS | 43 | 1,021 KiB | 346 KiB | 34, 952 / 322 KiB |
| LHR → AMS | 60 | 1,452 KiB | 518 KiB | 43, 1,232 / 436 KiB |
| HND → ITM | 43 | 591 KiB | 197 KiB | 34, 354 / 118 KiB |
| DEL → BOM | 53 | 1,424 KiB | 490 KiB | 38, 1,308 / 449 KiB |
| DEL → HND | 99 | 2,071 KiB | 709 KiB | 38, 1,308 / 449 KiB |
| ORD → SFO → AKL (the example) | 110 | 1,549 KiB | 542 KiB | 45, 1,282 / 442 KiB |

In Chrome against the local dev server on November 13, JFK → BOS, LHR → AMS, and DEL → BOM downloaded exactly these bytes at standard. Planning takes 1–2 ms.

An airport takes about 40–60 tiles: 0.35–1.4 MiB at standard (Tokyo's is light, Europe, India, and the US north-east heavy), and about 35 % of that at low. Nearby airports share tiles. A journey loads at most 128 tiles, in the order first needed, so a long trip keeps its first airports sharp and draws later ones from the global map.

In Chrome's phone emulation (390×844, low quality, Fast 4G), JFK → BOS showed its first frame after 3.23 s instead of 2.86 s (median of three cold loads each), for the 311 KiB of tiles it needed first (322 KiB since the November 13 rebuild).

**Clouds** add about 430 KB per model step (400–470 KB: cloud water, the 700 hPa wind, and since November 13, 2026 the high layer's ice at three levels and the 250 hPa wind, as GRIB2), cached for a year in the browser and at the edge. That is about 0.9–1.4 MB when the homepage opens, then about 18 KB/s while it stays on screen, about 2 MB for a short journey, and at most about 10.5 MB (24 steps). Before the high layer a step was about 240 KB (190–245 KB): 0.5–0.7 MB on opening the homepage, 10 KB/s after, and 5.8 MB at most. The high layer adds 210–225 KB per step ([decisions.md](decisions.md#a-high-cloud-layer)). These figures were not part of the earlier device measurements below.

**Relief** (November 12, 2026) is heavy: on standard its 1,871 KiB is more than the day texture and roughly doubles the set, and on low its 393 KiB adds 55–68 %. It was not part of the device measurements above; [assets.md](assets.md) explains the size.

## Frame time

| Scenario | Quality | Median frame | p95 frame |
| --- | --- | --- | --- |
| Landing idle globe, desktop | standard, DPR 2 | 16.6 ms | 18.4 ms |
| Watch page playback (1:1, follow camera), desktop | standard, DPR 2 | 16.7 ms | 18.3 ms |
| Watch page playback, emulated phone | low (chosen automatically), DPR 1 | 16.7 ms | 18.5 ms |
| **Watch page playback, real iPhone (iOS 27.3)** | low (chosen automatically) | 17 ms | 17 ms; 29.8 of 30 composition frames rendered per second |

These were measured before the November 12 lighting work (tone mapping, moonlight, city lights, cloud lighting), which adds per-pixel work: a few Chapman-function evaluations for sunlight through the air, a cloud shadow per light, two hashed noise fields only where the night map has lights, and the sky's reflection on water by day (about 150 arithmetic operations, two dozen of them exponentials or square roots, and no texture reads; see [decisions.md](decisions.md#water-that-reflects-the-sky)). Re-measure on the iPhone before relying on these numbers. Metering a journey's exposure costs about 80 ms of main-thread time for 2 minutes of frames, once, when it first plays.

Airport labels add little per frame: each split-flap panel is a canvas texture redrawn and uploaded only while its cards turn (0.74 s after it appears), about 0.1–0.4 ms a frame at 720p–1080p and 1 ms at a 2,160-pixel short side in headless Chrome on an M1 Max. Laying the labels out costs 1–4 ms once per journey and frame shape (18–120 s journeys, warm, Node); a resized window lays them out again.

**Cloud-top relief and the aircraft's shadow** (November 13, 2026; [decisions.md](decisions.md#cloud-tops-lit-as-shapes)) didn't measurably change GPU time. These figures come from the GPU's own timer (`EXT_disjoint_timer_query_webgl2`), per rendered frame, in headless Chrome on an M1 Max. Each is the median of two 7-second plays of three test journeys with real clouds, before and after, on the same build of everything else:

| Journey (frames 2–9 s) | 1280×720 at DPR 2: before | after | 390×844 at DPR 3: before | after |
| --- | --- | --- | --- | --- |
| London–Frankfurt, low Sun over broken cloud | 8.5–9.1 ms | 8.5–9.9 ms | 4.0–4.3 ms | 4.0 ms |
| Singapore–Hong Kong, midday over cloud | 6.5–6.7 ms | 6.2 ms | 2.4–2.5 ms | 2.4–2.5 ms |
| Dubai–Cairo, clear desert | 7.9–8.3 ms | 6.6–7.6 ms | 2.7–3.6 ms | 3.2–3.3 ms |

Run-to-run spread is about ±10 %. The cloud shader dropped an extra cubic read of the cloud field per light (10 texture reads, 20 under moonlight) and gained about 30 arithmetic operations. The shadow adds a few uniform tests per ground, cloud, and air pixel, plus one texture read near the aircraft.

**One linear composite** (November 13, 2026; [decisions.md](decisions.md#one-linear-composite-tone-mapped-once)) costs about 3 ms a frame at 2560×1440 and 0.2–0.3 ms at a phone's 390×844 on this laptop's GPU (a third run of the shipped build alone gave +2.2 and +0.27 ms). Measured with the GPU's timer in headless Chrome on the M1 Max, over the same 36 frames (2–9 s, every 0.2 s) of the three test journeys, seeked one by one on a paused watch page. Playback wasn't used, because the slower variants made the player step down to low quality. Each figure is the mean over the three journeys of the median frame, from two passes run in turn. Another agent's browser shared the GPU during these runs, so absolute times are higher than in the table above and vary by about ±10 %; compare within the table.

| Variant | 1280×720 at DPR 2 (2560×1440) | 390×844 at DPR 3, low quality (390×844) |
| --- | --- | --- |
| Before: each layer tone mapped | 11.2 ms | 1.38 ms |
| Fallback in the new build (`?display-referred`) | 10.6 ms | 1.31 ms |
| Linear, air as one grey draw | 13.3 ms | 1.53 ms |
| **Linear, air's transmittance per colour (shipped)** | **14.2 ms** | **1.59 ms** |
| Linear, air split at the cloud deck (four draws) | 16.4 ms | 1.99 ms |
| The same without multisampling the half-float target | 13.4 ms | — |

- **Where the time goes:**
  - The half-float target, its resolve, and the tone-map pass: about 2.7 ms at 2560×1440 (one grey draw against the fallback). Dropping the target's multisampling saves about 3 ms (the last two rows), so nearly all of that cost is the 4× multisampled half-float target.
  - The transmittance draw: 0.9 ms.
  - Restoring the depth: too little to measure.
- **iPhone:** not measured. The real-device budget above (17 ms frames, 29.8 of 30 composition frames) predates this. At the phone's resolution the change adds about 15 % of GPU time on this laptop. Check it with `?measure` on a device before relying on it.

**The aircraft in the scene's own light** (November 13, 2026; [decisions.md](decisions.md#the-aircraft-in-the-scenes-own-light)) adds one shadow pass of the airframe per aircraft and a heavier paint shader. Measured as above, but with the builds before and after served side by side and alternated in one browser session, so both see the same load. Each figure is the median over rounds of the median frame of 6 seconds of playback. The machine was shared with other renders, and the same build varied by up to ±1.5 ms between rounds.

| Journey | 1280×720 at DPR 1: before | after | 1280×720 at DPR 2: before | after | 390×844 phone: before | after |
| --- | --- | --- | --- | --- | --- | --- |
| London–Frankfurt, through sunset | 7.0 ms | 7.1 ms | 9.3 ms | 10.1 ms | 1.5 ms | 1.8 ms |
| Singapore–Hong Kong, midday over cloud | 6.0 ms | 5.7 ms | 10.7 ms | 9.9 ms | 1.3 ms | 1.4 ms |
| New York–London, full Moon | 6.5 ms | 6.5 ms | | | | |
| London–Frankfurt–Munich, the stop where an A320 dissolves into a 787 | 6.6 ms | 6.6 ms | 10.8 ms | 11.9 ms | 1.4 ms | 1.6 ms |
| Auckland–Wellington, then the ferry to Picton at dusk | 6.3 ms | 5.5 ms | | | | |

The one consistent difference is at DPR 2 at a stop where one type dissolves into the next: about +1 ms, in two sessions. There, two airframes draw large at the airport's zoom, each with its own shadow pass. Freezing the shadow maps in the page to isolate their passes moved GPU time by less than this machine's run-to-run spread, so the cost isn't pinned down. The phone viewport is the player's own choice of quality at 390×844, DPR 3. On the CPU the light costs about 4 µs a frame, and reading the day map's colour back from the GPU about 10 ms once per texture. Re-measure on the iPhone.

**Sky light, cellular billows, and the high cloud layer** (November 13, 2026; [decisions.md](decisions.md#sky-light-on-clouds)). GPU time per rendered frame from the GPU's own timer, measured as above but timing everything a frame's `requestAnimationFrame` callbacks submit, on a shared M1 Max under heavy load from other work (load average 6–65). So compare within this table, not with the one above. Each range covers four 7-second plays (frames 2–9 s): two in each of two rounds, with the four builds run in turn and then in reverse.

| Journey (frames 2–9 s), 1280×720 at DPR 2 | Before | + sky light | + cellular billows | + high layer |
| --- | --- | --- | --- | --- |
| London–Frankfurt, low Sun over broken cloud | 10.1–12.6 ms | 12.4–13.6 ms¹ | 12.1–12.7 ms | 12.3–14.4 ms |
| Singapore–Hong Kong, midday over cloud | 12.1–12.9 ms | 10.4–14.2 ms | 13.4–13.8 ms | 12.5–13.7 ms |
| London–Johannesburg, whole globe mid-flight | 9.9–12.3 ms | 10.8–11.1 ms | 13.2–14.3 ms | 12.6–16.1 ms |

¹ Two of the four plays (3.4 and 4.8 ms) are left out: that load drew no clouds.

The 95th percentiles went from 15–35 ms before to 22–32 ms with all three. Sky light didn't measurably change GPU time. The billows cost about 1–2 ms in the whole-globe view, where the 1 MiB texture is read at many scales at once. The high layer adds 0–2 ms to the median, one more blended shell over the globe. In Chrome's phone emulation (390×844 at DPR 3) the medians went from 1.3–2.4 ms to 1.7–2.5 ms and the 95th percentiles from 2.6–7.8 ms to 2.9–9.4 ms. Re-measure on the iPhone before relying on these numbers.

**Carving without the grid** (November 14, 2026; [decisions.md](decisions.md#cellular-billows-with-real-gaps)). The same journeys, measured the same way, interleaved against the build above (four desktop plays and four phone plays each). Desktop medians stayed within run-to-run spread: low Sun 14.4–15.7 ms (before 13.9–15.9), midday 13.3–16.0 ms (13.4–17.0), whole globe 12.7–15.4 ms (15.8–16.7). In phone emulation they rose 0–0.4 ms, from 1.6–1.9 ms to 1.7–2.1 ms. A first version kept four separate uniform tables, looked up per copy, and nudged the finer octave with a dependent texture read. It cost 0.5–0.9 ms more in phone emulation, so the tables were packed into one vec4 per level and the nudge was dropped.

**The air and clouds in the ground's units** (November 14, 2026; [decisions.md](decisions.md#the-air-and-clouds-in-the-grounds-units)) add a few operations per pixel to the air's transmittance draw and one division per cloud pixel. Measured as above (7 seconds of playback from 2 s, everything a frame's `requestAnimationFrame` callbacks submit), the builds before and after alternated four times in one browser, with the machine's load average at 15–17. Medians stayed within run-to-run spread. At 1280×720, DPR 2: Singapore–Hong Kong 13.1–14.8 ms before and 13.7–14.8 ms after; London–Frankfurt at low Sun 13.8–14.8 and 13.9–14.8 ms. In phone emulation (390×844, DPR 3), Singapore–Hong Kong went from 1.91–1.96 to 1.92–1.99 ms. Export of the same 10.3 s journey at 720p took 6.1 s, as before.

**Aircraft under the cloud deck** (November 15, 2026; [decisions.md](decisions.md#aircraft-under-the-cloud-deck)) runs the deck's shader once more over a plane's own pixels while it is under the deck: about 0.005 ms a frame at 2560×1440, under 0.02 ms allowing for overshading. That is too little to measure directly, so it was worked out from the deck's own cost per pixel. All figures are from the GPU's timer over everything a frame's `requestAnimationFrame` callbacks submit, in headless Chrome on the M1 Max, playing London's gate hold under an overcast. The variants were switched at runtime in one page and alternated play by play, six to eight times, so the load from other work (load average 8–13) fell on all of them alike.

| | 1280×720 at DPR 2 (2560×1440) | Phone viewport, 390×844 at DPR 3 |
| --- | --- | --- |
| Pixels the veil changes at the gate (A350) | 8,400 (0.23 % of the frame) | about 6,600 screenshot pixels |
| The deck's pass (hidden against shown) | 1.4–2.7 ms, 0.4–0.7 ns per pixel | 1.2–1.5 ms |
| The veil (hidden against shown) | +0.16 ms median, within the ±0.5 ms noise | +0.005 ms |
| The veil, from the deck's cost per pixel | about 0.005 ms; under 0.02 ms allowing for the airframe's small triangles | — |

- **The phone viewport** is the player's own choice of quality at 390×844, DPR 3. Forced to low quality (DPR 1, a 390×808 canvas), a plane at the gate is about 700 pixels: a few microseconds.
- **The fallback** without half floats (`?display-referred`) measured the same, within noise (−0.3 to +0.6 ms at 2560×1440).
- **Methods that didn't work here.** A timer query around the veil's draw alone returned 9–30 ms: on Apple GPUs, ANGLE's Metal backend times command buffers, not draws. Two amplified tests also failed:
  - Drawing the veil 101 times added 0.17–0.3 ms per copy, more at the phone's size than at 2560×1440. Per-draw overhead, not pixels, dominated.
  - Running `deck()` 41 times per pixel would put the full-screen deck at about 45 ms a frame, more than the whole measured frame. The 255-step loop it needed bloats the shader.
- **CPU:** under the deck, the plane's light takes 4.5 µs instead of 3.9 µs, and setting a veil's uniforms takes 0.4 µs a frame (Node, warm).
- **Memory and downloads:** nothing added. The veil reads the deck's textures. It is one more shader program, or two with a surface leg, since a vehicle's veil is tone mapped as a graphic.
- **Re-measure on the iPhone** before relying on these numbers.

CPU throttling does not slow the GPU, so the emulated-phone frame times are optimistic. The player steps down from standard to low automatically if playback stays below 20 fps for 3 seconds. Timing is unaffected.

## GPU memory (estimated, not measured)

The textures are the dominant allocation. RGBA8 plus mipmaps is about 1.33 × width × height × 4 bytes per texture.

- Low: a 4096×2048 day texture (43 MiB) and a 2048×1024 night map (one channel, 2.7 MiB), about 46 MiB.
- Standard: an 8192×4096 day texture (171 MiB) and a 3600×1800 night map (one channel, 8.2 MiB), about 179 MiB. Where the largest texture is under 8192, the 4096 day texture keeps it to about 51 MiB. The night maps were RGBA (11 and 33 MiB) until November 13, 2026.
- The water mask has the day texture's size but keeps one channel (`RedFormat`), a quarter of RGBA: 11 MiB at 4096×2048 and 43 MiB at 8192×4096.
- The relief map is uploaded as two channels (RG8): 24 MiB standard (4320×2160), 6 MiB low (2160×1080).
- Night-detail tiles share one texture array, one channel (R8) with mipmaps: 0.47 MiB per tile at standard (608×608), 0.12 MiB at low (304×304). An airport's 40–60 tiles take 19–28 MiB at standard and 5–7 MiB at low; the 128-tile cap is 60 MiB and 15 MiB. three.js also keeps a copy of the array in JavaScript memory, three quarters of those figures. Journeys allocate exactly the tiles they plan; the homepage allocates none.
- Clouds: each loaded weather step holds an RG8 cloud texture and an RGBA8 wind texture on the 1° grid, 382 KiB (191 KiB before the high layer). A journey keeps at most 24 steps, 9.0 MiB; the homepage frees each step it has passed. The cellular billow texture is 64³ RGBA8, 1 MiB (the value noise it replaced was 128 KiB), and the sky-light table 3 KiB.
- The homepage shows the low set first. Two seconds after the standard set is on screen it frees the low set's GPU copies.
- Framebuffers at 1280×720 with DPR 2 add about 30 MiB (without counting multisampling).
- The linear composite's half-float target (November 13, 2026): RGBA16F with 4× multisampling, a multisampled depth buffer, and the resolved colour and depth textures. That is about 211 MiB at 2560×1440 (1280×720 at DPR 2), 119 MiB for a 1080p export's context, 53 MiB at 720p, and 19 MiB on a phone at 390×844 and DPR 1. Without multisampling it would be about a fifth of that.
- Each aircraft's self-shadow maps are 512² (a 32-bit depth texture and an RGBA8 colour attachment: 2 MiB a map), one for the Sun and one for the night key once it is used: 2–4 MiB per aircraft, up to 12 MiB on the homepage. They are freed with their plane.
- During export, a second WebGL context temporarily holds a standard set as well.

Phones start at low quality.

## Export duration

| Clip | Frames | Wall time (including capability check and 15-frame probe) |
| --- | --- | --- |
| 20 s, 720×1280, follow camera | 600 | 9 s |
| 19 s, 720×720, follow camera | 570 | 9 s |
| 20 s, 1280×720, globe camera | 600 | 9 s |
| **20 s, 720×1280, follow camera, real iPhone** | 600 | 10.3 s render and encode (11.1 s with check and probe), 3.1 MB |
| 10.3 s, 1280×720, Singapore–Hong Kong, headless Chrome, linear composite (November 13, 2026) | 309 | 6.2 s (the build before it: 6.1–6.4 s) |

Export runs faster than real time on this laptop. Slower devices may take longer than the clip's length; the panel shows progress and supports cancellation.

## Request budget (Cloudflare free tier)

Live usage: `npm run usage` (see the [runbook](runbook.md)).

**The Workers request limit is account-wide.** On launch day, other projects in the same Cloudflare account already used about 6,500 requests per day, so Route Replay has roughly 93,000 of the 100,000 daily free requests. Recheck this before relying on the capacity figures below.

Free-tier references, to recheck periodically:

- Worker requests: 100,000 per day.
- Durable Objects: a separate 100,000 requests and 13,000 GB-s per day. Incoming WebSocket messages count 20 to 1; outgoing messages are free; hibernating objects aren't billed for duration.
- D1: 5 million rows read and 100,000 rows written per day; 5 GB storage.
- Static asset requests outside `run_worker_first` don't invoke the Worker.
- Durable Object storage (SQLite-backed, used only for the current activity line): 100,000 rows written and 5 million read per day, 5 GB.
- Workers AI (the homepage chat): 10,000 neurons per day, account-wide, on every plan; then $0.011 per 1,000 on Workers Paid.

| Activity | Worker requests | Durable Object requests | D1 rows read / written |
| --- | --- | --- | --- |
| Agent creates a draft | 1 | 0 | ~2 / ~4 (scene, revision, rate limits, idempotency) |
| Agent revises | 2 (GET + PUT) | 1 (notify) | ~4 / ~4 |
| Each new train, bus, car, or ferry leg in a save (not cached) | 0 (1–2 outgoing requests to BRouter or OSRM; outgoing requests don't count) | 0 | ~1 / ~1 (daily lookup budget) |
| Open a preview | 3 (shell, session, first read) + 1 socket upgrade + 1 read on connect | 1 | ~6 / ~1 |
| Each change while a preview is open | 1 refetch per open preview | included above | ~2 |
| Preview left open with no changes | 0 | 0 | 0 |
| Watch page view | 2 (HTML shell + snapshot) + 1 per 3 h of journey time for clouds (at most 24) | 0 | 1–2 |
| Homepage view | 1 (HTML shell, which carries the visitor's location for the globe) | 0 | 0 |
| Homepage clouds | 2–3 on arrival, then 1 per 24 s on screen (one 6-hour model step) | 0 | 0 |
| Docs or schema fetch | 1 | 0 | 0 |
| Storyboard (JSON or SVG) | 1 | 0 | 1 (scene or publication) |
| Agent reads the draft (bearer) | 1 | +1 (viewer and activity) | ~2 / 0 |
| Creator pauses, seeks, or resumes | 0 | 1/20 per report (incoming WebSocket message; at most one per 2 s, none during playback) | 0 |
| Agent shows a moment (`POST …/viewer`) | 1 | 1 | ~1 / 0 |
| Agent sets activity (`POST …/activity`) | 1 | 1, plus one Durable Object storage write | ~1 / 0 |
| Open the homepage chat (`GET /api/v1/compose`) | 1 | 0 | 2 / 0 |
| Each homepage chat message (`POST /api/v1/compose`) | 1, plus a Workers AI call of about 9 neurons (up to ~20 for a long confirmation email) | 0 | ~2 / 2 (rate-limit counters) |
| Chat makes the draft (when the journey is complete) | as "Agent creates a draft", then "Open a preview" | | |
| Each later change from the chat | 1 compose message (above) + 1 PUT; the open socket refetches once | 1 (notify) | ~4 / ~4 |

A preview open for an hour with no changes went from 450–1,200 Worker requests (polling) to none. On November 11, 2026, a local browser check made 4 requests in 33 seconds including one pushed revision; polling would have made about 11. Agent activity, not open previews, now drives usage. Over-quota requests fail with Cloudflare errors, and the API never partially writes a scene: replacement is one atomic batch.

Abuse bounds currently enforced:

- Creates: 30 per client per hour and 2,000 per day globally.
- Writes: 240 per draft per hour.
- Browser session exchanges: 60 per client per hour.
- Body size: 64 KiB.
- Homepage chat: 20 messages per client per hour and 800 per day for everyone (about 7,000 neurons on a typical day); 4,000 characters per conversation.
- At most 12 legs and 120 s of presentation time.
- Revisions: 50 kept per draft.

## Worker CPU (Cloudflare free plan: 10 ms a request)

The free plan allows 10 ms of CPU per request. Cloudflare tolerates a Worker that "infrequently runs over" and terminates it (error 1102) when it does so consistently. The account is on the paid plan, so overruns currently still succeed, but the budget here is 10 ms.

**How it was measured (November 12, 2026):**

- **Production:** `cpuTime` from `npx wrangler tail routereplay-web --format json` (whole milliseconds), on synthetic drafts that were deleted afterwards. The first request after a few seconds idle often lands in a fresh isolate, so a single production number is either "cold" or "warm".
- **Local:** V8 CPU profiles of the production bundle (`wrangler deploy --dry-run`) running in workerd through Miniflare, with the inspector attached. Each sample starts a fresh workerd process in which another Worker has already loaded ICU (time-zone data), as on a busy production machine, so only the app's own isolate is cold. BRouter, OSRM and NOAA are answered from recorded responses (AKL→WLG: 657 km of rail, 633 KB from BRouter; 636 km of road, 34 KB from OSRM). The local D1 and Cache simulators share the Worker's thread, so local figures overstate what D1, the Cache API and `fetch` cost in production.

**Production before the changes.** The fresh-isolate figures for the flights-only save and the cached route come from an earlier run just after a deploy, which also measured 44 ms for a fresh BRouter lookup.

| Request | Fresh isolate | Warm isolate |
| --- | --- | --- |
| Create, train leg, fresh BRouter lookup | 52 ms | — |
| Create, flights only | 14 ms | 5–6 ms |
| Create, train leg, route from the edge cache | 32 ms | 7 ms |
| Replace (`PUT`), train leg keeps its stored route | — | 9 ms |
| Read a draft (agent, bearer) | — | 3 ms |
| Publish | — | 4 ms |
| Read a publication | — | 1–2 ms |
| Weather fields: fetched from NOAA / from the edge cache | — | 6 ms / 1 ms |
| Delete | — | 1–3 ms |

An airport lookup (`GET /api/v1/airports/AKL`) sent after 20 s to 4 minutes of idle took 3–9 ms, most likely because each one landed in a fresh isolate. At today's traffic many requests probably do, so fresh-isolate costs matter.

**Where the time went:**

- **The airport table**, a 5,405-row object literal copied into a `Map` on first use: about 1.5 ms to build plus 2–3 ms of the garbage collection it set off, on the first lookup in every isolate. It is now one tab-separated string in code order (generated by `scripts/generate.mjs`), and lookups binary-search it: the first lookup takes 0.08 ms instead of 2 ms, loading the bundle takes 2.7 ms instead of 6 ms (Node, fresh isolate), and the heap is 1.5 MB smaller.
- **D1 round trips:** each costs CPU in the binding's client code, about 0.5–1 ms in a fresh isolate. A create made four: two rate-limit counters, the insert, and a list of the publications of a draft that can't have any. It now makes two. A replace no longer reads back the row it has just written (four instead of five).
- **Route lookups:** parsing BRouter's response is about 2 ms per 633 KB whichever way it is done. Parsing only the coordinates, or flattening them first, saved under 0.5 ms and wasn't worth hand-parsing the format. Simplifying that route took 0.75 ms warm and 2.6 ms in a fresh isolate; without a copy of every point and without array destructuring in the hot loop, it takes 0.35 and 2.1 ms. Decoding an OSRM polyline is twice as fast once warm (0.22 ms for 10,550 points).
- **`Intl.DateTimeFormat`** cost 12–20 ms on its first use in a fresh *process* (loading ICU data), but only 0.25 ms in a fresh isolate of a process that has already loaded it. Production processes host many Workers, so it was left alone.
- **Weather fields:** the Worker's own work (finding three lines in a 743-line index) is 0.1–0.4 ms. The rest is the runtime fetching, buffering and caching about 240 KB. Two more fields (10 m wind) are one more range request, about 155 KB.

**After, local workerd** (median busy CPU of 3 fresh processes):

| Request | Before | After |
| --- | --- | --- |
| Create, flights only, fresh isolate | 11–14 ms | 7–8 ms |
| Create, flights only, warm | 3.1–3.6 ms | 2.6–3.3 ms |
| Create, train leg, BRouter lookup, fresh isolate | 29 ms | 22 ms |
| Create, train leg, BRouter lookup, warm isolate (first route) | 24 ms | 21 ms |
| Create, train leg, BRouter lookup, warm (second route) | 9.7 ms | 8.5 ms |
| Create, train leg, cached route, warm | 3.7 ms | 2.6 ms |
| Create, car leg, OSRM lookup, fresh isolate | 29 ms | 22 ms |
| Replace | 4.4 ms | 3.5 ms |
| Read a draft / a publication | 4.2 / 1.6 ms | 3.8 / 1.3 ms |
| Weather fields from NOAA, warm (code unchanged; a smaller heap or noise) | 6.3 ms | 3.7 ms |

Production figures after the change: not yet measured (needs a deploy).

**Weather fields with the high cloud layer** (November 13, 2026; [decisions.md](decisions.md#a-high-cloud-layer)): a step is now eight messages in six range requests, made in parallel, about 430 KB instead of 240 KB. Measured the coarse way, as the CPU time of the local workerd process (`wrangler dev`) over 12 requests for steps it hadn't cached, both versions took about 3.3 ms per request, and 1.7–2.5 ms once cached. At that resolution (±1 ms) the change didn't show. Process time includes the runtime's own I/O, which Cloudflare doesn't bill, so this bounds the Worker's share from above. The index search is unchanged (five more patterns over the same 743 lines). Buffering and joining the larger body is the part that grows with size. If production `cpuTime` shows weather requests near 10 ms, piping the ranges into the response as a stream would avoid copying them in JavaScript. Not yet measured in production.

**Storyboards and seeks lay out airport labels** (renderer 2.2): one pass over every frame of the journey, about 1 ms for 18–30 s journeys and 3–4 ms for the 120 s maximum, warm, in Node. A storyboard, a seek, or an agent's read of a draft with an open preview pays it once per request. Not yet measured in workerd or production.

**Storyboards with a drone camera over surface legs** (renderer 2.6; [decisions.md](decisions.md#surface-legs-filmed-like-a-drone)). Building the timeline now also builds each traced route's running integrals, and every camera evaluation on a surface leg costs three binary searches into them. `buildStoryboard` on stored records (8 keyframes, and the label layout over every frame), in Node on an M1 Max, before → after. Warm is the median of 60 runs after 20; a fresh process is the median of 15, each in a new process that has already loaded ICU, as a busy production machine has.

| Record | Warm | Fresh process |
| --- | --- | --- |
| Zurich–Milan by train, 246 km traced, 24 s | 0.53 → 0.60 ms | 7.3 → 7.9 ms |
| Paris CDG–Marseille by TGV, 770 km traced, 24 s | 0.64 → 0.66 ms | 7.4 → 8.5 ms |
| The same leg on a winding 1,500-point route (the most the server stores) | 0.82 → 0.99 ms | 9.5 → 10.9 ms |
| Twelve such legs in 120 s: the largest record possible | 6.2 → 6.5 ms | 27.0 → 34.6 ms |

- **Building** the integrals for those twelve 1,500-point routes costs about 0.5 ms in a fresh process.
- **Evaluating** is the rest. The label layout evaluates the camera once per frame, about 3,700 times on the largest record, and before the code is optimized each evaluation over a surface leg costs about 2 µs more.
- **Brought down from a first version** that cost 8.2 ms warm on the largest record:
  - the reflections at each end come from the route's own integrals in closed form, not from copies of the route;
  - `PathTrack.fromPoints` no longer builds a throwaway great circle for every pair of points;
  - the drone's height and window use square roots, not fractional powers.
  - Checking the previous segment before each binary search saved nothing measurable, so it isn't there.
- **In fresh isolates**, real records were already near the budget and stay there. The largest record was already more than twice over and is now three times over.
- Not yet measured in workerd or production.

**Still over budget:** a save that looks up a new train, bus, car or ferry route in a fresh isolate. The route's own work is now about 2.5 ms per 650 km warm, but the first lookup in an isolate also pays for the runtime's fetch and cache machinery and for running cold code. Lookups are infrequent: about once per route, per Cloudflare location, per 30 days (edge caches can evict sooner). See [decisions.md](decisions.md#worker-cpu-within-the-free-plan) for the options if production shows them recurring.
