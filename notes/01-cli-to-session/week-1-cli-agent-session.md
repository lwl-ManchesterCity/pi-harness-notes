# Week 1：CLI 到 AgentSession

目标：沿真实调用链理解 Pi 如何从 CLI 启动并创建 `AgentSession`，为后续设计 Multi-Agent Coding Agent 打基础。

## 调用链总览

```text
cli.ts
  → main.ts：main(...)
  → main.ts：createAgentSessionRuntime(...)
  → main.ts：createRuntime(...)
  → agent-session-services.ts：createAgentSessionFromServices(...)
  → sdk.ts：createAgentSession(...)
  → sdk.ts：new AgentSession(...)
```

## Day 1：CLI 入口

入口文件：`packages/coding-agent/src/cli.ts`

```text
cli.ts：把用户输入交给 main()
main.ts：决定要不要创建 Agent
```

当前只需理解：

```text
用户执行 pi
  → cli.ts 接收命令行参数
  → cli.ts 调用 main(...)
  → main.ts 开始处理用户命令
```

`cli.ts` 的核心调用：

```ts
main(process.argv.slice(2));
```

`process.argv.slice(2)` 会去掉 Node 和脚本自身的路径，只保留用户输入的命令行参数。

暂时跳过：`setupCli()` 内部的环境变量、HTTP dispatcher 和 Node warning 设置。这些不是理解 Agent 创建链路的前置知识。

### `main.ts`：先分类输入，再决定是否创建 Agent

`main.ts` 不会立刻创建 Agent。它会先判断用户输入是不是一个不需要 Agent 的管理命令：

```text
pi auth check ...    → 检查凭证，不创建 Agent
pi update            → 更新 Pi，不创建 Agent
pi config ...        → 读取或修改配置，不创建 Agent
pi mcp list          → 管理 MCP 服务，不创建 Agent
pi --version         → 输出版本号，不创建 Agent
pi --export ...      → 导出历史会话，不创建 Agent
```

只有普通任务才继续：

```bash
pi 帮我修复 bug
```

对应的源码分流位置：`packages/coding-agent/src/main.ts`。

```text
用户输入 pi
  → cli.ts 把参数交给 main()
  → main.ts 检查是否为管理命令
  → 不是管理命令时，继续准备 AgentSession
```

### 参数解析

普通任务会先执行：

```ts
const parsed = parseArgs(args);
```

它把用户输入的字符串拆成结构化数据。例如：

```bash
pi --model openai/gpt-5 帮我修复 bug
```

会被拆成模型选项和用户消息。参数错误会写入 `parsed.diagnostics`；存在错误时，Pi 输出错误并以状态码 `1` 退出。

### 导出会话

```bash
pi --export session.jsonl output.html
```

将已保存的 `session.jsonl` 会话文件转换为浏览器可打开的 `output.html`，不启动 Agent。

### 今日结论

```text
cli.ts：把用户输入交给 main()
main.ts：先分类用户输入，再决定要不要创建 Agent
```

这也是未来 Multi-Agent Coding Agent 的第一层：先做请求路由，再决定是否启动某个 Agent。

### 明天从这里继续

`packages/coding-agent/src/main.ts` 中的：

```ts
let appMode = resolveAppMode(parsed, process.stdin.isTTY, process.stdout.isTTY);
```

## Day 3：项目配置的信任判断（补充）

容易混淆的点：命令行没有强制指定信任状态，不等于项目已经被信任。

```ts
parsed.projectTrustOverride === undefined
```

这句话只表示：用户本次没有在命令行中明确要求“信任”或“不信任”。Pi 还要继续检查两件事：

```text
1. 项目中是否存在需要确认的资源
   例如 .pi/settings.json、.pi/extensions、.pi/skills 等。

2. 当前这台电脑的 Pi 是否已记录信任该项目
   记录保存在 Pi 全局目录的 agentDir/trust.json。
```

判断过程：

```text
没有命令行强制指定
+ 项目暂时没有需要确认的 .pi/ 资源
→ 可以暂时不弹确认；autoTrustOnReloadCwd 只记录这个“暂时情况”。

没有命令行强制指定
+ 项目已有需要确认的 .pi/ 资源
+ 当前电脑没有该项目的信任记录
→ 弹出信任确认。
```

跨电脑例子：

```text
电脑 A 的项目后来有 .pi/ 配置；
电脑 B 第一次打开同一个项目时，电脑 B 的 trust.json 没有信任记录；
→ Pi 仍会在电脑 B 弹出确认。
```

`autoTrustOnReloadCwd` 不是“后续请求默认信任”，也不是立即写入 `trust.json`。
它只处理一种特殊情况：本次交互开始时项目还没有需确认资源，运行中项目新增了这些资源并触发重新加载；Pi 用它避免在同一轮已经开始的交互中突然改变信任状态。

### 本段代码真正要解决的问题

不要先把它理解成抽象的“信任系统”。当前代码最直接的问题是：

```text
现在能不能读取当前项目的 cwd/.pi/settings.json？
```

