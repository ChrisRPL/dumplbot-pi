# Pi Bring-Up Touchpoints

- Hardware target: Raspberry Pi Zero 2 WH, PiSugar 3, PiSugar Whisplay HAT.
- First checks: display, audio codec, buttons, Wi-Fi path, battery state.
- Planned install entrypoint: `bash scripts/install_pi.sh`.
- Planned services: `dumplbotd.service`, `dumpl-ui.service`.
- Planned config: `/etc/dumplbot/config.yaml`, `/etc/dumplbot/secrets.env`.
- If those files are still missing from the repo, stop at docs or scaffolding and log the gap instead of fabricating a deployment path.
