#!/usr/bin/env node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const HOST = "127.0.0.1";
const HOST_PORT = 4143;
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

const startHostServer = async (tmpRoot, workspaceRoot, skillsRoot, configPath) => {
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
        DUMPLBOT_SANDBOX_ENABLED: "false",
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
  const tmpRoot = await mkdtemp(join(tmpdir(), "dumplbot-bash-tool-exec-smoke-"));
  const workspaceRoot = join(tmpRoot, "workspaces");
  const skillsRoot = join(tmpRoot, "skills");
  const configPath = join(tmpRoot, "config.yaml");
  const defaultWorkspaceRoot = join(workspaceRoot, "default");
  const codingSkillRoot = join(skillsRoot, "coding");

  await mkdir(defaultWorkspaceRoot, { recursive: true });
  await mkdir(codingSkillRoot, { recursive: true });
  await writeFile(join(defaultWorkspaceRoot, "CLAUDE.md"), "# default\n", "utf8");
  await writeFile(join(defaultWorkspaceRoot, "note.txt"), "hello from host bash\n", "utf8");
  await writeFile(
    join(codingSkillRoot, "skill.yaml"),
    [
      "id: coding",
      "prompt_prelude: |",
      "  Bash execution fixture.",
      "tool_allowlist:",
      "  - bash",
      "bash_prefix_allowlist:",
      "  - cat",
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

  const hostServer = await startHostServer(tmpRoot, workspaceRoot, skillsRoot, configPath);
  const baseUrl = `http://${HOST}:${HOST_PORT}`;

  try {
    const talkResponse = await fetch(`${baseUrl}/api/talk`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "bash: cat note.txt",
        tools: ["bash"],
      }),
    });
    assert(talkResponse.status === 200, "expected /api/talk to return 200");

    const events = parseSsePayload(await talkResponse.text());
    const bashToolEvent = events.find(
      (event) => event.eventType === "tool" && event.data?.name === "bash",
    );
    const tokenEvent = events.find((event) => event.eventType === "token");
    const doneEvent = events.find((event) => event.eventType === "done");
    const errorEvent = events.find((event) => event.eventType === "error");

    assert(
      bashToolEvent?.data?.detail === "cat note.txt",
      "expected bash tool detail in SSE stream",
    );
    assert(
      tokenEvent?.data?.text === "hello from host bash",
      "expected command output token in SSE stream",
    );
    assert(
      doneEvent?.data?.summary === "Bash tool completed.",
      "expected bash completion summary in SSE stream",
    );
    assert(!errorEvent, "unexpected error event for bash execution");

    console.log("bash tool execution smoke ok");
  } finally {
    await stopHostServer(hostServer);
    await rm(tmpRoot, { recursive: true, force: true });
  }
};

runSmoke().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
