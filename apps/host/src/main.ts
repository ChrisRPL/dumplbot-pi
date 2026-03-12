import { loadHostSchedulerConfig } from "./runtime-config";
import { startSchedulerLoop } from "./scheduler-loop";
import { runScheduledJob } from "./scheduler-runner";
import { recordScheduledJobRun } from "./scheduler-store";
import { startHostServer } from "./server";

const main = async (): Promise<void> => {
  const server = await startHostServer();
  const schedulerConfig = await loadHostSchedulerConfig();
  const scheduler = startSchedulerLoop({
    enabled: schedulerConfig.enabled,
    pollIntervalMs: schedulerConfig.pollIntervalSeconds * 1000,
    onJobDue: async (job) => {
      const outcome = await runScheduledJob(job);
      await recordScheduledJobRun(job.id, outcome);
      process.stdout.write(
        `scheduler job ${job.id} finished with ${outcome.status}: ${outcome.result}\n`,
      );
    },
    onError: (error) => {
      process.stderr.write(`scheduler loop error: ${error.message}\n`);
    },
  });

  const shutdown = (): void => {
    scheduler.close();
    server.close(() => {
      process.exit(0);
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
