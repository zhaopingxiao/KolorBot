# KolorBot 项目交接

> 项目路径：`D:\code\kolorbot`
>
> 最后更新：2026-11-17
>
> 当前版本：**0.4.0**
>
> 代码仓库：https://github.com/zhaopingxiao/KolorBot.git（origin/main）
>
> 代码基线：当前 `origin/main`（具体提交见 `git log`）
>
> 当前状态：`pnpm build` / `pnpm test` 全部通过（111 个测试），单对话 + 话题驱动，Windows 单文件 release 已更新。

## 1. 这个项目是什么

KolorBot 是一个本地运行的 Node.js 智能体运行时，配一个轻量 Web 聊天界面。

- 只使用用户在「模型」页添加的 OpenAI Chat Completions 兼容提供商，可自动发现模型；没有内置默认模型。
- 整个应用只有一条对话，按话题划分为 `topics` / `segments` / `messages`。
- 模型消息先做话题判定；切换话题会新开 segment，模型上下文只取当前 segment。
- 技能遵循 Claude `SKILL.md`，支持三个技能区；技能可以声明 MCP server。
- 记忆由 `AI.md`、每个话题的 `workspace/topic/<slug>.md`、当天日记片段组成。
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
│   ├── kolorbot-memory/         # AI.md、话题文件、日记、注入块
│   └── kolorbot-web/            # Web 服务、SSE、AgentPool、话题判定、前端、CLI
├── scripts/restart.ps1          # 启停脚本（restart.cmd 调用）
├── restart.cmd
├── inner/skills/browseruse/     # 内置浏览器 MCP 技能
├── docs/                        # UI 截图
├── README.md
├── HANDOFF.md
├── pnpm-workspace.yaml / pnpm-lock.yaml
├── tsconfig.base.json / tsconfig.dev.json
└── LICENSE                      # MIT
```

- 数据目录默认 `~/.kolorbot`（`KOLOR_HOME` 可覆盖）；环境变量仍是 `KOLOR_*`，技能 MCP 配置仍叫 `kolor.json`，类名仍是 `KolorAgent` / `KolorFrame`。包名已是 `kolorbot-*`，不要随意改回。

## 3. 当前架构

### 3.1 Agent loop（`kolorbot-agent-loop`）

- OpenAI 兼容流式客户端，手写 SSE 解析，支持 text / reasoning / tool-call 增量。
- 工具调度：有界并行池、独占屏障、按模型顺序提交结果、取消时补齐未执行调用。
- 上下文校验：每个 assistant `toolCalls` 必须有对应 tool 结果。
- MCP 客户端：stdio / Streamable HTTP / SSE，工具名 `mcp__<server>__<tool>`。
- 事件流、取消、超时、`concludeTurn`、上下文导入导出。
- 本地工具：文件读写、bash、技能读取、`read_image`。`read_image` 会把图片附到下一次模型请求；不支持视觉的模型自动降级。
- `KOLOR_SYSTEM_PROMPT` 目前只描述：话题组织、`list_topics` / `read_diary` 可读、日记写入只在日记轮次启用；普通聊天不要写日记/话题记忆。

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
  - `<system-memory>`：AI.md + `workspace/topic/<slug>.md` + 该话题最新日记片段；
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

#### 话题文件

`workspace/topic/<slug>.md` 保存话题事实、决定、当前状态、下一步。
`write_topic` 创建/替换当前话题文件；日记工具发现文件缺失时会提示 AI 调用它。

#### 日记

- 文件：`workspace/daily/YYYY-MM-DD.md`。
- 格式：`# 日期 → ## 话题 → ### HH:mm`；话题标题严格等于 `topics.name`，不做模糊匹配。
- 写入工具（只在日记轮次启用）：
  - `list_topics`：列出所有话题，当前话题标 `(current)`；
  - `read_diary({ slug?, date? })`：不带 date 列出有该话题的日期，带 date 读取当天该话题段落；slug 省略时用当前话题；
  - `write_diary({ content, date? })`：写当前话题，自动补日期/话题标题/时间；不接收 slug；
  - `write_topic({ content })`：写当前话题记忆，不接收 slug。
