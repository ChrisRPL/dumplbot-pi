# API Contracts

Lock these contracts early so UI, host, and runner work can proceed in parallel.

## SSE Event Stream

The daemon streams events back to the UI over Server-Sent Events.

### `status`

```json
{"message":"Transcribing audio"}
```

### `stt`

```json
{"text":"open the logs","confidence":0.93}
```

`confidence` stays optional.

### `token`

```json
{"text":"Hello"}
```

### `tool`

```json
{"name":"bash","detail":"pytest tests/smoke"}
```

`detail` stays optional.

### `done`

```json
{"summary":"Run finished"}
```

`summary` stays optional.

### `error`

```json
{"message":"Workspace not found"}
```

## HTTP Endpoints

### `GET /health`

- Purpose: liveness check for UI, installer, and systemd health probes.
- Baseline response: `200 OK`.

### `POST /api/talk`

- Request body:

```json
{"text":"run tests","workspace":"default","skill":"coding","tools":["read_file","bash"]}
```

- `workspace` optional.
- `skill` optional.
- `tools` optional; when present, it must be a non-empty string array and each value must be allowed by the selected skill.
- Response: SSE stream using the event types above.
- Workspace selection order when `workspace` is omitted: `active_workspace` from `/api/config`, then `runtime.default_workspace`.
- Skill selection order when `skill` is omitted: `active_skill` from `/api/config`, then workspace `default_skill`, then `runtime.default_skill`.
- Host emits skill prelude metadata before runner events:
  - `status`: `Using skill <skill-id>`
  - `tool`: `{"name":"skill-policy","detail":"<comma-separated allowlist>"}`
- Policy denials are streamed as terminal SSE events (HTTP `200`) instead of JSON errors:
  - `status`: `{"message":"Policy check failed","phase":"policy"}`
  - `error`: `{"code":"<policy-code>","message":"<policy-message>"}`
- Host enforces `runtime.max_run_seconds` per run.
  - Timeout is streamed as terminal SSE `error`: `{"message":"runner timed out after <N>s"}`
- Successful and terminal runner outcomes append workspace-local run history under `workspaces/<id>/.dumplbot-history.json`.
- Current policy denial codes:
  - `policy_tools_denied`
  - `policy_tools_invalid`
  - `policy_mode_denied`
  - `policy_bash_prefix_required`
- Returns `404` with `{"error":"workspace not found"}` when the selected workspace does not exist.
- Returns `404` with `{"error":"skill not found"}` when the selected skill does not exist.

### `POST /api/audio`

- Request: multipart upload with one WAV file.
- Initial response:

```json
{"audio_id":"a1b2c3"}
```

- Follow-up: either hand the client to `/api/talk` or expose a dedicated audio-run stream path later.
- `POST /api/audio/:audioId/talk` returns `404` with `{"error":"workspace not found"}` when workspace selection is invalid.
- `POST /api/audio/:audioId/talk` returns `404` with `{"error":"skill not found"}` when skill selection is invalid.
- `POST /api/audio/:audioId/talk` uses the same policy-denial SSE mapping as `/api/talk`.
- `POST /api/audio/:audioId/talk` uses the same timeout SSE mapping as `/api/talk`.
- Successful and terminal runner outcomes append workspace-local run history under `workspaces/<id>/.dumplbot-history.json`.

### `GET /api/skills`

- Return installed skills plus policy metadata.
- Current response shape:

```json
{
  "skills": [
    {"id":"coding","permission_mode":"balanced","tool_allowlist":["read_file","edit_file","bash","web_search"],"bash_prefix_allowlist":["git status","git diff","npm test","npm run","ls","cat"],"is_active":true}
  ]
}
```

### `GET /api/workspaces`

- Return workspace list and basic metadata.
- Current response shape:

```json
{
  "workspaces": [
    {
      "id":"default",
      "has_instructions":true,
      "is_active":true,
      "default_skill":null,
      "attached_repos":[
        {"id":"dumplbot-pi","path":"/Users/krzysztof/Projects/oss/dumplbot-pi","mount_path":"repos/dumplbot-pi"}
      ]
    }
  ]
}
```

### `POST /api/workspaces`

- Create a workspace from validated input.
- Request body:

```json
{"id":"project-alpha","instructions":"# Workspace\n\n## Goal\n\n- Project-specific guidance.\n"}
```

- `instructions` optional; daemon writes `workspaces/<id>/CLAUDE.md`.
- Success response:

