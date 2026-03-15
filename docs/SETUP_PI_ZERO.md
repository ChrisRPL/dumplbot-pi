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

The installer now prints the next command and the `/setup` URL to open from the same Wi-Fi after install.

## Required Files

- `/etc/dumplbot/config.yaml`
- `/etc/dumplbot/secrets.env`

## Smoke Checks

- `GET /health` returns `200 OK`.
- UI can render an idle screen.
- `arecord` can capture a short WAV.
- `npm run smoke:runner-sandbox-fs` passes on the Pi after `bwrap` is installed.
- A reboot returns to a working idle state.

## Mac Prep Before Pi Validation

Run these on the Mac before the final hardware pass:

1. `npm run smoke:audio-routes`
2. `npm run smoke:runner-sandbox-local`
3. `node scripts/mac-preview-walkthrough.mjs --output-dir /tmp/dumplbot-mac-preview --seed error`
4. inspect `/tmp/dumplbot-mac-preview/*.png`
5. run the printed live preview command and exercise home -> diagnostics/voice/transcript/audio/error navigation

## Final Pi Validation Order

Keep the Pi pass hardware-first:

1. verify LCD, buttons, battery state, Wi-Fi, mic, and speaker
2. install with `bash scripts/install_pi.sh`
3. start `dumplbotd.service`, then `dumpl-ui.service`
4. confirm `curl -i http://127.0.0.1:4123/health`
5. run `npm run smoke:runner-sandbox-local`
6. verify `/setup` from the same LAN and confirm key/setup status
7. verify one push-to-talk loop end to end
8. verify one workspace file/history flow and one scheduler run
9. reboot once and confirm the system returns to idle cleanly

## Failure Rules

- If Whisplay hardware is unstable, stop before adding app complexity.
- If audio capture fails, keep text-only mode moving while hardware debug continues.
- If installer files are missing from the repo, add scaffolding before pretending appliance install exists.
