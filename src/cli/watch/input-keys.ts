export function isPromptBackspaceKey(input: string, key: { backspace?: boolean; ctrl?: boolean }): boolean {
  return key.backspace === true
    || input === "\u0008"
    || input === "\u007f"
    || (key.ctrl === true && input === "h");
}

export function isPromptDeleteKey(input: string, key: { delete?: boolean }): boolean {
  return key.delete === true || input === "\u001b[3~";
}

export function getPromptEditAction(params: {
  input: string;
  key: { backspace?: boolean; ctrl?: boolean; delete?: boolean };
  cursor: number;
  bufferLength: number;
}): "backspace" | "delete" | null {
  if (isPromptBackspaceKey(params.input, params.key)) {
    return "backspace";
  }
  if (isPromptDeleteKey(params.input, params.key)) {
    // Some terminal stacks normalize physical backspace as `delete` with
    // empty input. At end-of-line, treat that as backward delete so prompt
    // editing still works instead of turning into a no-op.
    if (params.input === "" && params.cursor >= params.bufferLength) {
      return "backspace";
    }
    return "delete";
  }
  return null;
}
