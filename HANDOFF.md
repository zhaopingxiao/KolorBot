# KolorBot 项目交接

> 项目路径：`D:\code\kolorbot`  
> 交接时间：2026-11-01（从原 `D:\deepseek_harness_workspace\kolor` 迁移），最后更新 2026-11-14  
> 当前版本：**0.4.0**  
> 代码仓库：https://github.com/zhaopingxiao/KolorBot.git（origin/main）  
> 当前状态：`pnpm build` 和 `pnpm test` 全部通过（109 个测试）；已改成单对话 + 话题驱动：conversation 存储 topics/segments/messages，memory 负责话题文件与日记片段，定时任务功能移除。

## 1. 这个项目是什么

**KolorBot** 是一个本地运行的 Node.js 智能体（agent）运行时，配一个轻量 Web 聊天界面。

核心能力：

- **模型提供商**：Web UI 里添加任意 OpenAI Chat Completions 兼容提供商（地址 + Key），自动识别全部模型，输入框上方下拉框切换使用；没配提供商就没有可用模型（除非显式配置了环境变量回退）。
- 调 OpenAI 兼容接口，流式输出、工具调用循环、取消、上下文导入。
- 工具可以来自：
  - agent-loop 内置的本地工具（文件读写、bash、技能读取）；
  - 技能目录里 `kolor.json` 声明的 MCP 服务器。
- 会话、主题、定时任务持久化在 SQLite。
- 技能遵循 Claude 的 `SKILL.md` 标准，支持自动注入技能列表。
- Web UI 白色极简风（纯白背景），支持桌面和移动端抽屉，模型思考时显示三个点。
- 附带一个 DeepSeek Search/Fetch 技能示例。

它不是一个多用户服务器：没有鉴权，默认只监听 `127.0.0.1`。`bash` 工具完全不沙箱，只适合本机可信环境。

## 2. 目录与包

```text
D:\code\kolorbot\
├── packages/
│   ├── kolorbot-agent-loop/     # 主循环 + frame/ 本地工具（文件 / bash / skills / read_image）
│   ├── kolorbot-conversation/   # 单对话：topics / segments / messages
│   ├── kolorbot-skills/         # SKILL.md / kolor.json 解析、技能注入
│   ├── kolorbot-memory/         # AI.md、话题文件、日记解析、注入块
│   └── kolorbot-web/            # Web 服务、SSE、AgentPool、话题判定、提供商、前端、CLI
├── scripts/restart.ps1       # 启停脚本（restart.cmd 调用，run web）
├── restart.cmd               # 启停脚本入口
├── inner/skills/browseruse/  # 内置技能：无头浏览器（MCP + 实时画面 + WebMCP）
├── docs/                     # UI 截图
├── README.md
├── HANDOFF.md
├── pnpm-workspace.yaml / pnpm-lock.yaml
├── tsconfig.base.json / tsconfig.dev.json
└── LICENSE                   # MIT
```

注意：包名已从 `kolor-*` 改为 **`kolorbot-*`**；以下兼容标识保留：

- 数据目录仍是 `~/.kolor`，对话库改用 `conversation.db`（`KOLOR_CONVERSATION_DB`）；
- 环境变量仍是 `KOLOR_*`（`KOLOR_SESSIONS_DB` 已换成 `KOLOR_CONVERSATION_DB`）；
- 技能的 MCP 配置仍叫 `kolor.json`；
- 类名仍是 `KolorAgent`、`KolorFrame` 等。

这样做是为了不破坏已有安装、会话数据和技能配置。除非明确要求全量重命名，否则不要改这些内部标识。

## 3. 已经做了什么

### 3.1 Agent loop（`kolorbot-agent-loop`）

- OpenAI 兼容的流式客户端，手写 SSE 解析，支持 `text/delta`、推理内容、工具调用增量拼装。
- 工具调度器：有界并行池、独占屏障、按模型顺序提交工具结果、取消时给未执行的调用补结果。
- 上下文校验：每个 assistant 的 `toolCalls` 必须有对应的 tool 结果。
- MCP 客户端：stdio / Streamable HTTP / SSE 三种传输，工具名 `mcp__<server>__<tool>`。
- 事件流、取消、超时、`concludeTurn` 工具、上下文导入/导出。

### 3.2 单对话存储（`kolorbot-conversation`）

- SQLite（`node:sqlite`），默认 `~/.kolor/conversation.db`（`KOLOR_CONVERSATION_DB` 可覆盖）。
- 表：`topics(slug,name,...)`、`segments(id,topic_slug,started_at,ended_at,memory_signature,diary_at)`、`messages(id,segment_id,topic_slug,role,data_json,created_at)`。
- 整个应用只有一条对话；`segments` 是「话题访问」，切换话题就新建 segment，模型上下文只取当前 segment。
- `messages.data_json` 存完整 `AgentMessage`（含 toolCalls / tool 结果），UI 从同一份数据渲染。
- Web 侧有一个 `SingleConversation` 适配层，把单对话包装成旧的 session 形状（id 固定 `main`），供 RunBroker / AgentPool / 兼容 API 使用。

### 3.3 话题判定与上下文切换

- 每条普通用户消息先调用 `classifyTopic()`：`continue` / `switch` / `new`；分类失败一律 continue。
- 新话题：创建/复用 topic，开始新 segment，`pool.disposeSession('main')` 丢掉旧 agent。
- 上下文：`segmentMessages(currentSegment)`；切回旧话题也开新 segment，不恢复旧消息。
- 注入：新 segment 第一条带 `<system-memory>`（AI.md + topic 文件 + 最新日记片段）和 `<system-last-message>`（上一 segment 最后 10 条 user/assistant 文本）；同一 segment 内只有 AI.md 变化才重发记忆。
- 重置 `/api/sessions/main/reset` 清空全部消息/segment（话题与记忆文件保留）。

### 3.4 单对话与话题（2026-11-14 重构）

