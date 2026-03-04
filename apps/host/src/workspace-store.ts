import { access, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export type WorkspaceSummary = {
  id: string;
  hasInstructions: boolean;
};

export type CreateWorkspaceInput = {
  id: string;
  instructions?: string;
};

export type CreatedWorkspace = {
  id: string;
  workspacePath: string;
  instructionsPath: string;
};

const WORKSPACES_ROOT = process.env.DUMPLBOT_WORKSPACES_ROOT
  ?? resolve(process.cwd(), "workspaces");
const WORKSPACE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/u;
const DEFAULT_WORKSPACE_INSTRUCTIONS = `# Workspace

## Goal

- General-purpose local coding and research.

## Boundaries

- Stay inside the active workspace unless the user explicitly broadens scope.
- Prefer web tools over shell network commands.
- Keep changes small, observable, and easy to revert.
`;

export const normalizeWorkspaceId = (workspaceId: string): string => {
  const normalized = workspaceId.trim().toLowerCase();

  if (!WORKSPACE_ID_PATTERN.test(normalized)) {
    throw new Error("workspace id is invalid");
  }

  return normalized;
};

const normalizeWorkspaceInstructions = (instructions: string | undefined): string => {
  const normalized = (instructions ?? DEFAULT_WORKSPACE_INSTRUCTIONS).trim();

  if (!normalized) {
    throw new Error("workspace instructions are required");
  }

  return `${normalized}\n`;
};

export const getWorkspacePath = (workspaceId: string): string =>
  join(WORKSPACES_ROOT, normalizeWorkspaceId(workspaceId));

export const getExistingWorkspacePath = async (workspaceId: string): Promise<string> => {
  const workspacePath = getWorkspacePath(workspaceId);

  let workspaceStats;

  try {
    workspaceStats = await stat(workspacePath);
  } catch {
    throw new Error("workspace not found");
  }

  if (!workspaceStats.isDirectory()) {
    throw new Error("workspace not found");
  }

  return workspacePath;
};

export const createWorkspace = async (
  input: CreateWorkspaceInput,
): Promise<CreatedWorkspace> => {
  const workspaceId = normalizeWorkspaceId(input.id);
  const workspacePath = getWorkspacePath(workspaceId);
  const instructionsPath = join(workspacePath, "CLAUDE.md");

  try {
    const existing = await stat(workspacePath);

    if (existing.isDirectory()) {
      throw new Error("workspace already exists");
    }
  } catch (error) {
    const isMissingWorkspace =
      error instanceof Error
      && "code" in error
      && error.code === "ENOENT";

    if (!isMissingWorkspace) {
      throw error;
    }
  }

  await mkdir(WORKSPACES_ROOT, { recursive: true });
  await mkdir(workspacePath);
  await writeFile(
    instructionsPath,
    normalizeWorkspaceInstructions(input.instructions),
    "utf8",
  );

  return {
    id: workspaceId,
    workspacePath,
    instructionsPath,
  };
};

const hasWorkspaceInstructions = async (workspacePath: string): Promise<boolean> => {
  const instructionPath = join(workspacePath, "CLAUDE.md");

  try {
    await access(instructionPath);
    return true;
  } catch {
    return false;
  }
};

export const listWorkspaces = async (): Promise<WorkspaceSummary[]> => {
  let rootEntries;

  try {
    rootEntries = await readdir(WORKSPACES_ROOT, { withFileTypes: true });
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

  const directoryEntries = rootEntries.filter((entry) => entry.isDirectory());
  const summaries: WorkspaceSummary[] = [];

  for (const directoryEntry of directoryEntries) {
    try {
      const workspaceId = normalizeWorkspaceId(directoryEntry.name);
      const workspacePath = join(WORKSPACES_ROOT, workspaceId);
      const hasInstructions = await hasWorkspaceInstructions(workspacePath);

      summaries.push({
        id: workspaceId,
        hasInstructions,
      });
    } catch {
      continue;
    }
  }

  return summaries.sort((left, right) => left.id.localeCompare(right.id));
};
