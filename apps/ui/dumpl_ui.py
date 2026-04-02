#!/usr/bin/env python3

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import queue
import shlex
import signal
import subprocess
import sys
import textwrap
import threading
import time
from typing import Any, Iterator, Optional
import urllib.error
import urllib.parse
import urllib.request

SCREEN_WIDTH = 48
WHISPLAY_TEXT_WIDTH = 28
WHISPLAY_DEFAULT_WIDTH = 170
WHISPLAY_DEFAULT_HEIGHT = 320
PREVIEW_DEFAULT_SCALE = 3
WHISPLAY_BACKGROUND = (10, 15, 20)
WHISPLAY_HEADER_BACKGROUND = (18, 34, 48)
WHISPLAY_FOREGROUND = (242, 244, 247)
LIVE_RENDER_BOOT_SECONDS = 0.16
LIVE_RENDER_PHASE_TRANSITION_SECONDS = 0.08
BUTTON_POLL_INTERVAL_SECONDS = 0.05
BUTTON_LONG_PRESS_SECONDS = 1.2
HOME_NAVIGATION_TARGET_SEQUENCE = ("workspace", "skill", "scheduler", "diagnostics", "voice", "transcript", "audio", "error")
SCHEDULER_SCREEN_SEQUENCE = ("summary", "detail", "history")
WORKSPACE_HISTORY_COMMAND_LIMIT = 8
WORKSPACE_HISTORY_SCREEN_LIMIT = 4
JOB_HISTORY_COMMAND_LIMIT = 8
JOB_HISTORY_SCREEN_LIMIT = 4
JOB_DETAIL_HISTORY_LIMIT = 3
WHISPLAY_PHASE_RGB = {
    "Home": (182, 205, 109),
    "Idle": (124, 207, 106),
    "Diagnostics": (196, 155, 46),
    "Jobs": (100, 210, 199),
    "Workspaces": (98, 192, 255),
    "Skills": (124, 207, 106),
    "Listening": (98, 192, 255),
    "Transcribing": (100, 210, 199),
    "Thinking": (242, 193, 78),
    "Tool": (242, 140, 40),
    "Answer": (124, 207, 106),
    "Saved": (124, 207, 106),
    "Error": (255, 122, 89),
}


@dataclass
class ScreenState:
    phase: str = "Idle"
    status: str = "Ready"
    prompt: str = ""
    transcript: Optional[str] = None
    tool_banner: Optional[str] = None
    answer: str = ""
    error: Optional[str] = None
    visual: Optional[dict[str, Any]] = None


@dataclass
class UiRuntimeConfig:
    audio_capture_cmd: str = "arecord"
    ptt_wav_path: str = "/tmp/dumplbot/ptt.wav"
    button_debug: bool = False


@dataclass(frozen=True)
class SchedulerNavigationState:
    screen_mode: str = "summary"
    job_id: Optional[str] = None
    history_offset: int = 0


@dataclass(frozen=True)
class HomeNavigationState:
    screen_mode: str = "home"
    focused_target: str = HOME_NAVIGATION_TARGET_SEQUENCE[0]


def parse_bool(value: str) -> bool:
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class ButtonEvent:
    kind: str
    value: Optional[str] = None


@dataclass
class CaptureFlowState:
    phase: str = "Idle"
    saved_path: Optional[str] = None
    error: Optional[str] = None


def reduce_button_event(
    state: CaptureFlowState,
    event: ButtonEvent,
) -> CaptureFlowState:
    if event.kind == "press":
        if state.phase in {"Idle", "Saved", "Error"}:
            return CaptureFlowState(phase="Listening")
        return state

    if event.kind == "release":
        if state.phase == "Listening":
            return CaptureFlowState(
                phase="Saved",
                saved_path=event.value or state.saved_path,
            )
        return state

    if event.kind == "long_press":
        if state.phase == "Listening":
            return CaptureFlowState()
        return state

    if event.kind == "capture_failed":
        return CaptureFlowState(
            phase="Error",
            error=event.value or "Audio capture failed",
        )

    if event.kind == "reset":
        return CaptureFlowState()

    return state


def clamp_progress(value: float) -> float:
    return max(0.0, min(1.0, value))


def build_capture_screen_state(
    state: CaptureFlowState,
    hold_progress: float = 0.0,
) -> ScreenState:
    if state.phase == "Listening":
        return ScreenState(
            phase="Listening",
            status="Recording audio",
            visual={
                "kind": "stage",
                "title": "Listening",
                "badge": "rec",
                "lead": "Release to send",
                "detail": "Keep holding to record.\nLong hold cancels this capture.",
                "footer": "walkie-talkie mode",
                "progress": clamp_progress(hold_progress),
                "progress_label": "hold to cancel",
            },
        )

    if state.phase == "Saved":
        return ScreenState(
            phase="Saved",
            status="Audio capture saved",
            transcript=state.saved_path,
            visual={
                "kind": "stage",
                "title": "Saved",
                "badge": "wav",
                "lead": "Audio saved",
                "detail": truncate_visual_text(state.saved_path, 42) if isinstance(state.saved_path, str) else "Ready to upload and run.",
                "footer": "sending to host",
            },
        )

    if state.phase == "Error":
        return ScreenState(
            phase="Error",
            status="Audio capture failed",
            error=state.error or "Unknown error",
            visual={
                "kind": "stage",
                "title": "Error",
                "badge": "mic",
                "lead": "Capture failed",
                "detail": state.error or "Unknown error",
                "footer": "release, then try again",
            },
        )

    return ScreenState(
        phase="Idle",
        status="Ready for push-to-talk",
        visual={
            "kind": "stage",
            "title": "Ready",
            "badge": "ptt",
            "lead": "Hold to record",
            "detail": "Release sends audio.\nLong hold cancels before upload.",
            "footer": "push-to-talk idle",
        },
    )


def render_capture_flow(
    renderer: "ConsoleRenderer",
    state: CaptureFlowState,
    hold_progress: float = 0.0,
) -> None:
    renderer.render(build_capture_screen_state(state, hold_progress=hold_progress))


def emit_button_debug(enabled: bool, message: str) -> None:
    if not enabled:
        return

    sys.stderr.write(f"[button] {message}\n")
    sys.stderr.flush()


def process_capture_button_event(
    state: CaptureFlowState,
    event: ButtonEvent,
    recorder: "ArecordRecorder",
) -> CaptureFlowState:
    if event.kind == "press" and state.phase in {"Idle", "Saved", "Error"}:
        try:
            recorder.start()
        except FileNotFoundError as error:
            return reduce_button_event(state, ButtonEvent("capture_failed", str(error)))
        except (RuntimeError, subprocess.SubprocessError) as error:
            return reduce_button_event(state, ButtonEvent("capture_failed", str(error)))

    if event.kind == "release" and state.phase == "Listening":
        try:
            saved_path = recorder.stop()
        except (RuntimeError, subprocess.SubprocessError) as error:
            recorder.cancel()
            return reduce_button_event(state, ButtonEvent("capture_failed", str(error)))

        event = ButtonEvent("release", str(saved_path))

    if event.kind == "long_press" and state.phase == "Listening":
        recorder.cancel()

    return reduce_button_event(state, event)


def load_ui_runtime_config(
    config_path: str = "/etc/dumplbot/config.yaml",
) -> UiRuntimeConfig:
    config = UiRuntimeConfig()
    path = Path(os.environ.get("DUMPLBOT_CONFIG_PATH", config_path))

    if path.is_file():
        in_ui_block = False

        for raw_line in path.read_text(encoding="utf-8").splitlines():
            stripped = raw_line.strip()

            if not stripped or stripped.startswith("#"):
                continue

            if not raw_line.startswith(" "):
                in_ui_block = stripped == "ui:"
                continue

            if not in_ui_block or not raw_line.startswith("  ") or ":" not in stripped:
                continue

            key, _, raw_value = stripped.partition(":")
            value = raw_value.strip().strip("'\"")

            if key == "audio_capture_cmd" and value:
                config.audio_capture_cmd = value
            elif key == "ptt_wav_path" and value:
                config.ptt_wav_path = value
            elif key == "button_debug" and value:
                config.button_debug = parse_bool(value)

    config.audio_capture_cmd = os.environ.get(
        "DUMPLBOT_UI_AUDIO_CAPTURE_CMD",
        config.audio_capture_cmd,
    )
    config.ptt_wav_path = os.environ.get(
        "DUMPLBOT_UI_PTT_WAV_PATH",
        config.ptt_wav_path,
    )
    if "DUMPLBOT_UI_BUTTON_DEBUG" in os.environ:
        config.button_debug = parse_bool(os.environ["DUMPLBOT_UI_BUTTON_DEBUG"])
    return config


def iter_sse_events(response: Any) -> Iterator[tuple[str, dict[str, Any]]]:
    current_event = "message"

    for raw_line in response:
        line = raw_line.decode("utf-8").strip()

        if not line:
            current_event = "message"
            continue

        if line.startswith("event: "):
            current_event = line.removeprefix("event: ")
            continue

        if line.startswith("data: "):
            data = json.loads(line.removeprefix("data: "))
            yield current_event, data


