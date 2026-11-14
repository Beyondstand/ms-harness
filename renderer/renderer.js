// MS Harness — 渲染进程（dsh-desktop 形态：控制台 / 对话工作台 / 模型配置 三视图）
"use strict";

const $ = (id) => document.getElementById(id);
const S = {
  config: null,
  view: "console",
  msRunning: false,
  msUnlocked: false,
  mcpReady: false,
  busy: false,
  busyStart: 0,
  timerInt: null,
  term: [],          // {t, kind, text}
  termFilter: "",
  expandedDirs: new Set(),
  bell: 0,
  activeSessionId: null,
  toolCards: new Map(),
};

// ---------- 基础 ----------
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function fmtSize(n) {
  if (n == null) return "";
  if (n < 1024) return n + "B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + "KB";
  return (n / 1024 / 1024).toFixed(1) + "MB";
}
function md(text) {
  const parts = String(text ?? "").split(/```/);
  let html = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      let code = parts[i];
      const nl = code.indexOf("\n");
      if (nl >= 0 && code.slice(0, nl).trim().length <= 12) code = code.slice(nl + 1);
      html += `<pre>${esc(code.replace(/\n$/, ""))}</pre>`;
    } else {
      let t = esc(parts[i]);
      t = t.replace(/`([^`\n]+)`/g, "<code>$1</code>");
      t = t.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
      t = t.replace(/^#{1,4}\s+(.+)$/gm, "<strong>$1</strong>");
      t = t.replace(/^[-*]\s+(.+)$/gm, "• $1");
      html += t;
    }
  }
  return html;
}
function scrollBottom() { const c = $("chat"); c.scrollTop = c.scrollHeight; }
function clearWelcome() { const w = $("welcome"); if (w) w.remove(); }

// ---------- 视图切换 ----------
const VIEW_NAMES = { console: "console", harness: "harness", modelcfg: "modelcfg" };

function showView(name) {
  S.view = name;
  for (const v of ["console", "harness", "modelcfg"]) {
    $(`view-${v}`).classList.toggle("hidden", v !== name);
  }
  document.querySelectorAll(".nav").forEach((n) => n.classList.toggle("active", n.dataset.view === name));
  $("tb-view").textContent = VIEW_NAMES[name] || name;
  $("sb-view").textContent = VIEW_NAMES[name] || name;
  // 标题栏右侧动作按钮：工作台里是"返回控制台"，其余是"打开 Material Studio"
  if (name === "harness") {
    $("tb-action").textContent = "◀ 返回控制台";
  } else {
    $("tb-action").textContent = S.msRunning ? "🚀 Material Studio 运行中" : "🚀 打开 Material Studio";
  }
  if (name === "console") refreshTree();
}

// ---------- 标题栏 ----------
$("tb-min").addEventListener("click", () => window.harness.invoke("win:min"));
$("tb-max").addEventListener("click", () => window.harness.invoke("win:max"));
$("tb-close").addEventListener("click", () => window.harness.invoke("win:close"));
$("tb-action").addEventListener("click", () => {
  if (S.view === "harness") { showView("console"); return; }
  openMs();
});

async function openMs() {
  if (S.msRunning) {
    addTermLineLocal({ t: nowStr(), kind: "info", text: "Materials Studio 已在运行，无需重复启动。" });
    return;
  }
  const r = await window.harness.invoke("ms:open");
  if (!r?.ok) addTermLineLocal({ t: nowStr(), kind: "err", text: "启动失败：" + (r?.error || "?") });
}

document.querySelectorAll(".nav").forEach((n) => {
  n.addEventListener("click", () => {
    if (n.dataset.view === "harness" && !S.msUnlocked) {
      addTermLineLocal({ t: nowStr(), kind: "warn", text: "对话工作台未解锁：请先「打开 Material Studio」，检测到客户端启动后自动跳转。" });
      showView("console");
      return;
    }
    showView(n.dataset.view);
  });
});

// ---------- 终端 ----------
function nowStr() {
  return new Date().toISOString().slice(11, 19);
}

function renderTerm() {
  const box = $("terminal");
  const f = S.termFilter.toLowerCase();
  const lines = f ? S.term.filter((l) => l.text.toLowerCase().includes(f)) : S.term;
  box.innerHTML = lines
    .map(
      (l) =>
        `<div class="tline kind-${esc(l.kind)}"><span class="ts">[${esc(l.t)}]</span> <span class="arrow">▶</span> ${esc(l.text)}</div>`
    )
    .join("");
  $("term-count").textContent = `${S.term.length} 行`;
  box.scrollTop = box.scrollHeight;
}

function addTermLineLocal(line) {
  S.term.push(line);
  renderTerm();
}

$("term-filter").addEventListener("input", (e) => {
  S.termFilter = e.target.value;
  renderTerm();
});

// ---------- 文件树 ----------
async function refreshTree() {
  const root = await window.harness.invoke("ws:tree");
  if (!root?.entries) return;
  const parts = [];
  parts.push(`<div class="ft-path">📁 ${esc(root.base || S.config?.ms?.workspace || "")}</div>`);
  for (const e of root.entries) {
    const isOpen = S.expandedDirs.has(e.name);
    parts.push(
      `<div class="ft-row" data-dir="${esc(e.name)}" data-isdir="${e.dir}">` +
        `<span>${e.dir ? (isOpen ? "📂" : "📁") : "📄"}</span><span class="nm">${esc(e.name)}</span>` +
        `<span class="sz">${e.dir ? "" : fmtSize(e.size)}</span></div>`
    );
    if (e.dir && isOpen) {
      const sub = await window.harness.invoke("ws:tree", { sub: e.name });
      for (const f of sub?.entries || []) {
        parts.push(
          `<div class="ft-row sub"><span>${f.dir ? "📁" : "📄"}</span><span class="nm">${esc(f.name)}</span>` +
            `<span class="sz">${f.dir ? "" : fmtSize(f.size)}</span></div>`
        );
      }
    }
  }
  $("filetree").innerHTML = parts.join("");
}

$("filetree").addEventListener("click", (e) => {
  const row = e.target.closest("[data-dir]");
  if (!row || row.dataset.isdir !== "true") return;
  const name = row.dataset.dir;
  if (S.expandedDirs.has(name)) S.expandedDirs.delete(name);
  else S.expandedDirs.add(name);
  refreshTree();
});

// ---------- 服务状态 chips ----------
function setSvc(on) {
  S.mcpReady = on;
  const txt = on ? "服务在线" : "服务离线";
  $("svc-chip-text").textContent = txt;
  $("svc-chip").className = "svc-chip " + (on ? "on" : "off");
  $("svc-chip2-text").textContent = txt;
  $("svc-chip2").className = "svc-chip sm " + (on ? "on" : "off");
  $("svc-badge").textContent = on ? "服务在线" : "服务离线";
  $("svc-badge").className = "badge " + (on ? "on" : "off");
  $("sb-svc").textContent = txt;
  $("nav-dot-svc").classList.toggle("hidden", !on);
}

function setMsState(running, unlocked) {
  S.msRunning = running;
  S.msUnlocked = unlocked;
  $("nav-lock").textContent = unlocked ? "✓" : "🔒";
  $("nav-lock").title = unlocked ? "已解锁" : "检测到 Materials Studio 启动后解锁";
  $("sb-ms").textContent = `MS: ${running ? "运行中" : "未运行"}${unlocked ? " · 工作台解锁" : ""}`;
  if (S.view !== "harness") {
    $("tb-action").textContent = S.view === "harness" ? "◀ 返回控制台"
      : running ? "🚀 Material Studio 运行中" : "🚀 打开 Material Studio";
  }
}

// ---------- 侧栏列表 ----------
async function refreshDirs() {
  const r = await window.harness.invoke("ws:list");
  const dirs = r?.dirs || [];
  $("taskdirs").innerHTML = dirs.length
    ? dirs.map((d) => `<div class="item" data-dir="${esc(d.name)}" title="${esc(d.name)}">${esc(d.name)}</div>`).join("")
    : `<span class="dim small">暂无任务目录</span>`;
}

async function refreshSessions() {
  const list = await window.harness.invoke("session:list");
  $("sessions").innerHTML = (list || [])
    .map(
      (s) =>
        `<div class="item ${s.id === S.activeSessionId ? "active" : ""}" data-sid="${esc(s.id)}" title="${esc(s.title)}">` +
        `<span>${esc(s.title)}</span><span class="del" data-del="${esc(s.id)}">✕</span></div>`
    )
    .join("") || `<span class="dim small">暂无会话</span>`;
}

// ---------- 工作台：聊天渲染 ----------
function addBubble(html, cls) {
  clearWelcome();
  const d = document.createElement("div");
  d.className = `msg ${cls}`;
  d.innerHTML = html;
  $("chat").appendChild(d);
  scrollBottom();
  return d;
}
function addUser(text) { addBubble(md(text), "user"); }
function addAssistant(text) { addBubble(`<div class="who">AI</div><div class="body">${md(text)}</div>`, "assistant"); }
function addNotice(text, extra = "") { addBubble(esc(text), `notice ${extra}`); }
function addError(text) { addBubble(esc(text), "error"); }
function addJobBanner(ev) {
  addBubble(
    `📋 作业看护：<b>${esc(ev.jobId)}</b>（${esc(ev.script)}）→ <b>${esc(ev.state)}</b>` +
      (ev.exitCode != null ? `，退出码 ${esc(ev.exitCode)}` : ""),
    "job"
  );
}

function addToolStart(ev) {
  const d = addBubble(
    `<div class="tool-head"><span>🔧</span><b>${esc(ev.name)}</b><span class="spin">执行中…</span></div>` +
      `<div class="tool-args">${esc(JSON.stringify(ev.args ?? {})).slice(0, 400)}</div>`,
    "tool"
  );
  S.toolCards.set(ev.id, d);
  return d;
}

function fillToolCard(ev) {
  const d = S.toolCards.get(ev.id) || addToolStart(ev);
  S.toolCards.delete(ev.id);
  const status = ev.isError ? `<span class="status-err">✗</span>` : `<span class="status-ok">✓</span>`;
  d.querySelector(".tool-head").innerHTML =
    `<span>🔧</span><b>${esc(ev.name)}</b>` +
    (ev.ms != null ? `<span class="dim">${ev.ms} ms</span>` : "") +
    status;
  let result = d.querySelector(".tool-result");
  if (!result) {
    result = document.createElement("div");
    result.className = "tool-result";
    d.appendChild(result);
  }
  const text = String(ev.text ?? "");
  result.innerHTML = `<details><summary>结果（${text.length} 字符）</summary><pre>${esc(text)}</pre></details>`;
  scrollBottom();
}

function addConfirmCard(ev) {
  const d = addBubble(
    `<div>⚙ 权限确认：<b>${esc(ev.name)}</b></div>` +
      `<pre>${esc(JSON.stringify(ev.args ?? {}, null, 1)).slice(0, 600)}</pre>` +
      `<div class="row"><button class="btn primary" data-approve="${esc(ev.id)}" data-ok="1">✓ 执行</button>` +
      `<button class="btn" data-approve="${esc(ev.id)}" data-ok="0">✗ 拒绝</button></div>`,
    "confirm"
  );
  d.dataset.confirmId = ev.id;
}

function resolveConfirmCard(ev) {
  const d = [...$("chat").children].find((x) => x.dataset?.confirmId === ev.id);
  if (d) {
    d.querySelector(".row")?.remove();
    const span = document.createElement("div");
    span.className = ev.allowed ? "status-ok" : "status-err";
    span.textContent = ev.allowed ? "✓ 已批准" : `✗ 已拒绝${ev.reason ? `：${ev.reason}` : ""}`;
    d.appendChild(span);
  }
}

function renderTranscript(session) {
  $("chat").innerHTML = `<div id="welcome" class="welcome"></div>`;
  S.toolCards.clear();
  const msgs = session.messages || [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === "user") {
      addUser(m.text);
    } else if (m.role === "assistant") {
      if (m.text) addAssistant(m.text);
    } else {
      let args = null;
      for (let j = i - 1; j >= 0; j--) {
        const a = msgs[j];
        if (a.role === "assistant" && a.toolCalls?.length) {
          const tc = a.toolCalls.find((t) => t.id === m.toolCallId);
          if (tc) args = tc.args;
          break;
        }
      }
      fillToolCard({ id: m.toolCallId, name: m.toolName, args, text: m.text, isError: m.isError, ms: null });
    }
  }
  if (!msgs.length) {
    $("chat").innerHTML = `<div id="welcome" class="welcome">
      <h1>MS Harness 工作台</h1>
      <p>用自然语言下达 Materials Studio 建模与计算指令。</p>
    </div>`;
  }
  scrollBottom();
}

