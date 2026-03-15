#!/usr/bin/env node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const HOST = "127.0.0.1";
const HOST_PORT = 4142;

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const waitForServerReady = (childProcess) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("host server did not start in time"));
    }, 8000);

    const onData = (chunk) => {
      const text = chunk.toString("utf8");

      if (text.includes("dumplbotd listening")) {
        clearTimeout(timeout);
        childProcess.stdout.off("data", onData);
        resolve();
      }
    };

    childProcess.stdout.on("data", onData);
    childProcess.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`host server exited early: ${code ?? "unknown"}`));
    });
  });

const startHostServer = async (
  tmpRoot,
  workspaceRoot,
  skillsRoot,
  runnerEntryPointPath,
) => {
  const childProcess = spawn(
    process.execPath,
    ["dist/apps/host/src/main.js"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        DUMPLBOT_HOST: HOST,
        DUMPLBOT_PORT: String(HOST_PORT),
        DUMPLBOT_TMP_ROOT: tmpRoot,
        DUMPLBOT_WORKSPACES_ROOT: workspaceRoot,
        DUMPLBOT_SKILLS_ROOT: skillsRoot,
        DUMPLBOT_SANDBOX_ENABLED: "false",
        DUMPLBOT_MAX_RUN_SECONDS: "30",
        DUMPLBOT_RUNNER_ENTRYPOINT: runnerEntryPointPath,
      },
    },
  );

  await waitForServerReady(childProcess);
  return childProcess;
};

const stopHostServer = async (childProcess) => {
  if (childProcess.exitCode !== null) {
    return;
  }

  childProcess.kill("SIGINT");
  await new Promise((resolve) => {
    childProcess.once("exit", resolve);
    setTimeout(() => resolve(), 3000);
  });
};

const runSmoke = async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), "dumplbot-ui-run-cancel-smoke-"));
  const workspaceRoot = join(tmpRoot, "workspaces");
  const skillsRoot = join(tmpRoot, "skills");
  const runnerEntryPointPath = join(tmpRoot, "slow-runner.js");
  const pythonHarnessPath = join(tmpRoot, "ui-cancel-harness.py");
  const defaultWorkspaceRoot = join(workspaceRoot, "default");
  const codingSkillRoot = join(skillsRoot, "coding");

  await mkdir(defaultWorkspaceRoot, { recursive: true });
  await mkdir(codingSkillRoot, { recursive: true });
  await writeFile(join(defaultWorkspaceRoot, "CLAUDE.md"), "# default\n", "utf8");
  await writeFile(
    join(codingSkillRoot, "skill.yaml"),
    [
      "id: coding",
      "prompt_prelude: |",
      "  UI cancel smoke fixture.",
      "tool_allowlist:",
      "  - read_file",
      "permission_mode: balanced",
      "model:",
      "  reasoning: medium",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    runnerEntryPointPath,
    [
      "const readAll = async () => {",
      "  for await (const _ of process.stdin) {",
      "    // consume input",
      "  }",
      "};",
      "",
      "void readAll().then(() => {",
      "  process.stdout.write(JSON.stringify({ type: 'status', message: 'waiting for ui cancel smoke' }) + '\\\\n');",
      "  setInterval(() => {}, 1000);",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    pythonHarnessPath,
    [
      "import json",
      "import sys",
      "import time",
      "",
      "from apps.ui.dumpl_ui import ScreenState, stream_talk",
      "",
      "class FakeRenderer:",
      "    def __init__(self):",
      "        self.started_at = time.monotonic()",
      "        self.last_state = {}",
      "        self.saw_canceling = False",
      "",
      "    def render(self, state):",
      "        self.last_state = {",
      "            'phase': state.phase,",
      "            'status': state.status,",
      "            'error': state.error,",
      "            'visual_kind': state.visual.get('kind') if isinstance(state.visual, dict) else None,",
      "        }",
      "        if state.status == 'Canceling run':",
      "            self.saw_canceling = True",
      "",
      "    def poll_button_pressed(self):",
      "        return (time.monotonic() - self.started_at) < 1.6",
      "",
      "    def render_notice(self, message):",
      "        self.render(ScreenState(status=message))",
      "",
      "    def close(self):",
      "        return",
      "",
      "renderer = FakeRenderer()",
      "stream_talk(sys.argv[1], 'ping', None, None, renderer)",
      "print(json.dumps({",
      "    'saw_canceling': renderer.saw_canceling,",
      "    'last_state': renderer.last_state,",
      "}))",
      "",
    ].join("\n"),
    "utf8",
  );

  const hostServer = await startHostServer(
    tmpRoot,
    workspaceRoot,
    skillsRoot,
    runnerEntryPointPath,
  );
  const baseUrl = `http://${HOST}:${HOST_PORT}`;

  try {
    const result = spawnSync(
      "python3",
      [pythonHarnessPath, baseUrl],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PYTHONPATH: process.cwd(),
        },
        encoding: "utf8",
      },
    );

    if (result.error) {
      throw result.error;
    }

    assert(
      result.status === 0,
      `expected python ui cancel harness to return 0 (stdout: ${result.stdout.trim()} stderr: ${result.stderr.trim()})`,
    );
    const payload = JSON.parse(result.stdout.trim());
    assert(payload.saw_canceling === true, "expected ui to render canceling state");
    assert(payload.last_state?.phase === "Error", "expected canceled ui phase to be Error");
    assert(payload.last_state?.status === "Run failed", "expected canceled ui status");
    assert(payload.last_state?.error === "run canceled", "expected canceled ui error message");

    console.log("ui run cancel smoke ok");
  } finally {
    await stopHostServer(hostServer);
    await rm(tmpRoot, { recursive: true, force: true });
  }
};

runSmoke().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
