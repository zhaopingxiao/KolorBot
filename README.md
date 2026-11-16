# KolorBot

<img src="packages/kolorbot-web/public/logo.png" width="76" alt="KolorBot logo" />

KolorBot 是一个 Node.js 智能体（agent）运行时，带本地 Web 聊天界面。**整个应用只有一条对话**，这条对话会按「话题」自动分段：切换话题时插入分割线、切换上下文，并注入该话题的记忆。

当前版本：**0.4.0**（2026-11-14）。

> 新对话 / 交接请先读 [HANDOFF.md](HANDOFF.md)：包含项目结构、已完成改动、关键约束和运行方式。

模型不再写死成 DeepSeek，也没有内置默认模型：在 Web UI 左下角的「模型」页填入任意 OpenAI Chat Completions 兼容提供商的接口地址和 API Key，会自动识别该提供商的全部模型，然后在输入框上方的下拉框里选择使用。没有配置提供商时聊天会提示「没有可用模型」。

- **`kolorbot-agent-loop`** — 主循环 + 内置 KolorFrame 工具：调用模型 → 执行工具 → 把结果写回会话 → 再调用模型，直到模型给出最终答复。文件/目录/bash/技能/read_image 工具都在这个包里，可独立作为库使用。
- **`kolorbot-conversation`** — 单对话存储：SQLite 里的 topics / segments / messages；切换话题会新建 segment，模型上下文只取当前 segment。
- **`kolorbot-skills`** — 技能发现：读取三个技能区的 Claude 标准 `SKILL.md`，生成 `<system-skills>` 列表。
- **`kolorbot-memory`** — 记忆：AI.md 设定、话题文件、日记解析、`<system-memory>` / `<system-last-message>` 注入块。
- **`kolorbot-web`** — Web UI + HTTP API：聊天、话题判定、模型提供商、技能/MCP、记忆和日记。

**话题规则**：每条用户消息都会先经过一次轻量话题判定（continue / switch / new）。切换话题时 UI 插入话题分割线，模型上下文从空开始，并在第一条消息里注入：

- `<system-memory>`：AI.md + `workspace/topic/<slug>.md` + 该话题最新的日记片段；
- `<system-last-message>`：上一个话题最后 10 条 user/assistant 文本。

同一话题后续消息不重复注入，只有 AI.md 变更时才重新发送。定时任务功能已暂时移除。

只要传入 `apiUrl`、`apiModelName`、`apiKey` 就能跑；工具既可以在进程内注册，也可以来自任意 MCP 服务器。KolorFrame 的本地工具由 agent-loop 默认注册，所以不配置 MCP 时 AI 也有文件/bash/技能能力。

## 目录

```
kolorbot/
├── package.json                 # pnpm workspace 根
├── HANDOFF.md                   # 交接文档（项目是什么 / 做过什么 / 怎么继续）
├── docs/web-ui.png              # 聊天截图
├── docs/models.png              # 模型提供商截图
├── docs/memory.png              # 记忆（设定 + 日记）截图
├── docs/skills.png              # 技能面板（含 MCP 标识与详情）
├── docs/tool-call.png           # 工具调用详情截图
├── docs/mobile.png              # 移动端抽屉截图
├── inner/skills/browseruse/     # 内置技能：带 MCP 的无头浏览器（实时画面 + WebMCP）
├── packages/
│   ├── kolorbot-agent-loop/     # 主循环 + src/frame/（KolorFrame 工具）
│   ├── kolorbot-conversation/   # topics / segments / messages（单对话）
│   ├── kolorbot-skills/         # 技能发现 / <system-skills>
│   ├── kolorbot-memory/         # AI.md + 话题文件 + 日记 + 注入块
│   └── kolorbot-web/            # Web 服务 + public/ 静态页面 + 话题判定
│       ├── src/topic-classifier.ts  # 每条消息的话题判定
│       ├── src/providers.ts     # 提供商存储（~/.kolor/providers.json）+ 模型发现
│       ├── src/runs.ts          # RunBroker：turn 生命周期 + 事件回放
│       └── public/              # index.html / app.js / styles.css
├── restart.cmd                  # 启停脚本入口（scripts/restart.ps1）
├── pnpm-workspace.yaml / pnpm-lock.yaml
├── tsconfig.base.json / tsconfig.dev.json
├── LICENSE                      # MIT
└── .gitignore
```

## 快速开始

要求 Node.js >= 22.5（会话用 `node:sqlite`）。

```bash
pnpm install
pnpm build
pnpm test      # 110 个测试
pnpm demo      # 完全离线：本地假模型 + 本地工具
```

启动 Web：

