type DispatchCall = {
  readonly callee: "createModelSelection" | "resolveChatComposerDispatchModel";
  readonly args: readonly string[];
};

// Test-only recognizer for exactly the two reviewed initializer forms. It is
// intentionally not a general JS parser: opaque strings/comments cannot form
// bindings, and an unsupported initializer or send-context shape refuses.
function tokens(source: string, preserveStrings = false): string[] {
  const out: string[] = [];
  for (let i = 0; i < source.length;) {
    const char = source[i]!;
    if (/\s/.test(char)) {
      i++;
      continue;
    }
    if (source.startsWith("//", i)) {
      const end = source.indexOf("\n", i + 2);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) throw new Error("Unclosed comment");
      i = end + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      const start = i;
      const quote = char;
      i++;
      let closed = false;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i++] === quote) {
          closed = true;
          break;
        }
      }
      if (!closed) throw new Error("Unclosed opaque string");
      out.push(preserveStrings && quote !== "`" ? source.slice(start, i) : "<opaque>");
      continue;
    }
    const identifier = /^[A-Za-z_$][\w$]*/.exec(source.slice(i));
    if (identifier) {
      out.push(identifier[0]);
      i += identifier[0].length;
      continue;
    }
    if (source.startsWith("=>", i)) {
      out.push("=>");
      i += 2;
      continue;
    }
    out.push(char);
    i++;
  }
  return out;
}

/** Test-only, finite interpretation of the exact resting mount and its JSX use. */
export function readFiniteRestingTraitsMount(source: string): { wrapped: boolean } {
  const input = tokens(source, true);
  const declarations = input.flatMap((token, i) =>
    token === "const" && input[i + 1] === "restingProviderTraitsPicker" ? [i] : [],
  );
  if (declarations.length !== 1) throw new Error("Missing or duplicate resting mount");
  let cursor = declarations[0]! + 2;
  if (input[cursor++] !== "=") throw new Error("Unsupported resting declaration");
  const wrapped = input[cursor] === "withLiveTraitsPersistence";
  if (wrapped) {
    if (input[++cursor] !== "(") throw new Error("Unsupported resting wrapper");
    cursor++;
  }
  const render = [
    "renderProviderTraitsPicker",
    "(",
    "{",
    ".",
    ".",
    ".",
    "providerTraitsPickerInput",
    ",",
    "size",
    ":",
    "composerControlsCollapsed",
    "?",
    '"xs"',
    ":",
    '"sm"',
    ",",
    "hidden",
    ":",
    "composerControlsHidden",
    "|",
    "|",
    "restingHiddenBlockCount",
    ">",
    "1",
    ",",
    "}",
    ")",
  ];
  if (!matches(cursor, input, render))
    throw new Error("Unqualified resting input/size/hidden guards");
  cursor += render.length;
  if (wrapped) {
    const callback = [",", "changeLiveComposerOptions", ",", ")"];
    if (!matches(cursor, input, callback))
      throw new Error("Unqualified resting persistence callback");
    cursor += callback.length;
  }
  if (input[cursor++] !== ";") throw new Error("Unsupported resting expression boundary");
  if (!matches(cursor, input, ["const", "restingBlockDefs", "=", "["]))
    throw new Error("Missing resting render block");
  let depth = 1,
    uses = 0;
  for (let i = cursor + 4; i < input.length && depth > 0; i++) {
    if (input[i] === "[") depth++;
    if (input[i] === "]") depth--;
    if (matches(i, input, ["{", "restingProviderTraitsPicker", "}"])) uses++;
  }
  if (depth !== 0 || uses !== 1) throw new Error("Missing or duplicate resting JSX use");
  return { wrapped };
}

function matches(at: number, input: readonly string[], wanted: readonly string[]) {
  return wanted.every((token, offset) => input[at + offset] === token);
}

export function readFiniteDispatchCall(source: string): DispatchCall {
  const input = tokens(source);
  const declarations = input.flatMap((token, i) =>
    token === "const" && input[i + 1] === "selectedModelSelection" ? [i] : [],
  );
  if (declarations.length !== 1) throw new Error("Missing or duplicate dispatch initializer");
  let cursor = declarations[0]! + 2;
  if (!matches(cursor, input, ["=", "useMemo", "<", "ModelSelection", ">", "(", "(", ")", "=>"]))
    throw new Error("Unsupported dispatch initializer");
  cursor += 9;
  const callee = input[cursor++];
  if (callee !== "createModelSelection" && callee !== "resolveChatComposerDispatchModel")
    throw new Error("Unknown dispatch callee");
  if (input[cursor++] !== "(") throw new Error("Unsupported dispatch call");
  const args: string[] = [];
  while (input[cursor] !== ")") {
    let arg = input[cursor++];
    if (!arg || !/^[A-Za-z_$][\w$]*$/.test(arg)) throw new Error("Unsupported dispatch argument");
    if (input[cursor] === ".") {
      cursor++;
      const property = input[cursor++];
      if (!property || !/^[A-Za-z_$][\w$]*$/.test(property))
        throw new Error("Unsupported dispatch property");
      arg += `.${property}`;
    }
    args.push(arg);
    if (input[cursor] === ",") cursor++;
    else if (input[cursor] !== ")") throw new Error("Unsupported dispatch expression");
    if (args.length > 3) throw new Error("Unsupported dispatch arity");
  }
  const expected =
    callee === "createModelSelection"
      ? ["selectedInstanceId", "selectedModel", "selectedModelOptionsForDispatch"]
      : ["liveModelSelection", "liveObservation.reported", "selectedModelOptionsForDispatch"];
  if (args.length !== expected.length || args.some((arg, i) => arg !== expected[i]))
    throw new Error("Unknown or reordered dispatch argument");
  if (!matches(cursor, input, [")", ",", "["]))
    throw new Error("Unsupported dispatch memo boundary");

  const bindings = input.flatMap((token, i) =>
    token === "getSendContext" && matches(i + 1, input, [":", "(", ")", "=>", "(", "{"])
      ? [i + 7]
      : [],
  );
  if (bindings.length !== 1) throw new Error("Missing or duplicate getSendContext binding");
  let depth = 1,
    parens = 0,
    brackets = 0,
    shorthand = 0;
  for (let i = bindings[0]!; i < input.length && depth > 0; i++) {
    const token = input[i];
    if (token === "{") depth++;
    else if (token === "}") depth--;
    else if (token === "(") parens++;
    else if (token === ")") parens--;
    else if (token === "[") brackets++;
    else if (token === "]") brackets--;
    else if (
      depth === 1 &&
      parens === 0 &&
      brackets === 0 &&
      token === "selectedModelSelection" &&
      (input[i - 1] === "," || input[i - 1] === "{")
    ) {
      if (input[i + 1] !== "," && input[i + 1] !== "}")
        throw new Error("getSendContext aliases dispatch selection");
      shorthand++;
    }
  }
  if (depth !== 0 || parens !== 0 || brackets !== 0 || shorthand !== 1)
    throw new Error("Missing or duplicate send-context selection");
  return { callee, args };
}
