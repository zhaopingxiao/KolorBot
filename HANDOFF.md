# KolorBot 项目交接

> 项目路径：`D:\code\kolorbot`
>
> 最后更新：2026-11-21
>
> 当前版本：**0.4.0**
>
> 代码仓库：https://github.com/zhaopingxiao/KolorBot.git（origin/main）
>
> 代码基线：当前 `origin/main`（具体提交见 `git log`）
>
> 当前状态：`pnpm build` / `pnpm test` 全部通过（132 个测试），单对话 + 话题驱动；Windows 单文件 release 已更新。

## 1. 这个项目是什么

KolorBot 是一个本地运行的 Node.js 智能体运行时，配一个轻量 Web 聊天界面。

- 只使用用户在「模型」页添加的语言模型，可自动发现模型；没有内置默认模型。
- 整个应用只有一条对话，按话题划分为 `topics` / `segments` / `messages`。
- 模型消息先做话题判定；切换话题会新开 segment，模型上下文只取当前 segment。
- 技能遵循 Claude `SKILL.md`，支持三个技能区；技能可以声明 MCP server。
- 记忆由 `AI.md` 和每个话题的 `workspace/topic/<slug>/*.md` 时间戳记忆文件组成。
- Web UI 白色极简风，支持桌面和移动端抽屉。
- 有 Windows 单文件发布版，内置 Node/runtime，空目录可运行。

不是多用户服务器：没有鉴权，默认只监听本机；`bash` 工具不沙箱，只适合本机可信环境。

## 2. 目录与包

```text
D:\code\kolorbot\
├── packages/
│   ├── kolorbot-agent-loop/     # 主循环 + frame/ 本地工具
│   ├── kolorbot-conversation/   # topics / segments / messages
│   ├── kolorbot-skills/         # SKILL.md / kolor.json / MCP 解析
│   ├── kolorbot-memory/         # AI.md、时间戳话题记忆、注入块
│   └── kolorbot-web/            # Web 服务、SSE、AgentPool、话题判定、前端、CLI
├── scripts/restart.ps1          # 启停脚本（restart.cmd 调用）
├── restart.cmd
├── inner/skills/browseruse/     # 内置浏览器 MCP 技能
├── docs/                        # UI 截图
├── README.md
├── HANDOFF.md
├── pnpm-workspace.yaml / pnpm-lock.yaml
├── tsconfig.base.json / tsconfig.dev.json
├── LICENSE                      # MIT
```

Electron 桌面端原在仓库外 `D:\code\kolorbot_windows_desktop`，已按要求删除，暂停使用。

- 数据目录默认 `~/.kolorbot`（`KOLOR_HOME` 可覆盖）；环境变量仍是 `KOLOR_*`，技能 MCP 配置仍叫 `kolor.json`，类名仍是 `KolorAgent` / `KolorFrame`。包名已是 `kolorbot-*`，不要随意改回。

## 3. 当前架构

### 3.1 Agent loop（`kolorbot-agent-loop`）

- OpenAI 兼容流式客户端，手写 SSE 解析，支持 text / reasoning / tool-call 增量。
- 工具调度：有界并行池、独占屏障、按模型顺序提交结果、取消时补齐未执行调用。
- 上下文校验：每个 assistant `toolCalls` 必须有对应 tool 结果。
- MCP 客户端：stdio / Streamable HTTP / SSE，工具名 `mcp__<server>__<tool>`。
- 事件流、取消、超时、`concludeTurn`、上下文导入导出。
- 本地工具：文件读写、bash、后台 bash、技能读取、`read_image`。`read_image` 会把图片附到下一次模型请求；不支持视觉的模型自动降级。
- 后台 bash：`bash({ wait: true })` 立即返回任务名（首个命令参数 + `_2`/`_3`），后台输出由 `read_bash_output` 读取，`stop_bash` 停止；最多 8 个同时运行，重启不保留。完成时通过 Web 会话通知 AI。
- `KOLOR_SYSTEM_PROMPT` 描述：话题组织、`list_topics` / `read_today_memory` / `read_topic_memory` / `read_diary` 可读、`write_topic_note` 等写入只在整理任务启用；普通聊天不要写话题记忆。

