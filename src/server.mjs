import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import * as zlib from "node:zlib";
import {
  AGY_AUTO_COMPACT_TOKEN_LIMIT,
  AGY_CONTEXT_WINDOW,
  agyModelId,
  isAntigravityModel,
  isLegacyBridgeModel,
  routeId,
} from "./models.mjs";
import { buildAgyPrompt, encodeCompactionSummary, hasImageInput, imageCacheDir, scrubBridgeArtifactsForNative } from "./prompt.mjs";
import { AgyError, runAgyTurn } from "./agy.mjs";
import { fetchNative, nativeWebSocketHeaders, nativeWebSocketUrl, pipeNativeResponse } from "./native.mjs";

const MAX_ENCODED_BODY_BYTES = 64 * 1024 * 1024;
const MAX_DECODED_BODY_BYTES = 128 * 1024 * 1024;

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(body);
}

function errorPayload(message, type = "invalid_request_error", code) {
  return { error: { type, message, ...(code ? { code } : {}) } };
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > MAX_ENCODED_BODY_BYTES) throw new AgyError("Request body is too large", "BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  const encoded = Buffer.concat(chunks);
  const encoding = String(req.headers["content-encoding"] || "identity").trim().toLowerCase();
  let decoded;
  try {
    if (!encoding || encoding === "identity") decoded = encoded;
    else if (encoding === "zstd" && typeof zlib.zstdDecompressSync === "function") decoded = zlib.zstdDecompressSync(encoded);
    else if (encoding === "gzip") decoded = zlib.gunzipSync(encoded);
    else if (encoding === "deflate") decoded = zlib.inflateSync(encoded);
    else if (encoding === "br") decoded = zlib.brotliDecompressSync(encoded);
    else throw new AgyError(`Unsupported Content-Encoding: ${encoding}`, "UNSUPPORTED_ENCODING");
  } catch (error) {
    if (error instanceof AgyError) throw error;
    throw new AgyError(`Could not decompress request body (${encoding}): ${error.message}`, "INVALID_ENCODING");
  }
  if (decoded.byteLength > MAX_DECODED_BODY_BYTES) throw new AgyError("Decoded request body is too large", "BODY_TOO_LARGE");
  try {
    return JSON.parse(decoded.toString("utf8"));
  } catch {
    throw new AgyError("Request body must be valid JSON", "INVALID_JSON");
  }
}

function usage(result) {
  const input = result?.usage?.input_tokens ?? 0;
  const output = result?.usage?.output_tokens ?? 0;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: result?.usage?.total_tokens ?? input + output,
    ...(result?.usage?.cache_read_tokens !== undefined
      ? { input_tokens_details: { cached_tokens: result.usage.cache_read_tokens } }
      : {}),
    ...(result?.usage?.thinking_tokens !== undefined
      ? { output_tokens_details: { reasoning_tokens: result.usage.thinking_tokens } }
      : {}),
  };
}

function responseBody({ id, model, text, status = "completed", result }) {
  const itemId = `msg_${randomUUID().replaceAll("-", "")}`;
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output: [{
      id: itemId,
      type: "message",
      status: status === "completed" ? "completed" : status,
      role: "assistant",
      content: [{ type: "output_text", text: text || "", annotations: [] }],
    }],
    output_text: text || "",
    usage: result ? usage(result) : null,
  };
}

function sse(res, event, sequence, data) {
  if (res.destroyed || res.writableEnded) return false;
  const payload = responseEvent(event, sequence, data);
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  return true;
}

function responseEvent(event, sequence, data) {
  return { type: event, sequence_number: sequence.value++, ...data };
}

function inputItems(input) {
  if (input === undefined) return [];
  if (typeof input === "string") return [{ role: "user", content: input }];
  return Array.isArray(input) ? input : [input];
}

export function expandPreviousResponse(payload, responseStates, { native = false, conversations } = {}) {
  const previousId = typeof payload?.previous_response_id === "string"
    ? payload.previous_response_id
    : undefined;
  if (!previousId) return payload;

  const isPreviousAgy = conversations?.has(previousId);
  // If target is native and previous was also native -> OpenAI upstream already has the session state
  if (native && !isPreviousAgy) return payload;
  // If target is antigravity and previous was also antigravity -> AGY CLI tracks session via conversationId
  if (!native && isPreviousAgy) return payload;

  const state = responseStates.get(previousId);
  if (!state) return payload;
  const expanded = {
    ...payload,
    input: [...state.items, ...inputItems(payload.input)],
  };
  delete expanded.previous_response_id;
  return expanded;
}

