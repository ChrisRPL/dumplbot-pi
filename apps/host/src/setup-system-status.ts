import type { HostServerConfig } from "./runtime-config";

export type SetupSystemStatus = {
  system: {
    active_server: {
      bind: string;
      host: string;
      port: number;
    };
    configured_server: {
      bind: string;
      host: string;
      port: number;
    };
    lan_setup_ready: boolean;
    restart_required: boolean;
    status_message: string;
    action_required: boolean;
    action_label: string | null;
    action_instructions: string[];
  };
};

const formatServerBind = ({ host, port }: HostServerConfig): string => `${host}:${port}`;

const isLoopbackServerHost = (host: string): boolean => host === "127.0.0.1" || host === "::1";

export const buildSetupSystemStatus = (
  activeServer: HostServerConfig,
  configuredServer: HostServerConfig,
): SetupSystemStatus => {
  const restartRequired = activeServer.host !== configuredServer.host || activeServer.port !== configuredServer.port;
  const lanSetupReady = !isLoopbackServerHost(activeServer.host);
  let actionLabel: string | null = null;
  let actionInstructions: string[] = [];

  let statusMessage = "Same-Wi-Fi setup is ready.";

  if (restartRequired) {
    statusMessage = `Restart dumplbotd to apply configured bind ${formatServerBind(configuredServer)}.`;
    actionLabel = "Restart dumplbotd";
    actionInstructions = [
      "sudo systemctl restart dumplbotd.service",
      "curl -i http://127.0.0.1:4123/health",
    ];
  } else if (!lanSetupReady) {
    statusMessage = "Current bind is loopback-only. Set server.host to 0.0.0.0 and restart dumplbotd for same-Wi-Fi setup.";
    actionLabel = "Enable same-Wi-Fi setup";
    actionInstructions = [
      "Edit /etc/dumplbot/config.yaml and set server.host to 0.0.0.0",
      "sudo systemctl restart dumplbotd.service",
      "curl -i http://127.0.0.1:4123/health",
    ];
  }

  return {
    system: {
      active_server: {
        bind: formatServerBind(activeServer),
        host: activeServer.host,
        port: activeServer.port,
      },
      configured_server: {
        bind: formatServerBind(configuredServer),
        host: configuredServer.host,
        port: configuredServer.port,
      },
      lan_setup_ready: lanSetupReady,
      restart_required: restartRequired,
      status_message: statusMessage,
      action_required: actionInstructions.length > 0,
      action_label: actionLabel,
      action_instructions: actionInstructions,
    },
  };
};
