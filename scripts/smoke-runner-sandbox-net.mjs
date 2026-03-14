#!/usr/bin/env node

import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const HOST = "127.0.0.1";
const HOST_PORT = 4143;
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

const listen = async (server) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });

const closeServer = async (server) =>
  new Promise((resolve) => {
    server.close(() => resolve());
  });

const runSmoke = async () => {
  if (!supportsSandboxSmoke()) {
    console.log("runner sandbox net smoke skipped");
    return;
  }

  const tmpRoot = await mkdtemp(join(tmpdir(), "dumplbot-runner-sandbox-net-smoke-"));
  const workspaceRoot = join(tmpRoot, "workspaces");
  const skillsRoot = join(tmpRoot, "skills");
  const configPath = join(tmpRoot, "config.yaml");
  const defaultWorkspaceRoot = join(workspaceRoot, "default");
  const codingSkillRoot = join(skillsRoot, "coding");
  const networkCheckPath = join(defaultWorkspaceRoot, "network-check.mjs");
  const hostTcpServer = createServer();
  let connectionCount = 0;

  hostTcpServer.on("connection", (socket) => {
    connectionCount += 1;
    socket.end("ok");
  });

  await mkdir(defaultWorkspaceRoot, { recursive: true });
  await mkdir(codingSkillRoot, { recursive: true });
  await writeFile(join(defaultWorkspaceRoot, "CLAUDE.md"), "# default\n", "utf8");
  await writeFile(
    networkCheckPath,
    [
      'import { createConnection } from "node:net";',
      "",
      "const port = Number(process.argv[2] ?? 0);",
      'const socket = createConnection({ host: "127.0.0.1", port });',
      "const timeout = setTimeout(() => {",
      '  console.error("timeout");',
      "  socket.destroy();",
      "  process.exit(9);",
      "}, 2000);",
      "",
      'socket.on("connect", () => {',
      "  clearTimeout(timeout);",
      '  console.log("connected");',
      "  socket.end();",
      "});",
      "",
      'socket.on("error", (error) => {',
      "  clearTimeout(timeout);",
      '  console.error(error.code || error.message);',
      "  process.exit(7);",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  await writeFile(
    join(codingSkillRoot, "skill.yaml"),
    [
      "id: coding",
      "prompt_prelude: |",
      "  Sandbox network fixture.",
      "tool_allowlist:",
      "  - bash",
      "bash_prefix_allowlist:",
      `  - ${process.execPath} network-check.mjs`,
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

  await listen(hostTcpServer);
  const serverAddress = hostTcpServer.address();

  if (!serverAddress || typeof serverAddress === "string") {
    throw new Error("sandbox net smoke tcp server bind failed");
  }

  const hostServer = await startHostServer(
    tmpRoot,
    workspaceRoot,
    skillsRoot,
    configPath,
  );
  const baseUrl = `http://${HOST}:${HOST_PORT}`;

  try {
    const talkResponse = await fetch(`${baseUrl}/api/talk`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: `bash: ${process.execPath} network-check.mjs ${serverAddress.port}`,
        tools: ["bash"],
      }),
    });
    assert(talkResponse.status === 200, "expected sandbox net /api/talk to return 200 SSE");

    const events = parseSsePayload(await talkResponse.text());
    const errorEvent = events.find((event) => event.eventType === "error");
    const doneEvent = events.find((event) => event.eventType === "done");
    const tokenEvent = events.find((event) => event.eventType === "token");

    assert(errorEvent, "expected sandboxed network attempt to fail");
    assert(
      String(errorEvent.data?.message ?? "").includes("runner bash command failed"),
      "expected sandboxed network failure detail",
    );
    assert(!doneEvent, "unexpected done event for sandboxed network attempt");
    assert(!tokenEvent, "unexpected token event for sandboxed network attempt");
    assert(connectionCount === 0, "sandboxed network attempt should not reach host tcp server");

    console.log("runner sandbox net smoke ok");
  } finally {
    await stopHostServer(hostServer);
    await closeServer(hostTcpServer);
    await rm(tmpRoot, { recursive: true, force: true });
  }
};

runSmoke().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
