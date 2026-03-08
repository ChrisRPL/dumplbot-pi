# Policy

This file defines the safety baseline for DumplBot.

## Security Model

- Secrets live only in the daemon-side config surface.
- UI process never stores API keys.
- Agent runs happen inside `bubblewrap`.
- Current sandbox baseline mounts the active workspace read-write and only a minimal read-only runtime surface.
- Workspace mounts should be writable only where needed.
- Everything outside the active workspace should be read-only or absent by default.

## Tool Policy

- Tool allowlist should be selected per skill.
- File reads and writes should stay inside the active workspace.
- Bash should use prefix allowlists.
- Bash network access should be denied by default.
- Current sandbox baseline unshares network for sandboxed runner processes.
- Web access should go through explicit web tools, not arbitrary shell commands.

## Permission Modes

- `strict`: minimal tool set, strong allowlists, safer defaults.
- `balanced`: default day-to-day mode.
- `permissive`: explicit override for trusted local work only.

## Resource Controls

- Prefer lightweight runtimes on Pi.
- Add memory caps for Node.js services.
- Add systemd `MemoryMax`, `CPUQuota`, and timeouts.
- Add run timeouts for `agent-runner`.

## Operational Rules

- Add stop/cancel support early so runaway runs are recoverable.
- Log denied actions with enough detail to debug policy mismatches.
- Policy changes should be visible in docs and config, not hidden in code only.
