# Pi Zero Setup

Use this as the appliance bring-up checklist for a new Raspberry Pi Zero 2 WH.

## Base Assumptions

- Raspberry Pi OS Lite.
- SSH reachable.
- Wi-Fi pre-seeded or hotspot available.
- PiSugar 3 and Whisplay HAT installed.

## Install Order

1. Flash Raspberry Pi OS Lite.
2. Boot once and confirm SSH.
3. Install PiSugar / Whisplay driver stack using PiSugar-provided scripts.
4. Verify LCD, buttons, mic, and speaker before DumplBot install.
5. Run `scripts/install_pi.sh`.
6. Place config in `/etc/dumplbot/`.
7. Enable `dumplbotd.service` and `dumpl-ui.service`.

## Required Files

- `/etc/dumplbot/config.yaml`
- `/etc/dumplbot/secrets.env`

## Smoke Checks

- `GET /health` returns `200 OK`.
- UI can render an idle screen.
- `arecord` can capture a short WAV.
- A reboot returns to a working idle state.

## Failure Rules

- If Whisplay hardware is unstable, stop before adding app complexity.
- If audio capture fails, keep text-only mode moving while hardware debug continues.
- If installer files are missing from the repo, add scaffolding before pretending appliance install exists.
