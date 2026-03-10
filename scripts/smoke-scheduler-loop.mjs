#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listScheduledJobs,
  recordScheduledJobRun,
} from "../dist/apps/host/src/scheduler-store.js";
import { startSchedulerLoop } from "../dist/apps/host/src/scheduler-loop.js";

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const sleep = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const runSmoke = async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), "dumplbot-scheduler-loop-smoke-"));
  const jobsPath = join(tmpRoot, "jobs.json");
  const now = new Date(2026, 2, 8, 12, 34, 0, 0);

  await writeFile(
    jobsPath,
    `${JSON.stringify({
      jobs: [
        {
          id: "due-job",
          prompt: "ping",
          schedule: "34 12 * * *",
          workspace: null,
          skill: null,
          enabled: true,
          last_run_at: null,
          last_result: null,
        },
        {
          id: "later-job",
          prompt: "ping later",
          schedule: "35 12 * * *",
          workspace: null,
          skill: null,
          enabled: true,
          last_run_at: null,
          last_result: null,
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  process.env.DUMPLBOT_JOBS_PATH = jobsPath;
  const seenJobs = [];
  let loopError = null;
  let persistedJobs = [];
  const loop = startSchedulerLoop({
    enabled: true,
    pollIntervalMs: 250,
    nowProvider: () => new Date(now),
    onJobDue: async (job) => {
      seenJobs.push(job.id);
      await recordScheduledJobRun(job.id, {
        completedAt: now.toISOString(),
        status: "success",
        result: "ok",
        durationMs: 42,
      });
    },
    onError: (error) => {
      loopError = error;
    },
  });

  try {
    await sleep(900);
    persistedJobs = await listScheduledJobs();
  } finally {
    loop.close();
    delete process.env.DUMPLBOT_JOBS_PATH;
    await rm(tmpRoot, { recursive: true, force: true });
  }

  assert(!loopError, `unexpected scheduler loop error: ${loopError?.message ?? "unknown"}`);
  assert(seenJobs.length === 1, `expected one due job execution, got ${seenJobs.length}`);
  assert(seenJobs[0] === "due-job", "expected only due job to run");
  const dueJob = persistedJobs.find((job) => job.id === "due-job");
  assert(dueJob?.lastStatus === "success", "expected due job last status");
  assert(dueJob?.lastDurationMs === 42, "expected due job duration");
  assert(dueJob?.lastError === null, "expected due job error to stay empty");
  assert(Array.isArray(dueJob?.history), "expected due job history array");
  assert(dueJob?.history.length === 1, "expected one persisted history entry");
  assert(dueJob?.history[0]?.result === "ok", "expected persisted history result");

  console.log("scheduler loop smoke ok");
};

runSmoke().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
