import { readFile } from "node:fs/promises";

import type { PermissionMode } from "../../../packages/core/src";

export type HostRuntimeConfig = {
  defaultWorkspace: string;
  defaultSkill: string;
  permissionMode: PermissionMode;
  maxRunSeconds: number;
};

export type HostSandboxConfig = {
  enabled: boolean;
  backend: "bwrap";
};

export type HostSchedulerConfig = {
  enabled: boolean;
  pollIntervalSeconds: number;
  store: "file";
};

const DEFAULT_CONFIG_PATH = "/etc/dumplbot/config.yaml";
const DEFAULT_WORKSPACE = "default";
const DEFAULT_SKILL = "coding";
const DEFAULT_PERMISSION_MODE: PermissionMode = "balanced";
const DEFAULT_MAX_RUN_SECONDS = 180;
const DEFAULT_SCHEDULER_POLL_SECONDS = 15;
const DEFAULT_SANDBOX_CONFIG: HostSandboxConfig = {
  enabled: true,
  backend: "bwrap",
};
const DEFAULT_SCHEDULER_CONFIG: HostSchedulerConfig = {
  enabled: false,
  pollIntervalSeconds: DEFAULT_SCHEDULER_POLL_SECONDS,
  store: "file",
};

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
};

const applyRuntimeConfigLine = (
  config: HostRuntimeConfig,
  key: string,
  value: string,
): void => {
  if (key === "default_workspace" && value) {
    config.defaultWorkspace = value;
    return;
  }

  if (key === "default_skill" && value) {
    config.defaultSkill = value;
    return;
  }

  if (key === "permission_mode" && (value === "strict" || value === "balanced" || value === "permissive")) {
    config.permissionMode = value;
    return;
  }

  if (key === "max_run_seconds") {
    config.maxRunSeconds = parsePositiveInt(value, config.maxRunSeconds);
  }
};

export const loadHostRuntimeConfig = async (
  configPath = process.env.DUMPLBOT_CONFIG_PATH ?? DEFAULT_CONFIG_PATH,
): Promise<HostRuntimeConfig> => {
  const config: HostRuntimeConfig = {
    defaultWorkspace: process.env.DUMPLBOT_DEFAULT_WORKSPACE ?? DEFAULT_WORKSPACE,
    defaultSkill: process.env.DUMPLBOT_DEFAULT_SKILL ?? DEFAULT_SKILL,
    permissionMode: (process.env.DUMPLBOT_PERMISSION_MODE as PermissionMode | undefined) ?? DEFAULT_PERMISSION_MODE,
    maxRunSeconds: parsePositiveInt(
      process.env.DUMPLBOT_MAX_RUN_SECONDS,
      DEFAULT_MAX_RUN_SECONDS,
    ),
  };

  try {
    const rawConfig = await readFile(configPath, "utf8");
    let inRuntimeBlock = false;

    for (const rawLine of rawConfig.split(/\r?\n/u)) {
      const trimmedLine = rawLine.trim();

      if (!trimmedLine || trimmedLine.startsWith("#")) {
        continue;
      }

      if (!rawLine.startsWith(" ")) {
        inRuntimeBlock = trimmedLine === "runtime:";
        continue;
      }

      if (!inRuntimeBlock || !rawLine.startsWith("  ")) {
        continue;
      }

      const separatorIndex = trimmedLine.indexOf(":");

      if (separatorIndex <= 0) {
        continue;
      }

      const key = trimmedLine.slice(0, separatorIndex).trim();
      const value = trimmedLine.slice(separatorIndex + 1).trim().replace(/^"|"$/gu, "");
      applyRuntimeConfigLine(config, key, value);
    }
  } catch (error) {
    const isMissingFile =
      error instanceof Error
      && "code" in error
      && error.code === "ENOENT";

    if (!isMissingFile) {
      throw error;
    }
  }

  return config;
};

const applySandboxConfigLine = (
  config: HostSandboxConfig,
  key: string,
  value: string,
): void => {
  if (key === "enabled") {
    const normalized = value.trim().toLowerCase();
    config.enabled = normalized === "true" || normalized === "1";
    return;
  }

  if (key === "backend" && value === "bwrap") {
    config.backend = "bwrap";
  }
};

