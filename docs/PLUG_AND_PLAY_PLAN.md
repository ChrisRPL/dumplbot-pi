# Plug-And-Play Plan

Read with: `README.md`, `SETUP_PI_ZERO.md`, `UX.md`, and `VISUAL_DESIGN.md` when planning first-run setup, onboarding, or DumplBot’s brand polish.

This file defines the target state for “easy to set up, easy to love” DumplBot on Raspberry Pi.

## Product Goal

- A user should be able to go from flashed SD card to a working DumplBot with minimal shell work.
- Setup should feel closer to a small appliance than a DIY dev box.
- The UI should feel calm, friendly, and distinctive, not like a debug console.

## Target Outcome

Success looks like:

1. flash SD card
2. assemble hardware
3. run one install command
4. open `/setup` from phone or laptop on the same Wi-Fi
5. save keys and defaults
6. press the button and talk

## Current Friction

- hardware drivers still require manual bring-up and verification
- config lives across `config.yaml` and `secrets.env`
- first-run success still expects comfort with SSH and systemd
- README had grown into one long operator note instead of a guided path
- UI review is stronger now, but final hardware validation is still pending
- motion/animation intent is not yet implemented in the device renderer

## Plug-And-Play Workstreams

### 1. First-Run Setup

- keep README short and readable
- move detailed appliance steps into `SETUP_PI_ZERO.md`
- make `/setup` the default place to finish config
- reduce required shell steps after `scripts/install_pi.sh`
- make old-install restart/rebind hints explicit and copy-paste ready

### 2. Onboarding UX

- show a clear idle / ready state on first boot
- surface missing keys or missing audio hardware in plain language
- make the happy path obvious: hold, speak, release
- keep recovery easy: errors should point to one next action only

### 3. Brand / UI Polish

- preserve the Dumpl mascot mood: compact, practical, friendly, dark
- make one dominant state per screen
- keep debug surfaces secondary to the normal product experience
- prefer small purposeful motion over constant animation

## Motion Plan

Allowed motion should stay Pi-friendly and low-cost:

- boot/logo reveal: one short fade or slide-in sequence
- state transitions: 120-180 ms crossfade or slide between `home`, `listening`, `thinking`, `answer`, `error`
- long-press feedback: one simple hold-progress indicator
- new result arrival: brief emphasis pulse on the main answer card

Avoid:

- decorative looping animations
- high-frequency redraw effects
- motion that makes text harder to read

## Acceptance Criteria

Plug-and-play:

- README setup section readable in under 2 minutes
- same-LAN `/setup` is enough for normal key/default configuration
- fresh install does not require editing files by hand for the common path
- one reboot returns to a ready idle screen

Brand / UX:

- home screen explains the next action instantly
- capture / transcribe / think / answer states are distinct at a glance
- at least one tasteful transition exists between core states
- screenshots feel like one product family, not separate utilities

## Before Calling It Done

- run Mac review bundle
- run Pi hardware validation from `SETUP_PI_ZERO.md`
- adjust copy, defaults, and motion based on the real Pi pass
