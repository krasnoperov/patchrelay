import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type { PromptCustomizationLayer, PromptFileFragment } from "./types.ts";

const promptLayerSchema = z.object({
  extraInstructionsFile: z.string().min(1).optional(),
  replaceSections: z.record(z.string().min(1), z.string().min(1)).default({}),
});
type PromptLayerConfig = z.infer<typeof promptLayerSchema>;

const reviewQuillCustomizationSchema = z.object({
  version: z.literal(1),
  prompt: promptLayerSchema.default({
    replaceSections: {},
  }),
});

function configPath(repoRoot: string): string {
  return path.join(repoRoot, ".patchrelay", "review-quill.json");
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
  layer: PromptLayerConfig,
): PromptCustomizationLayer {
  return {
    ...(layer.extraInstructionsFile
      ? { extraInstructions: readPromptFile(repoRoot, layer.extraInstructionsFile) }
      : {}),
    replaceSections: Object.fromEntries(
      Object.entries(layer.replaceSections).map(([sectionId, fragmentPath]) => [sectionId, readPromptFile(repoRoot, fragmentPath)]),
    ),
  };
}

export function loadReviewQuillRepoPrompting(params: {
  repoRoot: string;
  logger: Logger;
}): PromptCustomizationLayer | undefined {
  try {
    const filePath = configPath(params.repoRoot);
    if (!existsSync(filePath)) {
      return undefined;
    }
    const raw = readFileSync(filePath, "utf8");
    const parsed = reviewQuillCustomizationSchema.parse(JSON.parse(raw) as unknown);
    return loadPromptLayer(params.repoRoot, parsed.prompt);
  } catch (error) {
    params.logger.warn(
      { error: error instanceof Error ? error.message : String(error), repoRoot: params.repoRoot },
      "Review Quill repo prompt customization could not be loaded",
    );
    return undefined;
  }
}
