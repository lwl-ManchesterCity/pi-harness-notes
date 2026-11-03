# 2026-10-28：项目资源信任与 AgentSession 服务准备

## 今天的目标

理解 Pi 在创建 `AgentSession` 前，为什么要先确认项目是否可信，以及 `createAgentSessionServices(...)` 如何准备运行所需内容。

## 阅读范围

- `packages/coding-agent/src/main.ts`
- `packages/coding-agent/src/core/project-trust.ts`
- `packages/coding-agent/src/core/settings-manager.ts`
- `packages/coding-agent/src/core/model-resolver.ts`

## 当前调用链

```text
main.ts
  → createRuntime(...)
  → 判断项目资源是否需要信任确认
  → SettingsManager.create(...)
  → createAgentSessionServices(...)
  → 收集 diagnostics、确定可选模型
  → buildSessionOptions(...)
  → createAgentSessionFromServices(...)
```

## 项目可信的真正意义

Pi 信任项目，意思是允许 Pi 使用该项目交给它的 `.pi/` 内容：

```text
.pi/settings.json  → 项目设置
.pi/extensions     → 扩展代码
.pi/skills         → 项目技能
.pi/mcp.json       → MCP 配置
.pi/prompts        → 提示词模板
```

陌生项目不能一打开就自动加载这些内容，因为它们能改变 Pi 的行为，扩展还可能执行项目代码。

## 两层职责：检查整套资源，读取设置文件

```ts
const hasTrustRequiringResources = hasTrustRequiringProjectResources(cwd);
```

这行检查整套项目资源。只要 `settings`、`extensions`、`skills`、`MCP`、`prompts` 等任意一项存在，就需要项目级信任判断。

```ts
const runtimeSettingsManager = SettingsManager.create(cwd, agentDir, {
  projectTrusted,
});
```

`SettingsManager` 只负责设置文件，所以它只根据 `projectTrusted` 决定能否读取：

```text
projectTrusted = true
→ 读取 cwd/.pi/settings.json

projectTrusted = false
→ 仍读取 Pi 全局设置，但跳过 cwd/.pi/settings.json
```

扩展、技能、MCP、提示词等其余项目资源，后面由资源加载器使用同一个最终信任结果决定是否加载。

## 两个容易混淆的变量

```ts
const shouldResolveProjectTrust = ...;
const projectTrusted = shouldResolveProjectTrust ? false : ...;
```

它们回答不同问题：

```text
shouldResolveProjectTrust
→ “现在还要不要取得信任答案？”

projectTrusted
→ “当前这一刻，能不能读取项目 .pi/ 设置？”
```

当项目有 `.pi/` 资源、没有缓存结果、用户也没有传 `--trust` 或 `--no-trust` 时：

```text
shouldResolveProjectTrust = true
projectTrusted = false
```

这不是最终拒绝项目，而是“最终答案尚未取得前，先不要读取陌生项目的配置”。

## 最终信任答案从哪里来

Pi 最终要回答的问题只有一个：

```text
“是否允许 Pi 使用这个项目的 .pi/ 配置和资源？”
```

```text
信任     → trusted = true  → 加载项目资源
不信任   → trusted = false → 不加载项目资源
```

答案可能来自：

```text
--trust / --no-trust
→ 用户在命令行提前给出答案。

agentDir/trust.json
→ 读取以前保存过的答案，不再询问。

交互式弹窗
→ 没有前两种答案且为 interactive 模式时，交给当前用户选择。
```

`resolveProjectTrust(...)` 是给资源加载器使用的中转函数：资源加载器需要确认时调用它；它再调用 `resolveProjectTrusted(...)`，取得最终 `true` 或 `false`，缓存结果并交还给资源加载器。

## `createAgentSessionServices(...)`

```ts
const services = await createAgentSessionServices({ ... });
```

这不是定义函数，而是调用另一个文件已经实现好的异步函数：

```text
agent-session-services.ts
→ 写明怎样准备 services

main.ts
→ 调用它，等待准备完成，再拿到 services
```

