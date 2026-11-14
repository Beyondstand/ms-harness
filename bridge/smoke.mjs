#!/usr/bin/env node
/**
 * ms-mcp 冒烟测试：拉起 server.mjs，走 initialize → tools/list → ms_status
 * 用法：node smoke.mjs   （期望输出三层结果全 OK，退出码 0）
 */
import { spawn } from "node:child_process";
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
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }
    }, 30_000);
  });
}

const init = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "smoke", version: "0.0.0" },
});
console.log("initialize ⇒", init.result?.serverInfo);

const tools = await rpc("tools/list", {});
const names = tools.result.tools.map((t) => t.name);
console.log(`tools/list ⇒ ${names.length} tools:`, names.join(", "));

const status = await rpc("tools/call", { name: "ms_status", arguments: {} });
const body = JSON.parse(status.result.content[0].text);
console.log("ms_status ⇒", body.verdict);
for (const c of body.checks) console.log(`  [${c.layer}] ${c.name}: ${c.ok ? "OK" : "FAIL"} — ${c.detail}`);

const green = body.verdict === "GREEN" && names.includes("ms_parse_castep");
console.log(green ? "\nSMOKE PASS" : "\nSMOKE FAIL");
child.kill();
process.exit(green ? 0 : 1);
