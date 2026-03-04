import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

type RetentionEntry = {
  path: string;
  modifiedAtMs: number;
};

const DEFAULT_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
const DEFAULT_MAX_FILES = 64;

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

const getMaxAgeSeconds = (): number =>
  parsePositiveInt(process.env.DUMPLBOT_RETENTION_MAX_AGE_SECONDS, DEFAULT_MAX_AGE_SECONDS);

const getMaxFiles = (): number =>
  parsePositiveInt(process.env.DUMPLBOT_RETENTION_MAX_FILES, DEFAULT_MAX_FILES);

const readRetentionEntries = async (
  directoryPath: string,
  extension: string,
): Promise<RetentionEntry[]> => {
  const dirEntries = await readdir(directoryPath, { withFileTypes: true });
  const files = dirEntries.filter(
    (entry) => entry.isFile() && entry.name.endsWith(extension),
  );
  const entries: RetentionEntry[] = [];

  for (const file of files) {
    const path = join(directoryPath, file.name);
    const stats = await stat(path);
    entries.push({
      path,
      modifiedAtMs: stats.mtimeMs,
    });
  }

  return entries.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
};

const pruneByAge = async (
  entries: RetentionEntry[],
  maxAgeSeconds: number,
): Promise<RetentionEntry[]> => {
  const nowMs = Date.now();
  const survivors: RetentionEntry[] = [];

  for (const entry of entries) {
    const ageSeconds = (nowMs - entry.modifiedAtMs) / 1000;

    if (ageSeconds > maxAgeSeconds) {
      await rm(entry.path, { force: true });
      continue;
    }

    survivors.push(entry);
  }

  return survivors;
};

const pruneByCount = async (
  entries: RetentionEntry[],
  maxFiles: number,
): Promise<void> => {
  const overflowEntries = entries.slice(maxFiles);

  for (const entry of overflowEntries) {
    await rm(entry.path, { force: true });
  }
};

export const applyRetentionPolicy = async (
  directoryPath: string,
  extension: string,
): Promise<void> => {
  try {
    const entries = await readRetentionEntries(directoryPath, extension);
    const survivors = await pruneByAge(entries, getMaxAgeSeconds());
    await pruneByCount(survivors, getMaxFiles());
  } catch (error) {
    const isMissingDirectory =
      error instanceof Error
      && "code" in error
      && error.code === "ENOENT";

    if (!isMissingDirectory) {
      throw error;
    }
  }
};
