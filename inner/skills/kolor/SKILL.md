---
name: Kolor
description: KolorBot 框架自身的使用说明：三个技能目录与优先级、如何制作 skill、skill 里的 MCP 配置与制作方法、设定（AI.md 的用途、1 MiB 限制、/self-md-update 与 /self-md-tell 命令）、日记（存放位置、文件格式、整理规则、怎么写）、会话/提供商/HTTP API 速查。用户问「KolorBot 自己怎么用/怎么扩展/技能放哪/日记怎么工作」时读这个技能，不要凭记忆猜。
---

# Kolor

这是 KolorBot 框架自身的说明书。系统提示词只要求「关于框架的问题先读这个技能」，所以这里放的是事实和路径，不是营销文案。

## 1. 三个技能区

技能是 `<区>/<id>/SKILL.md`（Claude 标准 frontmatter），id 就是目录名。

| 区 | 默认目录 | 覆盖环境变量 | 用途 |
| --- | --- | --- | --- |
| 兼容技能 | `~/.agents/skills` | `KOLOR_SKILLS_DIR` | Claude 标准兼容区，历史安装位置 |
| 专属技能 | `<workspace>/skills`，默认 `~/.kolor/workspace/skills` | `KOLOR_USER_SKILLS_DIR` | KolorBot 自己的技能区 |
| 内置技能 | 源码仓库的 `inner/skills` | `KOLOR_BUILTIN_SKILLS_DIR` | 随源码分发的内置技能（`browseruse`、`kolor` 本身） |

- 同名技能按 **专属 → 兼容 → 内置** 取第一个；三个区的 `kolor.json` 都收集，同名 MCP server 同样按这个优先级。
- 技能列表在每轮对话前刷新；`<system-skills>` 的指纹（`v2:<sha1>`，含 id、描述、来源）变化会触发重新注入和 MCP 重连，不用重启服务。
- `<system-skills>` 里每行是 `id - description`；需要全文时调用内置工具 `skills(id)`，它会按同样优先级在三个区里查。
- Web 侧栏「技能」弹窗按三个区分组显示（标题 + 数量 + 空区目录提示），点技能看详情和它的 MCP server。

## 2. 制作一个 skill

最小结构：

```text
<区>/my-skill/
├── SKILL.md          # 必需，文件名大小写不敏感
├── kolor.json        # 可选，声明 MCP server
└── 其他文件           # 可选，脚本/模板/数据，skills 工具会列出最多 100 个
```

`SKILL.md` 必须是 frontmatter + 正文：

```markdown
---
name: My Skill
description: 一句话说明什么时候用它；这句会出现在 <system-skills> 里。
---

# My Skill

正文：什么时候用、步骤、工具、注意事项。
```

制作步骤：

1. 在某个技能区建目录，目录名就是 id（建议小写、连字符）。
2. 写 `SKILL.md`；`description` 写清触发场景（模型只靠这一行决定要不要读正文）。
3. 有脚本就一起放进去；`stdio` MCP 的默认 `cwd` 就是技能目录，相对 `command`/`cwd` 也按技能目录解析。
4. 需要依赖时在技能目录里自行安装（例如 `npm install`），依赖不要提交进仓库。
5. 把技能放到哪个区：临时试验放专属区；要和别人共享放兼容区；随源码分发放 `inner/skills`（提交到仓库）。
6. 验证：侧栏「技能」能看到、带 MCP 的显示 **MCP** 标识；对话里让模型 `skills("<id>")` 能读到正文。

## 3. skill 的 MCP 配置

