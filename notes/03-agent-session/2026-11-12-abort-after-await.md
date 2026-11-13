# 2026-11-12：异步等待后的中止检查

## 阅读范围

`packages/coding-agent/src/core/agent-session.ts` 中 `_handlePostAgentRun()` 的压缩检查。

```ts
if (await this._checkCompaction(message, true, toolResults)) {
    return !this._agentRunAbortRequested;
}
```

传入 `_checkCompaction()` 的 `true` 表示：如果 `message` 这条 assistant 回复本身被中止，就跳过检查。它关注的是这条回复的结束状态。

`_checkCompaction()` 不只是判断是否需要压缩：符合条件时，它会调用 `_runAutoCompaction()` 执行压缩，并等待处理完成。它最终返回的布尔值表示是否需要继续 Agent，不是单纯表示是否执行过压缩。例如，压缩完成后如果不需要继续，仍可能返回 `false`。

`_agentRunAbortRequested` 关注的是当前 Session 运行是否收到中止请求。检查或压缩需要等待，等待期间用户可能按下中止；因此当 `_checkCompaction()` 返回需要继续时，还要查看当前是否已中止，再决定是否向外层返回 `true`。

```text
上一条回复没有被中止 → 开始压缩检查 → 等待期间用户中止
→ 检查完成 → 发现当前运行已中止 → 返回 false，不继续 Agent
```

这是一种常见模式，但并非每个 `await` 后都必须重新检查：要看后续操作是否受中止影响，以及异步函数自身如何处理中止。

最后，`return !this._agentRunAbortRequested && this.agent.hasQueuedMessages()` 检查两个条件：没有中止请求，并且 Agent 队列里还有消息。只有两者都满足才返回 `true`；否则返回 `false`。

## 结束前更新 session 和检查上下文

`_runBeforeSettleBoundary()` 在扩展处理结束前事件后依次执行：

1. `_commitBoundaryDrafts(result.entries)`：将扩展返回的记录写入 session，并刷新 Agent 消息上下文。
2. `_flushPendingCustomMessages()`：将 `_pendingCustomMessages` 里的自定义消息写入 session，清空该暂存数组。
3. `_buildBoundaryContext([], "agent_before_settle")`：读取更新后的 session 和待处理消息，生成供判断使用的 `finalContext`；不会再次把上下文写入 session。`[]` 表示没有额外的预览记录。

`_pendingCustomMessages` 与底层 Agent 的 steering、follow-up 队列是分开的。第二步只处理并清空自定义消息暂存数组，不清空 Agent 的两个队列；第三步仍会查看 Agent 中待处理的消息。

## Agent 事件与 Session

Agent 负责运行，并在运行过程中发出事件，例如 `agent_start`（开始运行）、`message_update`（回复更新）、`message_end`（消息完成）和 `agent_end`（本次底层运行结束）。

`AgentSession` 订阅这些事件，收到后通知扩展和公开监听方；收到 `message_end` 时，还会把完成的消息记录到 session。事件桥接的逐行实现暂时跳过。

## Session 记录与当前分支上下文

`SessionManager.fileEntries` 是内存中的 session 记录数组，包含 session 头部和各类历史记录，也可以保留其他分支的记录。添加记录时，`_appendEntry()` 会先把它放入这个数组。

当前分支的上下文则是从 session 记录中按当前分支组织出来、准备供模型使用的内容；其他分支虽然仍保存在 `fileEntries` 中，不会仅因为存在于数组里就自动进入当前分支的模型上下文。

例如，登录方案分成密码登录和验证码登录两条分支时，如果当前处于验证码分支，session 记录仍可保留两条分支，但当前分支上下文沿验证码分支构建。这是简化示例；具体构建过程待阅读 `buildSessionContext()`。

## 内存记录与 session 文件

`fileEntries` 是 Pi 运行时在内存中使用的记录数组；`sessionFile` 是保存会话记录的文件路径。新记录先加入内存数组，启用文件保存并配置路径时，再由 `_persist()` 尝试写入文件。

退出或重启 Pi 后，原进程的内存数组不再保留；如果有 session 文件，之后可以从文件加载记录，重新建立内存中的数组。一次 Agent 回复结束并不意味着 Pi 进程结束。

用户消息通常来自用户在 Pi 输入框中的输入，但扩展或其他调用方也可以通过接口发送。消息进入 Agent 后，普通情况下的记录顺序是：

```text
Agent 发出用户消息的 message_end 事件
→ AgentSession 调用 sessionManager.appendMessage(message)
→ appendMessage 将消息包装成 entry
→ _appendEntry 先将 entry 加入 fileEntries
→ _appendEntry 再调用 _persist(entry)
→ 首次保存时，_hasConversation() 可以在 fileEntries 中发现这条用户消息
```

启用文件保存且有路径时，首次写入会在出现用户或 assistant 消息后创建新文件，并将当前 `fileEntries` 的记录逐条写入，每条 JSON 记录占一行。没有这类消息时暂不创建文件。

## 分支查找的起点

`getBranch(fromId)` 接收可选的起点记录 ID；未传入时使用当前叶子记录 ID `leafId`。`startId = fromId ?? this.leafId` 得到最终起点 ID，然后通过 `byId.get(startId)` 查找对应的完整记录。

例如，假设记录 ID 有 A、B、C，当前叶子是 C：传入 B 就从 B 开始；不传则从 C 开始。`byId` 是从 ID 找到记录的查找表。