```powershell
npm run web
# 或
node packages/kolorbot-web/dist/src/bin.js run web --port 3399
```

`npm run web` 用 `tsx` 直接跑源码（`tsconfig.dev.json` 把 `kolorbot-*` 包映射到各自 `src/`），**不需要先 build**；编译产物用 `npm run web:dist`。

想后台跑并方便重启，用仓库根目录的脚本（默认 `100.87.104.6:3399`，日志 `logs/kolorbot-web.log`）：

```powershell
.\restart.cmd                    # 停掉旧实例并后台拉起 Web
.\restart.cmd status             # 端口 / PID / 模型
.\restart.cmd stop               # 只停
.\restart.cmd start -Foreground  # 前台跑，方便看报错
```

默认只监听 `127.0.0.1`。需要让局域网访问时用 `--host`：

```powershell
npm run web -- --host 0.0.0.0
# 或者：npm run web -- --host 0.0.0.0 --port 8080
```

也可以设置 `KOLOR_WEB_HOST=0.0.0.0`，命令行参数优先。`0.0.0.0` 会监听所有网卡；Web UI 没有鉴权，只建议在可信局域网使用。

打开 <http://127.0.0.1:3399>，在「模型」页添加一个提供商即可开始对话。启动日志里的 `model` 一行会显示当前用的提供商 / 模型；没配时显示「未配置」。

如果你更习惯用环境变量（例如 CI、容器），可以显式给出全部三项，它们会作为「环境变量 · 模型」出现在下拉框里：

```ts
{
  apiUrl: process.env.KOLOR_API_URL ?? '',      // 例如 'https://api.deepseek.com'
  apiModelName: process.env.KOLOR_API_MODEL ?? '', // 例如 'deepseek-chat'
  apiKey: process.env.DEEPSEEK_API_KEY ?? '',
}
```

三个都设置才会生效；只设置 key 不会产生任何默认模型。

### Web UI 能做什么

![KolorBot Web UI](docs/web-ui.png)

界面是白色极简风（纯白背景 + 浅灰层级），只保留对话需要的元素；模型思考时在回复位置显示三个跳动的点，出字后自动消失；操作结果用会自动消失的 toast 提示。

![工具调用](docs/tool-call.png)

移动端顶部左侧的三条杠打开侧栏菜单（品牌 + 技能/模型/记忆）。

![移动端](docs/mobile.png)