`projectTrusted` 就是这个开关：

```text
true  → 可读取项目的 .pi/settings.json，并继续加载该项目需要信任的资源。
false → 暂不读取项目的 .pi/settings.json；Pi 全局设置仍可读取。
```

这里容易误会成“只检查 `settings.json`”。实际分两层：

```text
hasTrustRequiringProjectResources(cwd)
→ 检查整套项目资源：settings、extensions、skills、MCP、prompts 等；
→ 只要任意一种存在，就需要做项目级信任判断。

SettingsManager.create(...)
→ 只管理 settings.json；所以它只根据 projectTrusted 决定是否读取 cwd/.pi/settings.json。

后面的资源加载器
→ 使用同一个最终信任结果，决定 extensions、skills、MCP、prompts 等其余项目资源是否加载。
```

当项目有需要确认的 `.pi/` 资源、又还没有信任结果时，Pi 的顺序是：

```text
先让 projectTrusted = false
→ 避免陌生项目的配置抢先影响 Pi
→ 后面的 createAgentSessionServices(...) 再读取 trust.json 或在交互模式弹出确认
→ 用户信任后，得到最终 true，并重新加载项目配置
→ 用户不信任时，最终保持 false
```

容易混淆的两个变量：

```text
shouldResolveProjectTrust → 现在要不要取得信任结果？
projectTrusted            → 当前这一刻能不能读取项目 .pi/ 配置？
```

因此不能把前者直接传给 `SettingsManager.create(...)`：

```text
shouldResolveProjectTrust = true 表示“还需要问”；
projectTrusted = false 表示“答案出来前，先不要读项目配置”。
```

### 最终的信任答案从哪里来

这一点是前面最容易漏掉的：当 Pi 没有现成答案时，最终的选择会交给用户。

Pi 要得到的答案只有一个问题：

```text
“是否允许 Pi 使用这个项目的 .pi/ 配置和资源？”
```

答案只有两种：

```text
用户选“信任”     → trusted = true  → 允许加载项目 settings、skills、extensions、MCP、prompts 等。
用户选“不信任”   → trusted = false → 不加载这些项目资源。
```

`resolveProjectTrust(...)` 是资源加载器可调用的中转函数；它把项目目录、信任记录、命令行参数和交互界面交给 `resolveProjectTrusted(...)`，再取得最终的 `true` 或 `false`。

最终答案可以有三种来源，但回答的是同一个问题：

```text
--trust / --no-trust      → 用户在命令行提前给出答案。
agentDir/trust.json       → 读取以前保存过的答案，不再询问。
交互式弹窗                → 没有上述答案且模式为 interactive 时，让当前用户选择。
```

注意：

```text
projectTrusted             → 当前启动阶段先按什么状态读项目配置；未知时临时为 false。
resolveProjectTrusted(...) → 在没有现成答案时，真正取得最终 true / false 的流程。
```

### `buildSessionOptions(...)`：从输入资料得到创建选项

它定义在同一个 `main.ts` 的 `main()` 前面；当前主调用链走到这里时才调用它。

```ts
const {
  options: sessionOptions,
  cliThinkingFromModel,
  diagnostics: sessionOptionDiagnostics,
} = buildSessionOptions(
  parsed,
  scopedModels,
  sessionManager.buildSessionContext().messages.length > 0,
  modelRuntime,
  settingsManager,
);
```

不要理解为“把 5 个参数直接封装成 3 个对象”。实际是：

```text
5 个输入资料
→ buildSessionOptions 按模型、思考等级、工具等规则计算并校验
→ 返回 3 个结果
```

五个输入：

```text
parsed
→ 用户本次输入的 --model、--thinking、--tools 等已解析参数。

scopedModels
→ 前面确认过、当前实际可选的模型列表。

sessionManager.buildSessionContext().messages.length > 0
→ 当前 session 是否已有历史消息；true 表示旧 session，false 表示新 session。

modelRuntime
→ 查询模型、provider 与认证状态。

settingsManager
→ 读取默认模型、默认 provider 等设置。
```

三个返回结果：

```text
sessionOptions
→ 对象：最终模型、思考等级、工具等创建选项。

cliThinkingFromModel
→ 布尔值：思考等级是否来自用户写在 --model 中的简写。

sessionOptionDiagnostics
→ 数组：模型或工具参数的错误、警告。
```

其中两个字段使用了“取字段并改名”的语法：

```ts
options: sessionOptions
// 等价于 const sessionOptions = 返回结果.options;

diagnostics: sessionOptionDiagnostics
// 等价于 const sessionOptionDiagnostics = 返回结果.diagnostics;
```

## Day 4：创建结果包与思考等级覆盖

当前继续沿 `main.ts` 往下读，不进入每个被调用函数的内部；先走完整主链路，只有主动追问时才展开函数实现。

```ts
const created = await createAgentSessionFromServices({ ... });
```

