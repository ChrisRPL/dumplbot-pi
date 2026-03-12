import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { PermissionMode } from "../../../packages/core/src";

const DEFAULT_CONFIG_PATH = "/etc/dumplbot/config.yaml";

type HostRuntimeConfigUpdate = {
  defaultWorkspace?: string;
  defaultSkill?: string;
  permissionMode?: PermissionMode;
};

export type ImportedHostRuntimeConfig = {
  defaultWorkspace: string;
  defaultSkill: string;
  permissionMode: PermissionMode;
  maxRunSeconds: number | null;
};

const RUNTIME_SECTION_NAME = "runtime";

const parseFlatYamlSection = (
  rawConfig: string,
  sectionName: string,
): Map<string, string> => {
  const entries = new Map<string, string>();
  let inSection = false;

  for (const rawLine of rawConfig.split(/\r?\n/u)) {
    const trimmedLine = rawLine.trim();

    if (!trimmedLine || trimmedLine.startsWith("#")) {
      continue;
    }

    if (!rawLine.startsWith(" ")) {
      inSection = trimmedLine === `${sectionName}:`;
      continue;
    }

    if (!inSection || !rawLine.startsWith("  ")) {
      continue;
    }

    const separatorIndex = trimmedLine.indexOf(":");

    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    const value = trimmedLine.slice(separatorIndex + 1).trim().replace(/^"|"$/gu, "");
    entries.set(key, value);
  }

  return entries;
};

const normalizeConfigText = (rawConfig: string): string => (
  rawConfig.endsWith("\n")
    ? rawConfig
    : `${rawConfig}\n`
);

const parseImportedMaxRunSeconds = (value: string | undefined): number | null => {
  if (typeof value === "undefined" || value.length === 0) {
    return null;
  }

  const parsedValue = Number.parseInt(value, 10);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error("runtime.max_run_seconds must be a positive integer");
  }

  return parsedValue;
};

export const parseImportedHostRuntimeConfig = (
  rawConfig: string,
): ImportedHostRuntimeConfig => {
  if (rawConfig.trim().length === 0) {
    throw new Error("config import requires non-empty config");
  }

  const runtimeEntries = parseFlatYamlSection(rawConfig, RUNTIME_SECTION_NAME);
  const defaultWorkspace = runtimeEntries.get("default_workspace")?.trim();
  const defaultSkill = runtimeEntries.get("default_skill")?.trim();
  const permissionMode = runtimeEntries.get("permission_mode")?.trim();

  if (!defaultWorkspace) {
    throw new Error("config import requires runtime.default_workspace");
  }

  if (!defaultSkill) {
    throw new Error("config import requires runtime.default_skill");
  }

  if (permissionMode !== "strict" && permissionMode !== "balanced" && permissionMode !== "permissive") {
    throw new Error("config import requires runtime.permission_mode to be strict, balanced, or permissive");
  }

  return {
    defaultWorkspace,
    defaultSkill,
    permissionMode,
    maxRunSeconds: parseImportedMaxRunSeconds(runtimeEntries.get("max_run_seconds")),
  };
};

const setFlatYamlSectionKeys = (
  rawConfig: string,
  sectionName: string,
  entries: Array<[string, string]>,
): string => {
  const lines = rawConfig.length > 0
    ? rawConfig.split(/\r?\n/u)
    : [];
  const sectionHeader = `${sectionName}:`;
  let sectionStartIndex = lines.findIndex((line) => line.trim() === sectionHeader);

  if (sectionStartIndex === -1) {
    if (lines.length > 0 && lines[lines.length - 1]?.trim() !== "") {
      lines.push("");
    }

    lines.push(sectionHeader);

    for (const [key, value] of entries) {
      lines.push(`  ${key}: ${value}`);
    }

    return `${lines.filter((line, index, source) => index < source.length - 1 || line.length > 0).join("\n")}\n`;
  }

  let sectionEndIndex = lines.length;

  for (let lineIndex = sectionStartIndex + 1; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";

    if (line.trim().length > 0 && !line.startsWith(" ")) {
      sectionEndIndex = lineIndex;
      break;
    }
  }

  const sectionLines = lines.slice(sectionStartIndex + 1, sectionEndIndex);

  for (const [key, value] of entries) {
    const keyLineIndex = sectionLines.findIndex((line) => line.trim().startsWith(`${key}:`));

    if (keyLineIndex >= 0) {
      sectionLines[keyLineIndex] = `  ${key}: ${value}`;
      continue;
    }

    let insertIndex = sectionLines.length;

    while (insertIndex > 0 && sectionLines[insertIndex - 1]?.trim() === "") {
      insertIndex -= 1;
    }

    sectionLines.splice(insertIndex, 0, `  ${key}: ${value}`);
  }

  lines.splice(sectionStartIndex + 1, sectionEndIndex - sectionStartIndex - 1, ...sectionLines);
  return `${lines.filter((line, index, source) => index < source.length - 1 || line.length > 0).join("\n")}\n`;
};

export const writeHostRuntimeConfigUpdate = async (
  update: HostRuntimeConfigUpdate,
  configPath = process.env.DUMPLBOT_CONFIG_PATH ?? DEFAULT_CONFIG_PATH,
): Promise<void> => {
  let rawConfig = "";

  try {
    rawConfig = await readFile(configPath, "utf8");
  } catch (error) {
    const isMissingFile =
      error instanceof Error
      && "code" in error
      && error.code === "ENOENT";

    if (!isMissingFile) {
      throw error;
    }
  }

  const entries: Array<[string, string]> = [];

  if (typeof update.defaultWorkspace === "string") {
    entries.push(["default_workspace", update.defaultWorkspace]);
  }

  if (typeof update.defaultSkill === "string") {
    entries.push(["default_skill", update.defaultSkill]);
  }

  if (typeof update.permissionMode === "string") {
    entries.push(["permission_mode", update.permissionMode]);
  }

  if (entries.length === 0) {
    return;
  }

  const nextConfig = setFlatYamlSectionKeys(rawConfig, RUNTIME_SECTION_NAME, entries);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, nextConfig, "utf8");
};

export const readHostConfigText = async (
  configPath = process.env.DUMPLBOT_CONFIG_PATH ?? DEFAULT_CONFIG_PATH,
): Promise<string> => {
  try {
    return await readFile(configPath, "utf8");
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

export const writeImportedHostConfig = async (
  rawConfig: string,
  configPath = process.env.DUMPLBOT_CONFIG_PATH ?? DEFAULT_CONFIG_PATH,
): Promise<ImportedHostRuntimeConfig> => {
  const importedConfig = parseImportedHostRuntimeConfig(rawConfig);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, normalizeConfigText(rawConfig), "utf8");
  return importedConfig;
};
