## Workflow

Route Replay turns a travel itinerary (flights, and any train, bus, car, or ferry legs between them) into an animated journey on a 3D Earth. You (the agent) research and clarify the itinerary with the creator, then submit a small JSON scene spec over HTTPS. Route Replay validates it, stores a private draft, and shows it in a live browser preview. You do the authoring; the page only plays, shares, and exports.

Every successful response includes `next`: a short list of suggested next steps. Follow it unless the creator asked for something else.

You need to be able to make HTTP requests with custom headers and JSON bodies (for example with `curl` or a fetch tool). Reading URLs alone is not enough. Send a descriptive `User-Agent` such as `my-agent/1.0`; the hosting network rejects some library defaults (for example Python's `Python-urllib`) with a plain-text `error code: 1010`. If you cannot make authorized POST and PUT requests, tell the creator plainly instead of pretending to create the journey.

### 1. Gather the itinerary

- Collect each flight in order: departure airport, arrival airport, and local departure and arrival times with dates.
- Use 3-letter IATA airport codes (`ORD`, not `KORD` or the city code `CHI`).
- Find the aircraft type for every flight; the scene draws it. Give its 4-character ICAO type designator, such as `B38M` (Boeing 737 MAX 8) or `A21N` (Airbus A321neo), not the 3-character IATA code many booking sites show (`7M8`, `32Q`). For a past flight, flight-history sites list the type that flew; for an upcoming one, use the airline's schedule or the creator's booking, and tell the creator that airlines sometimes swap aircraft. If the type isn't in the supported list (Reference section), choose the closest listed type and say so.
- Travel on the ground or water between flights (a train, bus, car, or ferry) is a leg too, with `mode` in place of `aircraft`, so the journey stays connected. For its `from` and `to`, use the IATA code of the airport nearest each station or terminal (Wellington's ferry terminal is `WLG`). Split a multi-day trip at its overnight stops: the night there shows, and the route is traced through the place the creator stopped rather than the fastest way. When you save, Route Replay traces each such leg along the railway, road, or ferry line; the scene draws a train, coach, car, or ferry moving along that route.
- Write every time with the airport's local UTC offset at that moment, including daylight saving time: `2031-07-05T10:00:00-05:00` in Chicago in July, `-06:00` in January.
- Clocks can change during a trip, even overnight on a flight. Check each timestamp's offset separately. If you have no time-zone database, `GET {{ORIGIN}}/api/v1/airports/{IATA}?local=2031-03-30T06:40` returns the airport, its IANA zone, and the exact offset (or both offsets, or none) for that local time.
- Flights over the date line often arrive on a different calendar day. Check that arrival is after departure in UTC.
- Ask the creator only about material ambiguity: a missing or unclear time or date, a city with several airports, or a gap between flights that suggests a missing leg (a flight, or travel on the ground). Do not invent times. Where the creator has a booking, prefer its scheduled times.
- Leave out passenger names, booking references, ticket numbers, seat numbers, prices, and sources. The scene contains only what is needed to draw the journey.

### 2. Build the spec

Start from the example in the Reference section of {{ORIGIN}}/agent-docs and the field descriptions in {{ORIGIN}}/schemas/scene-v1.json. The example sets several optional fields only to show their shape. Use stable lowercase leg ids such as `ord-sfo`. Omit optional presentation fields unless the creator asked for something specific; defaults adapt when legs change. A short, generic `title` (such as "Boston to Madeira") is recommended; it names the page and shared links, and is never drawn in the scene. Scenes have no frame shape: the player fills any screen, and viewers pick 16:9, 1:1, or 9:16 when they export a video.

Sensible choices:

- The camera is not configurable: it looks straight down at the aircraft, north up, close in at airports and pulling back toward the middle of each flight (furthest on the trip's longest leg). Time runs on through the start and end holds, from 20 minutes before departure to 20 minutes after arrival.
- Long connections are animated in a short stop; set `presentation.stopHolds` to give a connection more or less time, or `0` to cut straight to the next departure.
- Pacing: `normalized.legs[].flightSeconds` shows how long each flight is on screen. Flight time is the total duration minus all holds, shared between legs by weight. Default weights grow with distance and average 1; a leg you don't list in `legWeights` keeps its default. Raising one leg's weight alone takes time from the others, and raising `durationSeconds` alone slows every leg. To slow just one leg without changing the others, add the extra seconds to `durationSeconds`, then set that leg's weight to its current `normalized.legs[].weight` × new seconds ÷ current `flightSeconds`, and list every other leg in `legWeights` at its current `normalized` weight. Example: a leg with weight 1.39 showing 7 s should show 14 s: add 7 to `durationSeconds` and set its weight to 1.39 × 14 ÷ 7 = 2.78. `durationSeconds` may be fractional. Once it is set, the length no longer adapts when legs change, so adjust it yourself if you later add or remove legs. Dry-run with `/api/v1/validate` to see the resulting `flightSeconds` before saving.
- If `durationSeconds` is omitted, the length is the start, end, and stop holds plus 6 seconds per leg, capped at 120. It changes when you add legs or holds.

If you are unsure whether a spec is valid, `POST {{ORIGIN}}/api/v1/validate` checks it without saving anything.

### 3. Create the draft

```
POST {{ORIGIN}}/api/v1/scenes
Content-Type: application/json
Idempotency-Key: <new random UUID>

<scene spec JSON>
```

The `201` response contains `id`, `revision`, `previewUrl`, and `credentials.edit` / `credentials.owner`. Credentials are shown only once. Capture the whole response before printing or redacting anything, and keep the credentials in this conversation's working state. If you lose them within 24 hours, repeating the identical request with the same `Idempotency-Key` returns the original response, credentials included.

- Give the creator `previewUrl`. Opening it shows the journey (on desktop or phone) and refreshes automatically when you revise it. Its credential, after the `#`, allows editing, so the creator should share it only with people who may edit.
- Keep `credentials.owner` private. It is needed to publish, delete, or rotate the edit credential. Give it to the creator in your private conversation and suggest they keep it somewhere safe, such as a password manager, so they can manage the journey after this conversation ends; there are no accounts and it cannot be recovered.
- Never put either credential in a public place. If you must keep credentials between sessions, store them only where the creator approves, never in a repository or anything shared.
- If the request fails with a network error, retry with the same `Idempotency-Key` and the same body; you will not create a duplicate.
- The `#k=` part of `previewUrl` is the edit credential. The page moves it into a private browser session and removes it from the address bar. For a link that can only watch, publish (step 7).

### 4. Repair validation errors

A `422 validation_failed` response lists `issues`, each with a JSON Pointer `path`, a `code`, a `message`, and often a `hint` with a concrete fix. Nothing is saved. Apply the fixes and resubmit. If an issue reflects a real ambiguity, such as an unknown airport or a time that does not exist, ask the creator rather than guessing. Stop and explain after a few failed attempts.

### 5. Check your work

Passing validation does not prove the journey looks right.

- **Warnings.** Successful validate, create, and replace responses include `warnings[]`: likely mistakes that were still accepted, such as an average speed no airliner flies (often a wrong date) or a multi-day stay that flashes past. Each has `path`, `code`, `message`, and `hint`; the Reference section lists the codes. Raise material ones with the creator in plain words, for example "The SFO–ORD flight comes out at 28 hours. Did it land on the 7th?" Don't change the creator's itinerary just to silence a warning, and don't repeat one they have confirmed.
- **Storyboard.** After creating or revising, `GET {{ORIGIN}}/api/v1/scenes/{id}/storyboard` with the credential. Its keyframes describe what the animation shows at evenly spaced moments (`?frames=` from 2 to 24, default 8) or at moments you choose (`?at=7.2,12`): the phase, leg and progress, a plain summary, the UTC and local times being shown, whether the aircraft is in daylight, the airport labels on screen, and where the camera is centred and how far it sees. `onScreenSeconds` lists how long each leg and stop lasts. Compare it with what the creator asked for: that a slowed leg gained seconds, or that an overnight flight crosses the dark side.
- **Picture.** If you can view images, `{{ORIGIN}}/api/v1/scenes/{id}/storyboard.svg` sketches the routes, airports, and numbered keyframe markers on a plain map, with night shading at `?night=<seconds>` (default 0).
- **Before saving.** `POST {{ORIGIN}}/api/v1/validate?storyboard=8` adds a storyboard to a dry run.

### 6. Revise

When the creator asks for a change ("slow down the Pacific leg", "make it vertical", "the second flight left at 9:40"). If they point at the preview ("slow down this part"), see "What the creator is looking at" below:

1. `GET {{ORIGIN}}/api/v1/scenes/{id}` with `Authorization: Bearer <edit or owner credential>`.
2. Change the returned `spec` (not `normalized`), keeping leg ids stable.
3. `PUT {{ORIGIN}}/api/v1/scenes/{id}` with body `{"expectedRevision": <revision you read>, "spec": <changed spec>}`.

A `409 revision_conflict` means the draft changed since you read it (perhaps the creator used another agent). The response includes the current spec. Reapply your intended change to it and retry with the current revision; do not blindly overwrite. An open preview shows each new revision immediately. Check the response's `warnings` and the storyboard (step 5) before telling the creator it's done.

To undo, list `GET /api/v1/scenes/{id}/revisions`, fetch an earlier revision, and PUT its `spec` as a new revision.

### What the creator is looking at

While the creator has the preview open, reading the draft with your credential (`GET {{ORIGIN}}/api/v1/scenes/{id}`) also returns:

- `viewer.open`: whether a preview is open. Once the creator pauses or moves the playhead, `viewer.paused` and `viewer.at` describe the moment they are looking at, in the same form as a storyboard keyframe (`t`, `phase`, `legId`, `legProgress`, `summary`, local times). While it plays, `at` is an estimate.
- `activity`: whether the preview currently shows that you are working.

When the creator says "this part", "here", or "now", read the draft and use `viewer.at`. Say what you assumed ("I'll slow down the Pacific crossing, where you paused"). If no preview is open or it is playing, ask which part they mean. A paused position stays accurate however long ago it was reported (`reportedSecondsAgo`), because the preview reports again whenever the creator moves. `viewer.revision` appears only while the preview is still showing an older revision, typically for a second after you save.

**Showing a moment.** `POST {{ORIGIN}}/api/v1/scenes/{id}/viewer` with `{"seek": <seconds>}` pauses open previews at that moment; storyboard keyframes give the times. Move the creator's view only when they ask ("show me the layover"), or once at the end of a change to bring it into view. Never move it while you work.

**Showing that you are working.** Before work that will take you more than about 10 seconds in all, such as researching flights or a read–check–save sequence, `POST {{ORIGIN}}/api/v1/scenes/{id}/activity` with `{"state": "working", "message": "Checking your connection in San Francisco"}`. The message is plain text, up to 80 characters. Open previews show "Your agent is working: …" until you send `{"state": "idle"}`, or for 3 minutes unless you send it again.

Viewer state is never stored or published. It exists only while a preview is open.

### 7. Share

Publish only when the creator asks to share:

```
POST {{ORIGIN}}/api/v1/scenes/{id}/publications
Authorization: Bearer <owner credential>
Content-Type: application/json
Idempotency-Key: <new random UUID>

{"revision": <the revision the creator approved>}
```

Give the creator the returned `watchUrl`. Anyone can watch it without an account or credentials. It is an immutable snapshot: later edits do not change it, and publishing again creates a new link. Published data contains the journey and presentation only.

### 8. Delete

When the creator asks, `DELETE {{ORIGIN}}/api/v1/scenes/{id}` with the owner credential removes the draft, its revisions, and all its watch links. Explain that this cannot be undone.

### Browser tools (optional)

When the creator has the preview open in a browser that supports WebMCP, the page offers tools: `get_scene`, `set_scene`, `seek_scene`, and (with owner access) `publish_scene`. They use the same validation and revisions as the HTTP API. Use `seek_scene` to inspect a specific moment. The HTTP API works without them.

### Video export

The page has an Export button. On browsers that support it, the creator can save a 720p MP4 locally. Export runs on their device, may take longer than the clip's length, and is not required for sharing.
