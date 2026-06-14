# Linux Cursor Helper TODO

## Goal

Make Linux autozoom reliable on this machine without building a full Linux recording
library first.

The target is:

- keep the current Electron/PipeWire video recording path for now;
- record accurate cursor position and click telemetry in parallel;
- use that telemetry for `Suggest Zooms from Cursor`;
- only enable cursor styling/editing once the real system cursor can be removed
  or hidden reliably.

## What We Tried

1. Enabled Linux cursor telemetry during recordings.
   - Linux already used `TelemetryRecordingSession`.
   - We changed recording state handling so Linux records cursor telemetry even
     when the system cursor is baked into the video.

2. Improved the existing dwell-based autozoom heuristic.
   - Long cursor pauses are no longer rejected just because they exceed the old
     max dwell length.
   - Light jitter is tolerated.
   - Slow continuous cursor travel is less likely to be treated as a dwell.
   - Added `zoomSuggestionUtils.test.ts` for this logic.

3. Tried to make window-source coordinate mapping better.
   - Added Linux/X11 window bounds lookup attempts through `wmctrl -lG` and
     `xwininfo`.
   - Marked cursor samples outside the selected source as not visible.
   - Later adjusted loading so a recording with samples incorrectly marked
     invisible does not appear as "No cursor telemetry available".

4. Tried enabling the editable cursor path on Linux.
   - Added the Linux cursor mode toggle.
   - Tried `cursor: "never"` for Chromium desktop capture.
   - Allowed Linux telemetry recordings to render OpenScreen's editable cursor
     overlay.

## What Went Wrong

1. Electron cursor telemetry is not reliable enough here.
   - Several `.cursor.json` files had `cx: 0` for nearly the whole recording.
   - Some newer files had movement, but the range was still too small or not
     representative of the actual mouse movement.
   - This means the autozoom suggestion code can be logically correct and still
     zoom to the wrong place.

2. Window coordinate mapping is fragile through Electron source IDs.
   - Linux `desktopCapturer` source IDs do not give a stable, clearly documented
     mapping to X11 window IDs in this app.
   - `xwininfo`/`wmctrl` can help, but matching by ID/title is still best-effort.
   - A bad bounds match caused all samples in one recording to be marked
     `visible: false`.

3. There are no click events in the Linux telemetry path.
   - The existing Linux fallback only samples position.
   - Autozoom based only on dwell/pause detection misses many meaningful user
     actions.
   - This explains why one test only produced two zooms even though the video
     contained more important actions.

4. Editable cursor styling is not currently viable on Linux.
   - Chromium/Electron did not reliably remove the system cursor with
     `cursor: "never"` on this setup.
   - Result: the real cursor stayed in the video and OpenScreen rendered a
     second projected cursor on top.
   - Because the real cursor is baked into the video, post-recording cursor
     styling would create duplicate cursors unless the real cursor is hidden or
     removed first.

5. OpenH264 terminal warnings were not the cause.
   - The warnings are encoder/framerate/bitrate warnings.
   - They do not explain the wrong autozoom locations.

## Current Recommendation

Stop trying to make the Electron-only Linux sampler good enough.

Build a small native Linux/X11 cursor helper first. This is much smaller than a
full recording library and directly targets the missing data:

- accurate cursor position;
- click/button events;
- reliable screen/window coordinate source;
- timestamps aligned to the recording start.

For now, keep the real system cursor in the video and use native telemetry only
for autozoom. Cursor styling should stay disabled on Linux until cursor hiding is
solved.

## Proposed Helper

### Scope

Create a helper similar in spirit to the Windows cursor sampler, but for Linux
X11.

Suggested location:

- `electron/native/linux-cursor-helper/`
- `electron/native-bridge/cursor/recording/linuxNativeCursorRecordingSession.ts`

The helper should output newline-delimited JSON events to stdout.

### Technology

Preferred implementation:

- C or C++;
- X11/Xlib;
- XInput2 for button/motion events;
- XFixes only later, for optional cursor hiding experiments.

Avoid shelling out to `wmctrl`/`xwininfo` for the main telemetry path once the
helper exists. Those tools are okay as diagnostics, but they are too fragile as
the core implementation.

### Helper Responsibilities

1. On startup:
   - accept selected source metadata from Electron:
     - source type: `display` or `window`;
     - source ID/name from Electron;
     - optional target window ID if it can be resolved;
     - recording start timestamp;
     - sample interval fallback, e.g. 16-33 ms.
   - connect to X11 display;
   - locate root window and screen geometry;
   - if recording a window, resolve its absolute bounds through X11 APIs.

2. During recording:
   - emit cursor movement samples:
     - `timeMs`;
     - raw screen `x/y`;
     - normalized `cx/cy` relative to captured source bounds;
     - `visible`;
   - emit click samples:
     - `interactionType: "click"` on ButtonPress;
     - `interactionType: "mouseup"` on ButtonRelease;
     - button number if useful later;
   - keep sampling position even if no motion event arrives, so interpolation
     remains smooth.

