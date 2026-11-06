# kolor-sessions

KolorBot 的会话存储：把 agent-loop 的上下文、会话主题和定时任务存进 SQLite，默认路径 `~/.kolor/sessions.db`。

## 表结构

```sql
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,   -- s_xxxxxxxxxxxxxxxx
  name          TEXT NOT NULL,
  created_at    TEXT NOT NULL,      -- ISO-8601
  updated_at    TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  preview       TEXT NOT NULL,      -- 第一条 user 消息，截断到 120 字符
  context_json  TEXT NOT NULL,      -- AgentMessage[]
  topic         TEXT NOT NULL DEFAULT '',   -- 长文本主题
  topic_pending INTEGER NOT NULL DEFAULT 0, -- 下一条用户消息是否携带主题
  skills_signature TEXT NOT NULL DEFAULT ''  -- 上次发送的 <system-skills> 指纹
);

CREATE TABLE session_tasks (
  id            TEXT PRIMARY KEY,   -- t_xxxxxxxxxxxxxxxx
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,      -- 触发消息里 Do: 后面的内容
  schedule_json TEXT NOT NULL,      -- TaskSchedule
  created_at    TEXT NOT NULL,
  last_fired_at TEXT
);
```

旧数据库会在打开时自动 `ALTER TABLE` 补上 `topic` / `topic_pending` / `skills_signature`，并创建 `session_tasks`。

## 用法

```ts
import { SessionStore } from 'kolor-sessions';

const store = new SessionStore();            // ~/.kolor/sessions.db
const session = store.create({
  name: '葡萄云项目',
  topic: '编写葡萄云项目，使用 Vue 3 + Node.js…',
});

// 下一条用户消息会被包成 <system-topic>…</system-topic> + 原话
const prepared = store.prepareUserMessage(session.id, '从哪开始？');
agent.run(prepared.content);

store.replaceContext(session.id, agent.exportContext()); // 每轮结束后保存
store.reset(session.id);                                 // 只清上下文，主题保留
agent.importContext(store.require(session.id).context);  // 读回来继续对话

store.exportJson(session.id);                // 导出（含 topic / topicPending）
store.importJson(json);                      // 导入为新会话

// 定时任务：名字 + 时间规则
const task = store.createTask(session.id, {
  name: '提醒我写周报',
  schedule: { type: 'weekly', weekdays: [1, 3], time: '18:30' },
});
store.listTasks(session.id);
store.markTaskFired(task.id);                // 调度器记录触发时间
store.deleteTask(session.id, task.id);
```

## 定时规则

```ts
type TaskSchedule =
  | { type: 'daily'; time: 'HH:mm' }
  | { type: 'weekly'; weekdays: number[]; time: 'HH:mm' }   // 1=周一 … 7=周日
  | { type: 'monthly'; day: number; time: 'HH:mm' }         // 1-31，缺该日期的月份跳过
  | { type: 'hourly'; minute: number };                     // 0-59
```

配套工具函数：`validateTaskSchedule`、`matchesSchedule(schedule, date)`、`nextRunAt(schedule, from?)`、`describeSchedule(schedule)`、`formatTimestamp(date)`。时间都按本地时区解释；调度器本身由 `kolor-web` 提供。

## 主题注入规则

主题是给 AI 记住的长文本项目背景。以下时机把 `topic_pending` 置为 1：

- `create({ topic })` 或 `setTopic(id, topic)`（内容有变化时）；
- `reset(id)`（主题非空时）。

下一次 `prepareUserMessage(id, text)` 会返回：

```
<system-topic>
（主题全文）
</system-topic>

（用户原话）
```

并把 `topic_pending` 清零，因此**只有一条**用户消息携带主题。主题本身会一直保留，直到 `setTopic(id, '')` 清除。

## API

| 方法 | 说明 |
| --- | --- |
| `list()` | 按 `updated_at` 倒序返回摘要（含 `topicPreview`、`topicPending`） |
| `get(id)` / `require(id)` | 读取完整会话（含 `topic`、`context`） |
| `create({ name?, context?, id?, topic?, topicPending? })` | 新建，`context` 会做校验 |
| `rename(id, name)` | 改名 |
| `setTopic(id, topic)` | 设置/清除主题；有变化时下一条消息注入 |
| `reset(id)` | 清空上下文，保留名称与主题，重新标记主题待注入，并清空技能签名 |
| `prepareUserMessage(id, text)` | 生成要发给模型的第一条消息（必要时带主题信封） |
| `listTasks(sessionId)` / `listAllTasks()` | 某个会话 / 全部定时任务 |
| `createTask(sessionId, { name, schedule })` | 新建定时任务，规则会校验 |
| `deleteTask(sessionId, taskId)` | 删除任务 |
| `markTaskFired(taskId, at?)` | 记录触发时间，避免同一分钟重复触发 |
| `markSkillsSent(id, signature)` | 记录已发送的技能列表指纹；`reset` 会清空 |
| `replaceContext(id, context)` | 替换上下文（每轮结束、导入） |
| `appendContext(id, messages)` | 追加消息 |
| `delete(id)` | 删除，返回是否命中 |
| `exportJson(id)` | 导出带 `version: 1` 的信封（含主题） |
| `importJson(text, { name? })` | 接受信封或裸消息数组 |

## 路径

| 环境变量 | 作用 |
| --- | --- |
| `KOLOR_HOME` | KolorBot 主目录，默认 `~/.kolor` |
| `KOLOR_SESSIONS_DB` | 直接指定数据库文件路径（优先级最高） |

也可以在构造时传 `{ path }` 或 `{ home }`。

## 上下文校验

`context` 必须是合法的 agent-loop 历史：每个 assistant `toolCalls` 都有一条对应的 `tool` 结果，`toolCallId` 不能悬空或重复。不合法的上下文会在写入/读取时抛出 `KolorStateError`，避免把坏历史发给模型。

数据库使用 Node 内置 `node:sqlite`（Node ≥ 22.5），无需额外依赖。