- **单对话**：整个产品只有一条对话，没有新建会话、会话列表或搜索；所有历史在 `~/.kolor/conversation.db`。
- **话题页**：对话标题左边的话题图标进入；点进话题先看到 Markdown 渲染的 `workspace/topic/<slug>.md` 话题记忆，下面是**对话里出现过**的所有月份日历，紫色日期可点开当天的话题聊天记录和日记片段；有对话但没日记的那天可以直接点「整理这天的日记」。
- **话题分段**：每条用户消息先判定话题；切换时插入话题分割线并换新上下文。详见 [单对话、话题与日记](#单对话话题与日记)。
- 模型：侧栏底部 agent 卡片的「⋯」→「模型」管理提供商（OpenAI Chat Completions 协议），自动识别该提供商的全部模型；输入框上方的下拉框随时切换当前模型。
- 设定：侧栏底部 agent 卡片的「⋯」→「设定」管理 AI.md，可用 `/self-md-update` / `/self-md-tell …` 创建或更新；页面不再显示日记项。
- 输入框输入 `/` 会弹出指令补全（`/self-md-update`、`/self-md-tell`、`/update-daily-memory`），点击自动填充。
- 技能：侧栏「技能」查看三个技能区的 Claude 标准技能；每个话题的第一条消息会带 `<system-skills>`，AI 用 `skills(id)` 工具读详情。
- 技能里的 MCP：有 MCP 的技能在列表里带一个 **MCP** 标识，点开技能详情就能看到它通过 `kolor.json` 声明的所有 MCP 服务器（名称 + transport）；**每个服务器旁边有「刷新」按钮，点击会关闭该 MCP 服务器并重新连接**。
- 聊天：流式输出、工具调用卡片（**默认折叠**，点开看参数 / 结果 / 状态）、停止按钮、思考时的三个点。运行中继续输入并按 Enter 会先排队，等这一轮结束后自动发出。每次工具调用前后的文字各自成段；AI 回复**边出边渲染 Markdown**。
- 断线不丢回答：一轮对话在服务端跑，关闭标签页、刷新、切网都只是断开镜像；回来时从服务端缓冲回放整轮。同一时间只允许一轮，重复发送返回 409。
- 跟随滚动：只有离消息列表底部**一行字以内**时才自动拉到底；往上翻读历史时不会被拽走。
- 内置工具：`read_file` / `write_file` / `list_files` / `bash` / `skills` / `read_image` 由 agent-loop 直接注册；话题日记另有 `list_topics` / `read_diary` / `write_diary` / `write_topic`。额外 MCP 只能写在技能目录的 `kolor.json` 里。

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` / `KOLOR_API_KEY` | 空 | ① 给 `kolor.json` 里的 `${DEEPSEEK_API_KEY}` 占位符用（搜索技能）；② 显式环境变量回退的一部分 |
| `KOLOR_API_URL` | 空 | 显式环境变量回退的 endpoint；不设就没有任何默认模型 |
| `KOLOR_API_MODEL` | 空 | 显式环境变量回退的模型名；不设就没有任何默认模型 |
| `KOLOR_WEB_HOST` / `KOLOR_WEB_PORT` | `127.0.0.1` / `3399` | 监听地址与端口 |
| `KOLOR_HOME` | `~/.kolor` | 数据目录（`conversation.db`、`providers.json`、`memory.json`、`workspace/`） |
| `KOLOR_CONVERSATION_DB` | `<home>/conversation.db` | 单对话 / 话题数据库 |
| `KOLOR_FRAME_ROOT` | `<home>/workspace` | 内置文件/bash 工具的工作区根 |
| `KOLOR_SKILLS_DIR` | `~/.agents/skills` | 兼容技能区（Claude 标准） |
| `KOLOR_USER_SKILLS_DIR` | `<frameRoot>/skills` | 专属技能区（默认 `~/.kolor/workspace/skills`） |
| `KOLOR_BUILTIN_SKILLS_DIR` | `<repo>/inner/skills` | 内置技能区 |
| `BROWSERUSE_VIEW_PORT` | `9223` | browseruse 技能实时画面的端口（经 `kolor.json` 的 `${VAR}` 注入技能进程） |
| `BROWSERUSE_HEADLESS` | `true` | browseruse 技能用 `false` 时显示真实浏览器窗口 |

> `KOLOR_API_URL`、`KOLOR_API_MODEL`、`DEEPSEEK_API_KEY` **三个都设置**时，才会出现「环境变量 · 模型」这个回退项；只设置 key 不会自动补 deepseek 端点。

> Web 服务没有鉴权，默认只监听 `127.0.0.1`，不要暴露到公网。

### 如何运行 TypeScript

项目是 TypeScript 源码 + `tsc` 编译到 `dist/`，三种跑法：

| 方式 | 命令 | 适用场景 |
| --- | --- | --- |
| 编译后运行 | `pnpm build && node dist/your-script.js` | 自己的入口脚本，走 `tsc`；`npm run web:dist` 也是这条 |
| Node 原生类型剥离 | `node your-script.ts` | Node ≥ 22.18 / 24；只支持可擦除语法，不能有 `enum`、`namespace`、参数属性 |
| tsx 直接跑源码（`npm run web` 用的） | `tsx --tsconfig tsconfig.dev.json packages/kolorbot-web/src/bin.ts run web` | 不改 `dist`、调试包的 TS 源码；`tsconfig.dev.json` 的 `paths` 把 `kolor-*` 映射到各自 `src/index.ts` |

**不能**直接用 `node packages/kolorbot-web/src/bin.ts`：源码用 NodeNext 约定（`import './agent.js'`），Node 原生剥离不会把 `.js` 映射回 `.ts`；走 `tsc` 或 `tsx`。

Node 24.13 在 Windows 上有个小 bug：`fetch` 之后若有未捕获异常退出，可能打印 `Assertion failed: ... uv_handle_closing`。把调用包进 `try/catch` 即可。

## 作为库使用

```ts
import { KolorAgent, defineTool } from 'kolorbot-agent-loop';

const agent = await KolorAgent.create({
  apiUrl: 'https://api.deepseek.com',
  apiModelName: 'deepseek-chat',
  apiKey: process.env.DEEPSEEK_API_KEY!,
});

for await (const event of agent.stream('列出当前目录并总结')) {
  if (event.type === 'text/delta') process.stdout.write(event.text);
  if (event.type === 'tool/result') console.log(`\n[tool] ${event.name} → ${event.content}`);
}
```

### 上下文导入 / 导出

```ts
// 从任意来源导入（会校验 tool call 配对）
agent.importContext(JSON.parse(fs.readFileSync('session.json', 'utf8')).context);

// 导出，可交给 kolorbot-conversation 落库
const context = agent.exportContext();
```

`KolorAgent.create(config, { context })` 也可以在创建时直接带入上下文。

### 自定义工具

```ts
const writeFile = defineTool({
  name: 'write_file',
  description: 'Write text to a file',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, text: { type: 'string' } },
    required: ['path', 'text'],
  },
  concurrency: 'exclusive', // 独占：与同一步的其他调用形成屏障
  execute: async (input, context) => ({ content: `wrote ${input.path}` }),
});
```

- `execute` 可以直接返回字符串；`isError: true` 让模型看到失败但不会中断本轮；`concludeTurn: true` 在该结果提交后结束本轮。
- 工具抛异常、参数不是合法 JSON、未知工具、超时，都会变成 `isError` 结果写回会话。
- 工具拿到 `context.signal`，超时/取消会中止；即使工具无视信号，调度器也会用硬超时竞速。

## kolorbot-agent-loop 配置

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `apiUrl` | 必填 | Base URL；`.../v1`、`.../chat/completions` 都接受 |
| `apiModelName` | 必填 | 请求体里的 `model` |
| `apiKey` | 必填 | Bearer token，不会进日志或工具结果 |
| `systemPrompt` | 内置 | 传 `''` 关闭 system message |
| `maxSteps` | `80` | 单轮最多几次模型调用 |
| `maxParallelToolCalls` | `10` | 单步内并行工具上限 |
| `toolTimeoutMs` | `120000` | 单个工具默认超时（bash 单独放宽到 10 分钟） |
| `requestTimeoutMs` | `300000` | 单次模型请求超时 |
| `maxToolResultChars` | `100000` | 工具输出截断阈值 |
| `mcpServers` | `[]` | MCP 服务器列表 |
| `mcpDefaultConcurrency` | `parallel` | MCP 工具默认并发模式 |
| `mcpConnectTimeoutMs` | `20000` | MCP 握手 / `tools/list` 超时 |
| `agentId` | `kolor-agent` | 事件与工具上下文中的 agent 标识 |

## MCP 与内置工具

MCP 三种传输都支持：

```ts
mcpServers: [
  { name: 'fs', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] },
  { name: 'remote', transport: 'http', url: 'https://example.com/mcp', headers: { authorization: 'Bearer …' } },
  { name: 'legacy', transport: 'sse', url: 'https://example.com/sse' },
]
```

工具名会变成 `mcp__<server>__<tool>`（例如 `calc` → `mcp__calc__add`）。单个服务器连不上不会让 agent 启动失败：`agent.mcpServers` 记录 `ok: false` 和原因，同时发出 `mcp/error` 事件。

KolorFrame 不是 MCP，也不额外启动进程：`KolorAgent` 默认把 `read_file`、`write_file`、`list_files`、`bash`、`skills` 注册成本地工具，工作区由 `kolorFrame.root` 指定（Web 默认 `~/.kolor/workspace`）。传 `kolorFrame: false` 可以关闭。

### 在 skill 里声明 MCP

Web 不再维护单独的 `mcp.json`。额外 MCP 写在技能目录的 `kolor.json`：

```md
~/.agents/skills/github/
├── SKILL.md
└── kolor.json
```

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "..." }
    },
    "browser": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}
```