function rememberResponse(responseStates, payload, response) {
  if (!response || typeof response !== "object" || typeof response.id !== "string" || !Array.isArray(response.output)) return;
  responseStates.set(response.id, {
    items: [...inputItems(payload?.input), ...structuredClone(response.output)],
  });
  while (responseStates.size > 1_000) responseStates.delete(responseStates.keys().next().value);
}

function modelCatalogRows(models) {
  return models.map(model => ({
    slug: routeId(model.id),
    display_name: model.displayName,
    description: `Official Antigravity CLI model: ${model.displayName}`,
    supported_in_api: true,
    supported_reasoning_levels: [{ effort: effortFromId(model.id), description: "Antigravity model effort" }],
    default_reasoning_level: effortFromId(model.id),
    visibility: "list",
    input_modalities: ["text", "image"],
    context_window: AGY_CONTEXT_WINDOW,
    max_context_window: AGY_CONTEXT_WINDOW,
    effective_context_window_percent: 100,
    auto_compact_token_limit: AGY_AUTO_COMPACT_TOKEN_LIMIT,
    use_responses_lite: false,
  }));
}

function effortFromId(id) {
  if (/(?:^|-)low$/.test(id)) return "low";
  if (/(?:^|-)medium$/.test(id)) return "medium";
  return "high";
}

function imagePreflightPrompt(prompt) {
  const references = String(prompt).split(/\r?\n/)
    .filter(line => /^\[Image (?:attachment|URL):/.test(line));
  return [
    "MANDATORY IMAGE PREFLIGHT. Do not answer the user's request yet.",
    "First call view_file for every exact [Image attachment: ...] path below, and use the browser/image reading tool for every [Image URL: ...]. Inspect all visual attachments, wait for the tool results, then reply with a concise factual visual description prefixed IMAGE_CONTEXT:.",
    references.join("\n"),
  ].filter(Boolean).join("\n\n");
}

async function runAgyPrompt({ config, selected, payload, prompt, mode, effort, conversationId, signal, onEvent }) {
  const attachmentDir = imageCacheDir();
  const addDirs = existsSync(attachmentDir) ? [attachmentDir] : [];
  let activeConversation = conversationId;
  let imageContext = "";
  if (hasImageInput(payload)) {
    const preflight = await runAgyTurn({
      agyPath: config.agyPath,
      cwd: config.cwd,
      model: selected.agy,
      prompt: imagePreflightPrompt(prompt),
      mode,
      effort,
      conversationId: activeConversation,
      addDirs,
      timeoutMs: config.requestTimeoutSec * 1000,
      signal,
    });
    activeConversation = preflight.conversation_id || activeConversation;
    imageContext = `\n\nBridge image preflight context (the attachment was inspected by AGY):\n${String(preflight.response || "").trim()}`;
  }
  const result = await runAgyTurn({
    agyPath: config.agyPath,
    cwd: config.cwd,
    model: selected.agy,
    prompt: prompt + imageContext,
    mode,
    effort,
    conversationId: activeConversation,
    addDirs,
    timeoutMs: config.requestTimeoutSec * 1000,
    signal,
    onEvent,
  });
  return result;
}

function resolveModel(payload, models) {
  if (typeof payload.model !== "string" || !payload.model.trim()) throw new AgyError("model is required", "MODEL_REQUIRED");
  const requested = payload.model.trim();
  if (isLegacyBridgeModel(requested)) {
    throw new AgyError(`Legacy bridge model is not supported: ${requested}`, "MODEL_PROVIDER");
  }
  if (!isAntigravityModel(requested)) return { kind: "native", route: requested, native: requested };
  const id = agyModelId(requested);
  if (!models.some(model => model.id === id)) {
    throw new AgyError(`Unknown Antigravity model: ${requested}`, "MODEL_NOT_FOUND");
  }
  return { kind: "antigravity", route: routeId(id), agy: id };
}

async function runAgyResponse({ config, models, payload, conversations, responseStates, signal, emit }) {
  const effectivePayload = expandPreviousResponse(payload, responseStates, { conversations });
  const selected = resolveModel(effectivePayload, models);
  if (selected.kind !== "antigravity") throw new AgyError("The request is not an Antigravity model", "MODEL_PROVIDER");
  const prompt = buildAgyPrompt(effectivePayload);
  if (!prompt) throw new AgyError("input is required", "INPUT_REQUIRED");

  const responseId = `resp_${randomUUID().replaceAll("-", "")}`;
  const sequence = { value: 0 };
  const previous = typeof effectivePayload.previous_response_id === "string"
    ? conversations.get(effectivePayload.previous_response_id)
    : undefined;
  const initial = responseBody({ id: responseId, model: selected.route, text: "", status: "in_progress" });
  const itemId = initial.output[0].id;
  emit("response.created", { response: initial }, sequence);
  emit("response.output_item.added", { output_index: 0, item: initial.output[0] }, sequence);
  emit("response.content_part.added", {
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  }, sequence);

  let sentDelta = false;
  const result = await runAgyPrompt({
    config,
    selected,
    payload: effectivePayload,
    prompt,
    mode: config.mode,
    effort: effectivePayload.reasoning?.effort,
    conversationId: previous,
    signal,
    onEvent: event => {
      const delta = event.kind === "step" && typeof event.step.text_delta === "string"
        ? event.step.text_delta
        : "";
      if (!delta) return;
      sentDelta = true;
      emit("response.output_text.delta", {
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        delta,
      }, sequence);
    },
  });
  if (result.conversation_id) conversations.set(responseId, result.conversation_id);
  const finalText = result.response || "";
  if (!sentDelta && finalText) {
    emit("response.output_text.delta", {
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: finalText,
    }, sequence);
  }
  emit("response.output_text.done", {
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    text: finalText,
  }, sequence);
  emit("response.content_part.done", {
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: finalText, annotations: [] },
  }, sequence);
  const completed = responseBody({ id: responseId, model: selected.route, text: finalText, result });
  completed.output[0].id = itemId;
  emit("response.output_item.done", { output_index: 0, item: completed.output[0] }, sequence);
  emit("response.completed", { response: completed }, sequence);
  rememberResponse(responseStates, effectivePayload, completed);
  return { responseId, response: completed, result };
}

