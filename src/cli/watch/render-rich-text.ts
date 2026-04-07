export interface TextSegment {
  text: string;
  color?: string | undefined;
  dimColor?: boolean | undefined;
  bold?: boolean | undefined;
}

export interface TextLine {
  key: string;
  segments: TextSegment[];
}

interface TextStyle {
  color?: string | undefined;
  dimColor?: boolean | undefined;
  bold?: boolean | undefined;
}

interface RenderTextOptions {
  key: string;
  width: number;
  firstPrefix?: TextSegment[] | undefined;
  continuationPrefix?: TextSegment[] | undefined;
  style?: TextStyle | undefined;
}

interface RenderRichTextOptions extends RenderTextOptions {
  codeColor?: string | undefined;
}

const richTextCache = new Map<string, TextLine[]>();

export function lineToPlainText(line: TextLine): string {
  return line.segments.map((segment) => segment.text).join("");
}

export function renderTextLines(text: string, options: RenderTextOptions): TextLine[] {
  const width = Math.max(8, options.width);
  const sourceLines = text.length === 0 ? [""] : text.split("\n");
  const lines: TextLine[] = [];

  for (let index = 0; index < sourceLines.length; index += 1) {
    const sourceLine = sourceLines[index] ?? "";
    const wrapped = wrapSegments(
      tokenizeSegments([{ text: sourceLine, ...(options.style ?? {}) }]),
      width,
      index === 0 ? options.firstPrefix : options.continuationPrefix ?? options.firstPrefix,
      options.continuationPrefix ?? options.firstPrefix,
      `${options.key}-${index}`,
    );
    lines.push(...wrapped);
  }

  return lines.length > 0 ? lines : [{ key: `${options.key}-0`, segments: [] }];
}

export function renderRichTextLines(text: string, options: RenderRichTextOptions): TextLine[] {
  const width = Math.max(8, options.width);
  const cacheKey = [
    options.key,
    width,
    segmentsKey(options.firstPrefix),
    segmentsKey(options.continuationPrefix),
    styleKey(options.style),
    options.codeColor ?? "",
    text,
  ].join("\u0000");
  const cached = richTextCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const lines: TextLine[] = [];
  const inputLines = text.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  let inCodeBlock = false;
  let codeLines: string[] = [];
  let blockIndex = 0;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const paragraphText = paragraph.join(" ").replace(/\s+/g, " ").trim();
    if (paragraphText.length > 0) {
      lines.push(...wrapSegments(
        tokenizeSegments(parseInlineMarkdown(paragraphText, options.style)),
        width,
        lines.length === 0 ? options.firstPrefix : options.continuationPrefix ?? options.firstPrefix,
        options.continuationPrefix ?? options.firstPrefix,
        `${options.key}-p-${blockIndex}`,
      ));
      blockIndex += 1;
    }
    paragraph = [];
  };

  const flushCodeBlock = () => {
    if (codeLines.length === 0) return;
    for (const codeLine of codeLines) {
      lines.push(...renderTextLines(codeLine, {
        key: `${options.key}-code-${blockIndex}`,
        width,
        firstPrefix: lines.length === 0 ? options.firstPrefix : options.continuationPrefix ?? options.firstPrefix,
        continuationPrefix: options.continuationPrefix ?? options.firstPrefix,
        style: { color: options.codeColor ?? "green" },
      }));
      blockIndex += 1;
    }
    codeLines = [];
  };

  const pushBlankLine = () => {
    lines.push({ key: `${options.key}-blank-${blockIndex}`, segments: [] });
    blockIndex += 1;
  };

  for (const rawLine of inputLines) {
    const line = rawLine ?? "";
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      flushParagraph();
      if (inCodeBlock) {
        flushCodeBlock();
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    if (trimmed.length === 0) {
      flushParagraph();
      if (lines.length > 0) {
        pushBlankLine();
      }
      continue;
    }

    const bulletMatch = line.match(/^\s*[-*]\s+(.*)$/);
    if (bulletMatch?.[1]) {
      flushParagraph();
      lines.push(...wrapSegments(
        tokenizeSegments(parseInlineMarkdown(bulletMatch[1], options.style)),
        width,
        appendSegments(options.firstPrefix, [{ text: "• ", ...(options.style ?? {}) }]),
        appendSegments(options.continuationPrefix ?? options.firstPrefix, [{ text: "  ", ...(options.style ?? {}) }]),
        `${options.key}-b-${blockIndex}`,
      ));
      blockIndex += 1;
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();
  flushCodeBlock();

  const result = lines.length > 0 ? lines : [{ key: `${options.key}-0`, segments: [] }];
  richTextCache.set(cacheKey, result);
  return result;
}

function parseInlineMarkdown(text: string, style?: TextStyle): TextSegment[] {
  const pattern = /\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*/g;
  const segments: TextSegment[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, index), ...(style ?? {}) });
    }

    if (match[1] && match[2]) {
      segments.push({ text: match[1], color: "cyan", bold: true });
      segments.push({ text: ` (${match[2]})`, dimColor: true });
    } else if (match[3]) {
      segments.push({ text: match[3], color: "yellow", bold: true });
    } else if (match[4]) {
      segments.push({ text: match[4], ...(style ?? {}), bold: true });
    }

    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), ...(style ?? {}) });
  }

  return segments.length > 0 ? segments : [{ text, ...(style ?? {}) }];
}

