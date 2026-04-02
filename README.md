# DumplBot

<img src="dumpl_banner.png" alt="Dumpl mascot" width="75%" />

**Pocket voice agent + on-device coding assistant** optimized for **Raspberry Pi Zero 2 WH** with the **PiSugar Whisplay HAT**.

Push-to-talk → transcribe → agent uses real tools (files/shell/web) → response streams back to the device.

---

## What DumplBot is

A **portable, always-with-you agent** that can **talk, code, run tools, and schedule jobs**—without needing a desktop “agent box”.

Current repo status: text + voice flow, sandbox/policy baseline, workspace/scheduler/skill surfaces, and LAN setup UX are committed; biggest remaining gaps are final Pi validation and fuller model-backed runner behavior.

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
- `docs/VISUAL_DESIGN.md` for the Whisplay visual target and screen hierarchy
- `docs/PLUG_AND_PLAY_PLAN.md` for the onboarding + brand-polish target

---

## Quick start (dev / laptop)

If your goal is a real Pi install, skip this section and go to `Install on Pi Zero 2 WH`.

1) Copy env and set keys:
```bash
cp .env.example .env
# set ANTHROPIC_API_KEY (and OPENAI_API_KEY for STT when enabled)
```

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

Common mock commands:

- `:workspace`, `:workspace <id>`, `:workspace history <id> [offset]`, `:workspace files <id>`, `:workspace read <id> <path>`
- `:skill`, `:skill <id>`
- `:jobs`, `:jobs history <id> [offset]`, `:jobs on|off|delete <id>`
- `:jobs add <id> "<schedule>" "<prompt>" [workspace|-] [skill|-] [on|off]`
- `:jobs edit ...`

Schedule input accepts cron, presets like `daily 09:15`, and tiny natural phrases like `every day at 09:15`. Job/workspace history keeps the newest 20 runs and supports the optional offset window.

### Mac preview / review

Host-backed preview:

1. Start the host:
```bash
npm run dev:host
```
2. Seed debug state + get the live preview command:
```bash
node scripts/mac-preview-walkthrough.mjs --output-dir /tmp/dumplbot-mac-preview --seed error
```
3. Live large-screen preview:
```bash
python apps/ui/dumpl_ui.py --preview --preview-scale 3 --home-button-mode
```

Host-free design review bundle:

```bash
node scripts/ui-review-bundle.mjs --output-dir /tmp/dumplbot-ui-review
open /tmp/dumplbot-ui-review
```

Bundle folders:

- `core/` for home + active-run states
- `appliance/` for first-run `READY`, `ADD KEY`, and `CHECK AUDIO`
- `debug/` for transcript, audio, error, and compact voice triage
- `navigation/` for hold-to-open, hold-to-clear, and hold-to-next-job affordances
- `scheduler/`, `skills/`, `workspaces/` for the rest of the device surfaces

Individual host-free galleries:

- `python apps/ui/dumpl_ui.py --preview-core-gallery /tmp/dumplbot-core-gallery`
- `python apps/ui/dumpl_ui.py --preview-appliance-gallery /tmp/dumplbot-appliance-gallery`
- `python apps/ui/dumpl_ui.py --preview-debug-gallery /tmp/dumplbot-debug-gallery`
- `python apps/ui/dumpl_ui.py --preview-navigation-gallery /tmp/dumplbot-navigation-gallery`
- `python apps/ui/dumpl_ui.py --preview-scheduler-gallery /tmp/dumplbot-scheduler-gallery`
- `python apps/ui/dumpl_ui.py --preview-skill-gallery /tmp/dumplbot-skill-gallery`
- `python apps/ui/dumpl_ui.py --preview-workspace-gallery /tmp/dumplbot-workspace-gallery`

Useful one-off renderer screens:

- `python apps/ui/dumpl_ui.py --home-screen`
- `python apps/ui/dumpl_ui.py --diagnostics-screen`
- `python apps/ui/dumpl_ui.py --transcript-screen`
- `python apps/ui/dumpl_ui.py --audio-screen`
- `python apps/ui/dumpl_ui.py --error-screen`
- `python apps/ui/dumpl_ui.py --voice-debug-screen`

UI review checks before Pi validation:

- `npm run smoke:ui-core-gallery`
- `npm run smoke:ui-appliance-gallery`
- `npm run smoke:ui-debug-gallery`
- `npm run smoke:ui-navigation-gallery`
- `npm run smoke:ui-scheduler-gallery`
- `npm run smoke:ui-skill-gallery`
- `npm run smoke:ui-workspace-gallery`
- `npm run smoke:ui-review-bundle`
- `npm run smoke:run-cancel`
- `npm run smoke:ui-run-cancel`

---

## Install on Pi Zero 2 WH

Detailed checklist: `docs/SETUP_PI_ZERO.md`

This is the normal user path. Goal: finish the shell work once, then do the rest from `/setup` on the same Wi-Fi.

### Before you start

