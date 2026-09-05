import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

export const MODEL_PREFIX = "antigravity/";
export const AGY_CONTEXT_WINDOW = 1_000_000;
export const AGY_AUTO_COMPACT_TOKEN_LIMIT = 800_000;

export function isAntigravityModel(value) {
  return typeof value === "string" && value.startsWith(MODEL_PREFIX);
}

export function isLegacyBridgeModel(value) {
  return typeof value === "string" && (value.startsWith("freebuff/") || value.startsWith("gemini-web/"));
}

export const FALLBACK_AGY_MODELS = [
  ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"],
  ["gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"],
  ["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"],
].map(([id, displayName]) => ({ id, displayName }));

function runAgyModels(agyPath, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(agyPath, ["models"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`agy models timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`cannot start ${agyPath}: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const detail = stderr.trim().split("\n").slice(-3).join(" ");
        reject(new Error(`agy models failed (${code ?? signal ?? "signal"})${detail ? `: ${detail}` : ""}`));
        return;
      }
      resolve(stdout);
    });
  });
}

export function parseAgyModels(text) {
  const models = [];
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^model(s)?$/i.test(trimmed)) continue;
    const match = trimmed.match(/^(\S+)\s+(.+?)\s*$/);
    if (!match || !/^[A-Za-z0-9._-]+$/.test(match[1])) continue;
    models.push({ id: match[1], displayName: match[2] });
  }
  return dedupeModels(models);
}

function dedupeModels(models) {
  const seen = new Set();
  return models.filter(model => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

export function isAllowedAgyModel(modelOrId) {
  const rawId = typeof modelOrId === "string" ? modelOrId : modelOrId?.id;
  if (typeof rawId !== "string") return false;
  const id = agyModelId(rawId);
  const match = id.match(/^gemini-(\d+)(?:\.(\d+))?-flash(?:-(high|medium|low))?$/i);
  if (!match) return false;
  const major = parseInt(match[1], 10);
  const minor = match[2] ? parseInt(match[2], 10) : 0;
  if (major > 3) return true;
  if (major === 3 && minor >= 8) return true;
  return false;
}

export async function discoverAgyModels(agyPath) {
  const parsed = parseAgyModels(await runAgyModels(agyPath));
  const available = parsed.length > 0 ? parsed : FALLBACK_AGY_MODELS;
  return available.filter(isAllowedAgyModel);
}

export function routeId(modelId) {
  return modelId.startsWith(MODEL_PREFIX) ? modelId : `${MODEL_PREFIX}${modelId}`;
}

export function agyModelId(route) {
  return route.startsWith(MODEL_PREFIX) ? route.slice(MODEL_PREFIX.length) : route;
}

function effortForModel(id) {
  if (/(?:^|-)low$/.test(id)) return "low";
  if (/(?:^|-)medium$/.test(id)) return "medium";
  return "high";
}

function nativeCatalog() {
  const candidates = [
    process.env.CODEX_MODEL_CATALOG?.trim(),
    join(homedir(), ".codex", "opencodex-catalog.json"),
    join(homedir(), ".codex", "models_cache.json"),
    join(homedir(), ".codex-freebuff-web", "codex", "model-catalog.json"),
  ].filter(Boolean);
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const value = JSON.parse(readFileSync(path, "utf8"));
      if (value && Array.isArray(value.models)) return value;
    } catch {
      // A stale optional cache should not prevent the bridge from starting.
    }
  }
  return { models: [] };
}

function modelSlug(value) {
  return value && typeof value === "object" && !Array.isArray(value) && typeof value.slug === "string"
    ? value.slug
    : undefined;
}

function nativeTemplate(catalog) {
  return catalog.models.find(model => {
    const slug = modelSlug(model);
    return slug && !slug.startsWith(MODEL_PREFIX)
      && !slug.startsWith("freebuff/")
      && !slug.startsWith("gemini-web/")
      && Array.isArray(model.supported_reasoning_levels);
  });
}

function reasoningLevel(template, effort) {
  const levels = Array.isArray(template?.supported_reasoning_levels)
    ? template.supported_reasoning_levels
    : [];
  const source = levels.find(level => level?.effort === effort);
  return {
    ...(source && typeof source === "object" ? structuredClone(source) : {}),
    effort,
    description: `Antigravity ${effort} effort`,
  };
}

function buildModel(template, model) {
  const effort = effortForModel(model.id);
  const base = template && typeof template === "object" ? structuredClone(template) : {};
  const result = {
    ...base,
    slug: routeId(model.id),
    display_name: model.displayName,
    description: `Official Antigravity CLI model: ${model.displayName}`,
    visibility: "list",
    supported_in_api: true,
    input_modalities: ["text", "image"],
    tool_mode: null,
    multi_agent_version: "disabled",
    upgrade: null,
    default_reasoning_level: effort,
    supported_reasoning_levels: [reasoningLevel(template, effort)],
    context_window: AGY_CONTEXT_WINDOW,
    max_context_window: AGY_CONTEXT_WINDOW,
    effective_context_window_percent: 100,
    auto_compact_token_limit: AGY_AUTO_COMPACT_TOKEN_LIMIT,
    use_responses_lite: false,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
  };
  delete result.comp_hash;
  delete result.availability_nux;
  return result;
}

export function buildCodexCatalog(models) {
  const source = nativeCatalog();
  const template = nativeTemplate(source);
  const preserved = source.models.filter(model => {
    const slug = modelSlug(model);
    return slug && !slug.startsWith(MODEL_PREFIX)
      && !slug.startsWith("freebuff/")
      && !slug.startsWith("gemini-web/");
  });
  return {
    ...structuredClone(source),
    models: [...preserved, ...models.map(model => buildModel(template, model))],
  };
}