- **只有一个对话**：没有 session 列表/新建/搜索，所有消息在 `~/.kolor/conversation.db`。
- **话题判定**：每条用户消息先调用一次轻量分类（`topic-classifier.ts`），输出 `continue` / `switch` / `new`；失败或 JSON 坏时默认 continue。
- **segment**：每次切换话题（包括切回旧话题）新建一个 segment，模型上下文只包含当前 segment；UI 在 segment 之间显示话题分割线。
- **记忆注入**：新 segment 第一条带 `<system-memory>`（AI.md + `workspace/topic/<slug>.md` + 该话题最新日记片段）和 `<system-last-message>`（上一 segment 最后 10 条 user/assistant 文本）。同一 segment 内只有 AI.md 变化才重发 `<system-memory>`。
- **日记**：`# 日期 → ## 话题（首次出现顺序）→ ### HH:mm`；第一次写某话题时创建/更新 `workspace/topic/<slug>.md`，AI 用 `write_file` 维护。
- **话题页**：`/api/topics` 列出所有话题和日记天数；`/api/topics/:slug` 返回按月份分组的日记日历；`/api/topics/:slug/days/:date` 返回当天该话题的 segments 和日记片段。前端左侧「话题」页展示日历和当天详情（聊天记录 / 日记两个分页）。
- **定时任务已移除**：`kolorbot-scheduler`、`schedule_reminder`、任务 API/UI/测试全部删除；旧任务表随旧库归档。
- **旧记忆归档**：`D:\deepseek_harness_workspace\backup\kolorbot-memory-2026-11-14`（AI.md、daily、memory.json、sessions.db）。

### 3.5 技能（`kolorbot-skills`）

- 三个技能区（2026-11-08 新增多区支持）：

  | 区 | 目录 | 说明 |
  | --- | --- | --- |
  | 兼容技能 | `~/.agents/skills`（`KOLOR_SKILLS_DIR`） | Claude 标准兼容区 |
  | 专属技能 | `<frameRoot>/skills`（`KOLOR_USER_SKILLS_DIR`） | KolorBot 自己的区，默认 `~/.kolor/workspace/skills` |
  | 内置技能 | `<repo>/inner/skills`（`KOLOR_BUILTIN_SKILLS_DIR`） | 随源码分发，`browseruse` 在这里 |

- 每个区都按 `<区>/<id>/SKILL.md` 读，Claude 标准 frontmatter；同名技能按 **专属 → 兼容 → 内置** 取第一个，三个区的 `kolor.json` 都收集、同名 MCP server 同样按这个优先级。
- `SkillsRegistry({ roots })` 接收 `SkillRoot[]`（`source` + `path`）；`list()` 合并去重、`listSource(source)` 保留分区、`get(id)` 从实际路径读文件；`signature()` 是 `v2:<sha1>`（包含 id/描述/来源），来源变化会重新注入。
- 生成 `<system-skills>` 列表，格式 `id - description`。
- 对话开始、重置、或技能列表指纹变化时注入；发送后记录 `skills_signature`。
- 内置 `skills(id)` 工具读取完整 `SKILL.md` 和文件列表（`kolorFrame.extraSkillRoots` 让三个区都能查）。`server.ts` 的 `KOLOR_SYSTEM_PROMPT` = agent-loop 默认提示词 + 日记工具说明 + 「不要停在计划/半成品，做到完成再汇报，除非需要用户确认」，通过 `AgentPool.systemPrompt` 传给 `KolorAgent.create`。
- Web 侧栏「技能」面板按三个区分组展示（标题 + 数量 + 空区目录提示），有 MCP 的技能带 **MCP** 标识，点开详情能看到它声明的所有 server（名称 + transport）。`/api/skills` 返回 `roots: [{ source, label, path, count }]`。
- 每技能可用 `kolor.json` 声明 MCP：

```json
{
  "mcpServers": {
    "server-name": {
      "command": "node",
      "args": ["server.mjs"],
      "env": { "TOKEN": "${TOKEN}" }
    }
  }
}
```

- 也接受 `"mcp"` 作为 `mcpServers` 的别名。
- `kolor.json` 可放在单个技能目录，也可放在任一个技能区根目录作为全局配置（区根优先，然后按技能 id 排序）。
- `env` / `headers` 支持 `${VAR}` 展开，从启动进程的环境读取；`/api/mcp` 和 `/api/config` 不会回传 env/headers。

### 3.6 MCP 的管理方式

- **不再手动维护 `~/.kolor/mcp.json`**，旧文件已删除。
- **Web 的 MCP 页面已删除**（2026-11-05）：MCP server 不再有独立面板，改在「技能」页展示——带 MCP 的技能旁边有 `MCP` 标识，点开技能详情能看到它声明的全部 server（名称 / transport）。`/api/mcp` 仍保留为只读 API，UI 不再调用。
- 添加/删除/启用服务器 = 修改技能里的 `kolor.json`，下一轮对话会自动重连。**单个服务器可以在技能详情里点「刷新」重启**（2026-11-08 新增）：`POST /api/mcp/:name/restart` → `AgentPool.restartMcpServer` → 每个存活 agent 的 `KolorAgent.restartMcpServer` → `McpManager.restart`（关闭旧连接、重新 `connect + listTools`、重新注册该服务器的工具，旧工具先 unregister）；无存活 agent 时返回 `status: null`。
- 同名 server 先到先得；根配置优先，然后按技能 id 排序。

### 3.7 KolorFrame 的演变

最初 KolorFrame 是一个 stdio MCP 子进程，由 agent-loop 自动挂载。后来按需求**解散成 agent-loop 直接注册的本地工具**：

```text
read_file
write_file
list_files
bash
skills
read_image
```

不再是：

```text
mcp__kolorbot-agent-loop__read_file
...
```

`kolorbot-agent-loop` 包现在只是一个本地工具库，没有 MCP server / bin / SDK 依赖；`KolorAgent` 默认注册这些工具，传 `{ kolorFrame: false }` 可关闭。

**`read_image`（2026-11-10）**：按本地路径读取 PNG/JPEG/GIF/WebP/BMP（工作区 + 三个技能区），返回格式、字节数、像素尺寸，并把图片以 `ToolImage` 附到**下一次模型请求**：`KolorAgent` 在 `#buildRequest` 里追加一条 content 数组的 user 消息（text + `image_url` 的 data URL）。模型侧两档：DeepSeek 里只有 `flash`（以及旧的 `...vision...` 名）支持视觉，`deepseek-v4-pro` 等文本模型只给元数据；其他 family 命中 `text-|embedding|rerank|moderation` 也跳过；未知模型先尝试带图，若 provider 返回 400/415/422 且提到 image/vision 等，就在还没产生任何输出时丢掉图片重试一次，并记住该 agent 不支持视觉。图片只在本次请求内有效，不写进会话历史。