async function runAgyCompaction({ config, models, payload, conversations, responseStates, signal }) {
  const effectivePayload = expandPreviousResponse(payload, responseStates, { conversations });
  const selected = resolveModel(effectivePayload, models);
  if (selected.kind !== "antigravity") throw new AgyError("The request is not an Antigravity model", "MODEL_PROVIDER");
  const previous = typeof effectivePayload.previous_response_id === "string"
    ? conversations.get(effectivePayload.previous_response_id)
    : undefined;
  const source = buildAgyPrompt(effectivePayload)
    || (previous ? "Use the preceding conversation in this AGY session as the source context." : "");
  if (!source) throw new AgyError("input is required for compaction", "INPUT_REQUIRED");
  const prompt = `${source}\n\nSummarize the preceding coding conversation for a later continuation. Preserve the user's goals, relevant decisions, file paths, commands, errors, and unfinished work. Be concise and do not invent facts.`;
  const result = await runAgyPrompt({
    config,
    selected,
    payload: effectivePayload,
    prompt,
    mode: "plan",
    effort: effectivePayload.reasoning?.effort,
    conversationId: previous,
    signal,
  });
  const responseId = `resp_${randomUUID().replaceAll("-", "")}`;
  if (result.conversation_id) conversations.set(responseId, result.conversation_id);
  const summary = String(result.response || "").trim() || "(no summary available)";
  const item = {
    id: `cmp_${randomUUID().replaceAll("-", "")}`,
    type: "compaction",
    encrypted_content: encodeCompactionSummary(summary),
  };
  const response = {
      id: responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "completed",
      model: selected.route,
      output: [item],
      output_text: "",
      usage: usage(result),
  };
  rememberResponse(responseStates, effectivePayload, response);
  return { response };
}

function emitCompactionEvents(emit, response) {
  const sequence = { value: 0 };
  const inProgress = { ...response, status: "in_progress", output: [] };
  const item = response.output[0];
  emit("response.created", { response: inProgress }, sequence);
  emit("response.output_item.added", { output_index: 0, item }, sequence);
  emit("response.output_item.done", { output_index: 0, item }, sequence);
  emit("response.completed", { response }, sequence);
}

function isCompactionPayload(payload) {
  return Array.isArray(payload?.input)
    && payload.input.some(item => item && typeof item === "object" && item.type === "compaction_trigger");
}

