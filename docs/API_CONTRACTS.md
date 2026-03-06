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
{"text":"run tests","workspace":"default","skill":"coding"}
```

- `workspace` optional.
- `skill` optional.
- Response: SSE stream using the event types above.
- Workspace selection order when `workspace` is omitted: `active_workspace` from `/api/config`, then `runtime.default_workspace`.
- Skill selection order when `skill` is omitted: `runtime.default_skill`.
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

### `GET /api/workspaces`

- Return workspace list and basic metadata.
- Current response shape:

```json
{
  "workspaces": [
    {"id":"default","has_instructions":true,"is_active":true}
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

### `GET /api/jobs`

- Return scheduler job list plus latest run status.

### `POST /api/jobs`

- Create or update a scheduler job.

### `GET /api/config`

- Return non-secret config needed for UI.
- Current response shape:

```json
{
  "runtime": {
    "default_workspace": "default",
    "default_skill": "coding",
    "active_workspace": "default"
  }
}
```

- `active_workspace` may be `null`.

### `POST /api/config`

- Update allowed mutable config values.
- Keep LAN-only once remote config exists.
- Current mutable field:

```json
{
  "runtime": {
    "active_workspace": "default"
  }
}
```

- Set `"active_workspace": null` to clear and fall back to `default_workspace`.
- Status codes:
  - `200` update applied.
  - `404` workspace does not exist.
  - `400` invalid JSON or missing `runtime.active_workspace`.

## Agent Runner Stream

- Input: JSON on stdin from `dumplbotd`.
- Current required input fields: `prompt`, `toolAllowlist`; optional: `workspace`, `skill`.
- Output: JSONL over stdout.
- Event vocabulary should match the SSE event shapes closely enough for simple translation.

## Stability Rules

- Additive changes preferred.
- Do not rename event types casually; UI code will key off them.
- Keep audio upload and talk streaming separable so PTT can evolve without breaking text-only mode.