export const loadHostSandboxConfig = async (
  configPath = process.env.DUMPLBOT_CONFIG_PATH ?? DEFAULT_CONFIG_PATH,
): Promise<HostSandboxConfig> => {
  const config: HostSandboxConfig = {
    enabled: process.env.DUMPLBOT_SANDBOX_ENABLED
      ? process.env.DUMPLBOT_SANDBOX_ENABLED.trim().toLowerCase() === "true"
      : DEFAULT_SANDBOX_CONFIG.enabled,
    backend: DEFAULT_SANDBOX_CONFIG.backend,
  };

  if (process.env.DUMPLBOT_SANDBOX_BACKEND === "bwrap") {
    config.backend = "bwrap";
  }

  try {
    const rawConfig = await readFile(configPath, "utf8");
    let inSandboxBlock = false;

    for (const rawLine of rawConfig.split(/\r?\n/u)) {
      const trimmedLine = rawLine.trim();

      if (!trimmedLine || trimmedLine.startsWith("#")) {
        continue;
      }

      if (!rawLine.startsWith(" ")) {
        inSandboxBlock = trimmedLine === "sandbox:";
        continue;
      }

      if (!inSandboxBlock || !rawLine.startsWith("  ")) {
        continue;
      }

      const separatorIndex = trimmedLine.indexOf(":");

      if (separatorIndex <= 0) {
        continue;
      }

      const key = trimmedLine.slice(0, separatorIndex).trim();
      const value = trimmedLine.slice(separatorIndex + 1).trim().replace(/^"|"$/gu, "");
      applySandboxConfigLine(config, key, value);
    }
  } catch (error) {
    const isMissingFile =
      error instanceof Error
      && "code" in error
      && error.code === "ENOENT";

    if (!isMissingFile) {
      throw error;
    }
  }

  return config;
};

const applySchedulerConfigLine = (
  config: HostSchedulerConfig,
  key: string,
  value: string,
): void => {
  if (key === "enabled") {
    const normalized = value.trim().toLowerCase();
    config.enabled = normalized === "true" || normalized === "1";
    return;
  }

  if (key === "store" && value === "file") {
    config.store = "file";
    return;
  }

  if (key === "poll_interval_seconds") {
    config.pollIntervalSeconds = parsePositiveInt(value, config.pollIntervalSeconds);
  }
};

export const loadHostSchedulerConfig = async (
  configPath = process.env.DUMPLBOT_CONFIG_PATH ?? DEFAULT_CONFIG_PATH,
): Promise<HostSchedulerConfig> => {
  const config: HostSchedulerConfig = {
    enabled: process.env.DUMPLBOT_SCHEDULER_ENABLED
      ? process.env.DUMPLBOT_SCHEDULER_ENABLED.trim().toLowerCase() === "true"
      : DEFAULT_SCHEDULER_CONFIG.enabled,
    pollIntervalSeconds: parsePositiveInt(
      process.env.DUMPLBOT_SCHEDULER_POLL_SECONDS,
      DEFAULT_SCHEDULER_CONFIG.pollIntervalSeconds,
    ),
    store: DEFAULT_SCHEDULER_CONFIG.store,
  };

  try {
    const rawConfig = await readFile(configPath, "utf8");
    let inSchedulerBlock = false;

    for (const rawLine of rawConfig.split(/\r?\n/u)) {
      const trimmedLine = rawLine.trim();

      if (!trimmedLine || trimmedLine.startsWith("#")) {
        continue;
      }

      if (!rawLine.startsWith(" ")) {
        inSchedulerBlock = trimmedLine === "scheduler:";
        continue;
      }

      if (!inSchedulerBlock || !rawLine.startsWith("  ")) {
        continue;
      }

      const separatorIndex = trimmedLine.indexOf(":");

      if (separatorIndex <= 0) {
        continue;
      }

      const key = trimmedLine.slice(0, separatorIndex).trim();
      const value = trimmedLine.slice(separatorIndex + 1).trim().replace(/^"|"$/gu, "");
      applySchedulerConfigLine(config, key, value);
    }
  } catch (error) {
    const isMissingFile =
      error instanceof Error
      && "code" in error
      && error.code === "ENOENT";

    if (!isMissingFile) {
      throw error;
    }
  }

  return config;
};
