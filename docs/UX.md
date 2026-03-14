# UX

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
- Keep workspace and skill selectors short enough that the active entry is obvious at a glance.
- Keep skill summary screens compact but explanatory: permission, reasoning, and integration readiness should fit without entering detail.
- Keep workspace and skill detail views to concise summaries, not raw full-file dumps.
- Keep scheduler history/diagnostics in small paged windows, not one long dump.
- Stream tokens into a scrolling buffer.
- Show short tool banners when a tool runs.
- Add stop/cancel affordance early.

## Push-To-Talk Rules

- Hold starts recording.
- Release stops and saves.
- Long press cancels.
- Errors should return to a recoverable idle state quickly.

## Debug Surfaces

- Keep last transcript visible or reviewable.
- Keep last audio and last error reachable for debugging.
- Add a diagnostics screen after the basic flow works.

## Scheduler Navigation

- Short press should cycle scheduler summary, detail, and history.
- Long press should move to the next job without leaving scheduler mode.
