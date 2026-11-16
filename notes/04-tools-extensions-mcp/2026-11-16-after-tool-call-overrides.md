# 2026-11-16：执行后 Hook 的结果覆盖

## 当前阅读位置

`packages/agent/src/agent-loop.ts` 的 `finalizeExecutedToolCall()`。

执行后 Hook 可以返回覆盖项，Pi 先决定最终使用哪份 `structuredContent`：

```ts
const structuredContent =
	afterResult.structuredContent ??
	(afterResult.content ? undefined : result.structuredContent);
```

## 当前表达式的语法

`??` 表示“左边不是 `null` 或 `undefined` 时用左边；否则用右边”。

```ts
afterResult.structuredContent ?? fallback
```

等价于：Hook 明确返回 `structuredContent` 时使用它；否则计算 `fallback`。

三元表达式的结构是：

```ts
条件 ? 条件为真时的值 : 条件为假时的值
```

这里的三元表达式是：

```ts
afterResult.content ? undefined : result.structuredContent
```

含义是：Hook 改了普通 `content`、但没有给新的 `structuredContent` 时，返回 `undefined`；Hook 连普通 `content` 也没有改时，保留 Tool 原来的 `structuredContent`。

## 三种结果

```text
Hook 返回 structuredContent
→ 使用 Hook 的 structuredContent

Hook 只返回 content
→ structuredContent 设为 undefined，后续删除旧值

Hook 两者都不返回
→ 保留 Tool 原来的 structuredContent
```

这样可以避免普通内容已被 Hook 改写，旧的结构化内容却仍然保留并与新内容不一致。

## 从执行结果到模型 API

`finalizeExecutedToolCall()` 返回的 `finalized` 只是 Pi 执行过程中的临时对象，不会直接进入模型上下文。

```text
finalized
→ createToolResultMessage(finalized)
→ Pi 内部统一的 toolResultMessage
→ 加入 AgentContext.messages
→ 下一轮请求前由 convertToLlm()
→ 模型 API 接受的 ToolResult 格式
```

因此有两次不同的转换：

1. `createToolResultMessage()`：把执行结果封装成 Pi 内部可记录、可发事件、可加入上下文的 `toolResult` 消息。
2. `convertToLlm()`：把上下文中的 `toolResultMessage` 转成具体模型 API 所需的消息格式。

## 一批工具的 terminate

`shouldTerminateToolBatch(finalizedCalls)` 检查已处理工具的最终结果。至少处理过一个工具，且每个已处理工具都返回 `terminate: true` 时，整批才返回 `true`。

假设一批有 `read` 和 `bash` 两个调用：

```text
read: true，bash: true → 整批 true，不因这批工具结果继续请求模型
read: true，bash: false → 整批 false，模型可以继续处理工具结果
```

这是针对工具结果的继续判断；其他排队消息或运行控制仍可能影响后续流程。

## 并行工具调用：准备与执行

`executeToolCallsParallel()` 并不是从循环开始就并行执行。假设模型依次请求 `read` 和 `bash`：

```text
准备阶段：按原顺序逐个发开始事件、等待 prepareToolCall()
→ 准备失败的调用保存即时结果
→ 准备成功的调用保存待执行函数
→ 执行阶段：Promise.all() 启动待执行函数，并行运行工具
```

结果仍按模型原有的调用顺序整理，即使后面的工具先执行完。

例如：

```text
第 1 次循环：准备 read
→ read 准备完成
→ 在本次循环里处理 read 的准备结果

第 2 次循环：准备 bash
→ bash 准备完成
→ 在本次循环里处理 bash 的准备结果

循环结束
→ 走到循环外的 Promise.all()
→ 并行执行准备成功的工具
```

循环里保存的是函数，而不是工具的执行结果：

```ts
finalizedCalls.push(async () => {
	// 检查取消、执行 Tool、处理并返回结果
});
```

这里先定义将来执行 Tool 的流程，再用 `push` 把函数存进数组；此时函数体尚未运行。循环结束后，Pi 调用这些函数，才开始执行其中的流程。

## satisfies 类型检查

```ts
const finalized = {
	toolCall,
	result: preparation.result,
	isError: preparation.isError,
} satisfies FinalizedToolCallOutcome;
```

`satisfies` 让 TypeScript 检查这个对象是否符合 `FinalizedToolCallOutcome` 的要求；如果缺少必需字段或字段类型不符，会报类型错误。它不会在运行时修改对象。

## 八个内置工具

`packages/coding-agent/src/core/tools/index.ts` 支持创建以下内置 Tool 定义：

| 工具 | 用途 |
| --- | --- |
| `read` | 读取文件内容 |
| `bash` | 执行 Shell 命令并返回输出 |
| `powershell` | 执行 PowerShell 命令并返回输出 |
| `edit` | 定位并替换文件中的指定文本 |
| `write` | 向文件写入内容 |
| `grep` | 按模式搜索文件内容 |
| `find` | 按 glob 模式查找文件路径 |
| `ls` | 列出目录内容 |

这些是内置工具定义，并不意味着全部默认启用；Extension、MCP 和 SDK 也可以提供其他 Tool。
