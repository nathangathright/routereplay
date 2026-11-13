# Verification record

What was checked against each milestone's completion evidence in [PLAN.md](../PLAN.md) and [PLAN-2.md](../PLAN-2.md), how, and with what result. Local checks used the production build under `wrangler pages dev` with local D1, in desktop Chrome on November 11, 2026. Production checks ran against https://routereplay-web.pages.dev on the same day.

## Automated tests (`npm test`, 129 tests)

| Area | File | Covers |
| --- | --- | --- |
| Scene contract | `tests/scene.test.ts` | Schema bounds, unknown fields, unsupported versions and presets, non-finite numbers, text limits, IATA/ICAO hints, unknown airports, DST offsets (summer/winter, spring-forward gap, fall-back repeat), `Z` handling, eastbound and westbound date-line crossings, connected/overlapping/duplicate legs, antipodal and same-airport legs, leg references, duration budget with a repair hint, repeated airports, key-order independence, and published JSON Schema ↔ validator agreement (Ajv) |
| Timeline | `tests/timeline.test.ts` | Monotonic flight profile, segment coverage, presentation→physical time mapping (start/end holds fixed, layover animates the real connection, zero hold is a cut), clamping, determinism under 200 shuffled out-of-order seeks on fresh and reused timelines, date-line path continuity, camera/heading over the pole for both presets, solstice subsolar point, separate label lifetimes for repeated airports, flown-trail reveal |
| API and persistence | `tests/api.test.ts` (Miniflare D1) | Create and read, credential hashing (no plaintext in any table), edit/owner capability separation, no credentials on reads, 401/404 non-enumeration, ETag/304, validation without saving, 413/415/400 bodies, creation rate limit with `Retry-After`, atomic `expectedRevision` replace, exactly one winner for concurrent writers, invalid updates preserve the scene, undo via revisions, idempotent create replay (encrypted at rest), key reuse with a different body, idempotent publish, edit cannot publish, immutable snapshot isolated from later edits, revalidating public cache, watch-page discovery hints and content negotiation, owner-only delete with 410 tombstones and no residual rows, cookie session exchange, CSRF header and Origin checks, agents cannot mint sessions, edit rotation revokes old tokens and sessions, sign-out, airport offset lookup, docs and schema rendering (no install step; `/skills/…` falls through), warnings and `next` on responses, storyboard routes, and (through a fake Durable Object) change notifications, viewer context with extrapolation and ETag changes, seek, activity with expiry, page reads that skip the object, and viewer/activity kept out of D1 and public data |
| Warnings | `tests/warnings.test.ts` | A 13-itinerary real-world corpus that must stay quiet, one realistic mistake per warning code, and the property that only the current leg's endpoints are ever labelled, with every visit (repeated airports included) introduced |
| Airport labels | `tests/labels.test.ts` | Slots, first and last frames matching the offline renderer's `labels.json` for its ORD→SFO→AKL demo at 9:16, the fixed slot until arrival, ground lock and recession, departed labels that never grow back (an Auckland–Wellington hop and the demo, in 16:9 and 9:16), towers for airports and dots for stations, arrival pulses |
| Storyboards | `tests/storyboard.test.ts` | Keyframe spacing and phases, local times, daylight, follow versus globe framing, screen time summing to the duration, cut connections, SVG content, escaping, antimeridian continuity |
| Live channel rules | `tests/live.test.ts` | Viewer report validation, latest report wins, activity expiry and events, activity message cleaning |
| Compatibility | `tests/compat.test.ts` | Saved published v1 fixture still plays, its connection animation, golden evaluated states at fixed frames, its pinned 12-keyframe storyboard, rejection of a different renderer major |
| Headers | `tests/headers.test.ts` | Static `_headers` CSP equals Function CSP |

The API tests also cover weak ETag comparison, which Cloudflare compression requires.

`npm run smoke` against the running local server passed all 20 end-to-end HTTP checks: docs, schema, create, idempotent retry, read, anonymous rejection, conditional read, revise, conflict, invalid revision hint, edit cannot publish, publish, credential-free public read, no secrets or draft id in public data, isolation from later revisions, watch-page JSON link, edit cannot delete, owner delete, 410 afterwards.

## Milestone 1: contract and rendering spike

- **Same timestamps survive pause, seek, and export.** I exported a 20 s, 720×1280 clip in the browser, then compared decoded frames 0, 90, 200, 300, 420, and 599 with the live preview paused at the same frames (`scripts/browser/compare-frames.js`, preview at `?debug`). Mean absolute difference was 0.39–1.30 of 255 and PSNR 43.0–50.9 dB, consistent with H.264 loss. Repeating the comparison in reverse seek order gave identical numbers. A control that compared decoded frame 300 with preview frame 330 dropped to 32.9 dB, so the metric discriminates.
- **Invalid fixtures are rejected:** see `tests/scene.test.ts`.
- **No dependence on Python or Blender.** The renderer is TypeScript, three.js, and R3F. The `../routereplay` repository was read for concepts only: its trip format, presentation contract, sqrt-distance pacing, and the Dosis font. No code, data, outputs, or history was copied.

## Milestone 2: local agent workflow

