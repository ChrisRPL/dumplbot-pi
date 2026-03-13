import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { DumplSkill, PermissionMode } from "../../../packages/core/src";

const SKILLS_ROOT = process.env.DUMPLBOT_SKILLS_ROOT ?? resolve(process.cwd(), "skills");
const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/u;
const PERMISSION_MODES = new Set<PermissionMode>(["strict", "balanced", "permissive"]);
const REASONING_LEVELS = new Set(["low", "medium", "high"]);

const normalizeScalar = (value: string): string =>
  value.trim().replace(/^['"]|['"]$/gu, "");

export const normalizeSkillId = (skillId: string): string => {
  const normalized = normalizeScalar(skillId).toLowerCase();

  if (!SKILL_ID_PATTERN.test(normalized)) {
    throw new Error("skill id is invalid");
  }

  return normalized;
};

const parsePermissionMode = (value: string): PermissionMode => {
  const normalized = normalizeScalar(value) as PermissionMode;

  if (!PERMISSION_MODES.has(normalized)) {
    throw new Error("skill permission_mode is invalid");
  }

  return normalized;
};

const parseReasoningLevel = (value: string): "low" | "medium" | "high" => {
  const normalized = normalizeScalar(value);

  if (!REASONING_LEVELS.has(normalized)) {
    throw new Error("skill model.reasoning is invalid");
  }

  return normalized as "low" | "medium" | "high";
};

const summarizePromptPrelude = (promptPrelude: string): string => {
  for (const line of promptPrelude.split(/\r?\n/u)) {
    const trimmedLine = line.trim();

    if (trimmedLine.length > 0) {
      return trimmedLine;
    }
  }

  return "";
};

const parseSkillFile = (rawSkill: string): DumplSkill => {
  let parsedId: string | null = null;
  let permissionMode: PermissionMode = "balanced";
  let modelReasoning: "low" | "medium" | "high" = "medium";
  let state:
    | "none"
    | "prompt_prelude"
    | "tool_allowlist"
    | "bash_prefix_allowlist"
    | "model"
    = "none";
  const promptPreludeLines: string[] = [];
  const toolAllowlist: string[] = [];
  const bashCommandPrefixAllowlist: string[] = [];

  for (const rawLine of rawSkill.split(/\r?\n/u)) {
    const trimmedLine = rawLine.trim();

    if (state === "prompt_prelude") {
      if (rawLine.startsWith("  ")) {
        promptPreludeLines.push(rawLine.slice(2));
        continue;
      }

      state = "none";
    }

    if (state === "tool_allowlist") {
      if (rawLine.startsWith("  - ")) {
        const toolName = normalizeScalar(rawLine.slice(4));

        if (!toolName) {
          throw new Error("skill tool_allowlist includes an empty entry");
        }

        toolAllowlist.push(toolName);
        continue;
      }

      if (trimmedLine.length === 0 || trimmedLine.startsWith("#")) {
        continue;
      }

      state = "none";
    }

    if (state === "bash_prefix_allowlist") {
      if (rawLine.startsWith("  - ")) {
        const commandPrefix = normalizeScalar(rawLine.slice(4));

        if (!commandPrefix) {
          throw new Error("skill bash_prefix_allowlist includes an empty entry");
        }

        bashCommandPrefixAllowlist.push(commandPrefix);
        continue;
      }

      if (trimmedLine.length === 0 || trimmedLine.startsWith("#")) {
        continue;
      }

      state = "none";
    }

    if (state === "model") {
      if (rawLine.startsWith("  ")) {
        if (trimmedLine.length === 0 || trimmedLine.startsWith("#")) {
          continue;
        }

        const separatorIndex = trimmedLine.indexOf(":");

        if (separatorIndex <= 0) {
          continue;
        }

        const key = trimmedLine.slice(0, separatorIndex).trim();
        const value = trimmedLine.slice(separatorIndex + 1).trim();

        if (key === "reasoning") {
          modelReasoning = parseReasoningLevel(value);
        }

        continue;
      }

      state = "none";
    }

    if (!trimmedLine || trimmedLine.startsWith("#")) {
      continue;
    }

    if (rawLine.startsWith(" ")) {
      continue;
    }

    const separatorIndex = trimmedLine.indexOf(":");

    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    const value = trimmedLine.slice(separatorIndex + 1).trim();

    if (key === "id") {
      parsedId = normalizeSkillId(value);
      continue;
    }

    if (key === "prompt_prelude") {
      if (value === "|") {
        state = "prompt_prelude";
      } else {
        promptPreludeLines.push(normalizeScalar(value));
      }
      continue;
    }

    if (key === "tool_allowlist") {
      state = "tool_allowlist";
      continue;
    }

    if (key === "bash_prefix_allowlist") {
      state = "bash_prefix_allowlist";
      continue;
    }

    if (key === "permission_mode") {
      permissionMode = parsePermissionMode(value);
      continue;
    }

    if (key === "model") {
      state = "model";
    }
  }

  if (!parsedId) {
    throw new Error("skill id is required");
  }

  const uniqueAllowlist = Array.from(new Set(toolAllowlist));
  const uniqueBashPrefixAllowlist = Array.from(new Set(bashCommandPrefixAllowlist));

  if (uniqueAllowlist.length === 0) {
    throw new Error("skill tool_allowlist is required");
  }

  return {
    id: parsedId,
    promptPrelude: promptPreludeLines.join("\n").trimEnd(),
    toolAllowlist: uniqueAllowlist,
    bashCommandPrefixAllowlist: uniqueBashPrefixAllowlist,
    permissionMode,
    model: {
      reasoning: modelReasoning,
    },
  };
};

const getSkillPath = (skillId: string): string =>
  join(SKILLS_ROOT, normalizeSkillId(skillId), "skill.yaml");

export type SkillSummary = {
  id: string;
  permissionMode: PermissionMode;
  toolAllowlist: string[];
  bashCommandPrefixAllowlist: string[];
  promptPreludeSummary: string;
  modelReasoning: DumplSkill["model"]["reasoning"];
};

export const loadSkill = async (skillId: string): Promise<DumplSkill> => {
  const normalizedSkillId = normalizeSkillId(skillId);
  const skillPath = getSkillPath(normalizedSkillId);
  let rawSkill: string;

  try {
    rawSkill = await readFile(skillPath, "utf8");
  } catch (error) {
    const isMissingSkill =
      error instanceof Error
      && "code" in error
      && error.code === "ENOENT";

    if (isMissingSkill) {
      throw new Error("skill not found");
    }

    throw error;
  }

  const parsedSkill = parseSkillFile(rawSkill);

  if (parsedSkill.id !== normalizedSkillId) {
    throw new Error("skill id does not match path");
  }

  return parsedSkill;
};

export const listSkills = async (): Promise<SkillSummary[]> => {
  let rootEntries;

  try {
    rootEntries = await readdir(SKILLS_ROOT, { withFileTypes: true });
  } catch (error) {
    const isMissingDirectory =
      error instanceof Error
      && "code" in error
      && error.code === "ENOENT";

    if (isMissingDirectory) {
      return [];
    }

    throw error;
  }

  const skillSummaries: SkillSummary[] = [];

  for (const rootEntry of rootEntries) {
    if (!rootEntry.isDirectory()) {
      continue;
    }

    let normalizedSkillId: string;

    try {
      normalizedSkillId = normalizeSkillId(rootEntry.name);
    } catch {
      continue;
    }

    const skill = await loadSkill(normalizedSkillId);
    skillSummaries.push({
      id: skill.id,
      permissionMode: skill.permissionMode,
      toolAllowlist: [...skill.toolAllowlist],
      bashCommandPrefixAllowlist: [...skill.bashCommandPrefixAllowlist],
      promptPreludeSummary: summarizePromptPrelude(skill.promptPrelude),
      modelReasoning: skill.model.reasoning,
    });
  }

  return skillSummaries.sort((left, right) => left.id.localeCompare(right.id));
};