- 普通聊天调用 `write_diary` / `write_topic` 会返回错误，必须由显式日记轮次（手动 `/update-daily-memory`、闲置自动日记、话题页补写）开启写入。
- 自动整理：一轮对话结束后开始计时，默认 10 分钟无新消息时整理 `diary_at IS NULL` 的 segment；新用户消息会取消计时，日记轮次本身不重新计时。
- 话题页仍可对“有对话但没日记”的日期补写日记；补写走 headless 日记轮次。
- **UI 已移除日记设置/预览**，但后端日记功能、自动整理配置（`memory.json`）、`/update-daily-memory` 命令仍在。

### 3.5 技能与 MCP（`kolorbot-skills`）

三个技能区：

| 区 | 目录 | 说明 |
| --- | --- | --- |
| 兼容技能 | `~/.agents/skills`（`KOLOR_SKILLS_DIR`） | Claude 标准兼容区 |
| 专属技能 | `<frameRoot>/skills`（`KOLOR_USER_SKILLS_DIR`） | 默认 `~/.kolorbot/workspace/skills` |
| 内置技能 | `<repo>/inner/skills`（`KOLOR_BUILTIN_SKILLS_DIR`） | `browseruse` 在这里 |

- 按 `<区>/<id>/SKILL.md` 读取；同名技能按 **专属 → 兼容 → 内置** 取第一个。
- `kolor.json` 可声明 `mcpServers`（也接受 `mcp` 别名），支持 `${VAR}` 环境变量展开。
- Web 的「技能」页按三个区分组展示，有 MCP 的技能带 MCP 标识，详情显示 server 名称/transport。
- 原来的独立 MCP 页面已删除；MCP 只读，通过技能目录配置。

### 3.6 提供商与模型

- Web「模型」页添加 OpenAI Chat Completions 兼容提供商：名称、接口地址、API Key；调用 `/models` 自动识别模型。
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

### 3.8 Web UI（当前）

`packages/kolorbot-web/public/` 是纯静态 HTML/CSS/JS。

- 侧栏：
  - 顶部 KolorBot logo；
  - 主导航只剩 **对话 / 技能**；
  - 底部 **agent 卡片**：左侧圆形头像（来自 AI.md `head-image`，缺失显示名字首字），右侧名字，最右 `⋯`；
  - `⋯` 菜单只有 **模型** 和 **设定**。
- Agent 识别：
  - 名字来自 AI.md 第一行 `# 名字`；
  - 头像通过 `/api/agent` + `/api/agent/avatar` 提供；
  - 没有 AI.md / 没有名字时回退 `KolorBot`。
- 顶部标题：
  - 对话页标题左侧显示话题 SVG 图标，点击进入话题页；
  - 话题页同样显示图标并加深，点击回到对话；
  - 技能 / 模型 / 设定页不显示这个图标。
- 对话页：
  - 标题只显示当前话题名；右侧不再显示「N 条消息 · 时间」或话题 pill，标题下只显示相对时间；
  - 空对话显示大标题「今天有什么可以帮到你？」；
  - 输入框大圆角、白色卡片、阴影，发送按钮为蓝色圆形 `↑`；
  - 输入 `/` 弹出指令补全：`/self-md-update`、`/self-md-tell`、`/update-daily-memory`，点击自动填充；`/self-md-tell` 会补空格；
  - 20 秒轮询只在会话签名变化时重建消息列表，重建时保留当前滚动位置，不再定时被拉到底部；
  - 只有离底部一行以内才自动跟随新内容。
- 话题页：
  - 展示话题记忆 Markdown、按月份日历、当天聊天记录/日记；
  - 日历日期来自对话 segment，不一定有日记；
  - 有对话但没日记的日期可点「整理这天的日记」补写；
  - 话题/日期切换时重置滚动位置。
- 设定页：
  - 内部页面 key / hash 仍是 `memory`（`#/memory`），但 UI 全部显示「设定」；
  - 只显示 AI.md 预览、路径、大小、名字/头像路径、固定格式提示；
  - 不再有日记开关、日记预览、日记刷新。
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
  - 大小 135,811,072 bytes
  - SHA256 `8ACAD96D62E1284131F2573D0B5EA6A1CBA2D6357B361B62BB4E1882F102E5CF`
