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

## 每日记录模板

### Day N：主题

- 阅读文件：
- 输入：
- 核心逻辑：
- 输出或状态变化：
- 下一步调用：
- 新学到的 TypeScript：
- 仍然不懂的问题：