function setBusy(on) {
  S.busy = on;
  $("btn-stop").classList.toggle("hidden", !on);
  $("btn-send").classList.toggle("hidden", on);
  if (on) {
    S.busyStart = Date.now();
    S.timerInt = setInterval(() => {
      $("timer").textContent = `已等待 ${Math.round((Date.now() - S.busyStart) / 1000)}s`;
    }, 500);
  } else {
    clearInterval(S.timerInt);
    $("timer").textContent = "";
    S.toolCards.clear();
  }
}

// ---------- 工作台：chips ----------
function updateChips() {
  const p = S.config?.provider || {};
  $("chip-model").textContent = p.model ? `${p.protocol} · ${p.model}` : "未配置模型";
  $("chip-model").className = "chip" + (p.apiKey && p.baseURL && p.model ? " on" : " warn");
  const tierNames = { auto: "完全自动", confirm: "需确认", readonly: "只读" };
  $("tier").value = S.config?.permissionTier || "auto";
  $("chip-tier-label").textContent = `档位：${tierNames[S.config?.permissionTier] || "完全自动"}`;
  $("chip-keeper").textContent = `看护：${S.config?.jobKeeper ? "开" : "关"}`;
  $("chip-keeper").className = "chip toggle" + (S.config?.jobKeeper ? " on" : "");
}