### 3.8 Web UI（`kolorbot-web`）

- 白色极简风，纯白背景 + 浅灰层级（`--bg: #ffffff`，侧栏/输入盒 `#fafafa`），无 1px 描边，`tabular-nums` 数字锁宽，toast 自动消失。
- 流式输出逐字 blur 晕入。
- **流式段落重置（2026-11-14）**：一个 turn 里工具调用前后的多段 assistant 文本，在 `handleRunEvent` 的 `tool/call`、`tool/result`、`tool/skipped` 分支会调 `resetSegment(stream)` 把 `stream.text`/`lastFragment` 清空；否则下一段助手气泡会把前面所有段落的文字重新渲染一遍，看起来像“上下文带着以前的回答”。`attachRun` 开始时也会 `dropStream`，避免复用一个已中断 turn 的流。
- **Markdown 实时渲染（2026-11-07）**：`renderMarkdown` 支持标题 `#`-`######`、`> ` 引用、有序/无序列表（含嵌套和 `- [ ]` 任务项）、Github 风格表格（`| a | b |` + 分隔行）、` ```lang ` 围栏代码块（带语言标签）、`---` 分隔线、`**加粗**`、`*斜体*`、`~~删除线~~`、`` `行内代码` ``、`[链接](url)`、`![图片](url)`（渲染成 `.md-image`，因此 browseruse 的截图 URL 能直接显示）；HTML 全部转义后再套样式，代码内容不解析内联。流式时 `flushStream` 每一帧把已接收文本（去掉最新一段）重新 `innerHTML = renderMarkdown(prefix)`，**只有最新一段保持原始文本 + `.stream-chunk` 淡入动画**，下一帧它并入已渲染部分——所以是边出边渲染，而不是等整条回复结束。样式在 `styles.css` 的 "rendered markdown" 区块。
- **思考指示**：发送后到第一个字（或工具卡片）出现前显示三个跳动的点；`step/start` / `reasoning/delta` 时显示，`text/delta`、`tool/call`、`tool/result`、`turn/end`、请求结束（含停止）时消失。实现是 `app.js` 的 `.thinking` + `.thinking-dot`，`prefers-reduced-motion` 时关闭动画。
- 工具调用卡片显示：工具名、状态（运行中/完成/失败/跳过）、耗时、参数、结果；**默认折叠**，点 summary 展开。运行中的用户输入不再堆在输入框里：按 Enter 会存成 `state.queued`，本轮结束（`finishRun`）后自动发送，避免下一句把上一句一起带上。
- **断线重连**：turn 在服务端的 `RunBroker` 里跑，SSE 只是镜像；关标签/刷新/切会话只断开监听，回来从缓冲回放整轮。会话列表有 `running` 时显示跳动的点；轮询发现当前会话在跑会自动 `attachLive`。停止按钮走 `/api/chat/cancel`，服务端发 `run/cancelled` 再正常结束。
- **跟随滚动**：只有离底部一行字（按 `.assistant-message` 的 `line-height` 计算）以内才自动贴底；往上翻时不拽走，轮次结束 `renderMessages` 重建也保持原位置（`renderMessages(forceBottom, note)`，会话切换才强制到底）。
- 取消的轮次在重建后仍显示「已停止」标记（`run-note`），但部分回答不落库。
- 保留元素：KolorBot / 新对话 / 搜索对话 / 会话列表 / 技能 / 模型 / 记忆 / 标题 / 消息数·时间 / 主题 / 定时 / 重置 / 删除 / 对话 / 模型下拉框 / 发送框。
- 技能页：有 MCP 的技能带 `MCP` 徽标（多个显示 `MCP ×N`），点开技能显示 `MCP servers` 区块（名称 + transport）和 `SKILL.md` 全文；全局 `kolor.json` 的 server 以「全局 MCP」行显示。
- 原来的 MCP 页面（侧栏 MCP 按钮 + `#mcp-dialog`）已删除。
- 移除了导入/导出、工具徽章、主题展示、注入提示、会话预览、改名等 UI（后端 API 仍然保留 import/export/rename）。
- 移动端（≤900px）：
  - 左侧三条杠打开对话列表抽屉；
  - 右侧三条杠打开会话操作抽屉；
  - 点会话/操作/遮罩/Esc 自动收起，锁定背景滚动；
  - 适配安全区、16px 输入字号、全宽 dialog。

### 3.9 DeepSeek 搜索/抓取技能

已经安装到 `~/.agents/skills/deepseek-search/`（源码已从仓库的 examples 里移除，技能本身仍在兼容区）。

- MCP server：`server.mjs`，无第三方依赖，stdio JSON-RPC。
- 工具：
  - `search`：调用 DeepSeek `/v1/tools/search`，支持 `site:` / `lang:` / `after:` / `before:` 等语法，返回标题、URL、摘要、日期、分数、权威性，可选正文。
  - `fetch`：调用 `/v1/tools/fetch`，返回 Markdown 正文，`max_chars` 截断。
- Key 通过 `kolor.json` 的 `${DEEPSEEK_API_KEY}` / `${KOLOR_API_KEY}` 注入。
- 本轮没有真实调用付费 API；用本地 mock 验证了 MCP 协议、工具参数、返回格式和 web 端接入。

### 3.10 品牌与截图

- Logo 由 `Kolor.jpg` 去白底生成 256×256 PNG，放在 `packages/kolorbot-web/public/logo.png`。
- 品牌名改为 **KolorBot**；浏览器标题、侧栏、启动日志、系统提示词均已更新。
- `docs/` 下截图已换成 KolorBot 版本。
- 根 `package.json` 名称是 `kolorbot`。

### 3.11 模型提供商（2026-11-01 新增）

原来是「默认 DeepSeek + 环境变量 key」，现在改成**纯提供商接入**（2026-11-01 又去掉内置默认模型）：