在技能目录（或任一技能区根目录）放 `kolor.json`：

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["server.mjs"],
      "env": { "API_KEY": "${API_KEY}" }
    },
    "my-remote": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${TOKEN}" }
    }
  }
}
```

- `"mcp"` 是 `mcpServers` 的别名，两种都认。
- `stdio`：`command` 必填，`args` 可选；`cwd` 默认技能目录；`command`/`cwd` 的相对路径按技能目录解析。
- `http` / `sse`：`type` 写 `http` 或 `sse`，`url` 必填；`headers` 可选。
- `env` / `headers` 支持 `${VAR}`，从启动 `kolorbot-web` 的进程环境读取；技能进程不会拿到宿主全部环境变量，只拿默认环境 + 这里声明的。
- 放在**技能区根目录**的 `kolor.json` 是该区的全局配置，优先于单个技能里的同名 server；重名 server 只保留第一个。
- MCP 工具在模型侧的名字是 `mcp__<server>__<tool>`，`/` 等字符会被替换；和本地工具重名时保留本地工具。
- 加/改 MCP 后下一轮对话会重连；单个 server 可以在技能详情里点「刷新」（`POST /api/mcp/<name>/restart`）关闭并重连，不用重启服务。
- 排查：`/api/mcp` 只返回名称/传输/来源技能，不返回 env/headers；连接失败看服务日志和 `mcp/error` 事件。

制作一个最小 MCP server（stdio，无依赖）：

```js
// server.mjs，按行读 stdin 的 JSON-RPC
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === '') continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    const reply = (result) =>
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
    if (message.method === 'initialize') {
      reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'demo', version: '0.1.0' } });
    } else if (message.method === 'tools/list') {
      reply({ tools: [{ name: 'ping', description: 'Ping', inputSchema: { type: 'object', properties: {} } }] });
    } else if (message.method === 'tools/call') {
      reply({ content: [{ type: 'text', text: 'pong' }] });
    }
  }
});
```

## 4. 单对话、话题与日记

KolorBot 只有一条对话。每条普通用户消息都会先判定话题；切换话题时 UI 插入分割线，模型上下文只保留当前话题片段（segment）。

- **话题**：短名字 + ascii slug + `workspace/topic/<slug>.md`；不允许别名，保存到 `~/.kolor/conversation.db`。
- **上下文**：切换话题（包括切回旧话题）从空上下文开始；旧信息靠话题文件和日记片段带回。
- **注入**：新话题第一条带 `<system-memory>`（AI.md + 话题文件 + 该话题最新日记片段）和 `<system-last-message>`（上一话题最后 10 条 user/assistant 文本）。同一话题内只有 AI.md 变化才重发记忆。
- **日记位置**：`<workspace>/daily/YYYY-MM-DD.md`，用 `list_files` / `read_file` / `write_file` 读写。
- **日记格式**：

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

- **排序**：一天里每个话题只有一个 `##` 块，按话题**第一次出现**的顺序排列；同一话题后续内容追加到同一块下（块内时间递增，整篇不保证严格全局时间）。
- **话题文件**：每个话题第一次写进日记时，同时创建/更新 `workspace/topic/<slug>.md`，写关键信息（事实、决定、状态、待办、相关路径）；之后出现关键变化时主动用 `write_file` 更新，不写流水账。
- **日记片段查找**（服务端注入时）：今天有该话题 → 用今天；否则往前找最近一天；再不行用该话题最早一次。
- **自动触发**：一轮对话结束后静默 10 分钟，整理上次日记之后产生的所有话题片段；`/update-daily-memory` 可立即整理。日记轮次本身不再计时，也没有定时任务功能。
- **没有新内容**时回复 `No new content.`，不要写空小节。

## 5. 设定（AI.md）

- **位置**：`<workspace>/AI.md`，默认 `~/.kolor/workspace/AI.md`；和日记一样用文件工具读写。
- **只放这些**：AI 的名字、性格、对自己的了解；可选：自己的形象图片的本地路径、AI 认为自己形象是什么样。不要什么都存，**文件到 1 MiB 必须删减**（注入会被截断并标记，界面也会提示超出）。
- 建议结构：

```markdown
# 名字

## 性格

## 自我认知

## 形象（可选）

图片路径：/path/to/image.png
```

- **触发命令**（服务端只发一行任务消息并指向本技能，不注入完整提示词）：
  - `/self-md-update`：根据这次对话创建或更新 AI.md；
  - `/self-md-tell 你是一个温柔的 AI…`：根据后面的信息创建或更新 AI.md；命令后没写内容会被拒绝。
- 写 AI.md 用 `write_file`（覆盖整个文件），需要时先 `read_file` 读旧内容再合并。
- **注入**：新话题第一条的 `<system-memory>` 里先放 AI.md（`## AI self (AI.md)`），再放话题文件和该话题最新日记片段；同一话题内只有 AI.md 变化才重发。

## 6. 框架速览

- 包：`kolorbot-agent-loop`（主循环/模型客户端/MCP + 本地工具）、`kolorbot-conversation`（topics/segments/messages）、`kolorbot-skills`（技能发现/注入）、`kolorbot-memory`（AI.md/话题文件/日记/注入）、`kolorbot-web`（HTTP/SSE/话题判定/提供商/前端/CLI）。
- 内置工具：`read_file` / `write_file` / `list_files` / `bash` / `skills` / `read_image`；`read_image` 会把本地图片附给支持视觉的模型（例如 `deepseek-flash`；文本模型只拿到格式/尺寸元数据）。
- 对话与 turn：`RunBroker` 让 turn 活在服务端，断线可回放；日记也走它。
- 模型提供商：`~/.kolor/providers.json`，OpenAI Chat Completions 协议；没有内置默认模型。
- 常用 HTTP API：`/api/conversation`、`/api/chat`（SSE，body `{text}`）、`/api/chat/cancel`、`/api/skills`、`/api/mcp`、`/api/mcp/:name/restart`、`/api/memory`、`/api/providers`、`/api/config`。
- 运行：`run web`（或 `npm run web`）；测试 `pnpm test`。
- 数据目录：`~/.kolor`（`conversation.db`、`providers.json`、`memory.json`、`workspace/`），可用 `KOLOR_HOME` 改。
- 包名是 `kolorbot-*`；`~/.kolor`、`KOLOR_*`、`kolor.json` 和技能 `kolor` 保留旧名，是兼容约束，不要重命名。

## 7. 注意

- 改技能/`kolor.json` 不需要重启，下一轮对话生效；改 `packages/*` 源码后重启 `kolorbot-web`。
- `write_file` / `read_file` 只能碰 workspace 和技能目录；`bash` 不沙箱。
- 技能正文不要写密钥；密钥通过 `kolor.json` 的 `${VAR}` 从环境变量注入。
