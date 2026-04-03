#!/usr/bin/env node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const HOST = "127.0.0.1";
const HOST_PORT = 4143;
const MODEL_PORT = 4144;
const SSE_DELIMITER = "\n\n";

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const parseSsePayload = (payload) =>
  payload
    .split(SSE_DELIMITER)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      let eventType = "message";
      let data = {};

      for (const line of chunk.split("\n")) {
        if (line.startsWith("event: ")) {
          eventType = line.slice("event: ".length);
        } else if (line.startsWith("data: ")) {
          data = JSON.parse(line.slice("data: ".length));
        }
      }

      return { eventType, data };
    });

const waitForServerReady = (childProcess) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("host server did not start in time"));
    }, 8000);

    const onData = (chunk) => {
      const text = chunk.toString("utf8");

      if (text.includes("dumplbotd listening")) {
        clearTimeout(timeout);
        childProcess.stdout.off("data", onData);
        resolve();
      }
    };

    childProcess.stdout.on("data", onData);
    childProcess.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`host server exited early: ${code ?? "unknown"}`));
    });
  });

const readJsonBody = (request) =>
  new Promise((resolve, reject) => {
    const chunks = [];

    request.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });

const writeFakeResponseEvent = (response, payload) => {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
};

const startFakeModelServer = async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.statusCode = 404;
      response.end("not found");
      return;
    }

    const payload = await readJsonBody(request);
    requests.push(payload);

    response.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
    });

    if (payload.input === "cancel me") {
      writeFakeResponseEvent(response, {
        type: "response.output_text.delta",
        delta: "cancel-start",
      });
      const interval = setInterval(() => {
        writeFakeResponseEvent(response, {
          type: "response.output_text.delta",
          delta: ".",
        });
      }, 250);
      response.once("close", () => {
        clearInterval(interval);
      });
      return;
    }

    writeFakeResponseEvent(response, {
      type: "response.output_text.delta",
      delta: "smoke ",
    });
    writeFakeResponseEvent(response, {
      type: "response.output_text.delta",
      delta: "model ",
    });
    writeFakeResponseEvent(response, {
      type: "response.output_text.delta",
      delta: "reply",
    });
    writeFakeResponseEvent(response, {
      type: "response.completed",
    });
    response.end();
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(MODEL_PORT, HOST, resolve);
  });

  return { server, requests };
};

const startHostServer = async (
  tmpRoot,
  workspaceRoot,
  skillsRoot,
) => {
  const childProcess = spawn(
    process.execPath,
    ["dist/apps/host/src/main.js"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        DUMPLBOT_HOST: HOST,
        DUMPLBOT_PORT: String(HOST_PORT),
        DUMPLBOT_TMP_ROOT: tmpRoot,
        DUMPLBOT_WORKSPACES_ROOT: workspaceRoot,
        DUMPLBOT_SKILLS_ROOT: skillsRoot,
        DUMPLBOT_SANDBOX_ENABLED: "false",
        DUMPLBOT_MODEL_BASE_URL: `http://${HOST}:${MODEL_PORT}`,
        OPENAI_API_KEY: "test-openai-key",
      },
    },
  );

  await waitForServerReady(childProcess);
  return childProcess;
};

const stopHostServer = async (childProcess) => {
  if (childProcess.exitCode !== null) {
    return;
  }

  childProcess.kill("SIGINT");
  await new Promise((resolve) => {
    childProcess.once("exit", resolve);
    setTimeout(() => resolve(), 3000);
  });
};