const MAX_WEBSOCKET_MESSAGE_BYTES = 64 * 1024 * 1024;

function websocketAccept(key) {
  return createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function writeWebSocketFrame(socket, opcode, value = Buffer.alloc(0)) {
  if (socket.destroyed) return;
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value);
  let header;
  if (payload.length <= 125) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length <= 65_535) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function attachWebSocket(socket, onMessage, onClose) {
  let buffer = Buffer.alloc(0);
  let fragmentOpcode = 0;
  const fragments = [];
  let closed = false;

  const close = (code = 1000, reason = "") => {
    if (closed) return;
    closed = true;
    const reasonBytes = Buffer.from(reason).subarray(0, 123);
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    writeWebSocketFrame(socket, 0x8, payload);
    socket.end();
  };

  const parse = () => {
    while (!closed && buffer.length >= 2) {
      const first = buffer[0];
      const second = buffer[1];
      const fin = (first & 0x80) !== 0;
      const rsv = first & 0x70;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let headerLength = 2;
      if (rsv || !masked) {
        close(1002, "Invalid WebSocket frame");
        return;
      }
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        headerLength = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const longLength = buffer.readBigUInt64BE(2);
        if (longLength > BigInt(MAX_WEBSOCKET_MESSAGE_BYTES)) {
          close(1009, "Message too large");
          return;
        }
        length = Number(longLength);
        headerLength = 10;
      }
      if (length > MAX_WEBSOCKET_MESSAGE_BYTES) {
        close(1009, "Message too large");
        return;
      }
      const total = headerLength + 4 + length;
      if (buffer.length < total) return;
      const mask = buffer.subarray(headerLength, headerLength + 4);
      const payload = Buffer.from(buffer.subarray(headerLength + 4, total));
      buffer = buffer.subarray(total);
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];

      if (opcode >= 0x8) {
        if (!fin || length > 125) {
          close(1002, "Invalid control frame");
          return;
        }
        if (opcode === 0x8) {
          if (!closed) writeWebSocketFrame(socket, 0x8, payload);
          closed = true;
          socket.end();
          onClose?.();
          return;
        }
        if (opcode === 0x9) writeWebSocketFrame(socket, 0xA, payload);
        continue;
      }

      if (opcode === 0x0) {
        if (!fragmentOpcode) {
          close(1002, "Unexpected continuation");
          return;
        }
        fragments.push(payload);
        if (!fin) continue;
        const complete = Buffer.concat(fragments);
        const completeOpcode = fragmentOpcode;
        fragmentOpcode = 0;
        fragments.length = 0;
        if (completeOpcode === 0x1) void onMessage(complete.toString("utf8"));
        continue;
      }
      if (fragmentOpcode || (opcode !== 0x1 && opcode !== 0x2)) {
        close(1002, "Invalid data frame");
        return;
      }
      if (!fin) {
        fragmentOpcode = opcode;
        fragments.push(payload);
      } else if (opcode === 0x1) {
        void onMessage(payload.toString("utf8"));
      }
    }
  };

  socket.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    parse();
  });
  socket.on("close", () => {
    if (!closed) {
      closed = true;
      onClose?.();
    }
  });
  socket.on("error", () => {
    if (!closed) {
      closed = true;
      onClose?.();
    }
  });
  return {
    sendJson(value) {
      writeWebSocketFrame(socket, 0x1, JSON.stringify(value));
    },
    sendText(value) {
      writeWebSocketFrame(socket, 0x1, value);
    },
    close,
    feed(chunk) {
      if (chunk?.length) {
        buffer = Buffer.concat([buffer, chunk]);
        parse();
      }
    },
    get isClosed() { return closed || socket.destroyed; },
  };
}

function websocketRequestBody(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  if (payload.type !== "response.create") return payload;
  const body = { ...payload };
  delete body.type;
  return body;
}

function websocketModel(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  if (typeof payload.model === "string") return payload.model;
  if (payload.response && typeof payload.response === "object" && typeof payload.response.model === "string") {
    return payload.response.model;
  }
  return undefined;
}

