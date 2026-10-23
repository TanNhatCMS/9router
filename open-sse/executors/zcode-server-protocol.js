import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Binary stdio client for the ZCode server distribution (~/.zcode/server/
// zcode-server.cjs). Wire format: a JSON hello line, then 13-byte
// length-prefixed frames carrying a compact value encoding. The server dist
// runs standalone — it manages account providers itself from the shared local
// ZCode profile, so Start Plan models resolve without a desktop host.

const HEADER_SIZE = 13;
const REGULAR_MESSAGE = 1;
const INITIALIZE_MESSAGE = 200;
const RESPONSE_MESSAGE = 201;
const ERROR_MESSAGE = 202;
const CANCELED_MESSAGE = 203;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

export function encodeVql(value) {
  const bytes = [];
  let remaining = value;
  do {
    let next = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) next |= 0x80;
    bytes.push(next);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

function decodeVql(data, offset) {
  let value = 0;
  let multiplier = 1;
  let cursor = offset;
  for (let i = 0; i < 8; i += 1) {
    if (cursor >= data.byteLength) throw new Error("Truncated ZCode variable-length quantity");
    const next = data[cursor++];
    value += (next & 0x7f) * multiplier;
    if ((next & 0x80) === 0) return { value, offset: cursor };
    multiplier *= 128;
  }
  throw new Error("Invalid ZCode variable-length quantity");
}

export function encodeZcodeValue(value) {
  if (value === undefined) return Buffer.from([0]);
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([Buffer.from([1]), encodeVql(bytes.byteLength), bytes]);
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const bytes = Buffer.from(value);
    return Buffer.concat([Buffer.from([2]), encodeVql(bytes.byteLength), bytes]);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([
      Buffer.from([4]),
      encodeVql(value.length),
      ...value.map((item) => encodeZcodeValue(item)),
    ]);
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return Buffer.concat([Buffer.from([6]), encodeVql(value)]);
  }
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  return Buffer.concat([Buffer.from([5]), encodeVql(bytes.byteLength), bytes]);
}

export function decodeZcodeValue(data, offset = 0) {
  if (offset >= data.byteLength) throw new Error("Truncated ZCode serialized value");
  const type = data[offset++];
  if (type === 0) return { value: undefined, offset };
  if (type === 1 || type === 2) {
    const length = decodeVql(data, offset);
    const end = length.offset + length.value;
    if (end > data.byteLength) throw new Error("Truncated ZCode byte/string value");
    const bytes = data.slice(length.offset, end);
    return {
      value: type === 1 ? Buffer.from(bytes).toString("utf8") : Buffer.from(bytes),
      offset: end,
    };
  }
  if (type === 4) {
    const length = decodeVql(data, offset);
    const values = [];
    let cursor = length.offset;
    for (let i = 0; i < length.value; i += 1) {
      const decoded = decodeZcodeValue(data, cursor);
      values.push(decoded.value);
      cursor = decoded.offset;
    }
    return { value: values, offset: cursor };
  }
  if (type === 5) {
    const length = decodeVql(data, offset);
    const end = length.offset + length.value;
    if (end > data.byteLength) throw new Error("Truncated ZCode JSON value");
    return {
      value: JSON.parse(Buffer.from(data.slice(length.offset, end)).toString("utf8")),
      offset: end,
    };
  }
  if (type === 6) {
    const decoded = decodeVql(data, offset);
    return { value: decoded.value, offset: decoded.offset };
  }
  throw new Error(`Unknown ZCode serialized value type ${type}`);
}

export function encodeZcodeRpcCall(id, channel, method, args) {
  const body = Buffer.concat([
    encodeZcodeValue([100, id, channel, method]),
    encodeZcodeValue(args),
  ]);
  const frame = Buffer.alloc(HEADER_SIZE + body.byteLength);
  frame.writeUInt8(REGULAR_MESSAGE, 0);
  frame.writeUInt32BE(0, 1);
  frame.writeUInt32BE(0, 5);
  frame.writeUInt32BE(body.byteLength, 9);
  body.copy(frame, HEADER_SIZE);
  return frame;
}

function errorFromPayload(payload, fallback) {
  if (payload && typeof payload === "object") {
    const record = payload;
    const error = new Error(typeof record.message === "string" ? record.message : fallback);
    if (typeof record.code === "string") error.code = record.code;
    if (record.data !== undefined) error.data = record.data;
    return error;
  }
  return new Error(fallback);
}

export class ZcodeAppServerClient {
  constructor(command, args, options = {}) {
    this.command = String(command || "");
    this.args = Array.isArray(args) ? args.map(String) : [];
    if (!this.command || /[\r\n]/.test(this.command) || this.args.some((a) => /[\r\n]/.test(a))) {
      throw new Error("Invalid ZCode spawn target");
    }
    this.cwd = options.cwd;
    this.env = options.env;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.onNotification = options.onNotification;
    this.onReverseRequest = options.onReverseRequest;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.outputBuffer = Buffer.alloc(0);
    this.handshakeDone = false;
    this.closed = false;
  }

  start() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise((resolve, reject) => {
      const readyPromise = new Promise((res, rej) => {
        this.serverReady = res;
        this.serverReadyError = rej;
      });
      const startupTimer = setTimeout(
        () => this.serverReadyError?.(new Error("ZCode app-server handshake timed out")),
        this.startupTimeoutMs,
      );
      startupTimer.unref?.();
      readyPromise.then(
        () => {
          clearTimeout(startupTimer);
          resolve();
        },
        (error) => {
          clearTimeout(startupTimer);
          reject(error);
        },
      );

      this.child = spawn(this.command, this.args, {
        cwd: this.cwd,
        env: this.env ? { ...process.env, ...this.env } : process.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });
      this.stderrHead = "";
      this.child.stdout.on("data", (chunk) => this.onStdout(chunk));
      this.child.stderr.on("data", (chunk) => {
        // Agent stderr may carry credentials; keep a short head for exit diagnostics.
        if (this.stderrHead.length < 800) this.stderrHead += chunk.toString("utf8");
      });
      this.child.on("error", (error) => {
        this.serverReadyError?.(error);
        this.rejectPending(error);
      });
      this.child.on("exit", (code, signal) => {
        const detail = this.stderrHead.trim().split("\n").slice(-3).join(" | ").slice(0, 400);
        const reason = code !== null && code !== undefined ? String(code) : String(signal ?? "unknown");
        const error = new Error(
          detail
            ? "ZCode app-server exited: " + reason + " — " + detail
            : "ZCode app-server exited: " + reason,
        );
        this.serverReadyError?.(error);
        this.rejectPending(error);
      });
    });
    return this.startPromise;
  }

  onStdout(chunk) {
    this.outputBuffer = Buffer.concat([this.outputBuffer, chunk]);
    if (!this.handshakeDone) {
      const newline = this.outputBuffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.outputBuffer.byteLength > 64 * 1024) {
          this.serverReadyError?.(new Error("ZCode hello line is too large"));
        }
        return;
      }
      const line = this.outputBuffer.subarray(0, newline).toString("utf8").trim();
      this.outputBuffer = this.outputBuffer.subarray(newline + 1);
      let hello;
      try {
        hello = JSON.parse(line);
      } catch {
        this.serverReadyError?.(new Error("Invalid ZCode app-server hello"));
        return;
      }
      if (!hello || typeof hello !== "object" || hello.type !== "zcode-hello") {
        this.serverReadyError?.(new Error("Unexpected ZCode app-server hello"));
        return;
      }
      this.child.stdin.write(
        JSON.stringify({
          type: "zcode-hello-ack",
          version: "9router",
          clientId: "9router-" + process.pid,
        }) + "\n",
      );
      this.handshakeDone = true;
    }
    this.consumeFrames();
  }

  consumeFrames() {
    while (this.outputBuffer.byteLength >= HEADER_SIZE) {
      const type = this.outputBuffer.readUInt8(0);
      const length = this.outputBuffer.readUInt32BE(9);
      if (length > MAX_FRAME_BYTES) {
        const error = new Error("ZCode frame exceeds the safety limit");
        this.serverReadyError?.(error);
        this.rejectPending(error);
        return;
      }
      const frameLength = HEADER_SIZE + length;
      if (this.outputBuffer.byteLength < frameLength) return;
      const body = this.outputBuffer.subarray(HEADER_SIZE, frameLength);
      this.outputBuffer = this.outputBuffer.subarray(frameLength);
      if (type !== REGULAR_MESSAGE) continue;
      try {
        const header = decodeZcodeValue(body, 0);
        const payload = decodeZcodeValue(body, header.offset);
        this.handleMessage(header.value, payload.value);
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        this.serverReadyError?.(normalized);
        this.rejectPending(normalized);
      }
    }
  }

  handleMessage(headerValue, payload) {
    if (!Array.isArray(headerValue)) return;
    const type = headerValue[0];
    if (type === INITIALIZE_MESSAGE) {
      this.serverReady?.();
      return;
    }
    if (type !== RESPONSE_MESSAGE && type !== ERROR_MESSAGE && type !== CANCELED_MESSAGE) return;
    const requestId = headerValue[1];
    if (typeof requestId !== "number") return;
    const request = this.pending.get(requestId);
    if (!request) return;
    this.pending.delete(requestId);
    clearTimeout(request.timer);
    if (type === RESPONSE_MESSAGE) {
      request.resolve(payload);
    } else {
      request.reject(errorFromPayload(
        payload,
        type === ERROR_MESSAGE ? "ZCode RPC request failed" : "ZCode RPC request canceled",
      ));
    }
  }

  call(channel, method, args) {
    if (!this.child || !this.handshakeDone) {
      return Promise.reject(new Error("ZCode app-server is not ready"));
    }
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("ZCode RPC request timed out: " + channel + "." + method));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.child.stdin.write(encodeZcodeRpcCall(requestId, channel, method, args));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  rejectPending(error) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async close() {
    this.closed = true;
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null) return;
    try {
      child.stdin.end();
    } catch {
      // already closed
    }
    child.kill();
  }
}

