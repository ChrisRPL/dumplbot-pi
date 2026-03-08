import { getMinuteBucket, matchesCronSchedule } from "./scheduler-cron";
import { listScheduledJobs, type ScheduledJobRecord } from "./scheduler-store";

const DEFAULT_POLL_INTERVAL_MS = 15_000;

export type SchedulerLoopOptions = {
  enabled: boolean;
  onJobDue: (job: ScheduledJobRecord) => Promise<void>;
  onError?: (error: Error) => void;
  nowProvider?: () => Date;
  pollIntervalMs?: number;
};

export type SchedulerLoopHandle = {
  close: () => void;
};

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

export const startSchedulerLoop = (
  options: SchedulerLoopOptions,
): SchedulerLoopHandle => {
  if (!options.enabled) {
    return {
      close: () => undefined,
    };
  }

  const nowProvider = options.nowProvider ?? (() => new Date());
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs) && options.pollIntervalMs
    ? Math.max(250, Math.floor(options.pollIntervalMs))
    : DEFAULT_POLL_INTERVAL_MS;
  const dueBuckets = new Map<string, string>();
  const inFlightJobs = new Set<string>();
  let closed = false;
  let tickActive = false;

  const tick = async (): Promise<void> => {
    if (closed || tickActive) {
      return;
    }

    tickActive = true;

    try {
      const now = nowProvider();
      const minuteBucket = getMinuteBucket(now);
      const jobs = await listScheduledJobs();

      for (const job of jobs) {
        if (!job.enabled || inFlightJobs.has(job.id)) {
          continue;
        }

        if (!matchesCronSchedule(job.schedule, now)) {
          continue;
        }

        if (dueBuckets.get(job.id) === minuteBucket) {
          continue;
        }

        dueBuckets.set(job.id, minuteBucket);
        inFlightJobs.add(job.id);

        void options.onJobDue(job).catch((error) => {
          options.onError?.(toError(error));
        }).finally(() => {
          inFlightJobs.delete(job.id);
        });
      }
    } catch (error) {
      options.onError?.(toError(error));
    } finally {
      tickActive = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, pollIntervalMs);
  timer.unref();
  void tick();

  return {
    close: () => {
      closed = true;
      clearInterval(timer);
    },
  };
};