function openNativeWebSocket(config, req, peer, onEvent, onClose) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket;
    try {
      socket = new WebSocket(nativeWebSocketUrl(config), { headers: nativeWebSocketHeaders(req) });
    } catch (error) {
      reject(error);
      return;
    }
    socket.addEventListener("open", () => {
      settled = true;
      resolve(socket);
    });
    socket.addEventListener("message", async event => {
      let value = event.data;
      if (typeof value !== "string") {
        if (value instanceof ArrayBuffer) value = Buffer.from(value).toString("utf8");
        else if (ArrayBuffer.isView(value)) value = Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8");
        else if (value && typeof value.text === "function") value = await value.text();
      }
      if (typeof value === "string") {
        try { onEvent?.(JSON.parse(value)); } catch { /* preserve non-JSON upstream frames */ }
        if (!peer.isClosed) peer.sendText(value);
      }
    });
    socket.addEventListener("error", () => {
      if (!settled) reject(new Error("Native Responses WebSocket connection failed"));
      else onClose?.();
    });
    socket.addEventListener("close", event => {
      if (!settled) reject(new Error(`Native Responses WebSocket closed before opening (${event.code})`));
      else onClose?.(event);
    });
  });
}

function acceptWebSocket(config, models, conversations, responseStates, req, socket, head) {
  const url = new URL(req.url || "/", `http://${config.host}:${config.port}`);
  if (url.pathname !== "/v1/responses") {
    socket.destroy();
    return;
  }
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return;
  }
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
    "\r\n",
  ].join("\r\n"));

  let nativeSocket;
  let localAbort;
  let closed = false;
  let messages = Promise.resolve();
  const nativePayloadQueue = [];
  const nativePayloads = new Map();
  const rememberNativeEvent = event => {
    const responseId = event?.response?.id;
    if (event?.type === "response.created" && typeof responseId === "string") {
      nativePayloads.set(responseId, nativePayloadQueue.shift());
      return;
    }
    if (event?.type === "response.completed" && event.response) {
      const payload = typeof responseId === "string" ? nativePayloads.get(responseId) : undefined;
      rememberResponse(responseStates, payload || nativePayloadQueue.shift(), event.response);
      if (typeof responseId === "string") nativePayloads.delete(responseId);
    }
  };
  const peer = attachWebSocket(socket, text => {
    let payload;
    try { payload = JSON.parse(text); } catch {
      peer.close(1007, "Request body must be valid JSON");
      return;
    }
    if (payload?.type === "response.cancel") {
      localAbort?.abort();
      if (nativeSocket?.readyState === WebSocket.OPEN) {
        try { nativeSocket.send(text); } catch { /* upstream is closing */ }
      }
      return;
    }
    messages = messages.then(async () => {
      const requestBody = websocketRequestBody(payload);
      const model = websocketModel(requestBody);
      try {
        const selected = resolveModel(requestBody, models);
        if (selected.kind === "native") {
          const nativePayload = scrubBridgeArtifactsForNative(
            expandPreviousResponse(requestBody, responseStates, { native: true, conversations }),
          );
          if (!nativeSocket || nativeSocket.readyState !== WebSocket.OPEN) {
            let openedSocket;
            openedSocket = await openNativeWebSocket(config, req, peer, rememberNativeEvent, () => {
              if (nativeSocket === openedSocket) nativeSocket = undefined;
            });
            nativeSocket = openedSocket;
          }
          if (!peer.isClosed && nativeSocket.readyState === WebSocket.OPEN) {
            nativePayloadQueue.push(nativePayload);
            try {
              const outbound = payload?.type === "response.create"
                ? { ...nativePayload, type: "response.create" }
                : nativePayload;
              nativeSocket.send(JSON.stringify(outbound));
            } catch (error) {
              nativePayloadQueue.pop();
              throw error;
            }
          }
          return;
        }

        const abort = new AbortController();
        localAbort = abort;
        const sequenceEmitter = (event, data, sequence) => {
          if (!peer.isClosed) peer.sendJson(responseEvent(event, sequence, data));
        };
        try {
          if (isCompactionPayload(requestBody)) {
            const compacted = await runAgyCompaction({
              config,
              models,
              payload: requestBody,
              conversations,
              responseStates,
              signal: abort.signal,
            });
            emitCompactionEvents(sequenceEmitter, compacted.response);
          } else {
            await runAgyResponse({
              config,
              models,
              payload: requestBody,
              conversations,
              responseStates,
              signal: abort.signal,
              emit: sequenceEmitter,
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!peer.isClosed) {
            const sequence = { value: 0 };
            const failed = responseBody({ id: `resp_${randomUUID().replaceAll("-", "")}`, model: model || "antigravity", text: "", status: "failed" });
            peer.sendJson(responseEvent("response.failed", sequence, { response: failed, error: { type: "server_error", message } }));
          }
        } finally {
          if (localAbort === abort) localAbort = undefined;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!peer.isClosed) peer.sendJson({ type: "error", error: { type: "invalid_request_error", message } });
      }
    }).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      if (!peer.isClosed) peer.sendJson({ type: "error", error: { type: "server_error", message } });
    });
  }, () => {
    if (closed) return;
    closed = true;
    localAbort?.abort();
    nativePayloadQueue.length = 0;
    nativePayloads.clear();
    if (nativeSocket && nativeSocket.readyState < WebSocket.CLOSING) nativeSocket.close();
  });
  peer.feed(head);
}

