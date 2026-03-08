import type {
  DumplDoneEvent,
  DumplErrorEvent,
  DumplEvent,
  PermissionMode,
  DumplStatusEvent,
  DumplTokenEvent,
  DumplToolEvent,
} from "../../../packages/core/src";
import {
  commandMatchesAllowedPrefix,
  executeCommand,
  parseBashPrompt,
} from "./bash-tool";

type RunnerPolicy = {
  workspace: string;
  skill: string;
  toolAllowlist: string[];
  bashCommandPrefixAllowlist: string[];
  permissionMode: PermissionMode;
};

type RunnerInput = {
  prompt: string;
  workspace?: string;
  skill?: string;
  toolAllowlist: string[];
  policy: RunnerPolicy;
};

const PERMISSION_MODES = new Set<PermissionMode>(["strict", "balanced", "permissive"]);
const INTERNAL_TOOL_NAMES = new Set(["planner"]);

const readStdIn = async (): Promise<string> => {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8").trim();
};

const writeEvent = (event: DumplEvent): void => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

const fail = (message: string): never => {
  const event: DumplErrorEvent = {
    type: "error",
    message,
  };

  writeEvent(event);
  throw new Error(message);
};

const buildScaffoldEvents = (input: RunnerInput): Array<DumplStatusEvent | DumplToolEvent | DumplTokenEvent | DumplDoneEvent> => [
  {
    type: "status",
    message: `Runner started for ${input.workspace ?? "default"}`,
  },
  {
    type: "tool",
    name: "planner",
    detail: input.skill ?? "default",
  },
  {
    type: "token",
    text: `Scaffold response placeholder for: ${input.prompt}`,
  },
  {
    type: "done",
    summary: "Runner scaffold completed.",
  },
];

const parseToolAllowlist = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    fail("runner input must include tool_allowlist");
  }

  const rawAllowlist = value as unknown[];
  const normalizedAllowlist: string[] = [];

  for (const entry of rawAllowlist) {
    if (typeof entry !== "string") {
      fail("runner tool_allowlist entries must be non-empty strings");
    }

    const toolName = (entry as string).trim();

    if (toolName.length === 0) {
      fail("runner tool_allowlist entries must be non-empty strings");
    }

    normalizedAllowlist.push(toolName);
  }

  const dedupedAllowlist = Array.from(new Set(normalizedAllowlist));

  if (dedupedAllowlist.length === 0) {
    fail("runner tool_allowlist must include at least one tool");
  }

  return dedupedAllowlist;
};

const parseBashCommandPrefixAllowlist = (value: unknown): string[] => {
  if (typeof value === "undefined") {
    return [];
  }

  if (!Array.isArray(value)) {
    fail("runner policy.bashCommandPrefixAllowlist must be string array");
  }

  const normalizedAllowlist: string[] = [];

  for (const entry of value as unknown[]) {
    if (typeof entry !== "string") {
      fail("runner policy.bashCommandPrefixAllowlist entries must be non-empty strings");
    }

    const commandPrefix = (entry as string).trim();

    if (commandPrefix.length === 0) {
      fail("runner policy.bashCommandPrefixAllowlist entries must be non-empty strings");
    }

    normalizedAllowlist.push(commandPrefix);
  }

  return Array.from(new Set(normalizedAllowlist));
};

const parsePolicy = (value: unknown): RunnerPolicy => {
  if (!value || typeof value !== "object") {
    fail("runner input must include policy");
  }

  const policyObject = value as {
    workspace?: unknown;
    skill?: unknown;
    toolAllowlist?: unknown;
    bashCommandPrefixAllowlist?: unknown;
    permissionMode?: unknown;
  };

  if (typeof policyObject.workspace !== "string" || policyObject.workspace.trim().length === 0) {
    fail("runner policy.workspace must be non-empty string");
  }

  if (typeof policyObject.skill !== "string" || policyObject.skill.trim().length === 0) {
    fail("runner policy.skill must be non-empty string");
  }

  if (
    typeof policyObject.permissionMode !== "string"
    || !PERMISSION_MODES.has(policyObject.permissionMode as PermissionMode)
  ) {
    fail("runner policy.permissionMode is invalid");
  }

  const parsedToolAllowlist = parseToolAllowlist(policyObject.toolAllowlist);
  const parsedBashCommandPrefixAllowlist = parseBashCommandPrefixAllowlist(
    policyObject.bashCommandPrefixAllowlist,
  );

  if (parsedToolAllowlist.includes("bash") && parsedBashCommandPrefixAllowlist.length === 0) {
    fail("runner bash tool requires command prefix allowlist");
  }

  return {
    workspace: (policyObject.workspace as string).trim(),
    skill: (policyObject.skill as string).trim(),
    toolAllowlist: parsedToolAllowlist,
    bashCommandPrefixAllowlist: parsedBashCommandPrefixAllowlist,
    permissionMode: policyObject.permissionMode as PermissionMode,
  };
};