- **入口**：侧栏底部与「技能」「记忆」并列的「模型」按钮，打开提供商页。
- **添加**：填名称（可空，默认域名）、接口地址、API Key（本地服务可空）→ 调 `GET <base>/models` 识别该提供商全部模型；`/v1` 之前的根地址会先试 `/models` 再试 `/v1/models`；识别失败直接报错（不保存空提供商）；没有 `/models` 的网关可手动填模型（逗号分隔）跳过识别。
- **使用**：对话输入框上方新增下拉框，列出「提供商 · 模型」；选中即全局生效。新加的第一个提供商自动选中第一个模型。
- **回退**：`config.ts` 不再有 `DEFAULT_API_URL` / `DEFAULT_MODEL`（原来是 `https://api.deepseek.com` + `deepseek-chat`）。只有 `KOLOR_API_URL` + `KOLOR_API_MODEL` + key **三个都显式设置**（或启动时显式传参）才会出现「环境变量 · 模型」这一项；只设 key 不算配置，此时 `/api/chat` 返回 400 并提示添加提供商。`.env` 里的 `DEEPSEEK_API_KEY` 仍注入给技能/搜索 MCP。
- **存储**：`~/.kolor/providers.json`（`version/active/providers`），原子写入，POSIX 下 `0600`。**API Key 只存这里**，接口只返回 `hasKey` + `••••末四位`，不返回明文，也不写进 `sessions.db`。
- **切模型**：`AgentPool.get(sessionId, context, target)` 记住每个会话的模型指纹，变了就重建该会话的 agent（MCP 会重连）；设置/定时任务用触发时的 active 模型。
- **代码**：`kolorbot-web/src/providers.ts`（`ProviderStore`、`discoverModels`、`normalizeBaseUrl`、`modelsEndpoints`），路由在 `server.ts`，`bin.ts` 启动日志改打当前模型来源。
- **测试**：新增 13 个（`test/providers.test.ts` + `test/helpers/mock-provider.ts`），覆盖脱敏/持久化/回退、地址归一化、`/models`→`/v1/models` 回退、401 与连接失败、添加/刷新/删除 API、以及「用选中模型真实对话」的端到端。
- **截图**：`docs/models.png`（桌面端提供商页 + 输入框上方的模型下拉框）。

### 3.12 记忆：设定（AI.md）+ 日记（2026-11-02 新增，2026-11-11 加设定）
两个板块：**设定**（AI.md）和**日记**；记忆按话题注入。

- **入口**：侧栏「记忆」页面：设定（AI.md 预览/路径/大小/刷新）和日记（自动整理开关/今日预览/刷新）。
- **自动整理**：一轮对话结束（`handleChat`）后开始计时，10 分钟内没有新用户消息就整理 `diary_at IS NULL` 的 segment；新消息会取消计时，日记轮次本身不重新计时。
- **写入工具（2026-11-14）**：日记不再由模型直接写文件，改用三个专用工具：
  - `list_topics`：列出所有话题 slug/name，当前话题标 `(current)`；
  - `read_diary({ slug, date? })`：不带 date 返回有该话题的日期，带 date 返回当天该话题的 `##` 段落；
  - `write_diary({ content, date? })`：写当前话题，按当前本地时间（或指定日期）追加，自动创建 `daily/YYYY-MM-DD.md`、`## 话题`、`### HH:mm`，保持话题首次出现顺序。
  - `write_topic({ content })`：创建/替换当前话题记忆 `workspace/topic/<slug>.md`；日记工具发现话题记忆缺失时提示调用它。
- **布局**：`# 日期 → ## 话题 → ### HH:mm`；`write_diary` 统一维护，模型不再写标题/时间；`##` 话题名严格等于 topics.name，不做模糊兼容。
- **提示词**：`buildTopicDiaryMessage` 附上按话题分组的 transcript，并说明上述工具；`/update-daily-memory` 使用同一路径。
- **话题文件**：`workspace/topic/<slug>.md` 由 `write_topic` 维护（事实、决定、状态、下一步）；`write_file` 不再用于日记或话题文件；`write_diary` / `write_topic` 只在日记轮次里启用，普通聊天调用会报错。
- **设定（AI.md）**：`<workspace>/AI.md`，只放 AI 名字/性格/自我认知，可带形象路径，超过 1 MiB 截断。
- **设定命令**：`/self-md-update`、`/self-md-tell <信息>` 直接要求模型用 `write_file` 写 AI.md，规则写在触发消息里。
- **测试**：memory 10 个、web 28 个，覆盖工具、写入门禁、对话日期日历、补写日记、注入去重、设定命令和闲置整理。

### 3.13 运行中的 turn（`RunBroker`，2026-11-07 新增）

- **问题**：以前一轮对话活在 `/api/chat` 请求里，关标签/断网会 abort，回答直接丢失。
- **做法**：`src/runs.ts` 的 `RunBroker` 按 session 持有 turn（每个 session 最多一个）。`/api/chat` 只做 `runs.begin()` + `attachRunSse()`，循环在 `driveTurn` 里跑；SSE 断开只移除 listener。事件序列化后进入缓冲（上限 4MB，超出后 `truncated: true`，晚加入的客户端靠会话回退）。
- **回放**：`GET /api/sessions/:id/stream?from=N` 先发 `run/state`，再重放 `events[N..]`，然后接实时事件；15s 一个 `: ping` 心跳。`GET /api/sessions/:id/run` 返回状态 + 缓冲事件；完成后 `RunView` 保留 5 分钟。
- **取消**：`RunAbortReason = 'user' | 'reset' | 'delete' | 'shutdown'`。abort 后循环正常结束（`stopReason: 'aborted'`），发 `run/cancelled`，状态记 `cancelled`。
- **reset/delete 语义**：`reset` / `delete` 会 `runs.cancel(id, 'reset'|'delete')`；`driveTurn` 看到这两个原因**跳过** `store.replaceContext()`，否则被 abort 的 turn 会把 reset 前的上下文写回去（2026-11-07 修复，测试 `resetting a session during a turn is not undone`）。
- **同一会话只跑一轮**：重复 `/api/chat` 返回 409；客户端收到 409 会 `loadSessions()` 后 `attachLive()` 接上正在跑的那轮。
- **headless**：定时任务和日记也走 broker（`runHeadlessTurn`），所以打开会话能看到它们的实时进度；只有用户消息和定时任务会重置日记静默期，日记自己不会。
- **前端**：`app.js` 的 `streams: Map` + `state.live`；`attachRun / detachRun / finishRun / attachLive`，`ensureStream` 用 `run.prompt`（剥壳后）重建用户气泡。流式文本按 `requestAnimationFrame` 批量插入 `.stream-chunk`。
- **客户端容错（2026-11-07）**：`consumeRun` 把 `handleRunEvent` 包在 try/catch 里，单个事件渲染失败只 toast 一次并继续消费；轮次结束仍由 `finishRun` 从会话兜底重建。同一天修过一个 `dropEmptyAssistant is not defined`：重构 `handleStreamEvent` 时函数被删但 `handleRunEvent` 的三处调用还在，结果一出现工具调用就抛 ReferenceError——实时卡片中断、页面只弹一个报错，等轮次结束重新拉会话才看到消息。
- **测试**：`test/runs.test.ts` 6 个（断开后继续、晚加入回放、409、取消、完成态 TTL、reset 不被写回）。客户端 JS 没有自动化测试，改 `public/app.js` 后至少手测：文本流、工具卡片、Markdown 渲染（标题/表格/代码块）、刷新重连、取消。

