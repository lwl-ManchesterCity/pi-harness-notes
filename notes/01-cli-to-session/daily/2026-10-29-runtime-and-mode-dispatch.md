# 2026-10-29：从 `createRuntime` 到运行模式启动

## 今天的目标

看完 `main.ts` 的主函数后半段，确认 Pi 如何：

```text
创建 AgentSession
→ 再封装 AgentSessionRuntime
→ 准备首次输入
→ 按 RPC / interactive / print 启动对应运行模式
```

## 阅读范围

- `packages/coding-agent/src/main.ts`
- `packages/coding-agent/src/core/agent-session-runtime.ts`（只确认调用关系，尚未展开阅读）
- `packages/coding-agent/src/cli/initial-message.ts`

## 主调用链

```text
main.ts 定义 createRuntime（此时不执行）
→ createAgentSessionRuntime(createRuntime, ...)
→ 内部调用 createRuntime(...)
→ createAgentSessionFromServices(...)
→ 创建 AgentSession
→ createRuntime return 结果包
→ 创建 AgentSessionRuntime
→ main.ts 按 appMode 启动 RPC / interactive / print
```

## 不要混淆：`AgentSession` 与 `AgentSessionRuntime`

`AgentSession` 只创建一次：

```ts
const created = await createAgentSessionFromServices({ ... });
```

它的结果保存在 `created`：

```text
created
├── session：真正创建好的 AgentSession
├── extensionsResult：扩展加载结果
└── modelFallbackMessage：恢复旧 session 时可显示的模型替换提示
```

随后：

```ts
return {
  ...created,
  services,
  diagnostics,
};
```

这里没有再次创建 AgentSession；只是把创建结果、服务和诊断交还给调用 `createRuntime(...)` 的 `createAgentSessionRuntime(...)`。

`createAgentSessionRuntime(...)` 接到结果后才创建外层运行容器：

```text
AgentSessionRuntime
├── session：已有的 AgentSession
├── services：模型、设置、资源加载等工具
├── diagnostics：启动问题
└── createRuntime：未来 /new、/resume、/fork 可复用的创建配方
```

因此这是“再封装”，不是第二次创建对话。

## `createRuntime` 的职责

前半段 `main.ts` 主要做前置判断：管理命令、参数、模式、Session、项目可信状态等。

```text
前面 main.ts
→ 这次 Pi 能不能开始？

createRuntime(...)
→ 开始时要准备什么、创建什么？
→ services、sessionOptions、AgentSession、diagnostics。

createAgentSessionRuntime(...)
→ 把上述结果装进统一运行容器。
```

## `appMode` 只决定一次，后面反复复用

`appMode` 前面已经通过 `resolveAppMode(...)` 确定；后续判断不会反复决定用户模式，而是复用同一个结果控制不同动作。

例如：

```ts
initTheme(settingsManager.getTheme(), appMode === "interactive");
```

```text
interactive → true  → 加载主题并监听主题文件变化。
print/json/rpc → false → 只加载一次主题，不监听。
```

主题有两步：

```text
--use-theme
→ 临时决定本次使用的主题名。

initTheme(...)
→ 真正加载最终主题名。
```

## 用户文字进入 Pi 的三种方式

`stdinContent` 只代表管道输入，不是所有用户输入。

```text
1. 启动命令参数
   pi "帮我修复 Bug"
   → 通过 process.argv 进入 parseArgs(args)，成为 parsed.messages。

2. 正常交互输入
   pi
   → 聊天界面打开后，用户持续从键盘输入第二、第三条消息。
   → stdin 是终端 TTY；不是 stdinContent。

3. 管道输入
   git diff | pi "检查改动"
   → git diff 的输出通过 | 自动进入 Pi 的 stdin。
   → stdin 不是终端 TTY；通常一次读完、随后输入结束。
   → readPipedStdin() 读到的文字是 stdinContent。
```

`prepareInitialMessage(parsed, stdinContent)` 只处理启动时的首条内容：

