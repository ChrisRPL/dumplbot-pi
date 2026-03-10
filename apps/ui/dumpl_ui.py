#!/usr/bin/env python3

import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import textwrap
import time
from typing import Any, Iterator, Optional
import urllib.error
import urllib.request

SCREEN_WIDTH = 48
WHISPLAY_TEXT_WIDTH = 28
WHISPLAY_DEFAULT_WIDTH = 170
WHISPLAY_DEFAULT_HEIGHT = 320
WHISPLAY_BACKGROUND = (10, 15, 20)
WHISPLAY_HEADER_BACKGROUND = (18, 34, 48)
WHISPLAY_FOREGROUND = (242, 244, 247)
BUTTON_POLL_INTERVAL_SECONDS = 0.05
BUTTON_LONG_PRESS_SECONDS = 1.2
WHISPLAY_PHASE_RGB = {
    "Idle": (0, 64, 16),
    "Jobs": (0, 56, 72),
    "Listening": (0, 48, 96),
    "Transcribing": (0, 64, 96),
    "Thinking": (96, 72, 0),
    "Tool": (96, 40, 0),
    "Answer": (32, 80, 24),
    "Saved": (0, 72, 32),
    "Error": (96, 0, 0),
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


@dataclass
class UiRuntimeConfig:
    audio_capture_cmd: str = "arecord"
    ptt_wav_path: str = "/tmp/dumplbot/ptt.wav"
    button_debug: bool = False


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


def build_capture_screen_state(state: CaptureFlowState) -> ScreenState:
    if state.phase == "Listening":
        return ScreenState(
            phase="Listening",
            status="Recording audio",
        )

    if state.phase == "Saved":
        return ScreenState(
            phase="Saved",
            status="Audio capture saved",
            transcript=state.saved_path,
        )

    if state.phase == "Error":
        return ScreenState(
            phase="Error",
            status="Audio capture failed",
            error=state.error or "Unknown error",
        )

    return ScreenState(
        phase="Idle",
        status="Ready for push-to-talk",
    )


def render_capture_flow(
    renderer: "ConsoleRenderer",
    state: CaptureFlowState,
) -> None:
    renderer.render(build_capture_screen_state(state))


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


def list_workspace_entries(base_url: str) -> list[dict[str, Any]]:
    payload = request_json(base_url, "/api/workspaces")
    workspaces = payload.get("workspaces")

    if not isinstance(workspaces, list):
        raise RuntimeError("workspace list response is invalid")

    return [workspace for workspace in workspaces if isinstance(workspace, dict)]


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
    selection = argument.strip()

    if not selection:
        workspaces = list_workspace_entries(base_url)
        print("Workspaces:")

        for workspace in workspaces:
            workspace_id = workspace.get("id")

            if not isinstance(workspace_id, str):
                continue

            marker = "*" if workspace.get("is_active") else " "
            print(f"{marker} {workspace_id}")

        return None

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


def list_skill_entries(base_url: str) -> list[dict[str, Any]]:
    payload = request_json(base_url, "/api/skills")
    skills = payload.get("skills")

    if not isinstance(skills, list):
        raise RuntimeError("skill list response is invalid")

    return [skill for skill in skills if isinstance(skill, dict)]


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


def list_job_entries(base_url: str) -> list[dict[str, Any]]:
    payload = request_json(base_url, "/api/jobs")
    jobs = payload.get("jobs")

    if not isinstance(jobs, list):
        raise RuntimeError("job list response is invalid")

    return [job for job in jobs if isinstance(job, dict)]


def find_job_entry(base_url: str, job_id: str) -> dict[str, Any]:
    normalized_job_id = job_id.strip().lower()

    for job in list_job_entries(base_url):
        if job.get("id") == normalized_job_id:
            return job

    raise RuntimeError("job not found")


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
        if len(tokens) != 2:
            renderer.render_notice("Usage: :jobs history <id>")
            return

        job = find_job_entry(base_url, tokens[1])
        history = job.get("history")

        if not isinstance(history, list) or len(history) == 0:
            print(f"Job history: {job.get('id', tokens[1])}")
            print("- no runs yet")
            renderer.render_notice(f"History: {job.get('id', tokens[1])} (0 runs)")
            return

        print(f"Job history: {job.get('id', tokens[1])}")

        for entry in history[-8:]:
            if not isinstance(entry, dict):
                continue

            completed_at = entry.get("completed_at")
            status = entry.get("status")
            result = entry.get("result")

            if not isinstance(completed_at, str) or not isinstance(status, str):
                continue

            summary = str(result) if isinstance(result, str) and result else "(no result)"
            print(f"- {completed_at} [{status}] {summary}")

        renderer.render_notice(f"History: {job.get('id', tokens[1])} ({len(history)} runs)")
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
        last_run_at = job.get("last_run_at")
        last_status = job.get("last_status")
        last_result = job.get("last_result")
        history = job.get("history")

        if not isinstance(job_id, str) or not isinstance(schedule, str):
            continue

        status = "on" if enabled else "off"
        run_state = "never"

        if isinstance(last_run_at, str) and last_run_at:
            run_state = last_run_at

            if isinstance(last_status, str) and last_status:
                run_state = f"{last_status} @ {last_run_at}"

        if isinstance(last_result, str) and last_result:
            run_state = f"{run_state} -> {last_result}"

        history_count = len(history) if isinstance(history, list) else 0
        print(f"- {job_id} [{status}] {schedule} :: {run_state} ({history_count} runs)")

    renderer.render_notice(f"Jobs listed: {len(jobs)}")


def build_jobs_screen_state(jobs: list[dict[str, Any]]) -> ScreenState:
    if not jobs:
        return ScreenState(
            phase="Jobs",
            status="No scheduler jobs",
            answer="Create jobs via /api/jobs.",
        )

    lines: list[str] = []

    for job in jobs[:4]:
        job_id = job.get("id")
        schedule = job.get("schedule")
        enabled = job.get("enabled")
        last_status = job.get("last_status")
        last_result = job.get("last_result")

        if not isinstance(job_id, str) or not isinstance(schedule, str):
            continue

        marker = "on" if enabled else "off"
        summary = f"{job_id} [{marker}] {schedule}"

        if isinstance(last_status, str) and last_status:
            summary = f"{summary}\n{last_status}"

        if isinstance(last_result, str) and last_result:
            summary = f"{summary}: {last_result}"

        lines.append(summary)

    if len(jobs) > 4:
        lines.append(f"+{len(jobs) - 4} more")

    return ScreenState(
        phase="Jobs",
        status=f"{len(jobs)} scheduler job(s)",
        answer="\n".join(lines),
    )


def build_job_history_screen_state(job: dict[str, Any]) -> ScreenState:
    job_id = job.get("id")
    history = job.get("history")

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

    for entry in history[-4:]:
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

    return ScreenState(
        phase="Jobs",
        status=f"{job_id} history ({len(history)} runs)",
        prompt=job_id,
        answer="\n".join(lines) if lines else "No valid history entries.",
    )


def build_job_detail_screen_state(job: dict[str, Any]) -> ScreenState:
    job_id = job.get("id")
    schedule = job.get("schedule")
    enabled = job.get("enabled")
    last_run_at = job.get("last_run_at")
    last_status = job.get("last_status")
    last_result = job.get("last_result")
    history = job.get("history")

    if not isinstance(job_id, str) or not isinstance(schedule, str):
        raise RuntimeError("job response is invalid")

    state = "on" if enabled else "off"
    last_run_summary = "never"

    if isinstance(last_run_at, str) and last_run_at:
        last_run_summary = last_run_at

        if isinstance(last_status, str) and last_status:
            last_run_summary = f"{last_status} @ {last_run_at}"

        if isinstance(last_result, str) and last_result:
            last_run_summary = f"{last_run_summary} -> {last_result}"

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
        transcript=last_run_summary,
        answer="\n".join(history_lines),
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
) -> int:
    if refresh_seconds <= 0:
        renderer.render_notice("Jobs refresh must be greater than zero")
        return 1

    while True:
        try:
            job = find_job_entry(base_url, job_id)
            renderer.render(build_job_history_screen_state(job))
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
) -> int:
    if refresh_seconds <= 0:
        renderer.render_notice("Jobs refresh must be greater than zero")
        return 1

    while True:
        try:
            job = find_job_entry(base_url, job_id)
            renderer.render(build_job_detail_screen_state(job))
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