function requestAbortSignal(req, res) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once("aborted", abort);
  res.once("close", abort);
  return {
    signal: controller.signal,
    cleanup() {
      req.off("aborted", abort);
      res.off("close", abort);
    },
  };
}

async function proxyNative(config, req, res, endpoint, body, responseStates) {
  const request = requestAbortSignal(req, res);
  try {
    const upstream = await fetchNative({ config, req, endpoint, body, signal: request.signal });
    if (endpoint === "responses" && body && typeof body === "object") {
      const eventStream = (upstream.headers.get("content-type") || "").toLowerCase().includes("text/event-stream");
      if (eventStream) {
        await pipeNativeResponse(res, upstream, event => {
          if (event?.type === "response.completed" && event.response) rememberResponse(responseStates, body, event.response);
        });
        return;
      }
      try {
        const response = await upstream.clone().json();
        rememberResponse(responseStates, body, response);
      } catch {
        // Let the original upstream body reach Codex; only continuation caching is optional.
      }
    }
    await pipeNativeResponse(res, upstream);
  } catch (error) {
    if (request.signal.aborted) throw new AgyError("Request was cancelled", "ABORT_ERR");
    if (error?.code === "NATIVE_AUTH") throw new AgyError(error.message, "NATIVE_AUTH");
    throw new AgyError(
      `Native Codex upstream failed: ${error instanceof Error ? error.message : String(error)}`,
      "NATIVE_UPSTREAM",
    );
  } finally {
    request.cleanup();
  }
}