```text
命令行首条消息 + @文件文字/图片 + 管道文字
→ initialMessage / initialImages
→ 后续运行模式再将它们交给模型。
```

它不负责第二、第三条消息：

```text
interactive → InteractiveMode 持续读取键盘输入。
print       → 执行一次后退出，没有第二条。
rpc         → runRpcMode(...) 持续读取结构化 RPC 命令。
```

## 普通管道与 RPC 都使用 stdin，但含义不同

```text
普通管道
→ 一次性的自然语言、日志、git diff 等文字。
→ main.ts 用 readPipedStdin() 一次读完。
→ 用 print 模式执行一次并退出。

RPC
→ 格式固定的 RPC / JSON-RPC 命令。
→ main.ts 不能抢先读完 stdin；把 stdin 留给 runRpcMode(...) 持续读取。
→ 进程可以长期处理多条程序命令。
```

## 启动诊断：收集后再决定显示时机

```ts
const startupDiagnostics = deduplicateDiagnostics([
  ...startupSettingsDiagnostics,
  ...runtime.diagnostics,
]);
```

```text
startupSettingsDiagnostics
→ settings.json 读取问题。

runtime.diagnostics
→ createRuntime 中信任、服务、扩展、模型参数等问题。

startupDiagnostics
→ 两份清单合并、去重后的启动问题总表。
```

`reportDiagnostics(startupDiagnostics)` 会逐条输出这些问题。

```text
非 interactive
→ 没有聊天界面可显示问题，因此立刻输出。

interactive + runtime error
→ 无法安全启动界面，因此立刻输出并退出。

interactive + 无 runtime error
→ 不在 main.ts 立刻打印；后面交给 InteractiveMode 显示。
```

## 启动测速

开发者可开启：

```bash
PI_STARTUP_BENCHMARK=1 pi
```

它不改变 Agent 对话逻辑，只用来测启动慢在哪一步：

```text
parseArgs
createSessionManager
createRuntime
initTheme
interactiveMode.init
```

测速模式仅支持 interactive，因为它会测量 `interactiveMode.init()`。

注意：interactive 路径中虽然有两处 `printTimings()`，但同一次运行不会输出两次：

```text
测速模式
→ 初始化界面
→ printTimings()
→ return
→ 跳过正常聊天路径的第二次 printTimings()。

普通模式
→ 跳过测速分支
→ 执行正常聊天前的 printTimings()。
→ 没有 PI_TIMING=1 时，该函数不输出任何内容。
```

## RPC 为什么后台刷新模型

RPC 是供其他程序长期调用 Pi 的模式。它后续需要使用模型，因此后台刷新模型、Provider 和认证可用状态，避免长期运行后信息过期。

```ts
void modelRuntime.refresh({ signal: controller.signal });
```

```text
开始后台刷新
→ 不 await，不阻塞 RPC 启动
→ RPC 可立刻接收请求
→ 最多 15 秒，超时只停止刷新，不停止 RPC。
```

interactive 也会刷新模型，但在终端界面初始化后开始。

## 最后按模式启动

```text
appMode = rpc
→ await runRpcMode(runtime)
→ 长期读取并处理结构化程序命令。

appMode = interactive
→ new InteractiveMode(runtime, 启动资料)
→ await interactiveMode.run()
→ 打开聊天界面，持续读取用户键盘输入。

appMode = print / json
→ await runPrintMode(runtime, 输入资料)
→ 执行一次任务，输出一次结果，然后清理并退出。
```

`new InteractiveMode(...)` 只创建聊天界面控制器，不会重新创建 `AgentSession`；`interactiveMode.run()` 才真正启动界面。

## 下一步

继续真实调用链：

```text
main.ts
→ core/agent-session-runtime.ts：createAgentSessionRuntime(...)
→ 调用 createRuntime(...)
→ core/agent-session-services.ts：createAgentSessionFromServices(...)
→ core/sdk.ts：createAgentSession(...)
→ new AgentSession(...)
```