### 3.14 浏览器操控技能（browseruse，2026-11-08 新增）

一个**挂在 MCP 上的真实浏览器**，只是技能。源码在 `inner/skills/browseruse/`（内置技能区，启动时自动发现，不再安装到 `~/.agents`）。

- **入口**：`kolor.json` 声明 stdio MCP `browseruse` → `node server.mjs`；依赖只有 `playwright-core`，驱动**系统 Edge**（`channel: 'msedge'`）的无头实例，不用下载浏览器内核。
- **实时画面**：server 内置一个小 HTTP 服务，默认 `http://127.0.0.1:9223/`（`BROWSERUSE_VIEW_PORT` 可改；`BROWSERUSE_HEADLESS=false` 显示真实窗口），`/screen.mjpg` 用 MJPEG 实时流屏幕，`/screen.png` 取单帧，`/shot/<file>` 提供保存的截图，`/` 是观看页。每次工具操作后自动截图；有人观看时每 250ms 补帧。**页面可手动操作**：观看页把鼠标点击/双击/右键、滚轮、键盘经 `POST /input` 转发到真实页面（坐标按截图比例映射到视口，键盘带修饰键，中文走顶部输入框回车 → `insertText`），**触摸屏单指上下滑动会转成滚轮滚动网页**（2026-11-08：之前只能鼠标滚轮，手机没法滑）；滚轮转发会先把鼠标移到视口中心再滚，避免落在不可滚动区域。
- **工具**（模型看到的是 `mcp__browseruse__browser_*`）：`browser_open(url)`、`browser_snapshot()`（**文本 + 截图合并**：标题/URL/正文/带序号的可交互元素 + 存到技能目录 `shots/` 的 JPEG，并在返回值里给出 `![page screenshot](http://127.0.0.1:9223/shot/<file>.jpeg)` 和截图文件路径）、`browser_click(index)`、`browser_type(index, text)`（原生 setter + input 事件，兼容 React 表单）、`browser_press(key)`、`browser_evaluate(expression)`。截图单独工具已移除；`/shot/<file>` 由预览 HTTP 服务提供。
- **自动快照（2026-11-08）**：`browser_open` / `browser_click` / `browser_type` / `browser_press` / `browser_evaluate` 的结果末尾都会跑一次 `snapshotPage()` 并把结果拼上（`## Auto snapshot after this action`：最新页面文本 + 新截图），模型不需要为了看操作结果再手动 snapshot；SKILL.md 说明截图**按需展示**（用户要截图或需要说明页面时才展示对应 Markdown 图片）。
- **实时地址只在打开新页面后给一次**：`browser_open` 的返回里带 `Live view:`，其他工具（含自动快照）不再输出地址；用户主动问时才重复。
- **WebMCP**：`browser_webmcp_list()` / `browser_webmcp_call(name, input)` 通过 CDP `Page.listWebMCPTools` / `Page.invokeWebMCPTool` 调用**网页自己注册的** WebMCP 工具；启动参数带了 `--enable-features=WebMCP,WebMCPTesting,DevToolsWebMCPSupport`。需要 Chrome ≥ 149；当前系统 Edge 157 还没开放该 CDP 命令，工具会返回明确的「不支持」错误，换支持它的浏览器即可用。
- **生命周期**：MCP 进程随会话 agent 存在，所以浏览器页面和实时画面在**同一会话的多轮之间保留**；会话删除/重置或模型切换重建 agent 时进程退出、画面地址失效。
- **验证**：`inner/skills/browseruse/smoke.mjs` 直接对 server.mjs 打 JSON-RPC（open/snapshot/click/type/evaluate/webmcp_list + 实时画面三个端点 + `/input` 手动操作（点击/拖动 down-move-up/滚轮/触摸滑动））；检查每个操作的返回都带自动快照和 `![...]` 图片、只有 `browser_open` 带 `Live view:`、`/shot/<file>` 可下载 JPEG、wheel 后 `scrollY > 0`。另在线上实例用真实模型实测：只调用 `browser_open` + `browser_click`，回复里出现 **2 张截图** 且实时地址只出现一次；UI 侧确认 Markdown 图片渲染成 `<img class="md-image">`。
- **注意**：这是浏览器自动化，网页里能登录、能执行任意 JS；敏感操作前先确认用户。单窗口单页面，没有多标签。

### 3.15 0.2.0（2026-11-14）

第一个正式版本号（此前一直是 0.1.0）。从 0.1.0 到 0.2.0 的主要变化：

- **技能三区**：兼容区 `~/.agents/skills`、专属区 `~/.kolor/workspace/skills`、内置区 `inner/skills`，技能弹窗分区显示；browseruse 移入内置区，deepseek-search 从仓库移除。
- **真识图**：`read_image` 读取本地图片并作为 `image_url` 附给支持视觉的模型（`deepseek-flash` 等）；文本模型只拿元数据，provider 拒绝时自动降级。
- **角色设定**：`workspace/AI.md` + `/self-md-update`、`/self-md-tell`，与日记共用 `<system-memory>`（AI.md 在前），1 MiB 上限，界面「设定」面板。
- **Windows 单文件发布**：`KolorBotMain.exe` 内嵌 packages + Node + npm + public + inner；空目录可运行，首次启动解压 `runtime/`、创建 `logs/`，不依赖系统 Node。
- **体验修复**：运行中发送改为排队；工具卡片默认折叠；assistant 文本按工具步骤分段渲染（`resetSegment`），不再把前文重新贴一遍；maxSteps 80、工具 120s（bash 10 分钟）、请求 300s，系统提示词要求做完再停。
- 测试：157 个，全部不依赖网络/API key。

