#!/usr/bin/env python3

import argparse
import json
import sys
from typing import Any, Iterator
import urllib.error
import urllib.request


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


def emit_raw_event(event_type: str, data: dict[str, Any]) -> None:
    print(f"[{event_type}] {json.dumps(data)}")


def stream_talk(base_url: str, prompt: str, workspace: str, skill: str) -> None:
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

    try:
        with urllib.request.urlopen(request) as response:
            for event_type, data in iter_sse_events(response):
                emit_raw_event(event_type, data)
    except urllib.error.URLError as error:
        print(f"[error] {error}", file=sys.stderr)


def run_mock_loop(base_url: str, workspace: str, skill: str) -> None:
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

        stream_talk(base_url, prompt, workspace, skill)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="DumplBot device UI scaffold")
    parser.add_argument("--mock", action="store_true", help="Run the text-only mock client")
    parser.add_argument("--host-url", default="http://127.0.0.1:4123", help="Base URL for dumplbotd")
    parser.add_argument("--workspace", default="default", help="Workspace to use for mock talk requests")
    parser.add_argument("--skill", default="coding", help="Skill to use for mock talk requests")
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if args.mock:
        run_mock_loop(args.host_url, args.workspace, args.skill)
        return 0

    print("Whisplay mode is not implemented yet. Use --mock for now.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
