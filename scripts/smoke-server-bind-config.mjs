#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const LOOPBACK_HOST = "127.0.0.1";
const SERVER_PORT = 4146;

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

      if (text.includes(`dumplbotd listening on http://0.0.0.0:${SERVER_PORT}`)) {
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
  const tmpRoot = await mkdtemp(join(tmpdir(), "dumplbot-server-bind-smoke-"));
  const workspaceRoot = join(tmpRoot, "workspaces");
  const configPath = join(tmpRoot, "config.yaml");

  await writeFile(
    configPath,
    [
      "server:",
      "  host: 0.0.0.0",
      `  port: ${SERVER_PORT}`,
      "",
      "runtime:",
      "  default_workspace: default",
      "  default_skill: coding",
      "  permission_mode: balanced",
      "",
    ].join("\n"),
    "utf8",
  );

  const childProcess = spawn(
    process.execPath,
    ["dist/apps/host/src/main.js"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        DUMPLBOT_TMP_ROOT: tmpRoot,
        DUMPLBOT_WORKSPACES_ROOT: workspaceRoot,
        DUMPLBOT_CONFIG_PATH: configPath,
        DUMPLBOT_SANDBOX_ENABLED: "false",
      },
    },
  );

  try {
    await waitForServerReady(childProcess);
    const response = await fetch(`http://${LOOPBACK_HOST}:${SERVER_PORT}/health`);
    assert(response.status === 200, "expected configured server port to answer /health");
    const payload = await response.json();
    assert(payload.ok === true, "expected health payload ok=true");
    console.log("server bind config smoke ok");
  } finally {
    await stopHostServer(childProcess);
    await rm(tmpRoot, { recursive: true, force: true });
  }
};

runSmoke().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