这里 `created` 不是 `AgentSession` 本身，而是创建函数返回的结果包。当前文件没有直接写出这个对象，是被调用的创建函数组装后返回的。可以先理解为：

```text
created
└── session
    ├── thinkingLevel
    └── setThinkingLevel(...)
```

因此：

```ts
created.session.setThinkingLevel(created.session.thinkingLevel);
```

不是：

```ts
created.setThinkingLevel(...)
```

因为 `setThinkingLevel(...)` 是真正的 `AgentSession` 的方法；`created` 只是包着它的外层结果。

```ts
const cliThinkingOverride =
  parsed.thinking !== undefined || cliThinkingFromModel;
```

这行判断用户本次是否通过命令行明确指定思考等级：

```text
pi --thinking high
→ parsed.thinking !== undefined

pi --model openai/gpt-5:high
→ cliThinkingFromModel = true

两者任意一个成立
→ cliThinkingOverride = true
```

若已经创建出 session，且用户明确指定了思考等级，Pi 会在该 session 上再应用一次思考等级，确保本次命令的选择优先。

### 本次遇到的 TypeScript 语法

```ts
const { settingsManager, modelRuntime, resourceLoader } = services;
```

从 `services` 这个对象中取出三个字段，等价于：

```ts
const settingsManager = services.settingsManager;
const modelRuntime = services.modelRuntime;
const resourceLoader = services.resourceLoader;
```

```ts
const diagnostics = [...a, ...b];
```

数组前的 `...` 表示展开数组中的每一项：

```text
a = ["设置错误"]
b = ["扩展错误"]
→ diagnostics = ["设置错误", "扩展错误"]
```

```ts
errors.map(({ path, error }) => ({ type: "error", message: `...` }))
```

`.map(...)` 会遍历数组，把原来的每一项转换成新的一项。这里把每个扩展加载错误，统一转换为：

```ts
{ type: "error", message: "错误说明" }
```

### `createRuntime` 与 `AgentSessionRuntime`：三段职责

`main.ts` 到这里不再主要做用户输入的前置校验。可以按下面三段理解：

```text
前面的 main.ts
→ 处理用户输入、管理命令、参数错误、运行模式、Session 定位、项目可信状态等前置判断。

const createRuntime = async (...) => { ... }
→ 使用前面已确认的信息，准备 services、生成 sessionOptions、创建 AgentSession；
→ 最后把 AgentSession、services、diagnostics 等结果打包返回。

createAgentSessionRuntime(createRuntime, ...)
→ 调用 createRuntime 取得上面的结果包；
→ 再把结果封装为 AgentSessionRuntime，作为本次 Pi 进程后续使用的统一运行容器。
```

因此 `createRuntime` 的函数内容不是继续逐项校验用户输入，而是：

```text
前面：这次 Pi 能不能开始？
createRuntime：开始时要准备什么、创建什么？
createAgentSessionRuntime：怎样把创建结果装进统一运行容器？
```

### 为什么看起来像“创建了两次”

实际只创建一次 `AgentSession`：

```text
createAgentSessionFromServices(...)
→ 真正创建 AgentSession
→ 返回结果保存到 created

createRuntime 的 return { ...created, services, diagnostics }
→ 不创建任何对象；只是把创建结果交还给 createAgentSessionRuntime。

createAgentSessionRuntime(...)
→ 接到上述结果后，创建 AgentSessionRuntime。
→ 它是外层运行容器，不是第二个 AgentSession。
```

代码中的“返回给谁”要这样连起来看：

```ts
const runtime = await createAgentSessionRuntime(createRuntime, { ... });
```

这里把函数 `createRuntime` 当作参数交出去；当前行没有写 `createRuntime()`，所以不是在这里直接调用它。
但 `createAgentSessionRuntime` 的内部会执行：

```ts
const result = await createRuntime(options);
```

因此 `createRuntime` 里的：

```ts
return { ...created, services, diagnostics };
```

会交给上面的 `result`。随后外层函数用 `result` 创建 `AgentSessionRuntime`，最后将它交给 `runtime`。

```text
AgentSessionRuntime
├── session：已创建好的 AgentSession
├── services：模型、设置、资源加载等运行工具
├── diagnostics：启动问题清单
└── createRuntime：以后 /new、/resume、/fork 时可复用的创建配方
```

所以这里是“再封装”，不是“再创建一段对话”。

### stdin：普通管道输入和 RPC 输入的区别

两者都会进入 Pi 进程的 `stdin`，但其中的内容和读取方式不同：

```text
普通管道输入
→ 例如 echo "帮我修复 Bug" | pi
→ stdin 是一次性的普通文字；main.ts 用 readPipedStdin() 一次读完。
→ 文字作为一次用户任务交给模型，Pi 用 print 模式输出结果后退出。

RPC 输入
→ 例如 pi --mode rpc
→ stdin 传递的是格式固定的 RPC / JSON-RPC 命令，不是普通任务文字。
→ main.ts 不能先调用 readPipedStdin() 抢先读完；它保留 stdin 给后面的 runRpcMode(...) 持续读取多条命令。
```