// ---------- 模型配置页 ----------
function gatherProvider() {
  return {
    protocol: $("f-protocol").value,
    baseURL: $("f-base").value.trim(),
    apiKey: $("f-key").value.trim(),
    model: $("f-model").value.trim(),
    maxTokens: Number($("f-maxtok").value) || 8192,
  };
}

async function loadCfgForm() {
  const p = S.config?.provider || {};
  $("f-protocol").value = p.protocol || "anthropic";
  $("f-base").value = p.baseURL || "";
  $("f-key").value = p.apiKey || "";
  $("f-model").value = p.model || "";
  $("f-maxtok").value = p.maxTokens || 8192;
  $("f-keeper").checked = !!S.config?.jobKeeper;
  $("test-result").classList.add("hidden");
}

async function saveCfg() {
  const patch = { provider: gatherProvider(), jobKeeper: $("f-keeper").checked };
  S.config = await window.harness.invoke("cfg:set", patch);
  updateChips();
  const tr = $("test-result");
  tr.classList.remove("hidden", "err");
  tr.classList.add("ok");
  tr.textContent = "已保存 config.json。";
}

async function testCfg() {
  const tr = $("test-result");
  tr.classList.remove("hidden", "ok", "err");
  tr.textContent = "测试中…（最长约 30 秒）";
  const r = await window.harness.invoke("cfg:test", { provider: gatherProvider() });
  tr.classList.add(r?.ok ? "ok" : "err");
  tr.textContent = r?.detail || String(r);
}