### 3.16 0.4.0：单对话 + 话题驱动（2026-11-14）

- **包名**：`kolor-*` → `kolorbot-*`；`kolor-frame` 合并进 `kolorbot-agent-loop/src/frame/`。
- **单对话存储**：`kolorbot-conversation`（topics / segments / messages）；旧的 `kolorbot-sessions`、`kolorbot-scheduler` 已删除。
- **话题判定**：每条普通消息一次 `classifyTopic()`，返回 continue/switch/new；切换话题新建 segment 并换上下文。
- **记忆**：`kolorbot-memory` 新增话题文件读取、日记片段查找、`<system-memory>` / `<system-last-message>`。
- **日记**：`# 日期 → ## 话题（首次出现顺序）→ ### 时间`；segment 用 `diary_at` 标记是否已整理。
- **定时任务移除**：`run web` 是唯一命令，任务 API/UI/提醒工具/测试全部删除。
- 测试：109 个（agent-loop 53、conversation 4、skills 14、memory 10、web 28）。

## 4. 关键约束 / 容易踩的坑

1. **工具调用与结果必须成对**：上下文里 assistant 的每个 `toolCalls` 都要有对应 tool 消息，否则 `validateAgentContext` 会拒绝。
2. **本地工具名没有前缀**：是 `read_file` 等；MCP 工具才是 `mcp__<server>__<tool>`。旧会话里的历史工具名不影响展示，但新工具注册名称以代码为准。
3. **KolorFrame 不再是 MCP**：不要重新引入 `kolorbot-agent-loop/bin` 或 SDK。
4. **MCP 只读**：Web 不能加/删 server；改技能目录的 `kolor.json`。
5. **技能列表注入指纹**：改技能 id/description 会触发重新注入；改正文不会。
6. **每条普通消息都会先判定话题**：分类失败默认 continue；切换话题会新建 segment，旧消息不再进入模型上下文（但 UI 仍显示）。
7. **重置**会清空技能签名，所以下一条会重新注入 `<system-skills>`。
8. **主题和技能壳子**会在 UI 渲染时剥掉，不展示注入内容。
9. **`bash` 不沙箱**；文件工具限制在 `frameRoot`（默认 `~/.kolor/workspace`）。
10. **API key 的存放位置**：提供商 key 存在 `~/.kolor/providers.json`（明文，本机可信环境），接口和前端只能拿到 `hasKey` / `••••末四位`；`conversation.db` 永远不写 key；环境变量里的 key 仍按 `kolor.json` 的显式占位符注入 MCP 子进程。
11. **`--host 0.0.0.0` 会暴露无鉴权 UI**；只在可信局域网使用。
12. **包名已改为 `kolorbot-*`**；`~/.kolor`、`KOLOR_*` 和 `kolor.json` 仍是兼容标识，不要跟着改。
13. **模型选择是全局的**（不是每个会话一份）：切换后所有会话下一轮都用新模型；正在跑的轮次不受影响。
14. **`/api/chat` 不再看 `config.apiKey`**：先解析 active 提供商，再回退到「三个环境变量都齐」的显式配置；都没有才 400。新增提供商不需要重启。
15. **没有内置默认模型**：`config.apiUrl` / `config.apiModelName` 为空是正常状态（`/api/config` 里 `hasModel: false`），不要为了「能启动」把它们填回 deepseek。
16. **`providers.json` 坏掉会直接报错**（`is not valid JSON`），不会静默丢配置；改它之前先确认服务没在写。调度器读取时会去掉 BOM。
17. **记忆注入去重靠组合签名（`memory_signature` 列，沿用旧列名 `daily_signature`）**：AI.md + 当天日记的哈希没变就不注入；重置会清空它，所以重置后第一条消息一定会重新带上 `<system-memory>`。改 AI.md 或日记都会让签名变化，下一条消息自然重新注入。
18. **日记轮次不重新计时**：只有用户消息完成会 `noteTurnFinished`；`runDiaryTurn` 结束后不再触发，否则会无限自我整理。日记只整理 `diary_at IS NULL` 的 segment。
19. **10 分钟计时只在进程存活时有效**：重启后从下一轮对话重新开始，不会补跑；关掉开关会立刻清掉所有待触发的计时器。
20. **`/update-daily-memory` 必须整条消息**：`/update-daily-memory now` 之类的会当普通消息发给模型。
21. **记忆衔接只发生在当天第一次整理**：`previous_topic` 只在日记文件由这次调用创建时生效；文件已存在时传了也会被忽略。想补写旧日记请直接编辑 Markdown。
22. **「上一篇日记」由模型自己找**：固定提示词让它 `list daily/` 并按文件名日期读最近一篇更早的 `YYYY-MM-DD.md`；不是服务端预计算，所以日记目录改名/非日期命名会影响模型的选择。
23. **`npm run web` 不 build**：它用 `tsx` 直接从 `src/` 导入（依赖 `tsconfig.dev.json` 的 paths）。改了包源码重启即可；改 `tsconfig.dev.json` 忘记同步 paths 会导致 `Cannot find package`。发布/测试仍用 `pnpm build` + `dist/`。
24. **turn 不在请求里**：`/api/chat` 返回的 SSE 断开不会停 turn；要停只能 `/api/chat/cancel`。同一 session 同时只有一个 turn，重复 POST 返回 409（客户端会自动 attach 现有那轮）。
25. **reset/delete 会丢弃运行中的 turn**：不会把 abort 前的上下文写回去；想保留就等 turn 结束再 reset。
26. **回放缓冲上限 4MB**：超出后 `truncated: true`，晚加入的客户端只能看到部分事件，turn 结束后以 `session/saved` + 会话内容为准。
27. **跟随滚动只看一行**：阈值是 `.assistant-message` 的 `line-height`，不是固定像素；改动消息字体/行高时不需要再调常量。
28. **`RunBroker` 是进程内的**：进程重启后所有运行中的 turn 消失，不补跑；会话里已持久化的部分保留。

## 5. 运行

要求 Node.js >= 22.5（`node:sqlite`），pnpm 10。

```powershell
cd D:\code\kolorbot
pnpm install
pnpm build
pnpm test
```

启动 Web：

```powershell
npm run web        # http://127.0.0.1:3399
```

也可以直接用启停脚本（默认后台跑 Web 在 `100.87.104.6:3399`，日志写 `logs/kolorbot-web.log`）：