因此：

```ts
if (appMode !== "rpc") {
  stdinContent = await readPipedStdin();
}
```

含义是：普通模式由 `main.ts` 读取一次性管道任务；RPC 模式把 stdin 留给 RPC 运行器。

### 不要混淆：用户文字进入 Pi 的三种方式

`stdinContent` 只表示管道输入，不是所有正常用户输入。三种来源分别是：

```text
1. 启动命令参数
   pi "帮我修复 Bug"
   → 文字来自命令行参数 process.argv。
   → parseArgs(args) 解析后放入 parsed.messages。

2. 正常交互输入
   pi
   → Pi 打开聊天界面后，用户继续用键盘输入消息。
   → stdin 是终端 TTY，可持续进行多轮对话。
   → 这不是 stdinContent。

3. 管道输入
   git diff | pi "帮我检查改动"
   → git diff 的输出通过 | 自动进入 Pi 的 stdin。
   → stdin 不是终端 TTY；通常一次读完，随后输入结束。
   → readPipedStdin() 读到的文字才是 stdinContent。
```

可以记成：

```text
pi "任务"                  → 启动参数
pi 后在界面继续打字         → 正常交互输入
git diff | pi "检查改动"    → 管道输入
```

### `prepareInitialMessage(...)`：把首条任务整理为可发送内容

```ts
const { initialMessage, initialImages } = await prepareInitialMessage(parsed, stdinContent);
time("prepareInitialMessage");
```

这不是创建 `AgentSession`，而是调用已实现的 `prepareInitialMessage(...)`，把结果对象中的两个字段取出来：

```text
parsed
→ 用户命令行参数：首条文字消息、@文件参数等。

stdinContent
→ 普通管道读到的文字；没有管道时为 undefined。

prepareInitialMessage(...)
→ 有 @文件时先异步读取文件文字和图片；没有 @文件时直接处理。
→ 再组合 stdin 文字、文件文字、首条命令行消息。

返回对象
├── initialMessage：可选的首条文字任务
└── initialImages：可选的首批图片
```

`await` 的意义是：若有 `@文件`，必须等文件内容读取完成，才能取得结果。

源码中会把 `parsed.messages` 的第一条放进 `initialMessage`，并从 `parsed.messages` 移除；剩余消息留给后续模式处理。`time("prepareInitialMessage")` 只记录该整理步骤的耗时。

### `appMode` 只决定一次，后面反复复用

`appMode` 在前面已经由 `resolveAppMode(...)` 确定；后面的代码不会反复“重新决定”模式，而是使用同一个结果控制不同步骤。

例如：

```ts
initTheme(settingsManager.getTheme(), appMode === "interactive");
```

第二个参数不是再次判断用户想要什么模式，而是复用已有答案：

```text
interactive → true  → 加载主题，并监听主题文件变化。
print/json/rpc → false → 加载主题一次，但不监听。
```

主题相关也有两步，不能混为一件事：

```text
前面的 --use-theme 判断
→ 用户本次是否临时指定主题名？若指定，先修改本次运行的设置值。

这里的 initTheme(...)
→ 读取最终主题名，并真正加载为 Pi 当前主题。
```

可以记成：

```text
前面：决定主题名
这里：实际加载主题
```

### 启动测速：定位 Pi 慢在哪一步

开发者可通过环境变量开启启动耗时统计：

```bash
PI_STARTUP_BENCHMARK=1 pi
```

它不会改变 Agent 对话逻辑，只会额外输出每个启动阶段的耗时，例如：

```text
parseArgs: 3ms
createSessionManager: 15ms
createRuntime: 420ms
initTheme: 8ms
interactiveMode.init: 170ms
```

用途是定位启动变慢的具体位置：读取配置、加载扩展、模型初始化，还是终端界面初始化。

源码中的限制：

```ts
if (startupBenchmark && appMode !== "interactive") {
  process.exit(1);
}
```

原因是启动测速会测量 `interactiveMode.init()`；只有 interactive 模式有聊天界面初始化步骤，print/json/rpc 没有。

注意 `printTimings()` 在 interactive 路径中出现两次，但同一次运行不会输出两次。原因是两处属于互斥分支：

```text
PI_STARTUP_BENCHMARK=1
→ 进入 if (startupBenchmark)
→ printTimings()
→ return
→ 跳过 if 外的第二个 printTimings()，也不进入正常聊天。

普通 pi
→ 不进入 if (startupBenchmark)
→ 跳过 if 内的 printTimings()
→ 执行 if 外的 printTimings()
→ 再进入 interactiveMode.run()。
```

两处的用途不同：

```text
if 内：测速结果输出后直接退出。
if 外：正常聊天开始前；只有 PI_TIMING=1 时才实际输出耗时。
```

### RPC 为什么后台刷新模型

RPC 是供其他程序长期调用 Pi 的模式；后续 Agent 请求需要知道当前可用模型、Provider 和认证状态。

