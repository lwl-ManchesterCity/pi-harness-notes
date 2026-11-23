# 2026-11-23：Session 消息与记录 ID

## 历史、文件、上下文和摘要

- Session 历史是可追溯的记录，可以包含多个分支和非消息记录。
- Session 文件是持久化这些记录的 JSONL 文件；内存模式不写文件。
- 模型上下文由当前分支构建，可能受到 context edit 和 compaction 影响，不等于全部历史。它还会经过转换，形成模型 payload。
- 压缩摘要替代上下文中的部分旧消息；原始记录仍保留在 Session 中。

## 消息与记录 ID

AgentSession 收到的事件有不同类型。`event.type` 表示消息处于开始还是结束等阶段；`event.message.role` 表示消息的角色。先判断 `message_end`，在消息结束时处理；再判断角色，选择记录格式。

假设同一条用户消息先后产生 `message_start` 和 `message_end`，两次的 role 都是 `user`。仅判断角色会在两个事件上都进入保存逻辑；先判断 `message_end` 则在结束时处理。

普通消息通过 `appendMessage()` 创建 `message` 记录；custom 消息通过 `appendCustomMessageEntry()` 创建 `custom_message` 记录。两者都加入 Session。

```text
Agent 发出 message_end
→ AgentSession 根据消息类型调用 SessionManager
→ SessionManager 创建消息记录，返回记录 ID
→ AgentSession 记住：消息对象 → 记录 ID
```

假设一条用户消息的内容是“检查文件”，SessionManager 为它创建记录并返回假设 ID `abc123`。AgentSession 用消息对象保存对应的 ID；之后拿到同一个对象时，可以查找它对应的记录。

已经知道 ID 时，可以直接通过 SessionManager 的 `getEntry(id)` 查询。关联表解决的是调用方拿到消息对象、还不知道记录 ID 的情况；源码也有其他查找路径。

例如溢出恢复时，AgentSession 根据失败的 assistant 消息找到记录 ID，再追加 `context_edit`，让失败消息不进入模型上下文。原始记录仍保留。

## 记录之间的连接

`appendMessage()` 创建记录时，把当前 `leafId` 作为新记录的 `parentId`。`_appendEntry()` 把记录加入内存列表和 ID 索引，然后将 `leafId` 更新为新记录的 ID。

假设新记录的 ID 是 `abc123`：如果中间没有切换分支，下一次 `appendMessage()` 创建的记录会以 `abc123` 作为 `parentId`。切换分支会移动 `leafId`，下一条记录接在新的当前位置后面。

`_appendEntry()` 更新内存后调用 `_persist()`。如果没有启用持久化或没有文件路径，`_persist()` 直接返回：记录仍在内存，但不会由这次调用写入文件。内存状态通常在程序退出后消失；写入 JSONL 文件后，记录可以在之后重新加载。内存记录不等于模型上下文。

## 首次写入与后续追加

`flushed` 区分首次写入和后续追加。新 Session 的 `flushed` 为 `false`；有用户或 assistant 消息后，使用 `openSync(path, "wx")` 创建文件并写入内存中的全部记录。成功后设为 `true`，后续只追加新记录。加载已有 Session 成功后也设为 `true`，后续追加到已有文件。

因此 `_persist()` 的 `else` 对应 `flushed === true`：新 Session 已完成首次写入，或已有 Session 已加载。它用 `appendFileSync` 将本次新记录转成 JSON 并添加换行，追加到同一个文件末尾，不重写已有行。

检查是否已有对话消息是检查内存内容，不是检查目标路径是否存在。`wx` 在目标文件已存在时会报错，避免覆盖；如果创建或写入出错，就不会执行到设为 `true` 的语句，不能把这条路径当作成功后的追加。

阅读位置：`packages/coding-agent/src/core/agent-session.ts` 的 `_handleAgentEvent()` 和 `_findPersistedMessageEntryId()`；`packages/coding-agent/src/core/session-manager.ts` 的 `appendMessage()` 和 `_appendEntry()`。
