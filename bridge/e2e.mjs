#!/usr/bin/env node
/**
 * ms-mcp 最小真实任务端到端测试（MS ↔ 桥 连通层）
 * 用法：node e2e.mjs   （期望 EXITCODE=0 且产物含 smoke1_result.txt，退出码 0）
 *
 * 流程：ms_make_task_workspace → 写入 trivial smoke1.pl → ms_run_script → 核对产物
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "server.mjs");
const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });

let buf = "";
const pending = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
child.stderr.on("data", (d) => process.stderr.write(d));

let nextId = 1;
function rpc(method, params, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }
    }, timeoutMs);
  });
}

async function tool(name, args, timeoutMs = 30_000) {
  const res = await rpc("tools/call", { name, arguments: args }, timeoutMs);
  const payload = JSON.parse(res.result.content[0].text);
  if (res.result.isError) throw new Error(`${name} 失败：${payload}`);
  return payload;
}

await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0.0.0" } });

// 1) 日期命名任务目录（约束：不覆盖、附 TASK_PROMPT.md）
const ws = await tool("ms_make_task_workspace", { name: "mcp-e2e-smoke" });
console.log("taskDir ⇒", ws.taskDir);

// 2) trivial MaterialsScript：写结果文件 + 建一个分子文档（验证 API 活着）
const script = `#!perl
use strict;
use warnings;
use MaterialsScript qw(:all);

open(my $fh, ">", "smoke1_result.txt") or die "open failed: $!";
print $fh "MS_BRIDGE_SMOKE_OK\\n";
print $fh "perl_version=$^V\\n";
my $doc = Documents->New("SmokeMethane.xsd");
print $fh "doc_created=" . (defined $doc ? "yes" : "no") . "\\n";
if (defined $doc) {
    $doc->CreateAtom("C", Point(X => 1, Y => 1, Z => 1));
    $doc->Save;
    print $fh "doc_saved=yes\\n";
}
close($fh);
print "smoke1 done\\n";
`;
fs.writeFileSync(path.join(ws.taskDir, "smoke1.pl"), script, "utf8");

// 3) 真实调用 RunMatScript（首次可能拉起 MatServer，放宽超时）
const run = await tool("ms_run_script", { taskDir: ws.taskDir, script: "smoke1", timeoutMs: 240_000 }, 300_000);
console.log("exitCode ⇒", run.exitCode, " timedOut ⇒", run.timedOut);
console.log("artifacts ⇒", run.artifacts.map((a) => a.name).join(", "));
console.log("stdout tail ⇒\n" + run.stdoutTail.slice(-1500));

// 4) 核对产物（不信自称，读实际文件）
const resultFile = path.join(ws.taskDir, "smoke1_result.txt");
const ok = run.exitCode === 0 && fs.existsSync(resultFile) && fs.readFileSync(resultFile, "utf8").includes("MS_BRIDGE_SMOKE_OK");
console.log(ok ? "\nE2E PASS" : "\nE2E FAIL");
child.kill();
process.exit(ok ? 0 : 1);