const waitForWorkspaceHistory = async (baseUrl, workspaceId, expectedCount) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/history`);

    if (response.ok) {
      const payload = await response.json();

      if (payload.total >= expectedCount) {
        return payload;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`workspace history did not reach ${expectedCount} entries in time`);
};

const runSmoke = async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), "dumplbot-model-reply-smoke-"));
  const workspaceRoot = join(tmpRoot, "workspaces");
  const skillsRoot = join(tmpRoot, "skills");
  const defaultWorkspaceRoot = join(workspaceRoot, "default");
  const codingSkillRoot = join(skillsRoot, "coding");

  await mkdir(defaultWorkspaceRoot, { recursive: true });
  await mkdir(codingSkillRoot, { recursive: true });
  await writeFile(
    join(defaultWorkspaceRoot, "CLAUDE.md"),
    [
      "# Workspace",
      "",
      "## Goal",
      "",
      "- Default smoke workspace.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(codingSkillRoot, "skill.yaml"),
    [
      "id: coding",
      "prompt_prelude: |",
      "  You are in coding mode. Prefer file edits, tests, and concise execution updates.",
      "tool_allowlist:",
      "  - read_file",
      "permission_mode: balanced",
      "model:",
      "  reasoning: high",
      "",
    ].join("\n"),
    "utf8",
  );

  const fakeModelServer = await startFakeModelServer();
  const hostServer = await startHostServer(
    tmpRoot,
    workspaceRoot,
    skillsRoot,
  );
  const baseUrl = `http://${HOST}:${HOST_PORT}`;

  try {
    const talkResponse = await fetch(`${baseUrl}/api/talk`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    assert(talkResponse.status === 200, "expected /api/talk to return 200 SSE");
    assert(
      typeof talkResponse.headers.get("x-dumplbot-run-id") === "string",
      "expected run id header for model reply",
    );

    const talkEvents = parseSsePayload(await talkResponse.text());
    const tokenText = talkEvents
      .filter((event) => event.eventType === "token")
      .map((event) => String(event.data?.text ?? ""))
      .join("");
    const thinkingEvent = talkEvents.find(
      (event) => event.eventType === "status" && event.data?.message === "Thinking",
    );
    const doneEvent = talkEvents.find((event) => event.eventType === "done");

    assert(thinkingEvent, "expected model reply thinking status");
    assert(tokenText === "smoke model reply", "expected streamed model reply token text");
    assert(
      doneEvent?.data?.summary === "Model reply completed.",
      "expected model reply completion summary",
    );

    assert(fakeModelServer.requests.length >= 1, "expected one fake model request");
    const firstRequest = fakeModelServer.requests[0];
    assert(firstRequest.input === "hello", "unexpected model request prompt");
    assert(firstRequest.reasoning?.effort === "high", "expected model reasoning effort from skill");
    assert(
      String(firstRequest.instructions ?? "").includes("coding mode"),
      "expected skill prompt prelude in model instructions",
    );
    assert(
      String(firstRequest.instructions ?? "").includes("Active workspace: default"),
      "expected workspace id in model instructions",
    );
    assert(
      String(firstRequest.instructions ?? "").includes("Default smoke workspace."),
      "expected workspace instructions in model request",
    );

    const workspaceHistory = await waitForWorkspaceHistory(baseUrl, "default", 1);
    assert(workspaceHistory.total === 1, "expected one history entry after model reply");
    assert(workspaceHistory.history[0]?.prompt === "hello", "unexpected history prompt");
    assert(workspaceHistory.history[0]?.status === "success", "expected successful model history entry");

    const cancelTalkResponse = await fetch(`${baseUrl}/api/talk`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "cancel me" }),
    });
    assert(cancelTalkResponse.status === 200, "expected cancel /api/talk to return 200 SSE");

    const cancelRunId = cancelTalkResponse.headers.get("x-dumplbot-run-id");
    assert(cancelRunId, "expected run id header for canceling model reply");

    await new Promise((resolve) => setTimeout(resolve, 150));

    const cancelResponse = await fetch(`${baseUrl}/api/runs/${cancelRunId}/cancel`, {
      method: "POST",
    });
    assert(cancelResponse.status === 202, "expected cancel route to accept model reply cancel");

    const cancelEvents = parseSsePayload(await cancelTalkResponse.text());
    const cancelErrorEvent = cancelEvents.find((event) => event.eventType === "error");
    const cancelDoneEvent = cancelEvents.find((event) => event.eventType === "done");

    assert(cancelErrorEvent, "expected cancel to terminate model reply with error");
    assert(cancelErrorEvent.data?.message === "run canceled", "unexpected model cancel error");
    assert(!cancelDoneEvent, "unexpected done event after model cancel");

    const canceledHistory = await waitForWorkspaceHistory(baseUrl, "default", 2);
    assert(canceledHistory.history[1]?.status === "error", "expected canceled history entry status");
    assert(canceledHistory.history[1]?.summary === "run canceled", "unexpected canceled history summary");

    console.log("model reply smoke ok");
  } finally {
    await stopHostServer(hostServer);
    await new Promise((resolve) => {
      fakeModelServer.server.close(resolve);
    });
    await rm(tmpRoot, { recursive: true, force: true });
  }
};

runSmoke().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
