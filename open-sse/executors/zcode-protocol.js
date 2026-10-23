import { spawn } from "node:child_process";
import { createDecipheriv, createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

// Local client for the ZCode app-server (`zcode app-server` subcommand). The wire
// protocol is NDJSON JSON-RPC on stdio: requests are {id, method, params} lines,
// responses {id, result} / {id, error:{code,message}}, everything else is a
// notification. The agent also plays the client role itself (reverse requests
// with id+method) — the host side must answer those, most importantly
// session/requestRuntimePreferences and the provider runtime-headers refresh.

export const AGENT_CHANNEL_METHODS = {
  sessionCreate: "session/create",
  sessionSend: "session/send",
  sessionRead: "session/read",
  sessionSetModel: "session/setModel",
  sessionClose: "session/close",
  providerUpdateAccountConfig: "provider/updateAccountConfig",
};

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

// Start Plan serves GLM-5.3 / GLM-5.3-Flash under this account provider.
const ZCODE_BRIDGE_PROVIDER_ID = process.env.ZCODE_AGENT_PROVIDER_ID || "account:zai-start-plan";

export function encodeLine(obj) {
  return JSON.stringify(obj) + "\n";
}

export function resolveZcodeCommand(env = process.env) {
  // 1) Explicit overrides win. ZCODE_SERVER_* targets the server distribution
  //    (~/.zcode/server/zcode-server.cjs) which self-manages account providers;
  //    ZCODE_CJS / ZCODE_BIN target the desktop-bundled CLI app-server.
  if (env.ZCODE_SERVER_NODE && env.ZCODE_SERVER_ENTRY) {
    return { command: env.ZCODE_SERVER_NODE, args: [env.ZCODE_SERVER_ENTRY] };
  }
  if (env.ZCODE_CJS) {
    return { command: process.execPath, args: [env.ZCODE_CJS, "app-server"] };
  }
  if (env.ZCODE_BIN) {
    return { command: env.ZCODE_BIN, args: env.ZCODE_ARGS ? safeParseArgs(env.ZCODE_ARGS) : ["app-server"] };
  }
  const bundled = autoDetectDesktopCli();
  if (bundled) {
    return { command: process.execPath, args: [bundled, "app-server"] };
  }
  return { command: "zcode", args: ["app-server"] };
}

function safeParseArgs(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String).slice(0, 16) : ["app-server"];
  } catch {
    return ["app-server"];
  }
}

function autoDetectDesktopCli() {
  const candidates =
    process.platform === "win32"
      ? [
          join(process.env["ProgramFiles"] || "C:\\Program Files", "ZCode", "resources", "glm", "zcode.cjs"),
          join(process.env["LOCALAPPDATA"] || "", "Programs", "ZCode", "resources", "glm", "zcode.cjs"),
        ]
      : process.platform === "darwin"
        ? ["/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"]
        : ["/opt/ZCode/resources/glm/zcode.cjs", "/usr/lib/ZCode/resources/glm/zcode.cjs"];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // stat failures just mean "not here"
    }
  }
  return null;
}

// The CLI registry resolves account providers from these files; pointing them at
// the same store the desktop uses keeps the model catalog in sync (best-effort —
// the app-server also falls back to its own defaults when the vars are absent).
export function resolveProviderConfigEnv(env = process.env, defaultSelection = null) {
  // Same platform-dir naming the ZCode runtime uses (windows-x86_64, darwin-arm64…).
  const target = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  const root = join(homedir(), ".zcode", "v2", "runtime", "provider", `${target}-${arch}`);
  let builtinFile = null;
  try {
    const versions = existsSync(root)
      ? require_node_fs_readdirSync(root)
        .filter((name) => /^\d+\.\d+\.\d+$/.test(name))
        .sort((a, b) => compareVersions(b, a))
      : [];
    for (const version of versions) {
      const versionDir = join(root, version);
      const endpoints = require_node_fs_readdirSync(versionDir).filter((name) => name.startsWith("endpoint-"));
      for (const endpoint of endpoints) {
        const candidate = join(versionDir, endpoint, "zcode-builtin.json");
        if (existsSync(candidate)) {
          builtinFile = candidate;
          break;
        }
      }
      if (builtinFile) break;
    }
  } catch {
    // best-effort only
  }
  const personalFile = join(homedir(), ".zcode", "v2", "provider_config.json");
  const envVars = {};
  if (builtinFile) envVars.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtinFile;
  if (existsSync(personalFile)) {
    // Serve the worker a bridge-managed copy of the personal config with
    // user-custom providers stripped. Custom providers (e.g. one pointing back
    // at this router) become the worker's first-available model and shadow the
    // Start Plan account provider — the copy restores the Start Plan default
    // without touching the user's real desktop config.
    const bridgePersonalFile = buildBridgePersonalConfig(personalFile, env, defaultSelection);
    envVars.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = bridgePersonalFile ?? personalFile;
  }
  return { builtinFile, personalFile, envVars };
}