- Raspberry Pi OS Lite on the SD card
- Wi-Fi + SSH pre-seeded in Raspberry Pi Imager
- PiSugar / Whisplay drivers installed and the LCD, buttons, mic, and speaker verified once

### 1. SSH into the Pi and run the installer

```bash
ssh <pi-user>@<pi-ip>
git clone https://github.com/steipete/dumplbot-pi.git
cd dumplbot-pi
bash scripts/install_pi.sh
```

What that installer does for you:

1. asks for `sudo` if it needs it
2. installs the base Pi packages DumplBot needs (`nodejs`, `npm`, `bubblewrap`, `python3-pil`, `alsa-utils`, `rsync`, `curl`, `git`)
3. copies the app into `/opt/dumplbot`
4. builds the Node runtime
5. creates `/etc/dumplbot/config.yaml` and `/etc/dumplbot/secrets.env` if they do not exist yet
6. renders systemd units for your current Pi login user
7. installs `dumplbot-healthcheck`
8. prints the `/setup` URL for the current Pi IP

If you created a custom Raspberry Pi username in Imager, use that username in the SSH command above. The installer no longer assumes the user is `pi`.

Copy-paste first boot session:

```bash
ssh <pi-user>@<pi-ip>
git clone https://github.com/steipete/dumplbot-pi.git
cd dumplbot-pi
bash scripts/install_pi.sh
sudo systemctl enable --now dumplbotd.service
sudo systemctl enable --now dumpl-ui.service
curl -i http://127.0.0.1:4123/health
dumplbot-healthcheck
```

If you used that block, skip straight to step 3.

### 2. Start the services once

```bash
sudo systemctl enable --now dumplbotd.service
sudo systemctl enable --now dumpl-ui.service
```

### 3. Open setup from your phone or laptop on the same Wi-Fi

Open:

- `http://<pi-ip>:4123/setup`

Then do these in order:

1. save your OpenAI key
2. leave the default workspace as `default` unless you already created another one
3. leave the default skill as `coding` for the first test
4. leave safety mode at `balanced` for the first test
5. press `Save setup`
6. read the `What to do next` checklist and clear any remaining missing step

Your first-run goal is simple:

1. `Same-Wi-Fi setup` done
2. `Default workspace and skill` done
3. `Voice key` done
4. `Voice path` done

If you only remember one thing, remember this URL:

- `http://<pi-ip>:4123/setup`

### 4. What the device should show after setup

- `READY` when voice path is clear and the next action is just talk
- `SETUP` + `ADD KEY` when the provider key is still missing
- `SETUP` + `CHECK AUDIO` when Pi mic/speaker bring-up still needs verification

Fresh installs now default `server.host` to `0.0.0.0`, so the setup shell at `/setup` is reachable from the same Wi-Fi. The setup page handles provider keys, default workspace/default skill/safety, readiness checks, and exact next-step instructions when an older install still needs rebind + restart.

### 5. Quick health check

```bash
curl -i http://127.0.0.1:4123/health
dumplbot-healthcheck
```

### 6. First real voice test

1. wait for the device to show `READY`
2. if the focused home target is `voice`, the bottom action should read `TALK NOW`
3. hold the hardware button
4. speak a short sentence
5. release the button
6. watch the device move through `Listening` -> `Transcribing` -> `Thinking` -> streamed answer
7. if something is missing, the device should stay in `SETUP` and tell you what to fix next instead of failing silently

### 7. If the first test fails

Run these on the Pi first:

```bash
dumplbot-healthcheck
sudo systemctl --no-pager --full status dumplbotd.service dumpl-ui.service
journalctl -u dumplbotd.service -u dumpl-ui.service -n 120 --no-pager
```

Then re-open `/setup` and check the first-run checklist again.

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
* `done` workspaces + repo attach. Workspace APIs/state, repo attach, workspace-local history, workspace-local project file storage, mock UI switching, renderer workspace selector/detail/create/history/file flows, and a host-free workspace review gallery landed.
* `partial` skill packs + optional integrations. Skill schema/loading/policy landed, plus per-workspace defaults, focused job skill editing, renderer skill summary/detail flows, provider integration-readiness metadata from setup secrets plus the LAN setup page, and a host-free skill review gallery; richer run-time integrations are still pending.
* `partial` scheduler + job UI. File-backed jobs API, single-job detail/patch/history routes, schedule presets, natural-language phrases, capped run history, run diagnostics, failure counters, mock actions, paged history windows, on-device home/diagnostics plus summary/detail/history/action/edit flows, home button-navigation into device views, and first scheduler button-navigation preview/mode landed; Pi-side validation and further hardware polish are still pending.
* `done` local setup page (LAN only). Fresh installs now bind for same-Wi-Fi setup, the setup shell saves default workspace/default skill/safety plus provider keys, shows secret presence without exposing values, exports/imports `config.yaml`, surfaces live-vs-configured bind diagnostics plus daemon/scheduler/STT readiness, gives explicit next-step commands for old loopback-only installs, and limits setup routes to localhost/private-LAN clients.

---

## Disclaimer

DumplBot is an independent project and is not affiliated with any third-party agent frameworks.
