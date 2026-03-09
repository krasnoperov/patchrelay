import readline from "node:readline";

const scenario = process.argv[2] ?? "normal";
const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function buildThread(id, cwd = "/tmp/worktree") {
  return {
    id,
    preview: "PatchRelay stage",
    cwd,
    status: "idle",
    path: `${cwd}/thread.json`,
    turns: [
      {
        id: "turn-1",
        status: "completed",
        items: [{ type: "agentMessage", id: "assistant-1", text: "Hello from fake codex." }],
      },
    ],
  };
}

rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  const message = JSON.parse(line);

  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        serverInfo: {
          name: "fake-codex",
          version: "0.0.1",
        },
      },
    });
    return;
  }

  if (message.method === "initialized") {
    send({
      jsonrpc: "2.0",
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: {
        command: "npm test",
      },
    });
    return;
  }

  if (message.id === "approval-1") {
    send({
      jsonrpc: "2.0",
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
      },
    });
    return;
  }

  if (message.method === "thread/start") {
    if (scenario === "pending-close") {
      setTimeout(() => process.exit(7), 10);
      return;
    }

    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        thread: buildThread("thread-1", message.params.cwd),
      },
    });
    return;
  }

  if (message.method === "thread/resume") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        thread: buildThread(String(message.params.threadId), message.params.cwd ?? "/tmp/resumed"),
      },
    });
    return;
  }

  if (message.method === "thread/fork") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        thread: buildThread("thread-forked", message.params.cwd ?? "/tmp/forked"),
      },
    });
    return;
  }

  if (message.method === "turn/start") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        turn: {
          id: "turn-2",
          status: "inProgress",
        },
      },
    });
    return;
  }

  if (message.method === "thread/read") {
    if (scenario === "error-response") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          message: "thread read failed",
        },
      });
      return;
    }

    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        thread: buildThread(String(message.params.threadId), "/tmp/read"),
      },
    });
    return;
  }

  if (message.method === "thread/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        data: [buildThread("thread-1"), buildThread("thread-2", "/tmp/other")],
      },
    });
  }
});
