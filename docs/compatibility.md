# Compatibility policy

## Versions pinned in every record

| Field | Meaning | Current |
| --- | --- | --- |
| `schemaVersion` | Authoring contract (`/schemas/scene-v1.json`) | 1 |
| `compatibility.rendererVersion` | Semver of the timeline and scene code | 2.1.0 |
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

Pixel-identical output across GPUs is not promised. The golden states pin what is drawn, not how a GPU rasterizes it.

## Browsers

- The player needs WebGL 2. Without it, pages show the route summary and still allow sharing.
- Export needs WebCodecs `VideoEncoder` and passes a short real-export probe before the full render. Remotion lists Chrome 94+, Firefox 130+, and Safari 26+. Browser version is never used to decide; the probe is.
- WebMCP tools register only when `document.modelContext.registerTool` (current draft) or `navigator.modelContext.registerTool` (early previews) exists.

## Agent-facing changes

`/agent-docs` is rendered from `agent/workflow.md` and `agent/reference.md`; there is no installable copy to drift. Bump `agent/docs.json` `version` whenever the workflow changes meaningfully. Breaking API changes require `/api/v2`; `/api/v1` keeps working for as long as v1 records exist. New response fields (`next`, `warnings`) are additive, and warning thresholds may be tuned without a version change because warnings never block saving.

Storyboards describe what the renderer draws, so the published fixture's storyboard is pinned (`tests/fixtures/publication-v1.storyboard.json`) like its golden states: it changes only with a renderer major.
