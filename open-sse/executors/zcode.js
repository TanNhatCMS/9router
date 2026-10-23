import { DefaultExecutor } from "./default.js";
import {
  AGENT_CHANNEL_METHODS,
  ZcodeAppServerClient,
  getZcodeBridgeJwt,
  prepareStartPlanWorkerEnv,
} from "./zcode-protocol.js";
import { ZcodeAppServerClient as ZcodeServerDistClient, resolveZcodeServerCommand as pickServerDistCommand } from "./zcode-server-protocol.js";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Bridge provider: drives the locally installed, logged-in ZCode app over its
// native stdio protocol instead of calling the Z.ai HTTP gateway. The model
// requests are made by the genuine ZCode runtime, so Start/Coding Plan quota
// works without reproducing the app's WAF/captcha material. No Z.ai credential
// is stored — the shared local profile owns auth.

const numEnv = (name, fallback) => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};

const TURN_TIMEOUT_MS = numEnv("ZCODE_TURN_TIMEOUT_MS", 300_000);
const POLL_INTERVAL_MS = numEnv("ZCODE_POLL_INTERVAL_MS", 2_000);
const ALLOW_AGENT_TOOLS = process.env.ZCODE_ALLOW_TOOLS === "true";

// Start Plan serves GLM-5.3 / GLM-5.3-Flash under this account provider.
const AGENT_PROVIDER_ID = process.env.ZCODE_AGENT_PROVIDER_ID || "account:zai-start-plan";

export class ZcodeExecutor extends DefaultExecutor {
  constructor() {
    super("zcode");
  }

  buildUrl() {
    return "zcode://app-server/stdio";
  }

  async execute({ model, body, stream, credentials, signal, log }) {
    const jwt = await getZcodeBridgeJwt(credentials);
    const serverCmd = pickServerDistCommand();
    if (serverCmd) {
      return this.executeViaServer({ serverCmd, model, body, stream, jwt, signal, log });
    }
    const workerEnv = prepareStartPlanWorkerEnv(model, log);
    const command = workerEnv.command;
    const configEnv = workerEnv.configEnv;

    // Start Plan pin + filtered personal-config copy happen inside
    // prepareStartPlanWorkerEnv; the worker only ever sees ZCode-managed providers.

    const client = new ZcodeAppServerClient(command.command, command.args, {
      cwd: process.cwd(),
      env: configEnv.envVars,
      startupTimeoutMs: numEnv("ZCODE_STARTUP_TIMEOUT_MS", 30_000),
      requestTimeoutMs: numEnv("ZCODE_RPC_TIMEOUT_MS", 60_000),
      onReverseRequest: (message) =>
        this.handleReverseRequest(message, { jwt, signal, log }),
    });

    log?.info?.("ZCODE", `spawning app-server: ${command.command} ${command.args.join(" ")}`);
    try {
      await client.start();
      const sessionId = await this.createSession(client);
      const text = await this.runTurn(client, sessionId, body, signal, log);
      if (!text) throw new Error("ZCode turn completed without assistant text");
      const response = stream ? this.sseResponse(model, text) : this.jsonResponse(model, text);
      // BaseExecutor contract: chatCore reads url/headers/transformedBody for
      // request logging and response translation after execute() returns.
      return { response, url: this.buildUrl(model, stream), headers: {}, transformedBody: body };
    } catch (error) {
      logBridgeError("execute", error, { model, stream });
      const response = this.errorResponse(error, stream);
      return { response, url: this.buildUrl(model, stream), headers: {}, transformedBody: body };
    } finally {
      await client.close().catch(() => {});
    }
  }