- `mcpServers` 是标准写法，也接受 `mcp` 作为别名。
- `kolor.json` 可以放在单个技能目录；也可以放在 `~/.agents/skills/kolor.json` 作为全局配置。根配置优先，然后按技能 id 排序。
- `stdio` 需要 `command`，默认 `cwd` 是技能目录；相对 `command` / `cwd` 按技能目录解析。
- `env` / `headers` 的值支持 `${VAR}` 占位符，从启动 `kolorbot-web` 的进程环境读取；适合注入 API key。`/api/mcp` 只返回名称、来源技能和传输方式，不会把 env/headers 回传给浏览器。
- `http` / `sse` 需要 `url`。
- 同名 server 先到先得，避免两个技能互相覆盖工具。
- Web 不再有单独的 MCP 页面：在侧栏「技能」里，带 MCP 的技能旁边有 **MCP** 标识，点开技能详情就能看到它声明的所有 server；改完文件后下一轮对话自动重连。

KolorFrame 提供：

| 工具 | 说明 |
| --- | --- |
| `read_file` | 按行读 UTF-8 文本 |
| `read_image` | 读本地图片（PNG/JPEG/GIF/WebP/BMP），返回格式/尺寸；**支持视觉的模型会真正收到图片**（非视觉模型只拿到元数据，服务端自动降级） |
| `write_file` | 写/追加，自动建目录 |
| `list_files` | 递归列目录 |
| `bash` | 在工作区执行 shell 命令 |
| `skills` | 读取 `~/.agents/skills/<id>/SKILL.md` 和文件列表 |