// Copy the personal provider config into the 9router data dir, keeping only
// ZCode-managed provider rules (builtin:*/account:*) and injecting the wanted
// default selection. Returns the copy path, or null when the filtered write is
// not possible (caller falls back to the original file).
function buildBridgePersonalConfig(personalFile, env, defaultSelection) {
  try {
    const raw = JSON.parse(readFileSync(personalFile, "utf8"));
    const config = raw.config ?? (raw.config = {});
    const rulesWrap = config.providerConfigRules;
    if (rulesWrap && Array.isArray(rulesWrap.providerRules)) {
      rulesWrap.providerRules = rulesWrap.providerRules.filter((rule) => {
        const id = String(rule?.providerId ?? "");
        return id.startsWith("builtin:") || id.startsWith("account:");
      });
    }
    const modelRulesWrap = config.modelConfigRules;
    if (modelRulesWrap && Array.isArray(modelRulesWrap.providerRules)) {
      modelRulesWrap.providerRules = modelRulesWrap.providerRules.filter((rule) => {
        const id = String(rule?.providerId ?? "");
        return id.startsWith("builtin:") || id.startsWith("account:");
      });
    }
    if (defaultSelection) config.defaultModelSelection = defaultSelection;
    const dir = join(
      env.DATA_DIR || join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "9router"),
      "zcode-bridge",
    );
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "personal.provider_config.json");
    const tmp = target + ".tmp";
    writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n", "utf8");
    renameSync(tmp, target);
    return target;
  } catch {
    return null;
  }
}

// Small wrapper so this module keeps working in bundlers that rename node:fs.
function require_node_fs_readdirSync(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// One-call worker environment setup for the bridge executor: resolve the spawn
// command, pin the Start Plan default selection into the real desktop config,
// then build the filtered personal-config copy for the spawned worker.
export function prepareStartPlanWorkerEnv(model, log, env = process.env) {
  const command = resolveZcodeCommand(env);
  const chosen = resolveUpstreamModelId(model);
  ensureStartPlanDefaultSelection(
    join(homedir(), ".zcode", "v2", "provider_config.json"),
    chosen,
    log,
  );
  const configEnv = resolveProviderConfigEnv(env, {
    providerId: ZCODE_BRIDGE_PROVIDER_ID,
    modelId: chosen,
  });
  return { command, configEnv, chosen };
}

function resolveUpstreamModelId(model) {
  const key = String(model || "").toLowerCase();
  if (key === "glm-5.3") return "GLM-5.3";
  return "GLM-5.3-Flash";
}

// The worker's default selection is the ONLY model path that resolves reliably
// (the worker registry has no account sync). Pin the shared personal config's
// defaultModelSelection to the Start Plan model so the worker — and the ZCode
// app reading the same file — serve Start Plan.
function ensureStartPlanDefaultSelection(personalFile, upstreamModel, log) {
  try {
    if (!personalFile || !existsSync(personalFile)) return;
    const raw = JSON.parse(readFileSync(personalFile, "utf8"));
    const config = raw.config ?? (raw.config = {});
    const wanted = { providerId: ZCODE_BRIDGE_PROVIDER_ID, modelId: upstreamModel };
    const current = config.defaultModelSelection ?? null;
    if (current?.providerId === wanted.providerId && current?.modelId === wanted.modelId) return;
    config.defaultModelSelection = wanted;
    const tmpPath = personalFile + ".tmp-9rz";
    writeFileSync(tmpPath, JSON.stringify(raw, null, 2) + "\n", "utf8");
    renameSync(tmpPath, personalFile);
    log?.info?.("ZCODE", "default selection pinned to " + wanted.providerId + "/" + wanted.modelId);
  } catch (error) {
    log?.debug?.("ZCODE", "default selection pin skipped: " + (error?.message || ""));
  }
}

export async function getZcodeBridgeJwt(credentials) {
  return (
    credentials?.providerSpecificData?.zcodeJwtToken ||
    credentials?.apiKey ||
    readLocalZcodeJwt()
  );
}

// The device id lives in the shared ZCode profile next to the credentials.
export function readZcodeDeviceMid() {
  try {
    const file = join(homedir(), ".zcode", "v2", "telemetry-state.json");
    if (!existsSync(file)) return "";
    return JSON.parse(readFileSync(file, "utf8")).deviceMid || "";
  } catch {
    return "";
  }
}

// The local ZCode profile owns auth. The shared zcode JWT (used by Start/Coding
// Plan request auth) lives encrypted in ~/.zcode/v2/credentials.json with the
// same AES-256-GCM scheme the ZCode app uses; the key derives from the local
// machine identity unless ZCODE_CREDENTIAL_SECRET is set. Reading it lets the
// bridge answer the agent's runtime-headers refresh without storing anything.
export function readLocalZcodeJwt(env = process.env) {
  try {
    const file = join(homedir(), ".zcode", "v2", "credentials.json");
    if (!existsSync(file)) return "";
    const creds = JSON.parse(readFileSync(file, "utf8"));
    const encrypted = creds["zcodejwttoken"];
    if (typeof encrypted !== "string" || !encrypted) return "";
    return decryptCredentialValue(encrypted, env);
  } catch {
    return "";
  }
}

function decryptCredentialValue(value, env) {
  if (!value.startsWith("enc:v1:")) return value;
  const [ivRaw, tagRaw, cipherRaw] = value.slice("enc:v1:".length).split(".");
  if (!ivRaw || !tagRaw || cipherRaw === undefined) return "";
  let username = "unknown";
  try {
    username = userInfo().username || "unknown";
  } catch {
    // userInfo can throw on exotic environments
  }
  const secret =
    env.ZCODE_CREDENTIAL_SECRET ||
    `zcode-credential-fallback:${process.platform}:${homedir()}:${username}`;
  const key = createHash("sha256").update(secret).digest();
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64url"));
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(cipherRaw, "base64url")),
      decipher.final(),
    ]).toString("utf-8");
  } catch {
    return ""; // wrong machine/key — the agent will surface the auth failure
  }
}


