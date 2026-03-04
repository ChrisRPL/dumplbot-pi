import { access, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export type WorkspaceSummary = {
  id: string;
  hasInstructions: boolean;
};

const WORKSPACES_ROOT = process.env.DUMPLBOT_WORKSPACES_ROOT
  ?? resolve(process.cwd(), "workspaces");
const WORKSPACE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/u;

export const normalizeWorkspaceId = (workspaceId: string): string => {
  const normalized = workspaceId.trim().toLowerCase();

  if (!WORKSPACE_ID_PATTERN.test(normalized)) {
    throw new Error("workspace id is invalid");
  }

  return normalized;
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
