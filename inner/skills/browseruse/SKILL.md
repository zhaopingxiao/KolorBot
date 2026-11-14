---
name: BrowserUse
description: 用真实浏览器（无头 Edge）操控网页并实时看到画面。AI 通过 MCP 工具打开网页、快照（文本 + 截图）、点击、输入、按键、执行 JS，也可以调用网页注册的 WebMCP 工具；浏览器画面在本地 URL（默认 http://127.0.0.1:9223）实时流式显示，快照截图可直接用 Markdown 在回复里展示。适合登录、点按钮、填表单、抓取渲染后的内容等需要真实浏览器的任务。
---

# BrowserUse

一个挂在 MCP 上的真实浏览器：agent 用工具操控网页，人可以通过本地 URL 实时看屏幕。

## 回答要求（重要）

- **实时画面地址只在打开新网页后给一次**（`browser_open` 的返回里带有 `Live view: ...`），或者用户主动询问时再给；其他操作后的回复里不要再重复这个地址。
- **截图不需要每次都展示**：只有用户要截图、需要让用户看清页面、或截图有助于说明时才把返回里的 `![page screenshot](http://...)` 贴进回复；普通操作只汇报结果即可。
- **每个操作都会自动附带一次 snapshot**：`browser_open` / `browser_click` / `browser_type` / `browser_press` / `browser_evaluate` 的返回末尾都有 `## Auto snapshot after this action`（最新页面文本 + 新截图），不需要为了看结果再手动调 `browser_snapshot`；需要更完整的页面信息时再手动 snapshot。
- snapshot 的**文本**（标题、URL、正文、元素序号）已经够理解页面时，就不要再读图片；只有文本不够清楚时，才需要用图片核对，或直接让用户看截图/实时画面。
- 页面变化后旧序号失效：自动快照里的序号就是最新的，可直接用于下一次点击/输入。

## 实时画面

- 打开 **http://127.0.0.1:9223** （端口可用环境变量 `BROWSERUSE_VIEW_PORT` 改），页面以 MJPEG 实时显示浏览器画面，随每次操作自动刷新。
- **画面可以手动操作**：鼠标点击 / 双击 / 右键、按住拖动（拖拽元素、滑块、画布）、滚轮、键盘都直接转发到真实浏览器（坐标按截图比例映射到页面视口，拖动会按 16ms 节流连续发送 mousemove）；触摸屏上下滑动会把滚动转发到页面（单指滑动 = 滚动网页），顶部输入框回车可把中文/任意文字发进网页（`insertText`，适合输入法输入不了的场景）。先点一下画面让网页获得焦点，再开始键入。
- 如果页面内容比浏览器视口长，用滚轮/触摸滑动看下面的部分；实时画面本身只显示浏览器视口。
- 有头模式：把环境变量 `BROWSERUSE_HEADLESS=false` 设置到启动 `kolorbot-web` 的进程里，就能看到真实浏览器窗口。

## 工具

| 工具 | 说明 |
| --- | --- |
| `browser_open(url)` | 打开 http/https（或 `data:`）页面，返回标题、URL 和实时画面地址（只在打开后给用户一次） |
| `browser_snapshot()` | **文本 + 截图合并**：标题、URL、正文、所有可交互元素的序号，外加一张保存到技能目录 `shots/` 的截图；返回里同时给出 Markdown 图片行和截图文件路径。普通操作会自动带快照，一般不用手动调用 |
| `browser_click(index)` | 点击快照里的第 `index` 个元素 |
| `browser_type(index, text)` | 往第 `index` 个输入框/文本域里填文字（走原生 setter + input 事件，兼容 React 表单） |
| `browser_press(key)` | 按键，例如 `Enter`、`Escape`、`Tab`、`ArrowDown` |
| `browser_evaluate(expression)` | 在页面里执行 JavaScript 并取回 JSON 结果 |
| `browser_webmcp_list()` | 列出当前页面注册的 WebMCP 工具 |
| `browser_webmcp_call(name, input)` | 调用页面注册的 WebMCP 工具 |

## 标准流程

1. `browser_open("https://example.com")`：返回标题、URL、实时地址（这次回复里给用户一次），以及自动快照；
2. 需要展示页面（用户要截图/看不清）时，再把自动快照里的 Markdown 图片行贴进回复；
3. `browser_type(0, "hello")` / `browser_click(2)` / `browser_press("Enter")`：每个操作又会自动带回最新快照，按需展示；
4. 自动快照里的序号可以直接用，页面变化后不需要手动重新 snapshot；
5. 文本够用就别折腾图片；需要真的看图时用内置 `read_image` 读取返回的 `Screenshot file:` 路径（支持视觉的模型会真正收到图片，文本模型只拿到格式/尺寸），或让用户看实时画面（用户主动问再把地址给他）。

## WebMCP

部分网页会用 WebMCP 在页面里注册自己的工具。流程：

1. `browser_webmcp_list()` 看页面提供哪些工具和参数；
2. `browser_webmcp_call(name, { ...按 inputSchema 填的参数 })`；
3. 返回 `status`（Completed / Canceled / Error）+ `output`。

需要 **Chrome ≥ 149** 且带 WebMCP 特性开关（本技能启动浏览器时已带上）。当前系统的 Edge 157 还没有开放这个 CDP 命令，`browser_webmcp_list` 会返回明确的「不支持」错误；换成支持它的 Chrome 后这两个工具即可用，代码无需改动。页面没注册任何工具时 `browser_webmcp_list` 返回空列表，属于正常现象。

## 注意

- 浏览器是**真实浏览器**（系统 Edge 的无头模式）：cookie、JS、localStorage 都正常，和人工操作一致。
- 涉及登录、付款、删除等敏感操作前，先跟用户确认。
- 单窗口单页面模型：`browser_open` 复用同一个页面，没有多标签页。
- 依赖：`playwright-core`（技能目录内 `npm install`），复用系统 Edge，无需下载浏览器内核；机器上没有 Edge 时需要先安装 Edge 或改用 playwright 自带内核。
