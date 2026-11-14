// ms-harness 无 GUI 冒烟：协议映射 / 宿主工具安全 / MCP 客户端连真桥 / 假作业看护
// 运行：node test/smoke.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { McpClient } from "../mcpClient.mjs";
import { JobKeeper } from "../jobkeeper.mjs";
import { wsToolCall, resolveInWorkspace } from "../wsTools.mjs";
import { buildAnthropicMessages, buildOpenAIMessages, apiUrl } from "../agent.mjs";

// 与 main.mjs 同一自适应逻辑：本机既有 ms-mcp 优先，否则仓库自带 bridge/
const LOCAL_MS_MCP = path.join(os.homedir(), ".zcode", "workspace", "default", "ms-mcp");
const REPO_ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")));
const MS = {
  nodePath: "C:\\Program Files\\nodejs\\node.exe",
  serverPath: fs.existsSync(path.join(LOCAL_MS_MCP, "server.mjs"))
    ? path.join(LOCAL_MS_MCP, "server.mjs")
    : path.join(REPO_ROOT, "bridge", "server.mjs"),
  workspace: fs.existsSync(LOCAL_MS_MCP)
    ? path.join(LOCAL_MS_MCP, "workspace")
    : path.join(REPO_ROOT, "bridge", "workspace"),
  installRoot: "C:\\Program Files (x86)\\BIOVIA\\Materials Studio 23.1",
  serverRoot: "C:\\Program Files (x86)\\BIOVIA\\Materials Studio 23.1 x64 Server",
};

let pass = 0;
function ok(name) {
  pass++;
  console.log(`  ✓ ${name}`);
}

// ---------- 1. 协议映射 ----------
{
  const msgs = [
    { role: "user", text: "你好" },
    { role: "assistant", text: "好的", toolCalls: [{ id: "t1", name: "ms_status", args: {} }] },
    { role: "tool", toolCallId: "t1", toolName: "ms_status", text: "{verdict}", isError: false },
    { role: "assistant", text: "", toolCalls: null },
  ];
  const a = buildAnthropicMessages(msgs);
  assert.equal(a.length, 4); // user / assistant(tool_use) / user(tool_result) / assistant(尾部空回复占位)
  assert.equal(a[2].content[0].type, "tool_result");
  assert.equal(a[2].content[0].tool_use_id, "t1");
  assert.equal(a[3].role, "assistant");
  ok("anthropic 映射：tool_result 紧跟 tool_use");

  const o = buildOpenAIMessages(msgs, "SYS");
  assert.equal(o[0].role, "system");
  assert.equal(o[2].role, "assistant");
  assert.equal(o[2].tool_calls[0].id, "t1");
  assert.equal(o[3].role, "tool");
  assert.equal(o[3].tool_call_id, "t1");
  assert.deepEqual(JSON.parse(o[2].tool_calls[0].function.arguments), {});
  ok("openai 映射：system 前置 + tool_call_id 对齐");

  assert.equal(apiUrl("http://127.0.0.1:3425", "anthropic"), "http://127.0.0.1:3425/v1/messages");
  assert.equal(apiUrl("https://x.cn/api/anthropic/", "anthropic"), "https://x.cn/api/anthropic/v1/messages");
  assert.equal(apiUrl("https://x.cn/v1", "openai"), "https://x.cn/v1/chat/completions");
  ok("API URL 拼接");
}