$("btn-save-cfg").addEventListener("click", saveCfg);
$("btn-test").addEventListener("click", testCfg);

// ---------- 控制台动作 ----------
$("btn-open-ms").addEventListener("click", openMs);
$("btn-svc-start").addEventListener("click", () => window.harness.invoke("svc:start"));
$("btn-svc-stop").addEventListener("click", () => window.harness.invoke("svc:stop"));
$("btn-refresh-status").addEventListener("click", () => window.harness.invoke("ui:call", { name: "ms_status" }));

// ---------- 工作台交互 ----------
$("btn-send").addEventListener("click", send);
$("btn-stop").addEventListener("click", () => window.harness.invoke("chat:stop"));
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

async function send() {
  const text = $("input").value.trim();
  if (!text || S.busy) return;
  if (!S.msUnlocked) {
    addError("⚠ 工作台未解锁：请先在控制台「打开 Material Studio」。");
    return;
  }
  $("input").value = "";
  addUser(text);
  const r = await window.harness.invoke("chat:send", { text });
  if (r && !r.ok) addError("⚠ " + (r.error || "发送失败"));
}

$("tier").addEventListener("change", async (e) => {
  S.config = await window.harness.invoke("cfg:set", { permissionTier: e.target.value });
  updateChips();
  addNotice(`权限档位 → ${e.target.selectedOptions[0].text}`);
});

