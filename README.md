# MS Harness

Materials Studio 的 AI Harness 启动器（参照 GODOT BOX 思路）：Electron 桌面应用内置 agent 循环，接入你自己的模型 API（Anthropic 兼容 / OpenAI 兼容双协议），驱动现有 ms-mcp 桥完成建模计算任务。

## 架构

```
渲染进程（对话 UI）
   │  IPC（preload 暴露 invoke/onEvent）
主进程（agent 循环 + 权限门 + 作业看护 + 会话存储）
   │  spawn node server.mjs（stdio JSON-RPC，协议零改动）
ms-mcp 桥（现有 10 个 ms_* 工具，与 ZCode 共用同一工作区）
   │  wrapper .bat → cmd.exe
RunMatScript.bat → Materials Studio 23.1
```

> 仓库自带 `bridge/`（ms-mcp 桥的零依赖副本，含 e2e/smoke 测试）。若本机另有 ms-mcp 目录，Harness 优先使用它（共用任务工作区）；克隆到新机器时自动使用 `bridge/`，工作区落在 `bridge/workspace/`。安装路径等环境信息可在 `config.json` 的 `ms` 段覆盖。

宿主在 10 个 ms_* 工具之外补了两个原生工具（桥里没有写文件能力，模型无法自己创建 .pl）：

- `ws_write_file`：工作区内写文本文件（.pl/.py/.md/.txt 等；.bat/.exe/.ps1 等可执行类型禁止）
- `ws_list_dirs`：列工作区子目录（定位历史任务）

## 启动

双击 `启动Harness.bat`，或：

```bash
npm install        # 首次；国内网络若 electron 下载超时：set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm start
```

首次使用：左下角「设置」→ 选协议、填 API Base / API Key / 模型名 → 「测试连接」（含工具往返探测，专抓不支持 tool use 的中转）→ 保存。

## 权限三档（输入区左下切换）

| 档位 | 只读工具 | 执行类工具（建目录/跑脚本/提交/取消作业/写文件） |
|---|---|---|
| 完全自动（默认） | 放行 | 直接执行 |
| 需确认 | 放行 | 弹卡片等点击，60 秒超时视为拒绝 |
| 只读 | 放行 | 直接拒绝 |

只读工具：ms_status / ms_job_status / ms_job_list / ms_list_artifacts / ms_read_artifact / ms_parse_castep / ws_list_dirs。

## 作业看护

开启时每 60 秒轮询 ms_job_list；作业 running→completed/failed 时：UI 弹横幅 + 若会话空闲则自动唤醒 AI 去解析产物并汇报（看护轮次只做核验简报，不启动新计算）。关停只需点顶栏「看护」chip。

## 文件

- `config.json`：模型接入 + 权限档 + 看护开关 + MS 路径（明文存 Key，仅本机）
- `sessions/*.json`：会话转录（侧栏可恢复/删除）
- `test/smoke.mjs`：无 GUI 冒烟（协议映射 / 宿主工具安全边界 / MCP 连真桥 / 假作业看护），`npm run smoke`

## 与 ZCode 的关系

两者共用同一个 ms-mcp 桥与工作区（`ms-mcp\workspace`），任务目录互通。Harness 的价值：脱离 ZCode 独立运行的启动器形态、领域化权限门、作业看护自动收尾。

## 排障

- 状态灯红灯：按 L1→L4 逐层修，勿跳层（详见 ms-mcp README）
- 桥退出/重启：顶栏「桥」chip 显示状态，点击可手动重启
- 中转不支持 tool use：测试连接会提示；换支持 function calling 的接口