- 运行中的 `KolorBotMain.exe` 会锁住输出文件；打包前先关闭旧进程，或先改名旧 exe 再构建。

## 4. 数据文件

```text
~/.kolorbot/
├── conversation.db       # topics / segments / messages
├── memory.json           # 日记自动整理开关
├── providers.json        # 模型提供商 / active 模型 / key
├── workspace/
│   ├── AI.md             # 固定头部 + 性格/自我认知
│   ├── daily/YYYY-MM-DD.md
│   └── topic/<slug>.md
└── logs/                 # 源码运行时日志
```

- `KOLOR_FRAME_ROOT` 可改 workspace。
- 日记、AI.md、话题文件都是普通 Markdown，可直接编辑/备份。
- 2026-11-17 起默认数据目录从 `~/.kolor` 改为 `~/.kolorbot`；现有数据已迁移，旧目录备份在 `C:\Users\jiayi\.kolor.backup-20261117-190135`。应用不再读取旧目录。
- 用户曾手动清空数据：数据库缺数据、话题 404、日记为空都不是 bug。

## 5. HTTP API 概览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/config` | 配置、当前模型、MCP、状态 |
| GET/POST | `/api/providers` | 提供商列表 / 添加并识别模型 |
| DELETE | `/api/providers/:id` | 删除提供商 |
| POST | `/api/providers/:id/models` | 重新识别模型 |
| PUT | `/api/model` | 切换当前模型 |
| GET | `/api/conversation` | 当前单对话的 topics / segments / messages |
| GET/PUT | `/api/memory` | AI.md + 日记后端数据；PUT 切换日记自动整理（UI 已不用） |
| GET | `/api/agent` | Agent 名字、头像路径、`avatarUrl` |
| GET | `/api/agent/avatar` | 读取 AI.md 指向的本地头像文件 |
| GET | `/api/topics` | 话题列表 |
| GET | `/api/topics/:slug` | 话题记忆 + 日历 |
| GET | `/api/topics/:slug/days/:date` | 某天该话题的聊天/日记 |
| POST | `/api/topics/:slug/days/:date/diary` | 补写某天日记 |
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

静态资源白名单在 `server.ts` 的 `STATIC_FILES`；新增 public 文件（例如图标）必须同时加路由和 MIME，否则打包后会 404。

## 6. 运行与测试

要求 Node.js >= 22.5（`node:sqlite`）、pnpm 10。

```powershell
cd D:\code\kolorbot
pnpm install
pnpm build
pnpm test
npm run web       # http://127.0.0.1:3399
```

重启主服务：

```powershell
.\restart.cmd
```

当前测试：

```text
pnpm test  ✅ 111/111
  kolorbot-agent-loop 53
  kolorbot-conversation 5
  kolorbot-skills     14
  kolorbot-memory     11
  kolorbot-web        28
```

UI 没有自动化浏览器测试。改 `public/app.js` 后至少手测：发送/流式、话题切换、刷新重连、取消、滚动、Markdown、agent 卡片、指令补全、设定页。

## 7. 关键约束 / 容易踩的坑