async function proxyNativeModels(config, req, res, models) {
  const request = requestAbortSignal(req, res);
  try {
    const upstream = await fetchNative({ config, req, endpoint: "models", signal: request.signal });
    if (!upstream.ok || !upstream.body) {
      await pipeNativeResponse(res, upstream);
      return;
    }
    let catalog;
    try {
      catalog = await upstream.json();
    } catch (error) {
      throw new AgyError(
        `Native model catalog was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        "NATIVE_CATALOG",
      );
    }
    if (!catalog || typeof catalog !== "object" || Array.isArray(catalog) || !Array.isArray(catalog.models)) {
      throw new AgyError("Native model catalog did not contain a models array", "NATIVE_CATALOG");
    }
    const nativeModels = catalog.models.filter(model => {
      const slug = model && typeof model === "object" && typeof model.slug === "string" ? model.slug : "";
      return !isAntigravityModel(slug) && !isLegacyBridgeModel(slug);
    });
    json(res, upstream.status, { ...catalog, models: [...nativeModels, ...modelCatalogRows(models)] });
  } catch (error) {
    if (request.signal.aborted) throw new AgyError("Request was cancelled", "ABORT_ERR");
    if (error instanceof AgyError) throw error;
    if (error?.code === "NATIVE_AUTH") throw new AgyError(error.message, "NATIVE_AUTH");
    throw new AgyError(
      `Native model catalog request failed: ${error instanceof Error ? error.message : String(error)}`,
      "NATIVE_UPSTREAM",
    );
  } finally {
    request.cleanup();
  }
}

export function createBridgeServer(config, models) {
  const conversations = new Map();
  const responseStates = new Map();
  const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type,authorization",
      });
      res.end();
      return;
    }
    const url = new URL(req.url || "/", `http://${config.host}:${config.port}`);
    try {
      if (req.method === "GET" && url.pathname === "/healthz") {
        json(res, 200, {
          ok: true,
          service: "codex-bridge-antigravity",
          agy_path: config.agyPath,
          cwd: config.cwd,
          model_count: models.length,
          native_base_url: config.nativeBaseUrl,
          websocket: true,
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        await proxyNativeModels(config, req, res, models);
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/alpha/search") {
        const payload = await readJson(req);
        await proxyNative(config, req, res, "alpha/search", payload, responseStates);
        return;
      }
      if (req.method !== "POST" || !["/v1/responses", "/v1/responses/compact"].includes(url.pathname)) {
        json(res, 404, errorPayload("Not found", "not_found"));
        return;
      }

      const payload = await readJson(req);
      const selected = resolveModel(payload, models);
      if (selected.kind === "native") {
        const nativePayload = scrubBridgeArtifactsForNative(
          expandPreviousResponse(payload, responseStates, { native: true, conversations }),
        );
        await proxyNative(config, req, res, url.pathname.endsWith("/compact") ? "responses/compact" : "responses", nativePayload, responseStates);
        return;
      }
      if (url.pathname.endsWith("/compact")) {
        const request = requestAbortSignal(req, res);
        try {
          const compacted = await runAgyCompaction({
            config,
            models,
            payload,
            conversations,
            responseStates,
            signal: request.signal,
          });
          json(res, 200, compacted.response);
        } finally {
          request.cleanup();
        }
        return;
      }
      const abort = new AbortController();
      const cancel = () => {
        if (!res.writableEnded && !abort.signal.aborted) abort.abort();
      };
      req.once("aborted", cancel);
      res.once("close", cancel);
      const stream = payload.stream === true;
      if (isCompactionPayload(payload)) {
        if (stream) {
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "access-control-allow-origin": "*",
          });
          try {
            const compacted = await runAgyCompaction({
              config,
              models,
              payload,
              conversations,
              responseStates,
              signal: abort.signal,
            });
            emitCompactionEvents((event, data, sequence) => sse(res, event, sequence, data), compacted.response);
            if (!res.writableEnded) res.end("data: [DONE]\n\n");
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const failedSequence = { value: 0 };
            const failed = responseBody({ id: `resp_${randomUUID().replaceAll("-", "")}`, model: selected.route, text: "", status: "failed" });
            sse(res, "response.failed", failedSequence, { response: failed, error: { type: "server_error", message } });
            if (!res.writableEnded) res.end("data: [DONE]\n\n");
          }
          return;
        }
        const compacted = await runAgyCompaction({
          config,
          models,
          payload,
          conversations,
          responseStates,
          signal: abort.signal,
        });
        json(res, 200, compacted.response);
        return;
      }
      if (stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "access-control-allow-origin": "*",
        });
        try {
          await runAgyResponse({
            config,
            models,
            payload,
            conversations,
            responseStates,
            signal: abort.signal,
            emit: (event, data, sequence) => sse(res, event, sequence, data),
          });
          if (!res.writableEnded) res.end("data: [DONE]\n\n");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const failedSequence = { value: 0 };
          const failed = responseBody({ id: `resp_${randomUUID().replaceAll("-", "")}`, model: selected.route, text: "", status: "failed" });
          sse(res, "response.failed", failedSequence, { response: failed, error: { type: "server_error", message } });
          if (!res.writableEnded) res.end("data: [DONE]\n\n");
        }
        return;
      }

      const result = await runAgyResponse({
        config,
        models,
        payload,
        conversations,
        responseStates,
        signal: abort.signal,
        emit: () => {},
      });
      json(res, 200, result.response);
    } catch (error) {
      const status = error?.code === "MODEL_NOT_FOUND" ? 404
        : error?.code === "BODY_TOO_LARGE" ? 413
          : error?.code === "UNSUPPORTED_ENCODING" || error?.code === "INVALID_ENCODING" ? 415
          : error?.code === "ABORT_ERR" ? 499
            : error?.code === "NATIVE_AUTH" ? 401
              : error?.code === "NATIVE_UPSTREAM" || error?.code === "NATIVE_CATALOG"
                || error?.code === "AGY_RESULT" || error?.code === "AGY_EXIT" || error?.code === "AGY_COMPACT" ? 502
                : 400;
      if (!res.headersSent) json(res, status, errorPayload(error instanceof Error ? error.message : String(error), error?.code === "AGY_PROCESS" ? "server_error" : "invalid_request_error", error?.code));
      else if (!res.writableEnded) res.end();
    }
  });
  server.on("upgrade", (req, socket, head) => acceptWebSocket(config, models, conversations, responseStates, req, socket, head));
  return server;
}

export function listenBridge(server, config) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
