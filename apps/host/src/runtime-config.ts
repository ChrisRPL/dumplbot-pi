import { readFile } from "node:fs/promises";

export type HostRuntimeConfig = {
  defaultWorkspace: string;
  defaultSkill: string;
};

const DEFAULT_CONFIG_PATH = "/etc/dumplbot/config.yaml";
const DEFAULT_WORKSPACE = "default";
const DEFAULT_SKILL = "coding";

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
  }
};

export const loadHostRuntimeConfig = async (
  configPath = process.env.DUMPLBOT_CONFIG_PATH ?? DEFAULT_CONFIG_PATH,
): Promise<HostRuntimeConfig> => {
  const config: HostRuntimeConfig = {
    defaultWorkspace: process.env.DUMPLBOT_DEFAULT_WORKSPACE ?? DEFAULT_WORKSPACE,
    defaultSkill: process.env.DUMPLBOT_DEFAULT_SKILL ?? DEFAULT_SKILL,
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