1. **工具调用与结果必须成对**，否则 `validateAgentContext` 拒绝。
2. **本地工具名无前缀**（`read_file` 等），MCP 才是 `mcp__<server>__<tool>`。
3. **每条普通消息都会话题判定**；切换话题新开 segment，旧消息不进模型上下文但 UI 保留。
4. **日记写入有门禁**：`write_diary` / `write_topic` 只在日记轮次启用；普通聊天不要写。
5. **日记 `##` 话题名严格匹配** `topics.name`，没有别名/模糊兼容。
6. **AI.md 头部固定**：`# 名字` → `## head-image` → `> 头像路径`；改格式会导致名字/头像解析不到。
7. **头像服务只读本地图片**：路径相对 workspace 或绝对路径；扩展名限 png/jpg/jpeg/webp/gif/svg；`http(s)` 直接交给 `<img>`。
8. **agent 卡片和设定页依赖 `/api/agent` + `/api/memory`**；没有 AI.md 时显示回退名 `KolorBot`，不是错误。
9. **话题图标只在对话/话题页**；技能/模型/设定页隐藏。改 `renderHeader` 时要保持这个条件。
10. **对话轮询不能强制滚底**：`loadConversation` 用签名跳过无变化重建；有变化时 `renderMessages(false)` 保留位置。
11. **`/api/memory` 仍保留日记后端**，但设定页不再展示日记；自动整理开关目前只能通过 API/`memory.json` 修改。
12. **`memory` 页面 key/hash 是历史命名**（`#/memory`），UI 已改叫「设定」；不要因为看到 memory 就加回日记 UI。
13. **没有内置默认模型**；`/api/chat` 缺 provider 会 400。环境变量回退需要 URL + model + key 三个都齐。
14. **run 不在请求里**：SSE 断开不停 turn；要停只能 `/api/chat/cancel`；同一 main 同时只有一个 turn。
15. **reset/delete 会丢弃运行中的 turn**，不会写回旧上下文。
16. **`bash` 不沙箱**；文件工具限制在 `frameRoot`。
17. **`--host 0.0.0.0` 会暴露无鉴权 UI**。
18. **静态资源必须进 `STATIC_FILES`**；只放 public 不会自动可访问。
19. **打包前关掉运行中的 exe**，否则 copyfile EBUSY。
20. **测试数不要写回旧值**：当前 111（conversation 5；memory 11；web 28）。

## 8. 已知限制 / 可以继续做

- 话题判定每条消息一次额外模型请求；分类失败默认继续。
- 切回旧话题不恢复旧消息，只靠话题文件和日记片段。
- 没有多用户、鉴权、HTTPS、权限隔离。
- 记忆没有事实库、用户画像、向量检索。
- 自动日记是 10 分钟固定默认值；设定页移除日记 UI 后，没有前端开关。
- 日记自动整理依赖模型按提示词调用 `write_diary`；服务端不兜底生成正文。
- 日记轮次会占用对话，期间用户发消息会 409。
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

当前状态（2026-11-17）：
- 单对话 + 话题驱动，只有一条 conversation.db；没有 scheduler/定时任务。
- 模型只来自「模型」页的 OpenAI Chat Completions 提供商；没有内置默认模型。
- 侧栏只剩 对话/技能；左下角 agent 卡片有圆形头像、名字和 ⋯ 菜单（模型/设定）。
- 对话/话题页标题左边有话题图标；话题页点击回对话，其他页面不显示。
- 对话轮询不会强制滚到底；标题下只显示相对时间。
- 设定页只显示 AI.md（名字/头像路径/预览），不再有日记项；页面 key/hash 仍是 memory。
- 输入框输入 / 弹出三条指令补全：/self-md-update、/self-md-tell、/update-daily-memory。
- AI.md 固定格式：# 名字 → ## head-image → > 头像路径。
- 日记后端仍在：daily/YYYY-MM-DD.md，格式 # 日期 → ## 话题 → ### HH:mm；write_diary/write_topic 只在日记轮次启用。
- 测试 111/111；release SHA256 8ACAD96D62E1284131F2573D0B5EA6A1CBA2D6357B361B62BB4E1882F102E5CF。
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
| `packages/kolorbot-memory/src/memory.ts` | AI.md 解析、日记/话题文件、注入块、设定命令 |
| `packages/kolorbot-web/src/server.ts` | HTTP/SSE/API、AgentPool、RunBroker、静态资源、avatar |
| `packages/kolorbot-web/src/diary-tools.ts` | list/read/write 日记和话题工具 + 写入门禁 |
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
85dce26 feat(web): settings page and slash command completion
6907eb9 feat(web): add agent card and fixed AI.md identity header
b8eaeec feat(web): move topics entry into the chat header
7df96ab feat(web): polish chat layout and stop polling scroll jumps
9d4f9df feat(web): add icons to sidebar navigation
737f94d fix(diary): only allow diary and topic writes during diary turns
8e36b50 feat(diary): current-topic tools, strict headings and topic memory UI
```

0.4.0 核心变化：单对话 + 话题驱动、话题记忆/日记、Windows release、五个导航图标、agent 卡片、设定页、指令补全。更早的 0.1/0.2/0.3 历史和详细截图可查 README 与 git log。