### 3.2 单对话与话题（`kolorbot-conversation`）

- SQLite `node:sqlite`，默认 `~/.kolorbot/conversation.db`（`KOLOR_CONVERSATION_DB` 可覆盖）。
- 表：`topics` / `segments` / `messages`。
- 整个应用只有一条对话；切换话题开新 segment，UI 在 segment 之间显示话题分割线。
- `messages.data_json` 保存完整 `AgentMessage`（含 toolCalls / tool 结果），UI 与模型共用同一份数据。
- `SingleConversation` 适配层把单对话包装成旧 session 形状，id 固定 `main`，供 `RunBroker` / `AgentPool` 兼容使用。

### 3.3 话题判定与上下文

- 每条普通用户消息调用一次 `classifyTopic()`：`continue` / `switch` / `new`；失败一律 continue。
- 新话题创建/复用 topic，开始新 segment，`pool.disposeSession('main')`。
- 模型上下文只包含当前 segment；切回旧话题也开新 segment，不恢复该话题旧消息。
- 新 segment 第一条注入：
  - `<system-memory>`：AI.md + `workspace/topic/<slug>/main.md` 关键记忆 + 最新一条 `<YYYY-MM-DD-HH-mm>.md` 记录；
  - `<system-last-message>`：上一 segment 最后 10 条 user/assistant 文本。
- 同一 segment 内只有 AI.md 变化才重新注入记忆。
- 重置 `/api/sessions/main/reset` 清空消息/segment，保留话题与记忆文件。

### 3.4 记忆（`kolorbot-memory`）

#### AI.md 固定格式

`<workspace>/AI.md`，默认 `~/.kolorbot/workspace/AI.md`。固定头部：

```markdown
# 名字
## head-image
> 头像路径
```

- 第一行 `#` 后是名字。
- `## head-image` 下一行 `>` 后是头像路径。
- 相对路径按 workspace 解析，也支持绝对路径 / `file://`；远程 `http(s)` 头像由 UI 直接加载。
- 下面继续写性格、自我认知等；整个文件上限 1 MiB，超过会截断注入。
- `parsePersona()` 解析出 `name` / `headImage`；`MemoryStore.self()` 返回这两个字段。
- 当前主实例没有 AI.md，所以 agent 卡片显示回退名 `KolorBot`、无头像。
- `/self-md-update`、`/self-md-tell ...` 的提示词已要求按这个固定头部写入。

#### 话题记忆文件

- 关键记忆：`workspace/topic/<slug>/main.md`。
  - 只放可复用事实、状态、决定、待办；`<system-memory>` 使用它。
  - `<system-memory>` 还带当前话题最新一条时间戳记录（按文件名排序最后一条）。
  - `write_topic` 写这个文件；旧的 `workspace/topic/<slug>.md` 仅作读取兜底。
- 每日记录：`workspace/topic/<slug>/<YYYY-MM-DD-HH-mm>.md`。
  - 每个 segment 一条，文件名时间是该 segment 最后一条消息的完成时间，不是整理时间。
  - 只写“做了什么、结果、进展”，不写关键事实，不写 `# 日期` / `## 话题` / `### HH:mm`。
  - 同一天多个片段在话题页按 `### 片段 N · HH:mm` + `---` 分隔显示。
  - 旧的 `workspace/daily` 日记格式不再由整理任务写入。
- `read_today_memory({ date? })`：扫描所有 `workspace/topic/<slug>/` 下当天的时间戳文件，按 `HH-mm` 排序，每条前输出 `--------<slug>-HH-mm--------`。
- `read_topic_memory({ slug })`：返回指定话题的 `main.md` + 最新记录，格式与 `<system-memory>` 的 Topic / Latest record 一致。

