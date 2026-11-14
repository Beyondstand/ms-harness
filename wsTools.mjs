// ms-harness — 宿主原生工作区工具（MCP 桥之外的两个补充工具）
// 桥里没有"写文件"能力，模型无法自己创建 .pl 脚本；这两个工具补齐闭环。
// 安全边界与 server.mjs 一致：一切路径必须落在工作区根之内。

import fs from "node:fs";
import path from "node:path";

export const READONLY_TOOLS = new Set([
  "ms_status",
  "ms_job_status",
  "ms_job_list",
  "ms_list_artifacts",
  "ms_read_artifact",
  "ms_parse_castep",
  "ws_list_dirs",
]);

// 禁止写入可执行/脚本宿主类型（.pl/.py/.md/.txt/.csv 等数据与分析文件不受限）
const BLOCKED_EXT = new Set([".bat", ".cmd", ".com", ".exe", ".scr", ".vbs", ".ps1", ".hta", ".lnk"]);

export const WS_TOOLS = [
  {
    name: "ws_write_file",
    description:
      "在工作区内写一个文本文件（UTF-8）。用于创建 MaterialsScript 脚本（.pl）、分析脚本（.py）、说明文档等。路径相对工作区根；禁止写 .bat/.exe/.ps1 等可执行类型。写好 .pl 后用 ms_run_script 运行（脚本名不带 .pl）。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "工作区内相对路径，如 2026-11-14-task1/smoke1.pl" },
        content: { type: "string", description: "文件全文内容" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "ws_list_dirs",
    description: "列出工作区内某目录的子目录（即历史任务目录）。用于定位已有任务、检查命名，避免重复建目录。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "工作区内相对路径，默认根目录" },
      },
      additionalProperties: false,
    },
  },
];

export function resolveInWorkspace(workspaceRoot, relOrAbs) {
  const raw = relOrAbs == null || relOrAbs === "" ? "." : String(relOrAbs);
  const abs = path.resolve(workspaceRoot, raw);
  const norm = (p) => p.replace(/\//g, "\\").toLowerCase();
  const root = norm(workspaceRoot);
  const rootWithSep = root.endsWith("\\") ? root : root + "\\";
  if (norm(abs) !== root && !norm(abs).startsWith(rootWithSep)) {
    throw new Error(`安全边界拒绝：${abs} 不在工作区 ${workspaceRoot} 之内`);
  }
  return abs;
}

export async function wsToolCall(workspaceRoot, name, args = {}) {
  if (name === "ws_write_file") {
    const abs = resolveInWorkspace(workspaceRoot, args.path);
    const ext = path.extname(abs).toLowerCase();
    if (BLOCKED_EXT.has(ext)) {
      throw new Error(`禁止写入可执行类型 ${ext}（.pl/.py/.md/.txt 等不受限）`);
    }
    const content = String(args.content ?? "");
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
    const out = { path: abs, bytes: Buffer.byteLength(content, "utf8") };
    return { isError: false, text: JSON.stringify(out, null, 2), structured: out };
  }
  if (name === "ws_list_dirs") {
    const abs = resolveInWorkspace(workspaceRoot, args.path || ".");
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      throw new Error(`目录不存在：${abs}`);
    }
    const dirs = fs
      .readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    const out = { path: abs, dirs };
    return { isError: false, text: JSON.stringify(out, null, 2), structured: out };
  }
  throw new Error(`未知宿主工具：${name}`);
}
