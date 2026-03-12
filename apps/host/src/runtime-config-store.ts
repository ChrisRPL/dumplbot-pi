import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { PermissionMode } from "../../../packages/core/src";

const DEFAULT_CONFIG_PATH = "/etc/dumplbot/config.yaml";

type HostRuntimeConfigUpdate = {
  defaultWorkspace?: string;
  defaultSkill?: string;
  permissionMode?: PermissionMode;
};

const RUNTIME_SECTION_NAME = "runtime";

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
