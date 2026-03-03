import { readFile } from "node:fs/promises";

export type SttRuntimeConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  language: string;
  promptBias: string;
};

const DEFAULT_CONFIG_PATH = "/etc/dumplbot/config.yaml";
const DEFAULT_BASE_URL = "https://api.openai.com";
const DEFAULT_MODEL = "whisper-1";
const DEFAULT_LANGUAGE = "auto";

const applySttConfigLine = (
  config: SttRuntimeConfig,
  key: string,
  value: string,
): void => {
  if (key === "model" && value) {
    config.model = value;
    return;
  }

  if (key === "language" && value) {
    config.language = value;
    return;
  }

  if (key === "prompt_bias") {
    config.promptBias = value;
  }
};

export const loadSttRuntimeConfig = async (
  configPath = process.env.DUMPLBOT_CONFIG_PATH ?? DEFAULT_CONFIG_PATH,
): Promise<SttRuntimeConfig> => {
  const config: SttRuntimeConfig = {
    apiKey: process.env.OPENAI_API_KEY ?? "",
    baseUrl: process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL,
    model: process.env.DUMPLBOT_STT_MODEL ?? DEFAULT_MODEL,
    language: process.env.DUMPLBOT_STT_LANGUAGE ?? DEFAULT_LANGUAGE,
    promptBias: process.env.DUMPLBOT_STT_PROMPT_BIAS ?? "",
  };

  try {
    const rawConfig = await readFile(configPath, "utf8");
    let inSttBlock = false;

    for (const rawLine of rawConfig.split(/\r?\n/u)) {
      const trimmedLine = rawLine.trim();

      if (!trimmedLine || trimmedLine.startsWith("#")) {
        continue;
      }

      if (!rawLine.startsWith(" ")) {
        inSttBlock = trimmedLine === "stt:";
        continue;
      }

      if (!inSttBlock || !rawLine.startsWith("  ")) {
        continue;
      }

      const separatorIndex = trimmedLine.indexOf(":");

      if (separatorIndex <= 0) {
        continue;
      }

      const key = trimmedLine.slice(0, separatorIndex).trim();
      const value = trimmedLine.slice(separatorIndex + 1).trim().replace(/^"|"$/gu, "");
      applySttConfigLine(config, key, value);
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