#### 整理任务

- **切换话题自动整理（2026-11-18）**：上一 segment 关闭后，将其对话记录交给独立的整理 Agent（`diary-<uuid>`，独立 `AgentPool`，`context = []`），不占用主对话、不复用主 Agent 上下文。
- **跨天强制分段**：同一话题跨本地日期时，第二天第一条普通消息会强制新开 segment；上一天 segment 被关闭并进入整理队列。
- 整理工具是 `write_topic_note({ content, main })`：`content` 写每日记录，`main` 更新 `main.md`；服务端绑定当前话题和最后消息时间。
- 整理 Agent 会先读 `read_topic_memory`，再把 `main.md` 一起更新；不再只写时间戳文件。
- 任务完成后上下文丢弃，只保留每日记录和 `main.md` 写入，并标记 `diary_at`。
- 10 分钟静默仍作为兜底；主对话每轮结束后还会扫描除当前 segment 外的 pending segment，补做切换时漏掉的整理。
- 历史页补写、UI `/update-daily-memory` 也走独立整理 Agent（`/api/diary/organize`）。

### 3.5 技能与 MCP（`kolorbot-skills`）

三个技能区：

| 区 | 目录 | 说明 |
| --- | --- | --- |
| 兼容技能 | `~/.agents/skills`（`KOLOR_SKILLS_DIR`） | Claude 标准兼容区 |
| 专属技能 | `<home>/skills`（`KOLOR_USER_SKILLS_DIR`） | 默认 `~/.kolorbot/skills` |
| 内置技能 | `<repo>/inner/skills`（`KOLOR_BUILTIN_SKILLS_DIR`） | `browseruse` 在这里 |

- 按 `<区>/<id>/SKILL.md` 读取；同名技能按 **专属 → 兼容 → 内置** 取第一个。
- 2026-11-17：专属技能区从 `<home>/workspace/skills` 移到 `<home>/skills`；现有 `deepseek-search` 已迁移。
- `kolor.json` 可声明 `mcpServers`（也接受 `mcp` 别名），支持 `${VAR}` 环境变量展开。
- Web 的「技能」页按三个区分组展示，有 MCP 的技能带 MCP 标识，详情显示 server 名称/transport。
- 原来的独立 MCP 页面已删除；MCP 只读，通过技能目录配置。

### 3.6 提供商与模型

- Web「模型」页：选择协议（厂商集成 / OpenAI v1 / 代码接入）。
- 当前只支持大语言模型。
- 厂商集成来自 `model-catalog.ts` 的预置表（Anthropic、MiniMax、DeepSeek、Moonshot、智谱、通义、xAI、Gemini、火山、混元等）；兼容 OpenAI v1 的厂商只预填 endpoint，不写专用适配。
- 在厂商集成中选择 Anthropic 后走 `llm/anthropic.ts` 的 Messages API：system 顶层化、tool_use/tool_result 转换、SSE 增量与 usage 解析。
- 代码接入保存 `code` 字段，接口约定见 README；运行时尚未执行。
- 存储 `~/.kolorbot/providers.json`，key 只存在本地文件，API 只返回 `hasKey` + 末四位。
- 选择模型是全局的；切换后下一轮生效，运行中的 turn 不受影响。
- 没有内置默认模型；只有显式设置 `KOLOR_API_URL` + `KOLOR_API_MODEL` + key 才出现环境变量回退项。

### 3.7 运行中的 turn（`RunBroker`）

- turn 在服务端 `RunBroker` 里跑，`/api/chat` 只是接线 + SSE 镜像。
- 断开页面/刷新只移除监听，回来通过 `/api/sessions/main/stream?from=N` 回放。
- 同一 `main` 同时只允许一个 turn；重复 POST 返回 409，客户端自动 attach 正在运行的轮次。
- 取消走 `/api/chat/cancel`，服务端发 `run/cancelled` 后正常结束。
- 回放缓冲上限 4MB，超出后 `truncated: true`。
- 重置/删除会丢弃运行中的 turn，不写回旧上下文。

