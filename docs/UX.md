# UX

Read with: `VISUAL_DESIGN.md` when changing the actual screen composition or visual hierarchy.

Design for the tiny screen first. Fast feedback beats density.

## Core States

- Idle
- Listening
- Transcribing
- Thinking
- Tool
- Answer
- Saved
- Error

## State Priorities

- Input capture feedback must appear immediately.
- Transitions should be explicit; never leave the user guessing whether the button press registered.
- UI should remain responsive even when network or agent work is slow.

## Screen Rules

- Keep a stable status bar for battery, Wi-Fi, and time.
- Use wrapped text with predictable paging.
- Keep desktop preview mode faithful to the real panel aspect ratio; scale up, do not redesign.
- Keep the home screen compact: current workspace, current skill, scheduler count, and setup readiness should fit in one glance.
- Keep first-run home states explicit: top badge `READY` or `SETUP`, never ambiguous.
- When setup is incomplete, home should show one next action only, not a checklist dump.
- Missing key and missing audio should read like plain-language recovery steps, not backend status codes.
- Keep workspace and skill selectors short enough that the active entry is obvious at a glance.
- Keep skill summary screens compact but explanatory: permission, reasoning, and integration readiness should fit without entering detail.
- Keep workspace and skill detail views to concise summaries, not raw full-file dumps.
- Keep scheduler history/diagnostics in small paged windows, not one long dump.
- Stream tokens into a scrolling buffer.
- Show short tool banners when a tool runs.
- Add stop/cancel affordance early.
- During an active run, long press should request cancel on the same button path used for capture/navigation.

## Push-To-Talk Rules

- Hold starts recording.
- Release stops and saves.
- Long press cancels.
- While the user is holding toward cancel, show visible progress instead of a static hint only.
- After release starts the remote run, a new long press should request run cancel until the stream finishes.
- Errors should return to a recoverable idle state quickly.

## Debug Surfaces

- Add a dedicated diagnostics screen for bind, daemon, scheduler, and STT readiness.
- Keep last transcript visible or reviewable.
- Keep last audio and last error reachable for debugging.
- Keep transcript/audio debug screens consistent between mock mode, desktop preview, and device renderer.
- Keep one compact voice-debug summary screen for field triage.
- Keep one seedable debug preset path on desktop preview so layout checks do not depend on manual API poking.
- Keep debug preview snapshots on the same raster path as the live Whisplay preview.
- Keep preview gallery output bundled as home/transcript/audio/error/voice-debug PNGs.
- Add a diagnostics screen after the basic flow works.

## Home Navigation

- Home screen should show the next target clearly before the user enters it.
- On first boot, the same home screen should show whether the next action is `voice`, `add key`, or `check audio`.
- Short press on home should cycle workspace, skill, scheduler, diagnostics, voice, transcript, audio, and error targets.
- Long press on home should enter the focused target view.
- From a focused top-level view, one press should get the user back home quickly.
- From the focused voice-debug bundle view, long press should clear debug state in place.

## Scheduler Navigation

- Short press should cycle scheduler summary, detail, and history.
- Long press should move to the next job without leaving scheduler mode.
