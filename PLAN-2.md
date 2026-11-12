# Route Replay Web plan 2: the agent feedback loop

Drafted November 11, 2026; revised the same day. **Status: complete.** Milestones 7–10 shipped to production on November 11, 2026; [docs/verification.md](docs/verification.md) records the evidence. The sections below keep the original proposal, with notes where the build differed. It follows [PLAN.md](PLAN.md), whose six milestones are implemented and recorded in [docs/verification.md](docs/verification.md). The service now runs as one Cloudflare Worker at https://routereplay-web.resonantconcepts.workers.dev. Endpoint names, fields, and thresholds below are starting points to validate.

## Scope decisions

- **One path.** Route Replay must work for agents that can't install skills or command-line tools: ChatGPT and Claude on the web, mobile apps, and cloud agents. Every agent therefore gets the same instructions and uses the same plain HTTPS API: the Get Started prompt sends it to `/agent-docs`, and that page is the whole guide. There will be no installable skill, no `npx routereplay` CLI, no local-draft mode, and no second storage backend to maintain. Drafts stay hosted. Plan 1's optional skill is removed in [A4](#a4-the-next-step-in-every-reply-and-no-skill).
- **Minimal complexity, no fallbacks.** This isn't a mission-critical tool. Features target ordinary browsers and networks. Environments such as corporate proxies that block WebSockets aren't accommodated with alternative code paths.
- **Push, not polling.** *Done.* The site moved from Cloudflare Pages to a single Worker with a `SceneLive` Durable Object per draft. Open previews hold one hibernating WebSocket and refetch only when the API reports a change. An idle open preview now costs no requests, instead of 450–1,200 per hour. See [docs/decisions.md](docs/decisions.md#preview-refresh-push-instead-of-polling).

## Why a second plan

Plan 1 proved the core loop: an agent the visitor already uses reads `/agent-docs`, submits a scene spec, revises it, and publishes a watch link. Real agent runs (Claude, Codex, and a creator-driven session) showed where the loop is thin:

- **The agent works blind.** It sees JSON, never the scene. When the creator says "slow down this part," the agent guesses which part.
- **The creator waits blind.** The preview shows nothing while an agent researches or retries.
- **Mistakes that pass validation go unremarked.** One agent noticed a 5 h 15 m Honolulu–Los Angeles time; the service said nothing.
- **The skill added friction for little gain.** An installed copy was out of date within an hour, and nothing told the agent. In the creator-driven run, the offer to install it was the first thing the creator had to answer.

Twombly, another bring-your-own-agent tool, handles several of these well:
- It gives the agent the person's view.
- It shows that an agent is working.
- It separates blocking problems from advisory warnings.
- It puts the next step in every reply.
- Its skill only points at a live guide.
- It returns a screenshot after every change.

This plan adopts the ideas that fit Route Replay's single HTTP path. The live-update socket built for push makes several of them cheap.

## Principles carried forward

- The agent remains the only authoring interface. The page plays, previews, shares, and exports.
- One contract: the scene schema, errors, revisions, and `/api/v1` routes are the only interface agents need.
- `scene = evaluate(normalizedSpec, presentationTime)` stays the only source of what is drawn. Agent-facing views of the scene (storyboards, viewer context) call the same function.
- Agents never run code from Route Replay. Reading documentation and sending JSON over HTTPS is the whole integration.

## A1. Tell the agent what the creator is looking at

The preview already holds the draft's live socket. When the creator pauses, seeks, or resumes, the page sends a small message on that socket:

```json
{"type": "viewer", "t": 7.2, "paused": true}
```

The page sends at most one message every 2 seconds and none during continuous playback. Incoming messages count 20 to 1 against the Durable Object allowance, so this is nearly free. The `SceneLive` object keeps the latest report as that socket's attachment, which survives hibernation and disappears with the socket, so it needs no D1 writes. A scene read with an edit or owner bearer credential asks the object and adds (as built):

```json
"viewer": {
  "open": true,
  "previews": 1,
  "paused": true,
  "at": { "t": 7.2, "phase": "flight", "legId": "ord-sfo", "legProgress": 0.43, "summary": "Flying ORD → SFO, 43% of the way", "…": "the rest of a storyboard keyframe" },
  "reportedSecondsAgo": 4
}
```

- **`open`** is true when at least one preview socket is connected.
- **`at`** is evaluated with the shared timeline code against the current revision, so the agent learns the leg and phase directly. It has the same shape as a storyboard keyframe. While the preview plays, it is extrapolated from the last report.
- **Page reads skip it.** The preview's own refetches don't ask the object, so they cost no Durable Object request.
- **In the docs.** Agents are told to read `viewer` whenever the creator says "this", "here", or "now", and to state what they assumed.

**Showing a moment.** `POST /api/v1/scenes/{id}/viewer {"seek": 7.2}` makes the object send `{"type": "seek", "t": 7.2}` to open previews. Twombly's restraint applies: move the creator's view only when they ask ("show me the layover"), or once at the end of a change to bring it into view. Never move it while working.

**Privacy.** Viewer state exists only on the open preview's socket in the Durable Object. It is visible only to credential holders, never stored in D1 or publications, and gone when the last preview closes. Watch pages never send it.

## A2. Show that an agent is working

```
POST /api/v1/scenes/{id}/activity
{"state": "working", "message": "Checking your connection in San Francisco"}
```

- **What it sets:** `working` or `idle`. Messages are up to 80 characters and are shown as plain text, never HTML.
- **Expiry:** `working` lapses after 3 minutes unless renewed, as in Twombly, so a crashed agent can't leave the banner up.
- **Who may send it:** edit or owner credentials.
- **Delivery:** the API relays it through the draft's Durable Object, `{"type": "activity", …}`, so an open preview shows "Your agent is working: …" instantly without polling.
- **Storage (as built):** the object keeps the latest activity in its own storage, because memory doesn't survive hibernation, and an alarm deletes it when it lapses. Scene reads include it, and a preview that opens mid-activity receives it on connect.
- **Cost:** one Worker request and one Durable Object request per update.

## A3. Advisory warnings

Validation keeps blocking only what is invalid. Successful `validate`, create, and replace responses gain `warnings[]`. Each warning has a `path`, a `code`, a `message`, and a `hint` that suggests a fix, as Twombly's `fix` does. Warnings never block saving. Agents should raise material ones with the creator.

| Code | Trigger (initial threshold) | Catches |
| --- | --- | --- |
| `implausible_speed` | Great-circle distance ÷ block time below 250 or above 1,050 km/h | Wrong date, offset, or airport |
| `long_block_time` | Longer than the longest scheduled nonstops (about 19.5 h) but within the 30 h limit | Arrival on the wrong day |
| `short_screen_time` | A leg on screen less than 2 s | Pacing too fast to read |
| `compressed_connection` | Connection over 24 h with a hold under 1 s | Multi-day stays that flash past |
| `far_future_or_past` | Dates more than 2 years from today | Typos in the year |

The thresholds live beside `LIMITS` in `src/shared/scene/constants.ts`. Check them against a corpus of synthetic itineraries before release.

*Dropped during implementation:* a `label_crowding` warning (two airports labelled at once, within about 3% of the frame). The renderer fades each airport label out before the next fades in, so two labels are never both more than half visible, even with legs at the 1-second minimum. A test pins that property instead. The `implausible_speed` slow bound applies only to flights longer than 3 hours, so short hops with long taxi times pass.

## A4. The next step in every reply, and no skill

- **Next steps.** Every successful response includes `next: string[]`, as Twombly's replies do. For example, after a replace: "Tell the creator the preview has updated. Publish only if they ask." Error responses keep `hint`.
- **Remove the skill.** The Get Started prompt becomes:

  > Help me create a journey in Route Replay. Read {origin}/agent-docs and follow it.

  Remove:
  - the installation section of `/agent-docs` and the skill line in `/llms.txt`
  - the `/skills/` routes, `src/server/zip.ts`, the `SKILL.md` generator, and their tests
  - `/skills/*` from `run_worker_first` in `wrangler.toml` and from the Vite proxy

  `agent/skill.json` becomes a plain docs version, still shown at the top of `/agent-docs`. Copies already installed keep working, because they defer to `/agent-docs` for everything current.
- **No drift detection.** Version headers and a "docs updated" notice were only needed to catch stale installed copies. Without a skill, an agent reads the docs at the start of every session.

The one thing a skill adds is recognizing a Route Replay request in a later session without being given the address. Route Replay is occasional use, and a returning creator can copy the prompt from the site again.

## A5. Let agents check their own work: storyboards

The service can't render images, because there is no GPU in Workers. It can evaluate the timeline:

```
GET  /api/v1/scenes/{id}/storyboard?frames=8
GET  /api/v1/publications/{id}/storyboard?frames=8
POST /api/v1/validate?storyboard=8
```

Each keyframe reports:
- the presentation time and phase
- the leg and its progress
- the physical UTC time and the local times at both ends
- the aircraft's position, and whether it is in daylight (sun elevation at the aircraft)
- the visible labels
- the camera framing (centre latitude and longitude, and approximate view radius in km)

The response also includes `onScreenSeconds` per leg and per stop. A companion `storyboard.svg` draws a plain equirectangular sketch: routes, airports, keyframe markers, and the day/night line at a chosen moment. It is pure geometry, cheap to generate, and gives vision-capable agents a picture to check. The docs tell agents to check the storyboard after every change, the way Twombly tells agents to open the screenshot: passing validation doesn't prove the journey looks right.

## A6. Notes pinned to a moment (decided: not adopted)

Twombly lets people send `@agent` comments that reach the agent on its next command. The Route Replay equivalent would let the creator attach a short note to the current moment in the preview ("the label covers the plane here"). Agents would read it as `notes[]` on the scene, with the evaluated leg and phase.

**Outcome (milestone 10): not adopted.** In the production run, a fresh agent resolved "slow down this part" from viewer context alone, without asking which part, and said what it had assumed. Notes would add a chat-like text field, stored creator text, and another channel for agents to check, all for a problem viewer context already solves. [docs/decisions.md](docs/decisions.md#notes-pinned-to-a-moment-plan-2-a6-not-adopted) records the evidence and when to revisit.

This would close the feedback loop. It also sits close to plan 1's rule against a chat box. Decide after A1–A5 ship, based on whether viewer context alone resolves "this part" requests in real sessions. If adopted, notes would be:
- draft-only
- up to 200 characters each, at most 20 open per draft
- plain text
- never published

## What we will not copy

- **A command-line tool or local drafts.** These would create a second path to maintain, and many agents couldn't use them.
- **An installable skill.** Twombly's skill only points at its live guide. Route Replay's Get Started prompt is the same pointer without an install step, a second path, or copies that go stale.
- **"Always run `@latest`."** Agents never run Route Replay code at all.
- **Live shared canvases with cursors.** Public watch links stay immutable snapshots.
- **Moving the creator's view without consent.** Seeking happens only on request (A1).

## API additions

| Route or field | Access | Part |
| --- | --- | --- |
| `GET /api/v1/scenes/{id}/live` (WebSocket; `changed` events) | Draft credential or session, same origin | *Done* |
| `viewer` socket messages from the page; `viewer` in scene reads | Session (page) / edit or owner bearer | A1 *(done)* |
| `POST /api/v1/scenes/{id}/viewer` (`seek`) | Edit or owner | A1 *(done)* |
| `POST /api/v1/scenes/{id}/activity`; `activity` in scene reads | Edit or owner | A2 *(done)* |
| `warnings[]` on validate, create, and replace | — | A3 *(done)* |
| `next[]` on every success | — | A4 *(done)* |
| `…/storyboard` for scenes and publications; `POST /validate?storyboard=n`; `storyboard.svg` | Draft credential, or public for publications | A5 *(done)* |
| `notes[]` (if A6 is adopted) | Edit or owner | A6 *(not adopted)* |

All additions are backward compatible within `/api/v1`, and existing agents keep working. A4 removes the `/skills/` download paths, which sit outside the API; installed copies of the skill don't use them.

## Delivery sequence

Milestone numbers continue from plan 1.

| Milestone | Deliverable | Completion evidence |
| --- | --- | --- |
| 7. Push updates *(done)* | Single Worker with static assets, `SceneLive` Durable Object, WebSocket preview refresh, Pages redirect | Smoke test receives pushed `changed` events locally and in production; browser check shows a revision appear within about a second with no polling; earlier `pages.dev` links redirect with 308 |
| 8. Agent signals *(done)* | A4 skill removal and `next`, A3 warnings, A5 storyboards (JSON and SVG) | A real agent completes a journey from the shortened prompt with no installation step; unit tests for every warning code and storyboard keyframes; the published fixture's storyboard pinned like its golden states; a real agent mentions a warning to the creator and uses a storyboard to confirm a change |
| 9. Live loop *(done)* | A1 viewer context and seek, A2 activity | A real agent resolves "slow down this part" from viewer context without asking which leg; the activity banner appears and expires; viewer state never reaches D1 or public data |
| 10. Review *(done)* | Decision on A6 notes; updated agent docs, runbook, and budgets | Get Started walkthroughs by agents outside the developer's session; written outcome for A6 |

Ship each milestone to production before starting the next.

## Verification priorities

- Unit tests for warning thresholds, including the false-positive rate on synthetic real-world itineraries: long-haul, date-line, multi-day stays, repeated airports.
- Pinned storyboard keyframes for the published fixture, so storyboards change only with a renderer major version.
- API tests for viewer and activity relays through a fake Durable Object binding, activity expiry, and seek delivery. The smoke test covers the real object.
- Request-budget checks with `npm run usage` after each milestone.
- Real agent walkthroughs over plain HTTP from the shortened Get Started prompt, including at least one by an agent outside the developer's own session.

## Decisions to validate early

1. Does viewer context (A1) resolve "this part" requests well enough that moment-pinned notes (A6) are unnecessary?
2. Which warning thresholds catch real mistakes without nagging?
3. Do agents actually send activity updates (A2) when the docs ask, or is a banner derived from API traffic enough? One option is "the agent read or validated this draft in the last minute."
4. Should the service move from `workers.dev` to a custom domain, and should the Browser Integrity Check that blocks `Python-urllib/*` be relaxed for agent paths there?

### Outcomes (milestone 10)

*The owner confirmed outcomes 1, 3, and 4 on November 11, 2026.*

1. **Yes.** Viewer context resolved "this part" in ten of eleven sessions, without a clarifying question, across three Claude models and three Codex models. One of them was asked to speed a part *up*.
   - The miss was a Terra agent dropped into the middle of a conversation. It never consulted the service and asked which part.
   - The create response's `next` now says to read the draft for `viewer.at` when the creator says "this part". Since then, all four fresh agents tested resolved it: Terra, Astra, Sol, and Sonnet.
   - So A6 notes were not adopted.
2. **Thresholds kept as built:**
   - The 13-itinerary corpus produced no warnings. In the production run, `far_future_or_past` caught a real year typo that the agent did not catch itself.
   - The `implausible_speed` slow bound was narrowed to flights over 3 hours, so short hops pass.
   - `label_crowding` was dropped because the renderer can't produce it.
   - One agent suggested flagging a 44-hour stay shown at the default 1.5 s, and the Codex agent made the same observation. It isn't flagged: the default hold is deliberate, and the storyboard's `connectionMinutes` already let the agents notice the stay and raise it.
   - *Follow-up candidate (outside plan 2):* lengthen the default stop hold for multi-day stays. This would change normalization for new drafts only; published snapshots keep their holds.
3. **Agents use activity for longer work, and quick changes don't need it. Explicit activity stays, with no banner derived from traffic.**
   - Five of eleven agents that changed a draft after milestone 9 posted `working` and `idle` without being told to.
   - Agent reads of a draft with an open preview now carry a `next` line suggesting activity before work longer than about 10 seconds. Of five agents that read it, both Codex agents posted activity. Sonnet (twice) and Terra saved 7–10 s later without it, consistent with that threshold.
   - Every change, with or without the banner, appeared on the open preview within about a second of saving.
   - A traffic-derived banner is the kind of fallback the scope decisions rule out. The 3-minute expiry covers an agent that forgets `idle`. Revisit if creators report not knowing whether their agent is working.
   - Revisit if creators report not knowing whether their agent is working. The fallback would be "the agent read or validated this draft in the last minute".
4. **Stay on `workers.dev` for now.**
   - Across ten agent sessions and two providers, no agent hit error 1010. Every one sent a descriptive User-Agent, as the docs ask.
   - A domain costs money and adds DNS and WAF setup, which current use doesn't justify.
   - Revisit when the site is shared more widely or a 1010 report appears. The runbook lists the WAF skip rule for agent paths, and `PUBLIC_ORIGIN` switches the links. The owner can reverse this at any time; see [docs/decisions.md](docs/decisions.md#hosting-address-workersdev-for-now).

## Relationship to plan 1

Plan 1's contracts, compatibility policy, and credentials model stay as they are, with one exception: plan 1's optional skill and its installation checks are retired (A4). The compatibility rule to bump the skill version on workflow changes becomes a rule to bump the docs version. The deployment changed from Pages to a single Worker without changing the public API. Of the two plan 1 items left open, the walkthrough by an agent outside the developer's session is closed. In milestone 10, six outside-agent walkthroughs completed Get Started, revision, and publishing: four by Codex (one scripted, three live) and two by separate live Claude Code sessions. Firefox export is verified too. Firefox 160 (a Puppeteer-managed test build) played a production watch page and exported a 720×1280, 17.5 s MP4 that decodes, with no console errors.
