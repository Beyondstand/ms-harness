// ms-harness — agent 循环：模型 ↔ 工具执行（MCP 桥 + 宿主 ws_* 工具），双协议
const MAX_ITER = 40;
const MAX_RESULT_CHARS = 20000;

const TOOL_TIMEOUTS = {
  ms_run_script: 660000, // 同步脚本最长 600s + 余量
  ms_submit_job: 60000,
  ms_parse_castep: 300000,
  ms_status: 60000,
};

// ---------------- 中立转录 → 各协议消息映射 ----------------

export function buildAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: [{ type: "text", text: m.text }] });
    } else if (m.role === "assistant") {
      const content = [];
      if (m.text) content.push({ type: "text", text: m.text });
      for (const tc of m.toolCalls || []) {
        content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args || {} });
      }
      if (!content.length) content.push({ type: "text", text: "（空回复）" });
      out.push({ role: "assistant", content });
    } else {
      // tool：tool_result 必须紧跟带 tool_use 的 assistant；连续 tool 并进同一条 user
      const block = {
        type: "tool_result",
        tool_use_id: m.toolCallId,
        content: [{ type: "text", text: m.text || "" }],
        is_error: !!m.isError,
      };
      const prev = out[out.length - 1];
      if (prev && prev.role === "user" && Array.isArray(prev.content) && prev.content[0]?.type === "tool_result") {
        prev.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    }
  }
  return out;
}

export function buildOpenAIMessages(messages, system) {
  const out = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.text });
    } else if (m.role === "assistant") {
      const entry = { role: "assistant", content: m.text || null };
      if (m.toolCalls?.length) {
        entry.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) },
        }));
      }
      out.push(entry);
    } else {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.text || "" });
    }
  }
  return out;
}

export function apiUrl(baseURL, protocol) {
  const base = String(baseURL || "").replace(/\/+$/, "");
  const withV1 = /\/v1$/.test(base) ? base : base + "/v1";
  return protocol === "openai" ? withV1 + "/chat/completions" : withV1 + "/messages";
}

// ---------------- agent 循环 ----------------

export class AgentLoop {
  constructor({ emit, gate, callTool, getTools, getConfig, systemPrompt }) {
    this.emit = emit;
    this.gate = gate; // (toolName, args) => Promise<{allowed, reason?}>
    this.callTool = callTool; // (name, args, timeoutMs) => {isError, text, structured}
    this.getTools = getTools;
    this.getConfig = getConfig;
    this.systemPrompt = systemPrompt;
    this.aborted = false;
    this.ac = null;
  }

  abort() {
    this.aborted = true;
    try { this.ac?.abort(); } catch {}
  }

  async runTurn(session, userText, { source = "user" } = {}) {
    this.aborted = false;
    this.ac = new AbortController();
    const emit = this.emit;
    emit({ type: "turn_start", source });
    session.messages.push({ role: "user", text: userText, source });

    const cfg = this.getConfig();
    const provider = cfg.provider || {};
    if (!provider.apiKey || !provider.baseURL || !provider.model) {
      emit({ type: "error", message: "尚未配置模型 API（设置里填协议 / API Base / Key / 模型名），本轮不执行。" });
      emit({ type: "turn_end", reason: "no-provider" });
      return;
    }

    const tools = this.getTools();
    let iter = 0;
    try {
      while (iter < MAX_ITER) {
        iter++;
        if (this.aborted) break;

        const data = await this.#apiCall(session.messages, tools, provider);
        const { text, toolCalls, stopReason } = this.#parse(data, provider.protocol);
        session.messages.push({ role: "assistant", text, toolCalls: toolCalls.length ? toolCalls : null });
        if (text) emit({ type: "assistant_text", text });

        if (!toolCalls.length) {
          emit({ type: "turn_end", reason: stopReason || "end_turn", iterations: iter });
          return;
        }

        for (const tc of toolCalls) {
          if (this.aborted) break;
          emit({ type: "tool_start", id: tc.id, name: tc.name, args: tc.args });

          let out;
          let isError = false;
          let ms = 0;
          const verdict = await this.gate(tc.name, tc.args);
          if (!verdict.allowed) {
            out = `权限门拒绝执行 ${tc.name}：${verdict.reason || "未获用户批准"}`;
            isError = true;
          } else {
            const t0 = Date.now();
            try {
              const r = await this.callTool(tc.name, tc.args || {}, TOOL_TIMEOUTS[tc.name] || 120000);
              out = r.text;
              isError = r.isError;
            } catch (e) {
              out = `工具调用异常：${e.message}`;
              isError = true;
            }
            ms = Date.now() - t0;
          }

          const forModel =
            out.length > MAX_RESULT_CHARS
              ? out.slice(0, MAX_RESULT_CHARS) + `\n…[已截断，完整输出共 ${out.length} 字符；可用 ms_read_artifact 分段查看]`
              : out;
          session.messages.push({ role: "tool", toolCallId: tc.id, toolName: tc.name, text: forModel, isError });
          emit({ type: "tool_result", id: tc.id, name: tc.name, text: out, isError, ms });
        }
      }
      emit({ type: "turn_end", reason: this.aborted ? "stopped" : "max_iter", iterations: iter });
    } catch (e) {
      if (!this.aborted) emit({ type: "error", message: `模型调用失败：${e.message}` });
      emit({ type: "turn_end", reason: this.aborted ? "stopped" : "error", iterations: iter });
    }
  }

  async #apiCall(messages, tools, provider) {
    const protocol = provider.protocol === "openai" ? "openai" : "anthropic";
    const url = apiUrl(provider.baseURL, protocol);
    const headers = { "content-type": "application/json" };
    let body;

    if (protocol === "anthropic") {
      headers["x-api-key"] = provider.apiKey;
      headers["anthropic-version"] = "2023-06-01";
      body = {
        model: provider.model,
        max_tokens: Number(provider.maxTokens) || 8192,
        system: this.systemPrompt,
        messages: buildAnthropicMessages(messages),
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        })),
      };
      if (provider.temperature != null) body.temperature = provider.temperature;
    } else {
      headers.authorization = `Bearer ${provider.apiKey}`;
      body = {
        model: provider.model,
        messages: buildOpenAIMessages(messages, this.systemPrompt),
        tools: tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        })),
        tool_choice: "auto",
      };
      if (provider.temperature != null) body.temperature = provider.temperature;
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: this.ac.signal,
    });
    if (!res.ok) {
      const errText = (await res.text().catch(() => "")).slice(0, 800);
      throw new Error(`HTTP ${res.status} ${res.statusText} — ${errText || "无响应体"}`);
    }
    return res.json();
  }

  #parse(data, protocol) {
    if (protocol !== "openai") {
      const blocks = data.content || [];
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
      const toolCalls = blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, args: b.input || {} }));
      return { text, toolCalls, stopReason: data.stop_reason };
    }
    const m = data.choices?.[0]?.message || {};
    const toolCalls = (m.tool_calls || [])
      .map((tc) => {
        let args = {};
        try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { args = { _raw: tc.function?.arguments }; }
        return { id: tc.id || `call_${Math.random().toString(36).slice(2, 8)}`, name: tc.function?.name, args };
      })
      .filter((tc) => tc.name);
    return { text: m.content || "", toolCalls, stopReason: data.choices?.[0]?.finish_reason };
  }
}
