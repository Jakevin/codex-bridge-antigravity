import { spawn } from "node:child_process";

export class AgyError extends Error {
  constructor(message, code = "AGY_ERROR") {
    super(message);
    this.name = "AgyError";
    this.code = code;
  }
}

export function parseAgyLine(line) {
  try {
    const value = JSON.parse(line);
    if (!value || typeof value !== "object") return { kind: "unknown", raw: value };
    if (value.event === "init") return { kind: "init", raw: value, conversationId: value.conversation_id };
    if (value.event === "step_update") return { kind: "step", raw: value, step: value.step_update || {} };
    if (value.event === "result") return { kind: "result", raw: value, result: value.result || {} };
    return { kind: "unknown", raw: value };
  } catch {
    return { kind: "unknown", raw: line };
  }
}

function kill(child) {
  if (!child || child.killed) return;
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
}

export function runAgyTurn({
  agyPath,
  cwd,
  model,
  prompt,
  mode = "accept-edits",
  effort,
  conversationId,
  timeoutMs = 600_000,
  signal,
  onEvent,
}) {
  return new Promise((resolve, reject) => {
    const args = [
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--model", model,
      "--mode", mode,
      "--dangerously-skip-permissions",
      "--add-dir", cwd,
    ];
    if (mode !== "plan") args.push("--disable-slash-commands");
    if (effort && ["low", "medium", "high"].includes(effort)) args.push("--effort", effort);
    if (conversationId) args.push("--conversation", conversationId);

    let child;
    try {
      child = spawn(agyPath, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });
    } catch (error) {
      reject(new AgyError(`cannot start ${agyPath}: ${error.message}`, "AGY_START"));
      return;
    }

    let stdoutBuffer = "";
    let stderr = "";
    let result;
    let conversation;
    let settled = false;
    const timer = setTimeout(() => finishError(new AgyError(`AGY timed out after ${Math.round(timeoutMs / 1000)}s`, "AGY_TIMEOUT")), timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finishError = error => {
      if (settled) return;
      settled = true;
      cleanup();
      kill(child);
      reject(error);
    };
    const finishSuccess = value => {
      if (settled) return;
      settled = true;
      cleanup();
      kill(child);
      resolve(value);
    };
    const onAbort = () => finishError(new AgyError("Request was cancelled", "ABORT_ERR"));

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdoutBuffer += chunk;
      let newline;
      while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        const parsed = parseAgyLine(line);
        if (parsed.kind === "init" && parsed.conversationId) conversation = parsed.conversationId;
        if (parsed.kind === "step" && parsed.step.conversation_id) conversation = parsed.step.conversation_id;
        if (parsed.kind === "result") {
          result = parsed.result;
          if (result.conversation_id) conversation = result.conversation_id;
        }
        try {
          onEvent?.(parsed);
        } catch (error) {
          finishError(error);
          return;
        }
        if (parsed.kind === "result") {
          if (result.status && result.status !== "SUCCESS" && result.status !== "OK") {
            finishError(new AgyError(result.error || `AGY returned ${result.status}`, "AGY_RESULT"));
            return;
          }
          finishSuccess({ ...result, conversation_id: conversation || result.conversation_id });
          return;
        }
      }
    });
    child.stderr.on("data", chunk => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.once("error", error => finishError(new AgyError(`AGY process failed: ${error.message}`, "AGY_PROCESS")));
    child.once("close", (code, closeSignal) => {
      if (settled) return;
      if (stdoutBuffer.trim()) {
        const parsed = parseAgyLine(stdoutBuffer.trim());
        if (parsed.kind === "result") {
          result = parsed.result;
          if (result.conversation_id) conversation = result.conversation_id;
          try { onEvent?.(parsed); } catch (error) { finishError(error); return; }
          if (result.status && result.status !== "SUCCESS" && result.status !== "OK") {
            finishError(new AgyError(result.error || `AGY returned ${result.status}`, "AGY_RESULT"));
            return;
          }
          finishSuccess({ ...result, conversation_id: conversation || result.conversation_id });
          return;
        }
      }
      const detail = stderr.trim().split("\n").slice(-3).join(" ");
      finishError(new AgyError(
        `AGY exited before returning a result (${code ?? closeSignal ?? "signal"})${detail ? `: ${detail}` : ""}`,
        "AGY_EXIT",
      ));
    });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdin.once("error", error => finishError(new AgyError(`Cannot send prompt to AGY: ${error.message}`, "AGY_STDIN")));
    child.stdin.write(`${JSON.stringify({ event: "user", message: { role: "user", content: prompt } })}\n`);
  });
}

export async function agyVersion(agyPath) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(agyPath, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `agy exited with ${code}`)));
  });
  return result;
}