- **A real HTTP-capable agent created and revised a journey without installation.** A fresh Claude subagent got only the Get Started prompt and a trip in prose. It was barred from reading the source. It read `/agent-docs`, built the spec, checked it with `/validate`, and created the draft with an idempotency key, with no validation errors. The trip included Lisbon's DST change on the night of the flight, and it chose the correct `+01:00` offset. In a follow-up turn it revised pacing, stop hold, and camera (revision 1 → 2) and published. A second fresh agent, told the creator declined the skill, created a Tokyo → Honolulu → Los Angeles date-line journey using the airport offset endpoint.
- **A compatible agent installed the skill and resumed in a later session.** The first agent installed `routereplay-web` from `/skills/routereplay-web.zip` into a project skills folder. A separate later `claude -p` session (Sonnet, MCP disabled) in a directory containing only that skill was given the draft id and credentials. It invoked the `routereplay-web` skill, fetched the current hosted `/agent-docs`, changed the scene to 1:1 (revision 3), and published a new watch link. The installed skill predated later doc edits, which shows that the hosted contract, not the installed copy, governs.
- **Get Started cases, all five exercised with live agents:**
  - Accepted: installed (above).
  - Declined: offered once, then created over HTTP.
  - Already installed: the later session used the skill without re-offering.
  - Unsupported: a Sonnet agent told it could not install skills made no offer and created an Anchorage → Frankfurt journey on production.
  - Failed: a Sonnet agent asked to install into a read-only folder got `Permission denied`, told the user, and created and published a Sydney → Singapore → London journey on production without choosing another location.

  The "unsupported" agent redacted its own create response and lost the owner credential. That led to a doc fix: capture the whole response first. The docs now also say that an identical retry with the same `Idempotency-Key` within 24 hours returns the credentials again.
- **Private preview and revision refresh:** the preview removed the `#k=` fragment from history before any request, exchanged it for an HttpOnly session, and picked up HTTP and WebMCP revisions while open.
- Agent feedback from these runs led to doc fixes: a dangling example reference in the skill, DST changes during a trip, optional fields, pacing arithmetic, `1:1`, phone support, owner-credential handover, and a public snapshot `revision` field. The airport offset endpoint was also added in response.

## Milestone 3: sharing

- **The public URL works in a fresh browser without credentials:** watch pages loaded in an isolated browser context with no cookies, at 1280 px and at 390 px phone width with no horizontal scroll. They registered no WebMCP tools.
- **Draft edits do not change it:** covered by the API tests and the smoke run.
- **Edit tokens cannot delete or publish:** covered by the API tests, the smoke run, and a manual `curl` call (`owner_required`).
- **Deletion:** after owner deletion the publication API answers 410 and the watch page shows "This journey was deleted". A browser-cache issue was found and fixed: snapshots were initially cacheable for 5 minutes, and they now revalidate with ETags on every view.

## Milestone 4: WebMCP

**Real WebMCP walkthrough on production.**

