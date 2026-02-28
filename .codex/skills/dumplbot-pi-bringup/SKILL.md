---
name: dumplbot-pi-bringup
description: Set up, validate, and debug DumplBot on Raspberry Pi Zero 2 WH hardware with the PiSugar 3 battery and PiSugar Whisplay HAT. Use when bringing up a new device, checking display or audio or buttons, validating systemd services, or isolating Pi-side install and config failures.
---

# DumplBot Pi Bring-Up

Use this skill to keep Pi work hardware-first and ordered.

## Quick Pass

1. Read `docs/SETUP_PI_ZERO.md` first, then `docs/SYSTEM_ARCHITECTURE.md`.
2. Confirm the repo actually contains the files you plan to use. The README is future-facing; if `scripts/install_pi.sh` or unit files are missing, stop at docs or scaffolding and note the gap.
3. Validate the hardware assumptions from `README.md`: Raspberry Pi Zero 2 WH, PiSugar 3, PiSugar Whisplay HAT, Wi-Fi path.
4. Check the planned config surfaces before deeper changes: `/etc/dumplbot/config.yaml` and `/etc/dumplbot/secrets.env`.

## Bring-Up Order

1. Verify display output, audio I/O, buttons, battery reporting, and network reachability.
2. Run the install path from `scripts/install_pi.sh` once that script exists.
3. Bring up `dumplbotd.service` first, then `dumpl-ui.service`.
4. Confirm the UI can reach the daemon over `localhost`.
5. Validate one full talk loop, not only service startup.

## Debugging Bias

- Prefer systemd status, logs, config parsing, and device detection before code edits.
- Keep fixes Pi-friendly: low memory, low CPU, no heavyweight background services.
- When a missing file blocks the flow, leave a concrete breadcrumb in the repo instead of inventing an ungrounded command.

## Reference

- Read `references/checklist.md` for the device touchpoints and stop conditions.
- Read `docs/POLICY.md` before relaxing safety assumptions during debugging.