```powershell
.\restart.cmd            # 停掉旧实例并后台拉起 Web
.\restart.cmd status     # 看端口/PID/模型
.\restart.cmd stop       # 只停
.\restart.cmd start -Foreground   # 前台跑，看报错
```

`npm run web` 用 `tsx` 直接跑 TypeScript 源码（`tsx --tsconfig tsconfig.dev.json packages/kolorbot-web/src/bin.ts run web`），不逐个 package `tsc`。`tsconfig.dev.json` 的 `paths` 把 `kolorbot-agent-loop` / `kolorbot-conversation` / `kolorbot-skills` / `kolorbot-memory` 映射到各自的 `src/index.ts`，改完代码直接重启即可；编译产物用 `npm run web:dist`。
CLI 只有 `run web`，支持 `--host/--port/--help`；调度器与 `run gateway` 已移除。

启动日志的 `model` 行会打印当前模型来源，例如：

```text
model      Mock 提供商 · mock-large @ http://127.0.0.1:3456/v1
model      未配置（请在 Web 的「模型」页添加提供商）      ← 此时聊天会返回 400
```

局域网监听：

```powershell
npm run web -- --host 0.0.0.0
npm run web -- --host 0.0.0.0 --port 8080
```

没有内置默认模型。只有显式给出全部三项时，才会多出一个「环境变量 · 模型」回退项：

```ts
{
  apiUrl: process.env.KOLOR_API_URL ?? '',        // 例如 'https://api.deepseek.com'
  apiModelName: process.env.KOLOR_API_MODEL ?? '', // 例如 'deepseek-chat'
  apiKey: process.env.DEEPSEEK_API_KEY ?? '',
}
```

CLI 优先级高于 `KOLOR_WEB_HOST` / `KOLOR_WEB_PORT`。

## 6. 数据与外部状态

项目代码移动了，但运行数据仍在原位置：

```text
~/.kolor/
├── conversation.db   # topics / segments / messages
├── providers.json    # 模型提供商、当前模型（含明文 API Key，0600）
├── memory.json       # 记忆开关（日记是否自动追加）
├── workspace/        # 内置文件/bash 工具默认工作区（含 AI.md、daily/）
│   └── daily/        # 日记：YYYY-MM-DD.md，一天一个文件
└── mcp.json          # 已废弃并删除，不再使用

~/.agents/skills/     # 兼容技能区（当前 3 个：deepseek-search / email / ppt-master）
~/.kolor/workspace/skills/  # 专属技能区（默认空）
<repo>/inner/skills/  # 内置技能区（browseruse / kolor）
```

- 迁移项目目录**不会**自动迁移这些数据。
- 如果要完整搬家，把 `~/.kolor` 和 `~/.agents/skills` 一起复制到目标机器的对应用户目录。
- 启动 Web 的环境里不再必须有 `DEEPSEEK_API_KEY`：只要在 UI 里配好提供商就能聊天；但 deepseek-search 技能的 `${DEEPSEEK_API_KEY}` 仍从进程环境变量读，不读 `providers.json`。
- `providers.json` 是模型配置的唯一来源；删掉它等于清空所有提供商（聊天会提示未配置模型）。
- 日记在 `workspace/daily/`，设定在 `workspace/AI.md`，都是普通 Markdown，可以直接编辑/备份；`KOLOR_FRAME_ROOT` 改了，两者目录跟着走。

## 7. HTTP API 概览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/config` | 配置 + 当前模型（`activeModel` / `hasModel`）+ MCP 列表 + 状态 |
| GET/POST | `/api/providers` | 提供商列表（key 脱敏）/ 添加并识别模型 |
| DELETE | `/api/providers/:id` | 删除提供商 |
| POST | `/api/providers/:id/models` | 重新识别该提供商的模型 |
| PUT | `/api/model` | 切换当前模型（`providerId: ''` 表示回退到环境变量） |
| GET | `/api/conversation` | 单对话的 topics / segments / messages + 当前话题 |
| GET/PUT | `/api/memory` | 记忆设置（日记开关）+ 今日日记 / 切换开关 |
| GET | `/api/sessions/:id/run` | 运行中/刚结束的 turn 状态 + 缓冲事件 |
| GET | `/api/sessions/:id/stream?from=N` | SSE 回放 + 实时事件 |
| POST | `/api/sessions/:id/reset` | 重置上下文；运行中的 turn 丢弃 |
| GET | `/api/sessions/:id/export` | 导出 JSON |
| POST | `/api/sessions/import` | 导入会话 |
| GET | `/api/skills` | 三区技能列表（`source`）+ 签名 + `roots` + 每个技能的 `mcpServers` |
| GET | `/api/skills/:id` | 技能详情（SKILL.md + 文件列表 + `mcpServers`） |
| GET | /api/mcp | skill 声明的 MCP（只读；UI 已不单独使用） |
| POST | /api/mcp/:name/restart | 关闭指定的 MCP 服务器并重新连接（技能详情「刷新」按钮） |
| POST | `/api/chat` | SSE 聊天流（turn 在 broker 里跑；同会话重复请求 409） |
| POST | `/api/chat/cancel` | 取消当前轮次 |

UI 不再提供会话列表 / 导入 / 导出 / 改名 / 重置入口；`/api/sessions/:id/*` 只剩 `main` 这一个兼容 ID 供运行状态/SSE 使用。

## 8. 测试与当前状态

最近一次（0.4.0 单对话 + 话题）结果：

```text
pnpm build  ✅
pnpm test   ✅ 109/109
  kolorbot-agent-loop 53
  kolorbot-conversation 4
  kolorbot-skills     14
  kolorbot-memory     10
  kolorbot-web        28
```

Web 端到端覆盖：单对话 API、话题判定与切换、`<system-memory>`（AI.md + topic 文件 + 日记片段）、`<system-last-message>`、同一话题不重复注入、工具调用落库、`/api/memory`、闲置日记整理（新格式 + 话题文件）；提供商测试覆盖存储、模型发现、切换模型。

## 9. 已知限制 / 可以继续做的事