  // The agent process delegates account state, permissions and credential
  // refreshes back to the host (this process). Mirror what the ZCode desktop
  // would answer so the turn can complete unattended.
  async handleReverseRequest(message, { jwt, signal, log }) {
    const { method, params } = message;
    if (signal?.aborted) throw new Error("aborted");
    if (method === "session/requestRuntimePreferences") {
      return {
        additionalDirectories: [],
        nativeSearchEnhancementsEnabled: false,
        toolSearchMode: "off",
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: true,
        modelContextBudgetStrategy: "preflight-v1",
      };
    }
    if (method.includes("providerRuntimeHeaders")) {
      // Start/Coding Plan auth material rides on the shared zcode JWT.
      return jwt
        ? { headersApplied: true, requestAuth: { apiKey: jwt, headers: {} } }
        : { headersApplied: false, errorMessage: "No ZCode JWT available on this connection" };
    }
    if (method.toLowerCase().includes("permission")) {
      // Agent tool permissions default to deny; opt in with ZCODE_ALLOW_TOOLS=true.
      const decision = ALLOW_AGENT_TOOLS ? "allow" : "deny";
      log?.debug?.("ZCODE", `permission ${decision}: ${JSON.stringify(params ?? {}).slice(0, 120)}`);
      return { decision, behavior: decision };
    }
    if (method.toLowerCase().includes("officialmcpauth")) {
      return { headers: {} };
    }
    if (method.toLowerCase().includes("userinput") || method.toLowerCase().includes("interaction")) {
      // Unattended bridge: never fabricate user input.
      return { action: "decline" };
    }
    log?.debug?.("ZCODE", `unhandled reverse request: ${method}`);
    return {};
  }

  // NOTE: deliberately no provider/updateAccountConfig push here. The worker's
  // start-plan resolver takes builtinModelIds from availability connection
  // results; a host-pushed overlay without the connection's model list replaces
  // the provider with an empty model set and breaks execution. The worker's
  // configured default selection (kept in sync by the desktop app) resolves fine.

  async createSession(client) {
    const workspacePath = process.cwd();
    const workspace = {
      workspacePath,
      workspaceIdentity: workspacePath,
      workspaceKey: workspacePath,
    };
    const created = await client.call(AGENT_CHANNEL_METHODS.sessionCreate, {
      workspace,
      mode: "build",
      titleGenerationEnabled: false,
    });
    const sessionId =
      created?.session?.sessionId ?? created?.sessionId ?? created?.state?.session?.sessionId;
    if (!sessionId) throw new Error("ZCode session/create returned no sessionId");

    // Enforce Start Plan: the worker serves the model configured in the ZCode
    // app. If the user switched the app to a non-Start-Plan provider, refuse
    // instead of silently burning a different plan's quota — or creating an
    // infinite loop when the selected provider is 9Router itself. Opt out with
    // ZCODE_REQUIRE_START_PLAN=false to serve whatever the app has selected.
    const current = await client.call(
      AGENT_CHANNEL_METHODS.sessionRead,
      { sessionId, messageLimit: 1 },
      30_000,
    );
    const currentModel = current?.settings?.model?.current;
    const requireStartPlan = process.env.ZCODE_REQUIRE_START_PLAN !== "false";
    if (
      requireStartPlan &&
      currentModel?.providerId &&
      !String(currentModel.providerId).includes("start-plan")
    ) {
      throw new Error(
        "ZCode app is not on Start Plan (current: " +
          `${currentModel.providerId}/${currentModel.modelId}). ` +
          "Select GLM-5.3 or GLM-5.3-Flash in the ZCode app, then retry " +
          "(or set ZCODE_REQUIRE_START_PLAN=false).",
      );
    }
    return sessionId;
  }

