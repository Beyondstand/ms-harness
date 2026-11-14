// ms-harness — Electron 主进程（dsh-desktop 形态）：
// 无框窗口 + 控制台（服务终端/文件树）+ 模型配置页 + 检测 MS 启动后解锁跳转对话工作台
import { app, BrowserWindow, ipcMain } from "electron";
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import util from "node:util";
import { fileURLToPath } from "node:url";
import { McpClient } from "./mcpClient.mjs";
import { AgentLoop, apiUrl } from "./agent.mjs";
import { JobKeeper } from "./jobkeeper.mjs";
import { WS_TOOLS, READONLY_TOOLS, wsToolCall, resolveInWorkspace } from "./wsTools.mjs";
import { buildSystemPrompt } from "./systemPrompt.mjs";

// 工具型应用不需要 shader 磁盘缓存，禁用避免 cache 目录权限/锁冲突刷屏
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(APP_DIR, "config.json");
const SESSIONS_DIR = path.join(APP_DIR, "sessions");

// 桥与工作区默认路径：优先本机既有 ms-mcp 目录（保持既有任务工作区），否则用仓库自带 bridge/（自包含克隆可用）
const PERSONAL_MS_MCP = "C:\\Users\\lenovo20200825\\.zcode\\workspace\\default\\ms-mcp";
const DEFAULT_SERVER_PATH = fs.existsSync(path.join(PERSONAL_MS_MCP, "server.mjs"))
  ? path.join(PERSONAL_MS_MCP, "server.mjs")
  : path.join(APP_DIR, "bridge", "server.mjs");
const DEFAULT_WORKSPACE = fs.existsSync(PERSONAL_MS_MCP)
  ? path.join(PERSONAL_MS_MCP, "workspace")
  : path.join(APP_DIR, "bridge", "workspace");

const DEFAULT_CONFIG = {
  provider: { protocol: "anthropic", baseURL: "", apiKey: "", model: "", maxTokens: 8192, temperature: null },
  permissionTier: "auto",
  jobKeeper: true,
  pollSec: 60,
  ms: {
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    serverPath: DEFAULT_SERVER_PATH,
    workspace: DEFAULT_WORKSPACE,
    installRoot: "C:\\Program Files (x86)\\BIOVIA\\Materials Studio 23.1",
    serverRoot: "C:\\Program Files (x86)\\BIOVIA\\Materials Studio 23.1 x64 Server",
    clientExe: "", // 留空 = installRoot\bin\MatStudio.exe
  },
};

function loadConfig() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch {}
  return {
    ...DEFAULT_CONFIG,
    ...saved,
    provider: { ...DEFAULT_CONFIG.provider, ...(saved.provider || {}) },
    ms: { ...DEFAULT_CONFIG.ms, ...(saved.ms || {}) },
  };
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2), "utf8");
}

let CFG = loadConfig();
let win = null;
let mcp = null;
let keeper = null;
let agent = null;
let CUR = null;
let busy = false;
let keeperQueue = [];
let confirmSeq = 0;
const confirmWaiters = new Map();

// ---------------- 终端日志（控制台面板） ----------------

const TERM = [];
function termPush(kind, text) {
  const line = { t: new Date().toISOString().slice(11, 19), kind, text: String(text) };
  TERM.push(line);
  if (TERM.length > 800) TERM.shift();
  emit({ type: "term_log", line });
}

function log(...args) {
  const s = util.format(...args);
  console.log(`[ms-harness ${new Date().toISOString().slice(11, 19)}] ${s}`);
  termPush("info", s);
}

function emit(ev) {
  if (win && !win.isDestroyed()) win.webContents.send("ev", ev);
}

// ---------------- Materials Studio 客户端：启动 + 进程检测 ----------------

function msClientExe() {
  return CFG.ms.clientExe || path.join(CFG.ms.installRoot, "bin", "MatStudio.exe");
}

let msRunning = false;
let msUnlocked = false;
let msDetectTimer = null;

function detectMsOnce() {
  return new Promise((resolve) => {
    execFile("tasklist", ["/FI", "IMAGENAME eq MatStudio.exe", "/FO", "CSV", "/NH"], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(false);
      const out = String(stdout);
      resolve(/MatStudio\.exe/i.test(out) && !/INFO:/i.test(out));
    });
  });
}