// ---------- 2. 宿主工具：安全边界 ----------
{
  const scratch = path.join(MS.workspace, "harness-smoke-scratch");
  fs.rmSync(scratch, { recursive: true, force: true });
  const r1 = await wsToolCall(MS.workspace, "ws_write_file", { path: "harness-smoke-scratch/hello.txt", content: "hi" });
  assert.equal(r1.isError, false);
  assert.ok(fs.readFileSync(path.join(scratch, "hello.txt"), "utf8") === "hi");
  ok("ws_write_file 写入 + 自动建目录");

  await assert.rejects(
    () => wsToolCall(MS.workspace, "ws_write_file", { path: "../../evil.txt", content: "x" }),
    /安全边界/
  );
  ok("越界路径被拒绝");

  await assert.rejects(
    () => wsToolCall(MS.workspace, "ws_write_file", { path: "harness-smoke-scratch/x.bat", content: "@echo off" }),
    /禁止写入/
  );
  ok("可执行类型被拒绝");

  const r2 = await wsToolCall(MS.workspace, "ws_list_dirs", {});
  assert.ok(r2.structured.dirs.includes("harness-smoke-scratch"));
  ok("ws_list_dirs 列目录");
  fs.rmSync(scratch, { recursive: true, force: true });

  // ws_fetch_file 安全检查（不联网，只测拦截）
  await assert.rejects(
    () => wsToolCall(MS.workspace, "ws_fetch_file", { url: "file:///C:/Windows/notepad.exe", path: "harness-smoke-scratch/x.txt" }),
    /仅允许 http\/https/
  );
  await assert.rejects(
    () => wsToolCall(MS.workspace, "ws_fetch_file", { url: "不是URL", path: "harness-smoke-scratch/x.txt" }),
    /URL 无法解析/
  );
  await assert.rejects(
    () => wsToolCall(MS.workspace, "ws_fetch_file", { url: "https://example.com/a.exe", path: "harness-smoke-scratch/a.exe" }),
    /禁止保存可执行/
  );
  ok("ws_fetch_file 拦截 file:// 与可执行类型");
}

// ---------- 3. MCP 客户端连真桥 ----------
{
  const mcp = new McpClient({
    nodePath: MS.nodePath,
    serverPath: MS.serverPath,
    cwd: path.dirname(MS.serverPath),
    env: { MS_INSTALL_ROOT: MS.installRoot, MS_SERVER_ROOT: MS.serverRoot, MS_MCP_WORKSPACE: MS.workspace },
  });
  const tools = await mcp.start();
  assert.ok(tools.length >= 10, `工具数 ${tools.length}`);
  assert.ok(tools.every((t) => t.name.startsWith("ms_")));
  ok(`MCP 桥就绪，${tools.length} 个工具`);

  const st = await mcp.callTool("ms_status", {}, 30000);
  assert.equal(st.isError, false);
  assert.ok(["GREEN", "RED"].includes(st.structured.verdict));
  console.log(`  ↳ ms_status verdict = ${st.structured.verdict}`);
  ok("ms_status 返回结构化 verdict");

  // 假作业台账：写入 running 清单 + EXITCODE=0 日志 → 桥应判 completed
  const jobsDir = path.join(MS.workspace, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const fakeLog = path.join(jobsDir, "job_smoke.log");
  fs.writeFileSync(fakeLog, "EXITCODE=0\n", "utf8");
  fs.writeFileSync(
    path.join(jobsDir, "job_smoke.json"),
    JSON.stringify({
      id: "job_smoke", state: "running", script: "smoke1", taskDir: MS.workspace,
      pid: 999999, startedAt: new Date().toISOString(), endedAt: null, exitCode: null,
      wrapper: "", logPath: fakeLog,
    }, null, 2)
  );
  const jl = await mcp.callTool("ms_job_list", {});
  const fj = jl.structured.jobs.find((j) => j.id === "job_smoke");
  assert.equal(fj?.state, "completed");
  ok("ms_job_list 按日志 EXITCODE 判定 completed");

  // ---------- 4. 作业看护：状态迁移触发事件（纯 stub，不依赖桥的落盘时序） ----------
  const events = [];
  const runningList = {
    isError: false,
    structured: { jobs: [{ id: "job_smoke", state: "running", script: "smoke1", taskDir: MS.workspace, exitCode: null, logPath: "" }] },
  };
  const doneList = {
    isError: false,
    structured: { jobs: [{ id: "job_smoke", state: "completed", script: "smoke1", taskDir: MS.workspace, exitCode: 0, logPath: "" }] },
  };
  const keeper = new JobKeeper({
    poll: async () => runningList,
    onEvent: (e) => events.push(e),
    intervalMs: 60000,
  });
  await keeper.pollOnce(); // 建基线（running）
  keeper.poll = async () => doneList;
  await keeper.pollOnce(); // running→completed
  assert.equal(events.length, 1);
  assert.equal(events[0].jobId, "job_smoke");
  assert.equal(events[0].state, "completed");
  ok("看护捕获 running→completed 迁移");
  await keeper.pollOnce(); // 终态重复轮询不重复报
  assert.equal(events.length, 1);
  ok("终态不重复报事件");

  // 清理假作业
  fs.rmSync(path.join(jobsDir, "job_smoke.json"), { force: true });
  fs.rmSync(fakeLog, { force: true });

  await mcp.stop();
}

console.log(`\n冒烟通过：${pass} 项`);
