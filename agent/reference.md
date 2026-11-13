## Reference

### Example spec (synthetic)

This example sets optional presentation fields to show their shape. Only `schemaVersion` and `legs` are required.

```json
{{EXAMPLE_JSON}}
```

### Endpoints

| Method and path | Purpose | Credential |
| --- | --- | --- |
| `GET /api/v1/airports/{IATA}?local=YYYY-MM-DDTHH:MM` | Airport name, coordinates, IANA zone; with `local`, the valid offset(s) for that local time | None |
| `POST /api/v1/validate` | Check a spec without saving; `?storyboard=n` adds keyframes | None |
| `POST /api/v1/scenes` | Validate and create a private draft | None (rate-limited) |
| `GET /api/v1/scenes/{id}` | Read spec, normalized record, revision, capabilities, publications, and (while a preview is open) `viewer` and `activity` | Edit or owner |
| `PUT /api/v1/scenes/{id}` | Replace the spec: `{"expectedRevision", "spec"}` | Edit or owner |
| `GET /api/v1/scenes/{id}/revisions` | List retained revisions (last {{REVISIONS_KEPT}}) | Edit or owner |
| `GET /api/v1/scenes/{id}/revisions/{n}` | Read one revision | Edit or owner |
| `POST /api/v1/scenes/{id}/publications` | Publish a revision as an immutable snapshot: `{"revision"}` | Owner |
| `GET /api/v1/scenes/{id}/publications` | List this draft's watch links | Edit or owner |
| `POST /api/v1/scenes/{id}/viewer` | `{"seek": seconds}`: pause open previews at that moment | Edit or owner |
| `POST /api/v1/scenes/{id}/activity` | `{"state": "working", "message"}` or `{"state": "idle"}`: the preview's "Your agent is working" line, lapsing after 3 minutes | Edit or owner |
| `GET /api/v1/scenes/{id}/storyboard` | Keyframes (`?frames=2..24` or `?at=seconds,...`) and screen time per leg and stop | Edit or owner |
| `GET /api/v1/scenes/{id}/storyboard.svg` | Map sketch of the storyboard; `?night=seconds` places the day/night line | Edit or owner |
| `POST /api/v1/scenes/{id}/credentials/edit` | Replace the edit credential; old one and its browser sessions stop working | Owner |
| `DELETE /api/v1/scenes/{id}` | Delete the draft and all its publications | Owner |
| `GET /api/v1/publications/{id}` | Read a published snapshot: `scene` holds its normalized record (there is no `spec`) | None |
| `GET /api/v1/publications/{id}/storyboard` (and `.svg`) | Storyboard of a published snapshot | None |

Send credentials as `Authorization: Bearer <credential>`. Successful responses include `next`, the suggested next steps. Responses include `capabilities` so you can see what the current credential allows. Ordinary reads never return credentials. `GET /api/v1/scenes/{id}` supports `If-None-Match` with its `ETag`.

### Spec rules

