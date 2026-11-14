# ms-mcp — Materials Studio ↔ ZCode MCP 桥（设计背景）

> 方法论来源：B站《手把手教你,如何把 MS 与 Codex 连起来》+ 本机实测（2026-10-20）。
> 修改本项目前先读本文档——"没有设计上下文也能改，但费时费 token"。

## 1. 这是什么

一个**零依赖 Node.js MCP STDIO 服务**，把 Materials Studio 的脚本接口（MaterialsScript + `RunMatScript.bat`）
包装成 ZCode 可调用的工具，让 agent 以"对话指令 → 工具调用"的方式驱动 MS 建模与 CASTEP 计算。

**接口优先：脚本 > GUI。** 本桥只走 `RunMatScript.bat` 头less CLI（Mode A）。GUI 控制（Mode B）
仅当目标操作无脚本接口时才考虑，且须向用户声明脆弱性——本桥未实现 GUI 路线。

## 2. 分层连通性（每层绿灯才依赖下一层）

| 层 | 检查方式 | 状态（2026-10-20） |
|---|---|---|
| L1 运行时 | `node -v` | ✅ v24.19.0 |
| L2 MS 安装文件 | `ms_status` 逐文件核验（含手动恢复的 Servers 组件） | ✅ 8/8 |
| L3 工作区可写 | `ms_status` 写探针 | ✅ |
| L4 MS ↔ 桥 | `node e2e.mjs` 真实跑 `smoke1.pl` | ✅ EXITCODE=0，`SmokeMethane.xsd` 建模成功 |
| 桥 ↔ ZCode | `node smoke.mjs` 协议自检 | ✅ 10 工具 |
| ZCode ↔ 桥（客户端侧） | 重启 ZCode → Settings → MCP 看 `matstudio` 已连接、工具可见 | ⏳ 待用户重启后确认 |

排障时从上往下查，不要跳层。`smoke.mjs` / `e2e.mjs` 可随时重跑复验。

## 3. 为什么这样设计

- **零依赖单文件**（`server.mjs`）：MCP 是换行分隔的 JSON-RPC 2.0，手写 ~150 行即可，
  免掉 npm install / 供应链面；部署即 `node server.mjs`。
- **wrapper .bat 中转**：MS 安装路径含空格和括号，Git Bash 直接调 .bat 会被 MSYS 参数转换搅坏。
  每次执行生成 `run_<时间戳>.bat`（cd 到任务目录 + call RunMatScript + echo EXITCODE），
  由 `cmd.exe /d /c` 执行——技能文档实测可靠的形式。wrapper 与日志同目录落盘，失败现场可查。
- **同步 + 异步双通道**：短脚本 `ms_run_script`（带超时，超时杀进程树）；长时 CASTEP 用
  `ms_submit_job`（detached，日志重定向到文件）+ `ms_job_status` 轮询——MCP 工具调用不该阻塞几十分钟。
  作业清单落盘 `workspace/jobs/*.json`，桥进程重启不丢观测。
- **安全边界在桥里强制**：所有文件操作经 `resolveInWorkspace` 白名单解析，工作区之外一律拒绝；
  脚本名/队列名/脚本参数走字符白名单，杜绝注入。目标软件侧配"完整权限 + 每次询问"。
- **`.castep` 严格解析独立成工具**：`Report->Lines` 会返回未收敛的中间能量；`ms_parse_castep`
  只认原始文件里的收敛标记 + 最终能量 + 错误行，并强制两个结构能量标签（E0/no_entropy/free）
  一致才给差值。

## 4. 约束放在哪里（双保险）

1. **工具描述**：pilot-first、严格解析、反馈回报、失败现场留存等约束写进各 tool description，
   每次工具调用都会进上下文。
2. **任务提示词**：`ms_make_task_workspace` 在任务目录生成 `TASK_PROMPT.md`（步进闸门、取材三分支、
   失败处理、反馈回报、安全边界、pilot-first、严格解析八条），要求逐任务贴进提示词。

原方法论实测只靠一处约束会漏，所以两处都放。注意：**步进闸门只降低模型偷跑概率，不根除**——
每步后读工作区状态/日志核实，别信自称。

## 5. 工具清单

| 工具 | 用途 |
|---|---|
| `ms_status` | 分层绿灯检查（接入/排障/开跑前） |
| `ms_make_task_workspace` | 建日期命名任务目录 + 约束提示词（已有则加序号，绝不覆盖） |
| `ms_run_script` | 同步跑 MaterialsScript（脚本名**不含** `.pl`） |
| `ms_submit_job` / `ms_job_status` / `ms_job_list` / `ms_job_cancel` | 长时作业的提交/轮询/清单/取消 |
| `ms_parse_castep` | 严格解析 .castep：收敛、能量标签、截断/k点/展宽、错误行、双结构差值 |
| `ms_read_artifact` / `ms_list_artifacts` | 观测通道：读产物、列目录 |