function startMsDetection() {
  if (msDetectTimer) return;
  msDetectTimer = setInterval(async () => {
    try {
      const running = await detectMsOnce();
      if (running && !msRunning) {
        msRunning = true;
        const firstUnlock = !msUnlocked;
        msUnlocked = true;
        termPush("ok", "检测到 Materials Studio 已启动（客户端进程 MatStudio.exe）");
        if (firstUnlock) {
          termPush("ok", "对话工作台已解锁，正在跳转 Harness 平台…");
          emit({ type: "ms_state", running: true, unlocked: true, jump: true });
        } else {
          emit({ type: "ms_state", running: true, unlocked: true, jump: false });
        }
      } else if (!running && msRunning) {
        msRunning = false;
        termPush("warn", "Materials Studio 客户端进程已退出（工作台本次会话保持解锁）");
        emit({ type: "ms_state", running: false, unlocked: msUnlocked, jump: false });
      }
    } catch { /* 检测失败静默等下一轮 */ }
  }, 3000);
}

// ---------------- 权限门 ----------------

async function gate(toolName, args) {
  const tier = CFG.permissionTier;
  if (READONLY_TOOLS.has(toolName)) return { allowed: true };
  if (tier === "auto") return { allowed: true };
  if (tier === "readonly") {
    return { allowed: false, reason: `当前权限档位为「只读」，执行类工具 ${toolName} 被禁用；请到模型配置页或输入区切换档位` };
  }
  const id = `confirm_${++confirmSeq}`;
  emit({ type: "confirm_request", id, name: toolName, args });
  const answer = await new Promise((resolve) => {
    const t = setTimeout(() => {
      confirmWaiters.delete(id);
      resolve({ allowed: false, reason: "确认超时（60 秒），视为拒绝" });
    }, 60000);
    confirmWaiters.set(id, { resolve: (v) => { clearTimeout(t); confirmWaiters.delete(id); resolve(v); } });
  });
  emit({ type: "confirm_done", id, allowed: answer.allowed, reason: answer.reason || "" });
  return answer;
}

// ---------------- 会话存储 ----------------

function newSession() {
  return {
    id: `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    title: "新对话",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
  };
}

function saveSession(s) {
  if (!s) return;
  s.updatedAt = new Date().toISOString();
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(path.join(SESSIONS_DIR, `${s.id}.json`), JSON.stringify(s, null, 1), "utf8");
}

function listSessions() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  return fs
    .readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf8"));
        return { id: j.id, title: j.title, updatedAt: j.updatedAt, msgCount: j.messages?.length || 0 };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

// ---------------- 轮次调度 ----------------

async function startTurn(text, source = "user") {
  if (!msUnlocked) return { ok: false, error: "工作台未解锁：请先在控制台启动 Materials Studio" };
  if (busy) return { ok: false, error: "上一轮还在执行中，请先停止或稍候" };
  if (!CUR) CUR = newSession();
  if (source === "user" && CUR.title === "新对话") CUR.title = text.slice(0, 30) || "新对话";
  busy = true;
  emit({ type: "busy", on: true });
  try {
    await agent.runTurn(CUR, text, { source });
  } finally {
    busy = false;
    saveSession(CUR);
    emit({ type: "busy", on: false });
    emit({ type: "session_meta", id: CUR.id, title: CUR.title, msgCount: CUR.messages.length });
    flushKeeper();
  }
  return { ok: true };
}

function flushKeeper() {
  if (!keeperQueue.length || busy) return;
  if (!CFG.jobKeeper) { keeperQueue = []; return; }
  if (!CFG.provider?.apiKey) { keeperQueue = []; return; }
  const events = keeperQueue.splice(0);
  const lines = events.map((e) =>
    `- 作业 ${e.jobId}（脚本 ${e.script}）状态变为 **${e.state}**${e.exitCode != null ? `，退出码 ${e.exitCode}` : ""}，任务目录 \`${e.taskDir}\``
  );
  const text =
    `【作业看护】以下异步作业状态有变化：\n${lines.join("\n")}\n\n` +
    `请检查对应任务目录的产物（ms_list_artifacts / ms_read_artifact），用 ms_parse_castep 严格核验收敛与能量后给出简报；` +
    `若作业失败，先读日志定位原因再汇报。遵守步进闸门：本轮只做核验简报，不启动新的计算。`;
  startTurn(text, "keeper").catch((e) => log("看护唤醒轮次失败:", e.message));
}

// ---------------- 服务状态（分层绿灯 → 终端行） ----------------