- `schemaVersion` is `1`. Unknown fields are errors.
- 1–{{MAX_LEGS}} legs. Each leg: `id`, `from`, `to`, `departure`, `arrival`, and exactly one of `aircraft` (a flight) or `mode` (a leg on the ground or water).
- `aircraft` is an ICAO type designator. Supported: {{AIRCRAFT_LIST}}. A connection between legs flown by different types dissolves from one aircraft to the next while the aircraft waits.
- `mode` is one of {{SURFACE_MODES}}. Each mode is drawn as its own vehicle moving along the ground: a short train, a coach, a car, or a ferry with a wake. At a connection the aircraft dissolves into it, and one mode dissolves into the next (two legs with the same mode keep the same vehicle). When the journey is saved (create or replace, not `/validate`), the leg is traced along OpenStreetMap's railways for `train`, roads for `bus` and `car`, and ferry lines for `ferry`, from the airport nearest one station to the airport nearest the other, and `normalized.legs[].path` holds the route. A later save keeps it while the leg's mode and airports stay the same. If no route is found, the leg is drawn as a straight line with a `route_not_found` warning. The mode names the leg in the route summary and storyboards. `from` and `to` are the IATA codes of the airports nearest the stations or terminals (a few kilometres apart is invisible at the scene's scale). Choose the closest mode for others: a tram or metro is `train`, a coach is `bus`, any boat is `ferry`.
- Legs are connected (each departs where the previous arrived) and do not overlap in time. Repeated airports are fine.
- Timestamps are ISO 8601 with the airport's local offset at that instant. `Z` is accepted only where the local offset is zero. Times are converted to UTC by the service.
- Flight time per leg: {{MIN_FLIGHT_MINUTES}} minutes to {{MAX_FLIGHT_HOURS}} hours. Surface legs: {{MIN_FLIGHT_MINUTES}} minutes to {{MAX_SURFACE_DAYS}} days. Whole journey: at most {{MAX_JOURNEY_DAYS}} days.
- `presentation.durationSeconds`: {{MIN_DURATION}}–{{MAX_DURATION}}. After start, stop, and end holds are subtracted, each flight needs at least {{MIN_LEG_SECONDS}} s.
- `presentation.legWeights` values {{MIN_WEIGHT}}–{{MAX_WEIGHT}}. Unlisted surface legs default to at least {{MIN_SURFACE_WEIGHT}}, so a short crossing stays on screen beside long flights. `stopHolds` values 0–{{MAX_STOP_HOLD}} s keyed by the arriving leg's id; start and end holds 0–{{MAX_END_HOLD}} s.
- `title` (optional): up to {{MAX_TITLE}} characters. It names the page and shared links, and is never drawn in the scene.
- `environment.weather`: `clouds` (default) draws cloud cover from NOAA's GFS weather model at the journey's times: the model's analysis for past times and its forecast for upcoming ones. They are model clouds, not satellite photos. Each save pins the latest model run, so save again closer to an upcoming trip for a fresher forecast. Model data covers 22 March 2021 to 16 days ahead; outside that, no clouds are drawn. `omitted` draws no clouds. `assets.style`: `standard`.
- Request bodies are limited to {{MAX_PAYLOAD_KIB}} KiB.

The service returns `normalized`: resolved airports (name, coordinates, IANA time zone), UTC times, distances, per-leg presentation seconds, defaults, a seed, and pinned renderer, asset, and airport-data versions. Read it to confirm the service understood the itinerary. Never send `normalized` back; edit `spec`.

### Warnings

Warnings never block saving. Each has `path` (where a fix would go in the spec), `code`, `message`, and `hint`.

| Code | When | Usually means |
| --- | --- | --- |
| `implausible_speed` | Average speed (great-circle distance ÷ block time) over {{WARN_MAX_KMH}} km/h, or under {{WARN_MIN_KMH}} km/h on a flight longer than {{WARN_SLOW_HOURS}} hours. Surface legs: over {{WARN_SURFACE_MAX_KMH}} km/h, or under {{WARN_SURFACE_MIN_KMH}} km/h on a leg longer than {{WARN_SURFACE_SLOW_HOURS}} hours | A wrong date, time, or airport |
| `long_block_time` | A flight longer than {{WARN_LONG_HOURS}} hours (validation allows up to {{MAX_FLIGHT_HOURS}}); never raised for surface legs | Arrival on the wrong day, or a stop that should be its own leg |
| `short_screen_time` | A flight on screen for less than {{WARN_SCREEN_SECONDS}} s | Too fast to follow |
| `compressed_connection` | A stop runs faster than {{WARN_LAYOVER_RATE}} real hours per second on screen | Day and night flash past; lengthen the stop, or set it to 0 to cut |
| `far_future_or_past` | The journey starts more than {{WARN_YEARS}} years from today | A typo in the year |
| `route_not_found` | A train, bus, car, or ferry leg has no matching railway, road, or ferry line in OpenStreetMap between its airports, so it is drawn straight | A wrong mode or airport; or a line OpenStreetMap lacks, which needs no fix |
| `route_unavailable` | The route lookup service didn't answer when the journey was saved; the leg is drawn straight for now | Nothing to fix; save again later to retry |
| `no_cloud_data` | Clouds are on, but part of the journey is before 22 March 2021 or more than 16 days after the save (not raised with `far_future_or_past`) | Nothing to fix; that part is drawn without clouds |

### Errors

Every error is JSON: `{"error": {"code", "message", "hint"?, ...}}`.

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_json`, `invalid_body`, `expected_revision_required`, `revision_required`, `invalid_idempotency_key`, `invalid_query` | Malformed request |
| 401 | `credential_required`, `session_expired` | Missing or expired credential |
| 403 | `owner_required`, `csrf_rejected` | Credential cannot do this |
| 404 | `not_found`, `publication_not_found`, `revision_not_found` | Unknown id, or credential does not match |
| 409 | `revision_conflict` | Draft changed; body has `currentRevision`, `spec`, `normalized` |
| 409 | `request_in_progress` | Same Idempotency-Key still running; retry shortly |
| 410 | `publication_deleted` | Owner deleted the journey |
| 413 | `payload_too_large` | Body over the size limit |
| 415 | `unsupported_media_type` | Use `Content-Type: application/json` |
| 422 | `validation_failed` | `issues[]` with `path`, `code`, `message`, `hint` |
| 422 | `idempotency_key_reused` | Same key, different body |
| 429 | `rate_limited` | Wait `retryAfterSeconds` (also in `Retry-After`) |
| 501 | `live_unavailable` | This server has no live channel; viewer and activity features are off |
| 403 (plain text `error code: 1010`) | — | Blocked by the hosting network's browser-signature check before reaching Route Replay. Set a descriptive `User-Agent` header and retry |

Validation issue codes include `unknown_field`, `required`, `type`, `unsupported_version`, `unsupported_preset`, `unsupported_aircraft`, `unsupported_mode`, `conflicting_fields`, `pattern`, `out_of_range`, `timestamp_format`, `invalid_date`, `offset_mismatch`, `unknown_airport`, `same_airport`, `antipodal_route`, `arrival_not_after_departure`, `flight_duration`, `disconnected_legs`, `overlapping_legs`, `duplicate_leg_id`, `unknown_leg_reference`, `hold_on_final_leg`, `journey_too_long`, and `duration_budget`.

### Limits and retention

- Creation is rate-limited per client and globally; writes are rate-limited per draft. Back off on `429`.
- Idempotency keys are remembered for 24 hours, scoped to the operation (and the draft, for publishing).
- Drafts are deleted after {{DRAFT_RETENTION_DAYS}} days without changes. Published watch links stay until the owner deletes the draft.
- There are no accounts. Whoever holds the owner credential controls the draft. If it is lost, the draft cannot be published or deleted, and Route Replay cannot recover it.

### Privacy

Specs must not contain personal data beyond the journey itself. Route Replay stores the spec and its derived record, never your conversation or the creator's documents. Credentials are stored only as hashes. When a journey with train, bus, car, or ferry legs is saved, Route Replay's server sends the coordinates of each such leg's two airports, and whether to follow railways, roads, or ferry lines, to the routing services that trace it: BRouter (brouter.de) for trains, and OSRM at routing.openstreetmap.de (run by FOSSGIS) for buses, cars, and ferries. Nothing else from the journey goes with them: no times, title, other legs, or credentials. Routes are cached and shared between journeys, so a leg already traced for anyone isn't sent again. Video export runs entirely in the viewer's browser and uploads nothing; the bundled Remotion renderer reports only the site's origin and whether a render succeeded to Remotion's license service. Pages load Cloudflare Web Analytics, which counts page views and measures load times without cookies. It reports each page's address without its query or fragment, so the credential in a private link is never sent.
