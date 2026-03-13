import type { HostSchedulerConfig } from "./runtime-config";
import type { SttRuntimeConfig } from "./stt-config";

export type SetupHealthStatus = {
  health: {
    daemon_healthy: boolean;
    scheduler_enabled: boolean;
    scheduler_poll_interval_seconds: number;
    stt_ready: boolean;
    stt_model: string;
    stt_language: string;
    status_message: string;
  };
};

export const buildSetupHealthStatus = (
  schedulerConfig: HostSchedulerConfig,
  sttConfig: SttRuntimeConfig,
): SetupHealthStatus => {
  const sttReady = sttConfig.apiKey.length > 0;
  let statusMessage = "Daemon, scheduler, and STT look ready.";

  if (!sttReady) {
    statusMessage = "Add an OpenAI key to enable transcription.";
  } else if (!schedulerConfig.enabled) {
    statusMessage = "Daemon is healthy. Scheduler is disabled in config.";
  }

  return {
    health: {
      daemon_healthy: true,
      scheduler_enabled: schedulerConfig.enabled,
      scheduler_poll_interval_seconds: schedulerConfig.pollIntervalSeconds,
      stt_ready: sttReady,
      stt_model: sttConfig.model,
      stt_language: sttConfig.language,
      status_message: statusMessage,
    },
  };
};