const enforcePermissionMode = (policy: RunnerPolicy): void => {
  if (policy.permissionMode === "strict" && policy.toolAllowlist.includes("bash")) {
    fail("runner strict mode forbids bash tool");
  }
};

const assertToolAllowedByPolicy = (policy: RunnerPolicy, toolName: string): void => {
  if (INTERNAL_TOOL_NAMES.has(toolName)) {
    return;
  }

  if (!policy.toolAllowlist.includes(toolName)) {
    fail(`runner policy blocked tool: ${toolName}`);
  }
};

const assertBashCommandAllowedByPolicy = (
  policy: RunnerPolicy,
  commandArgv: string[],
): void => {
  if (!policy.toolAllowlist.includes("bash")) {
    fail("runner policy blocked tool: bash");
  }

  const commandAllowed = policy.bashCommandPrefixAllowlist.some((allowedPrefix) =>
    commandMatchesAllowedPrefix(commandArgv, allowedPrefix),
  );

  if (!commandAllowed) {
    fail("runner policy blocked bash command prefix");
  }
};

const buildRunnerStartedEvent = (input: RunnerInput): DumplStatusEvent => ({
  type: "status",
  message: `Runner started for ${input.workspace ?? "default"}`,
});

const runPromptAsTool = async (input: RunnerInput): Promise<boolean> => {
  let bashInvocation;

  try {
    bashInvocation = parseBashPrompt(input.prompt);
  } catch (error) {
    const message = error instanceof Error ? error.message : "runner bash command is invalid";
    fail(message);
  }

  if (!bashInvocation) {
    return false;
  }

  writeEvent(buildRunnerStartedEvent(input));
  assertBashCommandAllowedByPolicy(input.policy, bashInvocation.argv);

  const toolEvent: DumplToolEvent = {
    type: "tool",
    name: "bash",
    detail: bashInvocation.detail,
  };
  writeEvent(toolEvent);

  let result: { stdout: string; stderr: string } | null = null;

  try {
    result = await executeCommand(bashInvocation.argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : "runner bash command failed";
    fail(message);
  }

  if (!result) {
    fail("runner bash command failed");
  }

  const resolvedResult = result as { stdout: string; stderr: string };
  const output = resolvedResult.stdout.trimEnd() || resolvedResult.stderr.trimEnd();

  if (output.length > 0) {
    const tokenEvent: DumplTokenEvent = {
      type: "token",
      text: output,
    };
    writeEvent(tokenEvent);
  }

  const doneEvent: DumplDoneEvent = {
    type: "done",
    summary: "Bash tool completed.",
  };
  writeEvent(doneEvent);
  return true;
};

const parseInput = (raw: string): RunnerInput => {
  if (raw.length === 0) {
    fail("runner input is required");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("runner input must be valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || !("prompt" in parsed)) {
    fail("runner input must include prompt");
  }

  const input = parsed as RunnerInput;

  if (!input.prompt || input.prompt.trim().length === 0) {
    fail("prompt must be non-empty");
  }

  const parsedToolAllowlist = parseToolAllowlist(
    (parsed as { toolAllowlist?: unknown }).toolAllowlist,
  );
  const parsedPolicy = parsePolicy((parsed as { policy?: unknown }).policy);
  const topLevelAllowlist = parsedToolAllowlist.join("\u0000");
  const policyAllowlist = parsedPolicy.toolAllowlist.join("\u0000");

  if (topLevelAllowlist !== policyAllowlist) {
    fail("runner policy tool_allowlist mismatch");
  }

  if (input.workspace && input.workspace.trim() !== parsedPolicy.workspace) {
    fail("runner policy workspace mismatch");
  }

  if (input.skill && input.skill.trim() !== parsedPolicy.skill) {
    fail("runner policy skill mismatch");
  }

  enforcePermissionMode(parsedPolicy);

  return {
    ...input,
    workspace: parsedPolicy.workspace,
    skill: parsedPolicy.skill,
    toolAllowlist: parsedToolAllowlist,
    policy: parsedPolicy,
  };
};

const main = async (): Promise<void> => {
  const raw = await readStdIn();
  const input = parseInput(raw);
  const promptHandledAsTool = await runPromptAsTool(input);

  if (promptHandledAsTool) {
    return;
  }

  for (const event of buildScaffoldEvents(input)) {
    if (event.type === "tool") {
      assertToolAllowedByPolicy(input.policy, event.name);
    }

    writeEvent(event);
  }
};

void main().catch((error) => {
  process.exitCode = 1;

  if (error instanceof Error) {
    process.stderr.write(`${error.message}\n`);
    return;
  }

  process.stderr.write("unknown error\n");
});
