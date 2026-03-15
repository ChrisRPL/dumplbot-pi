# DumplBot

<img src="dumpl_banner.png" alt="Dumpl mascot" width="75%" />

**Pocket voice agent + on-device coding assistant** optimized for **Raspberry Pi Zero 2 WH** with the **PiSugar Whisplay HAT**.

Push-to-talk → transcribe → agent uses real tools (files/shell/web) → response streams back to the device.

---

## What DumplBot is

A **portable, always-with-you agent** that can **talk, code, run tools, and schedule jobs**—without needing a desktop “agent box”.

Current repo status: text + voice flow, sandbox/policy baseline, workspace/skill foundations, and LAN setup UX are committed; scheduler polish and broader repo-attach follow-on work remain.

---

## Key features

- **Push-to-talk voice UX** (walkie-talkie simple)
- **Streaming replies** to a tiny display (token-by-token)
- **On-device coding agent**: read/edit files, run commands, use web tools
- **Workspaces**: separate contexts per project
- **Scheduler**: cron-like jobs that run prompts and surface results
- **Skills**: drop-in bundles (prompt + tool policy + optional integrations)
- **Sandboxed execution** (Pi-friendly isolation; no Docker required)

---

## Hardware target

- Raspberry Pi Zero 2 WH
- PiSugar 3 battery
- PiSugar Whisplay HAT (LCD + WM8960 audio + buttons)
- Wi-Fi or phone hotspot

---

## Architecture (high level)

- **dumpl-ui** (device UI): buttons/PTT, audio capture, screen rendering  
- **dumplbotd** (daemon): API + orchestration + scheduler + policy  
- **agent-runner** (agent runtime): executes a single run and streams events back  

The UI talks to the daemon over `localhost`, and the daemon streams output back via SSE (or WebSocket later).

---

## Implementation Specs

The stepwise build plan now lives in `docs/`:

- `docs/README.md` for read order
- `docs/SYSTEM_ARCHITECTURE.md` for the final target topology
- `docs/API_CONTRACTS.md` for stable daemon/UI/runner contracts
- `docs/IMPLEMENTATION_PLAN.md` for milestone-by-milestone execution
- `docs/SETUP_PI_ZERO.md`, `docs/POLICY.md`, and `docs/UX.md` for hardware, safety, and device behavior

---

## Quick start (dev / laptop)

1) Copy env and set keys:
```bash
cp .env.example .env
# set ANTHROPIC_API_KEY (and OPENAI_API_KEY for STT when enabled)
````

2. Install + build:

```bash
npm install
npm run build
npm run dev:host
```

3. Run UI in mock mode:

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r apps/ui/requirements.txt
python apps/ui/dumpl_ui.py --mock
```

Type into `Dumpl>` and watch streamed output.
Use `:workspace`, `:workspace <id>`, `:workspace history <id> [offset]`, `:workspace files <id>`, `:workspace read <id> <path>`, `:skill`, `:skill <id>`, `:jobs`, `:jobs history <id> [offset]`, `:jobs on|off|delete <id>`, `:jobs add <id> "<schedule>" "<prompt>" [workspace|-] [skill|-] [on|off]`, and `:jobs edit ...` inside mock mode to inspect active selections, workspace files, and scheduler jobs. Schedule input now accepts cron, presets like `daily 09:15`, and tiny natural phrases like `every day at 09:15`. Job history keeps the newest 20 runs per job and can be paged with the optional history offset; workspace history keeps the newest 20 runs per workspace with the same offset pattern.
For the device renderer path, use `node scripts/mac-preview-walkthrough.mjs --output-dir /tmp/dumplbot-mac-preview --seed error` on the Mac to seed the host, write `home.png`, `transcript.png`, `audio.png`, `error.png`, and `voice-debug.png`, and print the exact live preview command. You can also run `python apps/ui/dumpl_ui.py --preview --preview-scale 3 --home-button-mode` on the Mac for a large live Whisplay-style window (`Space` = hold button, release `Space` = release, `q` = quit), `python apps/ui/dumpl_ui.py --preview-snapshot /tmp/dumplbot-home.png --home-screen` for a PNG snapshot of the same raster path, `python apps/ui/dumpl_ui.py --home-screen` for a compact device overview, `python apps/ui/dumpl_ui.py --diagnostics-screen` for bind/daemon/STT diagnostics, `python apps/ui/dumpl_ui.py --transcript-screen` for the last stored transcript, `python apps/ui/dumpl_ui.py --audio-screen` for the last stored audio metadata, `python apps/ui/dumpl_ui.py --error-screen` for the last stored voice error, `python apps/ui/dumpl_ui.py --voice-debug-screen` for the compact transcript/audio/error summary, `python apps/ui/dumpl_ui.py --seed-debug-state error` to seed a preview-friendly transcript/audio/error bundle from the renderer path, `python apps/ui/dumpl_ui.py --clear-debug-state` to clear transcript/audio/error state from the renderer path, `python apps/ui/dumpl_ui.py --home-nav-mode home --home-nav-action next-target` to preview one home-navigation short press, `python apps/ui/dumpl_ui.py --home-nav-mode voice --home-nav-target voice --home-nav-action clear-debug` to preview the voice-debug clear action, or `python apps/ui/dumpl_ui.py --home-button-mode` on-device for one-button home navigation into workspace/skill/scheduler/diagnostics/voice/transcript/audio/error views. Debug snapshot examples: `python apps/ui/dumpl_ui.py --preview-snapshot /tmp/dumplbot-transcript.png --transcript-screen`, `python apps/ui/dumpl_ui.py --preview-snapshot /tmp/dumplbot-audio.png --audio-screen`, `python apps/ui/dumpl_ui.py --preview-snapshot /tmp/dumplbot-error.png --error-screen`, `python apps/ui/dumpl_ui.py --preview-snapshot /tmp/dumplbot-voice-debug.png --voice-debug-screen`, and `python apps/ui/dumpl_ui.py --preview-gallery /tmp/dumplbot-gallery --seed-debug-state error` to write `home.png`, `transcript.png`, `audio.png`, `error.png`, and `voice-debug.png` in one pass. Workspace-specific flows still support `python apps/ui/dumpl_ui.py --workspace-screen`, `--workspace-files alpha`, `--workspace-file alpha --workspace-file-path notes/today.md`, `--workspace-history alpha --workspace-history-offset 4`, `--workspace-detail alpha`, `--workspace-select alpha`, `--workspace-create field-lab --workspace-instructions "# Field Lab"`, or `--workspace-clear`; skill flows still support `python apps/ui/dumpl_ui.py --skill-summary`, `--skill-screen`, `--skill-detail coding`, `--skill-select research`, or `--skill-clear`; scheduler flows still support `python apps/ui/dumpl_ui.py --scheduler-screen summary`, `python apps/ui/dumpl_ui.py --scheduler-screen detail --scheduler-job daily-status`, `python apps/ui/dumpl_ui.py --scheduler-screen history --scheduler-job daily-status --scheduler-history-offset 4`, `python apps/ui/dumpl_ui.py --scheduler-nav-mode summary --scheduler-nav-action next-screen`, or `python apps/ui/dumpl_ui.py --scheduler-button-mode`. Focused action/edit flows still use `python apps/ui/dumpl_ui.py --job-detail daily-status --job-detail-action disable`, `python apps/ui/dumpl_ui.py --job-detail daily-status --job-detail-prompt "summarize repo state" --job-detail-schedule "every monday at 08:30" --job-detail-workspace default --job-detail-skill coding`, `python apps/ui/dumpl_ui.py --job-history daily-status --job-history-offset 4`, `python apps/ui/dumpl_ui.py --job-enable daily-status` or `--job-disable daily-status` or `--job-delete daily-status`, or `python apps/ui/dumpl_ui.py --job-id daily-status --job-schedule "every monday at 08:30" --job-prompt "summarize repo state"` to save one scheduler job through the renderer flow.