  async runTurn(client, sessionId, body, signal, log) {
    const prompt = flattenAnthropicPrompt(body);
    // Deliberately no modelSelection on the wire: an explicit selection requires
    // the account provider to be resolvable in the worker registry, which only
    // the desktop host's account sync provides. The worker's configured default
    // selection (the model picked in the ZCode app) always resolves.
    await client.call(AGENT_CHANNEL_METHODS.sessionSend, {
      sessionId,
      content: prompt,
      inputId: `9router-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });

    const deadline = Date.now() + TURN_TIMEOUT_MS;
    while (Date.now() <= deadline) {
      if (signal?.aborted) throw new Error("aborted");
      await sleep(POLL_INTERVAL_MS);
      let state;
      try {
        state = await client.call(
          AGENT_CHANNEL_METHODS.sessionRead,
          { sessionId, messageLimit: 200 },
          30_000,
        );
      } catch {
        continue; // transient read failures happen while the worker is busy
      }
      const messages = Array.isArray(state?.messages) ? state.messages : [];
      const assistant = [...messages]
        .reverse()
        .map((message) => ({
          role: message?.info?.role ?? message?.role,
          text: (Array.isArray(message?.parts) ? message.parts : [])
            .map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
            .join(""),
        }))
        .find((entry) => entry.text && (!entry.role || entry.role === "assistant"));
      const status = state?.session?.status ?? state?.status;
      if (assistant?.text) return assistant.text;
      if (status === "error") {
        log?.debug?.("ZCODE", `session state on error: ${JSON.stringify(state).slice(0, 9000)}`);
        const detail =
          state?.projection?.lastError?.message ??
          state?.session?.error?.message ??
          state?.error?.message ??
          "";
        throw new Error(`ZCode turn ended in an error state${detail ? `: ${detail}` : ""}`);
      }
    }
    throw new Error(`ZCode turn timed out after ${Math.round(TURN_TIMEOUT_MS / 1000)}s`);
  }

  // Server dist path: the standalone runtime self-manages account providers,
  // so the Start Plan selection resolves here without a desktop host.
  async executeViaServer({ serverCmd, model, body, stream, jwt, signal, log }) {
    const client = new ZcodeServerDistClient(serverCmd.command, serverCmd.args, {
      cwd: process.cwd(),
      env: serverCmd.agentEnv,
      startupTimeoutMs: numEnv("ZCODE_STARTUP_TIMEOUT_MS", 30_000),
      requestTimeoutMs: numEnv("ZCODE_RPC_TIMEOUT_MS", 60_000),
      onReverseRequest: (message) =>
        this.handleReverseRequest(message, { jwt, signal, log }),
    });

    log?.info?.("ZCODE", "spawning server dist: " + serverCmd.command + " " + serverCmd.args.join(" "));
    logBridgeError("server spawn", null, {
      command: serverCmd.command,
      args: serverCmd.args,
      agentEnvKeys: serverCmd.agentEnv ? Object.keys(serverCmd.agentEnv).join(",") : "(none)",
    });
    try {
      await client.start();
      const workspace = makeWorkspace(process.cwd());
      const initialized = await client.call("zcode-agent", "initialize", [workspace]);
      if (initialized?.available !== true) {
        throw new Error("ZCode server dist is not available: " + JSON.stringify(initialized).slice(0, 200));
      }
      const created = await client.call("zcode-agent", "createSession", [{
        ...workspace,
        sessionTraceId: randomUUID(),
        mode: "build",
        persistence: "immediate",
      }]);
      const sessionId = created?.session?.sessionId ?? created?.sessionId;
      if (!sessionId) throw new Error("ZCode server createSession returned no sessionId");

      const upstream = resolveServerUpstreamModel(model);
      try {
        await client.call("zcode-agent", "setModel", [{
          ...workspace,
          sessionId,
          model: {
            providerId: AGENT_PROVIDER_ID,
            modelId: upstream.modelId,
            options: { reasoningLevel: upstream.reasoningLevel },
          },
        }]);
        log?.info?.("ZCODE", "server model selected: " + AGENT_PROVIDER_ID + "/" + upstream.modelId + "@" + upstream.reasoningLevel);
      } catch (error) {
        log?.debug?.("ZCODE", "server setModel fell back to default selection: " + error?.message);
      }

      await client.call("zcode-agent", "sendPrompt", [{
        ...workspace,
        sessionId,
        inputId: randomUUID(),
        content: flattenAnthropicPrompt(body),
      }]);

      const deadline = Date.now() + TURN_TIMEOUT_MS;
      let text = "";
      while (Date.now() <= deadline) {
        if (signal?.aborted) throw new Error("aborted");
        await sleep(POLL_INTERVAL_MS);
        let state;
        try {
          state = await client.call("zcode-agent", "readSession", [{
            ...workspace,
            sessionId,
            messageLimit: 200,
          }]);
        } catch {
          continue;
        }
        const messages = Array.isArray(state?.messages) ? state.messages : [];
        const assistant = [...messages]
          .reverse()
          .map((message) => ({
            role: message?.info?.role ?? message?.role,
            text: (Array.isArray(message?.parts) ? message.parts : [])
              .map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
              .join(""),
          }))
          .find((entry) => entry.text && (!entry.role || entry.role === "assistant"));
        const status = state?.session?.status ?? state?.status;
        if (assistant?.text) {
          text = assistant.text;
          break;
        }
        if (status === "error") {
          log?.debug?.("ZCODE", "server session state on error: " + JSON.stringify(state).slice(0, 6000));
          const detail = state?.projection?.lastError?.message ?? state?.error?.message ?? "";
          throw new Error("ZCode turn ended in an error state" + (detail ? ": " + detail : ""));
        }
      }
      if (!text) throw new Error("ZCode turn timed out after " + Math.round(TURN_TIMEOUT_MS / 1000) + "s");

      const response = stream ? this.sseResponse(model, text) : this.jsonResponse(model, text);
      return { response, url: this.buildUrl(model, stream), headers: {}, transformedBody: body };
    } catch (error) {
      logBridgeError("server execute", error, { model, stream });
      const response = this.errorResponse(error, stream);
      return { response, url: this.buildUrl(model, stream), headers: {}, transformedBody: body };
    } finally {
      await client.close().catch(() => {});
    }
  }

  jsonResponse(model, text) {
    const payload = {
      id: `msg_9rz_${Date.now().toString(36)}`,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: approximateTokens(text) },
    };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  sseResponse(model, text) {
    const messageId = `msg_9rz_${Date.now().toString(36)}`;
    const encoder = new TextEncoder();
    const events = [
      { event: "message_start", data: { type: "message_start", message: { id: messageId, type: "message", role: "assistant", model, content: [], usage: { input_tokens: 0, output_tokens: 0 } } } },
      { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
      { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: approximateTokens(text) } } },
      { event: "message_stop", data: { type: "message_stop" } },
    ];
    const stream = new ReadableStream({
      start(controller) {
        for (const item of events) {
          controller.enqueue(encoder.encode(`event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  errorResponse(error, stream) {
    const aborted = error?.name === "AbortError" || /aborted/i.test(error?.message || "");
    const status = aborted ? 499 : /not installed|ENOENT|handshake timed out/i.test(error?.message || "") ? 503 : 502;
    const payload = {
      error: {
        type: "api_error",
        message: `[ZCode bridge] ${error?.message || String(error)}`,
      },
    };
    if (stream) {
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify({ type: "error", error: payload.error })}\n\n`,
            ),
          );
          controller.close();
        },
      });
      return new Response(body, { status: status === 499 ? 502 : status, headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
  }
}

// The bridge is prompt-shaped: flatten the translated Anthropic body into a
// single agent prompt. Tool-call round-trips through the router are out of
// scope — the agent runs with ZCode's own tool set inside the session.
function flattenAnthropicPrompt(body) {
  const parts = [];
  const system = body?.system;
  const systemText =
    typeof system === "string"
      ? system
      : Array.isArray(system)
        ? system.map((block) => block?.text ?? "").join("\n")
        : "";
  if (systemText.trim()) parts.push(`# System\n${systemText.trim()}`);
  for (const message of body?.messages ?? []) {
    const role = message?.role === "assistant" ? "Assistant" : "User";
    const text = normalizeContent(message?.content);
    if (text) parts.push(`${role}: ${text}`);
  }
  return parts.join("\n\n") || "Hello";
}

function normalizeContent(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (block?.type === "text" && typeof block.text === "string") return block.text;
      if (block?.type === "tool_result") {
        const inner = normalizeContent(block.content);
        return `[tool_result] ${inner.slice(0, 2000)}`;
      }
      if (block?.type === "tool_use") return `[tool_use ${block?.name ?? ""}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function approximateTokens(text) {
  return Math.max(1, Math.ceil((text || "").length / 4));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeWorkspace(cwd) {
  return { workspacePath: cwd, workspaceIdentity: cwd, workspaceKey: cwd };
}

function resolveServerUpstreamModel(model) {
  const key = String(model || "").toLowerCase();
  if (key === "glm-5.3") return { modelId: "GLM-5.3", reasoningLevel: "max" };
  return { modelId: "GLM-5.3-Flash", reasoningLevel: "high" };
}

// Bridge failures are otherwise invisible (the server console belongs to the
// deployment); append a compact breadcrumb to the 9router data dir so the
// failing stage can be diagnosed from disk.
function logBridgeError(stage, error, meta = {}) {
  try {
    const dir = process.env.DATA_DIR || join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "9router");
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      stage,
      message: error?.message || String(error),
      stack: error?.stack?.split("\n").slice(0, 4).join(" | ") || "",
      ...meta,
    });
    appendFileSync(join(dir, "logs", "zcode-bridge.log"), line + "\n", "utf8");
  } catch {
    // never let diagnostics break the response
  }
}

export default ZcodeExecutor;
