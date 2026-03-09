#!/usr/bin/env node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const HOST = "127.0.0.1";
const HOST_PORT = 4137;

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const sleep = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
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

const startHostProcess = async (tmpRoot, workspaceRoot, configPath, jobsPath) => {
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
        DUMPLBOT_CONFIG_PATH: configPath,
        DUMPLBOT_JOBS_PATH: jobsPath,
        DUMPLBOT_SANDBOX_ENABLED: "false",
      },
    },
  );

  await waitForServerReady(childProcess);
  return childProcess;
};

const stopHostProcess = async (childProcess) => {
  if (childProcess.exitCode !== null) {
    return;
  }

  childProcess.kill("SIGINT");
  await new Promise((resolve) => {
    childProcess.once("exit", resolve);
    setTimeout(() => resolve(), 3000);
  });
};

const waitForJobRun = async (baseUrl, jobId) => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 7000) {
    const response = await fetch(`${baseUrl}/api/jobs`);
    const payload = await response.json();
    const job = payload.jobs.find((entry) => entry.id === jobId);

    if (job?.last_run_at && job?.last_status) {
      return job;
    }

    await sleep(250);
  }

  throw new Error("scheduler job did not record a run in time");
};

const runSmoke = async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), "dumplbot-scheduler-runtime-smoke-"));
  const workspaceRoot = join(tmpRoot, "workspaces");
  const configPath = join(tmpRoot, "config.yaml");
  const jobsPath = join(tmpRoot, "scheduler", "jobs.json");
  const defaultWorkspacePath = join(workspaceRoot, "default");

  await mkdir(defaultWorkspacePath, { recursive: true });
  await writeFile(join(defaultWorkspacePath, "CLAUDE.md"), "# default\n", "utf8");
  await writeFile(
    configPath,
    [
      "runtime:",
      "  default_workspace: default",
      "  default_skill: coding",
      "scheduler:",
      "  enabled: true",
      "  store: file",
      "  poll_interval_seconds: 1",
      "",
    ].join("\n"),
    "utf8",
  );

  const hostProcess = await startHostProcess(tmpRoot, workspaceRoot, configPath, jobsPath);
  const baseUrl = `http://${HOST}:${HOST_PORT}`;

  try {
    const createJobResponse = await fetch(`${baseUrl}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "scheduler-ping",
        prompt: "ping",
        schedule: "* * * * *",
        workspace: "default",
        skill: "coding",
      }),
    });
    assert(createJobResponse.status === 200, "expected scheduler job create to return 200");

    const job = await waitForJobRun(baseUrl, "scheduler-ping");
    assert(job.last_status === "success", "expected successful scheduler run");
    assert(typeof job.last_result === "string" && job.last_result.length > 0, "expected scheduler result text");
    assert(Array.isArray(job.history), "expected scheduler job history array");
    assert(job.history.length === 1, "expected single scheduler history entry");
    assert(job.history[0]?.status === "success", "expected scheduler history status");

    console.log("scheduler runtime smoke ok");
  } finally {
    await stopHostProcess(hostProcess);
    await rm(tmpRoot, { recursive: true, force: true });
  }
};

runSmoke().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
