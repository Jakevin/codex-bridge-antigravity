import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DEFAULT_NATIVE_BASE_URL } from "./native.mjs";

export const DEFAULT_PORT = 17842;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_MODE = "accept-edits";

export function expandPath(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

export function appHome() {
  return resolve(expandPath(process.env.CODEX_ANTIGRAVITY_HOME?.trim() || "~/.codex-bridge-antigravity"));
}

export function configPath() {
  return join(appHome(), "config.json");
}

export function catalogPath() {
  return join(appHome(), "codex", "model-catalog.json");
}

export function integrationStatePath() {
  return join(appHome(), "codex", "integration.json");
}

export function codexConfigPath() {
  const configured = process.env.CODEX_HOME?.trim();
  return join(resolve(expandPath(configured || "~/.codex")), "config.toml");
}

export function defaultConfig(overrides = {}) {
  return {
    version: 1,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    cwd: process.cwd(),
    mode: DEFAULT_MODE,
    agyPath: process.env.AGY_PATH?.trim() || "agy",
    nativeBaseUrl: process.env.CODEX_NATIVE_BASE_URL?.trim() || DEFAULT_NATIVE_BASE_URL,
    requestTimeoutSec: 600,
    models: [],
    ...overrides,
  };
}

export function loadConfig(overrides = {}) {
  const path = configPath();
  let stored = {};
  if (existsSync(path)) {
    try {
      stored = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new Error(`Invalid bridge config ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return defaultConfig({ ...stored, ...overrides });
}

export function saveConfig(config) {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export function resolveCwd(value) {
  const expanded = expandPath(value || process.cwd());
  return isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);
}

export function resolveAgyExecutable(value) {
  const requested = value?.trim() || process.env.AGY_PATH?.trim() || "agy";
  if (isAbsolute(requested)) return requested;
  const candidates = [
    join(homedir(), ".local", "bin", requested),
    join(homedir(), ".local", "bin", "agy"),
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
  ];
  return candidates.find(candidate => existsSync(candidate)) || requested;
}