$("chip-keeper").addEventListener("click", async () => {
  S.config = await window.harness.invoke("cfg:set", { jobKeeper: !S.config?.jobKeeper });
  updateChips();
});

$("chat").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-approve]");
  if (btn) window.harness.invoke("approve", { id: btn.dataset.approve, ok: btn.dataset.ok === "1" });
});

$("taskdirs").addEventListener("click", (e) => {
  const it = e.target.closest("[data-dir]");
  if (it) {
    const input = $("input");
    input.value = (input.value ? input.value + " " : "") + `（任务目录：${it.dataset.dir}）`;
    showView("harness");
    input.focus();
  }
});

$("sessions").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-del]");
  if (del) {
    await window.harness.invoke("session:delete", { id: del.dataset.del });
    refreshSessions();
    return;
  }
  const it = e.target.closest("[data-sid]");
  if (it) {
    const s = await window.harness.invoke("session:open", { id: it.dataset.sid });
    S.activeSessionId = s.id;
    renderTranscript(s);
    showView("harness");
    refreshSessions();
  }
});

// ---------- 主进程事件总线 ----------
window.harness.onEvent((ev) => {
  switch (ev.type) {
    case "term_log":
      S.term.push(ev.line);
      if (S.term.length > 800) S.term.shift();
      renderTerm();
      break;
    case "lights":
      // 分层状态灯已通过终端行展示；此处可扩展
      break;
    case "mcp_status":
      setSvc(ev.state === "ready");
      if (ev.state === "ready") refreshTree();
      break;
    case "ms_state":
      setMsState(ev.running, ev.unlocked);
      if (ev.jump) showView("harness");
      break;
    case "turn_start":
      setBusy(true);
      if (ev.source === "keeper") addNotice("— 作业看护唤醒 —", "divider");
      break;
    case "assistant_text":
      addAssistant(ev.text);
      break;
    case "tool_start":
      addToolStart(ev);
      break;
    case "tool_result":
      fillToolCard(ev);
      break;
    case "confirm_request":
      addConfirmCard(ev);
      break;
    case "confirm_done":
      resolveConfirmCard(ev);
      break;
    case "turn_end":
      setBusy(false);
      break;
    case "error":
      addError("⚠ " + ev.message);
      break;
    case "busy":
      setBusy(ev.on);
      break;
    case "job_event":
      addJobBanner(ev);
      break;
    case "mcp_log":
      break; // server stderr 已由主进程并入终端
    case "session_meta":
      S.activeSessionId = ev.id;
      refreshSessions();
      break;
  }
});

// ---------- 启动 ----------
(async function init() {
  const info = await window.harness.invoke("cfg:get");
  S.config = info.config;
  setSvc(info.mcpReady);
  setMsState(info.msRunning, info.msUnlocked);
  $("ws-label").textContent = `工作区：${info.workspace}`;
  $("sb-ws").textContent = info.workspace;
  if (info.session) S.activeSessionId = info.session.id;

  const backlog = await window.harness.invoke("term:backlog");
  S.term = backlog || [];
  renderTerm();

  refreshSessions();
  refreshDirs();
  refreshTree();
  loadCfgForm();
  updateChips();
  showView("console");
  setInterval(refreshDirs, 30000);
  console.log("MS Harness renderer ready, workspace=" + info.workspace);
})();