```text
启动时
→ Pi 已有一份模型信息，足够让 RPC 先开始接收请求。

后台刷新
→ 更新模型目录、Provider 状态、认证可用状态等；避免长期运行后信息过期。
```

因此 Pi 不会串行等待：

```text
错误做法：先刷新模型 → 等网络完成 → 再启动 RPC

实际做法：开始后台刷新模型 → 不 await 等待 → 立刻继续启动 RPC
```

代码中的：

```ts
void modelRuntime.refresh({ signal: controller.signal });
```

表示刷新已开始，但 `main.ts` 不接收它的返回值、不在这里等待。`AbortController` 配合 15 秒计时器限制这次后台刷新；超时只停止刷新，不停止 RPC。本段仅在非离线的 RPC 模式运行；interactive 模式会在终端界面初始化后刷新模型。

## Day 5：`AgentSessionRuntime` 如何装入创建结果

阅读文件：`packages/coding-agent/src/core/agent-session-runtime.ts`

### 先分清两个不同动作

源码中同时出现 `createRuntime(options)` 和 `new AgentSessionRuntime(...)`，但它们做不同事情：

```ts
const result = await createRuntime(options);

return new AgentSessionRuntime(
  result.session,
  result.services,
  createRuntime,
  result.diagnostics,
  result.modelFallbackMessage,
);
```

真实顺序：

```text
main.ts 前面
→ 已定义 createRuntime 这份函数配方。

createRuntime(options)
→ 执行配方，创建 AgentSession、services、diagnostics 等内容。
→ 返回 result。

new AgentSessionRuntime(result...)
→ 创建外层 runtime 容器。
→ JavaScript 自动执行这个类的 constructor(...)。
→ constructor 把 result 中已有内容保存为 runtime 内部字段。
```

因此不是“创建两个 AgentSession”：

```text
createRuntime
→ 造出内容。

AgentSessionRuntime constructor
→ 创建外层容器时，接收并保存内容。
```

### constructor 为什么会自动执行

`constructor` 是 class 的特殊创建方法，不需要手动写 `constructor(...)` 调用。

```ts
new AgentSessionRuntime(...)
```

就会自动进入：

```ts
constructor(...) { ... }
```

最小例子：

```ts
class Box {
  constructor(value: string) {
    this.value = value;
  }
}

const box = new Box("苹果");
```

执行顺序：

```text
new Box("苹果")
→ 自动调用 constructor("苹果")
→ this.value = "苹果"
→ 得到 box 对象。
```

Pi 的参数对应关系：

```text
new AgentSessionRuntime(        constructor(
  result.session,           →     _session,
  result.services,          →     _services,
  createRuntime,            →     createRuntime,
  result.diagnostics,       →     _diagnostics,
  result.modelFallbackMessage →  _modelFallbackMessage,
)                                )
```

例如：

```ts
this._session = _session;
```

就是把：

```text
result.session
→ 保存到 runtime._session。
```

### `AgentSessionRuntime` 是什么盒子

它不是新的 AgentSession，而是管理“当前对话如何在 Pi 中运行、以后如何切换”的容器：

```text
AgentSessionRuntime
├── _session       → 当前对话本身
├── _services      → 当前项目绑定的模型、设置、资源工具
├── createRuntime  → 以后切换 session 时重新创建一套内容的配方
├── _diagnostics   → 启动问题
└── _modelFallbackMessage → 模型替换提示
```

`rebindSession?` 和 `beforeSessionInvalidate?` 是可选的 UI 回调：切换到新 session 时重新绑定界面、旧 session 失效前清理界面。

### 新建、恢复、分叉 session 的区别

三种操作都会让 runtime 最后使用一个新的“当前 session”，但新 session 的历史来源不同：

```text
新建 session（new）
→ 开始一段新对话；当前对话历史不带过去。

恢复旧 session（resume）
→ 打开以前保存的会话，继续它已有的历史。

分叉 session（fork）
→ 从当前会话历史的某个旧位置创建一条新分支；原会话不变，之后可在新分支中继续。
```

例子：

```text
原 session：
1. 用户：做登录功能
2. Agent：给出方案 A
3. 用户：按方案 A 实现
4. Agent：写出代码

此时从第 2 步后分叉：
→ 新 session 保留第 1、2 步；不带第 3、4 步。
→ 可以在新分支改走方案 B；原 session 仍完整保留。
```

因此 `new` 与 `resume` 共用 `emitBeforeSwitch(...)`：它们都是普通的“切换当前 session”。
`fork` 使用单独的 `emitBeforeFork(...)`：它还需要知道从哪条历史记录开始复制，扩展也可在分叉前取消操作。

恢复旧 session 时，Pi 的第一步不是马上关闭当前 session，而是先允许扩展拦截：

```text
切换旧 session 前
→ Pi 通知当前 session 中关心此事的扩展。
→ 没有扩展取消：继续切换。
→ 任一扩展取消：立即停止，当前 session 保持不变。
```

