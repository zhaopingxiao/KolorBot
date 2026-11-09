---
name: Kolor
description: KolorBot 框架自身的使用说明：三个技能目录与优先级、如何制作 skill、skill 里的 MCP 配置与制作方法、日记（存放位置、文件格式、整理时注入的提示词、怎么写）、会话/提供商/HTTP API 速查。用户问「KolorBot 自己怎么用/怎么扩展/技能放哪/日记怎么工作」时读这个技能，不要凭记忆猜。
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
- `env` / `headers` 支持 `${VAR}`，从启动 `kolor-web` 的进程环境读取；技能进程不会拿到宿主全部环境变量，只拿默认环境 + 这里声明的。
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

## 4. 日记（daily memory）

- **位置**：`<workspace>/daily/YYYY-MM-DD.md`，本地日期，一天一个 Markdown 文件；workspace 默认 `~/.kolor/workspace`，可用 `KOLOR_FRAME_ROOT` 改。
- **文件格式**：

```markdown
# 2026-11-09

## Previous Topic

- 上一篇日记在做什么、停在哪

## 20:15

- 这次对话的进展、决定、结论、待办
```

- **首条规则**：当天文件不存在或为空时，如果 `daily/` 里还有更早的日记，必须先 `list_files daily/`、`read_file` 最近一篇更早的日记，概括 2-4 条写进 `## Previous Topic`，再写 `## HH:mm` 正文；没有更早日记时可以直接从 `## HH:mm` 开始。同一天后续整理只追加新的 `## HH:mm`，不再写第二个 `## Previous Topic`。
- **写日记用什么工具**：内置文件工具 `list_files` / `read_file` / `write_file`。第一次写当天文件用 `write_file` 覆盖整个文件；后续追加用 `write_file` 加 `append: true`，只写新的 `## HH:mm` 块。**没有 `append_diary` 工具**，不要调用它。
- **自动触发**：一次对话结束后开始计时，10 分钟没有新用户消息就为该会话跑一轮后台日记（和定时任务一样走 broker，可看实时进度）。新用户消息会重置计时；重置/删除会话会取消；日记轮次本身不再计时。
- **手动触发**：发送固定命令 `/update-daily-memory`（大小写不敏感、必须整条消息），服务端换成和自动触发完全相同的消息。
- **注入给模型的整理提示词**（固定英文，`kolor-web/src/memory.ts` 的 `DIARY_INSTRUCTION`，外层包 `<system-daily-memory-task>`，末尾是 `It's <本地时间>. Update today's diary.`）：

```text
Update today's diary (daily memory) from this conversation.

Requirements:
1. Review what happened in this conversation since the last diary entry: what was done, what was decided, conclusions and todo.
2. The diary is the markdown file daily/YYYY-MM-DD.md inside the workspace (today's local date). Use the file tools directly: list_files, read_file, write_file. There is no append_diary tool.
3. File format:
   # YYYY-MM-DD

   ## Previous Topic

   - 2-4 bullets summarising the most recent earlier diary

   ## HH:mm

   - short bullets for this conversation
4. First entry of the day (today's file is missing or empty) and any earlier diary exists: list daily/, read the most recent earlier diary, and write the whole file with write_file — the leading `## Previous Topic` section is REQUIRED in this case. Only when daily/ has no earlier diary may the first entry start directly with `## HH:mm`.
5. Later entries: append with write_file and `append: true`, adding only a new `## HH:mm` block; never add a second `## Previous Topic`.
6. Only record substantive content; write short bullet points in the language of the conversation, and do not repeat what the diary already records.
7. If nothing new has happened since the last entry, do not write the file and simply say "No new content."
8. Reply with one sentence when you are done.
```

- **日常注入**：每条用户消息前，如果当天日记非空，就注入 `<system-daily-memory>…当天日记全文…</system-daily-memory>`；内容没变不重复注入，重置会话后重新注入。这部分不用改。
- 开关在「记忆」面板（`~/.kolor/memory.json` 的 `diary.autoAppend`），默认关闭自动整理。

## 5. 框架速览

- 包：`kolor-agent-loop`（主循环/模型客户端/MCP）、`kolor-sessions`（SQLite 会话存储/主题/定时任务）、`kolor-skills`（技能发现/注入）、`kolor-frame`（本地工具：文件/bash/skills）、`kolor-web`（HTTP/SSE/调度器/提供商/前端）。
- 会话与 turn：`RunBroker` 让 turn 活在服务端，断线可回放；定时任务和日记也走它。
- 模型提供商：`~/.kolor/providers.json`，OpenAI Chat Completions 协议；没有内置默认模型。
- 常用 HTTP API：`/api/sessions`、`/api/chat`（SSE）、`/api/chat/cancel`、`/api/skills`、`/api/mcp`、`/api/mcp/:name/restart`、`/api/memory`、`/api/providers`、`/api/config`。
- 运行：`npm run web`（tsx 直接跑源码）或 `restart.cmd`；测试 `pnpm test`。
- 数据目录：`~/.kolor`（`sessions.db`、`providers.json`、`memory.json`、`workspace/`），可用 `KOLOR_HOME` 改。
- 内部标识（`kolor-*` 包名、`~/.kolor`、`KOLOR_*`、`kolor.json`）是兼容约束，不要重命名。

## 6. 注意

- 改技能/`kolor.json` 不需要重启，下一轮对话生效；改 `packages/*` 源码后重启 `kolor-web`。
- `write_file` / `read_file` 只能碰 workspace 和技能目录；`bash` 不沙箱。
- 技能正文不要写密钥；密钥通过 `kolor.json` 的 `${VAR}` 从环境变量注入。
