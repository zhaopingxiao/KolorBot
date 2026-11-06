# kolor-frame

**KolorFrame**：KolorBot 的本地工具库，提供工作区里的文件读写、bash 和技能读取能力。

它不再是 MCP 服务器，也不启动子进程；`kolor-agent-loop` 在创建 agent 时直接把这些工具注册进本地工具表。

## 工具

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `read_file` | `path`, `offset?`, `limit?` | 读 UTF-8 文本，按行分页 |
| `write_file` | `path`, `content`, `append?` | 写入/追加，自动创建父目录 |
| `list_files` | `path?`, `depth?` | 递归列目录，默认深度 2 |
| `bash` | `command`, `cwd?`, `timeout_ms?` | 在根目录里执行 shell 命令 |
| `skills` | `id` | 读取 `~/.agents/skills/<id>/SKILL.md` 和技能文件列表 |

## 由 agent-loop 注册

```ts
const agent = await KolorAgent.create(config, {
  kolorFrame: {
    root: '/path/to/workspace',
    skillsRoot: '/path/to/skills', // 默认 ~/.agents/skills
  },
});

// 不需要文件/bash/技能工具时关闭：
const plain = await KolorAgent.create(config, { kolorFrame: false });
```

模型看到的工具名就是 `read_file`、`write_file`、`list_files`、`bash`、`skills`，不再有 `mcp__kolor-frame__` 前缀。

## 直接调用

```ts
import { FRAME_TOOLS, callFrameTool } from 'kolor-frame';

// 工具描述 + JSON schema，可注册到任何工具系统
FRAME_TOOLS;

// 执行一个工具；失败会变成 { isError: true }
await callFrameTool('read_file', { path: 'README.md' }, { root: process.cwd() });
```

## 安全说明

- 文件工具被限制在 `root` 内，但**不防符号链接穿越**，是防手滑而不是安全沙箱。
- `bash` **完全不沙箱**：命令可以访问整台机器。只在本地可信环境使用。
- Web UI 默认把 root 设为 `~/.kolor/workspace`，可用 `KOLOR_FRAME_ROOT` 覆盖。
