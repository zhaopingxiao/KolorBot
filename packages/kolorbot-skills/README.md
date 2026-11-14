# kolorbot-skills

KolorBot 的技能发现模块：读取 `~/.agents/skills` 下符合 **Claude 标准** 的技能，生成 `<system-skills>` 列表，并提供按 id 读取详情的能力。

## 安装标准

每个技能一个目录，目录名就是 id，里面必须有 `SKILL.md`：

```
~/.agents/skills/
└── pdf/
    ├── SKILL.md
    ├── kolor.json          # 可选：声明 MCP 服务器
    ├── scripts/extract.py
    └── references/guide.md
```

`SKILL.md` 使用 YAML frontmatter：

```md
---
name: PDF 处理
description: 提取、合并、拆分 PDF，填写表单，扫描件 OCR。
---

# PDF 处理

1. 用 pdftotext 提取文字……
```

- `name`：显示名，缺省用目录名。
- `description`：注入列表时的一行介绍；缺省取正文第一段。
- 其他字段（`allowed-tools`、`license` 等）会被忽略。
- 支持 `description: >` / `description: |` 和多行纯文本。

## 在技能里声明 MCP

技能目录下的 `kolor.json` 可以带 `mcpServers`（也接受 `mcp` 作为别名）：

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

- `stdio` 必须有 `command`，`args` 是字符串数组；`http` / `sse` 必须有 `url`。
- 默认 cwd 是技能目录；相对 `command` / `cwd` 按技能目录解析。
- `env` / `headers` 的值支持 `${VAR}` 占位符，从宿主环境展开；用于 API key 等秘密，Web API 不会回传这些字段。
- `kolor.json` 可以放在单个技能目录，也可以放在 `~/.agents/skills/kolor.json` 作为全局配置；全局优先。
- 非法条目会被跳过，不会影响其他技能。
- `SkillsRegistry.mcpServers()` 先读全局配置，再按技能 id 合并，同名 server 先到先得。

## API

```ts
import { SkillsRegistry, formatSkillsBlock } from 'kolorbot-skills';

const registry = new SkillsRegistry(); // ~/.agents/skills
registry.list();        // [{ id, name, description, path }]
registry.get('pdf');    // 详情：SKILL.md 内容 + 文件列表
registry.mcpServers();  // [{ name, transport, skillId, command|url, ... }]
registry.signature();   // v1:<sha1>，id + description 的指纹

formatSkillsBlock(registry.list());
// <system-skills>
// pdf - 提取、合并、拆分 PDF……
// </system-skills>
```

路径优先级：`$KOLOR_SKILLS_DIR` → `~/.agents/skills`。`KOLOR_HOME` 只影响会话数据库等 KolorBot 数据，不再影响技能目录。

## 注入规则（由 kolorbot-web 实现）

- 对话开始（`messageCount === 0`）、重置后、或 `signature()` 与上次发送不同时，把 `<system-skills>` 放在用户消息最前面。
- 发送后把签名记到会话的 `skills_signature`；重置会清空签名，因此下一条消息会重新注入。
- 列表为空时不注入空标签。
- 注入后消息形如：

```
<system-skills>
pdf - 提取、合并、拆分 PDF……
review - 按仓库规范审阅 diff……
</system-skills>

（原有的 <system-topic> 和用户原话）
```

模型通过内置的 `skills(id)` 工具读取某个技能的完整 `SKILL.md` 和文件列表。