文件工具只能在 `KOLOR_FRAME_ROOT` 内活动（`read_image` 也可以读三个技能区，方便看截图）；`bash` 不沙箱（本地可信环境使用）。

## 模型提供商

![模型](docs/models.png)

侧栏左下角的「模型」页管理模型提供商。一个提供商就是一组 **接口地址 + API Key**，走 OpenAI Chat Completions 协议（DeepSeek、OpenAI、OpenRouter、vLLM、Ollama 的 `/v1` 等都适用）。

添加流程：

1. 填名称（可留空，默认用域名）、接口地址（如 `https://api.openai.com/v1`）、API Key（本地服务可留空）。
2. 点「添加并识别模型」：服务端请求 `GET <base>/models`，把返回的模型全部存下来；基于 `/v1` 的网关会先试 `<base>/models`，再试 `<base>/v1/models`。
3. 输入框上方的下拉框里出现 `提供商 · 模型`，选中即生效。第一个提供商添加后会自动选中它的第一个模型。

其它行为：

- 「刷新」重新识别模型列表；「删除」移除提供商。
- 没有 `/models` 接口的网关可以手动填模型名（逗号分隔），此时跳过识别。
- 识别失败会直接报错（例如 `返回 401 Unauthorized`），不会保存一个没有模型的提供商。
- 删除当前提供商、或在下拉框里选「环境变量」时，回退到显式配置的 `KOLOR_API_URL` + `KOLOR_API_MODEL` + key。**没有内置默认**：这三项没配全就没有可选项，聊天会提示添加提供商。
- 模型选择是全局的：切换后所有会话的下一轮都用新模型，进行中的轮次不受影响。切换模型会在该会话重建 agent（MCP 会重连）。

存储位置是 `~/.kolor/providers.json`，和 `conversation.db` 同级：

```json
{
  "version": 1,
  "active": { "providerId": "p_1a2b3c4d5e6f", "model": "gpt-4o-mini" },
  "providers": [
    {
      "id": "p_1a2b3c4d5e6f",
      "name": "OpenAI",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-...",
      "models": ["gpt-4o", "gpt-4o-mini"],
      "createdAt": "2026-11-01T09:00:00.000Z",
      "updatedAt": "2026-11-01T09:00:00.000Z"
    }
  ]
}
```

- **API Key 只存在这个文件里**（POSIX 上写 `0600`），接口只回传 `hasKey` 和 `••••最后四位`，永远不回传明文；会话数据库里也不会写 key。
- 接口地址会做归一化：粘贴 `.../chat/completions` 或 `.../models` 会去掉后缀，只保留根地址。
- 这是本机可信环境的单用户工具：`providers.json` 是明文的，不要把它放进公开仓库。
- 技能 `kolor.json` 里的 `${DEEPSEEK_API_KEY}` 仍然从**进程环境变量**读取，不会自动使用提供商里的 key。

## 记忆：设定、话题与日记

![记忆](docs/memory.png)

agent 卡片的「⋯」→「设定」页面只显示 AI.md。记忆不再按「当天全部日记」注入，而是按当前话题注入：

```text
<system-memory>
## AI self (AI.md)

（AI.md 内容）

## Topic: 工作区 Remotion 环境

（workspace/topic/remotion.md 的内容）

## Latest diary (2026-11-14)

（今天日记里 ## 工作区 Remotion 环境 这一节；今天没有就往前找，实在没有用最早一次）
</system-memory>
```

注入规则：

- 新话题第一条必发；
- 同一话题内只有 **AI.md 变化**才重发；话题文件或日记变化不会重发；
- 话题文件不存在时省略该段；AI.md 超过 1 MiB 会截断并标记。

### 设定（AI.md）

- 文件：`<workspace>/AI.md`，默认 `~/.kolor/workspace/AI.md`。固定头部格式：

```markdown
# 名字
## head-image
> 头像路径
```

`#` 后是名字，`## head-image` 下一行的 `>` 后是头像路径（相对 workspace 或绝对路径）。
- 只存：AI 的名字、性格、对自身的了解；可选：自己形象图片的本地路径、AI 认为自己形象是什么样。**超过 1 MiB 必须删减**。
- 更新命令：
  - `/self-md-update`：让 AI 以当前对话为信息创建/更新 AI.md；
  - `/self-md-tell 你是一个温柔的 AI…`：按命令后面的信息更新（没写内容会被拒绝）。
  两者都只发一条包含 AI.md 保存规则的消息，直接要求模型用 `write_file` 写 `workspace/AI.md`。