// The server dist self-manages account providers, so it is preferred over the
// desktop CLI app-server (whose registry needs a desktop host account sync).
// The dist is a supervisor: it spawns the agent itself using the bundled-agent
// wiring env — point that wiring at the installed desktop CLI bundle.
export function resolveZcodeServerCommand(env = process.env) {
  if (env.ZCODE_SERVER_NODE && env.ZCODE_SERVER_ENTRY) {
    return {
      command: env.ZCODE_SERVER_NODE,
      args: [env.ZCODE_SERVER_ENTRY],
      agentEnv: resolveBundledAgentWiringFromEntry(
        env.ZCODE_AGENT_SERVER_COMMAND,
        env.ZCODE_AGENT_SERVER_ARGS_JSON,
        dirname(env.ZCODE_SERVER_ENTRY),
      ),
    };
  }
  const runtimeRoot = env.ZCODE_SERVER_RUNTIME_ROOT || join(homedir(), ".zcode", "server");
  const serverEntry = join(runtimeRoot, "zcode-server.cjs");
  if (!existsSync(serverEntry)) return null;
  return {
    command: process.execPath,
    args: [serverEntry],
    agentEnv: resolveBundledAgentWiringFromEntry(
      env.ZCODE_AGENT_SERVER_COMMAND,
      env.ZCODE_AGENT_SERVER_ARGS_JSON,
      runtimeRoot,
    ),
  };
}

// Release wiring precedence: explicit env wins; otherwise the zcode.cjs sitting
// next to the server entry (release layout) or the installed desktop bundle.
function resolveBundledAgentWiringFromEntry(commandEnv, argsJsonEnv, entryDir) {
  if (commandEnv?.trim()) {
    let args = ["app-server", "--stdio"];
    try {
      const parsed = JSON.parse(argsJsonEnv || "[]");
      if (Array.isArray(parsed)) args = parsed.map(String);
    } catch {
      // keep default args
    }
    return {
      ZCODE_AGENT_SERVER_COMMAND: commandEnv,
      ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify(args),
    };
  }
  const cliCandidates = [
    join(entryDir, "zcode.cjs"),
    "C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs",
    "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
    "/opt/ZCode/resources/glm/zcode.cjs",
  ];
  for (const candidate of cliCandidates) {
    if (candidate && existsSync(candidate)) {
      return {
        ZCODE_AGENT_SERVER_COMMAND: process.execPath,
        ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([candidate, "app-server", "--stdio"]),
      };
    }
  }
  return null;
}
