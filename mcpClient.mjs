// ms-harness — MCP stdio 客户端：把现有 ms-mcp server.mjs 当子进程用，协议零改动
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export class McpClient {
  constructor({ nodePath, serverPath, cwd, env = {}, onEvent = () => {} }) {
    this.nodePath = nodePath;
    this.serverPath = serverPath;
    this.cwd = cwd;
    this.env = env;
    this.onEvent = onEvent;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.buf = "";
    this.tools = [];
    this.ready = false;
    this.stopping = false;
    this.lastStart = 0;
  }

  async start() {
    this.stopping = false;
    this.lastStart = Date.now();
    const proc = spawn(this.nodePath, [this.serverPath], {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc = proc;
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => this.#onData(chunk));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (d) => {
      const t = d.trim();
      if (t) this.onEvent({ type: "mcp_log", text: t });
    });
    proc.on("exit", (code) => this.#onExit(code));
    proc.on("error", (e) => this.onEvent({ type: "mcp_log", text: `MCP spawn 失败: ${e.message}` }));

    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "ms-harness", version: "1.0.0" },
    }, 20000);
    this.#send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await this.listTools();
    this.ready = true;
    this.onEvent({ type: "mcp_status", state: "ready", tools: this.tools.length });
    return this.tools;
  }

  #onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    }
  }

  #onExit(code) {
    this.ready = false;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`MCP 子进程退出（code=${code}）`));
    }
    this.pending.clear();
    this.onEvent({ type: "mcp_status", state: this.stopping ? "stopped" : "exited", code });
    // 崩溃自动重启（5 秒防抖，避免循环重启）
    if (!this.stopping && Date.now() - this.lastStart > 5000) {
      this.onEvent({ type: "mcp_status", state: "restarting" });
      setTimeout(() => {
        this.start().catch((e) => this.onEvent({ type: "mcp_log", text: `MCP 重启失败: ${e.message}` }));
      }, 2000);
    }
  }

  #send(msg) {
    if (!this.proc || this.proc.stdin.destroyed) throw new Error("MCP 子进程未运行");
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  request(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId++;
    const entry = {};
    const promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    entry.timer = setTimeout(() => {
      this.pending.delete(id);
      entry.reject(new Error(`${method} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    this.pending.set(id, entry);
    try {
      this.#send({ jsonrpc: "2.0", id, method, params });
    } catch (e) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(e);
    }
    return promise;
  }

  async listTools() {
    const res = await this.request("tools/list", {}, 20000);
    this.tools = res.tools || [];
    return this.tools;
  }

  async callTool(name, args = {}, timeoutMs = 120000) {
    const res = await this.request("tools/call", { name, arguments: args }, timeoutMs);
    const text = (res.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    return { isError: !!res.isError, text, structured: res.structuredContent ?? null };
  }

  async restart() {
    this.stop();
    await delay(500);
    return this.start();
  }

  stop() {
    this.stopping = true;
    try { this.proc?.stdin?.end(); } catch {}
    try { this.proc?.kill(); } catch {}
    this.ready = false;
  }
}