### 日记

开关「定时追加日记」打开后：

1. 一轮对话结束后开始计时；10 分钟内没有新消息就整理一次日记（无 SSE 的后台轮次）。
2. 整理时会把**上次日记之后的所有话题片段**按话题分组，每个有未整理片段的话题依次跑一轮，模型通过 `write_diary` 写当前话题日记，用 `write_topic` 维护 `topic/<slug>.md`。
3. 日记格式是 `# 日期 → ## 话题（首次出现顺序）→ ### HH:mm`；`##` 话题名必须与话题的 `name` 完全一致（不做后缀或 slug 兼容），每个话题当天只保留一个 `##` 块。
4. 每个话题第一次写进日记时，同时创建/更新 `workspace/topic/<slug>.md`；之后关键信息变化由 AI 用 `write_file` 主动更新。
5. 没有新内容时模型应回复 `No new content.`；如果什么都没写，服务端会记一条日志。

### 日记工具

- `list_topics`：列出所有话题 slug / name，当前话题标 `(current)`。
- `read_diary({ slug, date? })`：不带 `date` 返回有哪些天写过这个话题；带 `date` 返回当天该话题的 `##` 段落。
- `write_diary({ content, date? })`：写**当前话题**，不需要 slug。在当前本地时间（或指定日期）追加内容，自动创建当天文件、`## 话题` 和 `### HH:mm`，并保持话题首次出现顺序。
- `write_topic({ content })`：创建或替换**当前话题**的记忆文件 `workspace/topic/<slug>.md`；`write_diary` 发现话题记忆缺失时会提示模型调用它。

`write_diary` / `write_topic` 只在一轮日记任务里启用；普通聊天中调用会返回错误，模型也不应再用 `write_file` 改 `daily/*.md` 或 `topic/*.md`。

也可以发送 `/update-daily-memory` 立即整理。

要点：

- 开关状态存在 `~/.kolor/memory.json`（`{ "version": 1, "diary": { "autoAppend": true } }`）。
- 计时只在 Web 进程存活时有效，重启后从下一轮对话重新开始；日记轮次不会触发自己。
- 日记是普通 Markdown，可以自己编辑、用 Git 管理或同步。

## 单对话、话题与日记

### 存储

`~/.kolor/conversation.db`（`KOLOR_CONVERSATION_DB` 可覆盖）里有三张表：

```sql
topics          (slug, name, created_at, updated_at)
segments        (id, topic_slug, started_at, ended_at, memory_signature, diary_at)
messages        (id, segment_id, topic_slug, role, data_json, created_at)
```

整个应用只有一条对话；`segments` 是一次「话题访问」。切换话题（包括切回旧话题）会新建 segment，模型上下文只包含当前 segment 的消息。旧的多会话数据已归档到 `D:\deepseek_harness_workspace\backup\kolorbot-memory-2026-11-14`。

### 每条消息的话题判定

用户发出消息后，Web 用一次轻量模型调用判断：

```json
{"action":"continue"}
{"action":"switch","slug":"remotion"}
{"action":"new","name":"工作区 Remotion 环境","slug":"remotion"}
```

- 语义未变 → `continue`，继续当前 segment；
- 命中已有话题 → `switch`，复用原 slug / name；
- 新内容 → `new`，生成短名字和 ascii slug；
- 分类失败、超时、JSON 不合法 → 一律 `continue`；
- 话题不允许别名。

### 上下文与注入

切换话题后的第一条消息会带：

```text
<system-memory>
## AI self (AI.md)
...
## Topic: 工作区 Remotion 环境
workspace/topic/remotion.md 的内容
## Latest diary (2026-11-14)
今天（或最近一次）日记里该话题的片段
</system-memory>

<system-last-message>
user: ...
assistant: ...
（上一个话题最后 10 条 user/assistant 文本）
</system-last-message>

（用户原话）
```

- 日记片段查找顺序：今天 → 最近一天 → 该话题最早一次；
- 新 segment 第一条必发 `<system-memory>` 和 `<system-last-message>`；
- 同一 segment 内只有 **AI.md 变化**才重发 `<system-memory>`；话题文件或日记变化不会触发重发；
- `<system-last-message>` 只在新话题的第一条发送，且只算 user/assistant 文本。

### 日记格式

```markdown
# 2026-11-14

## 工作区 Remotion 环境

### 19:21

...

### 21:00

...

## Deepseek Workspace

### 20:37

...
```

