import type { HostRuntimeConfig } from "./runtime-config";
import type { SetupSecretStatus } from "./secret-status";
import type { SetupHealthStatus } from "./setup-health-status";
import type { SetupSystemStatus } from "./setup-system-status";

export type SetupFirstRunStatus = {
  first_run: {
    ready: boolean;
    status_message: string;
    next_action_label: string;
    next_action_detail: string;
    steps: Array<{
      id: string;
      label: string;
      done: boolean;
      detail: string;
    }>;
  };
};

export const buildSetupFirstRunStatus = (
  runtimeConfig: HostRuntimeConfig,
  secretStatus: SetupSecretStatus,
  setupHealthStatus: SetupHealthStatus,
  setupSystemStatus: SetupSystemStatus,
): SetupFirstRunStatus => {
  const lanReady = setupSystemStatus.system.lan_setup_ready && !setupSystemStatus.system.restart_required;
  const defaultsReady = runtimeConfig.defaultWorkspace.length > 0 && runtimeConfig.defaultSkill.length > 0;
  const sttReady = setupHealthStatus.health.stt_ready;
  const keyReady = secretStatus.openaiApiKeyConfigured;

  const steps = [
    {
      id: "lan",
      label: "Same-Wi-Fi setup",
      done: lanReady,
      detail: lanReady
        ? `Reachable on ${setupSystemStatus.system.active_server.bind}`
        : setupSystemStatus.system.status_message,
    },
    {
      id: "defaults",
      label: "Default workspace and skill",
      done: defaultsReady,
      detail: defaultsReady
        ? `${runtimeConfig.defaultWorkspace} / ${runtimeConfig.defaultSkill}`
        : "Pick defaults on this page before the first run.",
    },
    {
      id: "openai",
      label: "Voice key",
      done: keyReady,
      detail: keyReady
        ? "OpenAI key is configured for transcription."
        : "Add an OpenAI key to enable push-to-talk transcription.",
    },
    {
      id: "voice",
      label: "Voice path",
      done: sttReady,
      detail: sttReady
        ? `${setupHealthStatus.health.stt_model} (${setupHealthStatus.health.stt_language}) is ready`
        : setupHealthStatus.health.status_message,
    },
  ];

  const nextStep = steps.find((step) => !step.done);
  const ready = nextStep === undefined;

  return {
    first_run: {
      ready,
      status_message: ready
        ? "DumplBot is ready for a first talk test."
        : "Finish the next missing step below, then try a first talk test.",
      next_action_label: nextStep?.label ?? "Try the button",
      next_action_detail: nextStep?.detail ?? "Hold the button, speak, release, and watch the first reply stream back.",
      steps,
    },
  };
};
