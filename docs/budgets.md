# Measured budgets

Measured on November 11, 2026:

- **Laptop:** the production build in desktop Chrome on an Apple M1 Max laptop.
- **Real phone:** an iPhone on iOS 27.3 (WebKit) against production. See [verification.md](verification.md#representative-phone-real-device) for the full table.
- **Emulated phone:** Chrome DevTools emulation (390×844 at 3×, 4–6× CPU throttling, Fast 4G), kept for comparison.

## Startup transfer

Gzip sizes from `dist/` (Cloudflare serves Brotli where supported, which is smaller):

| Page | JavaScript + CSS | Font | Textures | First-view total |
| --- | --- | --- | --- | --- |
| Landing | 318 KiB (`index` 316 + CSS 2) | — | 0.99–1.12 MiB low (this month's 4096 day texture, night, water mask, relief), then 3.8–4.2 MiB more for standard on capable devices | ~1.3–1.4 MiB (low) |
| Watch or preview | 318 + 133 (`JourneyStage`: Remotion and the player) + 1–5 (page) | 115 KiB | 0.99–1.12 MiB low / 3.8–4.2 MiB standard | ~1.5–1.7 MiB low / ~4.4–4.8 MiB standard |
| Export (on demand) | +117 KiB (`@remotion/web-renderer` + mediabunny core) | — | standard set | Loaded only when Export is pressed |

Real iPhone, cold load over Wi-Fi: **919 KiB**, first journey frame at **981 ms**. Emulated phone (Fast 4G, 4× CPU): a cold load transferred **916 KiB**: JS 317 + 120 + 2, font 59, low textures 415, snapshot and HTML 2. The globe appeared **2.6 s** after navigation.

**Textures** (November 12, 2026, from `public/assets/2026-11-12/manifest.json`; the device measurements above predate them and used a 415 KiB low and 1.3 MiB standard set). Each page downloads one month of the Blue Marble day texture: the journey's first departure month, or the current month on the homepage.

| Set | Day texture (by month) | Night | Water mask | Relief | Total |
| --- | --- | --- | --- | --- | --- |
| Low | 4096×2048 WebP, 408–541 KiB | 2048×1024 JPEG, 129 KiB | 4096×2048 WebP, 83 KiB | 2160×1080 lossless WebP, 397 KiB | 0.99–1.12 MiB |
| Standard | 8192×4096 WebP, 1,369–1,786 KiB | 3600×1800 JPEG, 434 KiB | 8192×4096 WebP, 205 KiB | 4320×2160 lossless WebP, 1,886 KiB | 3.8–4.2 MiB |

Standard falls back to the 4096 day texture and water mask on devices whose largest WebGL texture is under 8192. December and January are the largest files and July and August the smallest, probably because northern snow cover adds detail. The whole directory, all 12 months at both widths, is 25 MiB on the server.

The landing page does not download Remotion: the player pages are code-split. Muted export does not load the audio encoder chunks (aac, mp3, flac; 470 KiB gzip).

**Clouds** add about 240 KB per model step (cloud water plus 700 hPa wind, as GRIB2), cached for a year in the browser and at the edge: about 0.5–0.7 MB when the homepage opens, then about 10 KB/s while it stays on screen, and about 1 MB for a short journey (24 steps, about 5.8 MB, at most). These figures are from November 12, 2026 and were not part of the earlier device measurements below.

**Relief** (November 12, 2026) is heavy: on standard its 1,886 KiB is more than the day texture and roughly doubles the set, and on low its 397 KiB adds 55–68 %. It was not part of the device measurements above; [assets.md](assets.md) explains the size.

## Frame time

| Scenario | Quality | Median frame | p95 frame |
| --- | --- | --- | --- |
| Landing idle globe, desktop | standard, DPR 2 | 16.6 ms | 18.4 ms |
| Watch page playback (1:1, follow camera), desktop | standard, DPR 2 | 16.7 ms | 18.3 ms |
| Watch page playback, emulated phone | low (chosen automatically), DPR 1 | 16.7 ms | 18.5 ms |
| **Watch page playback, real iPhone (iOS 27.3)** | low (chosen automatically) | 17 ms | 17 ms; 29.8 of 30 composition frames rendered per second |

These were measured before the November 12 lighting work (tone mapping, moonlight, city lights, cloud lighting), which adds per-pixel work: a few Chapman-function evaluations for sunlight through the air, a cloud shadow per light, two hashed noise fields only where the night map has lights, and the sky's reflection on water by day (about 150 arithmetic operations, two dozen of them exponentials or square roots, and no texture reads; see [decisions.md](decisions.md#water-that-reflects-the-sky)). Re-measure on the iPhone before relying on these numbers. Metering a journey's exposure costs about 80 ms of main-thread time for 2 minutes of frames, once, when it first plays.

CPU throttling does not slow the GPU, so the emulated-phone frame times are optimistic. The player steps down from standard to low automatically if playback stays below 20 fps for 3 seconds. Timing is unaffected.

## GPU memory (estimated, not measured)

The textures are the dominant allocation. RGBA8 plus mipmaps is about 1.33 × width × height × 4 bytes per texture.

- Low: a 4096×2048 day texture (43 MiB) and a 2048×1024 night texture (11 MiB), about 54 MiB.
- Standard: an 8192×4096 day texture (171 MiB) and a 3600×1800 night texture (33 MiB), about 204 MiB. Where the largest texture is under 8192, the 4096 day texture keeps it to about 76 MiB.
- The water mask has the day texture's size but keeps one channel (`RedFormat`), a quarter of RGBA: 11 MiB at 4096×2048 and 43 MiB at 8192×4096.
- The relief map is uploaded as two channels (RG8): 24 MiB standard (4320×2160), 6 MiB low (2160×1080).
- The homepage shows the low set first. Two seconds after the standard set is on screen it frees the low set's GPU copies.
- Framebuffers at 1280×720 with DPR 2 add about 30 MiB.
- During export, a second WebGL context temporarily holds a standard set as well.

Phones start at low quality.

## Export duration

| Clip | Frames | Wall time (including capability check and 15-frame probe) |
| --- | --- | --- |
| 20 s, 720×1280, follow camera | 600 | 9 s |
| 19 s, 720×720, follow camera | 570 | 9 s |
| 20 s, 1280×720, globe camera | 600 | 9 s |
| **20 s, 720×1280, follow camera, real iPhone** | 600 | 10.3 s render and encode (11.1 s with check and probe), 3.1 MB |

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

| Activity | Worker requests | Durable Object requests | D1 rows read / written |
| --- | --- | --- | --- |
| Agent creates a draft | 1 | 0 | ~2 / ~4 (scene, revision, rate limits, idempotency) |
| Agent revises | 2 (GET + PUT) | 1 (notify) | ~4 / ~4 |
| Each new train, bus, car, or ferry leg in a save (not cached) | 0 (1–2 outgoing requests to BRouter or OSRM; outgoing requests don't count) | 0 | ~1 / ~1 (daily lookup budget) |
| Open a preview | 3 (shell, session, first read) + 1 socket upgrade + 1 read on connect | 1 | ~6 / ~1 |
| Each change while a preview is open | 1 refetch per open preview | included above | ~2 |
| Preview left open with no changes | 0 | 0 | 0 |
| Watch page view | 2 (HTML shell + snapshot) + 1 per 3 h of journey time for clouds (at most 24) | 0 | 1–2 |
| Homepage clouds | 2–3 on arrival, then 1 per 24 s on screen (one 6-hour model step) | 0 | 0 |
| Docs or schema fetch | 1 | 0 | 0 |
| Storyboard (JSON or SVG) | 1 | 0 | 1 (scene or publication) |
| Agent reads the draft (bearer) | 1 | +1 (viewer and activity) | ~2 / 0 |
| Creator pauses, seeks, or resumes | 0 | 1/20 per report (incoming WebSocket message; at most one per 2 s, none during playback) | 0 |
| Agent shows a moment (`POST …/viewer`) | 1 | 1 | ~1 / 0 |
| Agent sets activity (`POST …/activity`) | 1 | 1, plus one Durable Object storage write | ~1 / 0 |

A preview open for an hour with no changes went from 450–1,200 Worker requests (polling) to none. On November 11, 2026, a local browser check made 4 requests in 33 seconds including one pushed revision; polling would have made about 11. Agent activity, not open previews, now drives usage. Over-quota requests fail with Cloudflare errors, and the API never partially writes a scene: replacement is one atomic batch.

Abuse bounds currently enforced:

- Creates: 30 per client per hour and 2,000 per day globally.
- Writes: 240 per draft per hour.
- Browser session exchanges: 60 per client per hour.
- Body size: 64 KiB.
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

**Still over budget:** a save that looks up a new train, bus, car or ferry route in a fresh isolate. The route's own work is now about 2.5 ms per 650 km warm, but the first lookup in an isolate also pays for the runtime's fetch and cache machinery and for running cold code. Lookups are infrequent: about once per route, per Cloudflare location, per 30 days (edge caches can evict sooner). See [decisions.md](decisions.md#worker-cpu-within-the-free-plan) for the options if production shows them recurring.
