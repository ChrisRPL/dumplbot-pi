#!/usr/bin/env node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const HOST = "127.0.0.1";
const HOST_PORT = 4141;
const SSE_DELIMITER = "\n\n";

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const parseSsePayload = (payload) =>
  payload
    .split(SSE_DELIMITER)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      let eventType = "message";
      let data = {};

      for (const line of chunk.split("\n")) {
        if (line.startsWith("event: ")) {
          eventType = line.slice("event: ".length);
        } else if (line.startsWith("data: ")) {
          data = JSON.parse(line.slice("data: ".length));
        }
      }

      return { eventType, data };
    });

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
  const tmpRoot = await mkdtemp(join(tmpdir(), "dumplbot-run-cancel-smoke-"));
  const workspaceRoot = join(tmpRoot, "workspaces");
  const skillsRoot = join(tmpRoot, "skills");
  const runnerEntryPointPath = join(tmpRoot, "slow-runner.js");
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
      "  Cancel smoke fixture.",
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
      "  process.stdout.write(JSON.stringify({ type: 'status', message: 'waiting for cancel smoke' }) + '\\\\n');",
      "  setInterval(() => {}, 1000);",
      "});",
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
    const talkResponse = await fetch(`${baseUrl}/api/talk`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "ping" }),
    });
    assert(talkResponse.status === 200, "expected /api/talk to return 200 SSE");

    const runId = talkResponse.headers.get("x-dumplbot-run-id");
    assert(typeof runId === "string" && runId.length > 0, "expected x-dumplbot-run-id header");

    await new Promise((resolve) => setTimeout(resolve, 150));

    const cancelResponse = await fetch(`${baseUrl}/api/runs/${runId}/cancel`, {
      method: "POST",
    });
    assert(cancelResponse.status === 202, "expected cancel route to return 202");
    const cancelJson = await cancelResponse.json();
    assert(cancelJson.run_id === runId, "unexpected canceled run id");
    assert(cancelJson.status === "cancel_requested", "unexpected cancel response status");

    const events = parseSsePayload(await talkResponse.text());
    const errorEvents = events.filter((event) => event.eventType === "error");
    const doneEvents = events.filter((event) => event.eventType === "done");

    assert(errorEvents.length === 1, "expected one canceled error event");
    assert(
      errorEvents[0].data?.message === "run canceled",
      `expected canceled run error message, got ${JSON.stringify(errorEvents[0]?.data)}`,
    );
    assert(doneEvents.length === 0, "expected no done event after cancel");

    const repeatCancelResponse = await fetch(`${baseUrl}/api/runs/${runId}/cancel`, {
      method: "POST",
    });
    assert(repeatCancelResponse.status === 404, "expected second cancel to return 404");

    console.log("run cancel smoke ok");
  } finally {
    await stopHostServer(hostServer);
    await rm(tmpRoot, { recursive: true, force: true });
  }
};

runSmoke().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
