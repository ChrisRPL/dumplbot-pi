# System Architecture

## Engineering Approach

- Base OS: Raspberry Pi OS Lite.
- Runtime model: appliance-style install on a normal Pi OS host.
- Service model: `dumplbotd` and `dumpl-ui` run as systemd services.
- Install entrypoint: `scripts/install_pi.sh`.
- Sandboxing: `bubblewrap` (`bwrap`), not Docker.
- Config root: `/etc/dumplbot/`.

## Process Split

### `dumplbotd`

- Runtime: Node.js / TypeScript.
- Own HTTP API, SSE streaming, STT calls, scheduler, skills loading, workspace management, policy engine, and sandbox launch.
- Spawn one `agent-runner` process per interactive run.

### `dumpl-ui`

- Runtime: Python.
- Own buttons, push-to-talk, local audio capture, and LCD rendering.
- Stay responsive even when the daemon is busy or slow.

### `agent-runner`

- Runtime: TypeScript.
- Own one agent session only.
- Read prompt and workspace context.
- Emit streaming events: token, tool, status, done, error.
- Run inside `bwrap`, launched by `dumplbotd`.

## UI / Display Path

- Preferred path: PiSugar Whisplay Python driver plus a thin renderer layer.
- Renderer target: Pillow image buffer, then flush to display.
- Fallback path: generic ST7789 plus Pillow if Whisplay APIs prove limiting.

## Audio / STT Path

- Capture method: `arecord` subprocess.
- Baseline format: 16 kHz mono PCM WAV.
- Baseline temp file: `/tmp/dumplbot/ptt.wav`.
- STT happens in `dumplbotd`; UI never carries API keys.

## Final Repo Shape

```text
dumplbot/
  apps/
    host/
    agent-runner/
    ui/
  packages/
    core/
  config/
    dumplbot.example.yaml
  systemd/
    dumplbotd.service
    dumpl-ui.service
  scripts/
    install_pi.sh
    healthcheck.sh
  skills/
    coding/skill.yaml
    research/skill.yaml
    ops/skill.yaml
  workspaces/
    default/
      CLAUDE.md
  docs/
    README.md
    SYSTEM_ARCHITECTURE.md
    API_CONTRACTS.md
    IMPLEMENTATION_PLAN.md
    SETUP_PI_ZERO.md
    POLICY.md
    UX.md
```

## Non-Negotiables

- No Docker dependency on Pi.
- Prefer no native Node.js dependencies on Pi where avoidable.
- Secrets stay server-side in `/etc/dumplbot/secrets.env`.
- Stop/cancel support should be treated as an early feature, not polish.
