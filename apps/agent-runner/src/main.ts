import type {
  DumplDoneEvent,
  DumplErrorEvent,
  DumplEvent,
  DumplStatusEvent,
  DumplTokenEvent,
  DumplToolEvent,
} from "../../../packages/core/src";

type RunnerInput = {
  prompt: string;
  workspace?: string;
  skill?: string;
};

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

  return input;
};

const main = async (): Promise<void> => {
  const raw = await readStdIn();
  const input = parseInput(raw);

  for (const event of buildScaffoldEvents(input)) {
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
