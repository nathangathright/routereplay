# Flight motion and moments

These optional controls keep the centered aircraft and north-up globe. They do not require an account, server or remote media library. Older trip files retain level aircraft, classic pacing and no media cards.

## Modeled aircraft attitude

```json
"attitude": {"enabled": true, "strength": 1, "max_bank_deg": 25, "max_pitch_deg": 12}
```

`--aircraft-motion` enables this for `plan`, `preview`, `render`, `budget` or `import-track`; `--no-aircraft-motion` disables it. Import saves the option in its new trip file. Other commands leave the input unchanged.

Cycles aircraft bank into route turns and pitch with climb/descent. These are modeled poses, not measured roll or pitch from an onboard attitude sensor. Computation uses physical seconds and local route curvature; shortening the movie does not strengthen a turn. A great-circle heading changing with longitude does not itself cause a bank. Recorded tracks use a weighted local curve fit whose support depends on physical flight duration and reliable observation spacing, never video length or frame rate. It suppresses waypoint scatter and intentionally attenuates maneuvers shorter than that support. Holds, stationary observations and missing track intervals return to level, with a smooth boundary fade. The aircraft's ground contact and depth are evaluated after rotation, so its wings remain above the modeled ground. Sun and Moon shadows follow the same pose.

`strength` ranges from 0 to 3. Bank and pitch caps range from 0 to 45 and 0 to 25 degrees respectively. Default caps are 25 and 12. The 2D diagram remains level and cannot demonstrate this feature. Frame contexts and aircraft cache files record the modeled angles and their basis.

## Highlights pacing

Add `"pacing": "highlights"` inside `video`, or pass `--pacing highlights`. `classic` preserves the previous smootherstep curve.

Highlights gives additional presentation time to usable recorded climb, descent and turn cues. A flight without a usable track receives an explicitly illustrative endpoint emphasis. Gaps are not treated as detected phases. The mapping stays smooth and monotonic, without changing a leg's video interval, the total duration, or any departure, arrival or layover hold. It does not cut observations out of the flight.

The physical clock drives position, sunlight, Moon, telemetry and aircraft pose. Weather retains its separate documented endpoint-hold extension. `plan` reports the pacing cues and their basis; it does not claim to detect runway contact or an exact operational flight phase.

## Local photo and video moments

Add a top-level list, using the actual UTC instant on a flight:

```json
"moments": [
  {"flight": 1, "time": "2030-06-01T16:00:00Z", "path": "media/window.jpg", "duration_s": 2},
  {"flight": 1, "time": "2030-06-01T19:30:00Z", "path": "media/landing.mov", "start_s": 3, "duration_s": 2}
]
```

`flight` is one-based. `time` must include an explicit UTC offset and lie between that flight's departure and arrival. It sets the card's start; `duration_s` is presentation time, from 0.8 to 15 seconds, default 2. An arrival instant starts a card at the beginning of the arrival hold. Extend the hold if necessary. Overlapping cards and events extending past the video are rejected. Changing pacing repositions each card by its physical timestamp and rechecks overlap.

Paths resolve relative to the original trip JSON, then become absolute in the local render snapshot. `import-track` writes media paths relative to its new output file so the trip and media can move together. References between different Windows drive letters remain absolute. Supported stills are single-frame JPEG, PNG and WebP, prepared as 8-bit RGBA cards; videos are SDR MP4 and MOV with one ordinary video stream. Pillow safely reduces some 16-bit RGB(A) and grayscale-with-alpha PNGs to 8 bits during decoding. Grayscale images that remain high-depth after decoding are rejected to avoid clipping; export them as 8-bit sRGB first. An embedded color profile must be compatible with the decoded sample color space; palette and grayscale images carrying an RGB profile are expanded before conversion. Other unsupported profile/mode combinations require an sRGB export. HDR PQ/HLG clips require an SDR export first; they are rejected rather than converted with an unspecified tone curve. `kind` is inferred from the extension unless explicitly supplied. `start_s` selects a source-video offset and is invalid for photos. The complete requested clip must fit the source; it is never silently shortened. Clips play at normal presentation speed, without audio.

Cards fit beneath the centered aircraft and below telemetry. A contained image preserves the whole source, including portrait photos; EXIF orientation is honored. The restrained entrance and exit last up to 0.4 seconds. There are no automatic captions. Media cards can overlap geographically placed airport labels, so inspect selected frames before export.

Preparation checks and hashes local source files, decodes only the selected frames, removes source metadata from prepared PNGs, and records decoder versions. The compositor does no video decoding or network access. A changed source creates a new render cache. Keep inputs stable during a render; changing a file during preparation stops with an error.

Limits: 64 moments, 512 MiB per input, 40 megapixels per still, videos up to 4096×4096, one hour and 240 fps, and 30,000 selected media frames per preparation. Planning validates the event structure without reading media; rendering additionally verifies file contents, duration and decoder support. No media is included in the shareable skill export.

`Trip.presentation_time(instant, flight_index)` provides the inverse flight-clock mapping for integrations; its Python flight index is zero-based. The plan includes each card's presentation start and end. `media-moments.json` records input identity and prepared frame hashes alongside normal render provenance.