- 一级是日期，二级是话题，三级是时间；
- 同一话题当天只有一个 `##` 块，后续条目追加到同一块；
- 话题按**首次出现顺序**排列（方案 A），因此整篇不是严格全局时间顺序；
- 每个话题第一次写入日记时，同时创建/更新 `workspace/topic/<slug>.md`；之后出现关键变化时 AI 用 `write_file` 主动更新，不再依赖专门的记忆工具。

### 话题文件

```markdown
# 工作区 Remotion 环境

- slug: remotion
- created: 2026-11-14T19:21:00+08:00
- updated: 2026-11-14T21:00:00+08:00

## 关键信息

- 项目路径：workspace/remotion-project
- 当前状态：...

## 待办 / 下一步

- ...
```

只放可复用事实、状态、决定和待办，不写流水账。注入时如果文件不存在就跳过该段。

## Skills（技能）

![技能面板](docs/skills.png)

技能放在 `~/.agents/skills/<id>/SKILL.md`，遵循 Claude 标准：

```md
---
name: PDF 处理
description: 提取、合并、拆分 PDF，填写表单，扫描件 OCR。
---

# PDF 处理

1. 用 pdftotext 提取文字……
```

注入规则：

- **每个话题的第一条消息**（新 segment）最前面会带一次：

```
<system-skills>
pdf - 提取、合并、拆分 PDF……
review - 按仓库规范审阅 diff……
</system-skills>

（随后是 <system-memory> / <system-last-message>，最后是用户原话）
```

- 同一话题内不重复注入；切换话题会重新注入，因为上下文是新的。
- 列表为空时不注入空标签。
- AI 需要细节时调用内置的 `skills(id)` 工具，拿到完整 `SKILL.md` 和该技能的文件列表（三个区都会查）。

### 技能的三个区

Web 端把技能分成三个区，侧栏「技能」弹窗里也按这三个区分组展示（带数量；空区会显示目录提示）：

| 区 | 目录 | 说明 |
| --- | --- | --- |
| 兼容技能 | `~/.agents/skills`（`KOLOR_SKILLS_DIR` 可覆盖） | Claude 标准的兼容区，原来的安装位置 |
| 专属技能 | `<workspace>/skills`，默认 `~/.kolor/workspace/skills`（`KOLOR_USER_SKILLS_DIR` 可覆盖） | KolorBot 自己的技能区 |
| 内置技能 | 源码里的 `inner/skills`（`KOLOR_BUILTIN_SKILLS_DIR` 可覆盖） | 随源码分发的内置技能，`browseruse` 放在这里 |

- 三个区都按 `<区>/<id>/SKILL.md` 组织；同名技能按 **专属 → 兼容 → 内置** 的优先级取第一个，不会重复注入。
- 三个区的 `kolor.json` 都会被收集；同名 MCP server 同样按这个优先级取第一个。
- 改完技能文件不需要重启：下一轮对话重新读列表（列表指纹变化会触发重新注入和 MCP 重连）。

内置技能 [`inner/skills/browseruse`](inner/skills/browseruse) 是**浏览器操控**技能：通过 MCP 打开系统 Edge 的无头实例，AI 用 `browser_open` / `browser_snapshot` / `browser_click` / `browser_type` / `browser_press` / `browser_evaluate` 操作网页，浏览器画面在本地 `http://127.0.0.1:9223`（`BROWSERUSE_VIEW_PORT` 可改，`BROWSERUSE_HEADLESS=false` 可看真实窗口）以 MJPEG 实时显示。**`browser_snapshot` 把文本快照和截图合并**：除标题/URL/正文/元素序号外，还会把截图存进技能目录并返回 `![page screenshot](http://127.0.0.1:9223/shot/....jpeg)` 和文件路径。**每个操作（打开/点击/输入/按键/执行 JS）都会自动附带一次 snapshot 和新截图**，截图按需展示（用户要截图或需要说明页面时才贴出来）；实时画面地址只在打开新网页后给一次（或用户主动问），文本快照够用时不额外读图。预览页支持鼠标/键盘/滚轮，**按住鼠标可以拖动网页元素**（滑块、画布、拖拽排序），触摸屏上单指上下滑动会滚动网页。还带 `browser_webmcp_list` / `browser_webmcp_call` 调用网页自己注册的 WebMCP 工具（需要 Chrome ≥ 149 开 WebMCP 特性，当前 Edge 157 尚未开放）。**预览页本身可以手动操作**：鼠标点击/双击/右键、按住拖动、滚轮、键盘直接转发到真实浏览器，顶部输入框回车可发送中文文字。依赖只有 `playwright-core`（技能目录内 `npm install`），复用系统 Edge、不用下载浏览器内核。


