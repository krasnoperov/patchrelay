import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type { PatchRelayPromptingConfig, PromptCustomizationLayer, PromptFileFragment } from "./types.ts";

const promptLayerSchema = z.object({
  extraInstructionsFile: z.string().min(1).optional(),
  replaceSections: z.record(z.string().min(1), z.string().min(1)).default({}),
});

const promptByRunTypeSchema = z.object({
  implementation: promptLayerSchema.optional(),
  main_repair: promptLayerSchema.optional(),
  review_fix: promptLayerSchema.optional(),
  branch_upkeep: promptLayerSchema.optional(),
  ci_repair: promptLayerSchema.optional(),
  queue_repair: promptLayerSchema.optional(),
});
type PromptLayerConfig = z.infer<typeof promptLayerSchema>;

const patchRelayCustomizationSchema = z.object({
  version: z.literal(1),
  prompt: z.object({
    default: promptLayerSchema.default({
      replaceSections: {},
    }),
    byRunType: promptByRunTypeSchema.default({}),
  }).default({
    default: {
      replaceSections: {},
    },
    byRunType: {},
  }),
});

function configPath(repoRoot: string): string {
  return path.join(repoRoot, ".patchrelay", "patchrelay.json");
}

function readPromptFile(repoRoot: string, filePath: string): PromptFileFragment {
  const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(repoRoot, filePath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Prompt file not found: ${resolvedPath}`);
  }
  return {
    sourcePath: resolvedPath,
    content: readFileSync(resolvedPath, "utf8").trim(),
  };
}

function loadPromptLayer(
  repoRoot: string,
  layer: PromptLayerConfig | undefined,
): PromptCustomizationLayer {
  return {
    ...(layer?.extraInstructionsFile
      ? { extraInstructions: readPromptFile(repoRoot, layer.extraInstructionsFile) }
      : {}),
    replaceSections: Object.fromEntries(
      Object.entries(layer?.replaceSections ?? {})
        .map(([sectionId, fragmentPath]) => [sectionId, readPromptFile(repoRoot, fragmentPath)]),
    ),
  };
}

export function loadPatchRelayRepoPrompting(params: {
  repoRoot: string;
  logger: Logger;
}): PatchRelayPromptingConfig | undefined {
  try {
    const filePath = configPath(params.repoRoot);
    if (!existsSync(filePath)) {
      return undefined;
    }
    const raw = readFileSync(filePath, "utf8");
    const parsed = patchRelayCustomizationSchema.parse(JSON.parse(raw) as unknown);
    return {
      default: loadPromptLayer(params.repoRoot, parsed.prompt.default),
      byRunType: Object.fromEntries(
        Object.entries(parsed.prompt.byRunType).map(([runType, layer]) => [runType, loadPromptLayer(params.repoRoot, layer)]),
      ) as PatchRelayPromptingConfig["byRunType"],
    };
  } catch (error) {
    params.logger.warn(
      { error: error instanceof Error ? error.message : String(error), repoRoot: params.repoRoot },
      "PatchRelay repo prompt customization could not be loaded",
    );
    return undefined;
  }
}
