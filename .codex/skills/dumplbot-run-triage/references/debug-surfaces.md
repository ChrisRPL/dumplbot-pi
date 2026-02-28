# Run Triage Surfaces

- Primary path: push-to-talk -> audio capture -> STT -> planning and tool execution -> streamed reply.
- Planned components: `dumpl-ui`, `dumplbotd`, `agent-runner`.
- First evidence: UI logs, daemon logs, runner logs, config, permission policy, and stream continuity.
- Common fault classes: button event drop, audio device mismatch, missing API key, sandbox denial, SSE break, partial stream flush.
- If the repo is still docs-only, convert the task into a missing-surface checklist instead of fabricating runtime commands.