这里的“扩展”是给 Pi 添加功能的代码，例如项目 `.pi/extensions/` 中的扩展或 Pi 内置扩展。它们可以增加工具、命令、终端界面内容，也可以监听 session 的开始、关闭和切换。

切换前询问扩展不是向用户弹窗，而是让当前 session 中关心切换的扩展代码给出答案：

```text
没有扩展注册 session_before_switch 处理
→ Pi 直接继续切换。

扩展回答“继续”
→ cancelled = false
→ Pi 继续切换。

扩展回答“取消”
→ cancelled = true
→ Pi 不关闭当前 session，直接结束本次操作。
```

这样 Pi 不会在扩展仍依赖当前 session 时，直接把当前 session 换掉。

### 新建 session 会继承当前 session 的保存方式

`newSession(...)` 不会重新决定“是否把历史保存到文件”。它先检查当前 session 的保存方式，再让新 session 保持同样方式：

```text
当前 session 已保存到文件
→ 有实际 session 文件，例如 sessionDir/A.jsonl。
→ 新建 session 时，在同一个 sessionDir 创建新的文件，例如 B.jsonl。

当前 session 只存在内存中
→ 当前进程中有 session 对象，但此刻没有 session 文件。
→ 新建 session 时也只创建内存中的 session，不会突然创建文件。
```

因此这里的重点不是“此刻要不要保存历史”，而是：

```text
新 session 跟随当前 session 原本的保存方式。
```

### `fork`：从历史中间另开路线，而不是在原 session 继续

`fork` 会保留当前 session 的一部分历史，创建一个新的分支 session；原 session 完全不变。

```text
原 session：
1. 用户：做登录功能
2. Agent：方案 A
3. 用户：按方案 A 实现
4. Agent：写出方案 A 的代码
```

若在第 3 条记录处分叉：

```text
position = "before"
→ 新分支保留第 1、2 条；不带第 3、4 条。

position = "at"
→ 新分支保留第 1、2、3 条；不带第 4 条。
```

新分支可从那里改走方案 B；原 session 仍保存完整的方案 A 路线。

```text
直接在原 session 继续
→ 方案 A 的后续内容和方案 B 会混在同一条历史里。

fork
→ 原路线 A 保留。
→ 新路线 B 独立继续。
```

### 当前文件的阅读顺序

本文件按源码从上到下读，不因为 `/new`、`/resume`、`/fork`、`/import` 就直接跳过。

```text
结果包定义
→ createRuntime 函数规格
→ /import 文件不存在的自定义错误
→ 从混合消息提取文字的辅助函数
→ AgentSessionRuntime 类字段、constructor、getter
→ session 切换方法
→ createAgentSessionRuntime(...) 初始创建入口
```

但每次只读一小段；复杂方法先结合它在当前链路中的位置解释，再按需要进入具体参数和分支。

### `agent-session-runtime.ts`：首次创建、后续切换与退出

这个文件把“当前运行中的 session”放在 `AgentSessionRuntime` 里管理。

```text
首次启动
→ createAgentSessionRuntime(...)
→ 创建第一个 runtime

之后切换 session
→ switch / new / fork / import
→ createRuntime(...) 准备新内容
→ apply(...) 替换 runtime 当前内容

退出 Pi
→ dispose()
→ 通知扩展、清理、关闭当前 session
```

这里要区分两个名字相近的调用：

```text
createAgentSessionRuntime(...)
→ 第一次启动 Pi 时创建第一个 runtime。

this.createRuntime(...)
→ runtime 已经存在时，为新 session 创建 session、services 等替换内容。
→ 随后由 apply(...) 换入已有 runtime；不会再创建一个新的 runtime。
```

### `agent-session-services.ts`：扩展命令行参数的校验

扩展可自行声明命令行参数。代码先汇总所有扩展声明的参数，再逐个检查用户实际输入。

```text
registeredFlags
→ 扩展事先声明的“参数名 → 参数类型”。

extensionFlagValues
→ 用户本次实际输入的“参数名 → 参数值”。
```

两种参数：

```text
boolean
→ 开关参数；用户只要写了它，就保存为 true。
→ 例如：--dry-run → dry-run = true

string
→ 必须跟文字值。
→ 例如：--branch main → branch = "main"
```

处理顺序：

```text
用户输入参数
→ 到 registeredFlags 查询是否有扩展声明过它
→ 已知 boolean：保存 true
→ 已知 string 且有文字值：保存该文字值
→ 已知 string 但没有值：写入 diagnostics 错误
→ 未知参数：收集后写入 diagnostics 错误
```

### TypeScript：`??` 只在没有值时使用备用结果

```ts
A ?? B
```

表示：

```text
A 有值
→ 使用 A

A 是 undefined 或 null
→ 使用 B
```

本文件中的例子：

```ts
const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create(...));
```

```text
调用者已传入 modelRuntime
→ 直接复用。

调用者没传 modelRuntime
→ 等待 ModelRuntime.create(...) 创建一份新的。
```

### Day 7：`AgentSessionRuntime` 收尾与 `agent-session-services.ts` 开始

