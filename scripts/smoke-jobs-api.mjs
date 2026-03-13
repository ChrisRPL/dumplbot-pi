#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

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

const runUiCommand = (baseUrl, ...args) => {
  const result = spawnSync(
    "python3",
    ["apps/ui/dumpl_ui.py", "--mock", "--host-url", baseUrl, ...args],
    {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
      timeout: 8000,
    },
  );

  if (result.error) {
    throw result.error;
  }

  return result;
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
    assert(createJobPayload.last_duration_ms === null, "expected empty last_duration_ms");
    assert(createJobPayload.last_error === null, "expected empty last_error");
    assert(createJobPayload.failure_count === 0, "expected empty failure_count");
    assert(createJobPayload.last_success_at === null, "expected empty last_success_at");
    assert(Array.isArray(createJobPayload.history), "expected empty history array");
    assert(createJobPayload.history.length === 0, "expected no history entries");

    const jobsFilePayload = JSON.parse(await readFile(jobsPath, "utf8"));
    assert(Array.isArray(jobsFilePayload.jobs), "expected jobs file to contain jobs array");
    assert(jobsFilePayload.jobs.length === 1, "expected one persisted job");

    const patchJobResponse = await fetch(`${baseUrl}/api/jobs/daily-status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "summarize repo state via patch",
        schedule: "45 * * * *",
      }),
    });
    assert(patchJobResponse.status === 200, "expected PATCH /api/jobs/:id to return 200");
    const patchJobPayload = await patchJobResponse.json();
    assert(patchJobPayload.prompt === "summarize repo state via patch", "expected patched prompt");
    assert(patchJobPayload.schedule === "45 * * * *", "expected patched schedule");
    assert(patchJobPayload.workspace === "default", "expected patch to preserve workspace");

    const emptyPatchResponse = await fetch(`${baseUrl}/api/jobs/daily-status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert(emptyPatchResponse.status === 400, "expected empty PATCH /api/jobs/:id to return 400");

    const hourlyJobResponse = await fetch(`${baseUrl}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "hourly-status",
        prompt: "hourly ping",
        schedule: "hourly",
      }),
    });
    assert(hourlyJobResponse.status === 200, "expected hourly preset to return 200");
    const hourlyJobPayload = await hourlyJobResponse.json();
    assert(hourlyJobPayload.schedule === "0 * * * *", "expected hourly preset normalization");

    const dailyJobResponse = await fetch(`${baseUrl}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "daily-status",
        prompt: "daily ping",
        schedule: "daily 09:15",
      }),
    });
    assert(dailyJobResponse.status === 200, "expected daily preset to return 200");
    const dailyJobPayload = await dailyJobResponse.json();
    assert(dailyJobPayload.schedule === "15 9 * * *", "expected daily preset normalization");

    const weeklyJobResponse = await fetch(`${baseUrl}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "weekly-status",
        prompt: "weekly ping",
        schedule: "weekly mon 08:30",
      }),
    });
    assert(weeklyJobResponse.status === 200, "expected weekly preset to return 200");
    const weeklyJobPayload = await weeklyJobResponse.json();
    assert(weeklyJobPayload.schedule === "30 8 * * 1", "expected weekly preset normalization");

    const naturalHourlyJobResponse = await fetch(`${baseUrl}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "hourly-status",
        prompt: "hourly phrase ping",
        schedule: "every hour",
      }),
    });
    assert(naturalHourlyJobResponse.status === 200, "expected hourly phrase to return 200");
    const naturalHourlyJobPayload = await naturalHourlyJobResponse.json();
    assert(naturalHourlyJobPayload.schedule === "0 * * * *", "expected hourly phrase normalization");

    const naturalDailyJobResponse = await fetch(`${baseUrl}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "daily-status",
        prompt: "daily phrase ping",
        schedule: "every day at 09:15",
      }),
    });
    assert(naturalDailyJobResponse.status === 200, "expected daily phrase to return 200");
    const naturalDailyJobPayload = await naturalDailyJobResponse.json();
    assert(naturalDailyJobPayload.schedule === "15 9 * * *", "expected daily phrase normalization");

    const naturalWeeklyJobResponse = await fetch(`${baseUrl}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "weekly-status",
        prompt: "weekly phrase ping",
        schedule: "every monday at 08:30",
      }),
    });
    assert(naturalWeeklyJobResponse.status === 200, "expected weekly phrase to return 200");
    const naturalWeeklyJobPayload = await naturalWeeklyJobResponse.json();
    assert(naturalWeeklyJobPayload.schedule === "30 8 * * 1", "expected weekly phrase normalization");

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
    assert(updateJobPayload.last_duration_ms === null, "expected last_duration_ms to remain empty after update");
    assert(updateJobPayload.last_error === null, "expected last_error to remain empty after update");
    assert(updateJobPayload.failure_count === 0, "expected failure_count to remain empty after update");
    assert(updateJobPayload.last_success_at === null, "expected last_success_at to remain empty after update");
    assert(Array.isArray(updateJobPayload.history), "expected update to include history array");
    assert(updateJobPayload.history.length === 0, "expected no history entries after update");

    const listedJobsResponse = await fetch(`${baseUrl}/api/jobs`);
    assert(listedJobsResponse.status === 200, "expected GET /api/jobs after upsert");
    const listedJobsPayload = await listedJobsResponse.json();
    assert(listedJobsPayload.jobs.length === 3, "expected three jobs after preset coverage");
    const updatedJob = listedJobsPayload.jobs.find((job) => job.id === "daily-status");
    assert(updatedJob?.schedule === "30 * * * *", "expected updated job in list");
    assert(Array.isArray(updatedJob?.history), "expected listed job history array");
    assert(updatedJob?.history.length === 0, "expected listed job to have empty history");

    const detailJobResponse = await fetch(`${baseUrl}/api/jobs/daily-status`);
    assert(detailJobResponse.status === 200, "expected job detail to return 200");
    const detailJobPayload = await detailJobResponse.json();
    assert(detailJobPayload.id === "daily-status", "expected job detail id");
    assert(detailJobPayload.schedule === "30 * * * *", "expected job detail schedule");
    assert(detailJobPayload.last_duration_ms === null, "expected empty job detail duration");
    assert(detailJobPayload.last_error === null, "expected empty job detail error");
    assert(detailJobPayload.failure_count === 0, "expected empty job detail failure count");
    assert(detailJobPayload.last_success_at === null, "expected empty job detail last success");

    const schedulerNavScreenResult = runUiCommand(
      baseUrl,
      "--scheduler-nav-mode",
      "summary",
      "--scheduler-nav-action",
      "next-screen",
    );
    assert(schedulerNavScreenResult.status === 0, "expected scheduler nav next-screen to return 0");
    assert(
      schedulerNavScreenResult.stdout.includes("daily-status [off]"),
      "expected scheduler nav next-screen to show first job detail",
    );

    const schedulerNavJobResult = runUiCommand(
      baseUrl,
      "--scheduler-nav-mode",
      "detail",
      "--scheduler-nav-job",
      "daily-status",
      "--scheduler-nav-action",
      "next-job",
    );
    assert(schedulerNavJobResult.status === 0, "expected scheduler nav next-job to return 0");
    assert(
      schedulerNavJobResult.stdout.includes("hourly-status [on]"),
      "expected scheduler nav next-job to cycle to the next job",
    );

    const emptyHistoryResponse = await fetch(`${baseUrl}/api/jobs/daily-status/history`);
    assert(emptyHistoryResponse.status === 200, "expected empty job history to return 200");
    const emptyHistoryPayload = await emptyHistoryResponse.json();
    assert(emptyHistoryPayload.job_id === "daily-status", "expected job history id");
    assert(emptyHistoryPayload.total === 0, "expected empty job history total");
    assert(emptyHistoryPayload.returned === 0, "expected empty job history returned");
    assert(Array.isArray(emptyHistoryPayload.history), "expected job history array");
    assert(emptyHistoryPayload.history.length === 0, "expected empty job history entries");

    const seededJobsFilePayload = JSON.parse(await readFile(jobsPath, "utf8"));
    const seededDailyJob = seededJobsFilePayload.jobs.find((job) => job.id === "daily-status");
    assert(seededDailyJob, "expected seeded daily-status job");
    seededDailyJob.history = [
      { completed_at: "2026-03-12T08:00:00.000Z", status: "success", result: "run 1" },
      { completed_at: "2026-03-12T09:00:00.000Z", status: "error", result: "run 2" },
      { completed_at: "2026-03-12T10:00:00.000Z", status: "success", result: "run 3" },
      { completed_at: "2026-03-12T11:00:00.000Z", status: "success", result: "run 4" },
      { completed_at: "2026-03-12T12:00:00.000Z", status: "error", result: "run 5" },
    ];
    await writeFile(jobsPath, `${JSON.stringify(seededJobsFilePayload, null, 2)}\n`, "utf8");

    const pagedHistoryResponse = await fetch(`${baseUrl}/api/jobs/daily-status/history?limit=2&offset=1`);
    assert(pagedHistoryResponse.status === 200, "expected paged job history to return 200");
    const pagedHistoryPayload = await pagedHistoryResponse.json();
    assert(pagedHistoryPayload.total === 5, "expected paged job history total");
    assert(pagedHistoryPayload.returned === 2, "expected paged job history returned");
    assert(pagedHistoryPayload.history[0]?.result === "run 3", "expected paged job history window start");
    assert(pagedHistoryPayload.history[1]?.result === "run 4", "expected paged job history window end");

    const overflowHistoryResponse = await fetch(`${baseUrl}/api/jobs/daily-status/history?limit=2&offset=9`);
    assert(overflowHistoryResponse.status === 200, "expected overflow job history to return 200");
    const overflowHistoryPayload = await overflowHistoryResponse.json();
    assert(overflowHistoryPayload.total === 5, "expected overflow job history total");
    assert(overflowHistoryPayload.returned === 0, "expected overflow job history returned");
    assert(Array.isArray(overflowHistoryPayload.history) && overflowHistoryPayload.history.length === 0, "expected overflow job history to be empty");

    const invalidHistoryLimitResponse = await fetch(`${baseUrl}/api/jobs/daily-status/history?limit=0`);
    assert(invalidHistoryLimitResponse.status === 400, "expected invalid history limit to return 400");
    const invalidHistoryOffsetResponse = await fetch(`${baseUrl}/api/jobs/daily-status/history?offset=-1`);
    assert(invalidHistoryOffsetResponse.status === 400, "expected invalid history offset to return 400");

    const missingDetailResponse = await fetch(`${baseUrl}/api/jobs/missing-job`);
    assert(missingDetailResponse.status === 404, "expected missing job detail to return 404");

    const missingHistoryResponse = await fetch(`${baseUrl}/api/jobs/missing-job/history`);
    assert(missingHistoryResponse.status === 404, "expected missing job history to return 404");

    const disableJobResponse = await fetch(`${baseUrl}/api/jobs/hourly-status/disable`, {
      method: "POST",
    });
    assert(disableJobResponse.status === 200, "expected job disable to return 200");
    const disableJobPayload = await disableJobResponse.json();
    assert(disableJobPayload.enabled === false, "expected disabled job payload");

    const enableJobResponse = await fetch(`${baseUrl}/api/jobs/hourly-status/enable`, {
      method: "POST",
    });
    assert(enableJobResponse.status === 200, "expected job enable to return 200");
    const enableJobPayload = await enableJobResponse.json();
    assert(enableJobPayload.enabled === true, "expected enabled job payload");

    const deleteJobResponse = await fetch(`${baseUrl}/api/jobs/weekly-status`, {
      method: "DELETE",
    });
    assert(deleteJobResponse.status === 200, "expected job delete to return 200");
    const deleteJobPayload = await deleteJobResponse.json();
    assert(deleteJobPayload.ok === true, "expected job delete ok payload");

    const afterDeleteResponse = await fetch(`${baseUrl}/api/jobs`);
    assert(afterDeleteResponse.status === 200, "expected GET /api/jobs after delete");
    const afterDeletePayload = await afterDeleteResponse.json();
    assert(afterDeletePayload.jobs.length === 2, "expected two jobs after delete");
    assert(!afterDeletePayload.jobs.some((job) => job.id === "weekly-status"), "expected deleted job to be absent");

    const missingDeleteResponse = await fetch(`${baseUrl}/api/jobs/missing-job`, {
      method: "DELETE",
    });
    assert(missingDeleteResponse.status === 404, "expected missing delete to return 404");

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

    const invalidScheduleResponse = await fetch(`${baseUrl}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "broken-schedule",
        prompt: "ping",
        schedule: "daily 25:99",
      }),
    });
    assert(invalidScheduleResponse.status === 400, "expected invalid schedule to return 400");

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
