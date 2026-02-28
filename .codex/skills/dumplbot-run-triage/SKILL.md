---
name: dumplbot-run-triage
description: Trace and isolate broken DumplBot runs across voice capture, transcription, daemon orchestration, tool execution, and streamed output. Use when a push-to-talk request stalls, drops tokens, fails tool execution, or returns incomplete output from `dumpl-ui`, `dumplbotd`, or `agent-runner`.
---

# DumplBot Run Triage

Use this skill to debug the full user-visible path before chasing isolated subsystems.

## Triage Order

1. Read `docs/SYSTEM_ARCHITECTURE.md`, `docs/API_CONTRACTS.md`, and `docs/UX.md` before forming a theory.
2. Reconstruct the failing hop: push-to-talk -> audio capture -> STT -> planning and tool execution -> streamed reply.
3. Name the first missing artifact: button event, audio frames, transcript, tool result, or stream chunk.
4. Inspect the component that should have produced that artifact, then the immediate upstream dependency.
5. Re-run the smallest end-to-end scenario that still reproduces the failure.

## Signals To Collect

- Exact symptom and the last known-good step.
- UI, daemon, and runner logs.
- Relevant config and permission policy.
- Whether the failure is deterministic, intermittent, or device-specific.

## Guardrails

- Do not trust the README path list blindly; confirm files exist before scripting around them.
- If the code is not committed yet, turn the request into a gap list: missing logs, missing scripts, missing service definitions, or missing tests.
- Prefer fixes that preserve stream continuity and low-latency UX.
- If a bug is milestone-specific, narrow the work against `docs/IMPLEMENTATION_PLAN.md` before broad rewrites.

## Reference

- Read `references/debug-surfaces.md` for the main failure surfaces and fallback behavior when the repo is still docs-only.