def stream_audio_talk(
    base_url: str,
    audio_id: str,
    workspace: Optional[str],
    skill: Optional[str],
    renderer: "ConsoleRenderer",
) -> ScreenState:
    state = ScreenState(
        phase="Transcribing",
        status="Uploading audio",
        transcript=audio_id,
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

    try:
        with urllib.request.urlopen(request) as response:
            for event_type, data in iter_sse_events(response):
                apply_stream_event(state, event_type, data)
                renderer.render(state)
    except urllib.error.URLError as error:
        state.phase = "Error"
        state.status = "Network failure"
        state.error = str(error)
        renderer.render(state)

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
        status="Uploading audio",
        transcript=audio_path,
    )
    renderer.render(state)

    try:
        audio_id = upload_audio_file(base_url, audio_path)
    except (OSError, RuntimeError, urllib.error.URLError) as error:
        state.phase = "Error"
        state.status = "Audio upload failed"
        state.error = str(error)
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
        self._font: Any = None
        self._width = WHISPLAY_DEFAULT_WIDTH
        self._height = WHISPLAY_DEFAULT_HEIGHT
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
        self._font = font_module.load_default()
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

    def render(self, state: ScreenState) -> None:
        if self._board is None:
            super().render(state)
            return

        image = self._image_module.new(
            "RGB",
            (self._width, self._height),
            WHISPLAY_BACKGROUND,
        )
        draw = self._draw_module.Draw(image)
        accent = get_phase_rgb(state.phase)

        draw.rectangle(
            (0, 0, self._width - 1, 28),
            fill=WHISPLAY_HEADER_BACKGROUND,
        )
        draw.text((10, 9), state.phase.upper(), fill=accent, font=self._font)

        cursor_y = 38

        for line in build_screen_lines(state, width=WHISPLAY_TEXT_WIDTH):
            if cursor_y >= self._height - 12:
                break

            draw.text((10, cursor_y), line, fill=WHISPLAY_FOREGROUND, font=self._font)
            cursor_y += 12

        try:
            self._board.set_rgb(*accent)
            self._board.draw_image(
                0,
                0,
                self._width,
                self._height,
                image_to_rgb565(image),
            )
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
        return

    if event_type == "stt":
        transcript = str(data.get("text") or "")
        state.phase = "Transcribing"
        state.status = "Captured transcript"
        state.transcript = transcript or state.transcript
        return

    if event_type == "tool":
        name = str(data.get("name") or "tool")
        detail = str(data.get("detail") or "").strip()
        state.phase = "Tool"
        state.status = "Running tool"
        state.tool_banner = f"{name}: {detail}" if detail else name
        return

    if event_type == "token":
        text = str(data.get("text") or "")
        state.phase = "Answer"
        state.status = "Streaming reply"
        state.tool_banner = None
        state.answer += text
        return

    if event_type == "done":
        summary = str(data.get("summary") or "Run finished")
        state.phase = "Idle"
        state.status = summary
        state.tool_banner = None
        return

    if event_type == "error":
        message = str(data.get("message") or "Unknown error")
        state.phase = "Error"
        state.status = "Run failed"
        state.tool_banner = None
        state.error = message