3. On stop:
   - flush any buffered events;
   - exit cleanly.

### JSON Event Shape

Example stdout lines:

```json
{"event":"ready","provider":"linux-x11"}
{"event":"sample","timeMs":123,"x":1540,"y":812,"cx":0.62,"cy":0.44,"visible":true,"interactionType":"move"}
{"event":"sample","timeMs":1280,"x":1622,"y":905,"cx":0.68,"cy":0.51,"visible":true,"interactionType":"click","button":1}
{"event":"stopped"}
```

Electron should convert these into the existing `CursorRecordingData` shape:

```ts
{
  version: 2,
  provider: "none",
  samples: CursorRecordingSample[],
  assets: []
}
```

Use `provider: "none"` until we capture actual cursor assets. That lets the
editor use telemetry for zoom without pretending Linux has native cursor sprites.

## Autozoom Algorithm After Helper

Once click telemetry exists, change `Suggest Zooms from Cursor` from dwell-only
to action-based ranking:

1. Prefer clicks.
   - Add zoom candidates centered around click clusters.
   - Merge clicks that happen close together, e.g. within 700-1000 ms.

2. Add dwell candidates as secondary signals.
   - Keep dwell detection, but use it for actions without clicks.
   - Do not let one long pause create duplicate zooms.

3. Filter bad candidates.
   - Ignore invisible samples.
   - Ignore samples outside source bounds.
   - Ignore points too close to the video edge unless the cursor actually clicked
     there.

4. Improve spacing.
   - Current suggestions can underproduce because candidates are rejected when
     they overlap existing reserved spans.
   - Use a maximum suggestion count and minimum spacing, but choose candidates by
     score instead of just dwell duration.

5. Score candidates.
   - Click: high score.
   - Click cluster: higher score.
   - Dwell near active cursor movement: medium score.
   - Long idle at one place: lower score.

## Cursor Styling Plan

Do not expose Linux cursor styling yet.

Cursor styling requires one of these:

1. The recording path truly excludes the system cursor.
   - Electron `cursor: "never"` was not reliable on this setup.

2. A native cursor hiding solution works during recording.
   - Possible X11 experiment: XFixes cursor hiding.
   - Risk: hiding the real cursor globally can be bad UX and may not affect
     all capture paths consistently.

3. A full native Linux recorder captures without cursor and composes the cursor
   separately.
   - This is larger work and should not be the next step unless the helper is
     insufficient.

Until one of those is true, Linux should keep:

- real system cursor in video;
- no editable cursor overlay;
- no cursor style controls;
- cursor telemetry used only for autozoom.

## Implementation Steps

1. Add helper scaffold.
   - `electron/native/linux-cursor-helper/`
   - minimal build script in `scripts/`
   - dev command to compile it locally.

2. Implement X11 position sampling.
   - Query pointer position relative to root window.
   - Normalize against selected display/window bounds.
   - Emit JSON samples at 30-60 Hz.

3. Implement XInput2 click events.
   - Capture ButtonPress/ButtonRelease.
   - Merge into the same sample stream with `interactionType`.

4. Add Electron session class.
   - `LinuxNativeCursorRecordingSession`.
   - Starts/stops helper.
   - Parses stdout JSON.
   - Writes existing `.cursor.json` sidecar.

5. Route Linux through the helper.
   - Update cursor recording factory:
     - `linux` -> `LinuxNativeCursorRecordingSession` when helper exists;
     - fallback -> current `TelemetryRecordingSession`.

6. Add diagnostics.
   - Script to record 10 seconds of cursor telemetry without video.
   - Output summary:
     - sample count;
     - visible count;
     - min/max x/y;
     - click count;
     - source bounds.

7. Update autozoom suggestion.
   - Click-first candidate detector.
   - Dwell as fallback.
   - Tests with synthetic click and dwell fixtures.

8. Manual validation on this machine.
   - Full-screen capture.
   - Window capture.
   - Move cursor across left/right/top/bottom.
   - Perform 5-10 clicks at known UI targets.
   - Verify `.cursor.json` min/max and click count.
   - Verify suggested zooms land on clicked targets.

## Acceptance Criteria

Autozoom can be considered usable when:

- a 20-30 second window recording with 5+ clear clicks produces 4+ sensible zoom
  suggestions;
- suggested zoom centers are visually close to the clicked UI targets;
- full-screen and window captures both produce non-degenerate cursor ranges;
- no duplicate overlay cursor is rendered on Linux;
- no "No cursor telemetry available" message appears when the sidecar exists and
  has samples;
- cursor styling remains hidden on Linux until real cursor removal is solved.

## Known Current State

Current Linux behavior should be:

- system cursor remains in the video;
- cursor telemetry sidecar is written;
- editable cursor overlay is disabled on Linux;
- autozoom may still be unreliable until the native helper replaces the Electron
  sampler.

