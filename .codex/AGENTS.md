# DumplBot Project Context

## Current Repo Reality

- The repo now has the main runtime surfaces, installer/setup flow, scheduler/workspace UI, and Pi bring-up docs in place.
- Confirm files exist before building commands, tests, or automation around README examples.
- Favor committed code plus docs over older future-facing assumptions.
- The new `docs/` folder is now the stepwise spec set; use it before inventing structure.

## System Model

- `dumpl-ui`: device UI for buttons, audio capture, and the tiny display. The README implies a Python implementation.
- `dumplbotd`: local daemon for API, orchestration, scheduler, and policy.
- `agent-runner`: single-run executor that streams events back to the daemon; bash/tool policy path is real, freeform model-backed replies are still limited.
- Main happy path: button press -> capture audio -> transcribe -> plan and execute -> stream output back.

## Operational Touchpoints

- Install entrypoint: `bash scripts/install_pi.sh`.
- Systemd units: `dumplbotd.service`, `dumpl-ui.service`.
- Config surfaces: `/etc/dumplbot/config.yaml`, `/etc/dumplbot/secrets.env`.
- README dev loop is mixed-runtime: Node.js for daemon-side work, Python for the UI mock loop.

## Engineering Bias

- Optimize for Raspberry Pi Zero 2 WH resource limits first.
- Prefer small dependencies and simple runtime surfaces.
- When debugging user-visible behavior, prefer one end-to-end proof over isolated local fixes.
- When the repo and the README disagree, trust the committed tree, then document the mismatch.

## Project-Local Skills

- Keep project-specific skills under `.codex/skills/<skill-name>/`.
- Keep each skill concise; split dense notes into skill-local `references/` files if needed.
- Current shipped skills: `dumplbot-pi-bringup`, `dumplbot-run-triage`, `dumplbot-workspace-seed`.

## Spec Docs

- `docs/README.md`: read order.
- `docs/SYSTEM_ARCHITECTURE.md`: process split, repo shape, hardware assumptions.
- `docs/API_CONTRACTS.md`: stable endpoint and SSE contracts.
- `docs/IMPLEMENTATION_PLAN.md`: milestone-by-milestone execution order.