async function refreshServiceStatus() {
  if (!mcp?.ready) return;
  try {
    const st = await mcp.callTool("ms_status", {}, 30000);
    const d = st.structured;
    if (!d) return;
    const layers = {};
    for (const c of d.checks || []) {
      layers[c.layer] = layers[c.layer] ?? { ok: true, n: 0, bad: [] };
      layers[c.layer].n++;
      if (!c.ok) { layers[c.layer].ok = false; layers[c.layer].bad.push(c.name); }
    }
    const names = { L1: "运行时", L2: "MS 安装", L3: "工作区", L4: "RunMatScript" };
    for (const k of Object.keys(layers).sort()) {
      const L = layers[k];
      termPush(L.ok ? "ok" : "err", `${k} ${names[k] || ""} ${L.ok ? "✓" : `✗（${L.bad.join("、")}）`}`);
    }
    termPush(d.verdict === "GREEN" ? "ok" : "err", `服务状态判定：${d.verdict}${d.verdict === "GREEN" ? " · 服务在线" : " · 请先修复红灯层"}`);
    emit({ type: "lights", verdict: d.verdict, checks: d.checks || [] });
  } catch (e) {
    termPush("err", "状态检查失败：" + e.message);
  }
}

// ---------------- 模型连通性测试（含工具往返探测） ----------------

async function testProvider(prov) {
  const protocol = prov.protocol === "openai" ? "openai" : "anthropic";
  const url = apiUrl(prov.baseURL, protocol);
  const headers = { "content-type": "application/json" };
  if (protocol === "anthropic") {
    headers["x-api-key"] = prov.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.authorization = `Bearer ${prov.apiKey}`;
  }

  const body1 = protocol === "anthropic"
    ? { model: prov.model, max_tokens: 64, messages: [{ role: "user", content: "请只回复两个字：成功" }] }
    : { model: prov.model, messages: [{ role: "user", content: "请只回复两个字：成功" }] };
  const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify(body1) });
  if (!r1.ok) throw new Error(`HTTP ${r1.status}: ${(await r1.text().catch(() => "")).slice(0, 300)}`);
  const d1 = await r1.json();
  const text = protocol === "anthropic"
    ? (d1.content || []).filter((b) => b.type === "text").map((b) => b.text).join("")
    : d1.choices?.[0]?.message?.content || "";

  const pingTool = { name: "echo_ping", description: "测试工具：被要求时立即调用，无参数。", input_schema: { type: "object", properties: {}, additionalProperties: false } };
  const body2 = protocol === "anthropic"
    ? { model: prov.model, max_tokens: 256, messages: [{ role: "user", content: "请立即调用 echo_ping 工具。" }], tools: [pingTool] }
    : {
        model: prov.model,
        messages: [{ role: "user", content: "请立即调用 echo_ping 工具。" }],
        tools: [{ type: "function", function: { name: pingTool.name, description: pingTool.description, parameters: pingTool.input_schema } }],
        tool_choice: "auto",
      };
  const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify(body2) });
  if (!r2.ok) throw new Error(`工具探测 HTTP ${r2.status}: ${(await r2.text().catch(() => "")).slice(0, 300)}`);
  const d2 = await r2.json();
  const hasTool = protocol === "anthropic"
    ? (d2.content || []).some((b) => b.type === "tool_use")
    : !!(d2.choices?.[0]?.message?.tool_calls?.length);

  return {
    ok: true,
    detail: `文本往返 OK（回复：${(text || "").trim().slice(0, 40) || "（空）"}）；工具调用${hasTool ? "支持 ✓" : "未触发 ⚠ 该接口可能不支持 tool use，agent 功能会受限"}`,
  };
}

// ---------------- IPC ----------------

