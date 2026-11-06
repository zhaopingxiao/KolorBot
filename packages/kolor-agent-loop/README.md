# kolor-agent-loop

KolorBot 的第一个包：一个不依赖宿主框架的 Node.js 智能体主循环。

- OpenAI 兼容的流式模型客户端（DeepSeek / OpenAI / vLLM / OpenRouter…），手写 SSE 解析，自带超时与非流式兜底。
- 工具调度参考 DSH 的 `dsh-agent-loop`：有界并行池、独占屏障、**按模型顺序提交结果**、取消时给未派发调用补结果。
- 内置 MCP 客户端：stdio、Streamable HTTP、SSE 三种传输，工具自动以 `mcp__<server>__<tool>` 暴露给模型。
- 完整事件流（`turn/*`、`step/*`、`text/delta`、`tool/*`、`mcp/*`）、协作式取消 + 硬超时。

完整文档（配置表、事件表、架构对照、限制）：[../../README.md](../../README.md)。

## 安装

在 KolorBot 仓库内：

```bash
pnpm install
pnpm --filter kolor-agent-loop build
```

## 用法

```ts
import { KolorAgent, defineTool } from 'kolor-agent-loop';

const agent = await KolorAgent.create({
  apiUrl: 'https://api.deepseek.com',
  apiModelName: 'deepseek-chat',
  apiKey: process.env.DEEPSEEK_API_KEY!,
  mcpServers: [
    { name: 'fs', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] },
  ],
});

agent.on('tool/result', (event) => {
  console.log(`[tool] ${event.name} -> ${event.content}`);
});

for await (const event of agent.stream('这个项目是什么？')) {
  if (event.type === 'text/delta') process.stdout.write(event.text);
}

await agent.dispose();
```

KolorFrame（文件读写 / bash / 技能）由 agent-loop 默认注册成本地工具，不用写进 `mcpServers`：

```ts
const agent = await KolorAgent.create(config, {
  kolorFrame: { root: process.cwd() }, // 默认启用；传 false 关闭
});
```

本地工具：

```ts
const time = defineTool({
  name: 'get_time',
  description: 'Return the current time',
  inputSchema: { type: 'object', properties: {} },
  execute: () => new Date().toISOString(),
});

const agent = await KolorAgent.create(config, { tools: [time] });
```

## 公开 API

| 导出 | 作用 |
| --- | --- |
| `KolorAgent` | `create()` / `run()` / `stream()` / `cancel()` / `dispose()`，`on()` 订阅事件 |
| `defineTool` | 声明一个本地工具 |
| `ToolRegistry` | 工具注册表（也可单独使用） |
| `executeToolCalls` | 工具调度器；可脱离 agent 单独测试 |
| `OpenAiCompatibleClient` | 模型客户端，可实现 `ModelClient` 接口替换 |
| `McpManager` | MCP 连接管理 |
| `SessionLog` | 追加式会话日志 |
| `parseSseData` | SSE 解析器 |
| `resolveConfig` / `toChatCompletionsUrl` | 配置校验与 endpoint 规范化 |
| `KolorError` 系列 | `KolorConfigError` / `KolorApiError` / `KolorStateError` / `KolorToolError` / `KolorAbortError` |

## 已知限制

- 会话只在内存中，不持久化。
- 同一 agent 同时只能跑一个 turn；没有 steering / followup 队列。
- 没有上下文压缩、自动重试、prompt 组装钩子。
- MCP 只接入 tools，尚未接入 resources / prompts / sampling。
- 只实现 OpenAI 兼容协议（`/chat/completions`）。

## 测试

```bash
pnpm --filter kolor-agent-loop test
```

41 个测试，包含本地 HTTP 假模型端到端、真实 stdio MCP 子进程与 Streamable HTTP MCP 服务端到端，无需网络和 API key。
