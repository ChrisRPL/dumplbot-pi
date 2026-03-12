import { readFile } from "node:fs/promises";

export type SetupSecretStatus = {
  anthropicApiKeyConfigured: boolean;
  openaiApiKeyConfigured: boolean;
  secretsFilePresent: boolean;
};

const DEFAULT_SECRETS_PATH = "/etc/dumplbot/secrets.env";

const parseSecretStatus = (rawSecrets: string): SetupSecretStatus => {
  const status: SetupSecretStatus = {
    anthropicApiKeyConfigured: false,
    openaiApiKeyConfigured: false,
    secretsFilePresent: true,
  };

  for (const rawLine of rawSecrets.split(/\r?\n/u)) {
    const trimmedLine = rawLine.trim();

    if (!trimmedLine || trimmedLine.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmedLine.indexOf("=");

    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    const value = trimmedLine.slice(separatorIndex + 1).trim();

    if (key === "OPENAI_API_KEY" && value.length > 0) {
      status.openaiApiKeyConfigured = true;
    }

    if (key === "ANTHROPIC_API_KEY" && value.length > 0) {
      status.anthropicApiKeyConfigured = true;
    }
  }

  return status;
};

export const loadSetupSecretStatus = async (
  secretsPath = process.env.DUMPLBOT_SECRETS_PATH ?? DEFAULT_SECRETS_PATH,
): Promise<SetupSecretStatus> => {
  try {
    return parseSecretStatus(await readFile(secretsPath, "utf8"));
  } catch (error) {
    const isMissingFile =
      error instanceof Error
      && "code" in error
      && error.code === "ENOENT";

    if (isMissingFile) {
      return {
        anthropicApiKeyConfigured: false,
        openaiApiKeyConfigured: false,
        secretsFilePresent: false,
      };
    }

    throw error;
  }
};