## Web HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/config` | 配置 + 当前模型 + MCP 列表 + `conversationDbPath` |
| GET | `/api/conversation` | 单对话的 `topics` / `segments` / `messages` + 当前话题 |
| GET | `/api/topics` | 所有话题 + 每个话题有日记的天数 |
| GET | `/api/topics/:slug` | 该话题的对话日期、已有日记日期和按月份分组的日历数据 |
| GET | `/api/topics/:slug/days/:date` | 该话题某天的聊天片段 + 当天话题日记 + `hasDiary` |
| POST | `/api/topics/:slug/days/:date/diary` | 为这一天补写该话题日记（异步 202） |
| GET/POST | `/api/providers` | 提供商列表（key 已脱敏）/ 添加并识别模型 |
| DELETE | `/api/providers/:id` | 删除提供商 |
| POST | `/api/providers/:id/models` | 重新识别该提供商的模型 |
| PUT | `/api/model` | 切换当前模型（`providerId` 传空串表示回到环境变量回退） |
| GET/PUT | `/api/memory` | 记忆：AI.md 内容/大小/名字/头像路径 + 今日日记 + 日记开关 |
| GET | `/api/agent` | Agent 名字、头像路径和 `avatarUrl` |
| GET | `/api/agent/avatar` | 读取 AI.md 指向的本地头像文件 |
| GET | `/api/skills` | 三个技能区的技能列表（`source` 区分区）+ 签名 + `roots` + 每个技能的 `mcpServers` |
| GET | `/api/skills/:id` | 技能详情（SKILL.md + 文件列表 + `mcpServers`） |
| GET | `/api/mcp` | skill 声明的 MCP 列表（只读；信息并入技能详情） |
| POST | `/api/mcp/:name/restart` | 关闭指定的 MCP 服务器并重新连接 |
| POST | `/api/chat` | SSE 事件流，body 只有 `{ text }`；服务端先判定话题，再开始 turn；重复请求 409 |
| POST | `/api/chat/cancel` | 停止当前轮次 |
| GET | `/api/sessions/:id/run` | 兼容端点（`id` 固定 `main`）：当前/刚结束的 turn 状态 + 缓冲事件 |
| GET | `/api/sessions/:id/stream?from=N` | 兼容端点（`id` 固定 `main`）：SSE 回放 + 实时事件 |
| POST | `/api/sessions/:id/reset` | 清空当前对话的消息（话题与记忆文件保留） |

## 架构：从 dsh-agent-loop 抄了什么

| 这里 | dsh-agent-loop 对应物 | 做法 |
| --- | --- | --- |
| `SessionLog` | session 日志 + `deriveMessages()` | 追加式日志，请求全部从日志派生 |
| `ToolRegistry` | `ctx.tools` | 工具定义 + 执行模式 + 模型 schema |
| `tools/scheduler.ts` | `tool-calls.ts` | 有界并行池、独占屏障、按模型顺序提交、取消补 skipped 结果 |
| `KolorAgent` turn/step | `ReactLoopAgent` | `step/start`/`step/end` 配对、轮次级 `AbortController` |
| 上下文校验 | 会话恢复契约 | 导入时验证 tool call 配对，坏历史不发给模型 |
| MCP 命名空间 | DSH 工具命名约定 | `mcp__server__tool`，非法字符规范化 |

明确未实现：持久化写句柄与崩溃恢复、steering/followup 队列、上下文压缩、自动重试、MCP resources/prompts/sampling、子代理。

## 测试

```bash
pnpm test
```

共 110 个测试：

- `kolorbot-agent-loop`（53）：SSE 分片、流式工具调用拼装、并行/独占调度、取消、超时、上下文导入校验、真实 HTTP 假模型端到端；KolorFrame 的读写、目录、bash、skills、`read_image`。
- `kolorbot-conversation`（4）：话题复用、segment 切换、消息持久化、最后 10 条文本、未知话题拒绝。
- `kolorbot-skills`（14）：frontmatter 解析、列表、描述回退、签名变化、详情与文件列表、`kolor.json` MCP 解析、缺失目录。
- `kolorbot-memory`（11）：`<system-memory>` / `<system-last-message>`、话题文件、日记片段查找（今天→最近→最早）、1 MiB 截断、`/self-md-*` 命令、话题日记触发文案。
- `kolorbot-web`（28）：静态页/配置/单对话 API、话题判定与切换、话题记忆与上一话题最后 10 条注入、同一话题不重复注入、工具调用落库、`/api/memory`、日记闲置整理（write_diary + 话题文件）、日记工具（list/read/write）、话题日历/当天片段 API、CLI 子命令、提供商存储与模型切换。

全部测试不需要网络和 API key。

## License

[MIT](LICENSE)
