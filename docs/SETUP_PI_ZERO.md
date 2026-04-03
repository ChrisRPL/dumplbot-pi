# Pi Zero Setup

Use this as the appliance bring-up checklist for a new Raspberry Pi Zero 2 WH.

## Base Assumptions

- Raspberry Pi OS Lite.
- SSH reachable.
- Wi-Fi pre-seeded or hotspot available.
- PiSugar 3 and Whisplay HAT installed.

## Fast Path

Normal goal: do shell setup once, then finish from `/setup` on the same Wi-Fi.

1. Flash Raspberry Pi OS Lite.
2. Boot once and confirm SSH.
3. Install PiSugar / Whisplay driver stack using PiSugar-provided scripts.
4. Verify LCD, buttons, mic, and speaker before DumplBot install.
5. SSH into the Pi, clone the repo, and run `bash scripts/install_pi.sh`.
6. Start `dumplbotd.service` and `dumpl-ui.service`.
7. Open `http://<pi-ip>:4123/setup` from your phone or laptop on the same Wi-Fi.
8. Save provider keys, choose default workspace/skill/safety, and clear the first-run checklist.

If you only remember one URL, remember:

- `http://<pi-ip>:4123/setup`

The installer now builds the app, installs services, and prints the `/setup` URL after install.

## First-Boot Command Block

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

If you created a custom Raspberry Pi username in Imager, use that instead of `pi`.

What `bash scripts/install_pi.sh` now does for a blank Pi:

1. asks for `sudo` only when needed
2. installs the baseline packages DumplBot needs
3. syncs the repo into `/opt/dumplbot`
4. runs `npm ci` and `npm run build`
5. creates `/etc/dumplbot/config.yaml` and `/etc/dumplbot/secrets.env` if missing
6. renders systemd units for your actual Pi login user
7. installs `dumplbot-healthcheck`
8. prints the best `/setup` URL it can detect

## Required Files

- `/etc/dumplbot/config.yaml`
- `/etc/dumplbot/secrets.env`

## What Good Looks Like

- device shows `READY` when voice is ready for a real talk test
- device shows `SETUP` + `ADD KEY` when the provider key is still missing
- device shows `SETUP` + `CHECK AUDIO` when Pi audio bring-up still needs one quick verification pass
- `/setup` shows daemon, scheduler, and STT readiness without exposing secret values

## Step-By-Step Config From `/setup`

Do this in order from your phone or laptop:

1. open `http://<pi-ip>:4123/setup`
2. confirm the page loads and the host bind says same-Wi-Fi setup is reachable
3. save your OpenAI key
   This powers Whisper STT and normal freeform replies.
4. set `default workspace` to `default`
5. set `default skill` to `coding`
6. leave `safety mode` at `balanced` for the first run
7. press `Save setup`
8. read the `What to do next` checklist
9. do not continue until all four items are done:
   `Same-Wi-Fi setup`, `Default workspace and skill`, `Voice key`, `Voice path`

## Step-By-Step First Use

Once `/setup` says the first run is ready:

1. look at the device screen
2. wait for `READY`
3. if the focused home target is `voice`, confirm the bottom action says `TALK NOW`
4. hold the hardware button
5. speak one short sentence
6. release the button
7. watch for `Listening`, then `Transcribing`, then `Thinking`, then the streamed reply
8. repeat once more to prove the second run works too

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
4. `node scripts/ui-review-bundle.mjs --output-dir /tmp/dumplbot-ui-review-final`
5. inspect `/tmp/dumplbot-mac-preview/*.png` and `/tmp/dumplbot-ui-review-final/`
6. run the printed live preview command and exercise home -> diagnostics/voice/transcript/audio/error navigation

## Final Pi Validation Order

Keep the Pi pass hardware-first:

1. verify LCD, buttons, battery state, Wi-Fi, mic, and speaker
2. install with `bash scripts/install_pi.sh`
3. start `dumplbotd.service`, then `dumpl-ui.service`
4. open `/setup` from the same Wi-Fi and clear the first-run checklist
5. confirm `curl -i http://127.0.0.1:4123/health`
6. run `dumplbot-healthcheck`
7. run `npm run smoke:runner-sandbox-local`
8. verify one push-to-talk loop end to end
9. verify one workspace file/history flow and one scheduler run
10. reboot once and confirm the system returns to idle cleanly

## Failure Rules

- If Whisplay hardware is unstable, stop before adding app complexity.
- If audio capture fails, keep text-only mode moving while hardware debug continues.
- If installer files are missing from the repo, add the missing install path before pretending appliance install exists.