## 6. 典型工作流（收敛测试为例）

1. `ms_status` → 全绿再动。
2. `ms_make_task_workspace` → 把返回的 constraints 贴进任务提示词。
3. 取材三分支拿到结构文件放进任务目录（用户已有文件 > 开放库 > 问凭据 > 手动构建+文献依据）。
4. 预检：超胞原子数/周期性/最短原子间距/电子设置（**金属禁用绝缘体推导**）/k点随超胞缩放。
5. 写 .pl，**单跑 `--pilot-one`**（`ms_run_script` 或 `ms_submit_job`）。
6. `ms_parse_castep` 核验 pilot（SCF 收敛 + 能量标签）→ 过了再批量 `ms_submit_job`。
7. 每个任务回报：任务名、状态、关键数值、产物路径；失败项附日志路径。

## 7. 已知坑（实测）

- 安装在 **`C:\Program Files (x86)\BIOVIA\`**，网上的 `C:\Program Files\BIOVIA\` 路径不对。
- `RunMatScript.bat test` 跑的是 `test.pl`——传脚本名**不带** `.pl`；但文件本身要有 `.pl` 后缀。
- Servers 组件是手动恢复的（原安装缺 "Servers" MSI feature）。`RunMatScript` 链报错先查
  `etc\Scripting\bin\RunMatScript.bat`、`share\bin\runMSserver.bat`、`bin\MatServer.exe`、
  两处 `gwcmd.bat` 是否还在。
- 改 `~/.zcode/cli/config.json` 后要**重启 ZCode/会话**才生效；字段用 `env`（不是 `environment`）、
  `command` 是字符串（不是数组）——否则桌面端工具数为 0 或设置页崩溃。
- 若 Settings → MCP 编辑的服务器列表由桌面端托管、配置文件改动无效（diagnosing-mcp pitfall 11），
  改用 Settings → MCP 界面添加，命令同 §8。
- 首次 `RunMatScript` 可能拉起 MatServer/Gateway，耗时数十秒属正常。

## 8. 注册信息（已写入 `~/.zcode/cli/config.json`）

```json
"matstudio": {
  "type": "stdio",
  "command": "C:\\Program Files\\nodejs\\node.exe",
  "args": ["C:\\Users\\<你的用户名>\\.zcode\\workspace\\default\\ms-mcp\\server.mjs"],
  "cwd": "C:\\Users\\<你的用户名>\\.zcode\\workspace\\default\\ms-mcp",
  "env": {
    "MS_MCP_WORKSPACE": "C:\\Users\\<你的用户名>\\.zcode\\workspace\\default\\ms-mcp\\workspace",
    "MS_INSTALL_ROOT": "C:\\Program Files (x86)\\BIOVIA\\Materials Studio 23.1",
    "MS_SERVER_ROOT": "C:\\Program Files (x86)\\BIOVIA\\Materials Studio 23.1 x64 Server"
  },
  "timeoutMs": 300000
}
```

工具在 ZCode 里显示为 `mcp__matstudio__ms_status` 等。

## 9. 怎么扩展

- **加工具**：`server.mjs` 的 `TOOLS` 数组加一项（name/description/inputSchema/handler）。
  description 里写清约束——那是约束第一保险。
- **加 Gateway 队列/作业后端**：`buildWrapper` 里已支持 `-q <queue>`；如需 `gwcmd` 直提，
  新增独立工具，别改 `ms_run_script` 语义。
- **Mode B（GUI）路线**：仅当操作无脚本接口时，另建 GUI 桥；沿用同一工作区与约束注入，
  并在文档里标注"接管鼠标键盘，脆弱，不推荐无人值守"。
- **未完成的一键批量功能**：若未来做"一键收敛测试"，未走完 pilot 门禁前请标注"不推荐使用"。

## 10. 文件

```
ms-mcp/
├── server.mjs     # MCP 服务本体（零依赖）
├── smoke.mjs      # 协议冒烟：initialize / tools/list / ms_status
├── e2e.mjs        # 最小真实任务：建任务目录 → smoke1.pl → RunMatScript → 核对产物
├── README.md      # 本文档
└── workspace/     # 任务产物根（含 jobs/ 作业清单、日期命名任务目录）
```