```json
{"id":"project-alpha","has_instructions":true}
```

- Status codes:
  - `201` when created.
  - `409` when workspace already exists.
  - `400` for invalid JSON or invalid workspace input.

### `POST /api/workspaces/:workspaceId/repos`

- Attach one local repo directory to an existing workspace.
- Request body:

```json
{"id":"dumplbot-pi","path":"/Users/krzysztof/Projects/oss/dumplbot-pi"}
```

- Success response:

```json
{"id":"dumplbot-pi","path":"/Users/krzysztof/Projects/oss/dumplbot-pi","mount_path":"repos/dumplbot-pi"}
```

- Host persists attachment metadata in the workspace-local metadata file and creates a stable `repos/<id>` symlink inside the workspace root.
- Status codes:
  - `201` when attached.
  - `404` when workspace does not exist.
  - `409` when repo id is already attached.
  - `400` for invalid JSON or invalid repo input.

### `POST /api/workspaces/:workspaceId/config`

- Update workspace-local metadata.
- Current mutable field:

```json
{"default_skill":"research"}
```

- Set `"default_skill": null` to clear the workspace-local override.
- Success response:

```json
{
  "id":"default",
  "default_skill":"research",
  "attached_repos":[]
}
```

- Status codes:
  - `200` when updated.
  - `404` when workspace or skill does not exist.
  - `400` for invalid JSON or invalid field type.

### `GET /api/workspaces/:workspaceId/history`

- Return retained run-history entries for one workspace.
- Supports `?limit=<n>` and `?offset=<n>` like the scheduler history route.
- Current response shape:

```json
{
  "workspace_id":"default",
  "total":2,
  "returned":1,
  "history":[
    {
      "completed_at":"2026-03-13T12:00:00.000Z",
      "prompt":"ping",
      "transcript":null,
      "skill":"coding",
      "source":"text",
      "status":"success",
      "summary":"Runner scaffold completed."
    }
  ]
}
```

- `source` is `text` for `/api/talk` runs and `audio` for `/api/audio/:audioId/talk` runs.
- `history` currently retains the newest 20 run entries per workspace.
- Status codes:
  - `200` when the workspace exists.
  - `404` when the workspace does not exist.
  - `400` for invalid `limit` or `offset` values.

### `GET /api/jobs`

- Return scheduler job list plus latest run status.
- Current response shape:

```json
{
  "jobs": [
    {
      "id":"daily-status",
      "prompt":"summarize repo state",
      "schedule":"0 * * * *",
      "workspace":"default",
      "skill":"coding",
      "enabled":true,
      "last_run_at":null,
      "last_status":null,
      "last_result":null,
      "last_duration_ms":null,
      "last_error":null,
      "failure_count":0,
      "last_success_at":null,
      "history":[]
    }
  ]
}
```

### `GET /api/jobs/:jobId`

- Return one scheduler job with the same payload shape used in `GET /api/jobs`.
- Status codes:
  - `200` when found.
  - `404` when the job does not exist.
  - `400` when the job id is invalid.

### `GET /api/jobs/:jobId/history`

- Return retained run-history entries for one scheduler job.
- Optional query params:
  - `limit=<positive-int>` returns only the newest `N` retained entries.
  - `offset=<non-negative-int>` skips the newest `N` retained entries before `limit` is applied.
- Response shape:

```json
{
  "job_id":"daily-status",
  "total":12,
  "returned":5,
  "history":[
    {"completed_at":"2026-03-12T10:00:00.000Z","status":"success","result":"Run finished"}
  ]
}
```

- Status codes:
  - `200` when found.
  - `404` when the job does not exist.
  - `400` when the job id, `limit`, or `offset` is invalid.

### `POST /api/jobs`

- Create or update a scheduler job.
- Request body:

```json
{
  "id":"daily-status",
  "prompt":"summarize repo state",
  "schedule":"0 * * * *",
  "workspace":"default",
  "skill":"coding",
  "enabled":true
}
```

- `schedule` accepts:
  - raw cron expressions like `"0 * * * *"`
  - preset syntax: `"hourly"`, `"daily 09:15"`, `"weekly mon 08:30"`
  - tiny natural phrases: `"every hour"`, `"every day at 09:15"`, `"every monday at 08:30"`
