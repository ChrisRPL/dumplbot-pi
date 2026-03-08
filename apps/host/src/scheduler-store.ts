import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const JOB_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/u;
const DEFAULT_JOBS_PATH = join(homedir(), ".local", "state", "dumplbot", "jobs.json");

export type ScheduledJobRecord = {
  id: string;
  prompt: string;
  schedule: string;
  workspace: string | null;
  skill: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: "success" | "error" | null;
  lastResult: string | null;
};

export type UpsertScheduledJobInput = {
  id: string;
  prompt: string;
  schedule: string;
  workspace: string | null;
  skill: string | null;
  enabled: boolean;
};

type RawScheduledJobStore = {
  jobs?: unknown;
};

export type ScheduledJobRunUpdate = {
  completedAt: string;
  result: string;
  status: "success" | "error";
};

const getJobsPath = (): string =>
  process.env.DUMPLBOT_JOBS_PATH ?? DEFAULT_JOBS_PATH;

export const normalizeScheduledJobId = (jobId: string): string => {
  const normalizedJobId = jobId.trim().toLowerCase();

  if (!JOB_ID_PATTERN.test(normalizedJobId)) {
    throw new Error("job id is invalid");
  }

  return normalizedJobId;
};

const normalizeRequiredScalar = (value: string, fieldName: string): string => {
  const normalizedValue = value.trim();

  if (!normalizedValue) {
    throw new Error(`${fieldName} is required`);
  }

  return normalizedValue;
};

const parseScheduledJobRecord = (value: unknown): ScheduledJobRecord => {
  if (!value || typeof value !== "object") {
    throw new Error("job entry is invalid");
  }

  const rawJob = value as {
    id?: unknown;
    prompt?: unknown;
    schedule?: unknown;
    workspace?: unknown;
    skill?: unknown;
    enabled?: unknown;
    last_run_at?: unknown;
    last_status?: unknown;
    last_result?: unknown;
  };

  if (
    typeof rawJob.id !== "string"
    || typeof rawJob.prompt !== "string"
    || typeof rawJob.schedule !== "string"
    || typeof rawJob.enabled !== "boolean"
  ) {
    throw new Error("job entry is invalid");
  }

  if (rawJob.workspace !== null && typeof rawJob.workspace !== "string" && typeof rawJob.workspace !== "undefined") {
    throw new Error("job entry is invalid");
  }

  if (rawJob.skill !== null && typeof rawJob.skill !== "string" && typeof rawJob.skill !== "undefined") {
    throw new Error("job entry is invalid");
  }

  if (rawJob.last_run_at !== null && typeof rawJob.last_run_at !== "string" && typeof rawJob.last_run_at !== "undefined") {
    throw new Error("job entry is invalid");
  }

  if (rawJob.last_status !== null && rawJob.last_status !== "success" && rawJob.last_status !== "error" && typeof rawJob.last_status !== "undefined") {
    throw new Error("job entry is invalid");
  }

  if (rawJob.last_result !== null && typeof rawJob.last_result !== "string" && typeof rawJob.last_result !== "undefined") {
    throw new Error("job entry is invalid");
  }

  return {
    id: normalizeScheduledJobId(rawJob.id),
    prompt: normalizeRequiredScalar(rawJob.prompt, "job prompt"),
    schedule: normalizeRequiredScalar(rawJob.schedule, "job schedule"),
    workspace: typeof rawJob.workspace === "string" && rawJob.workspace.trim().length > 0
      ? rawJob.workspace.trim()
      : null,
    skill: typeof rawJob.skill === "string" && rawJob.skill.trim().length > 0
      ? rawJob.skill.trim()
      : null,
    enabled: rawJob.enabled,
    lastRunAt: typeof rawJob.last_run_at === "string" ? rawJob.last_run_at : null,
    lastStatus: rawJob.last_status === "success" || rawJob.last_status === "error"
      ? rawJob.last_status
      : null,
    lastResult: typeof rawJob.last_result === "string" ? rawJob.last_result : null,
  };
};

