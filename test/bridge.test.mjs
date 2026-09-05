import test from "node:test";
import assert from "node:assert/strict";
import { parseAgyLine } from "../src/agy.mjs";
import {
  buildAgyPrompt,
  decodeCompactionSummary,
  encodeCompactionSummary,
  scrubBridgeArtifactsForNative,
} from "../src/prompt.mjs";
import { buildCodexCatalog, parseAgyModels } from "../src/models.mjs";

test("parses AGY stream-json events", () => {
  assert.equal(parseAgyLine('{"event":"step_update","step_update":{"text_delta":"ok"}}').kind, "step");
  assert.equal(parseAgyLine('{"event":"result","result":{"status":"SUCCESS"}}').kind, "result");
  assert.equal(parseAgyLine("not json").kind, "unknown");
});

test("parses the live agy models table shape", () => {
  const models = parseAgyModels("gemini-3.8-flash-low    Gemini 3.8 Flash (Low)\nclaude-sonnet-4-6  Claude Sonnet 4.6 (Thinking)");
  assert.deepEqual(models.map(model => model.id), ["gemini-3.8-flash-low", "claude-sonnet-4-6"]);
});

test("builds a prompt from Responses input", () => {
  const prompt = buildAgyPrompt({
    instructions: "Be concise.",
    input: [{ role: "user", content: [{ type: "input_text", text: "Reply AGY_OK" }] }],
  });
  assert.match(prompt, /System instructions/);
  assert.match(prompt, /Reply AGY_OK/);
});

test("round-trips bridge compaction summaries into the next prompt", () => {
  const encoded = encodeCompactionSummary("keep the router change");
  assert.equal(decodeCompactionSummary(encoded), "keep the router change");
  assert.match(buildAgyPrompt({ input: [{ type: "compaction", encrypted_content: encoded }] }), /router change/);
});

test("scrubs bridge compaction items before native passthrough", () => {
  const encoded = encodeCompactionSummary("switch back to GPT");
  const payload = { previous_response_id: "resp_bridge", input: [{ type: "compaction", encrypted_content: encoded }] };
  const scrubbed = scrubBridgeArtifactsForNative(payload);
  assert.equal(scrubbed.previous_response_id, undefined);
  assert.deepEqual(scrubbed.input[0], {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "Compaction summary:\nswitch back to GPT" }],
  });
});

test("adds Antigravity routes to a Codex catalog", () => {
  const catalog = buildCodexCatalog([{ id: "gemini-3.8-flash-low", displayName: "Gemini 3.8 Flash (Low)" }]);
  const model = catalog.models.find(model => model.slug === "antigravity/gemini-3.8-flash-low");
  assert.ok(model);
  assert.equal(model.use_responses_lite, false);
});
