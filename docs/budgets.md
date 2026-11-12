# Measured budgets

Measured on November 11, 2026:

- **Laptop:** the production build in desktop Chrome on an Apple M1 Max laptop.
- **Real phone:** an iPhone on iOS 27.3 (WebKit) against production. See [verification.md](verification.md#representative-phone-real-device) for the full table.
- **Emulated phone:** Chrome DevTools emulation (390×844 at 3×, 4–6× CPU throttling, Fast 4G), kept for comparison.

## Startup transfer

Gzip sizes from `dist/` (Cloudflare serves Brotli where supported, which is smaller):

| Page | JavaScript + CSS | Font | Textures | First-view total |
| --- | --- | --- | --- | --- |
| Landing | 318 KiB (`index` 316 + CSS 2) | — | 584–717 KiB low (this month's 4096 day texture, night, water mask), then 1.8–2.2 MiB more for standard on capable devices | ~0.9–1.0 MiB (low) |
| Watch or preview | 318 + 133 (`JourneyView`: Remotion and the player) + 1–5 (page) | 115 KiB | 584–717 KiB low / 1.8–2.2 MiB standard | ~1.1–1.3 MiB low / ~2.4–2.8 MiB standard |
| Export (on demand) | +117 KiB (`@remotion/web-renderer` + mediabunny core) | — | standard set | Loaded only when Export is pressed |

Real iPhone, cold load over Wi-Fi: **919 KiB**, first journey frame at **981 ms**. Emulated phone (Fast 4G, 4× CPU): a cold load transferred **916 KiB**: JS 317 + 120 + 2, font 59, low textures 415, snapshot and HTML 2. The globe appeared **2.6 s** after navigation.

**Textures** (November 12, 2026, from `public/assets/2026-11-12/manifest.json`; the device measurements above predate them and used a 415 KiB low and 1.3 MiB standard set). Each page downloads one month of the Blue Marble day texture: the journey's first departure month, or the current month on the homepage.

| Set | Day texture (by month) | Night | Water mask | Total |
| --- | --- | --- | --- | --- |
| Low | 4096×2048 WebP, 408–541 KiB | 2048×1024 JPEG, 129 KiB | 46 KiB | 584–717 KiB |
| Standard | 8192×4096 WebP, 1,369–1,786 KiB | 3600×1800 JPEG, 434 KiB | 46 KiB | 1.8–2.2 MiB |

Standard falls back to the 4096 day texture on devices whose largest WebGL texture is under 8192. December and January are the largest files and July and August the smallest, probably because northern snow cover adds detail. The whole directory, all 12 months at both widths, is 25 MiB on the server.

The landing page does not download Remotion: the player pages are code-split. Muted export does not load the audio encoder chunks (aac, mp3, flac; 470 KiB gzip).

**Clouds** add about 240 KB per model step (cloud water plus 700 hPa wind, as GRIB2), cached for a year in the browser and at the edge: about 0.5–0.7 MB when the homepage opens, then about 10 KB/s while it stays on screen, and about 1 MB for a short journey (24 steps, about 5.8 MB, at most). The water mask for sun glint is 46 KiB. These figures are from November 12, 2026 and were not part of the earlier device measurements below.

## Frame time

| Scenario | Quality | Median frame | p95 frame |
| --- | --- | --- | --- |
| Landing idle globe, desktop | standard, DPR 2 | 16.6 ms | 18.4 ms |
| Watch page playback (1:1, follow camera), desktop | standard, DPR 2 | 16.7 ms | 18.3 ms |
| Watch page playback, emulated phone | low (chosen automatically), DPR 1 | 16.7 ms | 18.5 ms |
| **Watch page playback, real iPhone (iOS 27.3)** | low (chosen automatically) | 17 ms | 17 ms; 29.8 of 30 composition frames rendered per second |

These were measured before the November 12 lighting work (tone mapping, moonlight, city lights, cloud lighting), which adds per-pixel work: a few Chapman-function evaluations for sunlight through the air, a cloud shadow per light, and, only where the night map has lights, two hashed noise fields. Re-measure on the iPhone before relying on these numbers. Metering a journey's exposure costs about 80 ms of main-thread time for 2 minutes of frames, once, when it first plays.

CPU throttling does not slow the GPU, so the emulated-phone frame times are optimistic. The player steps down from standard to low automatically if playback stays below 20 fps for 3 seconds. Timing is unaffected.

## GPU memory (estimated, not measured)

The textures are the dominant allocation. RGBA8 plus mipmaps is about 1.33 × width × height × 4 bytes per texture.

- Low: a 4096×2048 day texture (43 MiB) and a 2048×1024 night texture (11 MiB), about 54 MiB.
- Standard: an 8192×4096 day texture (171 MiB) and a 3600×1800 night texture (33 MiB), about 204 MiB. Where the largest texture is under 8192, the 4096 day texture keeps it to about 76 MiB.
- The water mask (2048×1024) adds 11 MiB to either set.
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
