---
name: dumplbot-workspace-seed
description: Create, refine, and audit DumplBot workspace definitions, including instruction files, default skills, tool allowlists, and scheduler defaults. Use when adding a new workspace tree under `workspaces/NAME`, tightening permissions, choosing a default skill, or preparing a repeatable workspace preset for the device.
---

# DumplBot Workspace Seed

Use this skill to keep workspace setup explicit, least-privilege, and reusable.

## Seed Order

1. Read `docs/IMPLEMENTATION_PLAN.md` for Milestone 5 and Milestone 7, then `docs/POLICY.md`.
2. Confirm the workspace target and the repo roots it should expose.
3. Write the workspace instruction file at `workspaces/<name>/CLAUDE.md` unless the repo later standardizes on a different instruction surface.
4. Define the minimum tool allowlist and permission mode that still supports the task.
5. Pick one default skill and document when to switch away from it.
6. Add scheduler defaults only for jobs with clear ownership and observable output.

## Policy Rules

- Prefer explicit allowlists over broad shell access.
- Keep network disabled in bash unless there is a strong, documented exception.
- Keep workspace prompts task-specific; do not duplicate schedule or path data inside scheduler job prompts if those values are stored elsewhere.

## Repo Reality

- If `workspaces/` is missing, scaffold docs first and note the missing runtime hooks instead of guessing final runtime shape.
- Keep the seed compatible with a mixed Node and Python system; the README shows both runtimes.
- Distinguish Codex helper skills in `.codex/skills/` from runtime DumplBot skills planned for `skills/<skill-id>/skill.yaml`.

## Reference

- Read `references/workspace-shape.md` for the baseline fields and stop conditions.