### 3.7.1 外部消息 + 回调（2026-11-17）

`POST /api/message` 给外部系统用：

```json
{
  "message": "需要 AI 处理的消息",
  "callbackUrl": "http://127.0.0.1:9000/hook"
}
```

- 成功启动返回 202，AI 忙（Web 轮次/整理任务/另一个外部消息）返回 409，不排队。
- 内部调用本机 `/api/chat`，所以话题判定、记忆注入、历史落库都照常。
- `callbackTurnBusy` 在发响应前同步置位，避免两个 `/api/message` 在内部 run 注册前同时通过。
- 回调事件：
  - `context`：每个 assistant 文本段，字段 `context`/`text`/`sequence`/`at`/`last: false`；
  - `done`：`last: true`/`status`/`text`/`contexts`/`at`（取消时 `status: "cancelled"`）；
  - `error` / `busy`：终态回调，同样带 `last: true`。
- 回调按顺序 POST，10 秒超时；失败只记日志，不中断 AI。
- 只接受 `http:`/`https:` callback；没有 SSRF 防护，只适合可信环境。

### 3.8 Web UI（当前）

`packages/kolorbot-web/public/` 是纯静态 HTML/CSS/JS。

- 侧栏：
  - 顶部 KolorBot logo；
  - 主导航是 **对话 / 技能 / 模型**；
  - 底部 **agent 卡片**：左侧圆形头像（来自 AI.md `head-image`，缺失显示名字首字），右侧名字，最右 `⋯`；
  - `⋯` 菜单只有 **设定**；模型在「技能」下面单独入口。
- Agent 识别：
  - 名字来自 AI.md 第一行 `# 名字`；
  - 头像通过 `/api/agent` + `/api/agent/avatar` 提供；
  - 没有 AI.md / 没有名字时回退 `KolorBot`。
- 顶部标题：
  - 对话页标题左侧显示日历 SVG 图标，点击进入历史页；
  - 历史页同样显示图标并加深，点击回到对话；
  - 技能 / 模型 / 设定页不显示这个图标。
- 对话页：
  - 标题显示当前话题显示名；显示名也用于聊天/历史分割线；
  - 只渲染本地日期为今天的消息，历史记录看「历史」页；
  - AI 自然结束、非手动停止，且最后一条 assistant 内容为空或停在 tool 结果后没有最终 assistant 时，自动以用户消息发送 `Next.`；自动请求本身不再次触发；
  - 后台任务完成时，空闲立即发送 `<任务名> has done.`，AI 运行中则排队到本轮结束；完成通知优先于同一边界的 `Next.`；
  - 右侧不再显示「N 条消息 · 时间」或话题 pill，标题下只显示相对时间；
  - 空对话显示大标题「今天有什么可以帮到你？」；
  - 输入框大圆角、白色卡片、阴影，发送按钮为蓝色圆形 `↑`；
  - 输入 `/` 弹出指令补全：`/self-md-update`、`/self-md-tell`、`/update-daily-memory`，点击自动填充；`/self-md-tell` 会补空格；
  - 2 秒轮询只在会话签名变化时重建消息列表，重建时保留当前滚动位置；外部 `/api/message` 启动的轮次也会在 2 秒内被 Web 接上；
  - 只有离底部一行以内才自动跟随新内容。
- 历史页（原话题页）：
  - 标题和图标改为「历史」+ `icons/history.svg`（日历）；
  - 不再显示话题列表，直接显示所有话题合并后的全部月份日历；
  - 点日期进入当天全部话题的聊天记录 + 当天记忆；
  - 聊天片段分隔线显示圆角话题名徽标和加深的时间徽标（如 `打招呼` + `08:27`）；
  - 日历日期来自对话 segment；日期切换时重置滚动位置。
