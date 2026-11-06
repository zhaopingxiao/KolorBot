# kolor-web

KolorBot 的本地 Web 聊天界面：会话管理、MCP 列表、技能（skills），默认带 **KolorFrame** 文件/bash/技能工具。

## 启动

```bash
# 在 KolorBot 仓库根目录
pnpm install
DEEPSEEK_API_KEY=sk-... npm run web
```

Windows PowerShell：

```powershell
$env:DEEPSEEK_API_KEY = 'sk-...'
npm run web
```

打开 <http://127.0.0.1:3399>。

需要局域网访问时传 `--host`：

```powershell
npm run web -- --host 0.0.0.0
npm run web -- --host 0.0.0.0 --port 8080   # 换端口
```

也可以设置 `KOLOR_WEB_HOST=0.0.0.0`，命令行参数优先。`0.0.0.0` 监听所有网卡；Web UI 没有鉴权，只建议在可信局域网使用，并注意系统防火墙。

默认配置就是：

```ts
{
  apiUrl: 'https://api.deepseek.com',
  apiModelName: 'deepseek-chat',
  apiKey: process.env.DEEPSEEK_API_KEY ?? '',
}
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` / `KOLOR_API_KEY` | 空 | 模型 key；为空时仍能打开 UI，但发送会报错 |
| `KOLOR_API_URL` | `https://api.deepseek.com` | OpenAI 兼容 endpoint |
| `KOLOR_API_MODEL` | `deepseek-chat` | 模型名 |
| `KOLOR_WEB_HOST` | `127.0.0.1` | 监听地址 |
| `KOLOR_WEB_PORT` | `3399` | 端口（`0` 表示随机） |
| `KOLOR_HOME` | `~/.kolor` | 数据目录 |
| `KOLOR_SESSIONS_DB` | `<home>/sessions.db` | SQLite 文件 |
| `KOLOR_FRAME_ROOT` | `<home>/workspace` | 内置文件/bash 工具的工作区根 |
| `KOLOR_SKILLS_DIR` | `~/.agents/skills` | 技能目录（Claude 标准） |

命令行 `--host` / `--port` 优先于环境变量。

## 页面功能

浅色极简界面，只保留对话需要的元素；操作结果用会自动消失的 toast 提示。

- **会话**：新建、切换、搜索、删除；每轮结束后上下文写入 SQLite。
- **主题与重置**：顶栏「主题」编辑长文本项目背景；「重置」只清空上下文，名称和主题保留。设置/修改主题、重置之后的第一条用户消息会自动带上 `<system-topic>…</system-topic>`，之后恢复普通消息。
- **定时任务**：会话设置里添加任务（名字 + 时间），到点自动向该会话发送 `It's ... Do: 任务名` 并跑一轮。支持每天 / 每周（多选）/ 每月 / 每小时。模型也可以通过 `schedule_reminder` 工具创建提醒；工具描述要求任务名保持 1-4 个词、最多 40 字符，只需要 AI 自己能识别。
- **技能**：侧栏「SKILL」查看 `~/.agents/skills` 里的 Claude 标准技能。对话开始、重置、或列表变化时，下一条用户消息前会带 `<system-skills>` 列表；AI 用内置的 `skills(id)` 读取详情。
- **聊天**：流式文本、工具调用卡片（参数 / 结果 / 状态，可折叠）、停止按钮。
- **移动端**：顶部左右两个三条杠分别打开对话列表和会话操作（主题 / 定时 / 重置 / 删除）抽屉，点会话或操作后自动收起。
- **MCP**：内置工具（文件/bash/技能）由 agent-loop 直接注册；额外服务器写在 `~/.agents/skills/<id>/kolor.json`（或 `~/.agents/skills/kolor.json` 全局配置），面板只读展示，不提供增删改。

```json
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },
    "browser": { "type": "http", "url": "https://example.com/mcp" }
  }
}
```

`stdio` 默认 cwd 是技能目录，相对 `command` / `cwd` 按技能目录解析；也接受 `"mcp"` 作为 `mcpServers` 的别名。改完文件后下一轮对话自动重连；同名 server 按技能 id 先到先得。

KolorFrame 的工具始终存在（文件/bash/技能）；技能里的 MCP 服务器是叠加的。删除会话只会移除该会话，不影响内置工具。

定时任务由服务进程内的 15 秒 ticker 驱动：只在服务运行时触发，不补跑停机期间错过的任务；同一任务同一分钟只触发一次；会话有正在跑的轮次时跳过该次触发。

## 数据与安全

```
~/.kolor/
├── sessions.db      # 会话（SQLite）
└── workspace/       # 内置文件/bash 工具的工作区

~/.agents/skills/    # 技能（<id>/SKILL.md + 可选 <id>/kolor.json MCP）
```

- 服务只监听 `127.0.0.1`，没有鉴权；不要绑定到公网。
- `KolorFrame` 的 `bash` 不沙箱，文件工具只在 `frameRoot` 内。- API key 只存在于服务进程内存里，不会写入 sessions.db，也不会回传给前端（`/api/config` 只返回 `hasApiKey`）。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/config` | 运行配置 + MCP 列表 |
| GET/POST | `/api/sessions` | 列表 / 新建 |
| GET/PATCH/DELETE | `/api/sessions/:id` | 读取 / 改名 / 删除 |
| PUT | `/api/sessions/:id/context` | 整体替换上下文 |
| PUT | `/api/sessions/:id/topic` | 设置/清除主题（下一条消息注入） |
| GET/POST | `/api/sessions/:id/tasks` | 定时任务列表 / 新建 |
| DELETE | `/api/sessions/:id/tasks/:taskId` | 删除定时任务 |
| POST | `/api/sessions/:id/reset` | 重置：清空上下文，保留名称与主题 |
| GET | `/api/sessions/:id/export` | 导出 JSON（含主题） |
| POST | `/api/sessions/import` | 从 JSON 新建会话 |
| GET | `/api/skills` | 已安装技能列表 + 签名 |
| GET | `/api/skills/:id` | 技能详情（SKILL.md + 文件列表） |
| GET | `/api/mcp` | skill 声明的 MCP 列表（只读） |
| POST | `/api/chat` | 发送消息，SSE 事件流 |
| POST | `/api/chat/cancel` | 停止当前轮次 |

`/api/chat` 的事件就是 agent-loop 的 `KolorEvent`（`text/delta`、`tool/call`、`tool/result`、`turn/end`…），外加 `ready`（工具列表）、`topic/applied`（本轮注入了主题）和 `session/saved`。

## 开发

```bash
pnpm --filter kolor-web build
pnpm --filter kolor-web test   # 24 个测试，含内置工具、定时任务、CLI 参数与技能注入端到端
```
