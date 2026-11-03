# 2026-11-01：导入 Session 与创建 AgentSession 前的准备

## 今天的阅读位置

```text
packages/coding-agent/src/core/agent-session-runtime.ts
→ 完成 importFromJsonl(...)、dispose() 与初始 runtime 创建入口。

packages/coding-agent/src/core/agent-session-services.ts
→ 开始阅读创建 services 前半段。
```

## 导入 JSONL：什么时候复制文件

导入外部 JSONL 时，Pi 先为它确定 session 文件夹中的目标路径。

```text
外部文件：
/Users/lwl/Downloads/chat.jsonl
→ 默认目标：~/.pi/sessions/chat.jsonl
→ sourceAlreadyStored = false
→ 必要时改名 chat-1.jsonl、chat-2.jsonl，避免覆盖
→ 复制到 Pi session 文件夹。
```

```text
文件本来就在目标位置：
~/.pi/sessions/chat.jsonl
→ sourceAlreadyStored = true
→ 不改名、不复制，直接使用它。
```

第一个 `if (!sourceAlreadyStored)` 只负责为外部文件寻找不重名的目标名；第二个同条件的 `if` 才真正调用 `copyFileSync(...)` 复制文件。

## 导入文件如何变成当前 Session

```ts
const sessionManager = SessionManager.open(destinationPath, sessionDir, cwdOverride);
```

这不会创建新的 JSONL 文件或新的 session。它得到的是一个管理已有导入文件的 `sessionManager`，后续可从中取得 session 文件路径和所属项目目录。

导入成功后，Pi 沿用统一的 session 切换流程：

```text
teardownCurrent(...)
→ 结束旧 AgentSession。

this.createRuntime(...)
→ 根据导入 session 的 cwd、sessionManager 创建新 session、services 等内容。

apply(...)
→ 将这些新内容替换进已有 runtime。

finishSessionReplacement(...)
→ 重新绑定界面等后续动作。
```

## 两个名字相近的创建调用

```text
createAgentSessionRuntime(...)
→ Pi 第一次启动时创建第一个 AgentSessionRuntime 外壳。

this.createRuntime(...)
→ runtime 已存在时，为 /new、/resume、/fork、/import 准备新 session 的内容。
→ apply(...) 把新内容替换进原 runtime，不创建第二个 runtime。
```

退出 Pi 时：

```text
dispose()
→ 通知扩展 session_shutdown / quit
→ 执行外部清理回调
→ 关闭当前 AgentSession。
```

## `agent-session-services.ts`：先准备，再创建

创建 `AgentSession` 分两步：

```text
createAgentSessionServices(...)
→ 返回 services。

services 的格式：AgentSessionServices
→ cwd、agentDir、modelRuntime、settingsManager、resourceLoader、diagnostics。

createAgentSessionFromServices({ services, sessionManager, ... })
→ 使用已准备好的 services 创建 AgentSession。
```

`options` 只是函数参数名，代表调用者传入的资料包，例如：

```text
options.cwd
→ 当前项目目录。

options.agentDir
→ 可选的 Pi 全局目录。
```

## `??`：复用已有值，否则创建备用值

```ts
const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create(...));
```

```text
options.modelRuntime 有值
→ 直接复用。

options.modelRuntime 是 undefined 或 null
→ 创建新的 modelRuntime。
```

`modelRuntime` 创建时会使用 Pi 全局目录中的 `auth.json` 与 `models.json`。

## 扩展命令行参数

扩展可以声明自己的命令行参数。Pi 会先遍历所有扩展，将它们的 `flags` 汇总到：

```text
registeredFlags
→ 参数名 → 参数类型。
```

然后检查用户实际输入的：

```text
extensionFlagValues
→ 参数名 → 用户输入的值。
```

```text
boolean
→ 用户写了参数即保存 true。
→ --dry-run → dry-run = true

string
→ 用户必须给文字值。
→ --branch main → branch = "main"
```

未知参数、或 string 参数没有值，不立刻退出；会收集到 `diagnostics`，交给上层决定如何显示与停止。

## 扩展为什么能影响模型

`resourceLoader.reload(...)` 会真正加载扩展、skills、提示词模板等资源。

某些扩展可在加载时请求新增模型 provider：

```text
扩展调用 registerProvider(...)
→ 请求先写入 pendingProviderRegistrations（待办列表）。

modelRuntime 准备完成
→ modelRuntime.registerProvider(...) 真正登记该 provider。
→ 清空待办列表，避免重复登记。
```

清空的只是“尚未处理的请求”，不是已经登记进 `modelRuntime` 的 provider。