---

## Install on Pi Zero 2 WH (appliance mode)

1. Flash Raspberry Pi OS Lite, pre-seed Wi-Fi + SSH.
2. Install Whisplay drivers and verify LCD/buttons/audio.
3. Install DumplBot:

```bash
bash scripts/install_pi.sh
```

4. Put your keys into:

* `/etc/dumplbot/secrets.env`
* `/etc/dumplbot/config.yaml`

Fresh installs now default `server.host` to `0.0.0.0`, so the setup shell at `/setup` is reachable from the same Wi-Fi and can save default workspace/default skill/safety plus provider keys. The setup page now also shows live bind/configured bind, daemon/scheduler/STT readiness, and exact next-step instructions when an old install still needs rebind + restart.

5. Start services:

```bash
sudo systemctl enable --now dumplbotd.service
sudo systemctl enable --now dumpl-ui.service
```

---

## Configuration

* Main config: `/etc/dumplbot/config.yaml`
* Secrets: `/etc/dumplbot/secrets.env`
* Workspace instructions: `workspaces/<name>/CLAUDE.md`

You can tune:

* tool allowlists (safe defaults)
* permission mode (more/less restrictive)
* STT model and language bias
* default workspace + skill

---

## Safety model (practical)

DumplBot is built to be powerful **without becoming a pocket root shell**:

* tools are allowlisted
* bash is restricted (allowlist prefixes)
* network in bash is disabled by default (use web tools instead)
* agent runs are sandboxed (bubblewrap on Pi)

For local sandbox confidence before Pi validation, run `npm run smoke:runner-sandbox-local`. On native macOS it proves launch shape and failure-path wiring, while the Linux-only filesystem/network smokes skip by design; see [docs/SANDBOX_VALIDATION.md](/Users/krzysztof/Projects/oss/dumplbot-pi/docs/SANDBOX_VALIDATION.md).

---

## Roadmap

Status as of March 12, 2026:

* `done` Push-to-talk WAV capture. Software path landed; Pi hardware validation still pending.
* `done` Whisper API STT integration.
* `done` `bwrap` sandbox + policy gates. Linux/Pi runtime validation still pending.
* `done` workspaces + repo attach. Workspace APIs/state, repo attach, workspace-local history, workspace-local project file storage, mock UI switching, and renderer workspace selector/detail/create/history/file flows landed.
* `partial` skill packs + optional integrations. Skill schema/loading/policy landed, plus per-workspace defaults, focused job skill editing, renderer skill summary/detail flows, and provider integration-readiness metadata from setup secrets plus the LAN setup page; richer run-time integrations are still pending.
* `partial` scheduler + job UI. File-backed jobs API, single-job detail/patch/history routes, schedule presets, natural-language phrases, capped run history, run diagnostics, failure counters, mock actions, paged history windows, on-device home/diagnostics plus summary/detail/history/action/edit flows, home button-navigation into device views, and first scheduler button-navigation preview/mode landed; Pi-side validation and further hardware polish are still pending.
* `done` local setup page (LAN only). Fresh installs now bind for same-Wi-Fi setup, the setup shell saves default workspace/default skill/safety plus provider keys, shows secret presence without exposing values, exports/imports `config.yaml`, surfaces live-vs-configured bind diagnostics plus daemon/scheduler/STT readiness, gives explicit next-step commands for old loopback-only installs, and limits setup routes to localhost/private-LAN clients.

---

## Disclaimer

DumplBot is an independent project and is not affiliated with any third-party agent frameworks.
