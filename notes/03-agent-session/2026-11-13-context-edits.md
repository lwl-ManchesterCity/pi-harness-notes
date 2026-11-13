# 2026-11-13：上下文修改和投影

## 阅读范围

`packages/coding-agent/src/core/session-manager.ts` 中的 `buildSessionProjection()` 和 `projectContextEntry()`。

## 修改记录与原始历史

上下文修改通过新增 `context_edit` 记录表达：它用 `targetId` 指向目标记录，用 `replacement` 表示替换内容或排除。旧记录仍保存在 session 历史中；构建上下文时才应用修改指示。

例如，假设用户消息 A 的内容是“你好”：

| 修改指示 | 构建出的上下文消息 |
| --- | --- |
| 没有 | 使用原内容“你好” |
| 替换为“请检查代码” | 使用“请检查代码” |
| 排除 | 返回空数组，不加入这条消息 |

示例里的文本是简化表示，实际返回的是消息对象数组。

修改指示只决定目标记录如何处理，发给模型的不是只有被修改的内容，而是整理后当前上下文中所有保留的消息。例如当前分支包含 A（用户说“你好”）、B（assistant 回复）、C（用户说“继续”）和一条把 A 替换为“请检查代码”的修改指示，整理后保留 A 的替换内容、B 和 C；修改指示本身不作为普通消息发送。原始 session 中 A 仍是“你好”。

`edits.get(sourceEntry.id)` 按原记录的 ID 查找修改指示，再把原记录和找到的指示交给 `projectContextEntry()`。对同一目标出现多个修改指示时，收集到 `Map` 中的后一个覆盖前一个。

## 压缩记录的判断

当 `sourceEntry` 是 `compaction` 且位置 `index > 0` 时，给它空消息数组；其他情况调用 `projectContextEntry()`。判断背后的完整原因需要结合 `buildContextEntries()` 继续阅读。

`buildContextEntries()` 从前往后遍历当前分支，找到压缩记录时更新 `compaction`，因此最后保留的是这条分支上最新的一条压缩记录。没有压缩记录时直接返回完整路径。

例如（假设）：早期对话 → 压缩记录 B → 后续对话 → 压缩记录 D。B 和 D 分别记录各次压缩得到的摘要；遍历后选中 D。压缩不一定涵盖之前的所有记录，也可能保留部分较近的原始记录。

`firstKeptEntryId` 指向压缩记录之前、需要保留的连续区间的起点。假设 A → B → C → D（最新压缩记录）→ E，且起点是 B，构建时会先放入 D，再收集 B、C，最后加入 D 之后的 E；收集旧记录时会跳过 system 消息，后续投影也可能过滤或修改内容。

因此该例中 `contextEntries` 的顺序是 `[D, B, C, E]`：最新压缩记录、起点到压缩记录之前保留的记录、压缩记录之后的记录。它此时仍是记录数组，后面还要转换为上下文消息。

如果起点选得很早，可能保留大量旧记录，影响压缩效果。当前读取代码按起点执行，但起点如何选出、是否有控制保留范围，需要继续查看压缩生成逻辑，暂不能判断是否存在问题。

## 用户消息到模型的主链

```text
输入字符串
→ AgentSession._prepareRun() 包装成 user 消息
→ AgentSession 调用 Agent.prompt(messages)
→ 用户消息完成时，AgentSession 交给 SessionManager 记录
→ 请求准备时，根据当前分支和 session 记录整理上下文
→ convertToLlm() 转成模型请求使用的消息
→ Agent Loop 请求模型、执行工具，并按需要继续请求
→ 底层运行结束后，AgentSession 检查是否重试、压缩或继续处理消息
```

最简单情况下，“帮我检查代码”会先被包装成包含 `role: "user"`、文本内容和时间的消息对象，再交给 Agent。整理上下文时使用 session 记录 `entries`、当前叶子记录 ID `leafId` 和记录查找表 `byId`；处理压缩及修改后得到当前上下文消息。系统提示词和工具声明也会作为模型请求上下文的一部分准备。

## Week 3 主链回顾

以用户输入“帮我检查代码”为例：

1. `AgentSession.prompt()` 接收文本、处理输入并检查模型和认证；`_prepareRun()` 把文本包装为 `role: "user"`、文本内容和时间组成的消息对象。
2. `_startRun()` 将准备好的消息数组传给 `agent.prompt(messages)`。Agent 的消息完成事件由 AgentSession 接收，普通消息交给 `SessionManager.appendMessage()` 记录。
3. `SessionManager` 将消息包装为带 `id`、`parentId` 的 session 记录，先放入内存的 `fileEntries`，再根据配置保存到文件。`leafId` 标记当前分支位置。
4. 请求准备时，SessionManager 按当前分支整理上下文；必要时应用压缩和 `context_edit`。session 全部历史和当前上下文是不同范围。
5. `convertToLlm()` 保留普通模型消息，并按规则转换自定义消息、bash 结果和摘要；标记排除的 bash 记录不会发送。
6. Agent Loop 请求模型、执行工具并按需再次请求。一次底层运行结束后，AgentSession 检查重试、压缩、队列和结束前扩展；完成后发出 `agent_settled`。

分工：Agent Loop 管理模型和工具的循环；AgentSession 管理运行的准备、继续、中止与结束；SessionManager 管理历史、分支和上下文；`convertToLlm()` 转换模型请求消息。事件桥接已按学习安排浅看；压缩保留起点的选择和重试内部可作为后续专题。
