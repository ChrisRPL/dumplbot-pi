#!/usr/bin/env python3

import argparse
from dataclasses import dataclass
import json
import sys
import textwrap
from typing import Any, Iterator, Optional
import urllib.error
import urllib.request

SCREEN_WIDTH = 48


@dataclass
class ScreenState:
    phase: str = "Idle"
    status: str = "Ready"
    prompt: str = ""
    transcript: Optional[str] = None
    tool_banner: Optional[str] = None
    answer: str = ""
    error: Optional[str] = None


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


def format_field(label: str, value: str) -> list[str]:
    prefix = f"{label}: " if label else ""
    width = max(8, SCREEN_WIDTH - len(prefix))
    wrapped = textwrap.wrap(value, width=width) or [""]
    lines = [f"{prefix}{wrapped[0]}"]
    indent = " " * len(prefix)

    for line in wrapped[1:]:
        lines.append(f"{indent}{line}")

    return lines


class ConsoleRenderer:
    def __init__(self, surface_name: str = "Mock UI") -> None:
        self.surface_name = surface_name
        self._interactive = sys.stdout.isatty()

    def render_notice(self, message: str) -> None:
        self.render(ScreenState(status=message))

    def render(self, state: ScreenState) -> None:
        lines = [
            f"{self.surface_name} | {state.phase}",
            f"Status: {state.status}",
        ]

        if state.prompt:
            lines.extend(format_field("Prompt", state.prompt))

        if state.transcript:
            lines.extend(format_field("Heard", state.transcript))

        if state.tool_banner:
            lines.extend(format_field("Tool", state.tool_banner))

        show_answer = bool(
            state.prompt
            or state.answer
            or state.phase in {"Thinking", "Transcribing", "Tool", "Answer", "Error"}
        )

        if show_answer:
            lines.append("Answer:")
            lines.extend(format_field("", state.answer or "(waiting for tokens)"))

        if state.error:
            lines.extend(format_field("Error", state.error))

        if self._interactive:
            sys.stdout.write("\033[2J\033[H")
        else:
            sys.stdout.write("\n")

        sys.stdout.write("\n".join(lines) + "\n")
        sys.stdout.flush()


class WhisplayRenderer(ConsoleRenderer):
    def __init__(self) -> None:
        super().__init__("Whisplay (console fallback)")


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
    workspace: str,
    skill: str,
    renderer: ConsoleRenderer,
) -> None:
    state = build_prompt_state(prompt)
    payload = {
        "text": prompt,
        "workspace": workspace,
        "skill": skill,
    }
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


def run_mock_loop(base_url: str, workspace: str, skill: str) -> None:
    renderer = ConsoleRenderer()
    print("DumplBot mock UI. Type a prompt, or 'exit' to quit.")

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

        stream_talk(base_url, prompt, workspace, skill, renderer)


def run_single_prompt(
    base_url: str,
    workspace: str,
    skill: str,
    prompt: str,
    renderer: ConsoleRenderer,
) -> int:
    cleaned_prompt = prompt.strip()

    if not cleaned_prompt:
        renderer.render_notice("Prompt must be non-empty")
        return 1

    stream_talk(base_url, cleaned_prompt, workspace, skill, renderer)
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="DumplBot device UI scaffold")
    parser.add_argument("--mock", action="store_true", help="Run the text-only mock client")
    parser.add_argument("--host-url", default="http://127.0.0.1:4123", help="Base URL for dumplbotd")
    parser.add_argument("--prompt", help="Run one prompt and exit")
    parser.add_argument("--workspace", default="default", help="Workspace to use for mock talk requests")
    parser.add_argument("--skill", default="coding", help="Skill to use for mock talk requests")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    renderer: ConsoleRenderer = ConsoleRenderer() if args.mock else WhisplayRenderer()

    if args.prompt is not None:
        return run_single_prompt(
            args.host_url,
            args.workspace,
            args.skill,
            args.prompt,
            renderer,
        )

    if args.mock:
        run_mock_loop(args.host_url, args.workspace, args.skill)
        return 0

    renderer.render_notice("Button loop not implemented yet. Use --prompt or --mock.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
