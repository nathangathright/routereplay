# Compatibility policy

## Versions pinned in every record

| Field | Meaning | Current |
| --- | --- | --- |
| `schemaVersion` | Authoring contract (`/schemas/scene-v1.json`) | 1 |
| `compatibility.rendererVersion` | Semver of the timeline and scene code | 2.7.0 |
| `compatibility.assetManifestVersion` | Directory under `/assets/` holding textures and font when the record was saved | 2026-11-12 |
| `compatibility.airportDataVersion` | Airport table used to normalize the record | `2026-11-11.<hash>` |

Normalization happens once, when the agent writes the scene. Published snapshots store the normalized record, so later airport-table or default changes never alter a published journey.

## What the player supports

The player plays a record when its schema version is supported and its renderer major version equals the current one (`src/shared/scene/compat.ts`). Otherwise the watch page explains why and still shows the route summary.

- **Patch and minor renderer changes** (bug fixes, quality improvements) must keep `tests/fixtures/publication-v1.json` passing, including its golden evaluated states (`publication-v1.golden.json`: camera, aircraft, sun, trail, and labels at fixed frames). Visual output may improve, but timing, route facts, and framing intent must not change.
- **A change that alters golden states** (new pacing model, different camera curves) requires a renderer **major** bump. Before releasing it, either keep the previous renderer available for old records, or add a tested migration that re-normalizes old snapshots and explain the change to owners. Do not regenerate golden files to make a failing test pass.
- **Asset updates** go in a new `/assets/<version>/` directory. Pages load the current directory, not the one a record pinned, because the shaders are tuned for the current textures; the pinned version records what the journey was saved with. Old directories stay deployed so a page still running an earlier build keeps finding its files ([assets.md](assets.md#static-assets-publicassets2026-11-12)).
- **Schema v2**, if needed, gets a new schema file, a new fixture, and its own golden states. v1 keeps validating.

Renderer 2.0 (November 2026) replaced the camera presets with the offline renderer's single camera and moved time through the start and end holds (see [decisions.md](decisions.md#one-camera-the-offline-renderers)). It also added weather-model clouds (`environment.weather: "clouds"` with a pinned `environment.cloudRun`), made `legs[].aircraft` (an ICAO type designator) required, and dropped `presentation.camera`, `presentation.aspectRatio`, and `assets.aircraft`. This was a development reset: no outside agents or owners existed yet, so there is no migration. 1.x records show the "can't be played here" page with their route summary, and the fixture and its golden states were regenerated for 2.0. From here on the policy above applies. The ocean-glint water mask joined the existing asset directory because it adds a file and changes none. Its sharper replacements, one per day-texture width, joined it the same way, and so did the terrain relief maps (November 12, 2026). The old mask was deleted rather than kept: with no users yet, no page still runs the build that loaded it.

Renderer 2.1 added train, bus, car, and ferry legs (`legs[].mode` in place of `aircraft`; see [decisions.md](decisions.md#surface-legs-one-marker-for-every-mode)). Journeys with only flights evaluate exactly as before, so the fixture's golden states and storyboard are unchanged. Drawing each mode as its own vehicle ([decisions.md](decisions.md#train-bus-car-and-ferry-models)) changed only the picture and which craft a connection dissolves between, so the renderer version stayed 2.1.0.

Renderer 2.2 (November 12, 2026) draws airport labels and route lines as the offline renderer does ([decisions.md](decisions.md#airport-labels-and-route-lines-the-offline-renderers)). Labels now appear when their airport comes into view, hold a fixed slot until arrival, and recede with the ground, so the golden states' label entries and the storyboard's `labels` changed and both files were regenerated. Nothing else in them changed: camera, aircraft, Sun, trail, and timing are identical, and the fixture record itself was not rewritten. By the rule above this calls for a major version. It was kept minor on purpose: there are no users yet, and a major would make every saved journey unplayable only to keep the old labels. Once there are users, a label change like this one needs the major bump.

Renderer 2.3 (November 13, 2026) draws a control tower at each airport and stops departed labels from growing back ([decisions.md](decisions.md#airport-towers-and-labels-that-stay-gone)). One golden label entry changed (ORD at frame 150 no longer comes back as the camera descends to SFO), so the golden states were regenerated; the storyboard fixture and everything else in the golden states are unchanged. It stays a minor version for the same reason as 2.2.

Renderer 2.4 (November 13, 2026) changes only the picture: airports go back to the ringed dot, the arrival ring is gone, the accent is an electric blue, and the aircraft's shadow softens with height ([decisions.md](decisions.md#no-towers-an-electric-blue-accent-and-shadows-that-soften-with-height)). The golden states and the storyboard fixture are unchanged. `evaluate` no longer returns arrival pulses or marks which labels are airports; neither was in the golden states.

Renderer 2.5 (November 14, 2026) also changes only the picture: one linear composite tone mapped once, with the air's transmittance per colour ([decisions.md](decisions.md#one-linear-composite-tone-mapped-once)); sky light on clouds, cellular billows, and a high cloud layer from GFS ice ([decisions.md](decisions.md#sky-light-on-clouds)); and the aircraft and vehicles lit by the scene's own light, with self-shadows ([decisions.md](decisions.md#the-aircraft-in-the-scenes-own-light)). The golden states and the storyboard fixture are unchanged. Weather steps moved to `/api/v1/weather/gfs-layers/…`, because the old responses are cached as immutable.

Renderer 2.6 (November 15, 2026) makes three changes. It films train, bus, car, and ferry legs like a drone following the vehicle instead of a flight taking off and landing ([decisions.md](decisions.md#surface-legs-filmed-like-a-drone)). The camera stays at the airports' zoom unless the leg is fast, glides over the route smoothed along its length while the vehicle keeps to the route, and the vehicle eases in and out over a fifth of the leg instead of a flight's smootherstep. That changes the pacing and framing of every journey with a surface leg, which by the rule above calls for a major version. It stays minor for the same reason as 2.2: there are no users yet, and a major would make every saved journey unplayable. Journeys with only flights evaluate exactly as before, so the fixture's golden states and storyboard are unchanged; flights in mixed trips are unchanged too. Once there are users, a change like this one needs the major bump.

It also veils an aircraft or vehicle under the cloud deck and lights it like the ground beneath it, and an aircraft's shadow stays off the deck's tops until it breaks out above them ([decisions.md](decisions.md#aircraft-under-the-cloud-deck)). This reverses the earlier rule that planes are always drawn above the clouds. Crossings come from the existing altitude profile, so `evaluate` is unchanged, and the golden states and the storyboard fixture are unchanged.

And it adds hardware tiers and draws exports with several jittered samples per frame where the device has time for them ([decisions.md](decisions.md#hardware-tiers-and-cleaner-exports)). Playback draws exactly as before on phones and laptops, and a phone's export too; an export from a laptop or desktop is antialiased. No tier reaches the timeline: the golden states and the storyboard fixture are unchanged.

Renderer 2.7 (November 17, 2026) pulls each flight back by its own length instead of its share of the trip's longest leg ([decisions.md](decisions.md#flights-pull-back-by-their-own-length)). That changes the camera on every flight that isn't long-haul. In the fixture, Chicago–San Francisco climbs a little higher (its storyboard view radius went from 1,710 to 2,000 km at one keyframe and from 920 to 960 km at another, and one golden camera position moved), so the golden states and the storyboard were regenerated; San Francisco–Auckland, timing, aircraft, Sun, trail, and labels are unchanged, and the fixture record itself was not rewritten. By the rule above this calls for a major version. It stays minor for the same reason as 2.2: there are no users yet, and a major would make every saved journey unplayable.

Pixel-identical output across GPUs is not promised, and since 2.6 neither is it across machines' exports, which may draw different numbers of samples. The golden states pin what is drawn, not how a GPU rasterizes it.

## Browsers

- The player needs WebGL 2. Without it, pages show the route summary and still allow sharing.
- Export needs WebCodecs `VideoEncoder` and passes a short real-export probe before the full render. Remotion lists Chrome 94+, Firefox 130+, and Safari 26+. Browser version is never used to decide; the probe is.
- WebMCP tools register only when `document.modelContext.registerTool` (current draft) or `navigator.modelContext.registerTool` (early previews) exists, and their code loads only then.

## Agent-facing changes

`/agent-docs` is rendered from `agent/workflow.md` and `agent/reference.md`; there is no installable copy to drift. Bump `agent/docs.json` `version` whenever the workflow changes meaningfully. Breaking API changes require `/api/v2`; `/api/v1` keeps working for as long as v1 records exist. New response fields (`next`, `warnings`) are additive, and warning thresholds may be tuned without a version change because warnings never block saving.

Storyboards describe what the renderer draws, so the published fixture's storyboard is pinned (`tests/fixtures/publication-v1.storyboard.json`) like its golden states: it changes only with a renderer major.