const parseScheduledJobStore = (raw: string): ScheduledJobRecord[] => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("jobs store is invalid");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("jobs store is invalid");
  }

  const rawStore = parsed as RawScheduledJobStore;

  if (typeof rawStore.jobs === "undefined") {
    return [];
  }

  if (!Array.isArray(rawStore.jobs)) {
    throw new Error("jobs store is invalid");
  }

  const jobs = rawStore.jobs.map(parseScheduledJobRecord);
  const seenJobIds = new Set<string>();

  for (const job of jobs) {
    if (seenJobIds.has(job.id)) {
      throw new Error("jobs store contains duplicate job id");
    }

    seenJobIds.add(job.id);
  }

  return jobs.sort((left, right) => left.id.localeCompare(right.id));
};

const writeScheduledJobStore = async (jobs: ScheduledJobRecord[]): Promise<void> => {
  const jobsPath = getJobsPath();

  await mkdir(dirname(jobsPath), { recursive: true });
  await writeFile(
    jobsPath,
    `${JSON.stringify({
      jobs: jobs.map((job) => ({
        id: job.id,
        prompt: job.prompt,
        schedule: job.schedule,
        workspace: job.workspace,
        skill: job.skill,
        enabled: job.enabled,
        last_run_at: job.lastRunAt,
        last_status: job.lastStatus,
        last_result: job.lastResult,
      })),
    }, null, 2)}\n`,
    "utf8",
  );
};

export const listScheduledJobs = async (): Promise<ScheduledJobRecord[]> => {
  const jobsPath = getJobsPath();

  try {
    const rawStore = await readFile(jobsPath, "utf8");
    return parseScheduledJobStore(rawStore);
  } catch (error) {
    const isMissingFile =
      error instanceof Error
      && "code" in error
      && error.code === "ENOENT";

    if (!isMissingFile) {
      throw error;
    }
  }

  return [];
};

export const upsertScheduledJob = async (
  input: UpsertScheduledJobInput,
): Promise<ScheduledJobRecord> => {
  const nextJob: ScheduledJobRecord = {
    id: normalizeScheduledJobId(input.id),
    prompt: normalizeRequiredScalar(input.prompt, "job prompt"),
    schedule: normalizeRequiredScalar(input.schedule, "job schedule"),
    workspace: input.workspace,
    skill: input.skill,
    enabled: input.enabled,
    lastRunAt: null,
    lastStatus: null,
    lastResult: null,
  };
  const jobs = await listScheduledJobs();
  const existingJobIndex = jobs.findIndex((job) => job.id === nextJob.id);

  if (existingJobIndex >= 0) {
    const existingJob = jobs[existingJobIndex];
    jobs[existingJobIndex] = {
      ...existingJob,
      ...nextJob,
      lastRunAt: existingJob.lastRunAt,
      lastResult: existingJob.lastResult,
    };
  } else {
    jobs.push(nextJob);
  }

  const sortedJobs = jobs.sort((left, right) => left.id.localeCompare(right.id));
  await writeScheduledJobStore(sortedJobs);
  return sortedJobs.find((job) => job.id === nextJob.id) as ScheduledJobRecord;
};

export const recordScheduledJobRun = async (
  jobId: string,
  update: ScheduledJobRunUpdate,
): Promise<ScheduledJobRecord> => {
  const normalizedJobId = normalizeScheduledJobId(jobId);
  const jobs = await listScheduledJobs();
  const jobIndex = jobs.findIndex((job) => job.id === normalizedJobId);

  if (jobIndex < 0) {
    throw new Error("job not found");
  }

  jobs[jobIndex] = {
    ...jobs[jobIndex],
    lastRunAt: normalizeRequiredScalar(update.completedAt, "job completedAt"),
    lastStatus: update.status,
    lastResult: normalizeRequiredScalar(update.result, "job result"),
  };

  await writeScheduledJobStore(jobs);
  return jobs[jobIndex] as ScheduledJobRecord;
};