- `workspace` and `skill` optional; when present they must resolve to existing workspace/skill ids.
- Success response matches the job object in `GET /api/jobs`.
- Background scheduler runs update `last_run_at`, `last_status`, `last_result`, `last_duration_ms`, `last_error`, `failure_count`, `last_success_at`, and append `{completed_at,status,result}` entries to `history`.
- `history` currently retains the newest 20 run entries per job.
- Status codes:
  - `200` when created or updated.
  - `404` when workspace or skill does not exist.
  - `400` for invalid JSON or invalid job input.

### `PATCH /api/jobs/:jobId`

- Patch one scheduler job in place.
- Mutable fields:

```json
{
  "prompt":"summarize repo state via patch",
  "schedule":"45 * * * *",
  "workspace":null,
  "skill":"research",
  "enabled":false
}
```

- At least one mutable field is required.
- Omitted fields keep their existing values.
- Success response matches the job object in `GET /api/jobs`.
- Status codes:
  - `200` when updated.
  - `404` when the job, workspace, or skill does not exist.
  - `400` for invalid JSON, invalid field types, or an empty patch body.

### `POST /api/jobs/:jobId/enable`

- Enable one scheduler job.
- Success response matches the job object in `GET /api/jobs`.
- Status codes:
  - `200` when updated.
  - `404` when the job does not exist.
  - `400` when the job id is invalid.

### `POST /api/jobs/:jobId/disable`

- Disable one scheduler job.
- Success response matches the job object in `GET /api/jobs`.
- Status codes:
  - `200` when updated.
  - `404` when the job does not exist.
  - `400` when the job id is invalid.

### `DELETE /api/jobs/:jobId`

- Delete one scheduler job.
- Success response:

```json
{"ok":true}
```

- Status codes:
  - `200` when deleted.
  - `404` when the job does not exist.
  - `400` when the job id is invalid.

### `GET /api/config`

- Return non-secret config needed for UI.
- Current response shape:

```json
{
  "runtime": {
    "default_workspace": "default",
    "default_skill": "coding",
    "safety_mode": "balanced",
    "active_workspace": "default",
    "active_skill": "coding"
  }
}
```

- `active_workspace` may be `null`.
- `active_skill` may be `null`.

### `GET /setup`

- Return the LAN-only setup shell for phone/browser appliance setup.
- The current shell reads `/api/config`, `/api/workspaces`, `/api/skills`, `/api/setup/status`, `/api/setup/health`, `/api/setup/system`, and `/api/config/export`, then saves non-secret runtime config back through `POST /api/config`, setup keys through `POST /api/setup/secrets`, and raw config imports through `POST /api/config/import`.
- Status codes:
  - `200` with `text/html`.
  - `403` when the client is outside localhost or a private LAN range.

### `GET /api/setup/status`

- Return setup-only secret presence signals without exposing secret values.
- Current response shape:

```json
{
  "secrets": {
    "anthropic_api_key_configured": false,
    "openai_api_key_configured": true,
    "secrets_file_present": true
  }
}
```

- `secrets_file_present` only reports whether the configured secrets file exists.
- Provider booleans only report whether a non-empty key is present in that file.
- Status codes:
  - `200` when requested from localhost or a private LAN range.
  - `403` otherwise.

### `POST /api/setup/secrets`

- Update one or more setup-managed provider keys without returning the secret values.
- Current request shape:

```json
{
  "openai_api_key": "sk-...",
  "anthropic_api_key": "sk-ant-..."
}
```

- Omit a field to leave the current value unchanged.
- Empty or blank-only payloads are rejected.
- Success response reuses the `GET /api/setup/status` shape.
- Status codes:
  - `200` update applied.
  - `400` invalid JSON or missing non-empty secret fields.
  - `403` when the client is outside localhost or a private LAN range.

### `GET /api/setup/system`

- Return setup diagnostics for bind reachability and restart-required hints.
- Current response shape:

```json
{
  "system": {
    "active_server": {
      "bind": "127.0.0.1:4123",
      "host": "127.0.0.1",
      "port": 4123
    },
    "configured_server": {
      "bind": "0.0.0.0:4123",
      "host": "0.0.0.0",
      "port": 4123
    },
    "lan_setup_ready": false,
    "restart_required": true,
    "status_message": "Restart dumplbotd to apply configured bind 0.0.0.0:4123."
  }
}
```

- `active_server` reflects the current daemon listener.
- `configured_server` reflects the current `config.yaml` server section.
- `restart_required` is true when the live listener and config file differ.
- `action_instructions` give safe next steps for old loopback-only installs or pending bind restarts.
- Status codes:
  - `200` when requested from localhost or a private LAN range.
  - `403` otherwise.

