# Route Replay Web

A free web app where people use their own agent to create a journey, watch it play across a 3D Earth, and share a public playback link. Capable browsers can export a video locally.

**Status:** live at **https://routereplay.video** (the earlier `workers.dev` address still serves, and the old `pages.dev` address redirects to it). All six milestones of [the plan](PLAN.md) and all four of [plan 2](PLAN-2.md), the agent feedback loop, are implemented and verified, including laptop and real-iPhone budgets; see the [verification record](docs/verification.md).

## How it works

- **Authoring is done by the visitor's existing agent** over a small HTTPS JSON API. The agent reads [`/agent-docs`](agent/workflow.md) and the JSON Schema at `/schemas/scene-v1.json`, then submits a compact scene spec. The landing page's Get Started prompt points agents there; there is nothing to install. Responses carry the next step (`next[]`) and advisory `warnings[]`, and storyboards (`/storyboard`, `/storyboard.svg`) let agents check what the animation shows without a GPU.
- **The service** validates and normalizes the spec, then stores private drafts, revisions, and immutable publications in D1. It runs as one Cloudflare Worker that also serves the static app; a Durable Object per draft pushes changes to open previews over a WebSocket. The airport table converts airport codes into coordinates and IANA time zones; timestamps must carry the airport's real offset.
- **Real weather:** clouds come from NOAA's GFS model (analysis for past times, forecast up to 16 days ahead), cut from NOAA's AWS archive by range request, decoded in the browser, and carried by the model's wind between 3-hour steps.
- **The page** plays the scene with React Three Fiber inside a Remotion composition, edge to edge and framed for any screen; viewers choose 16:9, 1:1, or 9:16 when they export. That composition also renders local MP4 export through `@remotion/web-renderer`. Everything drawn is `evaluate(normalizedSpec, presentationTime)`: deterministic, seekable, and frame-exact between preview and export.
- **Private previews** move the edit credential from the URL fragment into an HttpOnly session. They refresh as revisions land, tell the agent where the creator paused (so "slow down this part" resolves to a leg), follow the agent's "show me" seeks, and show "Your agent is working" while it reports activity. In WebMCP-capable browsers they also expose `get_scene`, `set_scene`, `seek_scene`, and `publish_scene` (owner only).

## Develop

```sh
npm install
npm test                 # unit, warning-corpus, storyboard, API (local D1), compatibility, and header tests
npm run dev:worker       # build + local D1 migrations + Worker (assets, API, live updates) on http://127.0.0.1:8788
npm run smoke            # end-to-end HTTP checks (BASE_URL=https://routereplay.video for production)
npm run dev              # Vite hot reload on :5173, proxying the API and WebSocket to :8788
npm run deploy           # build, test, and deploy the Worker
npm run typecheck
```

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

Earth imagery: NASA Blue Marble and Black Marble (public domain). Airport data: OurAirports (public domain) and mwgg/Airports (MIT). Label font: Dosis (SIL OFL 1.1).