- 设定页：
  - 内部页面 key / hash 仍是 `memory`（`#/memory`），但 UI 全部显示「设定」；
  - 只显示 AI.md 预览、路径、大小、名字/头像路径、固定格式提示；
  - 不再有旧日记开关、日记预览、日记刷新。
- 模型页：提供商列表、添加、刷新模型、删除、当前模型选择。
- 技能页：三区分组、MCP 标识、技能详情。
- 移动端 ≤900px：左侧抽屉、遮罩、Esc 关闭、输入框 16px 字号。

### 3.9 Windows release

- 单文件：`D:\code\kolorbot_windows_release\KolorBotMain.exe`。
- 内置 packages + Node + npm + public + inner；首次运行解压 `runtime/`、创建 `logs/`。
- 打包脚本：`D:\code\kolorbot_release_build\build.mjs`。
- 打包前需要把源码 `packages/kolorbot-web/public` 和 `inner/` 复制到 `staging/`；当前构建脚本会读取 `staging/public`。
- 当前 release：
  - 版本 0.4.0
  - 大小 136,376,832 bytes
  - SHA256 `8B2F5780D9D2818613E2B6AD018CAFDF1A190318449118DD703140D784292BE3`
- 运行中的 `KolorBotMain.exe` 会锁住输出文件；打包前先关闭旧进程，或先改名旧 exe 再构建。
- 未显式指定端口时，CLI、release 和 `restart.cmd` 都按 **3399 → 3420 → 随机** 选择；显式 `--port` / `KOLOR_WEB_PORT` 不回退。

### 3.10 Electron 桌面端（已删除，暂停使用）

- 原路径：`D:\code\kolorbot_windows_desktop`；2026-11-22 已按要求删除，需要时再重建。
- 原行为：启动 release、3399 → 3420 → 随机、关闭到托盘。当前不再维护。

### 3.11 Skill code 网页插件

- 技能目录下 `code/index.js` 是浏览器 ES module 入口；可以相对 import `code/` 内其他文件。
- Web 加载页面时请求 `GET /api/skill-code`，动态 import 每个入口并调用 `export default function activate(kb)`。
- 服务端 `GET /skill-code/<skill-id>/<file>` 只读 skill 的 `code/` 目录，做了路径穿越检查。
- 浏览器 API：`window.KolorBot`，含 `getConversation`、`getMessages`、`sendMessage`、`subscribe`、`on`、`openPage`、`navigate`、`addStyle`、`addScript`、`setGlobal`。
- `sendMessage` 直接走 `/api/chat` SSE，插件页面可实时显示 text/tool/turn 事件。
- 示例插件已删除，不再内置；安装方式仍是 skill 目录下放 `code/index.js`。
- 技能代码属于本地可信代码；不要安装不可信 skill。

## 4. 数据文件

```text
~/.kolorbot/
├── conversation.db       # topics / segments / messages
├── memory.json           # 自动整理开关
├── providers.json        # 模型提供商 / active 模型 / key
├── workspace/
│   ├── AI.md             # 固定头部 + 性格/自我认知
│   └── topic/<slug>/main.md + <YYYY-MM-DD-HH-mm>.md
└── logs/                 # 源码运行时日志
```

- `KOLOR_FRAME_ROOT` 可改 workspace。
- AI.md、daily/ 旧日记、topic/ 新记忆文件都是普通 Markdown，可直接编辑/备份。
- 2026-11-17 起默认数据目录从 `~/.kolor` 改为 `~/.kolorbot`；现有数据已迁移，旧目录备份在 `C:\Users\jiayi\.kolor.backup-20261117-190135`。应用不再读取旧目录。
- 用户曾手动清空数据：数据库缺数据、话题 404、记忆为空都不是 bug。

