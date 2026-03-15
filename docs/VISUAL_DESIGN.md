# Visual Design

Read when: changing device renderer layout, typography, color, cards/chips, or screen hierarchy.

This file defines the visual target for DumplBot on the Whisplay-sized screen. Use it to keep the renderer opinionated and consistent.

## Intent

- Pocket instrument, not dashboard.
- Calm, dark appliance surface.
- One dominant thing per screen.
- Short labels, strong hierarchy, low chrome.
- Debug screens may stay utilitarian, but should still feel designed.

## Brand Cues

- Reuse the DumplBot banner/mascot mood from [dumpl_banner.png](/Users/krzysztof/Projects/oss/dumplbot-pi/dumpl_banner.png): dark, friendly, compact, practical.
- Avoid generic terminal aesthetics.
- Avoid bright red/green status overload.
- Use color as phase accent, not background wallpaper.

## Palette

Base:

- `bg`: `#0b1117`
- `panel`: `#18212b`
- `panel_alt`: `#121921`
- `header`: `#162737`
- `text`: `#eef2f4`
- `muted`: `#9aa4ad`
- `line`: `#223140`

Phase accents:

- `home`: `#b6cd6d`
- `listening`: `#62c0ff`
- `transcribing`: `#64d2c7`
- `thinking`: `#f2c14e`
- `tool`: `#f28c28`
- `answer`: `#7ccf6a`
- `error`: `#ff7a59`
- `diagnostics`: `#c49b2e`

Status chips:

- `active_chip_bg`: `#24516b`
- `idle_chip_bg`: `#2b323a`
- `active_chip_text`: `#e3f5fb`
- `idle_chip_text`: `#c3c9cf`

## Typography

Implementation fallback:

- body: `DejaVu Sans`
- emphasis: `DejaVu Sans Bold`

Visual roles:

- `hero`: 20-22 px, uppercase only for short nouns
- `title`: 14-16 px
- `label`: 10-11 px
- `body`: 12-13 px
- `tiny`: 9-10 px

Rules:

- uppercase only for chips, labels, and short section headers
- body copy stays sentence case
- never show more than two text weights on one screen
- trim default markers like `(default)` where space is tight

## Layout System

Target panel:

- logical canvas: `170x320`
- content gutter: `12 px`
- card radius: `12-16 px`
- small chip radius: `8-10 px`
- vertical rhythm: `6 / 10 / 14 px`

Zones:

1. top bar
2. primary card or state block
3. secondary chips/cards
4. footer hint or compact metadata

Do not:

- stack raw `Status / Prompt / Answer / Error` labels as the final device layout
- let file paths dominate the screen
- show more than one scrolling dump on screen at once

## Visual Components

Top bar:

- left: screen title
- right: compact mode badge
- rounded container, not a flat strip

Primary card:

- one main fact only
- large text
- room to breathe

Chips:

- binary readiness or small state only
- max 2 words

Meta cards:

- age, file, source, count, next target
- short values only

## Iconography

No external icon pack required right now.

Use:

- text badges
- short nouns
- simple glyphs only when needed: `>`, `!`, `...`

Avoid:

- emoji
- mixed icon styles
- decorative symbols that cost legibility

## Screen Blueprints

Home:

- show workspace
- show skill
- show 4 compact readiness chips max
- show one large `NEXT` target card
- when setup is incomplete, swap the normal target card for one recovery action such as `ADD KEY` or `CHECK AUDIO`
- footer: safety + jobs

Listening:

- dominant word: `Listening`
- one short helper: `release to send`
- secondary helper: `hold longer to cancel`
- optional subtle elapsed indicator

Transcribing:

- dominant word: `Transcribing`
- one short line for last heard/source if useful
- no debug dump here

Thinking:

- dominant word: `Thinking`
- optional tool banner area below
- answer area should not look like final answer yet

Tool:

- tool banner visible, compact
- if detail exists, truncate aggressively
- keep answer stream secondary while tool is active

Answer:

- one clear answer area
- readable wrap
- tool banner gone once finished

Error:

- one strong message card
- tiny meta cards for age/source/file
- error screen should feel recoverable, not catastrophic

Voice debug bundle:

- 3 stacked cards: heard / audio / error
- age on each card
- no raw path dump in the main body

Transcript/audio/error detail:

- one large content card
- two tiny meta cards below
- keep filenames short

Scheduler summary:

- show active job count first
- show 2 compact job cards max
- each card: job id, schedule, last result, enabled chip

Scheduler detail:

- one schedule card
- one compact context card for workspace, skill, and history window
- one short last-run line

Scheduler history:

- 3 stacked run cards max
- time left, status chip right, result line below
- keep footer hints short

## Preview Rules

- Mac preview and Whisplay must share the same raster composition path.
- Snapshot output is the review artifact for layout changes.
- Use `python apps/ui/dumpl_ui.py --preview-core-gallery /tmp/dumplbot-core-gallery` for host-free review of `home`, `listening`, `transcribing`, `thinking`, `tool`, `answer`, and `error`.
- Use `python apps/ui/dumpl_ui.py --preview-appliance-gallery /tmp/dumplbot-appliance-gallery` for host-free review of first-run `READY`, `ADD KEY`, and `CHECK AUDIO` home states.
- Use `python apps/ui/dumpl_ui.py --preview-scheduler-gallery /tmp/dumplbot-scheduler-gallery` for host-free review of `scheduler-summary`, `scheduler-detail`, and `scheduler-history`.
- Use `python apps/ui/dumpl_ui.py --preview-skill-gallery /tmp/dumplbot-skill-gallery` for host-free review of `skill-summary` and `skill-detail`.
- Use `python apps/ui/dumpl_ui.py --preview-workspace-gallery /tmp/dumplbot-workspace-gallery` for host-free review of `workspace-summary`, `workspace-detail`, `workspace-history`, `workspace-files`, and `workspace-file`.
- When changing visual hierarchy, regenerate `home`, `transcript`, `audio`, `error`, and `voice-debug` snapshots together.
- Run `npm run smoke:ui-core-gallery` after core-state raster changes so the PNG set stays locked.
- Run `npm run smoke:ui-appliance-gallery` after first-run home changes.
- Run `npm run smoke:ui-scheduler-gallery` after scheduler raster changes.
- Run `npm run smoke:ui-skill-gallery` after skill raster changes.
- Run `npm run smoke:ui-workspace-gallery` after workspace raster changes.

## Interaction Tone

- short press = browse
- long press = commit / enter / cancel
- hint text must be explicit on screens where the button meaning changes

## Acceptance For UI Polish

- Home fits in one glance.
- First-run `READY` vs `SETUP` is obvious without reading docs.
- Debug screens no longer look like terminal transcripts.
- Active run states are distinguishable at a distance.
- Renderer screenshots are reviewable without explaining the layout verbally.
