export const COMPACTION_PREFIX = "codex-bridge-antigravity:compaction:v1:";

export function encodeCompactionSummary(summary) {
  return `${COMPACTION_PREFIX}${Buffer.from(String(summary || ""), "utf8").toString("base64url")}`;
}

export function decodeCompactionSummary(value) {
  if (typeof value !== "string" || !value.startsWith(COMPACTION_PREFIX)) return null;
  try {
    return Buffer.from(value.slice(COMPACTION_PREFIX.length), "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBridgeCompactionItem(value) {
  return isObject(value)
    && value.type === "compaction"
    && typeof value.encrypted_content === "string"
    && value.encrypted_content.startsWith(COMPACTION_PREFIX);
}

/**
 * Bridge-owned compaction envelopes are readable by routed models, but the official native
 * backend cannot decrypt them. Convert them to plain input text before a model switch crosses
 * from Antigravity back to a native GPT response.
 */
export function scrubBridgeArtifactsForNative(payload) {
  if (!isObject(payload) || !Array.isArray(payload.input)) return payload;
  let changed = false;
  const input = payload.input.flatMap(item => {
    if (!isBridgeCompactionItem(item)) return [item];
    const summary = decodeCompactionSummary(item.encrypted_content);
    if (summary === null) throw new Error("Invalid Antigravity compaction checkpoint");
    changed = true;
    return [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `Compaction summary:\n${summary}` }],
    }];
  });
  if (!changed) return payload;
  const clean = { ...payload, input };
  delete clean.previous_response_id;
  return clean;
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    if (typeof part.text === "string") return part.text;
    if (typeof part.input_text === "string") return part.input_text;
    if (typeof part.output_text === "string") return part.output_text;
    if (part.type === "input_image" || part.type === "image") return "[image attachment]";
    if (part.type === "function_call" || part.type === "function_call_output") return JSON.stringify(part);
    return "";
  }).filter(Boolean).join("\n");
}

function itemText(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";
  if (typeof item.text === "string") return item.text;
  if (item.type === "compaction") {
    const summary = decodeCompactionSummary(item.encrypted_content);
    return summary === null ? "" : `Compaction summary:\n${summary}`;
  }
  if (item.type === "reasoning") return contentText(item.summary) || contentText(item.content);
  if (item.type === "message") return contentText(item.content);
  if (item.type === "input_text") return item.text || "";
  if (item.type === "function_call_output") return `Function output (${item.name || "tool"}):\n${item.output || ""}`;
  if (item.type === "function_call") return `Function call (${item.name || "tool"}):\n${item.arguments || ""}`;
  return contentText(item.content);
}

export function buildAgyPrompt(payload) {
  const sections = [];
  if (payload.instructions) sections.push(`System instructions:\n${itemText(payload.instructions)}`);
  const input = payload.input;
  if (typeof input === "string") {
    sections.push(`User:\n${input}`);
  } else if (Array.isArray(input)) {
    for (const item of input) {
      const text = itemText(item);
      if (!text) continue;
      const role = item?.role || (item?.type === "message" ? "user" : "context");
      sections.push(`${String(role).replace(/^./, char => char.toUpperCase())}:\n${text}`);
    }
  } else if (input !== undefined) {
    sections.push(`User:\n${JSON.stringify(input)}`);
  }
  return sections.join("\n\n").trim();
}