function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

export class ZcodeAppServerClient {
  constructor(command, args, options = {}) {
    // Spawn target comes from operator env (ZCODE_CJS/ZCODE_BIN) or the
    // auto-detected installed app path — never from request data. Validate the
    // shape defensively: no shell is used (shell:false below) and arguments are
    // passed as a list, so shell metacharacters cannot gain command semantics.
    this.command = String(command || "");
    this.args = Array.isArray(args) ? args.map(String) : [];
    if (!this.command || /[\r\n]/.test(this.command) || this.args.some((a) => /[\r\n]/.test(a))) {
      throw new Error("Invalid ZCode spawn target");
    }
    this.cwd = options.cwd;
    this.env = options.env;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.onNotification = options.onNotification;
    this.onReverseRequest = options.onReverseRequest;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.closed = false;
  }

  start() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise((resolve, reject) => {
      const ready = new Promise((res, rej) => {
        this.serverReady = res;
        this.serverReadyError = rej;
      });
      const startupTimer = setTimeout(
        () => this.serverReadyError?.(new Error("ZCode app-server handshake timed out")),
        this.startupTimeoutMs,
      );
      startupTimer.unref?.();
      ready.then(
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
      this.child.stdout.on("data", (chunk) => this.onStdout(chunk));
      this.stderrHead = "";
      this.child.stderr.on("data", (chunk) => {
        // Agent stderr may contain provider diagnostics or credentials; only a
        // short head is retained (for exit diagnostics), never forwarded.
        if (this.stderrHead.length < 800) this.stderrHead += chunk.toString("utf8");
      });
      this.child.on("error", (error) => {
        this.serverReadyError?.(error);
        this.rejectPending(error);
      });
      this.child.on("exit", (code, signal) => {
        const detail = this.stderrHead.trim().split("\n").slice(-3).join(" | ").slice(0, 400);
        const reason = code !== null && code !== undefined ? String(code) : String(signal ?? "unknown");
        const error = new Error(detail ? "ZCode app-server exited: " + reason + " — " + detail : "ZCode app-server exited: " + reason);
        this.serverReadyError?.(error);
        this.rejectPending(error);
      });
    });
    return this.startPromise;
  }

  onStdout(chunk) {
    this.buffer += chunk.toString("utf8");
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // not protocol traffic
      }
      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    // Response to one of our requests
    if (message.id !== undefined && !message.method && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message || "ZCode RPC failed");
        error.code = message.error.code;
        error.zcodeError = message.error;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    // Reverse request from the agent — the host side must answer.
    if (message.id !== undefined && message.method) {
      Promise.resolve(this.onReverseRequest?.(message))
        .then((result) => {
          if (!this.closed) this.write({ id: message.id, result: result ?? {} });
        })
        .catch((error) => {
          if (!this.closed)
            this.write({ id: message.id, error: { code: -32000, message: error?.message || "host error" } });
        });
      return;
    }
    // Notification
    if (message.method) {
      // The app-server reports SQLite startup progress before accepting calls;
      // a terminal phase is the only reliable readiness signal on this channel.
      if (message.method === "startup/storageState") {
        if (message.params?.phase === "ready") this.serverReady?.();
        else if (message.params?.phase === "failed")
          this.serverReadyError?.(new Error("ZCode app-server storage startup failed"));
      }
      this.onNotification?.(message);
    }
  }

  write(obj) {
    try {
      this.child?.stdin?.write(encodeLine(obj));
    } catch {
      // EPIPE when the runtime already exited; the exit handler rejects pending calls.
    }
  }

  call(method, params, timeoutMs) {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ZCode RPC timed out: ${method}`));
      }, timeoutMs ?? this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
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
    if (!child || child.exitCode !== null) return;
    try {
      child.stdin.end();
    } catch {
      // already closed
    }
    child.kill();
  }
}
