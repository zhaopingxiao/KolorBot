# DeepSeek Search 技能

一个带 MCP 的 Kolor skill：模型通过 `mcp__deepseek-search__search` 和
`mcp__deepseek-search__fetch` 搜索网页、抓取 Markdown 正文。

## 安装

把整个目录复制到技能目录即可：

```bash
mkdir -p ~/.agents/skills
cp -r examples/skills/deepseek-search ~/.agents/skills/
```

Windows PowerShell：

```powershell
Copy-Item -Recurse examples\skills\deepseek-search "$env:USERPROFILE\.agents\skills\deepseek-search"
```

## API Key

`kolor.json` 会把宿主进程的 `DEEPSEEK_API_KEY` / `KOLOR_API_KEY` 注入 MCP 子进程
（通过 `${VAR}` 占位符）；启动 `kolor-web` 时设置其中一个：

```powershell
$env:DEEPSEEK_API_KEY = 'sk-...'
pnpm web
```

没有 key 时工具会返回明确的错误，不会发起请求。

## 文件

- `SKILL.md` — 技能说明和给模型的使用规则
- `kolor.json` — MCP 声明（相对路径 `server.mjs`）
- `server.mjs` — 无依赖的 stdio MCP server，调用 DeepSeek `/v1/tools/search` 和 `/v1/tools/fetch`

## 测试

可以设置 `DEEPSEEK_API_BASE` 指向本地 mock，单独运行 MCP server；正常使用时不要设置。