#### 导入 JSONL session：外部文件与已保存文件

`importFromJsonl(...)` 会先为导入文件确定 Pi session 文件夹中的目标路径：

```text
源文件在 Pi session 文件夹外，例如 Downloads/chat.jsonl
→ sourceAlreadyStored = false
→ 若同名文件存在，目标改为 chat-1.jsonl、chat-2.jsonl 等
→ 再复制进 Pi session 文件夹。

源文件本来就在 Pi session 文件夹的目标位置
→ sourceAlreadyStored = true
→ 不改名、不复制，直接使用该文件。
```

`SessionManager.open(destinationPath, ...)` 不新建 JSONL 或 session；它得到的是负责管理已有 session 文件的对象。导入成功后仍复用统一切换流程：

```text
teardownCurrent(...)
→ 结束旧 session
→ this.createRuntime(...)
→ 为导入 session 准备新内容
→ apply(...)
→ 替换已有 runtime 内部当前内容
→ finishSessionReplacement(...)
```

`dispose()` 是 Pi 退出时的收尾：通知扩展、执行外部清理、关闭当前 `AgentSession`。

#### 首次创建 runtime 与后续替换 session

```text
createAgentSessionRuntime(...)
→ Pi 第一次启动时创建第一个 AgentSessionRuntime。

this.createRuntime(...)
→ runtime 已存在时，为新 session 创建 session、services 等替换内容。
→ apply(...) 将这些内容换入已有 runtime；不会再创建新的 runtime。
```

#### `agent-session-services.ts`：准备 services，再创建 AgentSession

本文件将创建 `AgentSession` 分为两步：

```text
createAgentSessionServices(...)
→ 创建并返回 services。

services 的格式是 AgentSessionServices：
cwd、agentDir、modelRuntime、settingsManager、resourceLoader、diagnostics。

createAgentSessionFromServices({ services, sessionManager, ... })
→ 使用已准备好的 services 创建 AgentSession。
```

`options` 只是调用函数时传入的资料包变量名。例如：

```text
options.cwd
→ 当前项目目录。

options.agentDir
→ 可选的 Pi 全局目录。
```

#### 扩展命令行参数与模型 provider

扩展可自行声明命令行参数。代码先将所有扩展声明的参数汇总为 `registeredFlags`，再检查用户实际输入的 `extensionFlagValues`：

```text
boolean
→ 用户只要写了参数，就保存 true。
→ --dry-run → dry-run = true

string
→ 用户必须提供文字值。
→ --branch main → branch = "main"
```

`resourceLoader.reload(...)` 真正加载扩展、skills、提示词模板等资源。某些扩展还可在加载时请求新增模型 provider：

```text
扩展加载时调用 registerProvider(...)
→ 请求暂存在 pendingProviderRegistrations。

modelRuntime 准备完成
→ registerProvider(...) 真正登记该 provider。
→ 清空 pendingProviderRegistrations：清空的是已办完的待办，不是已登记的 provider。
```

### Day 8：`createAgentSessionFromServices(...)` 与 `return 函数调用结果`

`agent-session-services.ts` 的第二步函数不自己写 `new AgentSession(...)`，而是将已准备好的资料传给 `sdk.ts`：

```ts
return createAgentSession({
  cwd: options.services.cwd,
  modelRuntime: options.services.modelRuntime,
  sessionManager: options.sessionManager,
  // 还有设置、资源、模型、工具等资料
});
```

这行不是把 `createAgentSession({...})` 这段代码原样返回，而是按顺序：

```text
1. 先整理并传入创建 AgentSession 所需的资料。
2. 立刻调用 sdk.ts 中实现的 createAgentSession(...)。
3. sdk.ts 在内部真正创建 AgentSession。
4. 当前函数把 sdk.ts 返回的创建结果，直接交回上层。
```

可用简单例子记忆：

```ts
return add(1, 2);
```

表示先执行 `add(1, 2)` 得到 `3`，再 `return 3`；不是返回文字 `add(1, 2)`。

`createAgentSession(...)` 是异步函数，因此它先返回：

```text
Promise<CreateAgentSessionResult>
```

当前函数直接返回同一个 Promise；上层 `await` 后才拿到真实创建结果。

### `streamFn`：默认执行者与实际调用参数

```ts
setDefaultStreamFn(streamSimple);
```

这一行只登记默认执行者：

```text
默认 streamFn = streamSimple
```

它不会立刻请求模型，也不会传入 `model`、`context`、`options`。此时 session 尚未创建，因此还不知道本次选中哪个模型、用户输入了什么内容。

之后真正请求模型时，才会调用被选中的函数：

```ts
streamFn(model, context, options)
```

```text
model
→ 本次选中的模型。

context
→ 系统提示词、历史消息、当前用户输入等要发送的内容。

options
→ 本次请求的超时、重试等设置。
```

因此：

```text
默认值
→ 默认由哪个函数执行模型请求。

传参
→ 真正执行时，本次要处理的具体资料。
```