## 5. HTTP API 概览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/config` | 配置、当前模型、MCP、状态 |
| GET/POST | `/api/providers` | 提供商列表 / 添加并识别模型 |
| DELETE | `/api/providers/:id` | 删除提供商 |
| POST | `/api/providers/:id/models` | 重新识别模型 |
| PUT | `/api/model` | 切换当前模型 |
| GET | `/api/conversation` | 当前单对话的 topics / segments / messages |
| GET/PUT | `/api/memory` | AI.md + 旧日记兼容数据；PUT 切换自动整理（UI 已不用） |
| GET | `/api/agent` | Agent 名字、头像路径、`avatarUrl` |
| GET | `/api/agent/avatar` | 读取 AI.md 指向的本地头像文件 |
| GET | `/api/calendar` | 所有话题合并后的对话日历 |
| GET | `/api/days/:date` | 某天所有话题的聊天片段和记忆 |
| GET | `/api/topics` | 话题列表 |
| GET | `/api/topics/:slug` | 话题记忆 + 日历 |
| GET | `/api/topics/:slug/days/:date` | 某天该话题的聊天/记忆 |
| POST | `/api/topics/:slug/days/:date/diary` | 补写某天记忆 |
| POST | `/api/diary/organize` | 所有未整理片段交给独立记忆 Agent（202） |
| GET | `/api/sessions/:id/run` | 运行中/刚结束 turn 状态 + 缓冲 |
| GET | `/api/sessions/:id/stream?from=N` | SSE 回放 + 实时事件 |
| POST | `/api/sessions/:id/reset` | 重置上下文 |
| GET | `/api/sessions/:id/export` | 导出 JSON |
| POST | `/api/sessions/import` | 导入 |
| GET | `/api/skills` | 三区技能列表 + 签名 + MCP |
| GET | `/api/skills/:id` | 技能详情 |
| GET | `/api/mcp` | skill 声明的 MCP |
| POST | `/api/mcp/:name/restart` | 重启 MCP server |
| POST | `/api/chat` | SSE 聊天；turn 在 broker 里跑 |
| POST | `/api/chat/cancel` | 取消当前轮次 |
| POST | `/api/message` | 外部消息 + callbackUrl；202/409；AI context 回调 |

静态资源白名单在 `server.ts` 的 `STATIC_FILES`；新增 public 文件（例如图标）必须同时加路由和 MIME，否则打包后会 404。

## 6. 运行与测试

要求 Node.js >= 22.5（`node:sqlite`）、pnpm 10。

```powershell
cd D:\code\kolorbot
pnpm install
pnpm build
pnpm test
npm run web       # 默认尝试 3399 -> 3420 -> 随机
```

重启主服务：

```powershell
.\restart.cmd
```

当前测试：

```text
pnpm test  ✅ 132/132
  kolorbot-agent-loop 61
  kolorbot-conversation 5
  kolorbot-skills     14
  kolorbot-memory     11
  kolorbot-web        41
```

UI 没有自动化浏览器测试。改 `public/app.js` 后至少手测：发送/流式、话题切换、刷新重连、取消、滚动、Markdown、agent 卡片、指令补全、设定页。

## 7. 关键约束 / 容易踩的坑

