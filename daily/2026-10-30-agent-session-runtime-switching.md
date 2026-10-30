# 2026-10-30：`AgentSessionRuntime` 如何切换 session

## 今天的目标

继续阅读：

```text
packages/coding-agent/src/core/agent-session-runtime.ts
```

确认 Pi 在恢复旧 session、创建新 session 时，如何先收尾旧内容，再让 runtime 使用新内容。

## 先分清 runtime 内部的两类内容

```text
createRuntime
→ 一份可重复调用的创建函数。
→ 每次给它目标 session 的资料，就创建该目标对应的一整套运行结果。

runtime 当前内容
→ 当前 AgentSession、配套 services、diagnostics、模型提示。
→ 切换 session 时会被替换。
```

例如从 session A 切到 B：

```text
调用同一份 createRuntime(B 的 cwd、B 的 sessionManager)
→ 得到 B 的运行结果包。

apply(结果包)
→ runtime 当前内容从 A 的一套替换为 B 的一套。
```

`createRuntime` 函数本身不需要替换；变化的是每次调用时传入的目标 session 资料。

## `apply(result)`：把新结果包装进现有 runtime

```ts
private apply(result: CreateAgentSessionRuntimeResult): void {
  this._session = result.session;
  this._services = result.services;
  this._diagnostics = result.diagnostics;
  this._modelFallbackMessage = result.modelFallbackMessage;
}
```

`result` 不是单独一个新 session，而是完整的新运行结果包：

```text
result
├── session                  → 新 AgentSession
├── services                 → 与新 session 对应的模型、设置、资源加载器
├── diagnostics              → 创建时发现的问题
└── modelFallbackMessage     → 可选模型降级提示
```

`apply(...)` 不负责保存旧 session。它只把 runtime 当前使用的一套内容替换为新的一套内容。

## 切换前先收尾旧 session

```text
teardownCurrent(...)
→ 停止旧 session 正在回答或调用工具。
→ 通知旧 session 中的扩展开始收尾。
→ 如有 UI 清理动作则执行。
→ 正式关闭旧 session。

apply(...)
→ 之后才装入新 session。
```

`abort()` 的作用只是停止当前正在进行的一轮工作；不是删除旧 session 历史。具体消息如何写入 session 文件，属于后续 `AgentSession` / `SessionManager` 的阅读范围。

## 扩展为什么能拦截 session 切换

扩展是给 Pi 添加功能的代码，例如项目 `.pi/extensions/` 中的扩展或 Pi 内置扩展。它们可以增加工具、命令、终端界面内容，也可以监听 session 的开始、关闭和切换。

新建或恢复 session 前，Pi 会先通知当前 session 中关心切换的扩展：

```text
没有扩展注册 session_before_switch
→ Pi 直接继续切换。

扩展回答“继续”
→ cancelled = false
→ Pi 继续。

扩展回答“取消”
→ cancelled = true
→ Pi 不关闭当前 session，直接结束本次操作。
```

这不是给用户弹窗，而是让扩展代码有机会说“当前不要切换”。

## 三种 session 去向

```text
switchSession
→ 打开已经存在的旧 session，继续它的历史。

newSession
→ 新开一段空白对话，不复制当前聊天历史。

fork
→ 从当前聊天历史的某个旧位置复制出一条新分支。
→ 原 session 保留，新分支带着分叉点之前的历史继续。
```

它们的前半段不同：

```text
恢复旧 session
→ SessionManager.open(旧 session 文件)。

新建 session
→ SessionManager.create(...) 或 SessionManager.inMemory(...).

fork
→ 选择当前历史中的分叉位置，再创建分支。
```

但目标 session 准备好后的后半段大致一致：

```text
teardownCurrent(...)
→ 收尾当前 session。

createRuntime(...)
→ 用目标 session 自己的 cwd、sessionManager 等资料创建新结果包。

apply(...)
→ runtime 使用目标 session 的整套内容。

finishSessionReplacement(...)
→ 界面重新绑定，并完成本次切换后的额外动作。
```

## 新建 session 会继承当前保存方式

`newSession(...)` 不重新决定是否保存历史文件；它让新 session 跟随当前 session 的保存方式：

```text
当前 session 已保存到文件
→ 新 session 在同一个 sessionDir 创建新的 session 文件。

当前 session 只存在内存中
→ 新 session 也只创建在内存中，不会突然创建文件。
```

所以这里的核心不是“是否保存”，而是：

```text
新 session 跟随当前 session 原本的保存方式。
```

## 今天的主链

```text
用户选择恢复旧 session 或新建 session
→ 扩展可先取消本次切换
→ 准备目标 sessionManager
→ teardownCurrent：收尾当前 session
→ createRuntime：按目标资料创建新运行结果
→ apply：runtime 替换为新结果
→ finishSessionReplacement：外部重新使用新 session
```
