#!/usr/bin/env node
/**
 * ms-mcp — Materials Studio ↔ ZCode MCP 桥（STDIO，零依赖）
 *
 * 设计背景见 README.md。核心约束：
 *  1. 文件访问仅限 MS_MCP_WORKSPACE 指定的工作区目录（安全边界）
 *  2. 一切执行走 RunMatScript.bat 头less CLI（接口优先：脚本 > GUI）
 *  3. 领域精度约束（pilot-first、严格 .castep 解析等）写入工具描述 + 任务提示词
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_INFO = { name: "ms-mcp", title: "Materials Studio MCP Bridge", version: "1.0.0" };

// ---------------------------------------------------------------------------
// 配置（环境变量覆盖，绝对路径——ZCode 配置文件不展开 ${...} 模板）
// ---------------------------------------------------------------------------
const MS_INSTALL_ROOT =
  process.env.MS_INSTALL_ROOT || "C:\\Program Files (x86)\\BIOVIA\\Materials Studio 23.1";
const MS_SERVER_ROOT =
  process.env.MS_SERVER_ROOT || "C:\\Program Files (x86)\\BIOVIA\\Materials Studio 23.1 x64 Server";
const WORKSPACE_ROOT = path.resolve(
  process.env.MS_MCP_WORKSPACE || path.join(SERVER_DIR, "workspace")
);
const RUNMATSCRIPT = path.join(MS_INSTALL_ROOT, "etc", "Scripting", "bin", "RunMatScript.bat");
const DEFAULT_SYNC_TIMEOUT_MS = Number(process.env.MS_RUN_TIMEOUT_MS || 120_000);
const MAX_SYNC_TIMEOUT_MS = 600_000;
const MAX_LOG_TAIL = 4000;

// ---------------------------------------------------------------------------
// 路径安全边界：所有文件操作必须落在 WORKSPACE_ROOT 之内
// ---------------------------------------------------------------------------
function resolveInWorkspace(relOrAbs, { mustExist = false, expectDir = false } = {}) {
  const raw = relOrAbs == null || relOrAbs === "" ? "." : String(relOrAbs);
  const abs = path.resolve(WORKSPACE_ROOT, raw);
  const root = WORKSPACE_ROOT.endsWith(path.sep) ? WORKSPACE_ROOT : WORKSPACE_ROOT + path.sep;
  const norm = (p) => p.replace(/\//g, "\\").toLowerCase();
  if (norm(abs) !== norm(WORKSPACE_ROOT) && !norm(abs).startsWith(norm(root))) {
    throw new Error(`安全边界拒绝：${abs} 不在工作区 ${WORKSPACE_ROOT} 之内`);
  }
  if (mustExist && !fs.existsSync(abs)) throw new Error(`路径不存在：${abs}`);
  if (mustExist && expectDir && !fs.statSync(abs).isDirectory()) throw new Error(`不是目录：${abs}`);
  return abs;
}

function assertSafeName(name, what) {
  if (typeof name !== "string" || !/^[A-Za-z0-9_\-]+$/.test(name)) {
    throw new Error(`${what} 只允许字母/数字/下划线/连字符（不含 .pl、不含路径）：${String(name)}`);
  }
  return name;
}

function assertSafeArg(arg) {
  const s = String(arg);
  if (!/^[A-Za-z0-9_.=\-\/+:,@\[\]]*$/.test(s)) {
    throw new Error(`脚本参数含不安全字符（禁止引号/百分号/管道/与号等）：${s}`);
  }
  return s;
}

function tail(text, max = MAX_LOG_TAIL) {
  if (text == null) return "";
  return text.length <= max ? text : "…(截断)…\n" + text.slice(-max);
}

function readTextIfExists(p, max = 4_000_000) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    if (st.size > max) return { path: p, size: st.size, truncated: true, text: "" };
    return { path: p, size: st.size, truncated: false, text: fs.readFileSync(p, "utf8") };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// RunMatScript 调用：生成 wrapper .bat（规避 Git Bash/引号问题），再由 cmd 执行
// ---------------------------------------------------------------------------
function buildWrapper({ taskDir, script, cores, queue, project, scriptArgs }) {
  const parts = [`"${RUNMATSCRIPT}"`];
  if (cores != null) parts.push("-np", String(cores));
  if (queue) parts.push("-q", assertSafeName(queue, "队列名"));
  if (project === true) parts.push("-project");
  else if (project === false) parts.push("-flat");
  parts.push(assertSafeName(script, "脚本名"));
  if (scriptArgs && scriptArgs.length) {
    parts.push("--");
    for (const a of scriptArgs) parts.push(`"${assertSafeArg(a)}"`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const wrapperPath = path.join(taskDir, `run_${stamp}.bat`);
  const body = [
    "@echo off",
    `cd /d "${taskDir}"`,
    `call ${parts.join(" ")}`,
    "echo EXITCODE=%ERRORLEVEL%",
    "",
  ].join("\r\n");
  fs.writeFileSync(wrapperPath, body, "utf8");
  return wrapperPath;
}

function listArtifacts(taskDir) {
  try {
    return fs
      .readdirSync(taskDir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const st = fs.statSync(path.join(taskDir, e.name));
        return { name: e.name, size: st.size, mtime: st.mtime.toISOString() };
      });
  } catch {
    return [];
  }
}

function parseExitCode(logText) {
  const m = /EXITCODE=(\d+)/.exec(logText || "");
  return m ? Number(m[1]) : null;
}

function runMatScriptSync({ taskDir, script, cores, queue, project, scriptArgs, timeoutMs }) {
  const wrapperPath = buildWrapper({ taskDir, script, cores, queue, project, scriptArgs });
  const logPath = wrapperPath.replace(/\.bat$/, ".log");
  const res = spawnSync("cmd.exe", ["/d", "/c", wrapperPath], {
    cwd: taskDir,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  const combined = `${res.stdout || ""}${res.stderr || ""}`;
  fs.writeFileSync(logPath, combined, "utf8");
  const timedOut = res.error && res.error.code === "ETIMEDOUT";
  const exitCode = timedOut ? null : (res.status ?? null);
  const declared = parseExitCode(combined);
  return {
    script,
    taskDir,
    wrapper: path.basename(wrapperPath),
    log: path.basename(logPath),
    exitCode: declared ?? exitCode,
    timedOut,
    spawnError: res.error ? String(res.error.message) : null,
    stdoutTail: tail(combined),
    artifacts: listArtifacts(taskDir),
  };
}

// ---------------------------------------------------------------------------
// 异步作业（长时 CASTEP 用）：manifest 落盘，父进程重启也不丢观测
// ---------------------------------------------------------------------------
const JOBS_DIR = path.join(WORKSPACE_ROOT, "jobs");

function saveJob(job) {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  fs.writeFileSync(path.join(JOBS_DIR, `${job.id}.json`), JSON.stringify(job, null, 2), "utf8");
}

function loadJob(jobId) {
  assertSafeName(jobId, "作业 ID");
  const p = path.join(JOBS_DIR, `${jobId}.json`);
  if (!fs.existsSync(p)) throw new Error(`作业不存在：${jobId}`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function refreshJob(job) {
  const logFile = readTextIfExists(job.logPath, 200_000);
  const logText = logFile ? logFile.text : "";
  const exitCode = parseExitCode(logText);
  if (job.state === "running") {
    if (exitCode !== null) {
      job.state = exitCode === 0 ? "completed" : "failed";
      job.exitCode = exitCode;
      job.endedAt = new Date().toISOString();
    } else if (!pidAlive(job.pid)) {
      job.state = "failed";
      job.exitCode = null;
      job.endedAt = new Date().toISOString();
      job.note = "进程已退出但日志中无 EXITCODE 标记，请查看日志";
    }
    saveJob(job);
  }
  job.logTail = tail(logText);
  return job;
}

// ---------------------------------------------------------------------------
// 严格 .castep 解析：不信 Report->Lines，只认原始输出里的收敛证据
// ---------------------------------------------------------------------------
function parseCastepFile(absPath) {
  const file = readTextIfExists(absPath, 200 * 1024 * 1024);
  if (!file) throw new Error(`无法读取 .castep 文件：${absPath}`);
  const text = file.text;
  const lines = text.split(/\r?\n/);

  const evidence = {
    converged: [],
    energies: [],
    cutoff: [],
    kpoints: [],
    smearing: [],
    errors: [],
  };
  const rx = {
    converged: /(SCF\s+converged|converged\s+(in|after)\s+\d+\s+(cycles|iterations)|has\s+converged|BFGS:\s+finished|Geometry\s+optimisation\s+completed)/i,
    energyE0: /Final\s+energy,\s*E\s*->\s*0\s*=\s*(-?\d+(?:\.\d+)?)\s*eV/i,
    energyFree: /Final\s+energy\s*=\s*(-?\d+(?:\.\d+)?)\s*eV/i,
    energyNoEntropy: /Energy\s+without\s+entropy\s*=\s*(-?\d+(?:\.\d+)?)\s*eV/i,
    cutoff: /(plane\s*wave\s*basis\s*set\s*cut-?off|cut-?off\s*energy)\D{0,20}(\d+(?:\.\d+)?)\s*eV/i,
    kpoints: /(k-?points?|Monkhorst[ -]Pack)\s*[:=]?\s*.*\d+x\d+x\d+/i,
    irreducible: /(\d+)\s+irreducible\s+k-?points?/i,
    smearing: /(smearing|width)\D{0,30}(\d+(?:\.\d+)?)\s*eV/i,
    error: /(Fatal error|Out of memory|memory required|failed to converge|Unable to find a solution|error in|FAILED|Traceback|segmentation)/i,
  };

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (rx.converged.test(t)) evidence.converged.push(t.slice(0, 200));
    const e0 = rx.energyE0.exec(t);
    const ef = rx.energyFree.exec(t);
    const en = rx.energyNoEntropy.exec(t);
    if (e0) evidence.energies.push({ kind: "E0", value: eV(e0[1]), line: t.slice(0, 200) });
    else if (en) evidence.energies.push({ kind: "no_entropy", value: eV(en[1]), line: t.slice(0, 200) });
    else if (ef) evidence.energies.push({ kind: "free", value: eV(ef[1]), line: t.slice(0, 200) });
    const c = rx.cutoff.exec(t);
    if (c) evidence.cutoff.push({ value: eV(c[2]), line: t.slice(0, 200) });
    if (rx.kpoints.test(t)) evidence.kpoints.push(t.slice(0, 200));
    const irr = rx.irreducible.exec(t);
    if (irr) evidence.kpoints.push(`irreducible k-points = ${irr[1]}`);
    const sm = rx.smearing.exec(t);
    if (sm) evidence.smearing.push({ value: eV(sm[2]), line: t.slice(0, 200) });
    if (rx.error.test(t)) evidence.errors.push(t.slice(0, 200));
  }

  // 0 K 外推能量优先；缺失时退回无熵能，再退自由能——同一比较必须用同一标签
  const primary =
    evidence.energies.find((e) => e.kind === "E0") ||
    evidence.energies.find((e) => e.kind === "no_entropy") ||
    evidence.energies.find((e) => e.kind === "free") ||
    null;

  const hasConverged = evidence.converged.length > 0;
  const hasEnergy = primary != null;
  const hasError = evidence.errors.length > 0;
  const verdict = hasConverged && hasEnergy && !hasError ? "valid" : "invalid";
  const reasons = [];
  if (!hasConverged) reasons.push("未找到 SCF/几何收敛标记");
  if (!hasEnergy) reasons.push("未找到最终能量");
  if (hasError) reasons.push(`发现错误行 ${evidence.errors.length} 条`);

  return {
    path: absPath,
    size: file.size,
    verdict,
    reasons,
    primaryEnergy: primary, // { kind, value(eV), line } —— 比较两个结构时 kind 必须一致
    evidence: {
      convergedMarkers: evidence.converged.slice(0, 10),
      energies: evidence.energies.slice(0, 10),
      cutoff_eV: evidence.cutoff.slice(0, 5),
      kpoints: evidence.kpoints.slice(0, 5),
      smearing_eV: evidence.smearing.slice(0, 5),
      errors: evidence.errors.slice(0, 10),
    },
  };
}

function eV(s) {
  return { raw: s, eV: Number(s) };
}

// ---------------------------------------------------------------------------
// 任务提示词：约束双保险（桥注入 + 提示词重申）
// ---------------------------------------------------------------------------
function taskPromptText(taskName) {
  return `# Materials Studio 任务约束（自动生成，任务：${taskName}）

全流程根据用户指令进行任务，遵守以下强约束：

1. **步进闸门**：每完成一步就停下，报告当前状态和产物路径，等用户确认后再进入下一步；不得自行进入下一环节。（提示：模型可能偷跑，每步后需读取工作区状态/日志核实。）
2. **接口优先**：一律走 MaterialsScript（.pl）+ RunMatScript CLI 工具；GUI 控制仅在无脚本接口时使用。
3. **取材三分支**：需要结构/模板/参数时，优先用工作区已有文件（校验后用或弃）→ 开放数据库下载到本目录 → 受限库问用户要凭据；手动构建前必须先取文献/官方文档的公认参数并列出依据，禁止凭记忆编造数值。
4. **失败处理**：失败不删不覆盖原文件；报告任务标识符、日志路径、初步原因；在上次产物上修改重试；每次尝试用独立文件名（追加序号或时间戳）。
5. **反馈回报**：每个任务回报任务名、状态（排队/运行中/完成/失败）、关键结果数值、产物文件路径。
6. **安全边界**：只访问本任务目录（工作区）内的文件；覆盖/删除/提交外部任务前逐一询问用户。
7. **pilot-first**：批量计算前先跑一个 --pilot-one 代表性任务；命令行有变化时展示完整命令并获确认后再提交。
8. **严格解析**：能量与收敛只认原始 .castep 文件（ms_parse_castep），不信任 Report->Lines；未收敛任务标记 invalid 并排除出统计；比较两个结构前确认能量标签（E0/free/no_entropy）一致。

工作区根目录：${WORKSPACE_ROOT}
任务目录：${path.join(WORKSPACE_ROOT, taskName)}
`;
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: "ms_status",
    description:
      "分层连通性检查（每层绿灯后才依赖下一层）：L1 运行时 → L2 MS 安装文件（含手动恢复的 Servers 组件）→ L3 工作区可写 → L4 RunMatScript 链路。接入、排障、每次开跑前先调用。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      const checks = [];
      const add = (layer, name, ok, detail) => checks.push({ layer, name, ok, detail });

      add("L1", "node", true, `v${process.versions.node} / ${os.platform()} ${os.arch()}`);
      const files = [
        ["L2", path.join(MS_INSTALL_ROOT, "etc", "Scripting", "bin", "RunMatScript.bat")],
        ["L2", path.join(MS_INSTALL_ROOT, "etc", "Scripting", "bin", "RunMatScript.Readme")],
        ["L2", path.join(MS_INSTALL_ROOT, "bin", "perl.exe")],
        ["L2", path.join(MS_INSTALL_ROOT, "bin", "MatServer.exe")],
        ["L2", path.join(MS_INSTALL_ROOT, "share", "bin", "runMSserver.bat")],
        ["L2", path.join(MS_INSTALL_ROOT, "etc", "Gateway", "gwcmd.bat")],
        ["L2", path.join(MS_INSTALL_ROOT, "etc", "Gateway", "gwlocation.cfg")],
        ["L2", path.join(MS_SERVER_ROOT, "etc", "Gateway", "gwcmd.bat")],
      ];
      for (const [layer, p] of files) {
        add(layer, path.basename(p), fs.existsSync(p), p);
      }
      try {
        fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
        const probe = path.join(WORKSPACE_ROOT, ".write-probe");
        fs.writeFileSync(probe, String(Date.now()));
        fs.unlinkSync(probe);
        add("L3", "workspace", true, WORKSPACE_ROOT);
      } catch (e) {
        add("L3", "workspace", false, String(e.message));
      }
      add("L4", "RunMatScript 链路", fs.existsSync(RUNMATSCRIPT), RUNMATSCRIPT);

      const allGreen = checks.every((c) => c.ok);
      return {
        verdict: allGreen ? "GREEN" : "RED",
        installRoot: MS_INSTALL_ROOT,
        serverRoot: MS_SERVER_ROOT,
        note: allGreen
          ? "各层绿灯。ZCode↔桥一层需在 ZCode 端确认（Settings → MCP 看到 ms-mcp 且工具可见）。"
          : "存在红灯层，修复后才能继续（勿跳层依赖）。",
        checks,
      };
    },
  },
  {
    name: "ms_make_task_workspace",
    description:
      "创建日期命名的任务目录（如 2026-10-20-task1）并生成 TASK_PROMPT.md 约束提示词。每个新任务先调用；目录已存在时自动追加序号，绝不覆盖。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "任务短名（字母/数字/下划线/连字符），如 alloy-cutoff-scan" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    handler: async ({ name }) => {
      const slug = assertSafeName(name, "任务名");
      const date = new Date().toISOString().slice(0, 10);
      let dir = path.join(WORKSPACE_ROOT, `${date}-${slug}`);
      let n = 2;
      while (fs.existsSync(dir)) dir = path.join(WORKSPACE_ROOT, `${date}-${slug}-${n++}`);
      fs.mkdirSync(dir, { recursive: true });
      const promptPath = path.join(dir, "TASK_PROMPT.md");
      fs.writeFileSync(promptPath, taskPromptText(path.basename(dir)), "utf8");
      return { taskDir: dir, taskName: path.basename(dir), promptFile: promptPath, constraints: taskPromptText(path.basename(dir)) };
    },
  },
  {
    name: "ms_run_script",
    description:
      "同步运行 MaterialsScript：<script> 是脚本名（不含 .pl，脚本放任务目录里）。短脚本用本工具；长时 CASTEP 一律用 ms_submit_job。产物（.pl.out、*MatStudioLog.htm）出现在任务目录。试点优先：批量前先单跑一个。",
    inputSchema: {
      type: "object",
      properties: {
        taskDir: { type: "string", description: "任务目录（工作区内相对或绝对路径）" },
        script: { type: "string", description: "脚本名，不含 .pl 后缀，如 smoke1 跑 smoke1.pl" },
        cores: { type: "integer", minimum: 1, maximum: 256, description: "-np 并行核数" },
        queue: { type: "string", description: "Gateway 队列名（-q），可省" },
        project: { type: "boolean", description: "true=项目模式（-project），false=flat（默认），省略=默认" },
        scriptArgs: { type: "array", items: { type: "string" }, description: "经 -- 传给 Perl 的 @ARGV 参数" },
        timeoutMs: { type: "integer", description: `超时毫秒，默认 ${DEFAULT_SYNC_TIMEOUT_MS}，上限 ${MAX_SYNC_TIMEOUT_MS}；超时杀进程树` },
      },
      required: ["taskDir", "script"],
      additionalProperties: false,
    },
    handler: async (a) => {
      const taskDir = resolveInWorkspace(a.taskDir, { mustExist: true, expectDir: true });
      const script = assertSafeName(a.script, "脚本名");
      const scriptPath = path.join(taskDir, `${script}.pl`);
      if (!fs.existsSync(scriptPath)) throw new Error(`脚本不存在：${scriptPath}（注意：传名不传 .pl，但文件本身要有 .pl）`);
      const timeoutMs = Math.min(Number(a.timeoutMs || DEFAULT_SYNC_TIMEOUT_MS), MAX_SYNC_TIMEOUT_MS);
      return runMatScriptSync({
        taskDir,
        script,
        cores: a.cores,
        queue: a.queue,
        project: a.project,
        scriptArgs: a.scriptArgs,
        timeoutMs,
      });
    },
  },
  {
    name: "ms_submit_job",
    description:
      "异步提交 MaterialsScript 作业（长时计算用），立即返回作业 ID；用 ms_job_status 轮询（建议间隔≥10 分钟），ms_job_list 看全部。反馈回报：任务名、状态、关键结果、产物路径。",
    inputSchema: {
      type: "object",
      properties: {
        taskDir: { type: "string" },
        script: { type: "string", description: "脚本名，不含 .pl" },
        cores: { type: "integer", minimum: 1, maximum: 256 },
        queue: { type: "string" },
        project: { type: "boolean" },
        scriptArgs: { type: "array", items: { type: "string" } },
      },
      required: ["taskDir", "script"],
      additionalProperties: false,
    },
    handler: async (a) => {
      const taskDir = resolveInWorkspace(a.taskDir, { mustExist: true, expectDir: true });
      const script = assertSafeName(a.script, "脚本名");
      const scriptPath = path.join(taskDir, `${script}.pl`);
      if (!fs.existsSync(scriptPath)) throw new Error(`脚本不存在：${scriptPath}`);
      const wrapperPath = buildWrapper({
        taskDir,
        script,
        cores: a.cores,
        queue: a.queue,
        project: a.project,
        scriptArgs: a.scriptArgs,
      });
      const logPath = wrapperPath.replace(/\.bat$/, ".log");
      const fd = fs.openSync(logPath, "a");
      const child = spawn("cmd.exe", ["/d", "/c", wrapperPath], {
        cwd: taskDir,
        stdio: ["ignore", fd, fd],
        detached: true,
        windowsHide: true,
      });
      child.unref();
      fs.closeSync(fd);
      const id = `job_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}_${Math.random().toString(36).slice(2, 6)}`;
      const job = {
        id,
        state: "running",
        script,
        taskDir,
        pid: child.pid,
        startedAt: new Date().toISOString(),
        endedAt: null,
        exitCode: null,
        wrapper: wrapperPath,
        logPath,
      };
      saveJob(job);
      return { jobId: id, state: "running", pid: child.pid, logPath, hint: "ms_job_status 轮询；完成后用 ms_parse_castep 严格核验能量" };
    },
  },
  {
    name: "ms_job_status",
    description: "查询异步作业状态（running/completed/failed）与日志尾部。状态以日志 EXITCODE 标记为准，不信自称。",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"],
      additionalProperties: false,
    },
    handler: async ({ jobId }) => refreshJob(loadJob(jobId)),
  },
  {
    name: "ms_job_list",
    description: "列出全部异步作业及状态（含日志路径，失败项可复制标识符定位）。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      if (!fs.existsSync(JOBS_DIR)) return { jobs: [] };
      const jobs = fs
        .readdirSync(JOBS_DIR)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
          const job = refreshJob(JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), "utf8")));
          return { id: job.id, state: job.state, script: job.script, taskDir: job.taskDir, exitCode: job.exitCode, logPath: job.logPath };
        });
      return { jobs };
    },
  },
  {
    name: "ms_job_cancel",
    description: "取消异步作业：终止其进程树（仅限本桥登记的作业）。破坏性操作，执行前征得用户同意。",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"],
      additionalProperties: false,
    },
    handler: async ({ jobId }) => {
      const job = loadJob(jobId);
      if (job.state !== "running") return { jobId, state: job.state, note: "作业已结束，无需取消" };
      const r = spawnSync("taskkill", ["/pid", String(job.pid), "/T", "/F"], { encoding: "utf8" });
      job.state = "failed";
      job.exitCode = null;
      job.endedAt = new Date().toISOString();
      job.note = `已取消：${(r.stdout || r.stderr || "").trim()}`;
      saveJob(job);
      return { jobId, state: job.state, note: job.note };
    },
  },
  {
    name: "ms_parse_castep",
    description:
      "严格解析 .castep 原始输出（禁止只看 Report->Lines）：核验 SCF 收敛标记、能量标签（E0 优先）、截断/k点/展宽、错误行。传两个路径时检查能量标签一致后再给差值（形成能/吸附能用）。未收敛=invalid，排除出统计。",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 2,
          description: "1 个=单点核验；2 个=对比（host, modified），标签不一致会拒绝给差值",
        },
      },
      required: ["paths"],
      additionalProperties: false,
    },
    handler: async ({ paths }) => {
      const results = paths.map((p) => parseCastepFile(resolveInWorkspace(p, { mustExist: true })));
      const out = { results };
      if (results.length === 2) {
        const [a, b] = results.map((r) => r.primaryEnergy);
        if (!a || !b) {
          out.comparison = { ok: false, reason: "至少一个结构缺最终能量，禁止计算差值" };
        } else if (a.kind !== b.kind) {
          out.comparison = {
            ok: false,
            reason: `能量标签不一致（${a.kind} vs ${b.kind}），禁止跨标签相减；改用一致的 E -> 0 能量`,
          };
        } else {
          out.comparison = {
            ok: true,
            energyKind: a.kind,
            delta_eV: Number((b.eV.value - a.eV.value).toFixed(6)),
            note: "差值前请自行确认两结构均已收敛（verdict=valid）且计算设置一致",
          };
        }
      }
      return out;
    },
  },
  {
    name: "ms_read_artifact",
    description: "读取工作区内产物文件（观测通道）：脚本输出、日志、.pl.out 等。超大文件只回尾部。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "工作区内路径" },
        maxBytes: { type: "integer", description: "最大读取字节数，默认 20000" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: async ({ path: p, maxBytes }) => {
      const abs = resolveInWorkspace(p, { mustExist: true });
      const max = Math.min(Number(maxBytes || 20_000), 500_000);
      const st = fs.statSync(abs);
      const fd = fs.openSync(abs, "r");
      try {
        const size = st.size;
        const start = Math.max(0, size - max);
        const buf = Buffer.alloc(Math.min(max, size));
        fs.readSync(fd, buf, 0, buf.length, start);
        return { path: abs, size, offset: start, truncated: start > 0, text: buf.toString("utf8") };
      } finally {
        fs.closeSync(fd);
      }
    },
  },
  {
    name: "ms_list_artifacts",
    description: "列出任务目录内产物（名称/大小/修改时间），配合反馈回报与失败现场留存。",
    inputSchema: {
      type: "object",
      properties: { taskDir: { type: "string" } },
      required: ["taskDir"],
      additionalProperties: false,
    },
    handler: async ({ taskDir }) => {
      const dir = resolveInWorkspace(taskDir, { mustExist: true, expectDir: true });
      return { taskDir: dir, artifacts: listArtifacts(dir) };
    },
  },
];

// ---------------------------------------------------------------------------
// MCP JSON-RPC over stdio（换行分隔 JSON）
// ---------------------------------------------------------------------------
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    reply(id, {
      protocolVersion: params?.protocolVersion || "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
    return;
  }
  if (method === "notifications/initialized" || method === "initialized") return;
  if (method === "ping") {
    reply(id, {});
    return;
  }
  if (method === "tools/list") {
    reply(id, {
      tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    });
    return;
  }
  if (method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) {
      replyError(id, -32602, `未知工具：${params?.name}`);
      return;
    }
    try {
      const result = await tool.handler(params.arguments || {});
      reply(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
        isError: false,
      });
    } catch (e) {
      reply(id, {
        content: [{ type: "text", text: `错误：${e.message}` }],
        isError: true,
      });
    }
    return;
  }
  if (id !== undefined) replyError(id, -32601, `不支持的方法：${method}`);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg).catch((e) => {
      if (msg?.id !== undefined) replyError(msg.id, -32603, String(e.message || e));
    });
  }
});

process.stderr.write(`[ms-mcp] started, workspace=${WORKSPACE_ROOT}\n`);