def build_prompt_state(prompt: str) -> ScreenState:
    return ScreenState(
        phase="Thinking",
        status="Connecting to dumplbotd",
        prompt=prompt,
    )


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

    try:
        with urllib.request.urlopen(request) as response:
            for event_type, data in iter_sse_events(response):
                apply_stream_event(state, event_type, data)
                renderer.render(state)
    except urllib.error.URLError as error:
        state.phase = "Error"
        state.status = "Network failure"
        state.error = str(error)
        renderer.render(state)


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
            and now - pressed_started_at >= BUTTON_LONG_PRESS_SECONDS
        ):
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
    parser = argparse.ArgumentParser(description="DumplBot device UI scaffold")
    parser.add_argument("--mock", action="store_true", help="Run the text-only mock client")
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
        "--jobs-refresh-seconds",
        type=float,
        default=5.0,
        help="Refresh interval for --jobs-screen",
    )
    parser.add_argument(
        "--job-history",
        help="Show one scheduler job history on the renderer and refresh continuously",
    )
    parser.add_argument(
        "--job-detail",
        help="Show one scheduler job detail screen on the renderer and refresh continuously",
    )
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
    parser.add_argument("--workspace", help="Workspace override for talk requests")
    parser.add_argument("--skill", help="Skill override for talk requests")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    renderer: ConsoleRenderer = ConsoleRenderer() if args.mock else WhisplayRenderer()
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
            )

        if args.job_detail is not None:
            return run_job_detail_screen(
                args.host_url,
                args.job_detail,
                renderer,
                args.jobs_refresh_seconds,
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