1. **工具调用与结果必须成对**，否则 `validateAgentContext` 拒绝。
2. **本地工具名无前缀**（`read_file` 等），MCP 才是 `mcp__<server>__<tool>`。
3. **每条普通消息都会话题判定**；切换话题新开 segment，旧消息不进模型上下文但 UI 保留。
4. **记忆写入有门禁**：`write_topic_note` 只在整理任务启用；普通聊天不要写。
5. **跨本地日期强制新 segment**：第二天第一条普通消息会关闭前一天 segment 并触发整理。
6. **AI.md 头部固定**：`# 名字` → `## head-image` → `> 头像路径`；改格式会导致名字/头像解析不到。
7. **头像服务只读本地图片**：路径相对 workspace 或绝对路径；扩展名限 png/jpg/jpeg/webp/gif/svg；`http(s)` 直接交给 `<img>`。
8. **agent 卡片和设定页依赖 `/api/agent` + `/api/memory`**；没有 AI.md 时显示回退名 `KolorBot`，不是错误。
9. **话题图标只在对话/话题页**；技能/模型/设定页隐藏。改 `renderHeader` 时要保持这个条件。
10. **对话轮询不能强制滚底**：`loadConversation` 用签名跳过无变化重建；有变化时 `renderMessages(false)` 保留位置。
11. **`/api/memory` 仍保留旧日记后端**，但设定页不再展示日记；自动整理开关目前只能通过 API/`memory.json` 修改。
12. **`memory` 页面 key/hash 是历史命名**（`#/memory`），UI 已改叫「设定」；不要因为看到 memory 就加回日记 UI。
13. **没有内置默认模型**；`/api/chat` 缺 provider 会 400。环境变量回退需要 URL + model + key 三个都齐。
14. **run 不在请求里**：SSE 断开不停 turn；要停只能 `/api/chat/cancel`；同一 main 同时只有一个 turn。
15. **reset/delete 会丢弃运行中的 turn**，不会写回旧上下文。
16. **`bash` 不沙箱**；文件工具限制在 `frameRoot`。
17. **`--host 0.0.0.0` 会暴露无鉴权 UI**。
18. **静态资源必须进 `STATIC_FILES`**；只放 public 不会自动可访问。
19. **打包前关掉运行中的 exe**，否则 copyfile EBUSY。
20. **测试数不要写回旧值**：当前 132（conversation 5；memory 11；agent-loop 61；web 41）。

## 8. 已知限制 / 可以继续做

- 话题判定每条消息一次额外模型请求；分类失败默认继续。
- 切回旧话题不恢复旧消息，只靠话题记忆文件。
- 没有多用户、鉴权、HTTPS、权限隔离。
- 记忆没有事实库、用户画像、向量检索。
- 自动整理保留 10 分钟静默兜底；设定页移除旧日记 UI 后，没有前端开关。
- 记忆整理依赖模型按提示词调用 `write_topic_note`；服务端不兜底生成正文。
- 切换/跨天/补写的整理 Agent 不占用主对话；UI `/update-daily-memory` 走 `/api/diary/organize`。
- AI.md/头像没有在线编辑器；设定页只预览，更新走 `/self-md-*` 或手动编辑。
- 头像没有裁剪、上传、缓存失效策略；`/api/agent/avatar` 每次 `no-store` 读取。
- 没有会话列表/搜索/新建；只有一条对话。
- 定时任务功能已彻底移除。

## 9. 新对话怎么开始

把下面这段直接贴到新对话：

```text
项目在 D:\code\kolorbot。请先读 D:\code\kolorbot\HANDOFF.md 和 README.md。
包名是 kolorbot-*，不要改回 kolor-*；数据目录默认 ~/.kolorbot，KOLOR_*、kolor.json 保留旧名。

基线：
cd D:\code\kolorbot
pnpm install
pnpm build
pnpm test

当前状态（2026-11-21）：
- 单对话 + 话题驱动，只有一条 conversation.db；没有 scheduler/定时任务。
- 模型只来自「模型」页的 OpenAI Chat Completions 提供商；没有内置默认模型。
- 侧栏是 对话/技能/模型；左下角 agent 卡片有圆形头像、名字和 ⋯ 菜单（设定）。
- 对话/话题页标题左边有话题图标；话题页点击回对话，其他页面不显示。
- 对话轮询不会强制滚到底；标题下只显示相对时间。
- 设定页只显示 AI.md（名字/头像路径/预览），不再有旧日记项；页面 key/hash 仍是 memory。
- 输入框输入 / 弹出三条指令补全：/self-md-update、/self-md-tell、/update-daily-memory。
- AI.md 固定格式：# 名字 → ## head-image → > 头像路径。
- 新记忆文件：workspace/topic/<slug>/main.md 关键记忆 + <YYYY-MM-DD-HH-mm>.md 每日记录；write_topic_note 只在整理任务启用。
- 默认端口：3399 → 3420 → 随机；显式 --port / KOLOR_WEB_PORT 不回退。
- Electron 桌面端已删除，暂停使用。
- 测试 132/132；release SHA256 8B2F5780D9D2818613E2B6AD018CAFDF1A190318449118DD703140D784292BE3。
- 代码已推送到 https://github.com/zhaopingxiao/KolorBot.git。
```

