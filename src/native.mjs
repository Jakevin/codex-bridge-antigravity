import { Readable } from "node:stream";

export const DEFAULT_NATIVE_BASE_URL = "https://chatgpt.com/backend-api/codex";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

function baseUrl(config) {
  return String(config.nativeBaseUrl || DEFAULT_NATIVE_BASE_URL).replace(/\/+$/, "");
}

function headerValue(value) {
  return Array.isArray(value) ? value.join(", ") : value;
}

export function forwardHeaders(req, { websocket = false, jsonBody = false } = {}) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    if (websocket && (name.startsWith("sec-websocket-") || name === "origin")) continue;
    headers.set(name, headerValue(value));
  }
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("accept-encoding");
  if (jsonBody) headers.set("content-type", "application/json");
  return headers;
}

function requireNativeAuth(req) {
  const value = req.headers.authorization;
  const authorization = Array.isArray(value) ? value[0] : value;
  if (!authorization?.startsWith("Bearer ") || authorization.length <= "Bearer ".length) {
    const error = new Error("Native Codex routing requires the incoming Bearer authorization");
    error.code = "NATIVE_AUTH";
    throw error;
  }
}

function nativeClientVersion(userAgent) {
  if (typeof userAgent !== "string") return undefined;
  const separator = userAgent.indexOf("/");
  if (separator < 1) return undefined;
  const originator = userAgent.slice(0, separator);
  if (!(originator === "codex_cli_rs"
    || originator === "codex-tui"
    || originator === "codex_vscode"
    || originator === "codex_atlas"
    || originator === "codex_chatgpt_desktop"
    || /^Codex [A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/.test(originator))) return undefined;
  const match = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+][0-9A-Za-z.-]+)?(?:\s|$)/
    .exec(userAgent.slice(separator + 1));
  return match ? `${match[1]}.${match[2]}.${match[3]}` : undefined;
}

export function nativeUrl(config, endpoint, search = "") {
  return `${baseUrl(config)}/${endpoint}${search}`;
}

export function nativeWebSocketUrl(config) {
  const url = new URL(nativeUrl(config, "responses"));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export async function fetchNative({ config, req, endpoint, body, signal }) {
  requireNativeAuth(req);
  const incoming = new URL(req.url || "/", `http://${config.host}:${config.port}`);
  if (endpoint === "models" && !incoming.searchParams.has("client_version")) {
    const version = nativeClientVersion(req.headers["user-agent"]);
    if (version) incoming.searchParams.set("client_version", version);
  }
  const method = endpoint === "models" ? "GET" : "POST";
  const headers = forwardHeaders(req, { jsonBody: method === "POST" });
  const requestBody = method === "POST" ? JSON.stringify(body) : undefined;
  return fetch(nativeUrl(config, endpoint, incoming.search), {
    method,
    headers,
    ...(requestBody === undefined ? {} : { body: requestBody }),
    signal,
  });
}

function responseHeaders(upstream) {
  const headers = {};
  for (const [name, value] of upstream.headers) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    if (["content-length", "content-encoding"].includes(name.toLowerCase())) continue;
    headers[name] = value;
  }
  return headers;
}

export async function pipeNativeResponse(res, upstream, onEvent) {
  res.writeHead(upstream.status, upstream.statusText, responseHeaders(upstream));
  if (!upstream.body) {
    res.end();
    return;
  }
  const eventStream = (upstream.headers.get("content-type") || "").toLowerCase().includes("text/event-stream");
  let lineBuffer = "";
  for await (const chunk of Readable.fromWeb(upstream.body)) {
    if (res.destroyed || res.writableEnded) break;
    res.write(chunk);
    if (!onEvent || !eventStream) continue;
    lineBuffer += chunk.toString("utf8");
    let newline;
    while ((newline = lineBuffer.indexOf("\n")) >= 0) {
      const line = lineBuffer.slice(0, newline).replace(/\r$/, "");
      lineBuffer = lineBuffer.slice(newline + 1);
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      try { onEvent(JSON.parse(line.slice(6))); } catch { /* non-JSON SSE metadata is ignored */ }
    }
  }
  if (!res.writableEnded) res.end();
}

export function nativeWebSocketHeaders(req) {
  requireNativeAuth(req);
  return forwardHeaders(req, { websocket: true });
}