### TypeScript：连续 `??` 按优先级选择第一个可用值

```ts
A ?? B ?? C
```

表示从左到右选择第一个不是 `undefined` 或 `null` 的值：

```text
A 有值
→ 使用 A。

A 没有值、B 有值
→ 使用 B。

A、B 都没有值
→ 使用 C。
```

`sdk.ts` 中确定项目目录的例子：

```ts
const cwd = options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd();
```

```text
调用者明确传入 cwd
→ 使用 options.cwd。

否则，传入 sessionManager
→ 使用该 session 所属项目的 cwd。

两者都没有
→ 使用 Pi 进程在终端启动时所在的目录 process.cwd()。
```

### `sdk.ts` 的职责：复用已有对象，或补齐默认对象

`sdk.ts` 不负责实现模型、设置、session、资源加载器这些对象本身；它只是负责在创建 `AgentSession` 前保证它们都存在：

```text
调用者已传入现成对象
→ 直接复用。

调用者没有传入
→ 调用其他文件已经实现好的 create(...) 或 new ... 补齐默认对象。
```

当前代码中的对应关系：

```text
ModelRuntime.create(...)
→ model-runtime.ts 中已实现。

SettingsManager.create(...)
→ settings-manager.ts 中已实现。

SessionManager.create(...)
→ session-manager.ts 中已实现。

new DefaultResourceLoader(...)
→ resource-loader.ts 中已实现。
```

### 工具列表：`?.some(...)` 与“修改默认工具”

```ts
const toolModifiers = options.tools?.some(isToolModifier) ? options.tools : undefined;
const selectedToolNames = toolModifiers
	? applyToolModifiers(defaultToolNames, toolModifiers)
	: options.tools;
```

`options.tools` 是用户本次传入的工具数组。

```ts
options.tools?.some(isToolModifier)
```

含义是：`options.tools` 有值时，逐个检查数组元素；只要其中一个是 `+write`、`-bash` 这类修改符号，就得到 `true`。`?.` 表示数组不存在时，不调用 `.some(...)`，直接得到 `undefined`。

```text
["read", "write"]
→ 直接指定最终工具列表。

["+write", "-bash"]
→ 在默认工具列表上增加 write、移除 bash。
```

三元表达式：

```ts
条件 ? 条件为真时的值 : 条件为假时的值
```

因此有修改符号时，`applyToolModifiers(...)` 根据默认列表算出最终列表；没有修改符号时，用户传入的数组就是最终列表。

`options.noTools` 不是“用户没有设置工具”，而是 `main.ts` 根据用户命令行参数写入的禁用指令：

```text
pi --no-tools
→ options.noTools = "all"
→ 关闭全部工具。

pi --no-builtin-tools
→ options.noTools = "builtin"
→ 关闭 Pi 内置工具。
```

`allowedToolNames` 是给整个 session 的允许名单；与“启动时选中了哪些工具”不同。

```text
pi --tools +write
→ 只是在默认工具列表中加入 write。
→ allowedToolNames = undefined：不设置只能使用哪些工具的硬限制。

pi --no-tools --tools +write
→ 先关闭全部工具，再明确加回 write。
→ allowedToolNames = ["write"]：session 只允许 write。
```

`allowedToolNames` 与 `initialActiveToolNames` 的区别：

```text
allowedToolNames
→ 整个 AgentSession 期间允许使用哪些工具。
→ 后续重新加载或启用工具时，仍会检查这份名单。

initialActiveToolNames
→ Pi 刚启动时先启用哪些工具。
→ 它会再移除 --exclude-tools 指定的工具。
```

例如用户在终端输入：

```bash
pi --tools read,write
```

参数解析后：

```ts
options.tools = ["read", "write"];
allowedToolNames = ["read", "write"];
```

本次 session 中，模型只能看到并调用 `read`、`write`。命令行是用户这次明确指定的要求，因此会覆盖“用户没有指定时才使用”的默认工具配置。

### 用户文字与图片统一为内容块数组

正常用户输入会先被 Pi 封装为内容块数组，再作为 user message 的 `content`：

```text
输入 hello
→ content = [{ type: "text", text: "hello" }]

输入文字加图片
→ content = [
    { type: "text", text: "帮我看这张图" },
    { type: "image", data: "...", mimeType: "image/png" },
  ]
```

因此 `convertToLlmWithBlockImages(...)` 中：

```text
converted.map(...)
→ 逐条处理所有转换后的模型消息。

user / toolResult + content 是数组
→ 用 content.some(...) 检查是否包含图片。

hasImages = true
→ 才会用 content.map(...) 把图片块替换为 “Image reading is disabled.”。

hello 这类纯文字
→ 仍会检查数组，但 hasImages = false，原消息不变。
```

## 每日记录模板

### Day N：主题

- 阅读文件：
- 输入：
- 核心逻辑：
- 输出或状态变化：
- 下一步调用：
- 新学到的 TypeScript：
- 仍然不懂的问题：
