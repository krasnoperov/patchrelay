import { z } from "zod";

export const stewardHomeConfigSchema = z.object({
  server: z.object({
    public_base_url: z.string().url().optional(),
    bind: z.string().default("127.0.0.1"),
    port_base: z.number().int().positive().default(8790),
    gateway_port: z.number().int().positive().optional(),
  }).default({ bind: "127.0.0.1", port_base: 8790 }),
  logging: z.object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  }).default({ level: "info" }),
});

export type StewardHomeConfig = z.infer<typeof stewardHomeConfigSchema>;

export function parseHomeConfigObject(raw: string, configPath: string): StewardHomeConfig {
  const source = raw.trim() ? raw : "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON config file: ${configPath}: ${message}`);
  }
  return stewardHomeConfigSchema.parse(parsed);
}

export function ensureValidRepoConfig(raw: string, configPath: string) {
  const source = raw.trim() ? raw : "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON repo config: ${configPath}: ${message}`);
  }
  return parsed;
}

export function stringifyJson(config: Record<string, unknown>): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}
