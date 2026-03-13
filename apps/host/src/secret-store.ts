import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_SECRETS_PATH = "/etc/dumplbot/secrets.env";

export type SetupSecretUpdate = {
  anthropicApiKey?: string;
  openaiApiKey?: string;
};

export type SetupSecrets = {
  anthropicApiKey: string;
  openaiApiKey: string;
};

const normalizeSecretsText = (rawSecrets: string): string => (
  rawSecrets.endsWith("\n")
    ? rawSecrets
    : `${rawSecrets}\n`
);

const setSecretsEnvKeys = (
  rawSecrets: string,
  entries: Array<[string, string]>,
): string => {
  const lines = rawSecrets.length > 0
    ? rawSecrets.split(/\r?\n/u)
    : [];

  for (const [key, value] of entries) {
    const nextLine = `${key}=${value}`;
    let replaced = false;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex] ?? "";
      const trimmedLine = line.trim();

      if (!trimmedLine || trimmedLine.startsWith("#")) {
        continue;
      }

      const separatorIndex = trimmedLine.indexOf("=");

      if (separatorIndex <= 0) {
        continue;
      }

      const existingKey = trimmedLine.slice(0, separatorIndex).trim();

      if (existingKey === key) {
        lines[lineIndex] = nextLine;
        replaced = true;
        break;
      }
    }

    if (!replaced) {
      let insertIndex = lines.length;

      while (insertIndex > 0 && (lines[insertIndex - 1] ?? "").trim() === "") {
        insertIndex -= 1;
      }

      lines.splice(insertIndex, 0, nextLine);
    }
  }

  return normalizeSecretsText(lines.join("\n"));
};

const readSecretsText = async (
  secretsPath = process.env.DUMPLBOT_SECRETS_PATH ?? DEFAULT_SECRETS_PATH,
): Promise<string> => {
  try {
    return await readFile(secretsPath, "utf8");
  } catch (error) {
    const isMissingFile =
      error instanceof Error
      && "code" in error
      && error.code === "ENOENT";

    if (isMissingFile) {
      return "";
    }

    throw error;
  }
};

export const loadSetupSecrets = async (
  secretsPath = process.env.DUMPLBOT_SECRETS_PATH ?? DEFAULT_SECRETS_PATH,
): Promise<SetupSecrets> => {
  const rawSecrets = await readSecretsText(secretsPath);
  const secrets: SetupSecrets = {
    anthropicApiKey: "",
    openaiApiKey: "",
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
      secrets.openaiApiKey = value;
    }

    if (key === "ANTHROPIC_API_KEY" && value.length > 0) {
      secrets.anthropicApiKey = value;
    }
  }

  return secrets;
};

export const writeSetupSecretUpdate = async (
  update: SetupSecretUpdate,
  secretsPath = process.env.DUMPLBOT_SECRETS_PATH ?? DEFAULT_SECRETS_PATH,
): Promise<void> => {
  const entries: Array<[string, string]> = [];

  if (typeof update.openaiApiKey === "string" && update.openaiApiKey.trim().length > 0) {
    entries.push(["OPENAI_API_KEY", update.openaiApiKey.trim()]);
  }

  if (typeof update.anthropicApiKey === "string" && update.anthropicApiKey.trim().length > 0) {
    entries.push(["ANTHROPIC_API_KEY", update.anthropicApiKey.trim()]);
  }

  if (entries.length === 0) {
    return;
  }

  const rawSecrets = await readSecretsText(secretsPath);
  const nextSecrets = setSecretsEnvKeys(rawSecrets, entries);
  await mkdir(dirname(secretsPath), { recursive: true });
  await writeFile(secretsPath, nextSecrets, "utf8");
};
