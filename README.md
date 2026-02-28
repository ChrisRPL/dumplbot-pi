# DumplBot

<img src="dumpl_banner.png" alt="Dumpl mascot" width="75%" />

**Pocket voice agent + on-device coding assistant** optimized for **Raspberry Pi Zero 2 WH** with the **PiSugar Whisplay HAT**.

Push-to-talk → transcribe → agent uses real tools (files/shell/web) → response streams back to the device.

---

## What DumplBot is

A **portable, always-with-you agent** that can **talk, code, run tools, and schedule jobs**—without needing a desktop “agent box”.

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

---

## Roadmap

* [ ] Push-to-talk WAV capture
* [ ] Whisper API STT integration
* [ ] bwrap sandbox + policy gates
* [ ] workspaces + repo attach
* [ ] scheduler + job UI
* [ ] skill packs + optional integrations
* [ ] local setup page (LAN only)

---

## Disclaimer

DumplBot is an independent project and is not affiliated with any third-party agent frameworks.