function wrapSegments(
  tokens: TextSegment[],
  width: number,
  firstPrefix: TextSegment[] | undefined,
  continuationPrefix: TextSegment[] | undefined,
  keyPrefix: string,
): TextLine[] {
  const initialPrefix = cloneSegments(firstPrefix);
  const nextPrefix = cloneSegments(continuationPrefix);
  const lines: TextLine[] = [];
  let currentSegments = initialPrefix;
  let currentWidth = segmentsWidth(initialPrefix);
  let lineHasContent = false;
  let lineIndex = 0;

  const pushLine = () => {
    lines.push({
      key: `${keyPrefix}-${lineIndex}`,
      segments: trimTrailingSpaces(currentSegments),
    });
    lineIndex += 1;
    currentSegments = cloneSegments(nextPrefix);
    currentWidth = segmentsWidth(currentSegments);
    lineHasContent = false;
  };

  for (const token of tokens) {
    let remaining = token.text.replace(/\t/g, "  ");
    while (remaining.length > 0) {
      const whitespace = remaining.match(/^\s+/)?.[0];
      if (whitespace) {
        const spaceText = lineHasContent ? whitespace : "";
        remaining = remaining.slice(whitespace.length);
        if (spaceText.length === 0) {
          continue;
        }
        if (currentWidth + spaceText.length > width) {
          pushLine();
          continue;
        }
        currentSegments.push({ ...token, text: spaceText });
        currentWidth += spaceText.length;
        continue;
      }

      const word = remaining.match(/^\S+/)?.[0] ?? remaining;
      remaining = remaining.slice(word.length);
      let rest = word;
      while (rest.length > 0) {
        const available = Math.max(1, width - currentWidth);
        if (lineHasContent && rest.length > available) {
          pushLine();
          continue;
        }
        const sliceLength = Math.min(rest.length, available);
        const chunk = rest.slice(0, sliceLength);
        currentSegments.push({ ...token, text: chunk });
        currentWidth += chunk.length;
        lineHasContent = true;
        rest = rest.slice(sliceLength);
        if (rest.length > 0) {
          pushLine();
        }
      }
    }
  }

  if (lines.length === 0 || currentSegments.length > 0 || lineHasContent) {
    lines.push({
      key: `${keyPrefix}-${lineIndex}`,
      segments: trimTrailingSpaces(currentSegments),
    });
  }

  return lines;
}

function tokenizeSegments(segments: TextSegment[]): TextSegment[] {
  return segments.flatMap((segment) => {
    const parts = segment.text.length === 0 ? [""] : segment.text.match(/\s+|\S+/g) ?? [segment.text];
    return parts.map((part) => ({ ...segment, text: part }));
  });
}

function cloneSegments(segments?: TextSegment[]): TextSegment[] {
  return (segments ?? []).map((segment) => ({ ...segment }));
}

function segmentsWidth(segments?: TextSegment[]): number {
  return (segments ?? []).reduce((sum, segment) => sum + segment.text.length, 0);
}

function trimTrailingSpaces(segments: TextSegment[]): TextSegment[] {
  const trimmed = cloneSegments(segments);
  while (trimmed.length > 0 && trimmed[trimmed.length - 1]?.text.trim().length === 0) {
    trimmed.pop();
  }
  return trimmed;
}

function appendSegments(base: TextSegment[] | undefined, extra: TextSegment[]): TextSegment[] {
  return [...cloneSegments(base), ...cloneSegments(extra)];
}

function segmentsKey(segments?: TextSegment[]): string {
  return (segments ?? []).map((segment) => `${segment.text}|${segment.color ?? ""}|${segment.dimColor ? "d" : ""}|${segment.bold ? "b" : ""}`).join(";");
}

function styleKey(style?: TextStyle): string {
  if (!style) return "";
  return `${style.color ?? ""}|${style.dimColor ? "d" : ""}|${style.bold ? "b" : ""}`;
}