function registerIpc() {
  // 窗口控制（无框标题栏）
  ipcMain.handle("win:min", () => win?.minimize());
  ipcMain.handle("win:max", () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
  });
  ipcMain.handle("win:close", () => win?.close());

  ipcMain.handle("term:backlog", () => TERM);
  ipcMain.handle("ms:state", () => ({ running: msRunning, unlocked: msUnlocked }));

  ipcMain.handle("ms:open", () => {
    const exe = msClientExe();
    if (!fs.existsSync(exe)) {
      termPush("err", `未找到 Materials Studio 客户端：${exe}（可在 config.json 的 ms.clientExe 指定）`);
      return { ok: false, error: `未找到 ${exe}` };
    }
    spawn(exe, [], { detached: true, stdio: "ignore", cwd: path.dirname(exe) }).unref();
    termPush("info", `已请求启动 Materials Studio（${exe}），每 3 秒检测客户端进程…`);
    return { ok: true };
  });

  ipcMain.handle("cfg:get", () => ({
    config: CFG,
    appDir: APP_DIR,
    workspace: CFG.ms.workspace,
    msClientExe: msClientExe(),
    msRunning,
    msUnlocked,
    mcpReady: !!mcp?.ready,
    session: CUR ? { id: CUR.id, title: CUR.title } : null,
  }));

  ipcMain.handle("cfg:set", (_e, patch = {}) => {
    if (patch.provider) CFG.provider = { ...CFG.provider, ...patch.provider };
    if (patch.permissionTier) CFG.permissionTier = patch.permissionTier;
    if (typeof patch.jobKeeper === "boolean") {
      CFG.jobKeeper = patch.jobKeeper;
      if (CFG.jobKeeper) keeper?.start(); else keeper?.stop();
      termPush("info", `作业看护：${CFG.jobKeeper ? "开启" : "关闭"}`);
    }
    if (patch.pollSec) {
      CFG.pollSec = patch.pollSec;
      if (CFG.jobKeeper) keeper?.start();
    }
    saveConfig();
    log("配置已更新: tier=%s keeper=%s model=%s", CFG.permissionTier, CFG.jobKeeper, CFG.provider.model);
    return CFG;
  });

  ipcMain.handle("cfg:test", async (_e, { provider }) => {
    try { return await testProvider(provider); }
    catch (e) { return { ok: false, detail: String(e.message) }; }
  });

  ipcMain.handle("chat:send", (_e, { text }) => {
    const t = String(text || "").trim();
    if (!t) return { ok: false, error: "空消息" };
    return startTurn(t, "user").catch((e) => ({ ok: false, error: String(e.message) }));
  });

  ipcMain.handle("chat:stop", () => {
    agent?.abort();
    return { ok: true };
  });

  ipcMain.handle("approve", (_e, { id, ok }) => {
    const w = confirmWaiters.get(id);
    if (w) w.resolve(ok ? { allowed: true } : { allowed: false, reason: "用户拒绝执行" });
    return { ok: true };
  });

  ipcMain.handle("ui:call", async (_e, { name, args }) => {
    try {
      if (String(name).startsWith("ws_")) return await wsToolCall(CFG.ms.workspace, name, args);
      if (!mcp?.ready) return { isError: true, text: "MCP 桥未就绪", structured: null };
      return await mcp.callTool(name, args || {}, name === "ms_status" ? 30000 : 120000);
    } catch (e) {
      return { isError: true, text: String(e.message), structured: null };
    }
  });

  ipcMain.handle("svc:start", async () => {
    if (mcp?.ready) { termPush("info", "服务已在运行"); return { ok: true }; }
    termPush("info", "手动启动 MS 服务桥…");
    try { await mcp.start(); return { ok: true }; }
    catch (e) { termPush("err", "启动失败：" + e.message); return { ok: false, error: String(e.message) }; }
  });

  ipcMain.handle("svc:stop", () => {
    if (!mcp) return { ok: false };
    mcp.stop();
    termPush("warn", "MS 服务桥已停止（服务离线；工作台对话不可用）");
    emit({ type: "mcp_status", state: "stopped" });
    return { ok: true };
  });

  ipcMain.handle("mcp:restart", async () => {
    if (!mcp) return { ok: false };
    try { await mcp.restart(); return { ok: true, tools: mcp.tools.length }; }
    catch (e) { return { ok: false, error: String(e.message) }; }
  });

  ipcMain.handle("ws:tree", (_e, { sub } = {}) => {
    try {
      const base = sub ? resolveInWorkspace(CFG.ms.workspace, sub) : CFG.ms.workspace;
      const entries = fs
        .readdirSync(base, { withFileTypes: true })
        .map((e) => {
          let size = null;
          try { if (!e.isDirectory()) size = fs.statSync(path.join(base, e.name)).size; } catch {}
          return { name: e.name, dir: e.isDirectory(), size };
        })
        .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name))
        .slice(0, 80);
      return { base, entries };
    } catch (e) {
      return { entries: [], error: String(e.message) };
    }
  });

  ipcMain.handle("ws:list", () => {
    try {
      const root = CFG.ms.workspace;
      const entries = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== "jobs")
        .map((e) => ({ name: e.name, mtime: fs.statSync(path.join(root, e.name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 40);
      return { dirs: entries };
    } catch (e) {
      return { dirs: [], error: String(e.message) };
    }
  });

  ipcMain.handle("session:new", () => {
    CUR = newSession();
    return CUR;
  });
  ipcMain.handle("session:list", () => listSessions());
  ipcMain.handle("session:open", (_e, { id }) => {
    CUR = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, `${id}.json`), "utf8"));
    return CUR;
  });
  ipcMain.handle("session:delete", (_e, { id }) => {
    fs.rmSync(path.join(SESSIONS_DIR, `${id}.json`), { force: true });
    return { ok: true };
  });
}