- 话题判定每条消息一次额外模型请求；分类失败默认继续当前话题。
- 切回旧话题不会恢复该话题上次的消息上下文，只靠话题文件和日记片段。
- 话题不允许别名/合并；分类器猜错时只能靠后续消息纠正。
- 没有多用户、鉴权、HTTPS、权限隔离。
- `bash` 不沙箱，文件工具不防符号链接穿越。
- 定时任务功能已移除（代码、API、UI 和测试）。
- `KolorFrame` 的 MCP 版本已经删除；如果外部客户端还需要 MCP，可以单独恢复，但会与本地工具重名。
- 包名已经是 `kolorbot-*`；`~/.kolor`、`KOLOR_*` 和 `kolor.json` 仍保留旧名，是有意为之。
- **模型选择是全局的**：切换后下一轮立即生效；进行中的 turn 不受影响。
- 提供商只有一套 key，没有自定义请求头（`Authorization` 固定为 `Bearer`）、没有 Azure 那种 `api-version` 查询参数、没有代理设置；需要时在 `ProviderStore` 里扩字段。
- 模型列表只在添加/手动刷新时拉取；提供商上新模型后要再点一次「刷新」。
- 没有对模型能力做区分（是否支持 tools / 流式）；不支持的模型会由上游返回错误，错误会经 SSE 显示。
- 记忆按话题注入：AI.md + 话题文件 + 该话题最新日记片段（超过 1 MiB 截断）；没有事实库、用户画像、向量检索。
- 话题文件的创建/更新由 `write_topic` 完成；`write_diary` 发现缺失时会要求模型补写。
- 自动整理依赖模型按提示词用 `write_file` 写日记；没写时只会写日志，不会服务端兜底生成日记。
- 10 分钟是写死的默认值（`KolorWebOptions.diaryIdleMs` 可改，测试就是靠它）；没有 UI 配置项。
- 日记轮次会占用对话，期间用户发消息会收到 409「正在运行」。

## 10. 新对话怎么开始

把下面这段直接贴到新对话：

```text
项目在 D:\code\kolorbot。请先读 D:\code\kolorbot\HANDOFF.md 和 README.md，
了解现有架构和已完成的改动；包名是 kolorbot-*，不要改回 kolor-*；
~/.kolor 数据目录、KOLOR_* 环境变量、kolor.json 和内置技能 kolor 保留旧名。

基线检查：
cd D:\code\kolorbot
pnpm install
pnpm test

当前状态：160 个测试全部通过，CLI 是 run web|scheduler|gateway；
run web 只启动 Web（任务面板显示不可用），run scheduler 只启动定时任务，run gateway 同时启动两者；
模型只来自「模型」页的提供商（OpenAI Chat Completions 协议），没有内置默认模型；
只有显式设置 KOLOR_API_URL + KOLOR_API_MODEL + key 才会出现「环境变量」回退项；
「记忆」页的日记开关可让对话静默 10 分钟后自动追加日记，发 /update-daily-memory 可立即整理；
日记格式是 # 日期 → ## 话题（首次出现顺序）→ ### 时间；每个话题第一次写入时创建/更新 workspace/topic/<slug>.md；
一轮对话在服务端 RunBroker 里跑，断开页面会回放；只有离底部一行以内才自动跟随滚动；
每条用户消息先判定话题，切换话题会新开上下文并注入话题记忆和上一话题最后 10 条；定时任务已移除；
代码已推送到 GitHub：https://github.com/zhaopingxiao/KolorBot.git。
```

如果新对话的默认工作目录不是项目目录，优先用绝对路径；这个项目的 pnpm workspace 必须在 `D:\code\kolorbot` 根目录执行命令。

## 11. 重要文件

| 文件 | 作用 |
| --- | --- |
| `packages/kolorbot-agent-loop/src/agent.ts` | `KolorAgent` 主循环、本地工具注册、MCP 连接 |
| `packages/kolorbot-agent-loop/src/config.ts` | 模型配置、系统提示词（KolorBot） |
| `packages/kolorbot-sessions/src/store.ts` | 会话/主题/任务 SQLite |
| `packages/kolorbot-sessions/src/schedule.ts` | 调度规则（多时间节点 `times`/`days`/`minutes`）、`nextRunAt`、`describeSchedule` |
| `packages/kolorbot-skills/src/skills.ts` | 技能发现、签名、`<system-skills>` |
| `packages/kolorbot-skills/src/mcp.ts` | `kolor.json` MCP 解析、`${VAR}` 展开 |
| `packages/kolorbot-agent-loop/src/tools.ts` | 文件/bash/skills/read_image 工具实现 |
| `packages/kolorbot-web/src/providers.ts` | 提供商存储（`providers.json`）、`/models` 发现、active 模型解析 |
| `packages/kolorbot-web/src/memory.ts` | 记忆设置（`memory.json`）、日记读写/签名、日记提示词 |
| `packages/kolorbot-web/src/diary-idle.ts` | 「对话静默 N 分钟」计时器 |
| `packages/kolorbot-web/src/server.ts` | HTTP、SSE、API、broker 接线、调度器/日记、注入 |
| `packages/kolorbot-web/src/runs.ts` | `RunBroker`：turn 生命周期、事件缓冲/回放、取消原因 |
| `packages/kolorbot-web/src/http.ts` | JSON/SSE 响应、`sendJsonText`（回放不重复序列化） |
| `packages/kolorbot-web/src/agent-pool.ts` | 每会话 agent、模型指纹重建、提醒/日记工具、MCP 签名重连 |
| `packages/kolorbot-web/src/reminder-tool.ts` | `schedule_reminder` |
| `packages/kolorbot-web/src/cli.ts` | `--host` / `--port` 参数 |
| `restart.cmd` + `scripts/restart.ps1` | 启停脚本：stop / start / status / restart，日志 `logs/kolorbot-web.log` |
| `packages/kolorbot-web/public/index.html` | UI 结构（模型 / 记忆对话框、输入框上方模型下拉框） |
| `packages/kolorbot-web/public/styles.css` | 白色主题 + 思考三点 + 移动端抽屉 + 提供商 / 记忆样式 |
| `packages/kolorbot-web/public/app.js` | UI 状态、turn 镜像/重连、跟随滚动、Markdown 渲染、思考指示、工具卡片、抽屉、提供商页、记忆页 |
| `tsconfig.dev.json` | tsx 的 paths（`npm run web` 直接跑源码不 build） |
| inner/skills/browseruse/ | 内置无头浏览器技能（`server.mjs` MCP + 实时画面 + WebMCP；`smoke.mjs` 自测） |
| `docs/` | 当前 UI 截图 |
