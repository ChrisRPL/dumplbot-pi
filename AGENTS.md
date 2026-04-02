Read first: [.codex/AGENTS.md](.codex/AGENTS.md)

# DumplBot Pi Agent Guide

## Scope

- Repo = DumplBot, a pocket voice agent and on-device coding assistant for Raspberry Pi Zero 2 WH.
- Current tree includes the main runtime surfaces, installer/setup flow, scheduler/workspace UI, and Pi bring-up docs.
- Treat `docs/` as the source of truth for implementation order; use `README.md` for product intent.
- Treat `docs/` as the implementation source of truth for stepwise build work.

## Product Facts

- Hardware target: Raspberry Pi Zero 2 WH, PiSugar 3, PiSugar Whisplay HAT.
- Runtime surfaces: `dumpl-ui`, `dumplbotd`, `agent-runner`.
- Config files: `/etc/dumplbot/config.yaml`, `/etc/dumplbot/secrets.env`.
- Workspace instructions: `workspaces/<name>/CLAUDE.md`.

## Agent Bias

- Prefer committed code plus docs over older future-facing assumptions.
- Keep Pi constraints visible: low memory, low CPU, no Docker assumptions.
- For runtime work, verify the full path: push-to-talk -> STT -> tools -> streamed reply.
- If a README-mentioned path is missing, do not invent it; note the gap and work from committed files only.

## Project-Local Skills

- Project-specific skill packs live in `.codex/skills/`.
- Read them directly from the repo, or copy proven ones into `$CODEX_HOME/skills` later.
Shipped now:
- `dumplbot-pi-bringup`: Pi install, service bring-up, and field diagnostics.
- `dumplbot-run-triage`: end-to-end run tracing across UI, daemon, and runner.
- `dumplbot-workspace-seed`: workspace scaffolding, policy defaults, and scheduler presets.

## Spec Docs

- Start with `docs/README.md`.
- Lock cross-process work against `docs/SYSTEM_ARCHITECTURE.md` and `docs/API_CONTRACTS.md`.
- Execute in order from `docs/IMPLEMENTATION_PLAN.md`.