// ---------------- 装配 ----------------

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1080,
    minHeight: 680,
    frame: false, // dsh 式自定义标题栏
    backgroundColor: "#0d0f12",
    title: "MS Harness",
    webPreferences: {
      preload: path.join(APP_DIR, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(APP_DIR, "renderer", "index.html"));
  win.webContents.on("console-message", (...a) => {
    const e = a[0];
    const msg = e && typeof e === "object" && "message" in e ? e.message : a[2];
    if (msg) log("[renderer]", msg);
  });
  win.on("closed", () => { win = null; });
}

app.whenReady().then(async () => {
  registerIpc();
  createWindow();

  const ms = CFG.ms;
  termPush("info", `准备启动 MS 服务桥（目标工作区 ${ms.workspace}）`);
  termPush("info", "启动方式：node 直连（跳过 npx，无需 shell）");
  termPush("info", "执行：node.exe + ms-mcp 入口 server.mjs");

  let nodePath = ms.nodePath;
  let extraEnv = {};
  if (!fs.existsSync(nodePath)) {
    nodePath = process.execPath;
    extraEnv = { ELECTRON_RUN_AS_NODE: "1" };
    termPush("warn", "未找到系统 node，回退 ELECTRON_RUN_AS_NODE 模式");
  }
  mcp = new McpClient({
    nodePath,
    serverPath: ms.serverPath,
    cwd: path.dirname(ms.serverPath),
    env: {
      ...extraEnv,
      MS_INSTALL_ROOT: ms.installRoot,
      MS_SERVER_ROOT: ms.serverRoot,
      MS_MCP_WORKSPACE: ms.workspace,
    },
    onEvent: (ev) => {
      emit(ev);
      if (ev.type === "mcp_status") {
        if (ev.state === "ready") {
          termPush("ok", `MS 服务桥就绪（${ev.tools} 个工具）`);
          refreshServiceStatus();
        } else if (ev.state === "exited") termPush("err", "MS 服务桥进程退出，正在自动重启…");
        else if (ev.state === "error") termPush("err", "MS 服务桥启动失败：" + (ev.message || ""));
        else if (ev.state === "restarting") termPush("warn", "MS 服务桥重启中…");
      } else if (ev.type === "mcp_log") {
        termPush("dim", ev.text);
      }
    },
  });
  try {
    await mcp.start();
  } catch (e) {
    termPush("err", "MS 服务桥启动失败：" + e.message);
    emit({ type: "mcp_status", state: "error", message: String(e.message) });
  }

  agent = new AgentLoop({
    emit,
    gate,
    callTool: async (name, args, timeoutMs) =>
      String(name).startsWith("ws_") ? wsToolCall(ms.workspace, name, args) : mcp.callTool(name, args, timeoutMs),
    getTools: () => [
      ...(mcp?.tools || []).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      ...WS_TOOLS,
    ],
    getConfig: () => CFG,
    systemPrompt: buildSystemPrompt({ workspace: ms.workspace, installRoot: ms.installRoot, date: new Date().toISOString().slice(0, 10) }),
  });

  keeper = new JobKeeper({
    intervalMs: Math.max(20, Number(CFG.pollSec) || 60) * 1000,
    poll: () => (mcp?.ready ? mcp.callTool("ms_job_list", {}, 60000) : null),
    onEvent: (ev) => {
      emit(ev);
      keeperQueue.push(ev);
      termPush("warn", `作业事件：${ev.jobId}（${ev.script}）→ ${ev.state}`);
      if (!busy) flushKeeper();
    },
  });
  if (CFG.jobKeeper) keeper.start();

  // MS 客户端进程检测（已启动则直接解锁）
  startMsDetection();
  detectMsOnce().then((running) => {
    if (running) {
      msRunning = true;
      msUnlocked = true;
      termPush("ok", "检测到 Materials Studio 已在运行，对话工作台解锁");
      emit({ type: "ms_state", running: true, unlocked: true, jump: true });
    } else {
      termPush("dim", "Materials Studio 客户端未运行；点击「打开 Material Studio」启动后自动跳转工作台");
    }
  });

  log("MS Harness 就绪（workspace=%s）", ms.workspace);
});

app.on("before-quit", () => {
  try { keeper?.stop(); } catch {}
  try { mcp?.stop(); } catch {}
  if (msDetectTimer) clearInterval(msDetectTimer);
});
app.on("window-all-closed", () => app.quit());