- **Setup:** Chrome 157 launched with `--enable-features=WebMCP`, which provides a native `document.modelContext`. An agent (Claude, driving `scripts/webmcp-cli.mjs`, which uses Puppeteer's WebMCP API over CDP) opened an owner preview link.
- **Discovery:** the browser listed `get_scene`, `seek_scene`, `set_scene`, and `publish_scene` with the declared input schemas and annotations: read-only for get and seek, consequential for publish.
- **Read and error:** the agent read revision 1. It then sent a change to 9:16 with a wrong offset (`-07:00` for SFO in January) and got `validation_failed` with the `/legs/1/departure` path and the hint `write 2031-01-05T21:30:00-08:00`. Nothing changed.
- **Fix and conflict:** it applied the hint and switched to the follow camera, getting revision 2 with `assetsReady: true`. The preview re-rendered. Resending the same change returned `revision_conflict`, `currentRevision 2`.
- **Seek:** `seek_scene` at 9.5 s reported phase `flight`, leg `sfo-akl`, the physical UTC time, the aircraft position, and the visible SFO label, and the page showed 0:09. A negative time returned `out_of_range`.
- **Publish:** `publish_scene` without `creatorRequested: true` was refused with `confirmation_required`. With it, a watch link was created that serves revision 2 publicly.

Earlier local checks with a stand-in for the same API showed that edit-only sessions do not register `publish_scene`. Public watch pages register no tools. The HTTP path works without WebMCP (all agent runs above).

**Not covered:** ChatGPT desktop's built-in browser was not available in this environment, so compatibility is claimed only for Chrome's native WebMCP as exercised above.

## Milestone 5: export and device quality

- **Short decoded clip matches the timeline:** see milestone 1. Export is gated by a WebCodecs check, `canRenderMediaOnWeb`, and a real 15-frame probe export that must decode at the expected size. Full exports of 19–20 s clips took 9 s and also succeeded under the production CSP.
- **Cancellation:** cancelling at 11% showed "Export cancelled", left no file, and playback continued.
- **Weak or unsupported devices keep playback:**
  - With WebGL disabled, the page shows a clear note, the route summary, and Share.
  - Forcing WebGL context loss showed an explanatory overlay with the summary. "Restore 3D view" remounted the canvas at low quality with a fresh context.
  - The emulated phone started at low quality automatically.
- **A playback bug found and fixed:** the Remotion Player waited for an AudioContext to resume and never advanced on a machine whose audio device errored. The Player now starts muted, since journeys are silent.

## Milestone 6: limited public launch

**Deployed** on November 11, 2026 to Cloudflare Pages project `routereplay-web` (https://routereplay-web.pages.dev) with D1 database `routereplay` (`786bdf85-d8da-41c8-9efb-f2c4fd42bc1e`). The `RATE_LIMIT_SALT` secret is set.

- **End-to-end creation and public playback on deployed URLs:**
  - `npm run smoke` against production passed all 20 checks. The first run found that Cloudflare's Brotli compression weakens ETags, which broke conditional polling; the fix is weak `If-None-Match` comparison, now tested.
  - Real agents created, revised, and published on production: the unsupported, failed-install, and WebMCP runs above.
  - A fresh browser context with no cookies played a production watch link and exported a 20 s MP4 in 9 s. The export logged no license warning.
  - An emulated phone (Fast 4G, 4× CPU) loaded a watch page cold with 916 KiB transferred, and the globe appeared at 2.6 s.
- **Storage restore and deletion:**
  - D1 Time Travel is active.
  - `wrangler d1 export --remote` produced a 26-row dump containing no plaintext credentials. It was restored into a scratch database, `routereplay-restore-test`.
  - Row counts matched production (3 scenes, 4 revisions, 2 publications, 2 tombstones), and a known publication loaded from the restore. The scratch database was then deleted.
  - Owner deletion on production returned 410 for the deleted watch link (smoke run).
- **No secrets in public JSON or logs:**
  - The smoke checks confirm public snapshots contain no credentials or draft ids.
  - A production `wrangler pages deployment tail` covering 35 requests (agent creates, revisions, publications, session exchange, WebMCP) contained no token-like strings, no console output, and no exceptions.
  - Internet scanners were already probing (`GET /api/.env`) and received 404 JSON.
- **Independent external agent on the deployed URL:**
  - **Agent and setup:** a Codex agent (OpenAI GPT-6 Astra, a different provider from the Claude agents above) got only the Get Started prompt and a Toronto → Vancouver → Tokyo trip, and was barred from the source.
  - **Create:** it read `/agent-docs` and resolved every offset with the airport endpoint. Vancouver is `-07:00` on 7 March 2031: under current tz data (tzdata 2026c in Node, Python's system zoneinfo, and the Worker) British Columbia observes permanent UTC−07:00, so this is correct. It created the draft with no validation errors.
  - **Revise and publish:** it revised the same draft (revision 1 → 2: 9:16, Pacific leg exactly +2.0 s while the first leg stayed at 4.0 s, using the documented pacing arithmetic) and published. It then confirmed the watch data credential-free (`/w/r3ni8wf42kyl`). The skill offer was declined as scripted.
  - **Finding:** its first schema fetch used Python's `urllib` and got `403 error code: 1010`. Cloudflare's Browser Integrity Check on `*.pages.dev` blocks the `Python-urllib/*` User-Agent on every path, while curl, `requests`, and custom User-Agents pass. The zone setting cannot be changed on `pages.dev`. The agent docs now tell agents to send a descriptive User-Agent and explain error 1010, and the runbook covers the WAF exemption for a custom domain.
- **Export on real hardware:**
  - Exports ran in headed (not headless) Chrome 157 on this laptop's real GPU. WebGL reports `ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Max)` and `VideoEncoder` is available. This is the plan's "ordinary laptop".
  - All the DevTools-driven playback, export, frame-comparison, cancellation, and context-loss checks above ran in that browser.
  - `scripts/browser/export-check.mjs` also passed in headless Chrome against production: playback advanced, and the 20 s MP4 exported in 9 s and decoded at 720×1280, 20.0 s, with no console errors.
  - Firefox 147 is installed, but it never opened its automation endpoint in this environment (WebDriver BiDi did not start, with or without the command sandbox), so it was not tested.
  - Safari automation needs `safaridriver --enable`, which requires an administrator.
  - Both remain manual checks, along with a phone.
- **Usage visibility:** `npm run usage` (`scripts/usage-report.mjs`) reads Cloudflare GraphQL analytics and D1 metadata. It reports 24-hour Function requests for this project, unattributed requests, and the account-wide total. It also reports D1 rows read and written and storage, compares each against the free limits, and exits with status 1 at 70%. The first run showed about 6,600 requests per day already used account-wide by other projects. Dashboard notifications could not be created: the wrangler token gets "Authentication error" from the alerting API.
- **Licensed asset inventory, quotas, runbook, and compatibility notes:** [assets.md](assets.md) (Remotion Free License eligibility checked; `free-license` key set), [budgets.md](budgets.md), [runbook.md](runbook.md), [compatibility.md](compatibility.md).

## Move to a Worker with push updates (plan 2, milestone 7)

On November 11, 2026 the site moved from Cloudflare Pages to one Worker. The Worker serves the static assets and the API, and runs a `SceneLive` Durable Object per draft for live updates.

- **Tests:** 87 automated tests pass. New ones check that change notifications fire only after successful replace, publish, delete, and edit-key rotation, and never after a conflict. They also check that the live route accepts only authorized, same-origin WebSocket upgrades.
- **Local (`wrangler dev`, real Durable Object):**
  - All 24 smoke checks passed. A browser session opened the live socket and received `{"type":"changed"}` for a revision, a publication, and a deletion.
  - In Chrome, an open preview made 4 requests in 33 seconds, including one revision pushed after 20 idle seconds that appeared within about a second. Polling would have made about 11.
- **Production:**
  - The same 24 checks pass at https://routereplay-web.resonantconcepts.workers.dev, including both live pushes.
  - Static pages carry the CSP from `_headers`, and `/_headers` itself isn't served.
  - Existing data carried over through the shared D1 database: a watch link published before the move loads from the new address.
- **Old links:** `routereplay-web.pages.dev` now answers every path with a 308 to the Worker, preserving the path and query, including API POSTs that keep their method.
- **Known:** `*.workers.dev`, like `*.pages.dev`, rejects Python's default `Python-urllib` User-Agent with `error code: 1010`. The agent docs already tell agents to send a descriptive User-Agent.

## Plan 2 completion evidence

Each completion criterion in [PLAN-2.md](../PLAN-2.md#delivery-sequence), and where it was met. "Outside agent" means an agent not running in the developer's session: a Codex thread, or a separate `claude -p` process.

| Milestone | Required evidence | Met by |
| --- | --- | --- |
| 7 | Smoke test receives pushed events locally and in production | Milestone 7 section; still passing in the 40-check smoke |
| 7 | Revision appears within about a second, with no polling | Milestone 7 browser check |
| 7 | Old `pages.dev` links redirect with 308 | Milestone 7 section |
| 8 | A real agent completes a journey from the shortened prompt with no install step | Ten agents, each through create, revise, and publish: a fresh Claude agent (milestone 8); then in milestone 10, Codex Sol (scripted, then live), Codex Astra (twice), Codex Terra (twice), separate Claude Code sessions on Sonnet (twice), and Haiku |
| 8 | Unit tests for every warning code and for storyboard keyframes | `tests/warnings.test.ts`: each of the five codes has a triggering case and a quiet corpus. `tests/storyboard.test.ts` |
| 8 | Published fixture's storyboard pinned like its golden states | `tests/fixtures/publication-v1.storyboard.json` |
| 8 | A real agent mentions a warning to the creator | Three agents. The milestone 8 Claude agent asked about the year after `far_future_or_past`. Two live outside agents: the Sonnet session explained `compressed_connection` and offered a 2-second pause, and the Haiku session explained how it resolved `short_screen_time` |
| 8 | A real agent uses a storyboard to confirm a change | The milestone 8 agent (6.97 s → 13.97 s), the milestone 9 agent, scripted Codex (`?at=7`), and live Codex (`?at=8.2,10.4,12.6` after its save) |
| 9 | A real agent resolves "slow down this part" from viewer context without asking which leg | Ten of eleven sessions, without a clarifying question, across Claude (Opus subagent, Sonnet, Haiku) and Codex (Astra, Sol, Terra). The miss was a Terra agent dropped mid-conversation that never consulted the service. After the create-response hint shipped, four of four fresh agents resolved it |
| 9 | Activity banner appears and expires | Local browser check (appeared, then gone at 3 minutes with the API reporting idle). Production page recorders saw it appear and clear for two agents |
| 9 | Viewer state never reaches D1 or public data | API tests scan every D1 table and public JSON; the production smoke checks public JSON |
| 10 | Get Started walkthroughs by agents outside the developer's session | Nine, across two providers and five models: Codex GPT-6.1 Sol (scripted, then live), GPT-6 Astra (twice), and GPT-6.1 Terra (twice); and separate Claude Code sessions on Sonnet 5.5 (twice) and Haiku 5.5. Each completed create, revise, and publish, independently verified through the public storyboard |
| 10 | Written outcome for A6 | [decisions.md](decisions.md#notes-pinned-to-a-moment-plan-2-a6-not-adopted): not adopted |
| 10 | Agent docs, runbook, and budgets updated | `agent/workflow.md`, `agent/reference.md`, the runbook's live-channel section, and the budgets' new rows |
| Carried from plan 1 | Firefox export | Firefox 160 played and exported a 720×1280, 17.5 s MP4 that decodes |
| Decision to validate 4 | Custom domain | Stay on `workers.dev` for now ([decisions.md](decisions.md#hosting-address-workersdev-for-now)) |

The A6 and activity outcomes are judgments from eleven "this part" sessions and eleven agents that changed drafts. The owner reviewed and accepted the A6, activity, and hosting outcomes on November 11, 2026. [PLAN-2.md](../PLAN-2.md#outcomes-milestone-10) lists what would reopen each.

## Agent signals (plan 2, milestone 8)

Shipped to production on November 11, 2026: no installable skill, `next[]` on every successful response, advisory `warnings[]`, and storyboards (JSON and SVG).

- **Tests:**
  - `tests/warnings.test.ts` runs a corpus of 13 plausible real-world itineraries that must produce no warnings: ultra-long-haul SIN–JFK, date-line crossings both ways, a polar route, PER–LHR, a 40-minute island hop, a congested shuttle, multi-day stays, same-day returns, a connection across the Pacific, twelve island-hopping legs, a 9:16 follow-camera clip, and a recent past trip. It also has one realistic mistake per warning code: an arrival a day late, an a.m./p.m. slip, an impossible speed, a 21-hour block, legs too brief to follow, and a 5-day stay shown for 0 s.
  - `tests/storyboard.test.ts` covers keyframe spacing, phases, local times at both ends, daylight, follow versus globe framing, screen time adding up to the duration, cut connections, SVG content, escaping, and antimeridian continuity.
  - The published fixture's 12-keyframe storyboard is pinned in `tests/fixtures/publication-v1.storyboard.json` beside its golden states.
  - API tests cover warnings on validate, create, and replace; `next` on every agent-facing success; storyboard access rules, query validation, the public publication storyboard, 410 after deletion, and `validate?storyboard=n`. Other tests check that `/skills/…` now falls through to the app shell and that the docs contain no install step.
- **Dropped warning, `label_crowding`:** the renderer fades one airport label out (from 30% of the outgoing leg) before the next fades in (from 50% of the incoming leg). So two labels are never both more than half visible, even with legs squeezed to the 1-second minimum. A test pins that property instead, so a renderer change that breaks it brings the warning back into question.
- **Cost:** a 24-keyframe storyboard takes about 0.9 ms of CPU, and the warnings about 0.01 ms, well inside the Workers free-plan CPU limit.
- **Production:** all 32 smoke checks passed at https://routereplay-web.resonantconcepts.workers.dev, including create warnings and next steps, draft and public storyboards, the SVG, and the removed skill download.
- **Real agent, from the shortened prompt.** A fresh Claude agent got only the new Get Started prompt and a scripted creator, and was barred from reading files or source.
  - The trip, Boston → Lisbon → Madeira, contained a year typo: 2029 for 2027.
  - The agent ran a dry run first. Only the service's `far_future_or_past` warning caught the typo, and the agent asked: "you wrote June 14, 2029, which is more than two and a half years from now. Is 2029 the right year?" It rebuilt the spec with 2027 after the scripted correction.
  - It created the draft (no install step) and checked the storyboard, noting that the Atlantic crossing is in darkness until daylight near Portugal.
  - Asked to "slow down the Atlantic crossing" and make it vertical, it used the storyboard to confirm the crossing went from 6.97 s to 13.97 s with the other leg and the stop unchanged. It also viewed the SVG sketch.
  - It published (`/w/d2v6ro10jiv7`). An independent check of the public storyboard confirmed 9:16, 21.5 s, and BOS–LIS at 13.97 s.
- **Warning raised live by an outside agent:** in milestone 10's live walkthrough, a separate Claude Code session received a `compressed_connection` warning after the creator asked to cut a 3-day stop, and explained it to the creator, offering a 2-second pause instead. See the milestone 10 section.
- **Doc fixes from that run:**
  - The year warning's hint now says to ignore it only once the creator confirms the date.
  - Validate's `next` now covers revising (PUT) as well as creating.
  - The pacing instructions give an explicit weight formula with an example.
  - The reference documents that a publication's record is under `scene`.
  - The owner-credential instruction says to give it, not offer it.
  - The SVG now has a legend explaining markers and night shading.

## Live loop (plan 2, milestone 9)

Shipped to production on November 11, 2026:
- The preview reports where the creator paused, seeked, or resumed.
- Agent reads include `viewer` (evaluated with the shared timeline) and `activity`.
- `POST …/viewer` moves open previews to a moment, and `POST …/activity` shows "Your agent is working: …", which lapses after 3 minutes.

- **Tests:**
  - `tests/live.test.ts` covers viewer-report validation, the latest report winning, activity expiry, and message cleaning.
  - The API tests drive a fake Durable Object that uses the same rules. They check:
    - Viewer context against the current revision, including extrapolation while playing and an ETag change when the viewer moves.
    - That the page's own reads never ask the object.
    - Seek delivery and validation.
    - Activity set, expiry, and idle.
    - That neither the viewer nor the activity message appears in any D1 table or in public publication data.
- **Real Durable Object:** the smoke test opens a browser-style socket and checks each of these, locally and in production (all 40 checks):
  - A reported pause reaches an agent read as `at` with a summary.
  - A seek arrives on the socket.
  - Activity is pushed, and a second preview opening mid-activity receives it on connect.
  - Activity appears in reads, and idle clears it.
  - Public data contains neither.
- **Browser (local Worker, Chrome):**
  - The page reported its initial position ("At ORD before departure").
  - An API seek to 12 s moved the player to 0:12, and the page reported 12 s back.
  - Playing with the keyboard produced a playing report, extrapolated correctly across the loop. Pausing again reported 7.47 s ("Connecting at SFO").
  - The activity banner appeared at once. With no idle sent, it disappeared on its own at the 3-minute mark, and the API then reported `idle`.
  - After a save, `viewer.revision` showed the old revision for about one second, until the page re-reported.
- **Real agent, "slow down this part" (production).**
  - Setup: a Chicago → San Francisco → Honolulu → Sydney draft was open in Chrome. Acting as the creator, I pressed Play and then Pause partway through the second flight (8.63 s, SFO → HNL, 48%). A fresh Claude agent, told only that the creator said "Slow down this part a bit, it goes by too fast", re-read the docs.
  - It read `viewer.at` and did not ask which part. It told the creator: "I took 'this part' to mean the San Francisco → Honolulu flight, since your preview was paused about halfway through it."
  - It doubled that leg from 4.50 s to 9.00 s, with the other legs unchanged (3.95 s and 6.55 s), and confirmed the change with the storyboard.
  - Unprompted, it posted activity. A recorder in the creator's page logged "Your agent is working: Slowing down the San Francisco to Honolulu flight" at 16:54:28, revision 2 arriving at 16:54:44, and the banner clearing when the agent sent idle.
  - It moved the view once to the start of the slowed leg. When the creator asked, "Can you show me the layover in Honolulu?", it moved the view to 16.2 s ("Connecting at HNL"), which the screenshot confirmed.
- **Fixes from that run:**
  - The page now reports again after a new revision loads.
  - The docs explain `viewer.revision`, say that a paused position doesn't go stale, and explain what setting `durationSeconds` costs.
  - The activity guidance now says "more than about 10 seconds in all".
  - A storage alarm deletes expired activity text instead of leaving it in the object's storage.

## Review (plan 2, milestone 10)

- **Scripted walkthrough by an agent outside the developer's session.** A Codex agent (GPT-6.1 Sol, a different provider and harness, started through T3 Code's delegation) got the shortened Get Started prompt, a scripted creator, and no access to files.
  - It caught the creator's slip (landing in Anchorage "July 11" for a 2 h 40 min flight) and asked about it before creating.
  - It created the draft and checked the storyboard. When the creator said the stay "flashes by", it posted activity, lengthened the Anchorage stop from 1.5 s to 5 s, confirmed that with the storyboard, and cleared the activity.
  - It published (`/w/vcv0xcgvhd62`). An independent check of the public storyboard confirmed the 5 s stop and both flights unchanged (4.19 s and 5.81 s).
  - It reported no API errors or documentation contradictions.
- **Four live walkthroughs by agents outside this session.** In each, I acted as the creator turn by turn: I answered the agent's actual questions, opened its preview in Chrome, played it, paused, and pointed at the screen without naming the leg. A recorder in the page logged revisions, seeks, and banners.
  - **Codex (GPT-6 Astra, its own T3 thread), London → Singapore → Bali, vertical:**
    - Before creating anything, it asked for the arrival time and what "two days later" meant.
    - It created a 9:16 draft and checked the storyboard.
    - I paused on the Singapore stop and wrote only "Can this bit stay on screen longer though? It's over in a blink." It read the viewer context ("You've paused at the Singapore stop") and set the stop to 4.5 s from 1.5 s.
    - The page showed "Your agent is working: Giving your Singapore stop more time", then revision 2, then the banner cleared.
    - On request it published `/w/gueuppsz7ag5`, verified as 9:16 with the stop at 4.5 s and the creator's times.
  - **A separate Claude Code process (`claude -p`, Sonnet 5.5, no MCP servers, run from an empty folder), Boston → Reykjavik → Copenhagen:**
    - It asked for flight times rather than guessing them. When I corrected a date, it noticed unprompted that the 3½-day Reykjavik stay passed in 1.5 s.
    - I paused over the night-time city lights and wrote "I love this part with all the city lights. Can you slow it down a bit so it lingers?" It replied, "You were paused partway across the night-time Atlantic on the Boston to Reykjavik flight, so I took that to be the part you meant." It doubled that flight to 11.5 s, set the stop to 5 s, and moved the view to show the change.
    - It published `/w/wy64tsojodij`, verified as revision 2 with BOS–KEF at 11.5 s.
    - Asked for a 15-second Instagram version, it trimmed to 9:16 within the limits. Asked to remove the Reykjavik pause, it passed on the service's warning: "The service gave one warning, which is that the 3-day stay in Reykjavik now passes in 0 seconds. That's what you asked for, so I've left it. You said Reykjavik is your favourite part, so I can bring back a short 2-second pause if you change your mind."
    - The open preview followed revisions 2, 3, and 4 live.
    - Its own session log shows that it fetched the storyboard right after creating the draft. After later saves it relied on the timing in each save response, and it never posted activity.
  - **Codex (GPT-6.1 Terra, its own T3 thread), Toronto → Vancouver → Tokyo:**
    - It asked which Toronto airport (YYZ or YTZ) before creating.
    - I paused over the Pacific and wrote "Can you slow this bit down? I want to savour it." It replied "You're paused halfway across the Pacific, so I'll slow down the Vancouver-to-Tokyo flight" and doubled it to 12.0 s.
    - It published `/w/wz4ibrcthlsm`, verified as revision 2.
    - A later request (square format and a longer Vancouver stop) was applied and checked with the storyboard.
  - **A separate Claude Code process (Haiku 5.5), Madrid → Lima → Cusco:**
    - Its dry run returned `short_screen_time` for the 586 km Lima–Cusco hop. It lengthened that leg and told the creator: "The first validation flagged that the short Lima to Cusco hop would flash by in 2 seconds…"
    - It also checked a 24½-hour gap in Lima with the creator.
    - I paused mid-Atlantic and asked the opposite: "this part drags on a bit, can you speed it up?" It replied "your preview was paused about halfway through Madrid to Lima" and cut that flight from 8 s to 5 s.
    - It published `/w/98rp7c334d6u`, verified as revision 3 with MAD–LIM at 5 s.
  - **Nudge checks.** I created two Chicago → Sydney drafts, opened each preview, and paused mid-flight on SFO → HNL. Each fresh agent was told it had created the draft earlier and got only "Slow down this part a bit, it goes by too fast."
  - **Separate Claude Code session (Sonnet), from its session log:**
    - It re-read the docs and read the draft at 23:12:54. The response contained the nudge ("The creator has the preview open. Before work that will take more than about 10 seconds, POST …/activity…").
    - It saved at 23:13:04 without posting activity, and the page recorder saw no banner. It didn't say why; the read-to-save gap was 10 s.
    - It resolved "this part" from viewer context ("I slowed down the San Francisco → Honolulu flight, which is where you had paused") and doubled it.
  - **Codex Terra, dropped in mid-conversation:** it made no requests at all and asked "Which part would you like me to slow down?" When I answered "The bit I've got paused on my screen right now!", it replied "I can't see where your preview is paused from here."
    - Because it never read the docs or the draft, viewer context couldn't help it. This is the one session where "this part" wasn't resolved.
    - In response, the create response's `next` now tells every agent, at first contact: "Later, if the creator says 'this part' or 'here', GET the draft first: viewer.at says where their preview is paused." It's deployed, and a production create shows it.
  - **Codex Terra again, through the real flow after that fix (Dubai → Cape Town → Johannesburg):**
    - It asked which Johannesburg airport, then created the draft and so received the new hint.
    - I paused at 0:05 and wrote "Can this part go a bit slower? It rushes by." It replied "I'll check where you've paused the preview so I can slow down the right part", read the draft, and said "You've paused during the Dubai-to-Cape Town flight".
    - It slowed that flight from 7 s to 10.1 s, checked the storyboard, and the page received revision 2 live. Read-to-save took 7 s, and it posted no activity.
    - It published `/w/mb81a2ssj4a6`, verified as revision 2 with DXB–CPT at 10.1 s and the creator's times.
  - **The hint, checked on three more fresh agents in parallel.** Each started from the Get Started prompt, created a draft (so it saw the hint), was told "this part" or "this bit" against a paused preview, and published.
    - **Codex Astra (Paris → New York → Los Angeles):** "I'll check where you've paused the preview… You've paused on the New York–Los Angeles flight." The page showed "Your agent is working: Slowing down the New York to Los Angeles flight". Published `/w/bpw6gzz9c4nq`, verified revision 2.
    - **Codex Sol (Seoul → Bangkok → Phuket):** "You're paused near Phuket on the Bangkok–Phuket flight". It doubled that flight from 3 s to 6 s. The page showed "Your agent is working: Slowing the flight to Phuket". Published `/w/9uydihqb1cm6`, verified revision 2.
    - **Separate Claude Code session on Sonnet (Frankfurt → Singapore → Sydney):** "I took 'this part' to mean the Frankfurt to Singapore flight, because your preview was paused near the end of it". It slowed that flight to 10.9 s, and also slowed the second flight so it wouldn't feel rushed, and said so. No activity. Published `/w/16a4e2jiq8zf`, verified revision 2.
    - Since the hint shipped, all four fresh agents resolved "this part" without asking.
- **Activity nudge (earlier runs):** neither of the Terra and Haiku walkthrough agents posted activity. After their first changes, agent reads of a draft with an open preview gained a `next` line suggesting it. Both agents' next changes went straight to a save without reading first, so they never saw the nudge. Each of those turns took about 14 s, and the preview showed each saved change within about a second.
- **Live Codex run, from its thread log:** it read the draft (with viewer context), posted `working`, saved the change, confirmed it with `GET …/storyboard?at=8.2,10.4,12.6`, posted `idle`, and only then replied.
- **A6 notes:** not adopted. See [decisions.md](decisions.md#notes-pinned-to-a-moment-plan-2-a6-not-adopted) and the outcomes in [PLAN-2.md](../PLAN-2.md#outcomes-milestone-10).
- **Activity:**
  - Five of the eleven agents that changed a draft after milestone 9 posted `working` and `idle`: the milestone 9 Claude agent, scripted Codex Sol, and live Codex Astra, plus Codex Astra and Sol again after reading the nudge.
  - Of the five agents that read the nudge, the two Codex agents posted activity. Sonnet (twice) and Terra didn't; they went from read to save in 7–10 s, at or under the nudge's 10-second threshold.
  - Every other change took 7–30 s.
  - The preview showed every saved change within about a second.
  - Explicit activity stays, with the read nudge and no banner derived from traffic; see [PLAN-2.md](../PLAN-2.md#outcomes-milestone-10).
- **Docs, runbook, budgets:** the agent docs cover warnings, storyboards, viewer context, seek, and activity. The runbook has a live-channel section, and the budgets list the new per-request costs.
- **Usage after milestones 8–9:** Route Replay used 152 Worker requests (0.15%) and 56 Durable Object requests (0.06%) in 24 hours, including every smoke run and walkthrough, with no Worker errors.
- **Firefox export (carried over from plan 1), verified.**
  - Firefox wasn't installed, so `npx @puppeteer/browsers install firefox@stable` downloaded a test build (Firefox 160.0) into a scratch folder, with nothing installed system-wide.
  - `scripts/browser/export-check.mjs --browser firefox` ran it headless against the production watch page `/w/gueuppsz7ag5`. WebGL 2 was available and playback advanced from 0:00 to 0:02.
  - The full export finished in 11 s, giving `routereplay-lhr-sin-dps.mp4` at 6.3 MB, which decodes at 720×1280 and 17.5 s. There were no console errors.
  - Remotion browser rendering and export are now verified in all three major engines: Blink, WebKit, and Gecko.
- **Hosting address:** stays on `workers.dev` for now; see [decisions.md](decisions.md#hosting-address-workersdev-for-now).

## Creator-driven Get Started run (production)

On November 11, 2026 the owner pasted the landing page's Get Started prompt into their own agent session (Claude Code). The run went as follows:

1. **Skill and trip.** The agent read `/agent-docs` and offered the `routereplay-web` skill once; the creator declined. It asked for the trip, and the creator gave a two-flight journey with only one departure time.
2. **Clarification.** The agent didn't invent the missing times and asked for them. The creator added that the first flight had left two hours late, and asked the agent to look up the likely connection.
3. **Research.**
   - The agent identified the first flight and its scheduled times.
   - Recent block times gave the delayed flight's likely arrival.
   - It found the likely rebooking onto a later flight after the missed connection.
   - Every offset was resolved with `/api/v1/airports`, including two that had just changed from daylight time.
4. **Draft.** It checked the spec with `/validate`, then created the draft with an idempotency key and a descriptive User-Agent. It saved the full response privately before printing anything. The creator reviewed the preview ("It looks correct").
5. **Publish.** On "Publish", the agent re-read the draft (still revision 1), published that revision, and confirmed the watch link works without credentials.

## Representative phone (real device)

Measured on November 11, 2026 on the owner's iPhone, driven through macOS iPhone Mirroring, against production. The browser was Chrome for iOS 157 (WebKit 605.1.15, iOS 27.3) in a fresh Incognito tab, so the load was cold. Every iOS browser uses Apple's WebKit engine. The figures come from the watch page's `?measure` panel (`src/app/components/MeasurePanel.tsx`), which records them on the device and displays them; nothing is uploaded.

| Measurement | Result |
| --- | --- |
| Device | iPhone, 393×852 at 3×, 4 reported cores, WebGL 2 "Apple GPU", max texture 16384, `VideoEncoder` available |
| Quality chosen automatically | low (`earth-day-low`, `earth-night-low`); unchanged after playback |
| Transfer (cold) | 919 KiB |
| DOMContentLoaded | 326 ms |
| First rendered journey frame | 981 ms after navigation |
| Playback | 29.8 rendered frames/s for a 30 fps composition; playback speed 0.99× real time; main-thread frame interval 17 ms median, 17 ms p95 |
| Export capability | Supported: MP4/H.264; 15-frame probe decoded |
| Full export (20 s, 720×1280, follow camera) | 10.3 s render and encode, 11.1 s including check and probe; 3.1 MB; decodes at the expected size |
| Label legibility | 9:16 follow camera: the `SFO` label is clearly readable. 16:9 globe at phone width (the player is about 390 px wide): the `SYD` label is readable, about the size of the player's time display |

This closes the plan's "representative phone" budget and confirms Remotion's browser rendering and export on real phone hardware.

**One input mistake during setup:** before the mirroring window had focus, a synthetic click was delivered as a long press and put the home screen into edit mode. It was exited immediately with Done. No app or setting was changed.

## Desktop Safari (real browser)

Safari 27.3 (WebKit 605.1.15) on the same Apple M1 Max laptop, opened normally with the production watch page and `?measure`, then read from a screen capture:

| Measurement | Result |
| --- | --- |
| Quality chosen automatically | standard (`earth-day-standard`, `earth-night-standard`) |
| Transfer | 1,806 KiB |
| First journey frame | 943 ms |
| Playback | 29 rendered frames/s; playback speed 0.99× real time; frame interval 17 ms median, 18 ms p95 |
| Export | MP4/H.264, probe decoded; full 20 s 720×1280 export in 8.4 s (9.1 s with check and probe); 6.2 MB; decodes |

Together with Chrome on the laptop and Chrome/WebKit on the iPhone, Remotion browser rendering and export are verified on both target device classes and in both major engines (Blink and WebKit).

## Optional hardening beyond PLAN.md

- **Cloudflare dashboard usage notifications.** The plan asks for usage visibility, which `npm run usage` and Cloudflare analytics provide. Push alerts need dashboard access, because the wrangler token gets "Authentication error" from the alerting API.
- **ChatGPT desktop WebMCP.** The plan asks for one WebMCP walkthrough with a compatible agent; it passed in Chrome's native WebMCP. Supporting ChatGPT's built-in browser would need its own run in that client.
- **Firefox.** Not named in the plan. Its automation did not start in this environment, and Firefox was later no longer installed on this Mac. Open `/w/<id>?measure` in Firefox elsewhere to record it; Remotion lists Firefox 130+ as supported.
