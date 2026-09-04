import fastify from "fastify";
import { registerFactoryPage } from "../src/factory/routes.ts";

// Deliberately has no operator API or credentials: this is a local UI preview.
const app = fastify();
registerFactoryPage(app);
app.get("/", async (_request, reply) => reply.redirect("/factory?demo=1"));
const port = Number(process.env.FACTORY_PORT ?? 4317);
await app.listen({ host: "127.0.0.1", port });
console.log(`Circuit City demo: http://127.0.0.1:${port}/factory?demo=1`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
