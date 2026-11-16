# Route Replay Web

A free web app where people use their own agent to create a journey, watch it play across a 3D Earth, and share a public playback link. Capable browsers can export a video locally.

**Status:** live at **https://routereplay.video** (the earlier `workers.dev` address still serves, and the old `pages.dev` address redirects to it). All six milestones of [the plan](PLAN.md) and all four of [plan 2](PLAN-2.md), the agent feedback loop, are implemented and verified, including laptop and real-iPhone budgets; see the [verification record](docs/verification.md).

## How it works

- **Authoring is done by the visitor's existing agent** over a small HTTPS JSON API. The agent reads [`/agent-docs`](agent/workflow.md) and the JSON Schema at `/schemas/scene-v1.json`, then submits a compact scene spec. The landing page's Get Started prompt points agents there; there is nothing to install. Responses carry the next step (`next[]`) and advisory `warnings[]`, and storyboards (`/storyboard`, `/storyboard.svg`) let agents check what the animation shows without a GPU.
- **The service** validates and normalizes the spec, then stores private drafts, revisions, and immutable publications in D1. It runs as one Cloudflare Worker that also serves the static app; a Durable Object per draft pushes changes to open previews over a WebSocket. The airport table converts airport codes into coordinates and IANA time zones; timestamps must carry the airport's real offset.
- **Real weather:** clouds come from NOAA's GFS model (analysis for past times, forecast up to 16 days ahead), cut from NOAA's AWS archive by range request, decoded in the browser, and carried by the model's wind between 3-hour steps.
- **The page** plays the scene with React Three Fiber inside a Remotion composition, edge to edge and framed for any screen; viewers choose 16:9, 1:1, or 9:16 when they export. That composition also renders local MP4 export through `@remotion/web-renderer`. Everything drawn is `evaluate(normalizedSpec, presentationTime)`: deterministic and seekable.
- **Private previews** move the edit credential from the URL fragment into an HttpOnly session. They refresh as revisions land, tell the agent where the creator paused (so "slow down this part" resolves to a leg), follow the agent's "show me" seeks, and show "Your agent is working" while it reports activity. In WebMCP-capable browsers they also expose `get_scene`, `set_scene`, `seek_scene`, and `publish_scene` (owner only).

## Roadmap

Realism work not yet started, mostly adapted from the offline renderer:

- **Real stars:** the Yale Bright Star Catalogue to magnitude 6.5, with real colours, in place of seeded random stars. Check its licence first.
- **Moonlit air:** the night limb glowing faintly under a bright Moon, which also lets water reflect a moonlit sky. Airglow, the thin green line at the night limb, would go in the same shader; the offline renderer doesn't draw it.
- **Higher-quality exports:** more atmosphere steps, a sharper aircraft shadow, and motion blur from averaged sub-frames. Exports aren't real-time, so they can afford it. Clocks, geometry and seeds stay the same as playback, as with the offline renderer's quality settings, so an export shows the same moments as the preview but not identical pixels. Exports already draw up to 16 jittered samples per frame where the device has time ([hardware tiers](docs/decisions.md#hardware-tiers-and-cleaner-exports)).
- **A desktop tier for capable GPUs:** a short benchmark at startup that promotes them automatically. The tier exists, behind `?tier=desktop`, for measurement.
- **Snow and sea ice for the trip's date,** from GFS, in place of the monthly 2004 snow. Sea ice also stops the ocean glint.
- **Recorded flight tracks** (GPX, KML, CSV, IGC): real route shapes, banking in turns, pacing that lingers on climbs, descents and turns, and an optional distance, altitude and speed readout. Needs a schema field and a legitimate source of tracks for agents.
- **Photo and video cards** at moments in the trip. Needs uploads and storage, which Route Replay avoids today, so it's a product decision first.

## Develop

```sh
npm install
npm test                 # unit, warning-corpus, storyboard, API (local D1), compatibility, and header tests
npm run dev:worker       # build + local D1 migrations + Worker (assets, API, live updates) at https://routereplay.localhost
npm run smoke            # end-to-end HTTP checks against that Worker (BASE_URL=https://routereplay.video for production)
npm run dev              # Vite hot reload at https://vite.routereplay.localhost, proxying the API and WebSocket to the Worker
npm run deploy           # build, test, and deploy the Worker
npm run typecheck
```

Local servers run through [portless](https://github.com/vercel-labs/portless), which gives them stable `.localhost` addresses instead of ports. In a git worktree they get the branch as a subdomain, such as `https://<branch>.routereplay.localhost`, so several checkouts can run at once. portless needs Node 24, and its first run installs a local certificate authority (it may ask for `sudo`).

Asset rebuilds, which download sources into `.cache/`, are `npm run assets:airports` and `npm run assets:textures` (needs Pillow).

## Layout

| Path | Contents |
| --- | --- |
| `src/shared/scene/` | Versioned contract: constants and limits, JSON Schema, validator and normalizer, advisory warnings, time-zone handling, compatibility policy |
| `src/shared/timeline/` | Deterministic timeline and camera evaluation, storyboards |
| `src/shared/geo/` | Great circles, subsolar point, vectors |
| `src/server/` | API (`api.ts`), D1 store, idempotency and rate limits, credentials, docs rendering, storyboard SVG, airport table |
| `src/server/worker.ts`, `src/server/live.ts`, `src/server/liveState.ts` | Worker entry and the `SceneLive` Durable Object: change pushes, where the creator is looking, seek, and the agent-activity line; `wrangler.toml` `run_worker_first` restricts which paths invoke the Worker |
| `src/app/` | Landing, preview, and watch pages, R3F scene (`render/`), Remotion composition, export, WebMCP tools |
| `agent/` | Source of `/agent-docs` (workflow, reference, docs version) |
| `migrations/` | D1 schema |
| `docs/` | [Decisions](docs/decisions.md), [verification](docs/verification.md), [budgets](docs/budgets.md), [compatibility](docs/compatibility.md), [assets and licenses](docs/assets.md), [runbook](docs/runbook.md) |

This project is separate from the offline renderer, [`routereplay-offline`](https://github.com/nathangathright/routereplay-offline). Its conventions informed the design, but the web app shares no code, data, or history with it.

Earth imagery: NASA Blue Marble and Black Marble (public domain). Airport data: OurAirports (public domain) and mwgg/Airports (MIT). Label font: Barlow Condensed (SIL OFL 1.1).
