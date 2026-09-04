import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawServerDefault,
} from "fastify";
import type { FactorySnapshot } from "./types.ts";

const page = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#080d14"><title>Circuit City · PatchRelay</title><link rel="stylesheet" href="/factory/assets/app.css"></head><body><div id="root"></div><script type="module" src="/factory/assets/app.js"></script></body></html>`;

export function registerFactoryPage<L extends FastifyBaseLogger>(
  app: FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, L>,
) {
  app.get("/factory", async (_request, reply) =>
    reply.type("text/html").send(page),
  );
  app.get<{ Params: { asset: string } }>(
    "/factory/assets/:asset",
    async (request, reply) => {
      const asset = request.params.asset;
      if (asset !== "app.js" && asset !== "app.css")
        return reply.code(404).send();
      // This layout works from both src/factory and the published dist/factory.
      const url = import.meta.url.includes("/dist/factory/")
        ? new URL(`./assets/${asset}`, import.meta.url)
        : new URL(`../../dist/factory/assets/${asset}`, import.meta.url);
      try {
        return reply
          .header("cache-control", "no-cache")
          .type(asset.endsWith(".js") ? "text/javascript" : "text/css")
          .send(await readFile(url));
      } catch {
        return reply
          .code(503)
          .type("text/plain")
          .send("Factory assets are not built. Run pnpm build:factory.");
      }
    },
  );
}

export function registerFactoryApi<L extends FastifyBaseLogger>(
  app: FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, L>,
  readSnapshot: () => Promise<FactorySnapshot>,
) {
  const streams = new Set<ServerResponse>();
  app.addHook("preClose", async () => {
    for (const stream of streams) stream.end();
  });
  app.get("/api/factory", async (_request, reply) =>
    reply.header("cache-control", "no-store").send(await readSnapshot()),
  );
  app.get("/api/factory/stream", async (request, reply) => {
    // Complete the initial read before taking ownership of the response.
    const initial = await readSnapshot();
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    streams.add(reply.raw);
    const send = (snapshot: FactorySnapshot) => {
      reply.raw.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    };
    const tick = async () => {
      try {
        const snapshot = await readSnapshot();
        // A slow client must not accumulate an unbounded stream of world copies.
        if (!closed && reply.raw.writableNeedDrain) reply.raw.destroy();
        else if (!closed) send(snapshot);
      } catch {
        if (!closed) reply.raw.write("event: unavailable\ndata: {}\n\n");
      }
      if (!closed) timer = setTimeout(tick, 5000);
    };
    send(initial);
    timer = setTimeout(tick, 5000);
    reply.raw.on("close", () => {
      closed = true;
      streams.delete(reply.raw);
      if (timer) clearTimeout(timer);
    });
    request.log.debug("factory stream connected");
  });
}