### `GET /api/setup/health`

- Return setup-focused readiness summary for the current daemon.
- Current response shape:

```json
{
  "health": {
    "daemon_healthy": true,
    "scheduler_enabled": false,
    "scheduler_poll_interval_seconds": 15,
    "stt_ready": true,
    "stt_model": "whisper-1",
    "stt_language": "auto",
    "status_message": "Daemon is healthy. Scheduler is disabled in config."
  }
}
```

- `stt_ready` reflects whether the current secrets/config allow transcription calls.
- Status codes:
  - `200` when requested from localhost or a private LAN range.
  - `403` otherwise.

### `GET /api/config/export`

- Return the current host config file contents for setup export/import editing.
- Current response shape:

```json
{
  "config": "runtime:\n  default_workspace: default\n  default_skill: coding\n  permission_mode: balanced\n"
}
```

- Status codes:
  - `200` when requested from localhost or a private LAN range.
  - `403` otherwise.

### `POST /api/config/import`

- Replace the host config file with imported YAML text after validating the runtime section.
- Current request shape:

```json
{
  "config": "runtime:\n  default_workspace: default\n  default_skill: coding\n  permission_mode: balanced\n"
}
```

- The imported config must include `runtime.default_workspace`, `runtime.default_skill`, and `runtime.permission_mode`.
- `runtime.default_workspace` must resolve to an existing workspace id.
- `runtime.default_skill` must resolve to an existing skill id.
- `runtime.permission_mode` must be one of `strict`, `balanced`, or `permissive`.
- `runtime.max_run_seconds`, when present, must be a positive integer.
- If a `server` section is present, it must include both `host` and `port`.
- `server.host`, when present, must be one of `127.0.0.1`, `0.0.0.0`, `::1`, or `::`.
- `server.port`, when present, must be a positive integer.
- Status codes:
  - `200` import applied.
  - `400` invalid JSON or invalid imported config.
  - `403` when the client is outside localhost or a private LAN range.

### `POST /api/config`

- Update allowed mutable config values.
- Keep LAN-only once remote config exists.
- Current mutable field:

```json
{
  "runtime": {
    "default_workspace": "default",
    "default_skill": "coding",
    "safety_mode": "balanced",
    "active_workspace": "default",
    "active_skill": "coding"
  }
}
```

- `default_workspace` must resolve to an existing workspace id.
- `default_skill` must resolve to an existing skill id.
- `safety_mode` must be one of `strict`, `balanced`, or `permissive`.
- Set `"active_workspace": null` to clear and fall back to `default_workspace`.
- Set `"active_skill": null` to clear and fall back to `default_skill`.
- Status codes:
  - `200` update applied.
  - `404` workspace does not exist.
  - `404` skill does not exist.
  - `400` invalid JSON, invalid safety mode, or missing all runtime config fields.
  - `403` when the client is outside localhost or a private LAN range.

## Agent Runner Stream

- Input: JSON on stdin from `dumplbotd`.
- Current required top-level input fields: `prompt`, `toolAllowlist`, `policy`; optional: `workspace`, `skill`.
- `policy` object shape:

```json
{
  "workspace":"default",
  "skill":"coding",
  "toolAllowlist":["read_file","bash"],
  "bashCommandPrefixAllowlist":["git status","git diff","npm test","npm run","ls","cat"],
  "permissionMode":"balanced"
}
```

- Current runner guardrails:
  - host pre-run strict-mode clamp removes `bash` from requested allowlists and denies if no tools remain.
  - host denies `bash` usage when selected skill has no `bash_prefix_allowlist`.
  - `permissionMode: "strict"` rejects `bash` in `toolAllowlist`.
  - `bash` policies require non-empty `bashCommandPrefixAllowlist`.
  - `bash` tool events must match an allowed command prefix.
  - current scaffold runner executes prompts with `bash: ...` as direct argv processes, without shell expansion.
  - non-internal tool events are blocked if not listed in `policy.toolAllowlist`.
- Runner rejects mismatches between top-level allowlist and policy allowlist.
- Output: JSONL over stdout.
- Event vocabulary should match the SSE event shapes closely enough for simple translation.

## Stability Rules

- Additive changes preferred.
- Do not rename event types casually; UI code will key off them.
- Keep audio upload and talk streaming separable so PTT can evolve without breaking text-only mode.
