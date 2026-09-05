import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appHome } from "./config.mjs";

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

export function imageCacheDir() {
  try {
    return join(appHome(), "cache", "images");
  } catch {
    return join(homedir(), ".codex-bridge-antigravity", "cache", "images");
  }
}

function mimeToExtension(mime) {
  if (/jpeg|jpg/i.test(mime)) return "jpg";
  if (/webp/i.test(mime)) return "webp";
  if (/gif/i.test(mime)) return "gif";
  if (/svg/i.test(mime)) return "svg";
  if (/avif/i.test(mime)) return "avif";
  if (/bmp/i.test(mime)) return "bmp";
  if (/tiff?/i.test(mime)) return "tiff";
  return "png";
}

function saveImageBuffer(buffer, mimeType = "image/png") {
  try {
    const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 16);
    const ext = mimeToExtension(mimeType);
    const dir = imageCacheDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, `${hash}.${ext}`);
    if (!existsSync(target)) {
      writeFileSync(target, buffer, { mode: 0o600 });
    }
    return target;
  } catch {
    return null;
  }
}

function saveBase64Image(base64Payload, mimeType = "image/png") {
  try {
    return saveImageBuffer(Buffer.from(base64Payload, "base64"), mimeType);
  } catch {
    return null;
  }
}

function mimeFromPath(path) {
  const extension = extname(path).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".avif") return "image/avif";
  if (extension === ".bmp") return "image/bmp";
  if (extension === ".tif" || extension === ".tiff") return "image/tiff";
  return "image/png";
}

function stageImageFile(filePath) {
  try {
    const source = resolve(filePath);
    const stats = statSync(source);
    if (!stats.isFile()) return null;
    return saveImageBuffer(readFileSync(source), mimeFromPath(source));
  } catch {
    return null;
  }
}

export function formatImagePart(part) {
  if (!part || typeof part !== "object") return "[Image attachment]";
  const name = part.name || part.filename || part.fileName;
  let filePath = part.file_path || part.path || part.image_path || part.filePath;

  let url = typeof part.image_url === "string"
    ? part.image_url
    : (part.image_url?.url || part.url || part.source?.url);

  if (url && typeof url === "string") {
    if (url.startsWith("file://")) {
      try {
        filePath = fileURLToPath(url);
      } catch {
        filePath = decodeURIComponent(url.replace(/^file:\/\//, ""));
      }
    } else if (url.startsWith("data:")) {
      const match = url.match(/^data:([^;]+);base64,(.+)$/s);
      if (match) {
        const saved = saveBase64Image(match[2], match[1]);
        if (saved) filePath = saved;
      }
    }
  }

  if (!filePath && part.source && part.source.type === "base64" && part.source.data) {
    const saved = saveBase64Image(part.source.data, part.source.media_type || "image/png");
    if (saved) filePath = saved;
  }

  if (filePath) {
    const stagedPath = stageImageFile(filePath);
    if (stagedPath) filePath = stagedPath;
    const label = name && name !== filePath ? ` (${name})` : "";
    return `[Image attachment: ${filePath}${label}]\nBefore answering, you MUST call the view_file tool for this exact path and inspect the image. Treat this as a visual attachment, not just a text path.`;
  }

  if (url && (url.startsWith("http://") || url.startsWith("https://"))) {
    const label = name ? ` (${name})` : "";
    return `[Image URL: ${url}${label}]\nBefore answering, you MUST use your browser/image reading tool to inspect this exact image URL. Treat this as a visual attachment, not just a text URL.`;
  }

  return name ? `[Image attachment: ${name}]` : "[Image attachment]";
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
    if (part.type === "input_image" || part.type === "image" || part.type === "image_url") {
      return formatImagePart(part);
    }
    if (part.type === "function_call" || part.type === "function_call_output") return JSON.stringify(part);
    return "";
  }).filter(Boolean).join("\n");
}

function hasImagePart(value) {
  if (Array.isArray(value)) return value.some(hasImagePart);
  if (!value || typeof value !== "object") return false;
  if (["input_image", "image", "image_url"].includes(value.type)) return true;
  return ["content", "input", "summary"].some(key => hasImagePart(value[key]));
}

export function hasImageInput(payload) {
  return hasImagePart(payload?.input);
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
  if (item.type === "input_image" || item.type === "image" || item.type === "image_url") {
    return formatImagePart(item);
  }
  if (item.type === "function_call_output") return `Function output (${item.name || "tool"}):\n${item.output || ""}`;
  if (item.type === "function_call") return `Function call (${item.name || "tool"}):\n${item.arguments || ""}`;
  return contentText(item.content);
}

export function buildAgyPrompt(payload) {
  const sections = [];
  const input = payload.input;
  const systemInstructions = [];
  if (hasImagePart(input)) {
    systemInstructions.push("MANDATORY IMAGE PREFLIGHT: this request includes visual attachment(s). Before answering the user's request, you MUST inspect every [Image attachment: ...] by calling the view_file tool with its exact path, and every [Image URL: ...] with the browser/image reading tool. Wait for those tool results before composing the answer. Do not say an image could not be read until you have performed the corresponding tool call.");
  }
  if (payload.instructions) systemInstructions.push(itemText(payload.instructions));
  if (systemInstructions.length) sections.push(`System instructions:\n${systemInstructions.join("\n\n")}`);
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