`services` 是创建 `AgentSession` 前准备好的工具箱。当前调用传入的关键信息：

```text
cwd
→ 当前 session 所属项目目录；从这里读取项目资源。

agentDir
→ Pi 全局目录；从这里读取全局设置、认证和数据。

settingsManager
→ 已按项目可信状态创建的设置管理器。

modelRuntimeSignal
→ 模型初始化最多等待 15 秒，超时则取消。

extensionFlagValues
→ Pi 本身不认识、但可能属于扩展的命令行参数。

resourceLoaderReloadOptions
→ 资源加载时若需要信任确认，应该调用的处理流程。

resourceLoaderOptions
→ 去哪里找资源、哪些类别不加载、系统提示词如何处理。
```

资源加载规则中：

```text
additionalSkillPaths 等
→ 用户通过 --skill、--theme 等额外指定的资源目录。

noSkills、noThemes 等
→ 用户通过 --no-* 禁用相应类别。

--no-mcp
→ 禁用 Pi 内置的 mcp 扩展。

systemPrompt / appendSystemPrompt
→ 替换默认系统提示词 / 在默认提示词后追加内容。
```

## `services` 返回后的三项

```ts
const { settingsManager, modelRuntime, resourceLoader } = services;
```

```text
settingsManager → 读取最终设置
modelRuntime    → 管理 AI 模型与认证
resourceLoader  → 管理已加载的项目资源
```

这行只是从 `services` 对象取字段，不会再次创建它们。

## 启动诊断与可选模型

Pi 将信任判断、服务准备、设置读取、扩展加载发现的错误和警告合并到：

```ts
const diagnostics = [...];
```

此时只是收集问题，尚未立即输出。

随后确定模型范围：

```text
用户传 --models
→ 优先使用这次给出的模型名单。

用户未传 --models
→ 读取设置中的默认启用模型名单。

resolveModelScope(...)
→ 与当前实际可用的 provider 和认证状态对照，得到 scopedModels。
```

`scopedModels` 是“本次可从中选择的模型”，不是本次最终必定使用的模型；最终模型、思考等级和工具选项由后面的 `buildSessionOptions(...)` 组装。

## `buildSessionOptions(...)`：从输入资料得到创建选项

它定义在同一个 `main.ts` 的 `main()` 前面；当前主调用链走到这里时才调用它：

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

它不是把五个参数直接打包成三个对象，而是：

```text
5 个输入资料
→ 按模型、思考等级、工具等规则计算并校验
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

这里的 TypeScript “取字段并改名”：

```ts
options: sessionOptions
// 等价于 const sessionOptions = 返回结果.options;

diagnostics: sessionOptionDiagnostics
// 等价于 const sessionOptionDiagnostics = 返回结果.diagnostics;
```

## 必要的 TypeScript

```ts
const { settingsManager, modelRuntime } = services;
```

从对象中取字段，等价于：

```ts
const settingsManager = services.settingsManager;
const modelRuntime = services.modelRuntime;
```

```ts
const all = [...a, ...b];
```

数组中的 `...` 会展开每一项：

```text
["设置错误"] + ["扩展错误"]
→ ["设置错误", "扩展错误"]
```

```ts
items.map((item) => newItem)
```

`.map(...)` 遍历数组，将每一项转换为新的结果。例如 Pi 将每个扩展加载错误转换为统一的：

```ts
{ type: "error", message: "错误说明" }
```

## 今天的结论

```text
项目级信任不是单独为了读取 settings.json，
而是 Pi 使用整套项目 .pi/ 资源前的总开关。

在没有答案前，Pi 先关闭项目设置读取；
再通过命令行、trust.json 或交互式弹窗取得最终 true / false。

AgentSession 创建前，Pi 先通过 createAgentSessionServices(...) 准备设置、模型、认证和资源加载能力。
```

## 下次从这里继续

`main.ts` 的 `buildSessionOptions(...)` 与：

```ts
const created = await createAgentSessionFromServices({ ... });
```

这里会把已经准备好的 `services` 和具体 session 选项交给真正创建 `AgentSession` 的流程。
