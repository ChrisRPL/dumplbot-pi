Read first: [.codex/AGENTS.md](.codex/AGENTS.md)

# DumplBot Pi Agent Guide

## Scope

- Repo = DumplBot, a pocket voice agent and on-device coding assistant for Raspberry Pi Zero 2 WH.
- Current tree is planning-stage only: `README.md`, `LICENSE`, `dumpl_banner.png`, git metadata.
- Treat `README.md` as the current source of truth until app code lands.

## Product Facts

- Hardware target: Raspberry Pi Zero 2 WH, PiSugar 3, PiSugar Whisplay HAT.
- Planned runtime surfaces: `dumpl-ui`, `dumplbotd`, `agent-runner`.
- Planned config files: `/etc/dumplbot/config.yaml`, `/etc/dumplbot/secrets.env`.
- Planned workspace instructions: `workspaces/<name>/CLAUDE.md`.

## Agent Bias

- Prefer doc-first and scaffolding work until source files exist.
- Keep Pi constraints visible: low memory, low CPU, no Docker assumptions.
- For runtime work, verify the full path: push-to-talk -> STT -> tools -> streamed reply.
- If a README-mentioned path is missing, do not invent it; note the gap and work from committed files only.

## Project-Local Skills

- Project-specific skill packs live in `.codex/skills/`.
- Read them directly from the repo, or copy proven ones into `$CODEX_HOME/skills` later.
