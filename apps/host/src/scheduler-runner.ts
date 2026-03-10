import type { ScheduledJobRecord } from "./scheduler-store";

const DEFAULT_HOST = process.env.DUMPLBOT_HOST ?? "127.0.0.1";
const DEFAULT_PORT = Number.parseInt(process.env.DUMPLBOT_PORT ?? "4123", 10);
const SSE_DELIMITER = "\n\n";

export type ScheduledJobRunOutcome = {
  completedAt: string;
  result: string;
  status: "success" | "error";
  durationMs: number;
};

const parseSseEvents = (payload: string): Array<{ eventType: string; data: Record<string, unknown> }> =>
  payload
    .split(SSE_DELIMITER)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      let eventType = "message";
      let data: Record<string, unknown> = {};

      for (const line of chunk.split("\n")) {
        if (line.startsWith("event: ")) {
          eventType = line.slice("event: ".length);
          continue;
        }

        if (line.startsWith("data: ")) {
          data = JSON.parse(line.slice("data: ".length)) as Record<string, unknown>;
        }
      }

      return { eventType, data };
    });

export const runScheduledJob = async (
  job: ScheduledJobRecord,
): Promise<ScheduledJobRunOutcome> => {
  const startedAt = Date.now();
  const payload: { text: string; workspace?: string; skill?: string } = {
    text: job.prompt,
  };

  if (job.workspace) {
    payload.workspace = job.workspace;
  }

  if (job.skill) {
    payload.skill = job.skill;
  }

  try {
    const response = await fetch(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/api/talk`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const completedAt = new Date().toISOString();
    const durationMs = Math.max(0, Date.now() - startedAt);
    const rawBody = await response.text();

    if (!response.ok) {
      return {
        completedAt,
        durationMs,
        status: "error",
        result: rawBody.trim() || `scheduler job failed with HTTP ${response.status}`,
      };
    }

    const events = parseSseEvents(rawBody);
    const errorEvent = events.find((event) => event.eventType === "error");

    if (errorEvent) {
      const errorMessage = typeof errorEvent.data.message === "string"
        ? errorEvent.data.message
        : "scheduler job failed";
      return {
        completedAt,
        durationMs,
        status: "error",
        result: errorMessage,
      };
    }

    const doneEvent = events.find((event) => event.eventType === "done");
    const summary = typeof doneEvent?.data.summary === "string"
      ? doneEvent.data.summary
      : null;
    const tokenText = events
      .filter((event) => event.eventType === "token")
      .map((event) => (typeof event.data.text === "string" ? event.data.text : ""))
      .join("")
      .trim();

    return {
      completedAt,
      durationMs,
      status: "success",
      result: summary || tokenText || "Run finished",
    };
  } catch (error) {
    return {
      completedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - startedAt),
      status: "error",
      result: error instanceof Error ? error.message : String(error),
    };
  }
};