## 10. 重要文件

| 文件 | 作用 |
| --- | --- |
| `packages/kolorbot-agent-loop/src/agent.ts` | `KolorAgent` 主循环、工具注册、MCP |
| `packages/kolorbot-agent-loop/src/config.ts` | 模型配置 / 系统提示词 |
| `packages/kolorbot-conversation/src/store.ts` | 单对话 SQLite：topics/segments/messages |
| `packages/kolorbot-skills/src/skills.ts` | 技能发现、签名、注入 |
| `packages/kolorbot-skills/src/mcp.ts` | `kolor.json` MCP 解析 |
| `packages/kolorbot-memory/src/memory.ts` | AI.md 解析、时间戳话题记忆、注入块、设定命令 |
| `packages/kolorbot-web/src/server.ts` | HTTP/SSE/API、AgentPool、RunBroker、静态资源、avatar |
| `packages/kolorbot-web/src/port.ts` | 端口可用性探测与回退 |
| `packages/kolorbot-web/src/diary-tools.ts` | list/read 今日记忆、旧日记、write_topic_note 记忆工具 + 写入门禁 |
| `packages/kolorbot-web/src/providers.ts` | 提供商存储、模型发现、active 模型 |
| `packages/kolorbot-web/src/runs.ts` | `RunBroker` turn 生命周期/回放/取消 |
| `packages/kolorbot-web/src/agent-pool.ts` | 每会话 agent、模型指纹重建 |
| `packages/kolorbot-web/src/topic-classifier.ts` | 话题判定 |
| `packages/kolorbot-web/public/index.html` | UI 结构：侧栏 / agent 卡片 / 三页 / 输入框 |
| `packages/kolorbot-web/public/styles.css` | 白色主题、agent 卡片、指令补全、移动端 |
| `packages/kolorbot-web/public/app.js` | 页面路由、对话/话题/设定、流式/滚动、agent 卡片、指令补全 |
| `packages/kolorbot-web/public/icons/` | 五个侧栏/话题 SVG 图标 |
| `restart.cmd` + `scripts/restart.ps1` | 启停脚本，日志 `logs/kolorbot-web.log` |
| `inner/skills/browseruse/` | 内置无头浏览器技能 |
| `docs/` | UI 截图 |

## 11. 最近提交 / 版本

```text
cde795e feat(skills): move the user skills directory to the data root
f09dd83 feat(api): add external message callback endpoint
73b6ef2 feat: move user data to ~/.kolorbot
85dce26 feat(web): settings page and slash command completion
6907eb9 feat(web): add agent card and fixed AI.md identity header
b8eaeec feat(web): move topics entry into the chat header
7df96ab feat(web): polish chat layout and stop polling scroll jumps
9d4f9df feat(web): add icons to sidebar navigation
737f94d fix(diary): only allow diary and topic writes during diary turns
8e36b50 feat(diary): current-topic tools, strict headings and topic memory UI
```

0.4.0 核心变化：单对话 + 话题驱动、话题记忆/日记、Windows release、五个导航图标、agent 卡片、设定页、指令补全。更早的 0.1/0.2/0.3 历史和详细截图可查 README 与 git log。
