#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listScheduledJobs,
  recordScheduledJobRun,
} from "../dist/apps/host/src/scheduler-store.js";

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const runSmoke = async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), "dumplbot-scheduler-history-smoke-"));
  const jobsPath = join(tmpRoot, "jobs.json");

  await writeFile(
    jobsPath,
    `${JSON.stringify({
      jobs: [
        {
          id: "history-job",
          prompt: "ping",
          schedule: "* * * * *",
          workspace: null,
          skill: null,
          enabled: true,
          last_run_at: null,
          last_status: null,
          last_result: null,
          history: [],
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  process.env.DUMPLBOT_JOBS_PATH = jobsPath;

  try {
    for (let index = 0; index < 25; index += 1) {
      await recordScheduledJobRun("history-job", {
        completedAt: new Date(Date.UTC(2026, 2, 10, 12, index, 0)).toISOString(),
        status: "success",
        result: `run-${index}`,
      });
    }

    const jobs = await listScheduledJobs();
    const job = jobs.find((entry) => entry.id === "history-job");
    assert(job, "expected history job to exist");
    assert(job.history.length === 20, `expected capped history length, got ${job.history.length}`);
    assert(job.history[0]?.result === "run-5", "expected oldest retained history entry");
    assert(job.history[19]?.result === "run-24", "expected newest retained history entry");
    assert(job.lastResult === "run-24", "expected last result to match newest history entry");
  } finally {
    delete process.env.DUMPLBOT_JOBS_PATH;
    await rm(tmpRoot, { recursive: true, force: true });
  }

  console.log("scheduler history retention smoke ok");
};

runSmoke().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
