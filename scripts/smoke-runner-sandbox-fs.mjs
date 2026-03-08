#!/usr/bin/env node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const HOST = "127.0.0.1";
const HOST_PORT = 4142;
const SSE_DELIMITER = "\n\n";

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const supportsSandboxSmoke = () => {
  if (process.platform !== "linux") {
    return false;
  }

  const result = spawnSync("bwrap", ["--version"], { stdio: "ignore" });
  return !result.error;
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
  configPath,
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
        DUMPLBOT_CONFIG_PATH: configPath,
        DUMPLBOT_SANDBOX_ENABLED: "true",
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
  if (!supportsSandboxSmoke()) {
    console.log("runner sandbox fs smoke skipped");
    return;
  }

  const tmpRoot = await mkdtemp(join(tmpdir(), "dumplbot-runner-sandbox-fs-smoke-"));
  const workspaceRoot = join(tmpRoot, "workspaces");
  const skillsRoot = join(tmpRoot, "skills");
  const configPath = join(tmpRoot, "config.yaml");
  const runnerEntryPointPath = join(tmpRoot, "sandbox-fs-runner.js");
  const defaultWorkspaceRoot = join(workspaceRoot, "default");
  const insideFilePath = join(defaultWorkspaceRoot, "inside.txt");
  const outsideFilePath = join(tmpRoot, "outside.txt");
  const codingSkillRoot = join(skillsRoot, "coding");

  await mkdir(defaultWorkspaceRoot, { recursive: true });
  await mkdir(codingSkillRoot, { recursive: true });
  await writeFile(join(defaultWorkspaceRoot, "CLAUDE.md"), "# default\n", "utf8");
  await writeFile(insideFilePath, "inside\n", "utf8");
  await writeFile(outsideFilePath, "outside\n", "utf8");
  await writeFile(
    join(codingSkillRoot, "skill.yaml"),
    [
      "id: coding",
      "prompt_prelude: |",
      "  Sandbox filesystem fixture.",
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
    configPath,
    [
      "runtime:",
      "  default_workspace: default",
      "  default_skill: coding",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    runnerEntryPointPath,
    [
      "const fs = require('node:fs');",
      "",
      "const writeEvent = (event) => {",
      "  process.stdout.write(JSON.stringify(event) + '\\n');",
      "};",
      "",
      "const main = async () => {",
      "  for await (const _chunk of process.stdin) {",
      "    // consume input",
      "  }",
      "",
      `  const insideFilePath = ${JSON.stringify(insideFilePath)};`,
      `  const outsideFilePath = ${JSON.stringify(outsideFilePath)};`,
      "",
      "  try {",
      "    const insideText = fs.readFileSync(insideFilePath, 'utf8').trim();",
      "    if (insideText !== 'inside') {",
      "      writeEvent({ type: 'error', message: 'inside workspace file unreadable' });",
      "      process.exitCode = 1;",
      "      return;",
      "    }",
      "  } catch (error) {",
      "    writeEvent({ type: 'error', message: `inside workspace read failed: ${error.message}` });",
      "    process.exitCode = 1;",
      "    return;",
      "  }",
      "",
      "  try {",
      "    fs.readFileSync(outsideFilePath, 'utf8');",
      "    writeEvent({ type: 'error', message: 'outside workspace file unexpectedly readable' });",
      "    process.exitCode = 1;",
      "    return;",
      "  } catch {",
      "    writeEvent({ type: 'status', message: 'Sandbox filesystem isolation confirmed' });",
      "    writeEvent({ type: 'done', summary: 'sandbox fs ok' });",
      "  }",
      "};",
      "",
      "void main();",
      "",
    ].join("\n"),
    "utf8",
  );

  const hostServer = await startHostServer(
    tmpRoot,
    workspaceRoot,
    skillsRoot,
    configPath,
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

    const events = parseSsePayload(await talkResponse.text());
    const statusEvent = events.find((event) =>
      event.eventType === "status"
      && event.data?.message === "Sandbox filesystem isolation confirmed");
    const doneEvent = events.find((event) => event.eventType === "done");
    const errorEvent = events.find((event) => event.eventType === "error");

    assert(statusEvent, "expected sandbox filesystem confirmation status");
    assert(doneEvent?.data?.summary === "sandbox fs ok", "expected sandbox filesystem done event");
    assert(!errorEvent, "unexpected error event for sandbox filesystem smoke");

    console.log("runner sandbox fs smoke ok");
  } finally {
    await stopHostServer(hostServer);
    await rm(tmpRoot, { recursive: true, force: true });
  }
};

runSmoke().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
