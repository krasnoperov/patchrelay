export function isPromptBackspaceKey(input: string, key: { backspace?: boolean; ctrl?: boolean }): boolean {
  return key.backspace === true
    || input === "\u0008"
    || input === "\u007f"
    || (key.ctrl === true && input === "h");
}

export function isPromptDeleteKey(input: string, key: { delete?: boolean }): boolean {
  return key.delete === true || input === "\u001b[3~";
}
