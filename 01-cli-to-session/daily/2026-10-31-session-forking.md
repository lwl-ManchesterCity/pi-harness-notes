# 2026-10-31：`fork(...)` 如何创建 Session 历史分支

## 今天的目标

继续阅读：

```text
packages/coding-agent/src/core/agent-session-runtime.ts
```

确认 Pi 如何从当前 session 的历史中创建 fork 分支，并最终把 runtime 切到该新分支。

## `fork` 和 `new`、`resume` 的区别

```text
switchSession / resume
→ 打开已经存在的旧 session，继续已有历史。

newSession
→ 创建一段空白新对话，不复制当前聊天历史。

fork
→ 从当前聊天历史的某个位置复制出新分支。
→ 原 session 保持不变；新分支从选中位置继续。
```

例子：

```text
原 session A：
1. 用户：做登录功能
2. Agent：方案 A
3. 用户：按方案 A 实现
4. Agent：方案 A 的代码
```

在第 3 条分叉：

```text
position = "before"
→ 新分支 B 保留第 1、2 条，不带第 3、4 条。

position = "at"
→ 新分支 B 保留第 1、2、3 条，不带第 4 条。
```

因此 fork 的价值是：保留原路线 A，同时从旧位置独立开始路线 B；不会把两个方案的后续消息混在同一条历史中。

## `before` 与 `at` 在代码中如何决定分叉位置

```ts
if (position === "at") {
  targetLeafId = selectedEntry.id;
} else {
  targetLeafId = selectedEntry.parentId;
}
```

```text
entryId
→ 调用 fork 时传入的“要选哪条历史记录”的 ID。

selectedEntry
→ Pi 根据 entryId 在当前 session 中查到的完整记录。

targetLeafId
→ 新分支最后要保留的那条历史记录 ID。
```

`position` 只预期有两个值：`"at"` 或 `"before"`。因此代码只检查：

```text
如果是 at
→ 包含选中记录。

否则
→ 就是 before，不包含选中记录。
```

`before` 分叉只允许选中用户消息；若选中 Agent 回复或工具结果，Pi 会报错，避免分叉位置含义不明确。

## 为什么 `targetLeafId` 可能为空

通常 `targetLeafId` 有值，表示新分支要复制到哪条历史记录。

特殊情况是：在第一条历史记录之前分叉。

```text
原 session：
1. 用户：做登录功能

before 第 1 条
→ 新分支不保留第 1 条。
→ 前面没有任何记录可复制。
→ targetLeafId = null。
```

因此：

```text
targetLeafId 有值
→ 复制从开头到该记录的旧历史。

targetLeafId 为空
→ 没有旧历史可复制，创建空分支。
```

空分支仍会记录来源关系：

```ts
sessionManager.newSession({ parentSession: currentSessionFile });
```

这表示：

```text
新分支知道自己来自原 session 文件，
但不会复制原 session 的任何聊天消息。
```

## fork 前会先定位并验证分叉点

```ts
const selectedEntry = this.session.sessionManager.getEntry(entryId);
if (!selectedEntry) {
  throw new Error("Invalid entry ID for forking");
}
```

```text
entryId 存在于当前 session 历史
→ 才能继续确定 before / at 的分叉位置。

找不到节点
→ 不关闭当前 session，不创建新分支，直接报错结束。
```

与 `new / resume` 一样，fork 真正开始前也会让扩展取消操作；扩展取消时，当前 session 保持不变。

## 文件分叉与内存分叉

fork 会先判断当前 session 是否已保存到文件。

```text
当前 session 有文件
→ 确认原文件路径存在于磁盘。
→ 打开原 session 文件。
→ createBranchedSession(targetLeafId) 复制从开头到分叉点的历史，写成独立新分支文件。
→ sessionManager 随后管理这个新分支文件。
```

```text
当前 session 只在内存中
→ 没有文件可复制。
→ 直接使用当前内存中的 sessionManager 创建空分支或历史分支。
```

无论文件还是内存，分支生成后的共同后半段都是：

```text
teardownCurrent("fork", 新分支文件路径)
→ 收尾并关闭当前 AgentSession A。

createRuntime(...)
→ 用新分支 B 的 cwd、sessionManager 等资料创建运行结果包。

apply(...)
→ runtime 当前内容从 A 替换为 B。

finishSessionReplacement(...)
→ 界面重新绑定新分支，完成本次 fork 的额外动作。
```

## cwd 在 fork 中的含义

聊天历史和 cwd 是两件事：

```text
聊天历史
→ 用户与 Agent 说过什么。

cwd
→ session 所属的项目目录。
```

fork 出的新分支虽然可能没有任何聊天历史，仍属于原项目：

```text
session A 的 cwd = 项目 P
fork 出的 session B 的 cwd = 项目 P
```

空分支代码直接使用 `this.cwd`；复制历史的分支从新分支自己的 `sessionManager.getCwd()` 读取。两者在 fork 场景中通常是同一个项目目录，只是取值来源不同。
