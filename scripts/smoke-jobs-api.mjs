#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const HOST = "127.0.0.1";
const HOST_PORT = 4136;

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

const startHostServer = async (tmpRoot, workspaceRoot, configPath, jobsPath) => {
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
  const tmpRoot = await mkdtemp(join(tmpdir(), "dumplbot-jobs-api-smoke-"));
  const workspaceRoot = join(tmpRoot, "workspaces");
  const configPath = join(tmpRoot, "config.yaml");
  const jobsPath = join(tmpRoot, "scheduler", "jobs.json");
  const defaultWorkspacePath = join(workspaceRoot, "default");

  await mkdir(defaultWorkspacePath, { recursive: true });
  await writeFile(join(defaultWorkspacePath, "CLAUDE.md"), "# default\n", "utf8");
  await writeFile(
    configPath,
    "runtime:\n  default_workspace: default\n  default_skill: coding\n",
    "utf8",
  );

  const hostServer = await startHostServer(tmpRoot, workspaceRoot, configPath, jobsPath);
  const baseUrl = `http://${HOST}:${HOST_PORT}`;

  try {
    const initialListResponse = await fetch(`${baseUrl}/api/jobs`);
    assert(initialListResponse.status === 200, "expected initial GET /api/jobs to return 200");
    const initialListPayload = await initialListResponse.json();
    assert(Array.isArray(initialListPayload.jobs), "expected jobs array");
    assert(initialListPayload.jobs.length === 0, "expected initial jobs list to be empty");

    const createJobResponse = await fetch(`${baseUrl}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "daily-status",
        prompt: "summarize repo state",
        schedule: "0 * * * *",
        workspace: "default",
        skill: "coding",
      }),
    });
    assert(createJobResponse.status === 200, "expected POST /api/jobs to return 200");
    const createJobPayload = await createJobResponse.json();
    assert(createJobPayload.id === "daily-status", "unexpected created job id");
    assert(createJobPayload.enabled === true, "expected enabled default to be true");
    assert(createJobPayload.workspace === "default", "unexpected created job workspace");
    assert(createJobPayload.skill === "coding", "unexpected created job skill");
    assert(createJobPayload.last_run_at === null, "expected empty last_run_at");
    assert(createJobPayload.last_status === null, "expected empty last_status");
    assert(createJobPayload.last_result === null, "expected empty last_result");

    const jobsFilePayload = JSON.parse(await readFile(jobsPath, "utf8"));
    assert(Array.isArray(jobsFilePayload.jobs), "expected jobs file to contain jobs array");
    assert(jobsFilePayload.jobs.length === 1, "expected one persisted job");

    const updateJobResponse = await fetch(`${baseUrl}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "daily-status",
        prompt: "summarize repo and tests",
        schedule: "30 * * * *",
        workspace: null,
        skill: "research",
        enabled: false,
      }),
    });
    assert(updateJobResponse.status === 200, "expected job update to return 200");
    const updateJobPayload = await updateJobResponse.json();
    assert(updateJobPayload.prompt === "summarize repo and tests", "expected updated prompt");
    assert(updateJobPayload.schedule === "30 * * * *", "expected updated schedule");
    assert(updateJobPayload.workspace === null, "expected cleared workspace");
    assert(updateJobPayload.skill === "research", "expected updated skill");
    assert(updateJobPayload.enabled === false, "expected updated enabled flag");
    assert(updateJobPayload.last_status === null, "expected last_status to remain empty after update");

    const listedJobsResponse = await fetch(`${baseUrl}/api/jobs`);
    assert(listedJobsResponse.status === 200, "expected GET /api/jobs after upsert");
    const listedJobsPayload = await listedJobsResponse.json();
    assert(listedJobsPayload.jobs.length === 1, "expected single job after update");
    assert(listedJobsPayload.jobs[0]?.schedule === "30 * * * *", "expected updated job in list");

    const missingWorkspaceResponse = await fetch(`${baseUrl}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "broken-workspace",
        prompt: "ping",
        schedule: "* * * * *",
        workspace: "missing",
      }),
    });
    assert(missingWorkspaceResponse.status === 404, "expected missing workspace to return 404");

    const missingSkillResponse = await fetch(`${baseUrl}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "broken-skill",
        prompt: "ping",
        schedule: "* * * * *",
        skill: "missing-skill",
      }),
    });
    assert(missingSkillResponse.status === 404, "expected missing skill to return 404");

    console.log("jobs api smoke ok");
  } finally {
    await stopHostServer(hostServer);
    await rm(tmpRoot, { recursive: true, force: true });
  }
};

runSmoke().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
