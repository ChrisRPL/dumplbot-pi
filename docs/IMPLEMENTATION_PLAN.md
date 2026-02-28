# Implementation Plan

Use this file as the ordered build sequence. Keep code changes aligned with one milestone at a time.

## Milestone 0: Hardware Bring-Up

### Steps

1. Install Whisplay drivers.
2. Verify LCD draw.
3. Verify button input.
4. Verify mic capture and speaker playback.

### Acceptance

- Text draws after reboot.
- Button events register.
- WAV record and replay works reliably.

## Milestone 1: Text-Only End-to-End

### Steps

1. Implement `dumplbotd` `/api/talk` with SSE.
2. Implement `agent-runner` token streaming as JSONL.
3. Implement `dumpl-ui` mock mode for streamed text.
4. Implement minimal Whisplay rendering for status plus text.

### Acceptance

- Typed prompt streams a response to the device display.

## Milestone 2: Push-To-Talk Capture

### Steps

1. Add button state machine.
2. Hold starts record.
3. Release stops record.
4. Long press cancels.
5. Capture via `arecord` to `/tmp/dumplbot/ptt.wav`.
6. Implement Idle, Listening, Saved, and Error states.

### Acceptance

- Press-hold-release produces a clean WAV consistently.

## Milestone 3: Whisper STT And Voice-To-Agent

### Steps

1. Add `/api/audio` upload.
2. Add daemon transcription module.
3. Show UI flow: Listening, Transcribing, Heard, Thinking, Answer.
4. Store last transcript and last audio for debugging.

### Acceptance

- Spoken command transcribes correctly and receives an on-screen answer.

## Milestone 4: Tools, Policy, Sandbox

### Steps

1. Implement skill-based tool allowlists.
2. Add bash allowlist prefixes.
3. Deny network in bash by default.
4. Restrict file access to workspace scope.
5. Add `bwrap` wrapper for `agent-runner`.
6. Add resource caps and systemd hardening.
7. Surface transient tool banners in UI.

### Acceptance

- Agent can work inside a workspace but cannot escape boundaries or use arbitrary shell networking.

## Milestone 5: Workspaces

### Steps

1. Add workspace list, create, and select flows.
2. Persist under `workspaces/<id>/`.
3. Store `CLAUDE.md`, history, and project files there.
4. Add a UI workspace switcher.

### Acceptance

- Active workspace changes agent context correctly.

## Milestone 6: Scheduler

### Steps

1. Start with a simple file-backed store if SQLite would slow Pi bring-up.
2. Add jobs and run-history persistence.
3. Add cron parsing and scheduler loop.
4. Add UI job list and last-result view.
5. Add minimal natural-language to cron conversion for hourly, daily, weekly.

### Acceptance

- Jobs survive reboot and surface results on-device.

## Milestone 7: Skills System

### Steps

1. Define `skills/<skill-id>/skill.yaml` schema.
2. Load prompt prelude, tool allowlist, permission overrides, and optional model settings.
3. Add UI skill selection.
4. Add per-workspace default skill.

### Acceptance

- New skill folders work without code changes.

## Milestone 8: Config UX

### Steps

1. Add LAN-only setup page.
2. Set keys, default workspace, default skill, and safety mode there.
3. Add config export/import.

### Acceptance

- Core device setup can be managed from a phone browser on the same Wi-Fi.

## Phase Order

### Phase A: Make It Work

1. `packages/core`: event types, config schema, skill schema.
2. `apps/host`: `/health`, `/api/talk`.
3. `apps/agent-runner`: stdin JSON in, JSONL out.
4. `apps/ui`: mock plus Whisplay SSE client.

### Phase B: Make It Talk

1. UI button and PTT recorder.
2. Host `/api/audio`.
3. Host Whisper transcription.
4. Glue voice input into `/api/talk`.

### Phase C: Make It Powerful

1. Workspaces CRUD.
2. Skills loader.
3. Policy engine.
4. `bwrap` sandbox plus systemd hardening.
5. Scheduler and job views.

### Phase D: Make It Elegant

1. UI layout engine.
2. Tool banners and stop/cancel.
3. Diagnostics screen.
4. Installer polish.

## Execution Constraints

- Prefer small passes over full vertical rewrites.
- Keep each implementation change scoped to one acceptance check where possible.
- If a milestone depends on missing hardware validation, leave code behind a mock path and document the gap.