def upload_audio_file(base_url: str, audio_path: str) -> str:
    boundary = f"----dumplbot-{int(time.time() * 1000)}"
    audio_bytes = Path(audio_path).read_bytes()
    filename = Path(audio_path).name or "ptt.wav"
    multipart_chunks = [
        f"--{boundary}\r\n".encode("utf-8"),
        (
            "Content-Disposition: form-data; "
            f'name="file"; filename="{filename}"\r\n'
        ).encode("utf-8"),
        b"Content-Type: audio/wav\r\n\r\n",
        audio_bytes,
        f"\r\n--{boundary}--\r\n".encode("utf-8"),
    ]
    request = urllib.request.Request(
        f"{base_url}/api/audio",
        data=b"".join(multipart_chunks),
        headers={"content-type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )

    with urllib.request.urlopen(request) as response:
        payload = json.loads(response.read().decode("utf-8"))

    audio_id = payload.get("audio_id")

    if not isinstance(audio_id, str) or not audio_id:
        raise RuntimeError("audio upload response missing audio_id")

    return audio_id


def request_json(
    base_url: str,
    path: str,
    method: str = "GET",
    payload: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    request = urllib.request.Request(
        f"{base_url}{path}",
        data=json.dumps(payload).encode("utf-8") if payload is not None else None,
        headers={"content-type": "application/json"} if payload is not None else {},
        method=method,
    )

    try:
        with urllib.request.urlopen(request) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace").strip()
        raise RuntimeError(detail or f"{method} {path} failed with HTTP {error.code}") from error
    except urllib.error.URLError as error:
        reason = getattr(error, "reason", error)
        detail = str(reason).strip() or str(error)
        raise RuntimeError(
            f'cannot reach dumplbotd at {base_url}; start it first with "npm run dev:host" or pass --host-url '
            f"(request: {method} {path}; detail: {detail})"
        ) from error


def get_runtime_config_entry(base_url: str) -> dict[str, Any]:
    payload = request_json(base_url, "/api/config")
    runtime = payload.get("runtime")

    if not isinstance(runtime, dict):
        raise RuntimeError("config response is invalid")

    return runtime


def get_setup_health_entry(base_url: str) -> dict[str, Any]:
    payload = request_json(base_url, "/api/setup/health")
    health = payload.get("health")

    if not isinstance(health, dict):
        raise RuntimeError("setup health response is invalid")

    return health


def get_setup_system_entry(base_url: str) -> dict[str, Any]:
    payload = request_json(base_url, "/api/setup/system")
    system = payload.get("system")

    if not isinstance(system, dict):
        raise RuntimeError("setup system response is invalid")

    return system


def get_setup_first_run_entry(base_url: str) -> dict[str, Any]:
    payload = request_json(base_url, "/api/setup/first-run")
    first_run = payload.get("first_run")

    if not isinstance(first_run, dict):
        raise RuntimeError("setup first-run response is invalid")

    return first_run


def summarize_runtime_selection(
    runtime: dict[str, Any],
    active_key: str,
    default_key: str,
) -> str:
    active_value = runtime.get(active_key)

    if isinstance(active_value, str) and active_value:
        return active_value

    default_value = runtime.get(default_key)

    if isinstance(default_value, str) and default_value:
        return f"{default_value} (default)"

    return "(none)"


def summarize_home_next_action_detail(
    first_run_ready: bool,
    next_action_label: str,
    next_action_detail: str,
) -> str:
    if first_run_ready:
        return "short press browse\nlong press open"

    normalized_label = next_action_label.strip().lower()

    if normalized_label == "add key":
        return "open setup on wi-fi"

    if normalized_label == "check audio":
        return "record and play 3 sec"

    collapsed_detail = " ".join(next_action_detail.strip().split())

    if collapsed_detail:
        return truncate_visual_text(collapsed_detail, 44)

    return "follow setup hint"


def get_debug_voice_entry(base_url: str) -> dict[str, Any]:
    payload = request_json(base_url, "/api/debug/voice")
    transcript = payload.get("transcript")
    audio = payload.get("audio")
    error = payload.get("error")

    if not isinstance(transcript, dict) or not isinstance(audio, dict) or not isinstance(error, dict):
        raise RuntimeError("debug voice response is invalid")

    return {
        "transcript": transcript,
        "audio": audio,
        "error": error,
    }


def parse_debug_timestamp(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None

    normalized_value = value.replace("Z", "+00:00")

    try:
        parsed = datetime.fromisoformat(normalized_value)
    except ValueError:
        return None

    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)

    return parsed.astimezone(timezone.utc)


def summarize_debug_age(value: Any) -> str:
    parsed = parse_debug_timestamp(value)

    if parsed is None:
        return "(unknown age)"

    age_seconds = max(0, int((datetime.now(timezone.utc) - parsed).total_seconds()))

    if age_seconds < 60:
        return f"{age_seconds}s ago"

    age_minutes = age_seconds // 60

    if age_minutes < 60:
        return f"{age_minutes}m ago"

    age_hours = age_minutes // 60

    if age_hours < 24:
        return f"{age_hours}h ago"

    age_days = age_hours // 24
    return f"{age_days}d ago"


def format_debug_detail_lines(
    path_value: Any,
    updated_at: Any,
) -> str:
    lines: list[str] = []

    if isinstance(path_value, str) and path_value:
        lines.append(path_value)

    if isinstance(updated_at, str) and updated_at:
        lines.append(f"updated: {updated_at}")
        lines.append(f"age: {summarize_debug_age(updated_at)}")

    return "\n".join(lines)


def normalize_home_navigation_state(
    screen_mode: str,
    focused_target: Optional[str] = None,
) -> HomeNavigationState:
    selected_target = focused_target

    if selected_target not in HOME_NAVIGATION_TARGET_SEQUENCE:
        if screen_mode in HOME_NAVIGATION_TARGET_SEQUENCE:
            selected_target = screen_mode
        else:
            selected_target = HOME_NAVIGATION_TARGET_SEQUENCE[0]

    if screen_mode != "home" and screen_mode not in HOME_NAVIGATION_TARGET_SEQUENCE:
        raise RuntimeError("home navigation mode is invalid")

    return HomeNavigationState(
        screen_mode=screen_mode,
        focused_target=selected_target,
    )


def parse_non_negative_int(value: str, field_name: str) -> int:
    try:
        parsed_value = int(value)
    except ValueError as error:
        raise RuntimeError(f"{field_name} must be a non-negative integer") from error

    if parsed_value < 0:
        raise RuntimeError(f"{field_name} must be a non-negative integer")

    return parsed_value


def parse_non_negative_int_arg(value: str) -> int:
    try:
        return parse_non_negative_int(value, "history offset")
    except RuntimeError as error:
        raise argparse.ArgumentTypeError(str(error)) from error


def list_workspace_entries(base_url: str) -> list[dict[str, Any]]:
    payload = request_json(base_url, "/api/workspaces")
    workspaces = payload.get("workspaces")

    if not isinstance(workspaces, list):
        raise RuntimeError("workspace list response is invalid")

    return [workspace for workspace in workspaces if isinstance(workspace, dict)]


def get_workspace_entry(base_url: str, workspace_id: str) -> dict[str, Any]:
    normalized_workspace_id = workspace_id.strip().lower()

    for workspace in list_workspace_entries(base_url):
        if workspace.get("id") == normalized_workspace_id:
            return workspace

    raise RuntimeError("workspace not found")


def get_workspace_history(
    base_url: str,
    workspace_id: str,
    limit: Optional[int] = None,
    offset: int = 0,
) -> dict[str, Any]:
    path = f"/api/workspaces/{workspace_id.strip().lower()}/history"
    query_parts: list[str] = []

    if isinstance(limit, int) and limit > 0:
        query_parts.append(f"limit={limit}")

    if offset < 0:
        raise RuntimeError("workspace history offset is invalid")

    if offset > 0:
        query_parts.append(f"offset={offset}")

    if query_parts:
        path = f"{path}?{'&'.join(query_parts)}"

    payload = request_json(base_url, path)

    if not isinstance(payload, dict) or not isinstance(payload.get("workspace_id"), str):
        raise RuntimeError("workspace history response is invalid")

    return payload


def list_workspace_files(
    base_url: str,
    workspace_id: str,
) -> dict[str, Any]:
    payload = request_json(base_url, f"/api/workspaces/{workspace_id.strip().lower()}/files")

    if not isinstance(payload, dict) or not isinstance(payload.get("workspace_id"), str):
        raise RuntimeError("workspace files response is invalid")

    return payload


def get_workspace_file(
    base_url: str,
    workspace_id: str,
    file_path: str,
) -> dict[str, Any]:
    encoded_path = urllib.parse.quote(file_path, safe="/._-")
    payload = request_json(
        base_url,
        f"/api/workspaces/{workspace_id.strip().lower()}/files?path={encoded_path}",
    )

    if not isinstance(payload, dict) or not isinstance(payload.get("workspace_id"), str):
        raise RuntimeError("workspace file response is invalid")

    return payload


def create_workspace_entry(
    base_url: str,
    workspace_id: str,
    instructions: Optional[str] = None,
) -> dict[str, Any]:
    payload: dict[str, str] = {
        "id": workspace_id,
    }

    if instructions is not None:
        payload["instructions"] = instructions

    return request_json(
        base_url,
        "/api/workspaces",
        method="POST",
        payload=payload,
    )


def update_active_workspace(
    base_url: str,
    workspace: Optional[str],
) -> Optional[str]:
    payload = request_json(
        base_url,
        "/api/config",
        method="POST",
        payload={"runtime": {"active_workspace": workspace}},
    )
    runtime = payload.get("runtime")

    if not isinstance(runtime, dict):
        raise RuntimeError("config response is invalid")

    active_workspace = runtime.get("active_workspace")

    if active_workspace is None:
        return None

    if not isinstance(active_workspace, str) or not active_workspace:
        raise RuntimeError("config response active_workspace is invalid")

    return active_workspace


def cycle_workspace(base_url: str) -> str:
    workspaces = list_workspace_entries(base_url)

    if not workspaces:
        raise RuntimeError("no workspaces available")

    active_index = next(
        (index for index, workspace in enumerate(workspaces) if workspace.get("is_active")),
        -1,
    )
    next_index = 0 if active_index < 0 else (active_index + 1) % len(workspaces)
    next_workspace = workspaces[next_index].get("id")

    if not isinstance(next_workspace, str) or not next_workspace:
        raise RuntimeError("workspace list entry is invalid")

    updated_workspace = update_active_workspace(base_url, next_workspace)

    if not updated_workspace:
        raise RuntimeError("workspace switch did not persist")

    return updated_workspace


def handle_workspace_command(
    base_url: str,
    command: str,
    renderer: "ConsoleRenderer",
) -> Optional[str]:
    _, _, argument = command.partition(" ")
    tokens = shlex.split(argument)

    if not tokens:
        workspaces = list_workspace_entries(base_url)
        print("Workspaces:")

        for workspace in workspaces:
            workspace_id = workspace.get("id")

            if not isinstance(workspace_id, str):
                continue

            marker = "*" if workspace.get("is_active") else " "
            print(f"{marker} {workspace_id}")

        return None

    if tokens[0] == "history":
        if len(tokens) not in {2, 3}:
            renderer.render_notice("Usage: :workspace history <id> [offset]")
            return None

        history_offset = 0

        if len(tokens) == 3:
            history_offset = parse_non_negative_int(tokens[2], "history offset")

        history_payload = get_workspace_history(
            base_url,
            tokens[1],
            limit=WORKSPACE_HISTORY_COMMAND_LIMIT,
            offset=history_offset,
        )
        history = history_payload.get("history")
        total = history_payload.get("total")
        returned = history_payload.get("returned")
        workspace_id = history_payload.get("workspace_id")

        print(f"Workspace history: {workspace_id or tokens[1]}")

        if not isinstance(history, list) or len(history) == 0:
            print("- no runs yet")
            renderer.render_notice(f"History: {workspace_id or tokens[1]} (0 runs)")
            return None

        for entry in history:
            if not isinstance(entry, dict):
                continue

            completed_at = entry.get("completed_at")
            status = entry.get("status")
            summary = entry.get("summary")

            if not isinstance(completed_at, str) or not isinstance(status, str):
                continue

            detail = str(summary) if isinstance(summary, str) and summary else "(no summary)"
            print(f"- {completed_at} [{status}] {detail}")

        renderer.render_notice(
            f"History: {workspace_id or tokens[1]} ({describe_history_window(total, returned, history_offset)})",
        )
        return None

    if tokens[0] == "files":
        if len(tokens) != 2:
            renderer.render_notice("Usage: :workspace files <id>")
            return None

        files_payload = list_workspace_files(base_url, tokens[1])
        files = files_payload.get("files")
        workspace_id = files_payload.get("workspace_id")

        print(f"Workspace files: {workspace_id or tokens[1]}")

        if not isinstance(files, list) or len(files) == 0:
            print("- no files yet")
            renderer.render_notice(f"Files: {workspace_id or tokens[1]} (0 files)")
            return None

        for entry in files:
            if not isinstance(entry, dict):
                continue

            path = entry.get("path")
            size = entry.get("size")

            if not isinstance(path, str):
                continue

            suffix = f" ({size} B)" if isinstance(size, int) else ""
            print(f"- {path}{suffix}")

        renderer.render_notice(f"Files: {workspace_id or tokens[1]} ({len(files)} files)")
        return None

    if tokens[0] == "read":
        if len(tokens) != 3:
            renderer.render_notice("Usage: :workspace read <id> <path>")
            return None

        file_payload = get_workspace_file(base_url, tokens[1], tokens[2])
        workspace_id = file_payload.get("workspace_id")
        path = file_payload.get("path")
        content = file_payload.get("content")

        print(f"Workspace file: {workspace_id or tokens[1]}")
        print(path if isinstance(path, str) else tokens[2])
        print(content if isinstance(content, str) and content else "(empty file)")
        renderer.render_notice(f"Read file: {path if isinstance(path, str) else tokens[2]}")
        return None

    selection = tokens[0]

    if selection == "next":
        next_workspace = cycle_workspace(base_url)
        renderer.render_notice(f"Workspace: {next_workspace}")
        return next_workspace

    if selection == "clear":
        update_active_workspace(base_url, None)
        renderer.render_notice("Workspace: host default")
        return None

    next_workspace = update_active_workspace(base_url, selection)
    renderer.render_notice(f"Workspace: {next_workspace or 'host default'}")
    return next_workspace


def build_workspace_screen_state(workspaces: list[dict[str, Any]]) -> ScreenState:
    if not workspaces:
        return ScreenState(
            phase="Workspaces",
            status="No workspaces",
            answer="Create via /api/workspaces.",
            visual={
                "kind": "workspace_summary",
                "workspace_count": 0,
                "active_workspace": "(none)",
                "cards": [],
            },
        )

    lines: list[str] = []
    cards: list[dict[str, str]] = []
    active_workspace = "(none)"

    for workspace in workspaces[:5]:
        workspace_id = workspace.get("id")
        default_skill = workspace.get("default_skill")
        attached_repos = workspace.get("attached_repos")

        if not isinstance(workspace_id, str):
            continue

        marker = "*" if workspace.get("is_active") else " "
        summary = f"{marker} {workspace_id}"

        if workspace.get("is_active") is True:
            active_workspace = workspace_id

        if isinstance(default_skill, str) and default_skill:
            summary = f"{summary} [{default_skill}]"

        repo_count = len(attached_repos) if isinstance(attached_repos, list) else 0
        instructions_state = "instructions" if workspace.get("has_instructions") else "no notes"

        if repo_count > 0:
            summary = f"{summary} repos:{repo_count}"

        lines.append(summary)
        cards.append({
            "id": truncate_visual_text(workspace_id, 16),
            "skill": truncate_visual_text(default_skill if isinstance(default_skill, str) and default_skill else "no skill", 16),
            "repos": f"{repo_count} repo" if repo_count == 1 else f"{repo_count} repos",
            "notes": truncate_visual_text(instructions_state, 16),
            "state": "active" if workspace.get("is_active") else "idle",
        })

    if len(workspaces) > 5:
        lines.append(f"+{len(workspaces) - 5} more")

    return ScreenState(
        phase="Workspaces",
        status=f"{len(workspaces)} workspace(s)",
        answer="\n".join(lines),
        visual={
            "kind": "workspace_summary",
            "workspace_count": len(workspaces),
            "active_workspace": truncate_visual_text(active_workspace, 18),
            "cards": cards[:2],
            "remaining_count": max(0, len(cards) - 2),
        },
    )


def build_workspace_detail_screen_state(workspace: dict[str, Any]) -> ScreenState:
    workspace_id = workspace.get("id")
    has_instructions = workspace.get("has_instructions")
    default_skill = workspace.get("default_skill")
    attached_repos = workspace.get("attached_repos")
    is_active = workspace.get("is_active")

    if not isinstance(workspace_id, str):
        raise RuntimeError("workspace response is invalid")

    repo_lines: list[str] = []

    if isinstance(attached_repos, list):
        for attachment in attached_repos[:3]:
            if not isinstance(attachment, dict):
                continue

            attachment_id = attachment.get("id")
            mount_path = attachment.get("mount_path")

            if not isinstance(attachment_id, str):
                continue

            if isinstance(mount_path, str) and mount_path:
                repo_lines.append(f"repo: {attachment_id} -> {mount_path}")
            else:
                repo_lines.append(f"repo: {attachment_id}")

    if not repo_lines:
        repo_lines.append("repo: (none)")

    repo_preview = " · ".join(
        truncate_visual_text(line.replace("repo: ", ""), 16)
        for line in repo_lines[:2]
    )

    return ScreenState(
        phase="Workspaces",
        status=f"{workspace_id} [{'active' if is_active else 'idle'}]",
        answer="\n".join([
            f"instructions: {'yes' if has_instructions else 'no'}",
            f"default skill: {default_skill if isinstance(default_skill, str) and default_skill else '(none)'}",
            *repo_lines,
        ]),
        visual={
            "kind": "workspace_detail",
            "workspace_id": truncate_visual_text(workspace_id, 18),
            "state": "active" if is_active else "idle",
            "instructions": "present" if has_instructions else "missing",
            "default_skill": truncate_visual_text(default_skill if isinstance(default_skill, str) and default_skill else "no skill", 18),
            "repo_count": len(attached_repos) if isinstance(attached_repos, list) else 0,
            "repos": truncate_visual_text(repo_preview or "(none)", 42),
        },
    )


def build_workspace_history_screen_state(
    history_payload: dict[str, Any],
    history_offset: int = 0,
) -> ScreenState:
    workspace_id = history_payload.get("workspace_id")
    history = history_payload.get("history")
    total = history_payload.get("total")
    returned = history_payload.get("returned")

    if not isinstance(workspace_id, str):
        raise RuntimeError("workspace history response is invalid")

    if not isinstance(history, list) or not history:
        return ScreenState(
            phase="Workspaces",
            status=f"{workspace_id} has no history",
            prompt=workspace_id,
            answer="No workspace runs recorded.",
            visual={
                "kind": "workspace_history",
                "workspace_id": truncate_visual_text(workspace_id, 18),
                "window": describe_history_window(total, returned, history_offset),
                "cards": [],
            },
        )

    lines: list[str] = []
    cards: list[dict[str, str]] = []

    for entry in history:
        if not isinstance(entry, dict):
            continue

        completed_at = entry.get("completed_at")
        status = entry.get("status")
        skill = entry.get("skill")
        source = entry.get("source")
        summary = entry.get("summary")

        if not isinstance(completed_at, str) or not isinstance(status, str):
            continue

        entry_lines = [completed_at]
        detail = status

        if isinstance(skill, str) and skill:
            detail = f"{detail} [{skill}]"

        if isinstance(source, str) and source:
            detail = f"{detail} {source}"

        entry_lines.append(detail)

        if isinstance(summary, str) and summary:
            entry_lines.append(summary)

        lines.append("\n".join(entry_lines))
        cards.append({
            "time": format_visual_timestamp(completed_at),
            "status": truncate_visual_text(status, 10),
            "detail": truncate_visual_text(detail, 26),
            "summary": truncate_visual_text(summary if isinstance(summary, str) and summary else "(no summary)", 34),
        })

    return ScreenState(
        phase="Workspaces",
        status=f"{workspace_id} history ({describe_history_window(total, returned, history_offset)})",
        prompt=workspace_id,
        answer="\n".join(lines) if lines else "No valid history entries.",
        visual={
            "kind": "workspace_history",
            "workspace_id": truncate_visual_text(workspace_id, 18),
            "window": describe_history_window(total, returned, history_offset),
            "cards": cards[:3],
        },
    )


def build_workspace_files_screen_state(
    files_payload: dict[str, Any],
) -> ScreenState:
    workspace_id = files_payload.get("workspace_id")
    files = files_payload.get("files")

    if not isinstance(workspace_id, str):
        raise RuntimeError("workspace files response is invalid")

    if not isinstance(files, list) or not files:
        return ScreenState(
            phase="Workspaces",
            status=f"{workspace_id} has no files",
            prompt=workspace_id,
            answer="No workspace project files recorded.",
            visual={
                "kind": "workspace_files",
                "workspace_id": truncate_visual_text(workspace_id, 18),
                "file_count": 0,
                "cards": [],
            },
        )

    lines: list[str] = []
    cards: list[dict[str, str]] = []

    for entry in files[:5]:
        if not isinstance(entry, dict):
            continue

        path = entry.get("path")
        size = entry.get("size")

        if not isinstance(path, str):
            continue

        summary = path

        if isinstance(size, int):
            summary = f"{summary}\n{size} B"

        lines.append(summary)
        cards.append({
            "name": truncate_visual_text(Path(path).name or path, 18),
            "path": visual_parent_path(path, 18),
            "size": visual_size_label(size),
        })

    if len(files) > 5:
        lines.append(f"+{len(files) - 5} more")

    return ScreenState(
        phase="Workspaces",
        status=f"{workspace_id} files ({len(files)})",
        prompt=workspace_id,
        answer="\n".join(lines) if lines else "No valid file entries.",
        visual={
            "kind": "workspace_files",
            "workspace_id": truncate_visual_text(workspace_id, 18),
            "file_count": len(files),
            "cards": cards[:3],
            "remaining_count": max(0, len(cards) - 3),
        },
    )


def build_workspace_file_screen_state(
    file_payload: dict[str, Any],
) -> ScreenState:
    workspace_id = file_payload.get("workspace_id")
    path = file_payload.get("path")
    content = file_payload.get("content")

    if not isinstance(workspace_id, str) or not isinstance(path, str):
        raise RuntimeError("workspace file response is invalid")

    return ScreenState(
        phase="Workspaces",
        status=f"{workspace_id} file",
        prompt=path,
        answer=content if isinstance(content, str) and content else "(empty file)",
        visual={
            "kind": "workspace_file",
            "workspace_id": truncate_visual_text(workspace_id, 18),
            "file_name": truncate_visual_text(Path(path).name or path, 18),
            "path": visual_parent_path(path, 20),
            "body": truncate_visual_text(content if isinstance(content, str) and content else "(empty file)", 220),
        },
    )


def run_workspace_screen(
    base_url: str,
    renderer: "ConsoleRenderer",
    refresh_seconds: float,
) -> int:
    if refresh_seconds <= 0:
        renderer.render_notice("Selection refresh must be greater than zero")
        return 1

    while True:
        try:
            renderer.render(build_workspace_screen_state(list_workspace_entries(base_url)))
        except (RuntimeError, urllib.error.URLError) as error:
            renderer.render(
                ScreenState(
                    phase="Error",
                    status="Workspace screen failed",
                    error=str(error),
                )
            )

        time.sleep(refresh_seconds)


def run_workspace_action(
    base_url: str,
    renderer: "ConsoleRenderer",
    action: str,
    selection: Optional[str] = None,
) -> int:
    renderer.render(
        ScreenState(
            phase="Workspaces",
            status="Updating workspace",
            prompt=selection or action,
        )
    )

    try:
        if action == "cycle":
            selected_workspace = cycle_workspace(base_url)
        elif action == "clear":
            update_active_workspace(base_url, None)
            selected_workspace = "host default"
        else:
            selected_workspace = update_active_workspace(base_url, selection)
            if selected_workspace is None:
                selected_workspace = "host default"

        state = build_workspace_screen_state(list_workspace_entries(base_url))
        state.status = f"Workspace: {selected_workspace}"
        renderer.render(state)
        return 0
    except (RuntimeError, urllib.error.URLError) as error:
        renderer.render(
            ScreenState(
                phase="Error",
                status="Workspace update failed",
                prompt=selection or action,
                error=str(error),
            )
        )
        return 1


def run_workspace_detail(
    base_url: str,
    renderer: "ConsoleRenderer",
    workspace_id: str,
) -> int:
    try:
        renderer.render(build_workspace_detail_screen_state(get_workspace_entry(base_url, workspace_id)))
        return 0
    except (RuntimeError, urllib.error.URLError) as error:
        renderer.render(
            ScreenState(
                phase="Error",
                status="Workspace detail failed",
                prompt=workspace_id,
                error=str(error),
            )
        )
        return 1


def run_workspace_history_screen(
    base_url: str,
    workspace_id: str,
    renderer: "ConsoleRenderer",
    refresh_seconds: float,
    history_offset: int = 0,
) -> int:
    if refresh_seconds <= 0:
        renderer.render_notice("Selection refresh must be greater than zero")
        return 1

    while True:
        try:
            history_payload = get_workspace_history(
                base_url,
                workspace_id,
                limit=WORKSPACE_HISTORY_SCREEN_LIMIT,
                offset=history_offset,
            )
            renderer.render(build_workspace_history_screen_state(history_payload, history_offset))
        except (RuntimeError, urllib.error.URLError) as error:
            renderer.render(
                ScreenState(
                    phase="Error",
                    status="Workspace history failed",
                    prompt=workspace_id,
                    error=str(error),
                )
            )

        time.sleep(refresh_seconds)


def run_workspace_files(
    base_url: str,
    renderer: "ConsoleRenderer",
    workspace_id: str,
) -> int:
    try:
        renderer.render(build_workspace_files_screen_state(list_workspace_files(base_url, workspace_id)))
        return 0
    except (RuntimeError, urllib.error.URLError) as error:
        renderer.render(
            ScreenState(
                phase="Error",
                status="Workspace files failed",
                prompt=workspace_id,
                error=str(error),
            )
        )
        return 1


def run_workspace_file(
    base_url: str,
    renderer: "ConsoleRenderer",
    workspace_id: str,
    file_path: str,
) -> int:
    try:
        renderer.render(build_workspace_file_screen_state(get_workspace_file(base_url, workspace_id, file_path)))
        return 0
    except (RuntimeError, urllib.error.URLError) as error:
        renderer.render(
            ScreenState(
                phase="Error",
                status="Workspace file failed",
                prompt=file_path,
                error=str(error),
            )
        )
        return 1


def run_workspace_create(
    base_url: str,
    renderer: "ConsoleRenderer",
    workspace_id: str,
    instructions: Optional[str] = None,
) -> int:
    renderer.render(
        ScreenState(
            phase="Workspaces",
            status="Creating workspace",
            prompt=workspace_id,
        )
    )

    try:
        create_workspace_entry(base_url, workspace_id, instructions)
        return run_workspace_detail(base_url, renderer, workspace_id)
    except (RuntimeError, urllib.error.URLError) as error:
        renderer.render(
            ScreenState(
                phase="Error",
                status="Workspace create failed",
                prompt=workspace_id,
                error=str(error),
            )
        )
        return 1


def list_skill_entries(base_url: str) -> list[dict[str, Any]]:
    payload = request_json(base_url, "/api/skills")
    skills = payload.get("skills")

    if not isinstance(skills, list):
        raise RuntimeError("skill list response is invalid")

    return [skill for skill in skills if isinstance(skill, dict)]


def get_skill_entry(base_url: str, skill_id: str) -> dict[str, Any]:
    normalized_skill_id = skill_id.strip().lower()

    for skill in list_skill_entries(base_url):
        if skill.get("id") == normalized_skill_id:
            return skill

    raise RuntimeError("skill not found")


def update_active_skill(
    base_url: str,
    skill: Optional[str],
) -> Optional[str]:
    payload = request_json(
        base_url,
        "/api/config",
        method="POST",
        payload={"runtime": {"active_skill": skill}},
    )
    runtime = payload.get("runtime")

    if not isinstance(runtime, dict):
        raise RuntimeError("config response is invalid")

    active_skill = runtime.get("active_skill")

    if active_skill is None:
        return None

    if not isinstance(active_skill, str) or not active_skill:
        raise RuntimeError("config response active_skill is invalid")

    return active_skill


def cycle_skill(base_url: str) -> str:
    skills = list_skill_entries(base_url)

    if not skills:
        raise RuntimeError("no skills available")

    active_index = next(
        (index for index, skill in enumerate(skills) if skill.get("is_active")),
        -1,
    )
    next_index = 0 if active_index < 0 else (active_index + 1) % len(skills)
    next_skill = skills[next_index].get("id")

    if not isinstance(next_skill, str) or not next_skill:
        raise RuntimeError("skill list entry is invalid")

    updated_skill = update_active_skill(base_url, next_skill)

    if not updated_skill:
        raise RuntimeError("skill switch did not persist")

    return updated_skill


def handle_skill_command(
    base_url: str,
    command: str,
    renderer: "ConsoleRenderer",
) -> Optional[str]:
    _, _, argument = command.partition(" ")
    selection = argument.strip()

    if not selection:
        skills = list_skill_entries(base_url)
        print("Skills:")

        for skill in skills:
            skill_id = skill.get("id")

            if not isinstance(skill_id, str):
                continue

            marker = "*" if skill.get("is_active") else " "
            print(f"{marker} {skill_id}")

        return None

    if selection == "next":
        next_skill = cycle_skill(base_url)
        renderer.render_notice(f"Skill: {next_skill}")
        return next_skill

    if selection == "clear":
        update_active_skill(base_url, None)
        renderer.render_notice("Skill: workspace/default")
        return None

    next_skill = update_active_skill(base_url, selection)
    renderer.render_notice(f"Skill: {next_skill or 'workspace/default'}")
    return next_skill


def build_skill_screen_state(skills: list[dict[str, Any]]) -> ScreenState:
    if not skills:
        return ScreenState(
            phase="Skills",
            status="No skills",
            answer="Install skills under skills/<id>/.",
            visual={
                "kind": "skills_summary",
                "skill_count": 0,
                "active_skill": "(none)",
                "cards": [],
            },
        )

    lines: list[str] = []
    cards: list[dict[str, str]] = []
    active_skill = "(none)"

    for skill in skills[:4]:
        skill_id = skill.get("id")
        permission_mode = skill.get("permission_mode")
        tool_allowlist = skill.get("tool_allowlist")

        if not isinstance(skill_id, str):
            continue

        marker = "*" if skill.get("is_active") else " "
        summary = f"{marker} {skill_id}"

        if skill.get("is_active") is True:
            active_skill = skill_id

        if isinstance(permission_mode, str) and permission_mode:
            summary = f"{summary} [{permission_mode}]"

        tool_count = len(tool_allowlist) if isinstance(tool_allowlist, list) else 0
        reasoning_summary, readiness_summary = summarize_skill_readiness(skill)
        detail = []

        if reasoning_summary:
            detail.append(reasoning_summary)

        if tool_count > 0:
            detail.append(f"tools:{tool_count}")

        if readiness_summary:
            detail.append(readiness_summary)

        if detail:
            summary = f"{summary}\n{' | '.join(detail)}"

        lines.append(summary)
        cards.append({
            "id": truncate_visual_text(skill_id, 16),
            "permission": truncate_visual_text(permission_mode if isinstance(permission_mode, str) and permission_mode else "open", 10),
            "reasoning": reasoning_summary,
            "readiness": readiness_summary,
            "state": "active" if skill.get("is_active") else "idle",
        })

    if len(skills) > 4:
        lines.append(f"+{len(skills) - 4} more")

    return ScreenState(
        phase="Skills",
        status=f"{len(skills)} skill(s)",
        answer="\n".join(lines),
        visual={
            "kind": "skills_summary",
            "skill_count": len(skills),
            "active_skill": truncate_visual_text(active_skill, 18),
            "cards": cards[:2],
            "remaining_count": max(0, len(cards) - 2),
        },
    )


def build_skill_detail_screen_state(skill: dict[str, Any]) -> ScreenState:
    skill_id = skill.get("id")
    permission_mode = skill.get("permission_mode")
    tool_allowlist = skill.get("tool_allowlist")
    bash_prefix_allowlist = skill.get("bash_prefix_allowlist")
    prompt_prelude_summary = skill.get("prompt_prelude_summary")
    integrations = skill.get("integrations")
    model = skill.get("model")
    is_active = skill.get("is_active")

    if not isinstance(skill_id, str):
        raise RuntimeError("skill response is invalid")

    tool_count = len(tool_allowlist) if isinstance(tool_allowlist, list) else 0
    bash_count = len(bash_prefix_allowlist) if isinstance(bash_prefix_allowlist, list) else 0
    tool_summary = ", ".join(
        tool_name
        for tool_name in tool_allowlist
        if isinstance(tool_name, str)
    ) if isinstance(tool_allowlist, list) else ""
    bash_summary = ", ".join(
        prefix
        for prefix in bash_prefix_allowlist
        if isinstance(prefix, str)
    ) if isinstance(bash_prefix_allowlist, list) else ""
    integration_total = 0
    integration_ready = 0
    integration_summary = ", ".join(
        f"{provider}[{'ready' if configured else 'missing'}]"
        for entry in integrations
        if isinstance(entry, dict)
        for provider, configured in [(entry.get("provider"), entry.get("configured"))]
        if isinstance(provider, str) and isinstance(configured, bool)
    ) if isinstance(integrations, list) else ""
    if isinstance(integrations, list):
        for entry in integrations:
            if not isinstance(entry, dict):
                continue

            provider = entry.get("provider")
            configured = entry.get("configured")

            if not isinstance(provider, str) or not isinstance(configured, bool):
                continue

            integration_total += 1
            if configured:
                integration_ready += 1

    if integration_total > 0:
        integration_visual = f"{integration_ready} ready · {integration_total - integration_ready} missing"
    else:
        integration_visual = "no integrations"
    reasoning = model.get("reasoning") if isinstance(model, dict) else None
    reasoning_summary, readiness_summary = summarize_skill_readiness(skill)

    return ScreenState(
        phase="Skills",
        status=f"{skill_id} [{'active' if is_active else 'idle'}]",
        answer="\n".join([
            f"permission: {permission_mode if isinstance(permission_mode, str) and permission_mode else '(none)'}",
            f"reasoning: {reasoning if isinstance(reasoning, str) and reasoning else '(none)'}",
            f"prelude: {prompt_prelude_summary if isinstance(prompt_prelude_summary, str) and prompt_prelude_summary else '(none)'}",
            f"integrations: {integration_summary or '(none)'}",
            f"tools: {tool_summary or '(none)'}",
            f"bash: {bash_summary or '(none)'}",
        ]),
        visual={
            "kind": "skill_detail",
            "skill_id": truncate_visual_text(skill_id, 18),
            "state": "active" if is_active else "idle",
            "permission": truncate_visual_text(permission_mode if isinstance(permission_mode, str) and permission_mode else "open", 12),
            "reasoning": truncate_visual_text(reasoning_summary, 14),
            "readiness": truncate_visual_text(readiness_summary, 18),
            "integrations": truncate_visual_text(integration_visual or "(none)", 42),
            "prelude": truncate_visual_text(prompt_prelude_summary if isinstance(prompt_prelude_summary, str) and prompt_prelude_summary else "(none)", 52),
            "tool_count": tool_count,
            "bash_count": bash_count,
        },
    )


def build_diagnostics_screen_state(
    runtime: dict[str, Any],
    health: dict[str, Any],
    system: dict[str, Any],
) -> ScreenState:
    active_server = system.get("active_server")
    configured_server = system.get("configured_server")
    active_bind = active_server.get("bind") if isinstance(active_server, dict) else None
    configured_bind = configured_server.get("bind") if isinstance(configured_server, dict) else None
    scheduler_enabled = health.get("scheduler_enabled")
    scheduler_poll_interval = health.get("scheduler_poll_interval_seconds")
    stt_ready = health.get("stt_ready")
    stt_model = health.get("stt_model")
    stt_language = health.get("stt_language")
    lan_setup_ready = system.get("lan_setup_ready")
    restart_required = system.get("restart_required")
    daemon_healthy = health.get("daemon_healthy")
    status_message = health.get("status_message")

    if not isinstance(status_message, str) or not status_message:
        status_message = "Diagnostics ready"

    scheduler_summary = "scheduler: on" if scheduler_enabled is True else "scheduler: off"

    if isinstance(scheduler_poll_interval, int):
        scheduler_summary = f"{scheduler_summary} @ {scheduler_poll_interval}s"

    stt_summary = "stt: ready" if stt_ready is True else "stt: missing"

    if isinstance(stt_model, str) and stt_model:
        stt_summary = f"{stt_summary} {stt_model}"

    if isinstance(stt_language, str) and stt_language:
        stt_summary = f"{stt_summary} {stt_language}"

    return ScreenState(
        phase="Diagnostics",
        status=status_message,
        prompt="\n".join([
            f"workspace: {summarize_runtime_selection(runtime, 'active_workspace', 'default_workspace')}",
            f"skill: {summarize_runtime_selection(runtime, 'active_skill', 'default_skill')}",
        ]),
        answer="\n".join([
            f"daemon: {'ok' if daemon_healthy is True else 'error'}",
            scheduler_summary,
            stt_summary,
            f"lan setup: {'ready' if lan_setup_ready is True else 'pending'}",
            f"restart: {'yes' if restart_required is True else 'no'}",
            f"active bind: {active_bind if isinstance(active_bind, str) and active_bind else '(unknown)'}",
            f"config bind: {configured_bind if isinstance(configured_bind, str) and configured_bind else '(unknown)'}",
        ]),
    )


def build_transcript_debug_screen_state(debug_voice: dict[str, Any]) -> ScreenState:
    transcript = debug_voice.get("transcript")

    if not isinstance(transcript, dict):
        raise RuntimeError("debug transcript response is invalid")

    if transcript.get("present") is not True:
        return ScreenState(
            phase="Diagnostics",
            status="No transcript captured",
            answer="Run one audio request to populate last transcript.",
            visual={
                "kind": "transcript_debug",
                "lead_value": "Run one audio request to populate last transcript.",
                "age": "(unknown)",
                "file": "(none)",
            },
        )

    transcript_path = transcript.get("path")
    transcript_text = transcript.get("text")
    updated_at = transcript.get("updated_at")

    return ScreenState(
        phase="Diagnostics",
        status="Last transcript",
        prompt=format_debug_detail_lines(transcript_path, updated_at),
        answer=transcript_text if isinstance(transcript_text, str) and transcript_text else "(empty transcript)",
        visual={
            "kind": "transcript_debug",
            "lead_value": transcript_text if isinstance(transcript_text, str) and transcript_text else "(empty transcript)",
            "age": summarize_debug_age(updated_at),
            "file": visual_path_name(transcript_path),
        },
    )


def build_audio_debug_screen_state(debug_voice: dict[str, Any]) -> ScreenState:
    audio = debug_voice.get("audio")

    if not isinstance(audio, dict):
        raise RuntimeError("debug audio response is invalid")

    if audio.get("present") is not True:
        return ScreenState(
            phase="Diagnostics",
            status="No audio captured",
            answer="Run push-to-talk or audio upload to populate last audio.",
            visual={
                "kind": "audio_debug",
                "lead_value": "Run push-to-talk or audio upload to populate last audio.",
                "age": "(unknown)",
                "file": "(none)",
            },
        )

    audio_path = audio.get("path")
    size_bytes = audio.get("size_bytes")
    updated_at = audio.get("updated_at")

    return ScreenState(
        phase="Diagnostics",
        status="Last audio",
        prompt=format_debug_detail_lines(audio_path, updated_at),
        answer="\n".join([
            f"size: {size_bytes} B" if isinstance(size_bytes, int) else "size: (unknown)",
            f"age: {summarize_debug_age(updated_at)}" if isinstance(updated_at, str) and updated_at else "age: (unknown)",
        ]),
        visual={
            "kind": "audio_debug",
            "lead_value": f"{size_bytes} B saved" if isinstance(size_bytes, int) else "(unknown size)",
            "age": summarize_debug_age(updated_at),
            "file": visual_path_name(audio_path),
        },
    )


def build_error_debug_screen_state(debug_voice: dict[str, Any]) -> ScreenState:
    error_entry = debug_voice.get("error")

    if not isinstance(error_entry, dict):
        raise RuntimeError("debug error response is invalid")

    if error_entry.get("present") is not True:
        return ScreenState(
            phase="Diagnostics",
            status="No error captured",
            answer="Run one failing talk or transcribe request to populate last error.",
            visual={
                "kind": "error_debug",
                "lead_value": "Run one failing talk or transcribe request to populate last error.",
                "age": "(unknown)",
                "file": "(none)",
            },
        )

    error_path = error_entry.get("path")
    source = error_entry.get("source")
    message = error_entry.get("message")
    updated_at = error_entry.get("updated_at")

    return ScreenState(
        phase="Diagnostics",
        status="Last error",
        prompt=format_debug_detail_lines(error_path, updated_at),
        answer="\n".join([
            f"source: {source}" if isinstance(source, str) and source else "source: (unknown)",
            f"age: {summarize_debug_age(updated_at)}" if isinstance(updated_at, str) and updated_at else "age: (unknown)",
            "",
            message if isinstance(message, str) and message else "(empty error)",
        ]),
        visual={
            "kind": "error_debug",
            "lead_value": message if isinstance(message, str) and message else "(empty error)",
            "age": summarize_debug_age(updated_at),
            "file": visual_path_name(error_path),
            "source": compact_badge_value(source),
        },
    )


def summarize_debug_value(
    value: Any,
    empty_value: str,
    max_length: int = 28,
) -> str:
    if not isinstance(value, str):
        return empty_value

    collapsed_value = " ".join(value.strip().split())

    if not collapsed_value:
        return empty_value

    if len(collapsed_value) <= max_length:
        return collapsed_value

    return f"{collapsed_value[:max_length - 3]}..."


def summarize_debug_audio_size(value: Any) -> str:
    if not isinstance(value, int) or value <= 0:
        return "no wav"

    if value < 1024:
        return f"{value} B"

    if value < 1024 * 1024:
        return f"{value / 1024:.1f} KB"

    return f"{value / (1024 * 1024):.1f} MB"


def build_voice_debug_bundle_screen_state(debug_voice: dict[str, Any]) -> ScreenState:
    transcript = debug_voice.get("transcript")
    audio = debug_voice.get("audio")
    error_entry = debug_voice.get("error")

    if not isinstance(transcript, dict) or not isinstance(audio, dict) or not isinstance(error_entry, dict):
        raise RuntimeError("debug voice bundle response is invalid")

    transcript_path = transcript.get("path")
    transcript_text = transcript.get("text")
    transcript_updated_at = transcript.get("updated_at")
    audio_path = audio.get("path")
    audio_size = audio.get("size_bytes")
    audio_updated_at = audio.get("updated_at")
    error_source = error_entry.get("source")
    error_message = error_entry.get("message")
    error_updated_at = error_entry.get("updated_at")
    heard_summary = summarize_debug_value(transcript_text, "nothing heard", 28)
    audio_summary = summarize_debug_audio_size(audio_size)
    error_summary = (
        summarize_debug_value(f"{error_source}: {error_message or 'issue'}", "clear", 30)
        if isinstance(error_source, str) and error_source
        else summarize_debug_value(error_message, "clear", 30)
    )

    return ScreenState(
        phase="Diagnostics",
        status="Voice triage",
        prompt="\n".join([
            f"tx: {Path(transcript_path).name}" if isinstance(transcript_path, str) and transcript_path else "tx: none",
            f"wav: {Path(audio_path).name}" if isinstance(audio_path, str) and audio_path else "wav: none",
            f"err: {error_source}" if isinstance(error_source, str) and error_source else "err: none",
        ]),
        answer="\n".join([
            f"heard: {heard_summary} [{summarize_debug_age(transcript_updated_at)}]",
            f"audio: {audio_summary} [{summarize_debug_age(audio_updated_at)}]",
            f"error: {error_summary} [{summarize_debug_age(error_updated_at) if isinstance(error_source, str) and error_source else 'clear'}]",
        ]),
        visual={
            "kind": "voice_debug",
            "heard": heard_summary,
            "heard_age": summarize_debug_age(transcript_updated_at),
            "audio": audio_summary,
            "audio_age": summarize_debug_age(audio_updated_at),
            "error": error_summary,
            "error_age": summarize_debug_age(error_updated_at) if isinstance(error_source, str) and error_source else "clear",
        },
    )


def clear_debug_voice_entry(base_url: str) -> dict[str, Any]:
    payload = request_json(base_url, "/api/debug/voice/clear", method="POST")
    transcript = payload.get("transcript")
    audio = payload.get("audio")
    error = payload.get("error")

    if not isinstance(transcript, dict) or not isinstance(audio, dict) or not isinstance(error, dict):
        raise RuntimeError("clear debug voice response is invalid")

    return {
        "transcript": transcript,
        "audio": audio,
        "error": error,
    }


def build_run_cancel_hold_screen_state(
    state: ScreenState,
    hold_progress: float,
) -> ScreenState:
    phase_title = truncate_visual_text(state.phase, 16) if isinstance(state.phase, str) and state.phase else "Run"
    return ScreenState(
        phase=state.phase or "Thinking",
        status="Hold to cancel",
        visual={
            "kind": "stage",
            "title": phase_title,
            "badge": "stop",
            "lead": "Hold to cancel",
            "detail": "Keep holding to stop this run.\nRelease keeps streaming.",
            "footer": "cancel affordance",
            "progress": clamp_progress(hold_progress),
            "progress_label": "cancel run",
        },
    )


def build_home_hold_screen_state(
    state: HomeNavigationState,
    hold_progress: float,
) -> ScreenState:
    if state.screen_mode == "home":
        target_label = truncate_visual_text(state.focused_target, 16)
        return ScreenState(
            phase="Home",
            status="Hold to open",
            visual={
                "kind": "stage",
                "title": "Home",
                "badge": "open",
                "lead": f"Open {target_label}",
                "detail": "Keep holding to enter this view.\nRelease keeps browsing.",
                "footer": "one-button home",
                "progress": clamp_progress(hold_progress),
                "progress_label": "open view",
            },
        )

    if state.screen_mode == "voice":
        return ScreenState(
            phase="Diagnostics",
            status="Hold to clear",
            visual={
                "kind": "stage",
                "title": "Voice",
                "badge": "clear",
                "lead": "Clear debug",
                "detail": "Keep holding to clear transcript, audio, and error.\nRelease keeps this screen.",
                "footer": "voice triage",
                "progress": clamp_progress(hold_progress),
                "progress_label": "clear debug",
            },
        )

    return ScreenState(
        phase="Home",
        status="Hold to return",
        visual={
            "kind": "stage",
            "title": truncate_visual_text(state.screen_mode, 16),
            "badge": "home",
            "lead": "Return home",
            "detail": "Keep holding to jump back home.\nRelease keeps this screen.",
            "footer": "one-button home",
            "progress": clamp_progress(hold_progress),
            "progress_label": "return home",
        },
    )


def build_scheduler_hold_screen_state(
    state: SchedulerNavigationState,
    hold_progress: float,
) -> ScreenState:
    lead = "Open next job" if state.screen_mode == "summary" else "Next job"
    detail = (
        "Keep holding to focus the next job.\nRelease cycles summary, detail, and history."
        if state.screen_mode == "summary"
        else "Keep holding to move to the next job.\nRelease switches screen mode."
    )

    return ScreenState(
        phase="Jobs",
        status="Hold to advance",
        visual={
            "kind": "stage",
            "title": "Scheduler",
            "badge": "next",
            "lead": lead,
            "detail": detail,
            "footer": "one-button scheduler",
            "progress": clamp_progress(hold_progress),
            "progress_label": "next job",
        },
    )


def seed_debug_voice_entry(base_url: str, preset: str) -> dict[str, Any]:
    if preset == "success":
        payload = {
            "transcript_text": "preview success",
            "audio_size_bytes": 24,
        }
    elif preset == "error":
        payload = {
            "transcript_text": "preview error",
            "audio_size_bytes": 24,
            "error_source": "audio-talk",
            "error_message": "preview failure",
        }
    else:
        raise RuntimeError("debug seed preset is invalid")

    response_payload = request_json(
        base_url,
        "/api/debug/voice/seed",
        method="POST",
        payload=payload,
    )
    transcript = response_payload.get("transcript")
    audio = response_payload.get("audio")
    error = response_payload.get("error")

    if not isinstance(transcript, dict) or not isinstance(audio, dict) or not isinstance(error, dict):
        raise RuntimeError("seed debug voice response is invalid")

    return {
        "transcript": transcript,
        "audio": audio,
        "error": error,
    }


def build_home_screen_state(
    runtime: dict[str, Any],
    health: dict[str, Any],
    system: dict[str, Any],
    first_run: dict[str, Any],
    jobs: list[dict[str, Any]],
    focused_target: Optional[str] = None,
) -> ScreenState:
    enabled_jobs = sum(1 for job in jobs if job.get("enabled") is True)
    daemon_healthy = health.get("daemon_healthy")
    stt_ready = health.get("stt_ready")
    scheduler_enabled = health.get("scheduler_enabled")
    lan_setup_ready = system.get("lan_setup_ready")
    safety_mode = runtime.get("safety_mode")
    first_run_ready = first_run.get("ready") is True
    first_run_message = truncate_visual_text(first_run.get("status_message"), 64)
    next_action_label = truncate_visual_text(first_run.get("next_action_label"), 18)
    next_action_detail = truncate_visual_text(first_run.get("next_action_detail"), 56)
    next_action_visual_detail = summarize_home_next_action_detail(
        first_run_ready,
        next_action_label,
        next_action_detail,
    )
    nav_lines: list[str] = []

    for target in HOME_NAVIGATION_TARGET_SEQUENCE:
        marker = ">" if target == focused_target else " "
        nav_lines.append(f"{marker} {target}")

    answer_lines = [
        f"workspace: {summarize_runtime_selection(runtime, 'active_workspace', 'default_workspace')}",
        f"skill: {summarize_runtime_selection(runtime, 'active_skill', 'default_skill')}",
        f"safety: {safety_mode if isinstance(safety_mode, str) and safety_mode else '(none)'}",
        f"jobs: {enabled_jobs}/{len(jobs)} on",
        f"scheduler: {'on' if scheduler_enabled is True else 'off'}",
        f"setup: {'ready' if first_run_ready else next_action_label.lower()}",
    ]

    if first_run_message and first_run_message != "(none)":
        answer_lines.extend([
            "",
            first_run_message,
        ])

    if nav_lines:
        answer_lines.extend([
            "",
            *nav_lines,
        ])

    return ScreenState(
        phase="Home",
        status=" | ".join(
            [
                "ready" if first_run_ready else "finish setup",
                "daemon ok" if daemon_healthy is True else "daemon issue",
                "stt ready" if stt_ready is True else "stt missing",
            ]
        ),
        answer="\n".join(answer_lines),
        visual={
            "kind": "home",
            "workspace": summarize_runtime_selection(runtime, "active_workspace", "default_workspace"),
            "skill": summarize_runtime_selection(runtime, "active_skill", "default_skill"),
            "safety": safety_mode if isinstance(safety_mode, str) and safety_mode else "(none)",
            "enabled_jobs": enabled_jobs,
            "job_count": len(jobs),
            "daemon_healthy": daemon_healthy is True,
            "stt_ready": stt_ready is True,
            "scheduler_enabled": scheduler_enabled is True,
            "lan_setup_ready": lan_setup_ready is True,
            "first_run_ready": first_run_ready,
            "first_run_message": first_run_message,
            "next_action_label": next_action_label,
            "next_action_detail": next_action_detail,
            "next_action_visual_detail": next_action_visual_detail,
            "focused_target": focused_target or HOME_NAVIGATION_TARGET_SEQUENCE[0],
        },
    )


def run_diagnostics_screen(
    base_url: str,
    renderer: "ConsoleRenderer",
) -> int:
    try:
        renderer.render(
            build_diagnostics_screen_state(
                get_runtime_config_entry(base_url),
                get_setup_health_entry(base_url),
                get_setup_system_entry(base_url),
            )
        )
        return 0
    except (RuntimeError, urllib.error.URLError) as error:
        renderer.render(
            ScreenState(
                phase="Error",
                status="Diagnostics screen failed",
                error=str(error),
            )
        )
        return 1


def run_transcript_debug_screen(
    base_url: str,
    renderer: "ConsoleRenderer",
) -> int:
    try:
        renderer.render(build_transcript_debug_screen_state(get_debug_voice_entry(base_url)))
        return 0
    except (RuntimeError, urllib.error.URLError) as error:
        renderer.render(
            ScreenState(
                phase="Error",
                status="Transcript screen failed",
                error=str(error),
            )
        )
        return 1


def run_audio_debug_screen(
    base_url: str,
    renderer: "ConsoleRenderer",
) -> int:
    try:
        renderer.render(build_audio_debug_screen_state(get_debug_voice_entry(base_url)))
        return 0
    except (RuntimeError, urllib.error.URLError) as error:
        renderer.render(
            ScreenState(
                phase="Error",
                status="Audio screen failed",
                error=str(error),
            )
        )
        return 1


def run_error_debug_screen(
    base_url: str,
    renderer: "ConsoleRenderer",
) -> int:
    try:
        renderer.render(build_error_debug_screen_state(get_debug_voice_entry(base_url)))
        return 0
    except (RuntimeError, urllib.error.URLError) as error:
        renderer.render(
            ScreenState(
                phase="Error",
                status="Error screen failed",
                error=str(error),
            )
        )
        return 1


def run_voice_debug_bundle_screen(
    base_url: str,
    renderer: "ConsoleRenderer",
) -> int:
    try:
        renderer.render(build_voice_debug_bundle_screen_state(get_debug_voice_entry(base_url)))
        return 0
    except (RuntimeError, urllib.error.URLError) as error:
        renderer.render(
            ScreenState(
                phase="Error",
                status="Voice debug screen failed",
                error=str(error),
            )
        )
        return 1


def run_clear_debug_state(
    base_url: str,
    renderer: "ConsoleRenderer",
) -> int:
    try:
        renderer.render(build_voice_debug_bundle_screen_state(clear_debug_voice_entry(base_url)))
        return 0
    except (RuntimeError, urllib.error.URLError) as error:
        renderer.render(
            ScreenState(
                phase="Error",
                status="Clear debug state failed",
                error=str(error),
            )
        )
        return 1


def run_seed_debug_state(
    base_url: str,
    renderer: "ConsoleRenderer",
    preset: str,
) -> int:
    try:
        renderer.render(build_voice_debug_bundle_screen_state(seed_debug_voice_entry(base_url, preset)))
        return 0
    except (RuntimeError, urllib.error.URLError) as error:
        renderer.render(
            ScreenState(
                phase="Error",
                status="Seed debug state failed",
                prompt=preset,
                error=str(error),
            )
        )
        return 1


def write_preview_gallery_snapshot(
    output_path: Path,
    state: ScreenState,
    scale: int,
) -> None:
    snapshot_renderer = SnapshotRenderer(str(output_path), scale=scale)

    try:
        snapshot_renderer.render(state)
    finally:
        snapshot_renderer.close()

    if not output_path.exists():
        raise RuntimeError(f"preview gallery snapshot was not created: {output_path.name}")


def run_preview_gallery(
    base_url: str,
    renderer: "ConsoleRenderer",
    output_dir: str,
    scale: int,
    seed_preset: Optional[str],
) -> int:
    try:
        output_root = Path(output_dir)
        output_root.mkdir(parents=True, exist_ok=True)

        if seed_preset is not None:
            seed_debug_voice_entry(base_url, seed_preset)

        runtime = get_runtime_config_entry(base_url)
        health = get_setup_health_entry(base_url)
        system = get_setup_system_entry(base_url)
        first_run = get_setup_first_run_entry(base_url)
        jobs = list_job_entries(base_url)
        debug_voice = get_debug_voice_entry(base_url)
        gallery_entries = [
            ("home.png", build_home_screen_state(runtime, health, system, first_run, jobs, focused_target=None)),
            ("transcript.png", build_transcript_debug_screen_state(debug_voice)),
            ("audio.png", build_audio_debug_screen_state(debug_voice)),
            ("error.png", build_error_debug_screen_state(debug_voice)),
            ("voice-debug.png", build_voice_debug_bundle_screen_state(debug_voice)),
        ]

        for filename, state in gallery_entries:
            write_preview_gallery_snapshot(output_root / filename, state, scale)

        renderer.render(
            ScreenState(
                phase="Preview",
                status="Gallery saved",
                prompt=str(output_root),
                answer="\n".join(filename for filename, _state in gallery_entries),
            )
        )
        return 0
    except (RuntimeError, urllib.error.URLError) as error:
        renderer.render(
            ScreenState(
                phase="Error",
                status="Preview gallery failed",
                prompt=output_dir,
                error=str(error),
            )
        )
        return 1


def build_core_preview_gallery_entries() -> list[tuple[str, ScreenState]]:
    prompt = "summarize current workspace"
    thinking_state = build_prompt_state(prompt)
    apply_stream_event(thinking_state, "status", {"message": "Planning next steps"})

    transcribing_state = build_prompt_state(prompt)
    apply_stream_event(transcribing_state, "stt", {"text": prompt})

    tool_state = build_prompt_state(prompt)
    apply_stream_event(tool_state, "tool", {"name": "bash", "detail": "git status --short"})

    answer_state = build_prompt_state(prompt)
    apply_stream_event(
        answer_state,
        "token",
        {"text": "Workspace is healthy. Scheduler and setup are ready for Pi validation."},
    )
    apply_stream_event(answer_state, "done", {"summary": "Run finished"})

    error_state = build_prompt_state(prompt)
    apply_stream_event(error_state, "error", {"message": "runner timed out after 30s"})

    return [
        (
            "home.png",
            build_home_screen_state(
                {
                    "active_workspace": "default",
                    "active_skill": "coding",
                    "safety_mode": "strict",
                },
                {
                    "daemon_healthy": True,
                    "stt_ready": True,
                    "scheduler_enabled": True,
                },
                {
                    "lan_setup_ready": True,
                },
                {
                    "ready": True,
                    "status_message": "DumplBot is ready for a first talk test.",
                    "next_action_label": "Voice",
                    "next_action_detail": "Tap next or hold enter to leave home.",
                },
                [
                    {"id": "daily-status", "enabled": True},
                    {"id": "weekly-review", "enabled": True},
                ],
                focused_target="voice",
            ),
        ),
        ("listening.png", build_capture_screen_state(CaptureFlowState(phase="Listening"), hold_progress=0.58)),
        ("transcribing.png", transcribing_state),
        ("thinking.png", thinking_state),
        ("tool.png", tool_state),
        ("answer.png", answer_state),
        ("error.png", error_state),
    ]


def build_appliance_preview_gallery_entries() -> list[tuple[str, ScreenState]]:
    runtime = {
        "active_workspace": "default",
        "active_skill": "coding",
        "safety_mode": "strict",
    }
    system = {
        "lan_setup_ready": True,
    }
    jobs = [
        {"id": "daily-status", "enabled": True},
        {"id": "weekly-review", "enabled": True},
    ]

    return [
        (
            "home-ready.png",
            build_home_screen_state(
                runtime,
                {
                    "daemon_healthy": True,
                    "stt_ready": True,
                    "scheduler_enabled": True,
                },
                system,
                {
                    "ready": True,
                    "status_message": "DumplBot is ready for a first talk test.",
                    "next_action_label": "Voice",
                    "next_action_detail": "Tap next or hold enter to leave home.",
                },
                jobs,
                focused_target="voice",
            ),
        ),
        (
            "home-setup-key.png",
            build_home_screen_state(
                runtime,
                {
                    "daemon_healthy": True,
                    "stt_ready": False,
                    "scheduler_enabled": True,
                },
                system,
                {
                    "ready": False,
                    "status_message": "Add an OpenAI key on /setup to enable voice.",
                    "next_action_label": "Add key",
                    "next_action_detail": "Open /setup on the same Wi-Fi, then save the OpenAI key.",
                },
                jobs,
                focused_target="voice",
            ),
        ),
        (
            "home-setup-audio.png",
            build_home_screen_state(
                runtime,
                {
                    "daemon_healthy": True,
                    "stt_ready": True,
                    "scheduler_enabled": True,
                },
                system,
                {
                    "ready": False,
                    "status_message": "Mic and speaker still need a quick hardware check.",
                    "next_action_label": "Check audio",
                    "next_action_detail": "Record 3 seconds on Pi, then play it back before the first talk test.",
                },
                jobs,
                focused_target="voice",
            ),
        ),
    ]


def run_preview_core_gallery(
    renderer: "ConsoleRenderer",
    output_dir: str,
    scale: int,
) -> int:
    try:
        output_root = Path(output_dir)
        output_root.mkdir(parents=True, exist_ok=True)
        gallery_entries = build_core_preview_gallery_entries()

        for filename, state in gallery_entries:
            write_preview_gallery_snapshot(output_root / filename, state, scale)

        renderer.render(
            ScreenState(
                phase="Preview",
                status="Core gallery saved",
                prompt=str(output_root),
                answer="\n".join(filename for filename, _state in gallery_entries),
            )
        )
        return 0
    except RuntimeError as error:
        renderer.render(
            ScreenState(
                phase="Error",
                status="Core gallery failed",
                prompt=output_dir,
                error=str(error),
            )
        )
        return 1


def run_preview_appliance_gallery(
    renderer: "ConsoleRenderer",
    output_dir: str,
    scale: int,
) -> int:
    try:
        output_root = Path(output_dir)
        output_root.mkdir(parents=True, exist_ok=True)
        gallery_entries = build_appliance_preview_gallery_entries()

        for filename, state in gallery_entries:
            write_preview_gallery_snapshot(output_root / filename, state, scale)

        renderer.render(
            ScreenState(
                phase="Preview",
                status="Appliance gallery saved",
                prompt=str(output_root),
                answer="\n".join(filename for filename, _state in gallery_entries),
            )
        )
        return 0
    except RuntimeError as error:
        renderer.render(
            ScreenState(
                phase="Error",
                status="Appliance gallery failed",
                prompt=output_dir,
                error=str(error),
            )
        )
        return 1


def build_debug_preview_gallery_entries() -> list[tuple[str, ScreenState]]:
    debug_voice = {
        "transcript": {
            "present": True,
            "text": "planner is waiting on workspace status",
            "updated_at": "2026-03-16T09:00:00Z",
            "path": "/tmp/debug/sample.txt",
        },
        "audio": {
            "present": True,
            "size_bytes": 3584,
            "updated_at": "2026-03-16T09:00:10Z",
            "path": "/tmp/debug/sample.wav",
        },
        "error": {
            "present": True,
            "source": "runner",
            "message": "timed out while waiting for tool output",
            "updated_at": "2026-03-16T09:00:20Z",
        },
    }

    return [
        ("transcript.png", build_transcript_debug_screen_state(debug_voice)),
        ("audio.png", build_audio_debug_screen_state(debug_voice)),
        ("error.png", build_error_debug_screen_state(debug_voice)),
        ("voice-debug.png", build_voice_debug_bundle_screen_state(debug_voice)),
    ]


def run_preview_debug_gallery(
    renderer: "ConsoleRenderer",
    output_dir: str,
    scale: int,
) -> int:
    try:
        output_root = Path(output_dir)
        output_root.mkdir(parents=True, exist_ok=True)
        gallery_entries = build_debug_preview_gallery_entries()

        for filename, state in gallery_entries:
            write_preview_gallery_snapshot(output_root / filename, state, scale)

        renderer.render(
            ScreenState(
                phase="Preview",
                status="Debug gallery saved",
                prompt=str(output_root),
                answer="\n".join(filename for filename, _state in gallery_entries),
            )
        )
        return 0
    except RuntimeError as error:
        renderer.render(
            ScreenState(
                phase="Error",
                status="Debug gallery failed",
                prompt=output_dir,
                error=str(error),
            )
        )
        return 1


def build_navigation_preview_gallery_entries() -> list[tuple[str, ScreenState]]:
    return [
        (
            "home-open.png",
            build_home_hold_screen_state(
                HomeNavigationState(screen_mode="home", focused_target="voice"),
                0.66,
            ),
        ),
        (
            "voice-clear.png",
            build_home_hold_screen_state(
                HomeNavigationState(screen_mode="voice", focused_target="voice"),
                0.74,
            ),
        ),
        (
            "scheduler-summary-next-job.png",
            build_scheduler_hold_screen_state(
                SchedulerNavigationState(screen_mode="summary"),
                0.58,
            ),
        ),
        (
            "scheduler-detail-next-job.png",
            build_scheduler_hold_screen_state(
                SchedulerNavigationState(screen_mode="detail", job_id="daily-status"),
                0.82,
            ),
        ),
    ]


def run_preview_navigation_gallery(
    renderer: "ConsoleRenderer",
    output_dir: str,
    scale: int,
) -> int:
    try:
        output_root = Path(output_dir)
        output_root.mkdir(parents=True, exist_ok=True)
        gallery_entries = build_navigation_preview_gallery_entries()

        for filename, state in gallery_entries:
            write_preview_gallery_snapshot(output_root / filename, state, scale)

        renderer.render(
            ScreenState(
                phase="Preview",
                status="Navigation gallery saved",
                prompt=str(output_root),
                answer="\n".join(filename for filename, _state in gallery_entries),
            )
        )
        return 0
    except RuntimeError as error:
        renderer.render(
            ScreenState(
                phase="Error",
                status="Navigation gallery failed",
                prompt=output_dir,
                error=str(error),
            )
        )
        return 1


def build_scheduler_preview_gallery_entries() -> list[tuple[str, ScreenState]]:
    jobs = [
        {
            "id": "daily-status",
            "schedule": "daily 09:15",
            "enabled": True,
            "last_status": "success",
            "last_result": "repo clean",
        },
        {
            "id": "weekly-review",
            "schedule": "every monday at 08:30",
            "enabled": True,
            "last_status": "error",
            "last_result": "runner timed out",
        },
        {
            "id": "nightly-sync",
            "schedule": "hourly",
            "enabled": False,
        },
    ]
    history_payload = {
        "job_id": "daily-status",
        "total": 5,
        "returned": 3,
        "history": [
            {"completed_at": "2026-03-15T10:00Z", "status": "success", "result": "repo clean"},
            {"completed_at": "2026-03-14T10:00Z", "status": "error", "result": "runner timed out"},
            {"completed_at": "2026-03-13T10:00Z", "status": "success", "result": "tests passed"},
        ],
    }

    return [
        ("scheduler-summary.png", build_jobs_screen_state(jobs)),
        ("scheduler-detail.png", build_job_detail_screen_state(jobs[0], history_payload)),
        ("scheduler-history.png", build_job_history_screen_state(history_payload)),
    ]


def run_preview_scheduler_gallery(
    renderer: "ConsoleRenderer",
    output_dir: str,
    scale: int,
) -> int:
    try:
        output_root = Path(output_dir)
        output_root.mkdir(parents=True, exist_ok=True)
        gallery_entries = build_scheduler_preview_gallery_entries()

        for filename, state in gallery_entries:
            write_preview_gallery_snapshot(output_root / filename, state, scale)

        renderer.render(
            ScreenState(
                phase="Preview",
                status="Scheduler gallery saved",
                prompt=str(output_root),
                answer="\n".join(filename for filename, _state in gallery_entries),
            )
        )
        return 0
    except RuntimeError as error:
        renderer.render(
            ScreenState(
                phase="Error",
                status="Scheduler gallery failed",
                prompt=output_dir,
                error=str(error),
            )
        )
        return 1


def build_skill_preview_gallery_entries() -> list[tuple[str, ScreenState]]:
    skills = [
        {
            "id": "coding",
            "permission_mode": "balanced",
            "tool_allowlist": ["read_file", "bash"],
            "bash_prefix_allowlist": ["git", "npm run"],
            "integrations": [
                {"provider": "openai", "configured": True},
                {"provider": "anthropic", "configured": False},
            ],
            "model": {"reasoning": "high"},
            "prompt_prelude_summary": "Ship small safe changes with focused verification and readable diffs.",
            "is_active": True,
        },
        {
            "id": "research",
            "permission_mode": "strict",
            "tool_allowlist": ["read_file"],
            "bash_prefix_allowlist": [],
            "integrations": [{"provider": "openai", "configured": True}],
            "model": {"reasoning": "medium"},
            "prompt_prelude_summary": "Read docs first, keep notes concise, summarize the important parts.",
            "is_active": False,
        },
        {
            "id": "ops",
            "permission_mode": "strict",
            "tool_allowlist": ["read_file", "bash"],
            "bash_prefix_allowlist": ["systemctl", "journalctl"],
            "integrations": [],
            "model": {"reasoning": "standard"},
            "prompt_prelude_summary": "Prefer observable changes and short operational runbooks for the device.",
            "is_active": False,
        },
    ]

    return [
        ("skill-summary.png", build_skill_screen_state(skills)),
        ("skill-detail.png", build_skill_detail_screen_state(skills[0])),
    ]


def run_preview_skill_gallery(
    renderer: "ConsoleRenderer",
    output_dir: str,
    scale: int,
) -> int:
    try:
        output_root = Path(output_dir)
        output_root.mkdir(parents=True, exist_ok=True)
        gallery_entries = build_skill_preview_gallery_entries()

        for filename, state in gallery_entries:
            write_preview_gallery_snapshot(output_root / filename, state, scale)

        renderer.render(
            ScreenState(
                phase="Preview",
                status="Skill gallery saved",
                prompt=str(output_root),
                answer="\n".join(filename for filename, _state in gallery_entries),
            )
        )
        return 0
    except RuntimeError as error:
        renderer.render(
            ScreenState(
                phase="Error",
                status="Skill gallery failed",
                prompt=output_dir,
                error=str(error),
            )
        )
        return 1


def build_workspace_preview_gallery_entries() -> list[tuple[str, ScreenState]]:
    workspaces = [
        {
            "id": "default",
            "default_skill": "coding",
            "attached_repos": [{"id": "notes"}],
            "has_instructions": True,
            "is_active": True,
        },
        {
            "id": "field-lab",
            "default_skill": "research",
            "attached_repos": [],
            "has_instructions": True,
            "is_active": False,
        },
        {
            "id": "ops",
            "default_skill": None,
            "attached_repos": [{"id": "runbooks"}, {"id": "logs"}],
            "has_instructions": False,
            "is_active": False,
        },
    ]
    history_payload = {
        "workspace_id": "default",
        "total": 5,
        "returned": 3,
        "history": [
            {"completed_at": "2026-03-15T10:00Z", "status": "success", "skill": "coding", "source": "text", "summary": "repo clean"},
            {"completed_at": "2026-03-14T09:00Z", "status": "error", "skill": "research", "source": "audio", "summary": "runner timeout"},
            {"completed_at": "2026-03-13T08:00Z", "status": "success", "skill": "coding", "source": "text", "summary": "notes updated"},
        ],
    }
    files_payload = {
        "workspace_id": "default",
        "files": [
            {"path": "notes/today.md", "size": 128},
            {"path": "plans/week.md", "size": 256},
            {"path": "README.md", "size": 64},
            {"path": "todo.txt", "size": 32},
        ],
    }
    file_payload = {
        "workspace_id": "default",
        "path": "notes/today.md",
        "content": "# Today\n\n- shipped workspace visuals\n- verify gallery output\n",
    }

    return [
        ("workspace-summary.png", build_workspace_screen_state(workspaces)),
        ("workspace-detail.png", build_workspace_detail_screen_state(workspaces[0])),
        ("workspace-history.png", build_workspace_history_screen_state(history_payload)),
        ("workspace-files.png", build_workspace_files_screen_state(files_payload)),
        ("workspace-file.png", build_workspace_file_screen_state(file_payload)),
    ]


def run_preview_workspace_gallery(
    renderer: "ConsoleRenderer",
    output_dir: str,
    scale: int,
) -> int:
    try:
        output_root = Path(output_dir)
        output_root.mkdir(parents=True, exist_ok=True)
        gallery_entries = build_workspace_preview_gallery_entries()

        for filename, state in gallery_entries:
            write_preview_gallery_snapshot(output_root / filename, state, scale)

        renderer.render(
            ScreenState(
                phase="Preview",
                status="Workspace gallery saved",
                prompt=str(output_root),
                answer="\n".join(filename for filename, _state in gallery_entries),
            )
        )
        return 0
    except RuntimeError as error:
        renderer.render(
            ScreenState(
                phase="Error",
                status="Workspace gallery failed",
                prompt=output_dir,
                error=str(error),
            )
        )
        return 1


def run_home_screen(
    base_url: str,
    renderer: "ConsoleRenderer",
) -> int:
    try:
        renderer.render(
            build_home_screen_state(
                get_runtime_config_entry(base_url),
                get_setup_health_entry(base_url),
                get_setup_system_entry(base_url),
                get_setup_first_run_entry(base_url),
                list_job_entries(base_url),
                focused_target=None,
            )
        )
        return 0
    except (RuntimeError, urllib.error.URLError) as error:
        renderer.render(
            ScreenState(
                phase="Error",
                status="Home screen failed",
                error=str(error),
            )
        )
        return 1


def cycle_home_navigation_state(
    state: HomeNavigationState,
    action: str,
) -> HomeNavigationState:
    if action == "next-target":
        if state.screen_mode != "home":
            raise RuntimeError("home navigation next-target requires home mode")

        current_index = HOME_NAVIGATION_TARGET_SEQUENCE.index(state.focused_target)
        next_target = HOME_NAVIGATION_TARGET_SEQUENCE[
            (current_index + 1) % len(HOME_NAVIGATION_TARGET_SEQUENCE)
        ]
        return HomeNavigationState(screen_mode="home", focused_target=next_target)

    if action == "toggle-view":
        if state.screen_mode == "home":
            return HomeNavigationState(
                screen_mode=state.focused_target,
                focused_target=state.focused_target,
            )

        return HomeNavigationState(
            screen_mode="home",
            focused_target=state.focused_target,
        )

    if action == "clear-debug":
        if state.screen_mode != "voice":
            raise RuntimeError("home navigation clear-debug requires voice mode")

        return HomeNavigationState(
            screen_mode="voice",
            focused_target="voice",
        )

    raise RuntimeError("home navigation action is invalid")


def render_home_navigation_state(
    base_url: str,
    renderer: "ConsoleRenderer",
    state: HomeNavigationState,
) -> None:
    if state.screen_mode == "home":
        renderer.render(
            build_home_screen_state(
                get_runtime_config_entry(base_url),
                get_setup_health_entry(base_url),
                get_setup_system_entry(base_url),
                get_setup_first_run_entry(base_url),
                list_job_entries(base_url),
                focused_target=state.focused_target,
            )
        )
        return

    if state.screen_mode == "workspace":
        renderer.render(build_workspace_screen_state(list_workspace_entries(base_url)))
        return

    if state.screen_mode == "skill":
        renderer.render(build_skill_screen_state(list_skill_entries(base_url)))
        return

    if state.screen_mode == "scheduler":
        renderer.render(build_jobs_screen_state(list_job_entries(base_url)))
        return

    if state.screen_mode == "diagnostics":
        renderer.render(
            build_diagnostics_screen_state(
                get_runtime_config_entry(base_url),
                get_setup_health_entry(base_url),
                get_setup_system_entry(base_url),
            )
        )
        return

    if state.screen_mode == "voice":
        renderer.render(build_voice_debug_bundle_screen_state(get_debug_voice_entry(base_url)))
        return

    if state.screen_mode == "transcript":
        renderer.render(build_transcript_debug_screen_state(get_debug_voice_entry(base_url)))
        return

    if state.screen_mode == "audio":
        renderer.render(build_audio_debug_screen_state(get_debug_voice_entry(base_url)))
        return

    if state.screen_mode == "error":
        renderer.render(build_error_debug_screen_state(get_debug_voice_entry(base_url)))
        return

    raise RuntimeError("home navigation mode is invalid")


def run_home_navigation_preview(
    base_url: str,
    renderer: "ConsoleRenderer",
    state: HomeNavigationState,
    action: str,
) -> int:
    try:
        next_state = cycle_home_navigation_state(state, action)
        if action == "clear-debug":
            renderer.render(build_voice_debug_bundle_screen_state(clear_debug_voice_entry(base_url)))
        else:
            render_home_navigation_state(base_url, renderer, next_state)
        return 0
    except (RuntimeError, urllib.error.URLError) as error:
        renderer.render(
            ScreenState(
                phase="Error",
                status="Home navigation failed",
                prompt=action,
                error=str(error),
            )
        )
        return 1


def run_home_button_loop(
    base_url: str,
    renderer: "ConsoleRenderer",
) -> int:
    state = HomeNavigationState()
    was_pressed = False
    long_press_sent = False
    pressed_started_at: Optional[float] = None

    try:
        render_home_navigation_state(base_url, renderer, state)
    except (RuntimeError, urllib.error.URLError) as error:
        renderer.render(
            ScreenState(
                phase="Error",
                status="Home navigation failed",
                error=str(error),
            )
        )
        return 1

    while True:
        is_pressed = renderer.poll_button_pressed()

        if is_pressed is None:
            renderer.render_notice("Button polling unavailable")
            return 1

        now = time.monotonic()

        if is_pressed and not was_pressed:
            pressed_started_at = now
            long_press_sent = False
        elif (
            is_pressed
            and was_pressed
            and not long_press_sent
            and pressed_started_at is not None
        ):
            hold_progress = clamp_progress((now - pressed_started_at) / BUTTON_LONG_PRESS_SECONDS)

            if now - pressed_started_at < BUTTON_LONG_PRESS_SECONDS:
                renderer.render(build_home_hold_screen_state(state, hold_progress))
                was_pressed = is_pressed
                time.sleep(BUTTON_POLL_INTERVAL_SECONDS)
                continue

            try:
                action = "clear-debug" if state.screen_mode == "voice" else "toggle-view"
                state = cycle_home_navigation_state(state, action)
                if action == "clear-debug":
                    renderer.render(build_voice_debug_bundle_screen_state(clear_debug_voice_entry(base_url)))
                else:
                    render_home_navigation_state(base_url, renderer, state)
            except (RuntimeError, urllib.error.URLError) as error:
                renderer.render(
                    ScreenState(
                        phase="Error",
                        status="Home navigation failed",
                        prompt=action,
                        error=str(error),
                    )
                )
                return 1

            long_press_sent = True
        elif not is_pressed and was_pressed:
            if not long_press_sent:
                action = "next-target" if state.screen_mode == "home" else "toggle-view"

                try:
                    state = cycle_home_navigation_state(state, action)
                    render_home_navigation_state(base_url, renderer, state)
                except (RuntimeError, urllib.error.URLError) as error:
                    renderer.render(
                        ScreenState(
                            phase="Error",
                            status="Home navigation failed",
                            prompt=action,
                            error=str(error),
                        )
                    )
                    return 1

            pressed_started_at = None
            long_press_sent = False

        was_pressed = is_pressed
        time.sleep(BUTTON_POLL_INTERVAL_SECONDS)


def run_skill_screen(
    base_url: str,
    renderer: "ConsoleRenderer",
    refresh_seconds: float,
) -> int:
    if refresh_seconds <= 0:
        renderer.render_notice("Selection refresh must be greater than zero")
        return 1

    while True:
        try:
            renderer.render(build_skill_screen_state(list_skill_entries(base_url)))
        except (RuntimeError, urllib.error.URLError) as error:
            renderer.render(
                ScreenState(
                    phase="Error",
                    status="Skill screen failed",
                    error=str(error),
                )
            )

        time.sleep(refresh_seconds)


def run_skill_summary(
    base_url: str,
    renderer: "ConsoleRenderer",
) -> int:
    try:
        renderer.render(build_skill_screen_state(list_skill_entries(base_url)))
        return 0
    except (RuntimeError, urllib.error.URLError) as error:
        renderer.render(
            ScreenState(
                phase="Error",
                status="Skill summary failed",
                error=str(error),
            )
        )
        return 1


def run_skill_detail(
    base_url: str,
    renderer: "ConsoleRenderer",
    skill_id: str,
) -> int:
    try:
        renderer.render(build_skill_detail_screen_state(get_skill_entry(base_url, skill_id)))
        return 0
    except (RuntimeError, urllib.error.URLError) as error:
        renderer.render(
            ScreenState(
                phase="Error",
                status="Skill detail failed",
                prompt=skill_id,
                error=str(error),
            )
        )
        return 1


def run_skill_action(
    base_url: str,
    renderer: "ConsoleRenderer",
    action: str,
    selection: Optional[str] = None,
) -> int:
    renderer.render(
        ScreenState(
            phase="Skills",
            status="Updating skill",
            prompt=selection or action,
        )
    )

    try:
        if action == "cycle":
            selected_skill = cycle_skill(base_url)
        elif action == "clear":
            update_active_skill(base_url, None)
            selected_skill = "workspace/default"
        else:
            selected_skill = update_active_skill(base_url, selection)
            if selected_skill is None:
                selected_skill = "workspace/default"

        state = build_skill_screen_state(list_skill_entries(base_url))
        state.status = f"Skill: {selected_skill}"
        renderer.render(state)
        return 0
    except (RuntimeError, urllib.error.URLError) as error:
        renderer.render(
            ScreenState(
                phase="Error",
                status="Skill update failed",
                prompt=selection or action,
                error=str(error),
            )
        )
        return 1


def list_job_entries(base_url: str) -> list[dict[str, Any]]:
    payload = request_json(base_url, "/api/jobs")
    jobs = payload.get("jobs")

    if not isinstance(jobs, list):
        raise RuntimeError("job list response is invalid")

    return [job for job in jobs if isinstance(job, dict)]


def get_job_entry(base_url: str, job_id: str) -> dict[str, Any]:
    payload = request_json(base_url, f"/api/jobs/{job_id.strip().lower()}")

    if not isinstance(payload, dict) or not isinstance(payload.get("id"), str):
        raise RuntimeError("job response is invalid")

    return payload


def get_job_history(
    base_url: str,
    job_id: str,
    limit: Optional[int] = None,
    offset: int = 0,
) -> dict[str, Any]:
    path = f"/api/jobs/{job_id.strip().lower()}/history"
    query_parts: list[str] = []

    if isinstance(limit, int) and limit > 0:
        query_parts.append(f"limit={limit}")

    if offset < 0:
        raise RuntimeError("job history offset is invalid")

    if offset > 0:
        query_parts.append(f"offset={offset}")

    if query_parts:
        path = f"{path}?{'&'.join(query_parts)}"

    payload = request_json(base_url, path)

    if not isinstance(payload, dict) or not isinstance(payload.get("job_id"), str):
        raise RuntimeError("job history response is invalid")

    return payload


def normalize_optional_job_value(raw_value: str) -> Optional[str]:
    normalized_value = raw_value.strip()

    if normalized_value.lower() in {"-", "none", "null"}:
        return None

    return normalized_value


def upsert_job_entry(
    base_url: str,
    job_id: str,
    schedule: str,
    prompt: str,
    workspace: Optional[str],
    skill: Optional[str],
    enabled: bool,
) -> dict[str, Any]:
    return request_json(
        base_url,
        "/api/jobs",
        method="POST",
        payload={
            "id": job_id,
            "schedule": schedule,
            "prompt": prompt,
            "workspace": workspace,
            "skill": skill,
            "enabled": enabled,
        },
    )


def patch_job_entry(
    base_url: str,
    job_id: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    return request_json(
        base_url,
        f"/api/jobs/{job_id}",
        method="PATCH",
        payload=payload,
    )


def set_job_enabled(
    base_url: str,
    job_id: str,
    enabled: bool,
) -> dict[str, Any]:
    return request_json(
        base_url,
        f"/api/jobs/{job_id}/{'enable' if enabled else 'disable'}",
        method="POST",
    )


def delete_job_entry(base_url: str, job_id: str) -> None:
    request_json(
        base_url,
        f"/api/jobs/{job_id}",
        method="DELETE",
    )


def format_job_run_state(job: dict[str, Any]) -> str:
    last_run_at = job.get("last_run_at")
    last_status = job.get("last_status")
    last_result = job.get("last_result")
    last_duration_ms = job.get("last_duration_ms")
    last_error = job.get("last_error")
    failure_count = job.get("failure_count")
    last_success_at = job.get("last_success_at")
    run_state = "never"

    if isinstance(last_run_at, str) and last_run_at:
        run_state = last_run_at

        if isinstance(last_status, str) and last_status:
            run_state = f"{last_status} @ {last_run_at}"

    if isinstance(last_result, str) and last_result:
        run_state = f"{run_state} -> {last_result}"

    if isinstance(last_duration_ms, (int, float)):
        run_state = f"{run_state} ({int(last_duration_ms)} ms)"

    if isinstance(last_error, str) and last_error:
        run_state = f"{run_state}\nerror: {last_error}"

    if isinstance(failure_count, int):
        run_state = f"{run_state}\nfailures: {failure_count}"

    if isinstance(last_success_at, str) and last_success_at:
        run_state = f"{run_state}\nlast ok: {last_success_at}"

    return run_state


def describe_history_window(
    total: Any,
    returned: Any,
    offset: int,
) -> str:
    total_runs = total if isinstance(total, int) and total >= 0 else 0
    returned_runs = returned if isinstance(returned, int) and returned >= 0 else 0

    if total_runs == 0 or returned_runs == 0:
        return f"0/{total_runs} runs"

    end_run = max(0, total_runs - offset)
    start_run = max(1, end_run - returned_runs + 1)
    return f"{start_run}-{end_run}/{total_runs} runs"


def summarize_job_run_line(job: dict[str, Any], max_length: int = 30) -> str:
    last_status = job.get("last_status")
    last_result = job.get("last_result")

    if isinstance(last_result, str) and last_result.strip():
        return summarize_debug_value(last_result, "no result", max_length)

    if isinstance(last_status, str) and last_status.strip():
        return summarize_debug_value(last_status, "never", max_length)

    return "never"


def summarize_skill_readiness(skill: dict[str, Any]) -> tuple[str, str]:
    integrations = skill.get("integrations")
    model = skill.get("model")
    reasoning = model.get("reasoning") if isinstance(model, dict) else None
    integration_total = 0
    integration_ready = 0

    if isinstance(integrations, list):
        for integration in integrations:
            if not isinstance(integration, dict):
                continue

            if not isinstance(integration.get("provider"), str):
                continue

            integration_total += 1

            if integration.get("configured") is True:
                integration_ready += 1

    reasoning_summary = reasoning if isinstance(reasoning, str) and reasoning else "standard"
    readiness_summary = (
        f"ready {integration_ready}/{integration_total}"
        if integration_total > 0
        else "no integrations"
    )
    return (
        truncate_visual_text(reasoning_summary, 14),
        truncate_visual_text(readiness_summary, 18),
    )


def handle_jobs_command(
    base_url: str,
    command: str,
    renderer: "ConsoleRenderer",
) -> None:
    _, _, argument = command.partition(" ")
    tokens = shlex.split(argument)

    if tokens and tokens[0] in {"add", "edit"}:
        if len(tokens) < 4 or len(tokens) > 7:
            renderer.render_notice("Usage: :jobs add|edit <id> \"<schedule>\" \"<prompt>\" [workspace|-] [skill|-] [on|off]")
            return

        enabled = True

        if len(tokens) >= 7:
            enabled = tokens[6].strip().lower() not in {"off", "false", "0"}

        job = upsert_job_entry(
            base_url,
            tokens[1],
            tokens[2],
            tokens[3],
            normalize_optional_job_value(tokens[4]) if len(tokens) >= 5 else None,
            normalize_optional_job_value(tokens[5]) if len(tokens) >= 6 else None,
            enabled,
        )
        verb = "updated" if tokens[0] == "edit" else "saved"
        renderer.render_notice(f"Job {verb}: {job.get('id', tokens[1])}")
        return

    if tokens and tokens[0] == "history":
        if len(tokens) not in {2, 3}:
            renderer.render_notice("Usage: :jobs history <id> [offset]")
            return

        history_offset = 0

        if len(tokens) == 3:
            history_offset = parse_non_negative_int(tokens[2], "history offset")

        history_payload = get_job_history(
            base_url,
            tokens[1],
            limit=JOB_HISTORY_COMMAND_LIMIT,
            offset=history_offset,
        )
        history = history_payload.get("history")
        total = history_payload.get("total")
        returned = history_payload.get("returned")
        job_id = history_payload.get("job_id")

        if not isinstance(history, list) or len(history) == 0:
            print(f"Job history: {job_id or tokens[1]}")
            print("- no runs yet")
            renderer.render_notice(f"History: {job_id or tokens[1]} (0 runs)")
            return

        print(f"Job history: {job_id or tokens[1]}")

        for entry in history:
            if not isinstance(entry, dict):
                continue

            completed_at = entry.get("completed_at")
            status = entry.get("status")
            result = entry.get("result")

            if not isinstance(completed_at, str) or not isinstance(status, str):
                continue

            summary = str(result) if isinstance(result, str) and result else "(no result)"
            print(f"- {completed_at} [{status}] {summary}")

        renderer.render_notice(
            f"History: {job_id or tokens[1]} ({describe_history_window(total, returned, history_offset)})",
        )
        return

    if tokens and tokens[0] in {"on", "off"}:
        if len(tokens) != 2:
            renderer.render_notice("Usage: :jobs on|off <id>")
            return

        job = set_job_enabled(base_url, tokens[1], tokens[0] == "on")
        state = "enabled" if job.get("enabled") else "disabled"
        renderer.render_notice(f"Job {state}: {job.get('id', tokens[1])}")
        return

    if tokens and tokens[0] == "delete":
        if len(tokens) != 2:
            renderer.render_notice("Usage: :jobs delete <id>")
            return

        delete_job_entry(base_url, tokens[1])
        renderer.render_notice(f"Job deleted: {tokens[1]}")
        return

    jobs = list_job_entries(base_url)
    print("Jobs:")

    for job in jobs:
        job_id = job.get("id")
        schedule = job.get("schedule")
        enabled = job.get("enabled")
        history = job.get("history")

        if not isinstance(job_id, str) or not isinstance(schedule, str):
            continue

        status = "on" if enabled else "off"
        run_state = format_job_run_state(job)
        history_count = len(history) if isinstance(history, list) else 0
        print(f"- {job_id} [{status}] {schedule} :: {run_state} ({history_count} runs)")

    renderer.render_notice(f"Jobs listed: {len(jobs)}")


def build_jobs_screen_state(jobs: list[dict[str, Any]]) -> ScreenState:
    if not jobs:
        return ScreenState(
            phase="Jobs",
            status="No scheduler jobs",
            answer="Create jobs via /api/jobs.",
            visual={
                "kind": "jobs_summary",
                "job_count": 0,
                "enabled_count": 0,
                "cards": [],
            },
        )

    lines: list[str] = []
    cards: list[dict[str, str]] = []
    enabled_count = 0

    for job in jobs[:4]:
        job_id = job.get("id")
        schedule = job.get("schedule")
        enabled = job.get("enabled")
        if not isinstance(job_id, str) or not isinstance(schedule, str):
            continue

        marker = "on" if enabled else "off"
        summary = f"{job_id} [{marker}] {schedule}"
        summary = f"{summary}\n{format_job_run_state(job)}"

        lines.append(summary)
        cards.append({
            "id": truncate_visual_text(job_id, 16),
            "schedule": truncate_visual_text(schedule, 24),
            "run": truncate_visual_text(summarize_job_run_line(job, 30), 30),
            "state": marker,
        })

        if enabled:
            enabled_count += 1

    if len(jobs) > 4:
        lines.append(f"+{len(jobs) - 4} more")

    return ScreenState(
        phase="Jobs",
        status=f"{len(jobs)} scheduler job(s)",
        answer="\n".join(lines),
        visual={
            "kind": "jobs_summary",
            "job_count": len(jobs),
            "enabled_count": enabled_count,
            "cards": cards[:2],
            "remaining_count": max(0, len(cards) - 2),
        },
    )


def build_job_history_screen_state(
    history_payload: dict[str, Any],
    history_offset: int = 0,
) -> ScreenState:
    job_id = history_payload.get("job_id")
    history = history_payload.get("history")
    total = history_payload.get("total")
    returned = history_payload.get("returned")

    if not isinstance(job_id, str):
        raise RuntimeError("job response is invalid")

    if not isinstance(history, list) or not history:
        return ScreenState(
            phase="Jobs",
            status=f"{job_id} has no history",
            prompt=job_id,
            answer="No scheduler runs recorded.",
        )

    lines: list[str] = []
    cards: list[dict[str, str]] = []

    for entry in history:
        if not isinstance(entry, dict):
            continue

        completed_at = entry.get("completed_at")
        status = entry.get("status")
        result = entry.get("result")

        if not isinstance(completed_at, str) or not isinstance(status, str):
            continue

        summary = completed_at

        if isinstance(result, str) and result:
            summary = f"{summary}\n{status}: {result}"
        else:
            summary = f"{summary}\n{status}"

        lines.append(summary)
        cards.append({
            "time": format_visual_timestamp(completed_at),
            "status": truncate_visual_text(status, 12),
            "result": truncate_visual_text(result if isinstance(result, str) and result else "no result", 34),
        })

    return ScreenState(
        phase="Jobs",
        status=f"{job_id} history ({describe_history_window(total, returned, history_offset)})",
        prompt=job_id,
        answer="\n".join(lines) if lines else "No valid history entries.",
        visual={
            "kind": "job_history",
            "job_id": truncate_visual_text(job_id, 16),
            "window": describe_history_window(total, returned, history_offset),
            "cards": cards[:3],
        },
    )


def build_job_detail_screen_state(
    job: dict[str, Any],
    history_payload: dict[str, Any],
    history_offset: int = 0,
) -> ScreenState:
    job_id = job.get("id")
    schedule = job.get("schedule")
    enabled = job.get("enabled")
    workspace = job.get("workspace")
    skill = job.get("skill")
    history = history_payload.get("history")
    total = history_payload.get("total")
    returned = history_payload.get("returned")

    if not isinstance(job_id, str) or not isinstance(schedule, str):
        raise RuntimeError("job response is invalid")

    state = "on" if enabled else "off"
    last_run_summary = format_job_run_state(job)

    history_lines: list[str] = []

    if isinstance(history, list):
        for entry in history[-3:]:
            if not isinstance(entry, dict):
                continue

            completed_at = entry.get("completed_at")
            status = entry.get("status")
            result = entry.get("result")

            if not isinstance(completed_at, str) or not isinstance(status, str):
                continue

            summary = f"{completed_at}\n{status}"

            if isinstance(result, str) and result:
                summary = f"{summary}: {result}"

            history_lines.append(summary)

    if not history_lines:
        history_lines.append("No history entries.")

    return ScreenState(
        phase="Jobs",
        status=f"{job_id} [{state}]",
        prompt=schedule,
        answer="\n".join([
            f"workspace: {workspace if isinstance(workspace, str) and workspace else '(none)'}",
            f"skill: {skill if isinstance(skill, str) and skill else '(none)'}",
            f"history: {describe_history_window(total, returned, history_offset)}",
            f"last run: {last_run_summary}",
            *history_lines,
        ]),
        visual={
            "kind": "job_detail",
            "job_id": truncate_visual_text(job_id, 16),
            "state": state,
            "schedule": truncate_visual_text(schedule, 40),
            "workspace": truncate_visual_text(workspace if isinstance(workspace, str) and workspace else "(none)", 18),
            "skill": truncate_visual_text(skill if isinstance(skill, str) and skill else "(none)", 18),
            "history_window": describe_history_window(total, returned, history_offset),
            "last_run": truncate_visual_text(summarize_job_run_line(job, 34), 34),
        },
    )


def run_jobs_screen(
    base_url: str,
    renderer: "ConsoleRenderer",
    refresh_seconds: float,
) -> int:
    if refresh_seconds <= 0:
        renderer.render_notice("Jobs refresh must be greater than zero")
        return 1

    while True:
        try:
            jobs = list_job_entries(base_url)
            renderer.render(build_jobs_screen_state(jobs))
        except (RuntimeError, urllib.error.URLError) as error:
            renderer.render(
                ScreenState(
                    phase="Error",
                    status="Jobs screen failed",
                    error=str(error),
                )
            )

        time.sleep(refresh_seconds)


def run_job_history_screen(
    base_url: str,
    job_id: str,
    renderer: "ConsoleRenderer",
    refresh_seconds: float,
    history_offset: int = 0,
) -> int:
    if refresh_seconds <= 0:
        renderer.render_notice("Jobs refresh must be greater than zero")
        return 1

    while True:
        try:
            history_payload = get_job_history(
                base_url,
                job_id,
                limit=JOB_HISTORY_SCREEN_LIMIT,
                offset=history_offset,
            )
            renderer.render(build_job_history_screen_state(history_payload, history_offset))
        except (RuntimeError, urllib.error.URLError) as error:
            renderer.render(
                ScreenState(
                    phase="Error",
                    status="Job history failed",
                    prompt=job_id,
                    error=str(error),
                )
            )

        time.sleep(refresh_seconds)


def run_job_detail_screen(
    base_url: str,
    job_id: str,
    renderer: "ConsoleRenderer",
    refresh_seconds: float,
    history_offset: int = 0,
    initial_action: Optional[str] = None,
    patched_prompt: Optional[str] = None,
    patched_schedule: Optional[str] = None,
    patched_workspace: Optional[str] = None,
    patched_skill: Optional[str] = None,
) -> int:
    if refresh_seconds <= 0:
        renderer.render_notice("Jobs refresh must be greater than zero")
        return 1

    if initial_action is not None:
        action_result = run_job_action(base_url, initial_action, job_id, renderer)

        if action_result != 0:
            return action_result

        if initial_action == "delete":
            return 0

    if (
        patched_prompt is not None
        or patched_schedule is not None
        or patched_workspace is not None
        or patched_skill is not None
    ):
        patch_payload: dict[str, Any] = {}

        if patched_prompt is not None:
            patch_payload["prompt"] = patched_prompt

        if patched_schedule is not None:
            patch_payload["schedule"] = patched_schedule

        if patched_workspace is not None:
            patch_payload["workspace"] = normalize_optional_job_value(patched_workspace)

        if patched_skill is not None:
            patch_payload["skill"] = normalize_optional_job_value(patched_skill)

        renderer.render(
            ScreenState(
                phase="Jobs",
                status="Updating scheduler job",
                prompt=job_id,
            )
        )

        try:
            patch_job_entry(base_url, job_id, patch_payload)
        except (RuntimeError, urllib.error.URLError) as error:
            renderer.render(
                ScreenState(
                    phase="Error",
                    status="Job update failed",
                    prompt=job_id,
                    error=str(error),
                )
            )
            return 1

    while True:
        try:
            job = get_job_entry(base_url, job_id)
            history_payload = get_job_history(
                base_url,
                job_id,
                limit=JOB_DETAIL_HISTORY_LIMIT,
                offset=history_offset,
            )
            renderer.render(build_job_detail_screen_state(job, history_payload, history_offset))
        except (RuntimeError, urllib.error.URLError) as error:
            renderer.render(
                ScreenState(
                    phase="Error",
                    status="Job detail failed",
                    prompt=job_id,
                    error=str(error),
                )
            )

        time.sleep(refresh_seconds)


def run_scheduler_screen(
    base_url: str,
    screen_mode: str,
    scheduler_job: Optional[str],
    history_offset: int,
    renderer: "ConsoleRenderer",
    refresh_seconds: float,
) -> int:
    if screen_mode == "summary":
        return run_jobs_screen(base_url, renderer, refresh_seconds)

    if scheduler_job is None:
        renderer.render_notice("--scheduler-job is required for scheduler detail/history screens")
        return 1

    if screen_mode == "history":
        return run_job_history_screen(
            base_url,
            scheduler_job,
            renderer,
            refresh_seconds,
            history_offset=history_offset,
        )

    return run_job_detail_screen(
        base_url,
        scheduler_job,
        renderer,
        refresh_seconds,
        history_offset=history_offset,
    )


def list_scheduler_job_ids(jobs: list[dict[str, Any]]) -> list[str]:
    job_ids: list[str] = []

    for job in jobs:
        job_id = job.get("id")

        if isinstance(job_id, str) and job_id:
            job_ids.append(job_id)

    return job_ids


def cycle_scheduler_navigation_state(
    jobs: list[dict[str, Any]],
    state: SchedulerNavigationState,
    action: str,
) -> SchedulerNavigationState:
    job_ids = list_scheduler_job_ids(jobs)

    if action == "next-screen":
        current_index = SCHEDULER_SCREEN_SEQUENCE.index(state.screen_mode)
        next_mode = SCHEDULER_SCREEN_SEQUENCE[(current_index + 1) % len(SCHEDULER_SCREEN_SEQUENCE)]

        if next_mode == "summary" or not job_ids:
            return SchedulerNavigationState(screen_mode="summary")

        next_job_id = state.job_id if state.job_id in job_ids else job_ids[0]
        return SchedulerNavigationState(screen_mode=next_mode, job_id=next_job_id)

    if action == "next-job":
        if not job_ids:
            return SchedulerNavigationState(screen_mode="summary")

        if state.job_id in job_ids:
            current_job_index = job_ids.index(state.job_id)
            next_job_id = job_ids[(current_job_index + 1) % len(job_ids)]
        else:
            next_job_id = job_ids[0]

        next_mode = state.screen_mode if state.screen_mode != "summary" else "detail"
        return SchedulerNavigationState(screen_mode=next_mode, job_id=next_job_id)

    raise RuntimeError("scheduler navigation action is invalid")


def render_scheduler_navigation_state(
    base_url: str,
    renderer: "ConsoleRenderer",
    state: SchedulerNavigationState,
) -> None:
    if state.screen_mode == "summary":
        renderer.render(build_jobs_screen_state(list_job_entries(base_url)))
        return

    if not state.job_id:
        raise RuntimeError("scheduler navigation requires job id")

    if state.screen_mode == "history":
        history_payload = get_job_history(
            base_url,
            state.job_id,
            limit=JOB_HISTORY_SCREEN_LIMIT,
            offset=state.history_offset,
        )
        renderer.render(build_job_history_screen_state(history_payload, state.history_offset))
        return

    job = get_job_entry(base_url, state.job_id)
    history_payload = get_job_history(
        base_url,
        state.job_id,
        limit=JOB_DETAIL_HISTORY_LIMIT,
        offset=state.history_offset,
    )
    renderer.render(build_job_detail_screen_state(job, history_payload, state.history_offset))


def run_scheduler_navigation_preview(
    base_url: str,
    renderer: "ConsoleRenderer",
    state: SchedulerNavigationState,
    action: str,
) -> int:
    try:
        next_state = cycle_scheduler_navigation_state(list_job_entries(base_url), state, action)
        render_scheduler_navigation_state(base_url, renderer, next_state)
        return 0
    except (RuntimeError, urllib.error.URLError) as error:
        renderer.render(
            ScreenState(
                phase="Error",
                status="Scheduler navigation failed",
                prompt=action,
                error=str(error),
            )
        )
        return 1


def run_scheduler_button_loop(
    base_url: str,
    renderer: "ConsoleRenderer",
) -> int:
    state = SchedulerNavigationState()
    was_pressed = False
    long_press_sent = False
    pressed_started_at: Optional[float] = None

    try:
        render_scheduler_navigation_state(base_url, renderer, state)
    except (RuntimeError, urllib.error.URLError) as error:
        renderer.render(
            ScreenState(
                phase="Error",
                status="Scheduler navigation failed",
                error=str(error),
            )
        )
        return 1

    while True:
        is_pressed = renderer.poll_button_pressed()

        if is_pressed is None:
            renderer.render_notice("Button polling unavailable")
            return 1

        now = time.monotonic()

        if is_pressed and not was_pressed:
            pressed_started_at = now
            long_press_sent = False
        elif (
            is_pressed
            and was_pressed
            and not long_press_sent
            and pressed_started_at is not None
        ):
            hold_progress = clamp_progress((now - pressed_started_at) / BUTTON_LONG_PRESS_SECONDS)

            if now - pressed_started_at < BUTTON_LONG_PRESS_SECONDS:
                renderer.render(build_scheduler_hold_screen_state(state, hold_progress))
                was_pressed = is_pressed
                time.sleep(BUTTON_POLL_INTERVAL_SECONDS)
                continue

            try:
                state = cycle_scheduler_navigation_state(list_job_entries(base_url), state, "next-job")
                render_scheduler_navigation_state(base_url, renderer, state)
            except (RuntimeError, urllib.error.URLError) as error:
                renderer.render(
                    ScreenState(
                        phase="Error",
                        status="Scheduler navigation failed",
                        prompt="next-job",
                        error=str(error),
                    )
                )
                return 1

            long_press_sent = True
        elif not is_pressed and was_pressed:
            if not long_press_sent:
                try:
                    state = cycle_scheduler_navigation_state(list_job_entries(base_url), state, "next-screen")
                    render_scheduler_navigation_state(base_url, renderer, state)
                except (RuntimeError, urllib.error.URLError) as error:
                    renderer.render(
                        ScreenState(
                            phase="Error",
                            status="Scheduler navigation failed",
                            prompt="next-screen",
                            error=str(error),
                        )
                    )
                    return 1

            pressed_started_at = None
            long_press_sent = False

        was_pressed = is_pressed
        time.sleep(BUTTON_POLL_INTERVAL_SECONDS)


def stream_audio_talk(
    base_url: str,
    audio_id: str,
    workspace: Optional[str],
    skill: Optional[str],
    renderer: "ConsoleRenderer",
) -> ScreenState:
    state = ScreenState(
        phase="Transcribing",
        status="Sending capture",
        transcript=audio_id,
        visual={
            "kind": "stage",
            "title": "Transcribing",
            "badge": "wav",
            "lead": "Sending capture",
            "detail": truncate_visual_text(audio_id, 48),
            "footer": "hold to cancel",
        },
    )
    payload: dict[str, str] = {}

    if workspace:
        payload["workspace"] = workspace

    if skill:
        payload["skill"] = skill

    request = urllib.request.Request(
        f"{base_url}/api/audio/{audio_id}/talk",
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    renderer.render(state)

    stream_sse_request(request, base_url, renderer, state)

    return state


def run_audio_talk_from_file(
    base_url: str,
    audio_path: str,
    workspace: Optional[str],
    skill: Optional[str],
    renderer: "ConsoleRenderer",
) -> ScreenState:
    state = ScreenState(
        phase="Saved",
        status="Sending capture",
        transcript=audio_path,
        visual={
            "kind": "stage",
            "title": "Saved",
            "badge": "wav",
            "lead": "Sending capture",
            "detail": truncate_visual_text(audio_path, 64),
            "footer": "hold to cancel",
        },
    )
    renderer.render(state)

    try:
        audio_id = upload_audio_file(base_url, audio_path)
    except (OSError, RuntimeError, urllib.error.URLError) as error:
        state.phase = "Error"
        state.status = "Audio upload failed"
        state.error = str(error)
        state.visual = {
            "kind": "stage",
            "title": "Error",
            "badge": "wav",
            "lead": "Upload failed",
            "detail": str(error),
            "footer": "check host on wi-fi",
        }
        renderer.render(state)
        return state

    return stream_audio_talk(base_url, audio_id, workspace, skill, renderer)


def format_field(label: str, value: str, width: int = SCREEN_WIDTH) -> list[str]:
    prefix = f"{label}: " if label else ""
    indent = " " * len(prefix)
    lines: list[str] = []
    logical_lines = value.splitlines() or [""]

    for index, logical_line in enumerate(logical_lines):
        line_prefix = prefix if index == 0 else indent
        wrap_width = max(8, width - len(line_prefix))
        wrapped = textwrap.wrap(logical_line, width=wrap_width) or [""]
        lines.append(f"{line_prefix}{wrapped[0]}")

        for wrapped_line in wrapped[1:]:
            lines.append(f"{indent}{wrapped_line}")

    return lines


def build_screen_lines(
    state: ScreenState,
    width: int = SCREEN_WIDTH,
) -> list[str]:
    lines = [
        f"Status: {state.status}",
    ]

    if state.prompt:
        lines.extend(format_field("Prompt", state.prompt, width))

    if state.transcript:
        lines.extend(format_field("Heard", state.transcript, width))

    if state.tool_banner:
        lines.extend(format_field("Tool", state.tool_banner, width))

    show_answer = bool(
        state.prompt
        or state.answer
        or state.phase in {"Thinking", "Transcribing", "Tool", "Answer", "Error"}
    )

    if show_answer:
        lines.append("Answer:")
        lines.extend(format_field("", state.answer or "(waiting for tokens)", width))

    if state.error:
        lines.extend(format_field("Error", state.error, width))

    return lines


def get_phase_rgb(phase: str) -> tuple[int, int, int]:
    return WHISPLAY_PHASE_RGB.get(phase, (32, 32, 32))


def load_pillow() -> Optional[tuple[Any, Any, Any]]:
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return None

    return Image, ImageDraw, ImageFont


def load_display_fonts(font_module: Any) -> dict[str, Any]:
    default_font = font_module.load_default()

    def load_named_font(name: str, size: int) -> Any:
        try:
            return font_module.truetype(name, size)
        except Exception:
            return default_font

    return {
        "tiny": load_named_font("DejaVuSans.ttf", 10),
        "label": load_named_font("DejaVuSans.ttf", 11),
        "body": load_named_font("DejaVuSans.ttf", 13),
        "title": load_named_font("DejaVuSans-Bold.ttf", 15),
        "hero": load_named_font("DejaVuSans-Bold.ttf", 22),
        "default": default_font,
    }


def load_preview_modules() -> Optional[tuple[Any, Any]]:
    try:
        import tkinter as tk
        from PIL import ImageTk
    except ImportError:
        return None

    return tk, ImageTk


def load_whisplay_board() -> Optional[Any]:
    try:
        from WhisPlay import WhisPlayBoard
    except ImportError:
        return None

    return WhisPlayBoard


def image_to_rgb565(image: Any) -> list[int]:
    pixel_data: list[int] = []

    for red, green, blue in image.convert("RGB").getdata():
        rgb565 = ((red & 0xF8) << 8) | ((green & 0xFC) << 3) | (blue >> 3)
        pixel_data.append((rgb565 >> 8) & 0xFF)
        pixel_data.append(rgb565 & 0xFF)

    return pixel_data


def truncate_visual_text(value: Any, max_length: int) -> str:
    if not isinstance(value, str):
        return "(none)"

    collapsed = " ".join(value.strip().split())

    if not collapsed:
        return "(none)"

    if len(collapsed) <= max_length:
        return collapsed

    return f"{collapsed[:max_length - 1]}..."


def compact_home_value(value: Any, max_length: int = 12) -> str:
    compacted = truncate_visual_text(value, max_length + 10)

    if compacted.endswith(" (default)"):
        compacted = compacted.removesuffix(" (default)")

    return truncate_visual_text(compacted, max_length)


def compact_badge_value(value: Any, max_length: int = 8) -> str:
    if isinstance(value, str) and value:
        value = value.split("-", 1)[0]

    return truncate_visual_text(value, max_length)


def format_visual_timestamp(value: Any) -> str:
    if not isinstance(value, str) or not value:
        return "(unknown)"

    normalized = value.replace("Z", "+00:00")

    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return truncate_visual_text(value, 18)

    return parsed.strftime("%b %d %H:%M")


def draw_text_block(
    draw: Any,
    text: str,
    x: int,
    y: int,
    max_width: int,
    font: Any,
    fill: tuple[int, int, int],
    line_gap: int = 3,
    max_lines: Optional[int] = None,
) -> int:
    lines = textwrap.wrap(text, width=max(8, max_width // 7)) or [text]

    if max_lines is not None:
        lines = lines[:max_lines]

    cursor_y = y

    for line in lines:
        draw.text((x, cursor_y), line, fill=fill, font=font)
        bbox = draw.textbbox((x, cursor_y), line, font=font)
        cursor_y = bbox[3] + line_gap

    return cursor_y


def draw_status_chip(
    draw: Any,
    x: int,
    y: int,
    width: int,
    label: str,
    active: bool,
    fonts: dict[str, Any],
) -> None:
    fill = (28, 64, 84) if active else (34, 40, 46)
    text_fill = (222, 242, 247) if active else (162, 171, 179)
    draw.rounded_rectangle((x, y, x + width, y + 20), radius=8, fill=fill)
    draw.text((x + 8, y + 5), label, fill=text_fill, font=fonts["tiny"])


def draw_inline_chip(
    draw: Any,
    x: int,
    y: int,
    text: str,
    font: Any,
    fill: tuple[int, int, int],
    text_fill: tuple[int, int, int],
    radius: int = 10,
    padding_x: int = 8,
    padding_y: int = 5,
) -> int:
    bbox = draw.textbbox((0, 0), text, font=font)
    width = (bbox[2] - bbox[0]) + (padding_x * 2)
    height = (bbox[3] - bbox[1]) + (padding_y * 2)
    draw.rounded_rectangle((x, y, x + width, y + height), radius=radius, fill=fill)
    draw.text((x + padding_x, y + padding_y - 1), text, fill=text_fill, font=font)
    return width


def measure_inline_chip_width(
    draw: Any,
    text: str,
    font: Any,
    padding_x: int = 8,
) -> int:
    bbox = draw.textbbox((0, 0), text, font=font)
    return (bbox[2] - bbox[0]) + (padding_x * 2)


def draw_panel_card(
    draw: Any,
    x: int,
    y: int,
    width: int,
    height: int,
    title: str,
    value: str,
    fonts: dict[str, Any],
    accent: tuple[int, int, int],
    body_fill: tuple[int, int, int] = (16, 23, 29),
) -> None:
    draw.rounded_rectangle((x, y, x + width, y + height), radius=12, fill=body_fill)
    draw.text((x + 10, y + 8), title.upper(), fill=accent, font=fonts["tiny"])
    draw_text_block(
        draw,
        value,
        x + 10,
        y + 24,
        width - 20,
        fonts["body"],
        WHISPLAY_FOREGROUND,
        max_lines=2,
    )


def visual_path_name(path_value: Any) -> str:
    if not isinstance(path_value, str) or not path_value:
        return "(none)"

    return truncate_visual_text(Path(path_value).name, 18)


def visual_parent_path(path_value: Any, max_length: int = 18) -> str:
    if not isinstance(path_value, str) or not path_value:
        return "(root)"

    parent = Path(path_value).parent.as_posix()

    if parent in {"", "."}:
        return "workspace root"

    return truncate_visual_text(parent, max_length)


def visual_size_label(size_value: Any) -> str:
    if not isinstance(size_value, int) or size_value < 0:
        return "(size?)"

    if size_value < 1024:
        return f"{size_value} B"

    if size_value < 1024 * 1024:
        return f"{size_value / 1024:.1f} KB"

    return f"{size_value / (1024 * 1024):.1f} MB"


def build_brand_splash_state(
    phase: str,
    badge: str,
    title: str,
    detail: str,
) -> ScreenState:
    return ScreenState(
        phase=phase,
        status=detail,
        visual={
            "kind": "brand_splash",
            "badge": truncate_visual_text(badge, 12),
            "title": truncate_visual_text(title, 22),
            "detail": truncate_visual_text(detail, 40),
        },
    )


def render_brand_splash_visual(
    draw: Any,
    state: ScreenState,
    fonts: dict[str, Any],
    width: int,
    height: int,
    accent: tuple[int, int, int],
) -> None:
    visual = state.visual or {}

    draw.rounded_rectangle((10, 8, width - 10, 42), radius=14, fill=(18, 34, 48))
    draw.text((18, 18), "DUMPLBOT", fill=(236, 240, 244), font=fonts["title"])
    draw.rounded_rectangle((width - 66, 14, width - 18, 36), radius=10, fill=(22, 28, 36))
    draw.text((width - 57, 20), truncate_visual_text(visual.get("badge"), 10).upper(), fill=accent, font=fonts["tiny"])

    draw.rounded_rectangle((12, 82, width - 12, 238), radius=18, fill=(22, 28, 36))
    draw.text((22, 102), "NOW", fill=accent, font=fonts["tiny"])
    draw_text_block(
        draw,
        truncate_visual_text(visual.get("title"), 22).upper(),
        22,
        128,
        width - 44,
        fonts["hero"],
        WHISPLAY_FOREGROUND,
        max_lines=3,
    )
    draw_text_block(
        draw,
        truncate_visual_text(visual.get("detail"), 40),
        22,
        196,
        width - 44,
        fonts["label"],
        (174, 182, 190),
        max_lines=3,
    )


def render_home_visual(
    draw: Any,
    state: ScreenState,
    fonts: dict[str, Any],
    width: int,
    height: int,
    accent: tuple[int, int, int],
) -> None:
    visual = state.visual if isinstance(state.visual, dict) else {}
    workspace = compact_home_value(visual.get("workspace"))
    skill = compact_home_value(visual.get("skill"))
    safety = truncate_visual_text(visual.get("safety"), 18)
    focused_target = truncate_visual_text(visual.get("focused_target"), 18)
    enabled_jobs = visual.get("enabled_jobs")
    job_count = visual.get("job_count")
    first_run_ready = visual.get("first_run_ready") is True
    first_run_message = truncate_visual_text(visual.get("first_run_message"), 52)
    next_action_label = truncate_visual_text(visual.get("next_action_label"), 18)
    next_action_detail = truncate_visual_text(visual.get("next_action_visual_detail"), 44)
    detail_text = first_run_message if first_run_ready and first_run_message not in {"", "(none)"} else next_action_detail
    normalized_next_action = next_action_label.strip().lower()
    home_title = "NEXT TARGET"

    if first_run_ready:
        action_left = "browse"
        action_right = "talk" if focused_target.lower() == "voice" else "open"
        if focused_target.lower() == "voice":
            home_title = "TALK NOW"
            detail_text = "hold to talk"
    elif normalized_next_action == "add key":
        action_left = "setup"
        action_right = "save key"
    elif normalized_next_action == "check audio":
        action_left = "setup"
        action_right = "test audio"
    else:
        action_left = "setup"
        action_right = "next"

    draw.rounded_rectangle((10, 8, width - 10, 42), radius=14, fill=(18, 34, 48))
    draw.text((18, 18), "DUMPLBOT", fill=(236, 240, 244), font=fonts["title"])
    badge_fill = (24, 48, 30) if first_run_ready else (75, 61, 23)
    badge_text = "READY" if first_run_ready else "SETUP"
    badge_color = (201, 230, 160) if first_run_ready else (244, 215, 131)
    draw.rounded_rectangle((width - 70, 14, width - 18, 36), radius=10, fill=badge_fill)
    draw.text((width - 60, 20), badge_text, fill=badge_color, font=fonts["tiny"])

    draw_panel_card(draw, 12, 56, 70, 50, "Workspace", workspace, fonts, accent)
    draw_panel_card(draw, 88, 56, 70, 50, "Skill", skill, fonts, accent)

    draw_status_chip(draw, 12, 116, 70, "daemon ok" if visual.get("daemon_healthy") else "daemon issue", bool(visual.get("daemon_healthy")), fonts)
    draw_status_chip(draw, 88, 116, 70, "stt ready" if visual.get("stt_ready") else "stt miss", bool(visual.get("stt_ready")), fonts)
    draw_status_chip(draw, 12, 142, 70, "sched on" if visual.get("scheduler_enabled") else "sched off", bool(visual.get("scheduler_enabled")), fonts)
    draw_status_chip(draw, 88, 142, 70, "lan ready" if visual.get("lan_setup_ready") else "lan wait", bool(visual.get("lan_setup_ready")), fonts)

    draw.rounded_rectangle((12, 176, width - 12, 272), radius=16, fill=(22, 28, 36))
    draw.text((22, 188), home_title if first_run_ready else "SETUP STEP", fill=accent, font=fonts["tiny"])
    draw_text_block(
        draw,
        (focused_target if first_run_ready else next_action_label).upper(),
        22,
        206,
        width - 44,
        fonts["hero"],
        WHISPLAY_FOREGROUND,
        max_lines=2,
    )
    draw_text_block(
        draw,
        detail_text,
        22,
        236,
        width - 44,
        fonts["tiny"],
        (160, 170, 180),
        max_lines=1,
    )
    action_y = 252
    left_width = draw_inline_chip(
        draw,
        22,
        action_y,
        action_left.upper(),
        fonts["tiny"],
        (27, 44, 58),
        (213, 233, 241),
    )
    draw_inline_chip(
        draw,
        30 + left_width,
        action_y,
        action_right.upper(),
        fonts["tiny"],
        (31, 36, 42),
        (183, 191, 198),
    )

    safety_text = f"SAFETY {truncate_visual_text(safety.upper(), 8)}"
    jobs_text = (
        f"JOBS {enabled_jobs}/{job_count}"
        if isinstance(enabled_jobs, int) and isinstance(job_count, int)
        else "JOBS ?"
    )
    footer_y = height - 28
    draw_inline_chip(draw, 12, footer_y, safety_text, fonts["tiny"], (18, 24, 30), (154, 162, 170))
    jobs_width = draw.textbbox((0, 0), jobs_text, font=fonts["tiny"])
    draw_inline_chip(
        draw,
        width - 12 - ((jobs_width[2] - jobs_width[0]) + 16),
        footer_y,
        jobs_text,
        fonts["tiny"],
        (18, 24, 30),
        (154, 162, 170),
    )


def render_detail_visual(
    draw: Any,
    title: str,
    badge: str,
    lead_label: str,
    lead_value: str,
    meta_left: str,
    meta_right: str,
    fonts: dict[str, Any],
    width: int,
    height: int,
    accent: tuple[int, int, int],
) -> None:
    draw.rounded_rectangle((10, 8, width - 10, 42), radius=14, fill=(18, 34, 48))
    draw.text((18, 18), title.upper(), fill=(236, 240, 244), font=fonts["title"])
    draw.rounded_rectangle((width - 66, 14, width - 18, 36), radius=10, fill=(22, 28, 36))
    draw.text((width - 57, 20), badge.upper(), fill=accent, font=fonts["tiny"])

    draw.rounded_rectangle((12, 58, width - 12, 220), radius=16, fill=(22, 28, 36))
    draw.text((22, 72), lead_label.upper(), fill=accent, font=fonts["tiny"])
    draw_text_block(
        draw,
        lead_value,
        22,
        92,
        width - 44,
        fonts["body"],
        WHISPLAY_FOREGROUND,
        max_lines=8,
    )

    draw_panel_card(draw, 12, 232, 70, 48, "Age", meta_left, fonts, accent, body_fill=(16, 23, 29))
    draw_panel_card(draw, 88, 232, 70, 48, "File", meta_right, fonts, accent, body_fill=(16, 23, 29))
    draw.text((14, height - 22), "debug surface", fill=(154, 162, 170), font=fonts["tiny"])


def render_voice_debug_visual(
    draw: Any,
    state: ScreenState,
    fonts: dict[str, Any],
    width: int,
    height: int,
    accent: tuple[int, int, int],
) -> None:
    visual = state.visual if isinstance(state.visual, dict) else {}
    heard_value = truncate_visual_text(visual.get("heard"), 34)
    audio_value = truncate_visual_text(visual.get("audio"), 34)
    error_value = truncate_visual_text(visual.get("error"), 34)
    draw.rounded_rectangle((10, 8, width - 10, 42), radius=14, fill=(18, 34, 48))
    draw.text((18, 18), "VOICE DEBUG", fill=(236, 240, 244), font=fonts["title"])
    draw.rounded_rectangle((width - 66, 14, width - 18, 36), radius=10, fill=(22, 28, 36))
    draw.text((width - 55, 20), "TRIAGE", fill=accent, font=fonts["tiny"])

    cards = [
        ("Heard", heard_value, truncate_visual_text(visual.get("heard_age"), 12), (85, 133, 69)),
        ("Audio", audio_value, truncate_visual_text(visual.get("audio_age"), 12), (98, 192, 255)),
        ("Error", error_value, truncate_visual_text(visual.get("error_age"), 12), (255, 122, 89) if error_value != "clear" else (79, 89, 99)),
    ]

    card_y = 58

    for title, value, age, card_accent in cards:
        draw.rounded_rectangle((12, card_y, width - 12, card_y + 56), radius=14, fill=(22, 28, 36))
        draw.rounded_rectangle((18, card_y + 10, 22, card_y + 44), radius=2, fill=card_accent)
        draw.text((28, card_y + 10), title.upper(), fill=card_accent, font=fonts["tiny"])
        age_width = measure_inline_chip_width(draw, age.upper(), fonts["tiny"])
        draw.rounded_rectangle((width - 18 - age_width, card_y + 8, width - 18, card_y + 28), radius=10, fill=(30, 36, 44))
        draw.text((width - 18 - age_width + 8, card_y + 13), age.upper(), fill=(154, 162, 170), font=fonts["tiny"])
        draw_text_block(draw, value, 28, card_y + 28, width - 56, fonts["body"], WHISPLAY_FOREGROUND, max_lines=2)
        card_y += 64

    back_width = draw_inline_chip(draw, 12, height - 28, "TAP BACK", fonts["tiny"], (18, 24, 30), (154, 162, 170))
    draw_inline_chip(draw, 20 + back_width, height - 28, "HOLD CLEAR", fonts["tiny"], (33, 40, 46), (195, 201, 207))


def render_stage_visual(
    draw: Any,
    title: str,
    badge: str,
    lead: str,
    detail: str,
    footer: str,
    fonts: dict[str, Any],
    width: int,
    height: int,
    accent: tuple[int, int, int],
    progress: float = 0.0,
    progress_label: Optional[str] = None,
) -> None:
    draw.rounded_rectangle((10, 8, width - 10, 42), radius=14, fill=(18, 34, 48))
    draw.text((18, 18), title.upper(), fill=(236, 240, 244), font=fonts["title"])
    draw.rounded_rectangle((width - 66, 14, width - 18, 36), radius=10, fill=(22, 28, 36))
    draw.text((width - 57, 20), badge.upper(), fill=accent, font=fonts["tiny"])

    draw.rounded_rectangle((12, 66, width - 12, 236), radius=18, fill=(22, 28, 36))
    draw.text((22, 82), "NOW", fill=accent, font=fonts["tiny"])
    draw_text_block(
        draw,
        lead,
        22,
        104,
        width - 44,
        fonts["hero"],
        WHISPLAY_FOREGROUND,
        max_lines=4,
    )
    draw_text_block(
        draw,
        detail,
        22,
        178,
        width - 44,
        fonts["label"],
        (174, 182, 190),
        max_lines=3,
    )

    progress_fraction = clamp_progress(progress)

    if progress_fraction > 0 or progress_label:
        progress_label_text = truncate_visual_text(progress_label or "hold", 18).upper()
        progress_percent = f"{int(progress_fraction * 100):d}%"
        draw.text((22, 212), progress_label_text, fill=accent, font=fonts["tiny"])
        progress_bbox = draw.textbbox((0, 0), progress_percent, font=fonts["tiny"])
        draw.text((width - 22 - (progress_bbox[2] - progress_bbox[0]), 212), progress_percent, fill=(154, 162, 170), font=fonts["tiny"])
        track_left = 22
        track_top = 228
        track_right = width - 22
        track_bottom = 240
        draw.rounded_rectangle((track_left, track_top, track_right, track_bottom), radius=6, fill=(14, 19, 24))
        fill_right = track_left + int((track_right - track_left) * progress_fraction)
        if fill_right > track_left:
            draw.rounded_rectangle((track_left, track_top, fill_right, track_bottom), radius=6, fill=accent)

    draw.text((14, height - 22), footer, fill=(154, 162, 170), font=fonts["tiny"])


def render_result_visual(
    draw: Any,
    title: str,
    badge: str,
    label: str,
    body: str,
    footer: str,
    fonts: dict[str, Any],
    width: int,
    height: int,
    accent: tuple[int, int, int],
) -> None:
    draw.rounded_rectangle((10, 8, width - 10, 42), radius=14, fill=(18, 34, 48))
    draw.text((18, 18), title.upper(), fill=(236, 240, 244), font=fonts["title"])
    draw.rounded_rectangle((width - 66, 14, width - 18, 36), radius=10, fill=(22, 28, 36))
    draw.text((width - 57, 20), badge.upper(), fill=accent, font=fonts["tiny"])

    draw.rounded_rectangle((12, 58, width - 12, 268), radius=16, fill=(22, 28, 36))
    draw.text((22, 72), label.upper(), fill=accent, font=fonts["tiny"])
    draw_text_block(
        draw,
        body,
        22,
        92,
        width - 44,
        fonts["body"],
        WHISPLAY_FOREGROUND,
        max_lines=11,
    )
    draw.text((14, height - 22), footer, fill=(154, 162, 170), font=fonts["tiny"])


def render_jobs_summary_visual(
    draw: Any,
    state: ScreenState,
    fonts: dict[str, Any],
    width: int,
    height: int,
    accent: tuple[int, int, int],
) -> None:
    visual = state.visual or {}
    cards = visual.get("cards")
    job_count = visual.get("job_count")
    enabled_count = visual.get("enabled_count")
    remaining_count = visual.get("remaining_count")

    draw.rounded_rectangle((10, 8, width - 10, 42), radius=14, fill=(18, 34, 48))
    draw.text((18, 18), "SCHEDULER", fill=(236, 240, 244), font=fonts["title"])
    draw.rounded_rectangle((width - 58, 14, width - 18, 36), radius=10, fill=(22, 28, 36))
    draw.text((width - 48, 20), str(job_count or 0), fill=accent, font=fonts["tiny"])

    draw.rounded_rectangle((12, 58, width - 12, 106), radius=14, fill=(22, 28, 36))
    draw.text((22, 72), "ACTIVE", fill=accent, font=fonts["tiny"])
    draw_text_block(
        draw,
        f"{enabled_count or 0} of {job_count or 0} jobs on",
        22,
        86,
        width - 44,
        fonts["body"],
        WHISPLAY_FOREGROUND,
        max_lines=1,
    )

    if not isinstance(cards, list) or not cards:
        draw.rounded_rectangle((12, 118, width - 12, 244), radius=16, fill=(22, 28, 36))
        draw.text((22, 132), "QUEUE", fill=accent, font=fonts["tiny"])
        draw_text_block(
            draw,
            "No jobs yet",
            22,
            156,
            width - 44,
            fonts["hero"],
            WHISPLAY_FOREGROUND,
            max_lines=2,
        )
        draw.text((14, height - 22), "add jobs from host or setup", fill=(154, 162, 170), font=fonts["tiny"])
        return

    card_y = 118

    for card in cards[:2]:
        if not isinstance(card, dict):
            continue

        draw.rounded_rectangle((12, card_y, width - 12, card_y + 56), radius=14, fill=(22, 28, 36))
        draw.text((22, card_y + 10), truncate_visual_text(card.get("id"), 16).upper(), fill=accent, font=fonts["tiny"])
        chip_fill = (36, 81, 107) if card.get("state") == "on" else (43, 50, 58)
        chip_text = (227, 245, 251) if card.get("state") == "on" else (195, 201, 207)
        draw.rounded_rectangle((width - 52, card_y + 8, width - 18, card_y + 28), radius=10, fill=chip_fill)
        draw.text((width - 43, card_y + 13), truncate_visual_text(card.get("state"), 3).upper(), fill=chip_text, font=fonts["tiny"])
        draw_text_block(draw, truncate_visual_text(card.get("schedule"), 22), 22, card_y + 28, width - 70, fonts["label"], WHISPLAY_FOREGROUND, max_lines=1)
        run_text = truncate_visual_text(card.get("run"), 16).upper()
        run_width = measure_inline_chip_width(draw, run_text, fonts["tiny"])
        draw.rounded_rectangle((22, card_y + 40, 22 + run_width, card_y + 60), radius=10, fill=(31, 36, 42))
        draw.text((30, card_y + 45), run_text, fill=(183, 191, 198), font=fonts["tiny"])
        card_y += 64

    footer = "hold next job"

    if isinstance(remaining_count, int) and remaining_count > 0:
        footer = f"+{remaining_count} more  ·  hold next"

    draw.text((14, height - 22), footer, fill=(154, 162, 170), font=fonts["tiny"])


def render_job_detail_visual(
    draw: Any,
    state: ScreenState,
    fonts: dict[str, Any],
    width: int,
    height: int,
    accent: tuple[int, int, int],
) -> None:
    visual = state.visual or {}
    state_value = truncate_visual_text(visual.get("state"), 3)
    schedule = truncate_visual_text(visual.get("schedule"), 42)
    workspace = truncate_visual_text(visual.get("workspace"), 18)
    skill = truncate_visual_text(visual.get("skill"), 18)
    history_window = truncate_visual_text(visual.get("history_window"), 18)
    last_run = truncate_visual_text(visual.get("last_run"), 38)

    draw.rounded_rectangle((10, 8, width - 10, 42), radius=14, fill=(18, 34, 48))
    draw.text((18, 18), "JOB DETAIL", fill=(236, 240, 244), font=fonts["title"])
    draw.rounded_rectangle((width - 52, 14, width - 18, 36), radius=10, fill=(22, 28, 36))
    draw.text((width - 44, 20), state_value.upper(), fill=accent, font=fonts["tiny"])

    draw.rounded_rectangle((12, 58, width - 12, 132), radius=16, fill=(22, 28, 36))
    draw.text((22, 72), "SCHEDULE", fill=accent, font=fonts["tiny"])
    draw_text_block(draw, truncate_visual_text(visual.get("job_id"), 16).upper(), 22, 88, width - 44, fonts["tiny"], (154, 162, 170), max_lines=1)
    draw_text_block(draw, schedule, 22, 102, width - 44, fonts["body"], WHISPLAY_FOREGROUND, max_lines=2)

    draw_panel_card(draw, 12, 144, 70, 48, "Workspace", workspace, fonts, accent, body_fill=(16, 23, 29))
    draw_panel_card(draw, 88, 144, 70, 48, "Skill", skill, fonts, accent, body_fill=(16, 23, 29))

    draw.rounded_rectangle((12, 204, width - 12, 244), radius=14, fill=(22, 28, 36))
    draw.text((22, 218), "HISTORY", fill=accent, font=fonts["tiny"])
    draw_inline_chip(draw, width - 84, 212, history_window.upper(), fonts["tiny"], (31, 36, 42), (183, 191, 198))

    draw.rounded_rectangle((12, 254, width - 12, 286), radius=14, fill=(22, 28, 36))
    draw.text((22, 266), "LAST RUN", fill=accent, font=fonts["tiny"])
    draw_text_block(draw, last_run, 22, 278, width - 44, fonts["tiny"], WHISPLAY_FOREGROUND, max_lines=1)

    history_chip_width = draw_inline_chip(draw, 12, height - 28, "HISTORY", fonts["tiny"], (18, 24, 30), (154, 162, 170))
    draw_inline_chip(draw, 20 + history_chip_width, height - 28, "NEXT JOB", fonts["tiny"], (33, 40, 46), (195, 201, 207))


def render_job_history_visual(
    draw: Any,
    state: ScreenState,
    fonts: dict[str, Any],
    width: int,
    height: int,
    accent: tuple[int, int, int],
) -> None:
    visual = state.visual or {}
    cards = visual.get("cards")

    draw.rounded_rectangle((10, 8, width - 10, 42), radius=14, fill=(18, 34, 48))
    draw.text((18, 18), "HISTORY", fill=(236, 240, 244), font=fonts["title"])
    draw.rounded_rectangle((width - 74, 14, width - 18, 36), radius=10, fill=(22, 28, 36))
    draw.text((width - 66, 20), truncate_visual_text(visual.get("window"), 12), fill=accent, font=fonts["tiny"])

    draw.text((14, 58), truncate_visual_text(visual.get("job_id"), 16).upper(), fill=accent, font=fonts["tiny"])

    if not isinstance(cards, list) or not cards:
        draw.rounded_rectangle((12, 76, width - 12, 212), radius=16, fill=(22, 28, 36))
        draw_text_block(draw, "No runs yet", 22, 106, width - 44, fonts["hero"], WHISPLAY_FOREGROUND, max_lines=2)
        draw.text((14, height - 22), "short: summary  long: next job", fill=(154, 162, 170), font=fonts["tiny"])
        return

    card_y = 76

    for card in cards[:3]:
        if not isinstance(card, dict):
            continue

        status_text = truncate_visual_text(card.get("status"), 10).upper()
        status_fill = (30, 36, 44)
        status_text_fill = (195, 201, 207)

        if status_text == "SUCCESS":
            status_fill = (24, 48, 30)
            status_text_fill = (201, 230, 160)
        elif status_text == "ERROR":
            status_fill = (75, 42, 32)
            status_text_fill = (255, 210, 198)

        draw.rounded_rectangle((12, card_y, width - 12, card_y + 64), radius=14, fill=(22, 28, 36))
        draw.text((22, card_y + 10), truncate_visual_text(card.get("time"), 16), fill=accent, font=fonts["tiny"])
        draw.rounded_rectangle((width - 60, card_y + 8, width - 18, card_y + 28), radius=10, fill=status_fill)
        draw.text((width - 52, card_y + 13), status_text, fill=status_text_fill, font=fonts["tiny"])
        draw_text_block(draw, truncate_visual_text(card.get("result"), 38), 22, card_y + 32, width - 44, fonts["label"], WHISPLAY_FOREGROUND, max_lines=2)
        card_y += 72

    draw.text((14, height - 22), "short: summary · long: next", fill=(154, 162, 170), font=fonts["tiny"])


def render_skills_summary_visual(
    draw: Any,
    state: ScreenState,
    fonts: dict[str, Any],
    width: int,
    height: int,
    accent: tuple[int, int, int],
) -> None:
    visual = state.visual or {}
    cards = visual.get("cards")
    skill_count = visual.get("skill_count")
    active_skill = truncate_visual_text(visual.get("active_skill"), 18)
    remaining_count = visual.get("remaining_count")

    draw.rounded_rectangle((10, 8, width - 10, 42), radius=14, fill=(18, 34, 48))
    draw.text((18, 18), "SKILLS", fill=(236, 240, 244), font=fonts["title"])
    draw.rounded_rectangle((width - 58, 14, width - 18, 36), radius=10, fill=(22, 28, 36))
    draw.text((width - 48, 20), str(skill_count or 0), fill=accent, font=fonts["tiny"])

    draw.rounded_rectangle((12, 58, width - 12, 106), radius=14, fill=(22, 28, 36))
    draw.text((22, 72), "ACTIVE", fill=accent, font=fonts["tiny"])
    draw_text_block(
        draw,
        active_skill or "(none)",
        22,
        86,
        width - 44,
        fonts["body"],
        WHISPLAY_FOREGROUND,
        max_lines=1,
    )

    if not isinstance(cards, list) or not cards:
        draw.rounded_rectangle((12, 118, width - 12, 228), radius=16, fill=(22, 28, 36))
        draw_text_block(draw, "No skills yet", 22, 150, width - 44, fonts["hero"], WHISPLAY_FOREGROUND, max_lines=2)
        draw.text((14, height - 22), "add skills under skills/", fill=(154, 162, 170), font=fonts["tiny"])
        return

    card_y = 118

    for card in cards[:2]:
        if not isinstance(card, dict):
            continue

        draw.rounded_rectangle((12, card_y, width - 12, card_y + 62), radius=14, fill=(22, 28, 36))
        draw.text((22, card_y + 10), truncate_visual_text(card.get("id"), 16).upper(), fill=accent, font=fonts["tiny"])
        chip_fill = (36, 81, 107) if card.get("state") == "active" else (43, 50, 58)
        chip_text = (227, 245, 251) if card.get("state") == "active" else (195, 201, 207)
        draw.rounded_rectangle((width - 68, card_y + 8, width - 18, card_y + 28), radius=10, fill=chip_fill)
        draw.text((width - 61, card_y + 13), truncate_visual_text(card.get("permission"), 8).upper(), fill=chip_text, font=fonts["tiny"])
        draw_text_block(draw, truncate_visual_text(card.get("reasoning"), 16), 22, card_y + 32, width - 44, fonts["label"], WHISPLAY_FOREGROUND, max_lines=1)
        readiness_text = truncate_visual_text(card.get("readiness"), 14).upper()
        readiness_width = measure_inline_chip_width(draw, readiness_text, fonts["tiny"])
        draw.rounded_rectangle((22, card_y + 42, 22 + readiness_width, card_y + 62), radius=10, fill=(31, 36, 42))
        draw.text((30, card_y + 47), readiness_text, fill=(183, 191, 198), font=fonts["tiny"])
        card_y += 72

    footer = "hold for detail"

    if isinstance(remaining_count, int) and remaining_count > 0:
        footer = f"+{remaining_count} more  ·  hold detail"

    draw.text((14, height - 22), footer, fill=(154, 162, 170), font=fonts["tiny"])


def render_skill_detail_visual(
    draw: Any,
    state: ScreenState,
    fonts: dict[str, Any],
    width: int,
    height: int,
    accent: tuple[int, int, int],
) -> None:
    visual = state.visual or {}
    state_value = truncate_visual_text(visual.get("state"), 6)
    skill_id = truncate_visual_text(visual.get("skill_id"), 18)
    readiness = truncate_visual_text(visual.get("readiness"), 18)
    permission = truncate_visual_text(visual.get("permission"), 12)
    reasoning = truncate_visual_text(visual.get("reasoning"), 14)
    integrations = truncate_visual_text(visual.get("integrations"), 44)
    prelude = truncate_visual_text(visual.get("prelude"), 64)
    tool_count = visual.get("tool_count")
    bash_count = visual.get("bash_count")

    draw.rounded_rectangle((10, 8, width - 10, 42), radius=14, fill=(18, 34, 48))
    draw.text((18, 18), "SKILL DETAIL", fill=(236, 240, 244), font=fonts["title"])
    chip_fill = (36, 81, 107) if state_value == "active" else (43, 50, 58)
    chip_text = (227, 245, 251) if state_value == "active" else (195, 201, 207)
    draw.rounded_rectangle((width - 60, 14, width - 18, 36), radius=10, fill=chip_fill)
    draw.text((width - 52, 20), state_value.upper(), fill=chip_text, font=fonts["tiny"])

    draw.rounded_rectangle((12, 58, width - 12, 118), radius=16, fill=(22, 28, 36))
    draw.text((22, 72), "SKILL", fill=accent, font=fonts["tiny"])
    draw_text_block(draw, skill_id.upper(), 22, 88, width - 44, fonts["hero"], WHISPLAY_FOREGROUND, max_lines=1)
    readiness_width = measure_inline_chip_width(draw, readiness.upper(), fonts["tiny"])
    draw.rounded_rectangle((width - 18 - readiness_width, 86, width - 18, 106), radius=10, fill=(31, 36, 42))
    draw.text((width - 18 - readiness_width + 8, 91), readiness.upper(), fill=(183, 191, 198), font=fonts["tiny"])

    draw.rounded_rectangle((12, 130, 82, 178), radius=14, fill=(16, 23, 29))
    draw.text((22, 142), "PERMISSION", fill=accent, font=fonts["tiny"])
    draw_text_block(draw, permission, 22, 158, 50, fonts["tiny"], WHISPLAY_FOREGROUND, max_lines=1)

    draw.rounded_rectangle((88, 130, width - 12, 178), radius=14, fill=(16, 23, 29))
    draw.text((98, 142), "REASONING", fill=accent, font=fonts["tiny"])
    draw_text_block(draw, reasoning, 98, 158, width - 110, fonts["tiny"], WHISPLAY_FOREGROUND, max_lines=1)

    draw.rounded_rectangle((12, 190, width - 12, 232), radius=14, fill=(22, 28, 36))
    draw.text((22, 202), "INTEGRATIONS", fill=accent, font=fonts["tiny"])
    draw_text_block(draw, integrations, 22, 218, width - 44, fonts["tiny"], WHISPLAY_FOREGROUND, max_lines=1)

    draw.rounded_rectangle((12, 242, width - 12, 284), radius=14, fill=(22, 28, 36))
    draw.text((22, 254), "PRELUDE", fill=accent, font=fonts["tiny"])
    draw_text_block(draw, prelude, 22, 268, width - 44, fonts["tiny"], WHISPLAY_FOREGROUND, max_lines=1)

    tools_width = draw_inline_chip(draw, 12, height - 28, f"TOOLS {tool_count or 0}", fonts["tiny"], (18, 24, 30), (154, 162, 170))
    draw_inline_chip(draw, 20 + tools_width, height - 28, f"BASH {bash_count or 0}", fonts["tiny"], (31, 36, 42), (183, 191, 198))


def render_workspace_summary_visual(
    draw: Any,
    state: ScreenState,
    fonts: dict[str, Any],
    width: int,
    height: int,
    accent: tuple[int, int, int],
) -> None:
    visual = state.visual or {}
    cards = visual.get("cards")
    workspace_count = visual.get("workspace_count")
    active_workspace = truncate_visual_text(visual.get("active_workspace"), 18)
    remaining_count = visual.get("remaining_count")

    draw.rounded_rectangle((10, 8, width - 10, 42), radius=14, fill=(18, 34, 48))
    draw.text((18, 18), "WORKSPACES", fill=(236, 240, 244), font=fonts["title"])
    draw.rounded_rectangle((width - 58, 14, width - 18, 36), radius=10, fill=(22, 28, 36))
    draw.text((width - 48, 20), str(workspace_count or 0), fill=accent, font=fonts["tiny"])

    draw.rounded_rectangle((12, 58, width - 12, 106), radius=14, fill=(22, 28, 36))
    draw.text((22, 72), "ACTIVE", fill=accent, font=fonts["tiny"])
    draw_text_block(draw, active_workspace or "(none)", 22, 86, width - 44, fonts["body"], WHISPLAY_FOREGROUND, max_lines=1)

    if not isinstance(cards, list) or not cards:
        draw.rounded_rectangle((12, 118, width - 12, 228), radius=16, fill=(22, 28, 36))
        draw_text_block(draw, "No workspaces yet", 22, 150, width - 44, fonts["hero"], WHISPLAY_FOREGROUND, max_lines=2)
        draw.text((14, height - 22), "create via host or setup", fill=(154, 162, 170), font=fonts["tiny"])
        return

    card_y = 118

    for card in cards[:2]:
        if not isinstance(card, dict):
            continue

        draw.rounded_rectangle((12, card_y, width - 12, card_y + 62), radius=14, fill=(22, 28, 36))
        draw.text((22, card_y + 10), truncate_visual_text(card.get("id"), 16).upper(), fill=accent, font=fonts["tiny"])
        chip_fill = (36, 81, 107) if card.get("state") == "active" else (43, 50, 58)
        chip_text = (227, 245, 251) if card.get("state") == "active" else (195, 201, 207)
        draw.rounded_rectangle((width - 60, card_y + 8, width - 18, card_y + 28), radius=10, fill=chip_fill)
        draw.text((width - 52, card_y + 13), truncate_visual_text(card.get("skill"), 10).upper(), fill=chip_text, font=fonts["tiny"])
        repo_text = truncate_visual_text(card.get("repos"), 12).upper()
        repo_width = measure_inline_chip_width(draw, repo_text, fonts["tiny"])
        draw.rounded_rectangle((22, card_y + 32, 22 + repo_width, card_y + 52), radius=10, fill=(31, 36, 42))
        draw.text((30, card_y + 37), repo_text, fill=(183, 191, 198), font=fonts["tiny"])
        draw_text_block(draw, truncate_visual_text(card.get("notes"), 16), 22, card_y + 50, width - 44, fonts["tiny"], (154, 162, 170), max_lines=1)
        card_y += 72

    footer = "hold for detail"

    if isinstance(remaining_count, int) and remaining_count > 0:
        footer = f"+{remaining_count} more  ·  hold detail"

    draw.text((14, height - 22), footer, fill=(154, 162, 170), font=fonts["tiny"])


def render_workspace_detail_visual(
    draw: Any,
    state: ScreenState,
    fonts: dict[str, Any],
    width: int,
    height: int,
    accent: tuple[int, int, int],
) -> None:
    visual = state.visual or {}
    state_value = truncate_visual_text(visual.get("state"), 6)
    workspace_id = truncate_visual_text(visual.get("workspace_id"), 18)
    default_skill = truncate_visual_text(visual.get("default_skill"), 18)
    instructions = truncate_visual_text(visual.get("instructions"), 12)
    repos = truncate_visual_text(visual.get("repos"), 44)
    repo_count = visual.get("repo_count")

    draw.rounded_rectangle((10, 8, width - 10, 42), radius=14, fill=(18, 34, 48))
    draw.text((18, 18), "WORKSPACE", fill=(236, 240, 244), font=fonts["title"])
    chip_fill = (36, 81, 107) if state_value == "active" else (43, 50, 58)
    chip_text = (227, 245, 251) if state_value == "active" else (195, 201, 207)
    draw.rounded_rectangle((width - 60, 14, width - 18, 36), radius=10, fill=chip_fill)
    draw.text((width - 52, 20), state_value.upper(), fill=chip_text, font=fonts["tiny"])

    draw.rounded_rectangle((12, 58, width - 12, 118), radius=16, fill=(22, 28, 36))
    draw.text((22, 72), "ID", fill=accent, font=fonts["tiny"])
    draw_text_block(draw, workspace_id.upper(), 22, 88, width - 44, fonts["hero"], WHISPLAY_FOREGROUND, max_lines=1)
    repo_badge = f"{repo_count or 0} REPO" if (repo_count or 0) == 1 else f"{repo_count or 0} REPOS"
    repo_badge_width = measure_inline_chip_width(draw, repo_badge, fonts["tiny"])
    draw.rounded_rectangle((width - 18 - repo_badge_width, 86, width - 18, 106), radius=10, fill=(31, 36, 42))
    draw.text((width - 18 - repo_badge_width + 8, 91), repo_badge, fill=(183, 191, 198), font=fonts["tiny"])

    draw.rounded_rectangle((12, 130, 82, 178), radius=14, fill=(16, 23, 29))
    draw.text((22, 142), "SKILL", fill=accent, font=fonts["tiny"])
    draw_text_block(draw, default_skill, 22, 158, 50, fonts["tiny"], WHISPLAY_FOREGROUND, max_lines=1)

    draw.rounded_rectangle((88, 130, width - 12, 178), radius=14, fill=(16, 23, 29))
    draw.text((98, 142), "NOTES", fill=accent, font=fonts["tiny"])
    draw_text_block(draw, instructions, 98, 158, width - 110, fonts["tiny"], WHISPLAY_FOREGROUND, max_lines=1)

    draw.rounded_rectangle((12, 190, width - 12, 248), radius=14, fill=(22, 28, 36))
    draw.text((22, 202), "REPOS", fill=accent, font=fonts["tiny"])
    draw_text_block(draw, repos, 22, 220, width - 44, fonts["tiny"], WHISPLAY_FOREGROUND, max_lines=2)

    history_width = draw_inline_chip(draw, 12, height - 28, "HISTORY", fonts["tiny"], (18, 24, 30), (154, 162, 170))
    draw_inline_chip(draw, 20 + history_width, height - 28, "FILES", fonts["tiny"], (31, 36, 42), (183, 191, 198))


def render_workspace_history_visual(
    draw: Any,
    state: ScreenState,
    fonts: dict[str, Any],
    width: int,
    height: int,
    accent: tuple[int, int, int],
) -> None:
    visual = state.visual or {}
    cards = visual.get("cards")

    draw.rounded_rectangle((10, 8, width - 10, 42), radius=14, fill=(18, 34, 48))
    draw.text((18, 18), "WS HISTORY", fill=(236, 240, 244), font=fonts["title"])
    draw.rounded_rectangle((width - 74, 14, width - 18, 36), radius=10, fill=(22, 28, 36))
    draw.text((width - 66, 20), truncate_visual_text(visual.get("window"), 12), fill=accent, font=fonts["tiny"])

    draw.text((14, 58), truncate_visual_text(visual.get("workspace_id"), 16).upper(), fill=accent, font=fonts["tiny"])

    if not isinstance(cards, list) or not cards:
        draw.rounded_rectangle((12, 76, width - 12, 212), radius=16, fill=(22, 28, 36))
        draw_text_block(draw, "No runs yet", 22, 106, width - 44, fonts["hero"], WHISPLAY_FOREGROUND, max_lines=2)
        draw.text((14, height - 22), "run a prompt to fill history", fill=(154, 162, 170), font=fonts["tiny"])
        return

    card_y = 76

    for card in cards[:3]:
        if not isinstance(card, dict):
            continue

        status_text = truncate_visual_text(card.get("status"), 10).upper()
        status_fill = (30, 36, 44)
        status_text_fill = (195, 201, 207)

        if status_text == "SUCCESS":
            status_fill = (24, 48, 30)
            status_text_fill = (201, 230, 160)
        elif status_text == "ERROR":
            status_fill = (75, 42, 32)
            status_text_fill = (255, 210, 198)

        draw.rounded_rectangle((12, card_y, width - 12, card_y + 64), radius=14, fill=(22, 28, 36))
        draw.text((22, card_y + 10), truncate_visual_text(card.get("time"), 16), fill=accent, font=fonts["tiny"])
        draw.rounded_rectangle((width - 60, card_y + 8, width - 18, card_y + 28), radius=10, fill=status_fill)
        draw.text((width - 52, card_y + 13), status_text, fill=status_text_fill, font=fonts["tiny"])
        draw_text_block(draw, truncate_visual_text(card.get("detail"), 28), 22, card_y + 30, width - 44, fonts["label"], WHISPLAY_FOREGROUND, max_lines=1)
        draw_text_block(draw, truncate_visual_text(card.get("summary"), 34), 22, card_y + 44, width - 44, fonts["tiny"], (154, 162, 170), max_lines=1)
        card_y += 72

    latest_width = draw_inline_chip(draw, 12, height - 28, "LATEST", fonts["tiny"], (18, 24, 30), (154, 162, 170))
    draw_inline_chip(draw, 20 + latest_width, height - 28, "RUNS", fonts["tiny"], (31, 36, 42), (183, 191, 198))


def render_workspace_files_visual(
    draw: Any,
    state: ScreenState,
    fonts: dict[str, Any],
    width: int,
    height: int,
    accent: tuple[int, int, int],
) -> None:
    visual = state.visual or {}
    cards = visual.get("cards")
    file_count = visual.get("file_count")
    remaining_count = visual.get("remaining_count")

    draw.rounded_rectangle((10, 8, width - 10, 42), radius=14, fill=(18, 34, 48))
    draw.text((18, 18), "WS FILES", fill=(236, 240, 244), font=fonts["title"])
    draw.rounded_rectangle((width - 58, 14, width - 18, 36), radius=10, fill=(22, 28, 36))
    draw.text((width - 48, 20), str(file_count or 0), fill=accent, font=fonts["tiny"])

    draw.text((14, 58), truncate_visual_text(visual.get("workspace_id"), 16).upper(), fill=accent, font=fonts["tiny"])

    if not isinstance(cards, list) or not cards:
        draw.rounded_rectangle((12, 76, width - 12, 212), radius=16, fill=(22, 28, 36))
        draw_text_block(draw, "No files yet", 22, 106, width - 44, fonts["hero"], WHISPLAY_FOREGROUND, max_lines=2)
        draw.text((14, height - 22), "save notes under workspace", fill=(154, 162, 170), font=fonts["tiny"])
        return

    card_y = 76

    for card in cards[:3]:
        if not isinstance(card, dict):
            continue

        draw.rounded_rectangle((12, card_y, width - 12, card_y + 58), radius=14, fill=(22, 28, 36))
        draw.text((22, card_y + 10), truncate_visual_text(card.get("name"), 18).upper(), fill=accent, font=fonts["tiny"])
        size_text = truncate_visual_text(card.get("size"), 10).upper()
        size_width = measure_inline_chip_width(draw, size_text, fonts["tiny"])
        draw.rounded_rectangle((width - 18 - size_width, card_y + 8, width - 18, card_y + 28), radius=10, fill=(31, 36, 42))
        draw.text((width - 18 - size_width + 8, card_y + 13), size_text, fill=(183, 191, 198), font=fonts["tiny"])
        draw_text_block(draw, truncate_visual_text(card.get("path"), 24), 22, card_y + 32, width - 44, fonts["tiny"], WHISPLAY_FOREGROUND, max_lines=1)
        card_y += 66

    footer = "hold for detail"
    if isinstance(remaining_count, int) and remaining_count > 0:
        footer = f"+{remaining_count} more  ·  hold detail"

    draw.text((14, height - 22), footer, fill=(154, 162, 170), font=fonts["tiny"])


def render_workspace_file_visual(
    draw: Any,
    state: ScreenState,
    fonts: dict[str, Any],
    width: int,
    height: int,
    accent: tuple[int, int, int],
) -> None:
    visual = state.visual or {}

    draw.rounded_rectangle((10, 8, width - 10, 42), radius=14, fill=(18, 34, 48))
    draw.text((18, 18), "WS FILE", fill=(236, 240, 244), font=fonts["title"])
    draw.rounded_rectangle((width - 68, 14, width - 18, 36), radius=10, fill=(22, 28, 36))
    draw.text((width - 59, 20), truncate_visual_text(visual.get("workspace_id"), 10).upper(), fill=accent, font=fonts["tiny"])

    draw.rounded_rectangle((12, 58, width - 12, 108), radius=14, fill=(22, 28, 36))
    draw.text((22, 72), truncate_visual_text(visual.get("file_name"), 18).upper(), fill=accent, font=fonts["tiny"])
    path_text = truncate_visual_text(visual.get("path"), 20).upper()
    path_width = measure_inline_chip_width(draw, path_text, fonts["tiny"])
    draw.rounded_rectangle((22, 84, 22 + path_width, 104), radius=10, fill=(31, 36, 42))
    draw.text((30, 89), path_text, fill=(183, 191, 198), font=fonts["tiny"])

    draw.rounded_rectangle((12, 120, width - 12, 274), radius=16, fill=(22, 28, 36))
    draw.text((22, 134), "PREVIEW", fill=accent, font=fonts["tiny"])
    draw_text_block(draw, truncate_visual_text(visual.get("body"), 220), 22, 154, width - 44, fonts["body"], WHISPLAY_FOREGROUND, max_lines=7)

    preview_width = draw_inline_chip(draw, 12, height - 28, "PREVIEW", fonts["tiny"], (18, 24, 30), (154, 162, 170))
    draw_inline_chip(draw, 20 + preview_width, height - 28, "WORKSPACE", fonts["tiny"], (31, 36, 42), (183, 191, 198))


def render_state_image(
    state: ScreenState,
    image_module: Any,
    draw_module: Any,
    fonts: dict[str, Any],
    width: int = WHISPLAY_DEFAULT_WIDTH,
    height: int = WHISPLAY_DEFAULT_HEIGHT,
) -> tuple[Any, tuple[int, int, int]]:
    image = image_module.new(
        "RGB",
        (width, height),
        WHISPLAY_BACKGROUND,
    )
    draw = draw_module.Draw(image)
    accent = get_phase_rgb(state.phase)

    if isinstance(state.visual, dict) and state.visual.get("kind") == "home":
        render_home_visual(draw, state, fonts, width, height, accent)
        return image, accent

    if isinstance(state.visual, dict) and state.visual.get("kind") == "brand_splash":
        render_brand_splash_visual(draw, state, fonts, width, height, accent)
        return image, accent

    if isinstance(state.visual, dict) and state.visual.get("kind") == "skills_summary":
        render_skills_summary_visual(draw, state, fonts, width, height, accent)
        return image, accent

    if isinstance(state.visual, dict) and state.visual.get("kind") == "skill_detail":
        render_skill_detail_visual(draw, state, fonts, width, height, accent)
        return image, accent

    if isinstance(state.visual, dict) and state.visual.get("kind") == "workspace_summary":
        render_workspace_summary_visual(draw, state, fonts, width, height, accent)
        return image, accent

    if isinstance(state.visual, dict) and state.visual.get("kind") == "workspace_detail":
        render_workspace_detail_visual(draw, state, fonts, width, height, accent)
        return image, accent

    if isinstance(state.visual, dict) and state.visual.get("kind") == "workspace_history":
        render_workspace_history_visual(draw, state, fonts, width, height, accent)
        return image, accent

    if isinstance(state.visual, dict) and state.visual.get("kind") == "workspace_files":
        render_workspace_files_visual(draw, state, fonts, width, height, accent)
        return image, accent

    if isinstance(state.visual, dict) and state.visual.get("kind") == "workspace_file":
        render_workspace_file_visual(draw, state, fonts, width, height, accent)
        return image, accent

    if isinstance(state.visual, dict) and state.visual.get("kind") == "jobs_summary":
        render_jobs_summary_visual(draw, state, fonts, width, height, accent)
        return image, accent

    if isinstance(state.visual, dict) and state.visual.get("kind") == "job_detail":
        render_job_detail_visual(draw, state, fonts, width, height, accent)
        return image, accent

    if isinstance(state.visual, dict) and state.visual.get("kind") == "job_history":
        render_job_history_visual(draw, state, fonts, width, height, accent)
        return image, accent

    if isinstance(state.visual, dict) and state.visual.get("kind") == "transcript_debug":
        visual = state.visual
        render_detail_visual(
            draw,
            "Transcript",
            "heard",
            "Transcript",
            truncate_visual_text(visual.get("lead_value"), 180),
            truncate_visual_text(visual.get("age"), 14),
            truncate_visual_text(visual.get("file"), 14),
            fonts,
            width,
            height,
            accent,
        )
        return image, accent

    if isinstance(state.visual, dict) and state.visual.get("kind") == "audio_debug":
        visual = state.visual
        render_detail_visual(
            draw,
            "Audio",
            "wav",
            "Audio",
            truncate_visual_text(visual.get("lead_value"), 180),
            truncate_visual_text(visual.get("age"), 14),
            truncate_visual_text(visual.get("file"), 14),
            fonts,
            width,
            height,
            accent,
        )
        return image, accent

    if isinstance(state.visual, dict) and state.visual.get("kind") == "error_debug":
        visual = state.visual
        render_detail_visual(
            draw,
            "Error",
            truncate_visual_text(visual.get("source"), 8),
            "Message",
            truncate_visual_text(visual.get("lead_value"), 180),
            truncate_visual_text(visual.get("age"), 14),
            truncate_visual_text(visual.get("file"), 14),
            fonts,
            width,
            height,
            accent,
        )
        return image, accent

    if isinstance(state.visual, dict) and state.visual.get("kind") == "voice_debug":
        render_voice_debug_visual(draw, state, fonts, width, height, accent)
        return image, accent

    if isinstance(state.visual, dict) and state.visual.get("kind") == "stage":
        visual = state.visual
        render_stage_visual(
            draw,
            truncate_visual_text(visual.get("title"), 18),
            truncate_visual_text(visual.get("badge"), 10),
            truncate_visual_text(visual.get("lead"), 160),
            truncate_visual_text(visual.get("detail"), 220),
            truncate_visual_text(visual.get("footer"), 28),
            fonts,
            width,
            height,
            accent,
            progress=visual.get("progress") if isinstance(visual.get("progress"), (int, float)) else 0.0,
            progress_label=truncate_visual_text(visual.get("progress_label"), 18),
        )
        return image, accent

    if isinstance(state.visual, dict) and state.visual.get("kind") == "tool_run":
        visual = state.visual
        render_result_visual(
            draw,
            "Tool",
            truncate_visual_text(visual.get("badge"), 10),
            "Running",
            truncate_visual_text(visual.get("body"), 220),
            truncate_visual_text(visual.get("footer"), 28),
            fonts,
            width,
            height,
            accent,
        )
        return image, accent

    if isinstance(state.visual, dict) and state.visual.get("kind") == "answer":
        visual = state.visual
        render_result_visual(
            draw,
            "Answer",
            truncate_visual_text(visual.get("badge"), 10),
            "Reply",
            truncate_visual_text(visual.get("body"), 280),
            truncate_visual_text(visual.get("footer"), 28),
            fonts,
            width,
            height,
            accent,
        )
        return image, accent

    if isinstance(state.visual, dict) and state.visual.get("kind") == "run_error":
        visual = state.visual
        render_result_visual(
            draw,
            "Run failed",
            truncate_visual_text(visual.get("badge"), 10),
            "Error",
            truncate_visual_text(visual.get("body"), 220),
            truncate_visual_text(visual.get("footer"), 28),
            fonts,
            width,
            height,
            accent,
        )
        return image, accent

    draw.rectangle(
        (0, 0, width - 1, 28),
        fill=WHISPLAY_HEADER_BACKGROUND,
    )
    draw.text((10, 9), state.phase.upper(), fill=accent, font=fonts["label"])

    cursor_y = 38

    for line in build_screen_lines(state, width=WHISPLAY_TEXT_WIDTH):
        if cursor_y >= height - 12:
            break

        draw.text((10, cursor_y), line, fill=WHISPLAY_FOREGROUND, font=fonts["default"])
        cursor_y += 12

    return image, accent


class ConsoleRenderer:
    def __init__(self, surface_name: str = "Mock UI") -> None:
        self.surface_name = surface_name
        self._interactive = sys.stdout.isatty()

    def close(self) -> None:
        return

    def poll_button_pressed(self) -> Optional[bool]:
        return None

    def render_notice(self, message: str) -> None:
        self.render(ScreenState(status=message))

    def render(self, state: ScreenState) -> None:
        lines = [
            f"{self.surface_name} | {state.phase}",
            *build_screen_lines(state),
        ]

        if self._interactive:
            sys.stdout.write("\033[2J\033[H")
        else:
            sys.stdout.write("\n")

        sys.stdout.write("\n".join(lines) + "\n")
        sys.stdout.flush()


class WhisplayRenderer(ConsoleRenderer):
    def __init__(self) -> None:
        super().__init__("Whisplay")
        self._board: Any = None
        self._image_module: Any = None
        self._draw_module: Any = None
        self._fonts: Optional[dict[str, Any]] = None
        self._width = WHISPLAY_DEFAULT_WIDTH
        self._height = WHISPLAY_DEFAULT_HEIGHT
        self._last_phase: Optional[str] = None
        self._has_shown_boot_splash = False
        self._fallback_reason = self._connect_hardware()

        if self._fallback_reason:
            self.surface_name = "Whisplay (console fallback)"

    def _connect_hardware(self) -> Optional[str]:
        pillow = load_pillow()

        if pillow is None:
            return "Pillow is not installed"

        board_class = load_whisplay_board()

        if board_class is None:
            return "WhisPlay driver is not installed"

        try:
            board = board_class()
        except Exception as error:
            return f"Whisplay init failed: {error}"

        image_module, draw_module, font_module = pillow
        self._board = board
        self._image_module = image_module
        self._draw_module = draw_module
        self._fonts = load_display_fonts(font_module)
        self._width = int(getattr(board, "LCD_WIDTH", WHISPLAY_DEFAULT_WIDTH))
        self._height = int(getattr(board, "LCD_HEIGHT", WHISPLAY_DEFAULT_HEIGHT))

        try:
            self._board.set_backlight(70)
        except Exception:
            pass

        return None

    def render_notice(self, message: str) -> None:
        if self._fallback_reason:
            message = f"{message} ({self._fallback_reason})"

        self.render(ScreenState(status=message))

    def _render_direct(self, state: ScreenState) -> None:
        image, accent = render_state_image(
            state,
            self._image_module,
            self._draw_module,
            self._fonts or load_display_fonts(load_pillow()[2]),
            width=self._width,
            height=self._height,
        )
        self._board.set_rgb(*accent)
        self._board.draw_image(
            0,
            0,
            self._width,
            self._height,
            image_to_rgb565(image),
        )

    def _render_transition_splash(
        self,
        state: ScreenState,
        badge: str,
        title: str,
        detail: str,
        delay_seconds: float,
    ) -> None:
        if delay_seconds <= 0:
            return

        self._render_direct(build_brand_splash_state(state.phase, badge, title, detail))
        time.sleep(delay_seconds)

    def _maybe_render_transition(self, state: ScreenState) -> None:
        visual_kind = state.visual.get("kind") if isinstance(state.visual, dict) else None

        if visual_kind == "brand_splash":
            return

        if not self._has_shown_boot_splash:
            self._render_transition_splash(
                state,
                "boot",
                "DumplBot",
                "Waking up",
                LIVE_RENDER_BOOT_SECONDS,
            )
            self._has_shown_boot_splash = True

        if self._last_phase is not None and self._last_phase != state.phase:
            self._render_transition_splash(
                state,
                "now",
                state.phase,
                state.status or f"{state.phase} in progress",
                LIVE_RENDER_PHASE_TRANSITION_SECONDS,
            )

    def render(self, state: ScreenState) -> None:
        if self._board is None:
            super().render(state)
            return

        try:
            self._maybe_render_transition(state)
            self._render_direct(state)
            self._last_phase = state.phase
        except Exception as error:
            self._fallback_reason = f"Whisplay draw failed: {error}"
            self._board = None
            self.surface_name = "Whisplay (console fallback)"
            super().render(state)

    def poll_button_pressed(self) -> Optional[bool]:
        if self._board is None:
            return None

        try:
            return bool(self._board.button_pressed())
        except Exception as error:
            self._fallback_reason = f"Whisplay button read failed: {error}"
            self._board = None
            self.surface_name = "Whisplay (console fallback)"
            return None

    def close(self) -> None:
        if self._board is None:
            return

        try:
            self._board.cleanup()
        except Exception:
            pass

        self._board = None


class DesktopPreviewRenderer(ConsoleRenderer):
    def __init__(self, scale: int = PREVIEW_DEFAULT_SCALE) -> None:
        super().__init__("Preview")
        self._scale = max(1, scale)
        self._image_module: Any = None
        self._draw_module: Any = None
        self._fonts: Optional[dict[str, Any]] = None
        self._tk_module: Any = None
        self._image_tk_module: Any = None
        self._window: Any = None
        self._image_label: Any = None
        self._photo_image: Any = None
        self._width = WHISPLAY_DEFAULT_WIDTH
        self._height = WHISPLAY_DEFAULT_HEIGHT
        self._button_pressed = False
        self._closed = False
        self._last_phase: Optional[str] = None
        self._has_shown_boot_splash = False
        self._fallback_reason = self._connect_preview()

        if self._fallback_reason:
            self.surface_name = "Preview (console fallback)"

    def _connect_preview(self) -> Optional[str]:
        pillow = load_pillow()

        if pillow is None:
            return "Pillow is not installed"

        preview_modules = load_preview_modules()

        if preview_modules is None:
            return "tkinter preview support is unavailable"

        image_module, draw_module, font_module = pillow
        tk_module, image_tk_module = preview_modules

        try:
            window = tk_module.Tk()
        except Exception as error:
            return f"Preview window unavailable: {error}"

        self._image_module = image_module
        self._draw_module = draw_module
        self._fonts = load_display_fonts(font_module)
        self._tk_module = tk_module
        self._image_tk_module = image_tk_module
        self._window = window

        window.title("DumplBot Preview")
        window.configure(bg="#0a0f14")
        window.resizable(False, False)
        window.bind("<KeyPress-space>", self._on_space_press)
        window.bind("<KeyRelease-space>", self._on_space_release)
        window.bind("<KeyPress-q>", self._on_quit_key)
        window.protocol("WM_DELETE_WINDOW", self.close)

        self._image_label = tk_module.Label(
            window,
            bg="#0a0f14",
            bd=0,
            highlightthickness=0,
        )
        self._image_label.pack(padx=12, pady=12)
        self._pump_events()
        return None

    def _on_space_press(self, _event: Any) -> None:
        self._button_pressed = True

    def _on_space_release(self, _event: Any) -> None:
        self._button_pressed = False

    def _on_quit_key(self, _event: Any) -> None:
        self.close()

    def _pump_events(self) -> None:
        if self._window is None:
            return

        try:
            self._window.update_idletasks()
            self._window.update()
        except Exception:
            self.close()

    def render_notice(self, message: str) -> None:
        if self._fallback_reason:
            message = f"{message} ({self._fallback_reason})"

        self.render(ScreenState(status=message))

    def _sleep_with_events(self, delay_seconds: float) -> None:
        if delay_seconds <= 0:
            return

        deadline = time.monotonic() + delay_seconds

        while self._window is not None and time.monotonic() < deadline:
            self._pump_events()
            time.sleep(min(0.01, max(0.0, deadline - time.monotonic())))

    def _show_image(self, image: Any, phase: str) -> None:
        if self._scale != 1:
            image = image.resize(
                (self._width * self._scale, self._height * self._scale),
                self._image_module.Resampling.NEAREST,
            )

        self._photo_image = self._image_tk_module.PhotoImage(image=image)
        self._image_label.configure(image=self._photo_image)
        self._window.title(f"DumplBot Preview | {phase} | Space=button, q=quit")
        self._pump_events()

    def _render_direct(self, state: ScreenState) -> None:
        image, _accent = render_state_image(
            state,
            self._image_module,
            self._draw_module,
            self._fonts,
            width=self._width,
            height=self._height,
        )
        self._show_image(image, state.phase)

    def _render_transition_splash(
        self,
        state: ScreenState,
        badge: str,
        title: str,
        detail: str,
        delay_seconds: float,
    ) -> None:
        if delay_seconds <= 0:
            return

        self._render_direct(build_brand_splash_state(state.phase, badge, title, detail))
        self._sleep_with_events(delay_seconds)

    def _maybe_render_transition(self, state: ScreenState) -> None:
        visual_kind = state.visual.get("kind") if isinstance(state.visual, dict) else None

        if visual_kind == "brand_splash":
            return

        if not self._has_shown_boot_splash:
            self._render_transition_splash(
                state,
                "boot",
                "DumplBot",
                "Waking up",
                LIVE_RENDER_BOOT_SECONDS,
            )
            self._has_shown_boot_splash = True

        if self._last_phase is not None and self._last_phase != state.phase:
            self._render_transition_splash(
                state,
                "now",
                state.phase,
                state.status or f"{state.phase} in progress",
                LIVE_RENDER_PHASE_TRANSITION_SECONDS,
            )

    def render(self, state: ScreenState) -> None:
        if self._window is None or self._image_module is None or self._draw_module is None or self._fonts is None:
            super().render(state)
            return

        try:
            self._maybe_render_transition(state)
            self._render_direct(state)
            self._last_phase = state.phase
        except Exception as error:
            self._fallback_reason = f"Preview draw failed: {error}"
            self.close()
            self.surface_name = "Preview (console fallback)"
            super().render(state)

    def poll_button_pressed(self) -> Optional[bool]:
        if self._window is None:
            return None

        self._pump_events()

        if self._window is None:
            return None

        return self._button_pressed

    def close(self) -> None:
        self._button_pressed = False

        if self._window is None:
            self._closed = True
            return

        window = self._window
        self._window = None
        self._image_label = None
        self._photo_image = None
        self._closed = True

        try:
            window.destroy()
        except Exception:
            pass


class SnapshotRenderer(ConsoleRenderer):
    def __init__(self, snapshot_path: str, scale: int = PREVIEW_DEFAULT_SCALE) -> None:
        super().__init__("Snapshot")
        self._snapshot_path = Path(snapshot_path)
        self._scale = max(1, scale)
        self._image_module: Any = None
        self._draw_module: Any = None
        self._fonts: Optional[dict[str, Any]] = None
        self._fallback_reason = self._connect_snapshot()

        if self._fallback_reason:
            self.surface_name = "Snapshot (console fallback)"

    def _connect_snapshot(self) -> Optional[str]:
        pillow = load_pillow()

        if pillow is None:
            return "Pillow is not installed"

        image_module, draw_module, font_module = pillow
        self._image_module = image_module
        self._draw_module = draw_module
        self._fonts = load_display_fonts(font_module)
        return None

    def render_notice(self, message: str) -> None:
        if self._fallback_reason:
            message = f"{message} ({self._fallback_reason})"

        self.render(ScreenState(status=message))

    def render(self, state: ScreenState) -> None:
        if self._image_module is None or self._draw_module is None or self._fonts is None:
            super().render(state)
            return

        image, _accent = render_state_image(
            state,
            self._image_module,
            self._draw_module,
            self._fonts,
            width=WHISPLAY_DEFAULT_WIDTH,
            height=WHISPLAY_DEFAULT_HEIGHT,
        )

        if self._scale != 1:
            image = image.resize(
                (WHISPLAY_DEFAULT_WIDTH * self._scale, WHISPLAY_DEFAULT_HEIGHT * self._scale),
                self._image_module.Resampling.NEAREST,
            )

        self._snapshot_path.parent.mkdir(parents=True, exist_ok=True)
        image.save(self._snapshot_path, format="PNG")
        super().render(state)


class ArecordRecorder:
    def __init__(self, config: UiRuntimeConfig) -> None:
        self._config = config
        self._process: Optional[subprocess.Popen[bytes]] = None

    @property
    def output_path(self) -> Path:
        return Path(self._config.ptt_wav_path)

    def start(self) -> Path:
        if self._process is not None:
            raise RuntimeError("recording is already active")

        output_path = self.output_path
        output_path.parent.mkdir(parents=True, exist_ok=True)

        self._process = subprocess.Popen(
            [
                self._config.audio_capture_cmd,
                "-q",
                "-f",
                "S16_LE",
                "-r",
                "16000",
                "-c",
                "1",
                str(output_path),
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        return output_path

    def stop(self) -> Path:
        process = self._process

        if process is None:
            raise RuntimeError("recording is not active")

        self._process = None
        try:
            process.send_signal(signal.SIGINT)
        except ProcessLookupError:
            pass
        _, stderr = process.communicate(timeout=5)

        if process.returncode not in (0, None):
            message = stderr.decode("utf-8", errors="replace").strip() or "arecord failed"
            raise RuntimeError(message)

        return self.output_path

    def cancel(self) -> None:
        process = self._process

        if process is None:
            return

        self._process = None
        try:
            process.terminate()
        except ProcessLookupError:
            pass

        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)

        self.output_path.unlink(missing_ok=True)


def apply_stream_event(
    state: ScreenState,
    event_type: str,
    data: dict[str, Any],
) -> None:
    if event_type == "status":
        message = str(data.get("message") or "Thinking")
        state.phase = "Thinking"
        state.status = message
        state.visual = {
            "kind": "stage",
            "title": "Thinking",
            "badge": "run",
            "lead": truncate_visual_text(message, 42),
            "detail": truncate_visual_text(state.prompt or state.transcript or "Working on your request.", 72),
            "footer": "hold to cancel",
        }
        return

    if event_type == "stt":
        transcript = str(data.get("text") or "")
        state.phase = "Transcribing"
        state.status = "Speech captured"
        state.transcript = transcript or state.transcript
        state.visual = {
            "kind": "stage",
            "title": "Transcribing",
            "badge": "stt",
            "lead": "Speech captured",
            "detail": truncate_visual_text(transcript or state.transcript or "(empty transcript)", 72),
            "footer": "hold to cancel",
        }
        return

    if event_type == "tool":
        name = str(data.get("name") or "tool")
        detail = str(data.get("detail") or "").strip()
        state.phase = "Tool"
        state.status = "Running tool"
        state.tool_banner = f"{name}: {detail}" if detail else name
        state.visual = {
            "kind": "tool_run",
            "badge": compact_badge_value(name, 10),
            "body": detail or name,
            "footer": "hold to cancel",
        }
        return

    if event_type == "token":
        text = str(data.get("text") or "")
        state.phase = "Answer"
        state.status = "Streaming reply"
        state.tool_banner = None
        state.answer += text
        state.visual = {
            "kind": "answer",
            "badge": "live",
            "body": state.answer,
            "footer": "hold to cancel",
        }
        return

    if event_type == "done":
        summary = str(data.get("summary") or "Run finished")
        state.phase = "Answer" if state.answer else "Idle"
        state.status = summary
        state.tool_banner = None
        state.visual = {
            "kind": "answer" if state.answer else "stage",
            "badge": "done",
            "body": state.answer or summary,
            "footer": summary,
            "title": "Done",
            "lead": summary,
            "detail": "Run finished cleanly.",
        }
        return

    if event_type == "error":
        message = str(data.get("message") or "Unknown error")
        state.phase = "Error"
        state.status = "Run failed"
        state.tool_banner = None
        state.error = message
        state.visual = {
            "kind": "run_error",
            "badge": "err",
            "body": message,
            "footer": "fix and retry",
        }


def build_prompt_state(prompt: str) -> ScreenState:
    return ScreenState(
        phase="Thinking",
        status="Starting run",
        prompt=prompt,
        visual={
            "kind": "stage",
            "title": "Thinking",
            "badge": "run",
            "lead": "Starting run",
            "detail": truncate_visual_text(prompt, 64),
            "footer": "hold to cancel",
        },
    )


def request_run_cancel(base_url: str, run_id: str) -> dict[str, Any]:
    encoded_run_id = urllib.parse.quote(run_id, safe="")
    return request_json(base_url, f"/api/runs/{encoded_run_id}/cancel", method="POST")


def set_run_cancel_pending_visual(state: ScreenState) -> None:
    state.phase = "Thinking"
    state.status = "Canceling run"
    state.tool_banner = None
    state.visual = {
        "kind": "stage",
        "title": "Canceling",
        "badge": "stop",
        "lead": "Stopping run",
        "detail": "Letting the run stop cleanly.",
        "footer": "cancel requested",
    }


def stream_sse_request(
    request: urllib.request.Request,
    base_url: str,
    renderer: ConsoleRenderer,
    state: ScreenState,
) -> ScreenState:
    event_queue: "queue.Queue[tuple[str, Any]]" = queue.Queue()
    run_id: Optional[str] = None
    cancel_requested = False
    button_polling_supported = renderer.poll_button_pressed() is not None
    was_pressed = False
    long_press_sent = False
    pressed_started_at: Optional[float] = None

    def worker() -> None:
        try:
            with urllib.request.urlopen(request) as response:
                event_queue.put(("run_id", response.headers.get("x-dumplbot-run-id")))

                for event_type, data in iter_sse_events(response):
                    event_queue.put(("event", (event_type, data)))
        except urllib.error.URLError as error:
            event_queue.put(("url_error", error))
        except Exception as error:
            event_queue.put(("error", error))
        finally:
            event_queue.put(("done", None))

    worker_thread = threading.Thread(target=worker, daemon=True)
    worker_thread.start()

    while True:
        try:
            item_type, payload = event_queue.get(timeout=BUTTON_POLL_INTERVAL_SECONDS)
        except queue.Empty:
            item_type = "poll"
            payload = None

        if item_type == "run_id":
            if isinstance(payload, str) and payload:
                run_id = payload
        elif item_type == "event":
            event_type, data = payload
            apply_stream_event(state, event_type, data)
            renderer.render(state)
        elif item_type == "url_error":
            state.phase = "Error"
            state.status = "Network failure"
            state.error = str(payload)
            state.visual = {
                "kind": "run_error",
                "badge": "net",
                "body": str(payload),
                "footer": "check host and retry",
            }
            renderer.render(state)
            break
        elif item_type == "error":
            state.phase = "Error"
            state.status = "Run failed"
            state.error = str(payload)
            state.visual = {
                "kind": "run_error",
                "badge": "err",
                "body": str(payload),
                "footer": "fix and retry",
            }
            renderer.render(state)
            break
        elif item_type == "done":
            break

        if not button_polling_supported or cancel_requested:
            continue

        is_pressed = renderer.poll_button_pressed()

        if is_pressed is None:
            button_polling_supported = False
            continue

        now = time.monotonic()

        if is_pressed and not was_pressed:
            pressed_started_at = now
            long_press_sent = False
        elif (
            is_pressed
            and was_pressed
            and not long_press_sent
            and pressed_started_at is not None
        ):
            hold_progress = clamp_progress((now - pressed_started_at) / BUTTON_LONG_PRESS_SECONDS)

            if now - pressed_started_at < BUTTON_LONG_PRESS_SECONDS:
                renderer.render(build_run_cancel_hold_screen_state(state, hold_progress))
                was_pressed = is_pressed
                continue

            if run_id:
                try:
                    request_run_cancel(base_url, run_id)
                except RuntimeError as error:
                    state.phase = "Error"
                    state.status = "Cancel failed"
                    state.error = str(error)
                    state.visual = {
                        "kind": "run_error",
                        "badge": "stop",
                        "body": str(error),
                        "footer": "cancel failed",
                    }
                    renderer.render(state)
                    break

                cancel_requested = True
                set_run_cancel_pending_visual(state)
                renderer.render(state)
                long_press_sent = True
        elif not is_pressed and was_pressed:
            if not long_press_sent:
                renderer.render(state)
            pressed_started_at = None
            long_press_sent = False

        was_pressed = is_pressed

    worker_thread.join(timeout=1)
    return state


def stream_talk(
    base_url: str,
    prompt: str,
    workspace: Optional[str],
    skill: Optional[str],
    renderer: ConsoleRenderer,
) -> None:
    state = build_prompt_state(prompt)
    payload: dict[str, str] = {
        "text": prompt,
    }

    if workspace:
        payload["workspace"] = workspace

    if skill:
        payload["skill"] = skill

    request = urllib.request.Request(
        f"{base_url}/api/talk",
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    renderer.render(state)

    stream_sse_request(request, base_url, renderer, state)


def run_mock_loop(
    base_url: str,
    workspace: Optional[str],
    skill: Optional[str],
    renderer: ConsoleRenderer,
) -> None:
    print("DumplBot mock UI. Type a prompt, ':workspace', ':skill', or ':jobs', or 'exit' to quit.")
    selected_workspace = workspace
    selected_skill = skill

    while True:
        try:
            prompt = input("Dumpl> ").strip()
        except EOFError:
            print()
            return
        except KeyboardInterrupt:
            print()
            return

        if not prompt:
            continue

        if prompt.lower() in {"exit", "quit"}:
            return

        if prompt.startswith(":workspace") or prompt.startswith("/workspace"):
            try:
                next_workspace = handle_workspace_command(base_url, prompt.replace("/", ":", 1), renderer)
            except (RuntimeError, urllib.error.URLError) as error:
                renderer.render(
                    ScreenState(
                        phase="Error",
                        status="Workspace switch failed",
                        error=str(error),
                    )
                )
            else:
                selected_workspace = next_workspace

            continue

        if prompt.startswith(":skill") or prompt.startswith("/skill"):
            try:
                next_skill = handle_skill_command(base_url, prompt.replace("/", ":", 1), renderer)
            except (RuntimeError, urllib.error.URLError) as error:
                renderer.render(
                    ScreenState(
                        phase="Error",
                        status="Skill switch failed",
                        error=str(error),
                    )
                )
            else:
                selected_skill = next_skill

            continue

        if prompt.startswith(":jobs") or prompt.startswith("/jobs"):
            try:
                handle_jobs_command(base_url, prompt.replace("/", ":", 1), renderer)
            except (RuntimeError, urllib.error.URLError) as error:
                renderer.render(
                    ScreenState(
                        phase="Error",
                        status="Job list failed",
                        error=str(error),
                    )
                )

            continue

        stream_talk(base_url, prompt, selected_workspace, selected_skill, renderer)


def run_single_prompt(
    base_url: str,
    workspace: Optional[str],
    skill: Optional[str],
    prompt: str,
    renderer: ConsoleRenderer,
) -> int:
    cleaned_prompt = prompt.strip()

    if not cleaned_prompt:
        renderer.render_notice("Prompt must be non-empty")
        return 1

    stream_talk(base_url, cleaned_prompt, workspace, skill, renderer)
    return 0


def run_job_upsert(
    base_url: str,
    job_id: str,
    schedule: str,
    prompt: str,
    workspace: Optional[str],
    skill: Optional[str],
    enabled: bool,
    renderer: ConsoleRenderer,
) -> int:
    renderer.render(
        ScreenState(
            phase="Jobs",
            status="Saving scheduler job",
            prompt=job_id,
            transcript=schedule,
            answer=prompt,
        )
    )

    try:
        job = upsert_job_entry(
            base_url,
            job_id,
            schedule,
            prompt,
            workspace,
            skill,
            enabled,
        )
    except (RuntimeError, urllib.error.URLError) as error:
        renderer.render(
            ScreenState(
                phase="Error",
                status="Job save failed",
                error=str(error),
            )
        )
        return 1

    renderer.render(
        ScreenState(
            phase="Jobs",
            status=f"Job saved: {job.get('id', job_id)}",
            prompt=job_id,
            transcript=schedule,
            answer=prompt,
        )
    )
    return 0


def run_job_action(
    base_url: str,
    action: str,
    job_id: str,
    renderer: ConsoleRenderer,
) -> int:
    renderer.render(
        ScreenState(
            phase="Jobs",
            status=f"{action.capitalize()} scheduler job",
            prompt=job_id,
        )
    )

    try:
        if action == "enable":
            job = set_job_enabled(base_url, job_id, True)
            status = "Job enabled"
        elif action == "disable":
            job = set_job_enabled(base_url, job_id, False)
            status = "Job disabled"
        else:
            delete_job_entry(base_url, job_id)
            job = None
            status = "Job deleted"
    except (RuntimeError, urllib.error.URLError) as error:
        renderer.render(
            ScreenState(
                phase="Error",
                status=f"Job {action} failed",
                prompt=job_id,
                error=str(error),
            )
        )
        return 1

    renderer.render(
        ScreenState(
            phase="Jobs",
            status=status,
            prompt=job_id,
            transcript=job.get("schedule") if isinstance(job, dict) else None,
            answer=str(job.get("last_result")) if isinstance(job, dict) and job.get("last_result") else "",
        )
    )
    return 0


def run_record_smoke(
    duration_seconds: float,
    renderer: ConsoleRenderer,
    config: UiRuntimeConfig,
    cancel_at_end: bool = False,
) -> int:
    if duration_seconds <= 0:
        renderer.render_notice("Record duration must be greater than zero")
        return 1

    recorder = ArecordRecorder(config)
    flow_state = process_capture_button_event(
        CaptureFlowState(),
        ButtonEvent("press"),
        recorder,
    )
    render_capture_flow(renderer, flow_state)

    if flow_state.phase == "Error":
        return 1

    time.sleep(duration_seconds)
    event = ButtonEvent("long_press") if cancel_at_end else ButtonEvent("release")
    flow_state = process_capture_button_event(flow_state, event, recorder)
    render_capture_flow(renderer, flow_state)
    return 1 if flow_state.phase == "Error" else 0


def run_button_capture_loop(
    renderer: ConsoleRenderer,
    config: UiRuntimeConfig,
    host_url: str,
    workspace: Optional[str],
    skill: Optional[str],
) -> int:
    recorder = ArecordRecorder(config)
    flow_state = CaptureFlowState()
    was_pressed = False
    long_press_sent = False
    pressed_started_at: Optional[float] = None

    render_capture_flow(renderer, flow_state)

    while True:
        is_pressed = renderer.poll_button_pressed()

        if is_pressed is None:
            emit_button_debug(config.button_debug, "polling unavailable")
            renderer.render_notice("Button polling unavailable")
            return 1

        now = time.monotonic()

        if is_pressed and not was_pressed:
            emit_button_debug(config.button_debug, "press")
            pressed_started_at = now
            long_press_sent = False
            flow_state = process_capture_button_event(
                flow_state,
                ButtonEvent("press"),
                recorder,
            )
            render_capture_flow(renderer, flow_state)
        elif (
            is_pressed
            and was_pressed
            and not long_press_sent
            and pressed_started_at is not None
        ):
            hold_progress = clamp_progress((now - pressed_started_at) / BUTTON_LONG_PRESS_SECONDS)

            if now - pressed_started_at < BUTTON_LONG_PRESS_SECONDS:
                render_capture_flow(renderer, flow_state, hold_progress=hold_progress)
                was_pressed = is_pressed
                time.sleep(BUTTON_POLL_INTERVAL_SECONDS)
                continue

            emit_button_debug(config.button_debug, "long_press")
            flow_state = process_capture_button_event(
                flow_state,
                ButtonEvent("long_press"),
                recorder,
            )
            render_capture_flow(renderer, flow_state)
            long_press_sent = True
        elif not is_pressed and was_pressed:
            if not long_press_sent:
                emit_button_debug(config.button_debug, "release")
                flow_state = process_capture_button_event(
                    flow_state,
                    ButtonEvent("release"),
                    recorder,
                )
                render_capture_flow(renderer, flow_state)

                if flow_state.phase == "Saved" and flow_state.saved_path:
                    emit_button_debug(
                        config.button_debug,
                        f"audio_talk:{flow_state.saved_path}",
                    )
                    talk_state = run_audio_talk_from_file(
                        host_url,
                        flow_state.saved_path,
                        workspace,
                        skill,
                        renderer,
                    )

                    if talk_state.phase == "Error":
                        flow_state = CaptureFlowState(
                            phase="Error",
                            error=talk_state.error,
                        )
                    else:
                        flow_state = CaptureFlowState()

            pressed_started_at = None
            long_press_sent = False

        was_pressed = is_pressed
        time.sleep(BUTTON_POLL_INTERVAL_SECONDS)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="DumplBot device UI")
    parser.add_argument("--mock", action="store_true", help="Run the text-only mock client")
    parser.add_argument("--preview", action="store_true", help="Run the desktop preview renderer")
    parser.add_argument("--preview-snapshot", help="Write one rasterized preview snapshot to PNG")
    parser.add_argument("--preview-gallery", help="Write a compact debug preview gallery to one directory")
    parser.add_argument("--preview-core-gallery", help="Write a host-free core UI gallery to one directory")
    parser.add_argument("--preview-appliance-gallery", help="Write a host-free first-run appliance gallery to one directory")
    parser.add_argument("--preview-debug-gallery", help="Write a host-free debug UI gallery to one directory")
    parser.add_argument("--preview-navigation-gallery", help="Write a host-free navigation-hold UI gallery to one directory")
    parser.add_argument("--preview-scheduler-gallery", help="Write a host-free scheduler UI gallery to one directory")
    parser.add_argument("--preview-skill-gallery", help="Write a host-free skill UI gallery to one directory")
    parser.add_argument("--preview-workspace-gallery", help="Write a host-free workspace UI gallery to one directory")
    parser.add_argument(
        "--preview-scale",
        type=int,
        default=PREVIEW_DEFAULT_SCALE,
        help="Desktop preview scale multiplier",
    )
    parser.add_argument("--host-url", default="http://127.0.0.1:4123", help="Base URL for dumplbotd")
    parser.add_argument("--prompt", help="Run one prompt and exit")
    parser.add_argument(
        "--record-seconds",
        type=float,
        help="Record audio for N seconds with arecord, then exit",
    )
    parser.add_argument(
        "--record-cancel",
        action="store_true",
        help="Cancel the smoke recording instead of saving it",
    )
    parser.add_argument(
        "--button-debug",
        action="store_true",
        help="Print button transition diagnostics to stderr",
    )
    parser.add_argument(
        "--jobs-screen",
        action="store_true",
        help="Show scheduler jobs on the renderer and refresh continuously",
    )
    parser.add_argument(
        "--scheduler-screen",
        choices=["summary", "detail", "history"],
        help="Show the scheduler summary/detail/history renderer screen",
    )
    parser.add_argument(
        "--scheduler-button-mode",
        action="store_true",
        help="Run button-driven scheduler navigation on the renderer",
    )
    parser.add_argument(
        "--scheduler-nav-mode",
        choices=["summary", "detail", "history"],
        help="Current scheduler screen used by --scheduler-nav-action",
    )
    parser.add_argument(
        "--scheduler-nav-job",
        help="Current scheduler job id used by --scheduler-nav-action",
    )
    parser.add_argument(
        "--scheduler-nav-action",
        choices=["next-screen", "next-job"],
        help="Apply one scheduler navigation step and exit",
    )
    parser.add_argument(
        "--scheduler-job",
        help="Job id used by --scheduler-screen detail/history",
    )
    parser.add_argument(
        "--scheduler-history-offset",
        type=parse_non_negative_int_arg,
        default=0,
        help="History offset used by --scheduler-screen detail/history",
    )
    parser.add_argument(
        "--jobs-refresh-seconds",
        type=float,
        default=5.0,
        help="Refresh interval for --jobs-screen",
    )
    parser.add_argument(
        "--selection-refresh-seconds",
        type=float,
        default=5.0,
        help="Refresh interval for workspace/skill selector screens",
    )
    parser.add_argument(
        "--job-history",
        help="Show one scheduler job history on the renderer and refresh continuously",
    )
    parser.add_argument(
        "--job-history-offset",
        type=parse_non_negative_int_arg,
        default=0,
        help="History offset used by --job-history",
    )
    parser.add_argument(
        "--job-detail",
        help="Show one scheduler job detail screen on the renderer and refresh continuously",
    )
    parser.add_argument(
        "--job-detail-history-offset",
        type=parse_non_negative_int_arg,
        default=0,
        help="History offset used by --job-detail",
    )
    parser.add_argument(
        "--job-detail-action",
        choices=["enable", "disable", "delete"],
        help="Apply one action before entering --job-detail",
    )
    parser.add_argument("--job-detail-prompt", help="Patch prompt before entering --job-detail")
    parser.add_argument("--job-detail-schedule", help="Patch schedule before entering --job-detail")
    parser.add_argument("--job-detail-workspace", help="Patch workspace before entering --job-detail")
    parser.add_argument("--job-detail-skill", help="Patch skill before entering --job-detail")
    parser.add_argument("--job-id", help="Create or update one scheduler job and exit")
    parser.add_argument("--job-schedule", help="Schedule or preset for --job-id")
    parser.add_argument("--job-prompt", help="Prompt for --job-id")
    parser.add_argument("--job-workspace", help="Workspace for --job-id")
    parser.add_argument("--job-skill", help="Skill for --job-id")
    parser.add_argument(
        "--job-disabled",
        action="store_true",
        help="Save --job-id as disabled",
    )
    parser.add_argument("--job-enable", help="Enable one scheduler job and exit")
    parser.add_argument("--job-disable", help="Disable one scheduler job and exit")
    parser.add_argument("--job-delete", help="Delete one scheduler job and exit")
    parser.add_argument("--workspace-screen", action="store_true", help="Show the workspace selector screen")
    parser.add_argument("--workspace-files", help="Show one workspace file list screen and exit")
    parser.add_argument("--workspace-file", help="Show one workspace file on the renderer and exit")
    parser.add_argument("--workspace-file-path", help="Workspace file path used by --workspace-file")
    parser.add_argument(
        "--workspace-history",
        help="Show one workspace history screen on the renderer and refresh continuously",
    )
    parser.add_argument(
        "--workspace-history-offset",
        type=parse_non_negative_int_arg,
        default=0,
        help="History offset used by --workspace-history",
    )
    parser.add_argument("--workspace-detail", help="Show one workspace detail screen and exit")
    parser.add_argument("--workspace-create", help="Create one workspace and show its detail screen")
    parser.add_argument("--workspace-instructions", help="Instructions used by --workspace-create")
    parser.add_argument("--workspace-select", help="Select one active workspace and exit")
    parser.add_argument("--workspace-cycle", action="store_true", help="Cycle to the next workspace and exit")
    parser.add_argument("--workspace-clear", action="store_true", help="Clear the active workspace and exit")
    parser.add_argument("--skill-screen", action="store_true", help="Show the skill selector screen")
    parser.add_argument("--skill-summary", action="store_true", help="Show one skill summary screen and exit")
    parser.add_argument("--skill-detail", help="Show one skill detail screen and exit")
    parser.add_argument("--skill-select", help="Select one active skill and exit")
    parser.add_argument("--skill-cycle", action="store_true", help="Cycle to the next skill and exit")
    parser.add_argument("--skill-clear", action="store_true", help="Clear the active skill and exit")
    parser.add_argument("--workspace", help="Workspace override for talk requests")
    parser.add_argument("--skill", help="Skill override for talk requests")
    parser.add_argument("--home-screen", action="store_true", help="Show one device home screen and exit")
    parser.add_argument("--transcript-screen", action="store_true", help="Show last transcript debug screen and exit")
    parser.add_argument("--audio-screen", action="store_true", help="Show last audio debug screen and exit")
    parser.add_argument("--error-screen", action="store_true", help="Show last error debug screen and exit")
    parser.add_argument("--voice-debug-screen", action="store_true", help="Show compact transcript/audio/error debug summary and exit")
    parser.add_argument(
        "--seed-debug-state",
        choices=["success", "error"],
        help="Seed one preview-friendly transcript/audio/error state and show the compact debug screen",
    )
    parser.add_argument("--clear-debug-state", action="store_true", help="Clear transcript/audio/error debug state and show the empty bundle screen")
    parser.add_argument("--home-button-mode", action="store_true", help="Run button-driven home navigation on the renderer")
    parser.add_argument(
        "--home-nav-mode",
        choices=["home", "workspace", "skill", "scheduler", "diagnostics", "voice", "transcript", "audio", "error"],
        help="Current home navigation screen used by --home-nav-action",
    )
    parser.add_argument(
        "--home-nav-target",
        choices=["workspace", "skill", "scheduler", "diagnostics", "voice", "transcript", "audio", "error"],
        help="Focused home target used by --home-nav-action",
    )
    parser.add_argument(
        "--home-nav-action",
        choices=["next-target", "toggle-view", "clear-debug"],
        help="Apply one home navigation step and exit",
    )
    parser.add_argument("--diagnostics-screen", action="store_true", help="Show one diagnostics screen and exit")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.preview and args.preview_snapshot is not None:
        ConsoleRenderer().render_notice("Use --preview or --preview-snapshot, not both")
        return 1

    if args.preview_gallery is not None and args.preview_core_gallery is not None:
        ConsoleRenderer().render_notice("Use --preview-gallery or --preview-core-gallery, not both")
        return 1

    if args.preview_appliance_gallery is not None and (
        args.preview_gallery is not None
        or args.preview_core_gallery is not None
    ):
        ConsoleRenderer().render_notice("Use one preview gallery mode at a time")
        return 1

    if args.preview_debug_gallery is not None and (
        args.preview_gallery is not None
        or args.preview_core_gallery is not None
        or args.preview_appliance_gallery is not None
    ):
        ConsoleRenderer().render_notice("Use one preview gallery mode at a time")
        return 1

    if args.preview_navigation_gallery is not None and (
        args.preview_gallery is not None
        or args.preview_core_gallery is not None
        or args.preview_appliance_gallery is not None
        or args.preview_debug_gallery is not None
    ):
        ConsoleRenderer().render_notice("Use one preview gallery mode at a time")
        return 1

    if args.preview_scheduler_gallery is not None and (
        args.preview_gallery is not None
        or args.preview_core_gallery is not None
        or args.preview_appliance_gallery is not None
        or args.preview_debug_gallery is not None
        or args.preview_navigation_gallery is not None
    ):
        ConsoleRenderer().render_notice("Use one preview gallery mode at a time")
        return 1

    if args.preview_skill_gallery is not None and (
        args.preview_gallery is not None
        or args.preview_core_gallery is not None
        or args.preview_appliance_gallery is not None
        or args.preview_debug_gallery is not None
        or args.preview_navigation_gallery is not None
        or args.preview_scheduler_gallery is not None
    ):
        ConsoleRenderer().render_notice("Use one preview gallery mode at a time")
        return 1

    if args.preview_workspace_gallery is not None and (
        args.preview_gallery is not None
        or args.preview_core_gallery is not None
        or args.preview_appliance_gallery is not None
        or args.preview_debug_gallery is not None
        or args.preview_navigation_gallery is not None
        or args.preview_scheduler_gallery is not None
        or args.preview_skill_gallery is not None
    ):
        ConsoleRenderer().render_notice("Use one preview gallery mode at a time")
        return 1

    if args.preview_gallery is not None and (
        args.preview
        or args.preview_snapshot is not None
        or args.mock
    ):
        ConsoleRenderer().render_notice("Use --preview-gallery separately from --mock/--preview/--preview-snapshot")
        return 1

    if args.preview_core_gallery is not None and (
        args.preview
        or args.preview_snapshot is not None
        or args.mock
    ):
        ConsoleRenderer().render_notice("Use --preview-core-gallery separately from --mock/--preview/--preview-snapshot")
        return 1

    if args.preview_appliance_gallery is not None and (
        args.preview
        or args.preview_snapshot is not None
        or args.mock
    ):
        ConsoleRenderer().render_notice("Use --preview-appliance-gallery separately from --mock/--preview/--preview-snapshot")
        return 1

    if args.preview_debug_gallery is not None and (
        args.preview
        or args.preview_snapshot is not None
        or args.mock
    ):
        ConsoleRenderer().render_notice("Use --preview-debug-gallery separately from --mock/--preview/--preview-snapshot")
        return 1

    if args.preview_navigation_gallery is not None and (
        args.preview
        or args.preview_snapshot is not None
        or args.mock
    ):
        ConsoleRenderer().render_notice("Use --preview-navigation-gallery separately from --mock/--preview/--preview-snapshot")
        return 1

    if args.preview_scheduler_gallery is not None and (
        args.preview
        or args.preview_snapshot is not None
        or args.mock
    ):
        ConsoleRenderer().render_notice("Use --preview-scheduler-gallery separately from --mock/--preview/--preview-snapshot")
        return 1

    if args.preview_skill_gallery is not None and (
        args.preview
        or args.preview_snapshot is not None
        or args.mock
    ):
        ConsoleRenderer().render_notice("Use --preview-skill-gallery separately from --mock/--preview/--preview-snapshot")
        return 1

    if args.preview_workspace_gallery is not None and (
        args.preview
        or args.preview_snapshot is not None
        or args.mock
    ):
        ConsoleRenderer().render_notice("Use --preview-workspace-gallery separately from --mock/--preview/--preview-snapshot")
        return 1

    if args.mock and args.preview:
        ConsoleRenderer().render_notice("Use --mock or --preview, not both")
        return 1

    if args.preview_scale < 1:
        ConsoleRenderer().render_notice("--preview-scale must be >= 1")
        return 1

    renderer: ConsoleRenderer

    if args.preview:
        renderer = DesktopPreviewRenderer(scale=args.preview_scale)
    elif args.preview_snapshot is not None:
        renderer = SnapshotRenderer(args.preview_snapshot, scale=args.preview_scale)
    elif args.preview_gallery is not None:
        renderer = ConsoleRenderer("Preview Gallery")
    elif args.preview_core_gallery is not None:
        renderer = ConsoleRenderer("Core Gallery")
    elif args.preview_appliance_gallery is not None:
        renderer = ConsoleRenderer("Appliance Gallery")
    elif args.preview_debug_gallery is not None:
        renderer = ConsoleRenderer("Debug Gallery")
    elif args.preview_navigation_gallery is not None:
        renderer = ConsoleRenderer("Navigation Gallery")
    elif args.preview_scheduler_gallery is not None:
        renderer = ConsoleRenderer("Scheduler Gallery")
    elif args.preview_skill_gallery is not None:
        renderer = ConsoleRenderer("Skill Gallery")
    elif args.preview_workspace_gallery is not None:
        renderer = ConsoleRenderer("Workspace Gallery")
    elif args.mock:
        renderer = ConsoleRenderer()
    else:
        renderer = WhisplayRenderer()
    ui_config = load_ui_runtime_config()

    if args.button_debug:
        ui_config.button_debug = True

    try:
        if args.record_seconds is not None:
            return run_record_smoke(
                args.record_seconds,
                renderer,
                ui_config,
                cancel_at_end=args.record_cancel,
            )

        has_job_upsert_arg = any(
            value is not None
            for value in (args.job_id, args.job_schedule, args.job_prompt)
        )
        job_action_args = [
            ("enable", args.job_enable),
            ("disable", args.job_disable),
            ("delete", args.job_delete),
        ]
        selected_job_actions = [
            (action, value)
            for action, value in job_action_args
            if value is not None
        ]

        if has_job_upsert_arg and selected_job_actions:
            renderer.render_notice("Use one scheduler action mode at a time")
            return 1

        if len(selected_job_actions) > 1:
            renderer.render_notice("Use only one of --job-enable, --job-disable, or --job-delete")
            return 1

        if args.job_detail_action is not None and args.job_detail is None:
            renderer.render_notice("--job-detail-action requires --job-detail")
            return 1

        if args.job_detail_action is not None and selected_job_actions:
            renderer.render_notice("Use --job-detail-action or direct job action flags, not both")
            return 1

        if args.job_history_offset and args.job_history is None:
            renderer.render_notice("--job-history-offset requires --job-history")
            return 1

        if args.workspace_history_offset and args.workspace_history is None:
            renderer.render_notice("--workspace-history-offset requires --workspace-history")
            return 1

        if args.workspace_file_path is not None and args.workspace_file is None:
            renderer.render_notice("--workspace-file-path requires --workspace-file")
            return 1

        if args.workspace_file is not None and args.workspace_file_path is None:
            renderer.render_notice("--workspace-file requires --workspace-file-path")
            return 1

        if args.job_detail_history_offset and args.job_detail is None:
            renderer.render_notice("--job-detail-history-offset requires --job-detail")
            return 1

        has_job_detail_patch_arg = any(
            value is not None
            for value in (
                args.job_detail_prompt,
                args.job_detail_schedule,
                args.job_detail_workspace,
                args.job_detail_skill,
            )
        )

        if has_job_detail_patch_arg and args.job_detail is None:
            renderer.render_notice("--job-detail-prompt/--job-detail-schedule require --job-detail")
            return 1

        if args.job_detail_action is not None and has_job_detail_patch_arg:
            renderer.render_notice("Use detail action or detail edit fields, not both")
            return 1

        if args.scheduler_screen is not None and (
            args.jobs_screen
            or args.job_history is not None
            or args.job_detail is not None
            or args.scheduler_button_mode
            or args.scheduler_nav_action is not None
        ):
            renderer.render_notice("Use one scheduler screen/navigation mode at a time")
            return 1

        if args.scheduler_button_mode and (
            args.jobs_screen
            or args.job_history is not None
            or args.job_detail is not None
            or args.scheduler_nav_action is not None
        ):
            renderer.render_notice("Use --scheduler-button-mode separately from other scheduler views")
            return 1

        if args.scheduler_nav_action is not None and (
            args.jobs_screen
            or args.job_history is not None
            or args.job_detail is not None
            or args.scheduler_button_mode
        ):
            renderer.render_notice("Use --scheduler-nav-action separately from other scheduler views")
            return 1

        if (
            args.scheduler_screen is not None
            or args.scheduler_button_mode
            or args.scheduler_nav_action is not None
        ) and (has_job_upsert_arg or selected_job_actions):
            renderer.render_notice("Use scheduler view flags or direct scheduler mutation flags, not both")
            return 1

        if (
            args.scheduler_screen is not None
            or args.scheduler_button_mode
            or args.scheduler_nav_action is not None
        ) and (
            args.job_detail_action is not None
            or has_job_detail_patch_arg
        ):
            renderer.render_notice("Use focused --job-detail actions/edits or --scheduler-screen, not both")
            return 1

        if args.scheduler_screen == "summary" and args.scheduler_job is not None:
            renderer.render_notice("--scheduler-job only applies to detail/history scheduler screens")
            return 1

        if args.scheduler_screen == "summary" and args.scheduler_history_offset:
            renderer.render_notice("--scheduler-history-offset only applies to detail/history scheduler screens")
            return 1

        if args.scheduler_screen is None and args.scheduler_job is not None:
            renderer.render_notice("--scheduler-job requires --scheduler-screen")
            return 1

        if args.scheduler_screen is None and args.scheduler_history_offset:
            renderer.render_notice("--scheduler-history-offset requires --scheduler-screen")
            return 1

        if args.scheduler_screen in {"detail", "history"} and args.scheduler_job is None:
            renderer.render_notice("--scheduler-screen detail/history requires --scheduler-job")
            return 1

        if args.scheduler_nav_action is not None and args.scheduler_nav_mode is None:
            renderer.render_notice("--scheduler-nav-action requires --scheduler-nav-mode")
            return 1

        if args.scheduler_nav_action is None and (args.scheduler_nav_mode is not None or args.scheduler_nav_job is not None):
            renderer.render_notice("--scheduler-nav-mode/--scheduler-nav-job require --scheduler-nav-action")
            return 1

        workspace_selector_count = sum(
            1
            for value in (
                args.workspace_screen,
                args.workspace_files is not None,
                args.workspace_file is not None,
                args.workspace_history is not None,
                args.workspace_detail is not None,
                args.workspace_create is not None,
                args.workspace_cycle,
                args.workspace_clear,
                args.workspace_select is not None,
            )
            if value
        )

        if workspace_selector_count > 1:
            renderer.render_notice("Use one workspace selector mode at a time")
            return 1

        if args.workspace_instructions is not None and args.workspace_create is None:
            renderer.render_notice("--workspace-instructions requires --workspace-create")
            return 1

        skill_selector_count = sum(
            1
            for value in (
                args.skill_screen,
                args.skill_summary,
                args.skill_detail is not None,
                args.skill_cycle,
                args.skill_clear,
                args.skill_select is not None,
            )
            if value
        )

        if skill_selector_count > 1:
            renderer.render_notice("Use one skill selector mode at a time")
            return 1

        if workspace_selector_count and skill_selector_count:
            renderer.render_notice("Use workspace or skill selector modes, not both at once")
            return 1

        selector_mode_active = workspace_selector_count or skill_selector_count

        if workspace_selector_count and args.workspace is not None:
            renderer.render_notice("Use --workspace-select/cycle/clear or talk override --workspace, not both")
            return 1

        if skill_selector_count and args.skill is not None:
            renderer.render_notice("Use --skill-select/cycle/clear or talk override --skill, not both")
            return 1

        top_level_debug_screen_count = sum(
            1
            for value in (
                args.home_screen,
                args.diagnostics_screen,
                args.transcript_screen,
                args.audio_screen,
                args.error_screen,
                args.voice_debug_screen,
                args.seed_debug_state is not None,
                args.clear_debug_state,
            )
            if value
        )

        if top_level_debug_screen_count > 1:
            renderer.render_notice("Use only one top-level home/debug screen at a time")
            return 1

        if args.home_nav_action is not None and args.home_nav_mode is None:
            renderer.render_notice("--home-nav-action requires --home-nav-mode")
            return 1

        if args.home_button_mode and (
            args.home_screen
            or args.diagnostics_screen
            or args.transcript_screen
            or args.audio_screen
            or args.error_screen
            or args.voice_debug_screen
            or args.seed_debug_state is not None
            or args.clear_debug_state
            or args.home_nav_action is not None
            or args.jobs_screen
            or args.job_history is not None
            or args.job_detail is not None
            or args.scheduler_screen is not None
            or args.scheduler_button_mode
            or args.scheduler_nav_action is not None
        ):
            renderer.render_notice("Use --home-button-mode separately from other home/scheduler views")
            return 1

        if args.home_nav_action is None and (
            args.home_nav_mode is not None
            or args.home_nav_target is not None
        ):
            renderer.render_notice("--home-nav-mode/--home-nav-target require --home-nav-action")
            return 1

        if args.preview_gallery is not None and (
            args.home_screen
            or args.home_button_mode
            or args.diagnostics_screen
            or args.transcript_screen
            or args.audio_screen
            or args.error_screen
            or args.voice_debug_screen
            or args.clear_debug_state
            or args.home_nav_action is not None
            or args.prompt is not None
            or selector_mode_active
            or args.scheduler_screen is not None
            or args.scheduler_button_mode
            or args.scheduler_nav_action is not None
            or args.jobs_screen
            or args.job_history is not None
            or args.job_detail is not None
            or has_job_upsert_arg
            or selected_job_actions
        ):
            renderer.render_notice("Use --preview-gallery separately from other screen/action flows")
            return 1

        if args.preview_core_gallery is not None and (
            args.home_screen
            or args.home_button_mode
            or args.diagnostics_screen
            or args.transcript_screen
            or args.audio_screen
            or args.error_screen
            or args.voice_debug_screen
            or args.seed_debug_state is not None
            or args.clear_debug_state
            or args.home_nav_action is not None
            or args.prompt is not None
            or selector_mode_active
            or args.scheduler_screen is not None
            or args.scheduler_button_mode
            or args.scheduler_nav_action is not None
            or args.jobs_screen
            or args.job_history is not None
            or args.job_detail is not None
            or has_job_upsert_arg
            or selected_job_actions
        ):
            renderer.render_notice("Use --preview-core-gallery separately from other screen/action flows")
            return 1

        if args.preview_appliance_gallery is not None and (
            args.home_screen
            or args.home_button_mode
            or args.diagnostics_screen
            or args.transcript_screen
            or args.audio_screen
            or args.error_screen
            or args.voice_debug_screen
            or args.seed_debug_state is not None
            or args.clear_debug_state
            or args.home_nav_action is not None
            or args.prompt is not None
            or selector_mode_active
            or args.scheduler_screen is not None
            or args.scheduler_button_mode
            or args.scheduler_nav_action is not None
            or args.jobs_screen
            or args.job_history is not None
            or args.job_detail is not None
            or has_job_upsert_arg
            or selected_job_actions
        ):
            renderer.render_notice("Use --preview-appliance-gallery separately from other screen/action flows")
            return 1

        if args.preview_debug_gallery is not None and (
            args.home_screen
            or args.home_button_mode
            or args.diagnostics_screen
            or args.transcript_screen
            or args.audio_screen
            or args.error_screen
            or args.voice_debug_screen
            or args.seed_debug_state is not None
            or args.clear_debug_state
            or args.home_nav_action is not None
            or args.prompt is not None
            or selector_mode_active
            or args.scheduler_screen is not None
            or args.scheduler_button_mode
            or args.scheduler_nav_action is not None
            or args.jobs_screen
            or args.job_history is not None
            or args.job_detail is not None
            or has_job_upsert_arg
            or selected_job_actions
        ):
            renderer.render_notice("Use --preview-debug-gallery separately from other screen/action flows")
            return 1

        if args.preview_navigation_gallery is not None and (
            args.home_screen
            or args.home_button_mode
            or args.diagnostics_screen
            or args.transcript_screen
            or args.audio_screen
            or args.error_screen
            or args.voice_debug_screen
            or args.seed_debug_state is not None
            or args.clear_debug_state
            or args.home_nav_action is not None
            or args.prompt is not None
            or selector_mode_active
            or args.scheduler_screen is not None
            or args.scheduler_button_mode
            or args.scheduler_nav_action is not None
            or args.jobs_screen
            or args.job_history is not None
            or args.job_detail is not None
            or has_job_upsert_arg
            or selected_job_actions
        ):
            renderer.render_notice("Use --preview-navigation-gallery separately from other screen/action flows")
            return 1

        if args.preview_scheduler_gallery is not None and (
            args.home_screen
            or args.home_button_mode
            or args.diagnostics_screen
            or args.transcript_screen
            or args.audio_screen
            or args.error_screen
            or args.voice_debug_screen
            or args.seed_debug_state is not None
            or args.clear_debug_state
            or args.home_nav_action is not None
            or args.prompt is not None
            or selector_mode_active
            or args.scheduler_screen is not None
            or args.scheduler_button_mode
            or args.scheduler_nav_action is not None
            or args.jobs_screen
            or args.job_history is not None
            or args.job_detail is not None
            or has_job_upsert_arg
            or selected_job_actions
        ):
            renderer.render_notice("Use --preview-scheduler-gallery separately from other screen/action flows")
            return 1

        if args.preview_skill_gallery is not None and (
            args.home_screen
            or args.home_button_mode
            or args.diagnostics_screen
            or args.transcript_screen
            or args.audio_screen
            or args.error_screen
            or args.voice_debug_screen
            or args.seed_debug_state is not None
            or args.clear_debug_state
            or args.home_nav_action is not None
            or args.prompt is not None
            or selector_mode_active
            or args.scheduler_screen is not None
            or args.scheduler_button_mode
            or args.scheduler_nav_action is not None
            or args.jobs_screen
            or args.job_history is not None
            or args.job_detail is not None
            or has_job_upsert_arg
            or selected_job_actions
        ):
            renderer.render_notice("Use --preview-skill-gallery separately from other screen/action flows")
            return 1

        if args.preview_workspace_gallery is not None and (
            args.home_screen
            or args.home_button_mode
            or args.diagnostics_screen
            or args.transcript_screen
            or args.audio_screen
            or args.error_screen
            or args.voice_debug_screen
            or args.seed_debug_state is not None
            or args.clear_debug_state
            or args.home_nav_action is not None
            or args.prompt is not None
            or selector_mode_active
            or args.scheduler_screen is not None
            or args.scheduler_button_mode
            or args.scheduler_nav_action is not None
            or args.jobs_screen
            or args.job_history is not None
            or args.job_detail is not None
            or has_job_upsert_arg
            or selected_job_actions
        ):
            renderer.render_notice("Use --preview-workspace-gallery separately from other screen/action flows")
            return 1

        if selector_mode_active and (
            args.home_screen
            or args.home_button_mode
            or args.diagnostics_screen
            or args.transcript_screen
            or args.audio_screen
            or args.error_screen
            or args.voice_debug_screen
            or args.seed_debug_state is not None
            or args.clear_debug_state
            or args.home_nav_action is not None
            or args.prompt is not None
            or args.scheduler_screen is not None
            or args.jobs_screen
            or args.job_history is not None
            or args.job_detail is not None
            or has_job_upsert_arg
            or selected_job_actions
        ):
            renderer.render_notice("Use workspace/skill selector modes separately from diagnostics/prompt/scheduler flows")
            return 1

        if (
            args.home_screen
            or args.home_button_mode
            or args.diagnostics_screen
            or args.transcript_screen
            or args.audio_screen
            or args.error_screen
            or args.voice_debug_screen
            or args.seed_debug_state is not None
            or args.clear_debug_state
            or args.home_nav_action is not None
        ) and (
            args.prompt is not None
            or selector_mode_active
            or args.scheduler_screen is not None
            or args.jobs_screen
            or args.job_history is not None
            or args.job_detail is not None
            or has_job_upsert_arg
            or selected_job_actions
        ):
            renderer.render_notice("Use home/diagnostics navigation flags separately from selector/prompt/scheduler flows")
            return 1

        if has_job_upsert_arg:
            if not args.job_id or not args.job_schedule or not args.job_prompt:
                renderer.render_notice("--job-id, --job-schedule, and --job-prompt are required together")
                return 1

            return run_job_upsert(
                args.host_url,
                args.job_id,
                args.job_schedule,
                args.job_prompt,
                args.job_workspace,
                args.job_skill,
                not args.job_disabled,
                renderer,
            )

        if selected_job_actions:
            action, job_id = selected_job_actions[0]
            return run_job_action(
                args.host_url,
                action,
                job_id,
                renderer,
            )

        if args.scheduler_button_mode:
            return run_scheduler_button_loop(
                args.host_url,
                renderer,
            )

        if args.scheduler_nav_action is not None:
            return run_scheduler_navigation_preview(
                args.host_url,
                renderer,
                SchedulerNavigationState(
                    screen_mode=args.scheduler_nav_mode,
                    job_id=args.scheduler_nav_job,
                ),
                args.scheduler_nav_action,
            )

        if args.scheduler_screen is not None:
            return run_scheduler_screen(
                args.host_url,
                args.scheduler_screen,
                args.scheduler_job,
                args.scheduler_history_offset,
                renderer,
                args.jobs_refresh_seconds,
            )

        if args.workspace_screen:
            return run_workspace_screen(
                args.host_url,
                renderer,
                args.selection_refresh_seconds,
            )

        if args.workspace_files is not None:
            return run_workspace_files(
                args.host_url,
                renderer,
                args.workspace_files,
            )

        if args.workspace_file is not None:
            return run_workspace_file(
                args.host_url,
                renderer,
                args.workspace_file,
                args.workspace_file_path,
            )

        if args.workspace_history is not None:
            return run_workspace_history_screen(
                args.host_url,
                args.workspace_history,
                renderer,
                args.selection_refresh_seconds,
                history_offset=args.workspace_history_offset,
            )

        if args.workspace_detail is not None:
            return run_workspace_detail(
                args.host_url,
                renderer,
                args.workspace_detail,
            )

        if args.workspace_create is not None:
            return run_workspace_create(
                args.host_url,
                renderer,
                args.workspace_create,
                args.workspace_instructions,
            )

        if args.workspace_cycle:
            return run_workspace_action(
                args.host_url,
                renderer,
                "cycle",
            )

        if args.workspace_clear:
            return run_workspace_action(
                args.host_url,
                renderer,
                "clear",
            )

        if args.workspace_select is not None:
            return run_workspace_action(
                args.host_url,
                renderer,
                "select",
                args.workspace_select,
            )

        if args.skill_screen:
            return run_skill_screen(
                args.host_url,
                renderer,
                args.selection_refresh_seconds,
            )

        if args.skill_summary:
            return run_skill_summary(
                args.host_url,
                renderer,
            )

        if args.home_screen:
            return run_home_screen(
                args.host_url,
                renderer,
            )

        if args.transcript_screen:
            return run_transcript_debug_screen(
                args.host_url,
                renderer,
            )

        if args.audio_screen:
            return run_audio_debug_screen(
                args.host_url,
                renderer,
            )

        if args.error_screen:
            return run_error_debug_screen(
                args.host_url,
                renderer,
            )

        if args.voice_debug_screen:
            return run_voice_debug_bundle_screen(
                args.host_url,
                renderer,
            )

        if args.preview_gallery is not None:
            return run_preview_gallery(
                args.host_url,
                renderer,
                args.preview_gallery,
                args.preview_scale,
                args.seed_debug_state,
            )

        if args.preview_core_gallery is not None:
            return run_preview_core_gallery(
                renderer,
                args.preview_core_gallery,
                args.preview_scale,
            )

        if args.preview_appliance_gallery is not None:
            return run_preview_appliance_gallery(
                renderer,
                args.preview_appliance_gallery,
                args.preview_scale,
            )

        if args.preview_debug_gallery is not None:
            return run_preview_debug_gallery(
                renderer,
                args.preview_debug_gallery,
                args.preview_scale,
            )

        if args.preview_navigation_gallery is not None:
            return run_preview_navigation_gallery(
                renderer,
                args.preview_navigation_gallery,
                args.preview_scale,
            )

        if args.preview_scheduler_gallery is not None:
            return run_preview_scheduler_gallery(
                renderer,
                args.preview_scheduler_gallery,
                args.preview_scale,
            )

        if args.preview_skill_gallery is not None:
            return run_preview_skill_gallery(
                renderer,
                args.preview_skill_gallery,
                args.preview_scale,
            )

        if args.preview_workspace_gallery is not None:
            return run_preview_workspace_gallery(
                renderer,
                args.preview_workspace_gallery,
                args.preview_scale,
            )

        if args.seed_debug_state is not None:
            return run_seed_debug_state(
                args.host_url,
                renderer,
                args.seed_debug_state,
            )

        if args.clear_debug_state:
            return run_clear_debug_state(
                args.host_url,
                renderer,
            )

        if args.home_button_mode:
            return run_home_button_loop(
                args.host_url,
                renderer,
            )

        if args.home_nav_action is not None:
            return run_home_navigation_preview(
                args.host_url,
                renderer,
                normalize_home_navigation_state(
                    args.home_nav_mode,
                    args.home_nav_target,
                ),
                args.home_nav_action,
            )

        if args.diagnostics_screen:
            return run_diagnostics_screen(
                args.host_url,
                renderer,
            )

        if args.skill_detail is not None:
            return run_skill_detail(
                args.host_url,
                renderer,
                args.skill_detail,
            )

        if args.skill_cycle:
            return run_skill_action(
                args.host_url,
                renderer,
                "cycle",
            )

        if args.skill_clear:
            return run_skill_action(
                args.host_url,
                renderer,
                "clear",
            )

        if args.skill_select is not None:
            return run_skill_action(
                args.host_url,
                renderer,
                "select",
                args.skill_select,
            )

        if args.jobs_screen:
            return run_jobs_screen(
                args.host_url,
                renderer,
                args.jobs_refresh_seconds,
            )

        if args.job_history is not None:
            return run_job_history_screen(
                args.host_url,
                args.job_history,
                renderer,
                args.jobs_refresh_seconds,
                history_offset=args.job_history_offset,
            )

        if args.job_detail is not None:
            return run_job_detail_screen(
                args.host_url,
                args.job_detail,
                renderer,
                args.jobs_refresh_seconds,
                args.job_detail_history_offset,
                args.job_detail_action,
                args.job_detail_prompt,
                args.job_detail_schedule,
                args.job_detail_workspace,
                args.job_detail_skill,
            )

        if args.prompt is not None:
            return run_single_prompt(
                args.host_url,
                args.workspace,
                args.skill,
                args.prompt,
                renderer,
            )

        if args.mock:
            run_mock_loop(args.host_url, args.workspace, args.skill, renderer)
            return 0

        return run_button_capture_loop(
            renderer,
            ui_config,
            args.host_url,
            args.workspace,
            args.skill,
        )
    finally:
        renderer.close()


if __name__ == "__main__":
    raise SystemExit(main())
