---
name: DeepSeek 搜索
description: 用 DeepSeek Search/Fetch 搜索网页并抓取 Markdown 正文，适合查最新资料、读文章、核对事实。
---

# DeepSeek 搜索

当用户要查最新信息、新闻、文档、网页资料，或直接给你一个 URL 时，用这个技能里的 MCP 工具。

## 工具

### `search`

按查询词搜索网页，返回标题、URL、摘要、日期、权威性和可选正文。

- `query`：搜索词，支持 `site:`、`-site:`、`"精确短语"`、`lang:`、`after:`、`before:`、`-排除词`。
- `count`：1-50，默认 5。
- `need_content`：需要正文时设为 `true`，每个结果会附一段截取正文。
- `ori_question`：可选，原始问题，帮助理解搜索意图。

### `fetch`

抓取单个网页，返回标题和 Markdown 正文。

- `url`：HTTP/HTTPS 地址。
- `max_chars`：正文截取上限，1000-50000，默认 12000。内容被截断时末尾会标注。

## 使用规则

1. 先 `search`，优先选 `rerank_score` 高、`authority` 高、日期新的结果。
2. 摘要不够或需要细节时，对结果 URL 调 `fetch`；需要更多正文就提高 `max_chars`。
3. 回答里引用实际用到的 URL，不要编造链接或内容。
4. 搜索或抓取失败时如实说明；429/5xx 可以重试一次。
5. 一次搜索/抓取都按次计费（见 DeepSeek 文档），不要无意义地重复调用。
