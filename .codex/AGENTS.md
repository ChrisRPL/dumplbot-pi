# DumplBot Project Context

## Current Repo Reality

- The repo is still documentation-first. Expected paths from `README.md` such as `apps/ui/`, `scripts/`, `.env.example`, and `workspaces/` are not committed yet.
- Confirm files exist before building commands, tests, or automation around README examples.
- Until code lands, favor docs, scaffolds, tests, and agent instruction assets over speculative implementation.

## System Model

- `dumpl-ui`: device UI for buttons, audio capture, and the tiny display. The README implies a Python implementation.
- `dumplbotd`: local daemon for API, orchestration, scheduler, and policy.
- `agent-runner`: single-run executor that streams events back to the daemon.
- Main happy path: button press -> capture audio -> transcribe -> plan and execute -> stream output back.

## Operational Touchpoints

- Planned install entrypoint: `bash scripts/install_pi.sh` once that file exists.
- Planned systemd units: `dumplbotd.service`, `dumpl-ui.service`.
- Planned config surfaces: `/etc/dumplbot/config.yaml`, `/etc/dumplbot/secrets.env`.
- README dev loop is mixed-runtime: Node.js for daemon-side work, Python for the UI mock loop.

## Engineering Bias

- Optimize for Raspberry Pi Zero 2 WH resource limits first.
- Prefer small dependencies and simple runtime surfaces.
- When debugging user-visible behavior, prefer one end-to-end proof over isolated local fixes.
- When the repo and the README disagree, trust the committed tree, then document the mismatch.

## Project-Local Skills

- Keep project-specific skills under `.codex/skills/<skill-name>/`.
- Keep each skill concise; split dense notes into skill-local `references/` files if needed.
