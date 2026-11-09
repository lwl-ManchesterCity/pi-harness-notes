# 2026-11-09：工具结果与 `finishTurn()` 决策

## 工具结果写回

工具执行完成后，每条 `toolResult` 同时写入两个数组：

```ts
currentContext.messages.push(result);
newMessages.push(result);
```

```text
currentContext.messages
= 下一次模型请求可读取的完整上下文

newMessages
= 本次 runAgentLoop 从开始到结束新增的全部消息，外层最终返回
```

`newMessages` 不包含本次运行开始前的旧历史；但包含本次运行内部前一轮新增的消息。

## `terminate`

工具执行批次返回：

```ts
{
	messages: ToolResultMessage[],
	terminate: boolean,
}
```

```text
terminate: false
→ 工具结果交回模型
→ 内层循环继续

terminate: true
→ 不再因为这批工具结果请求模型
→ 内层循环不因工具结果继续
```

正常 `read` 工具通常是 `terminate: false`：文件内容仍需模型读取和回答。内层循环更常见的正常退出原因，是模型之后生成了一条没有 `toolCall` 的 assistant 消息，而不是必须出现 `terminate: true`。

`terminate` 不是 `toolResult.content` 中的文本，而是工具执行批次返回的布尔标记：

```ts
const executedToolBatch = await executeToolCalls(...);

hasMoreToolCalls = !executedToolBatch.terminate;
```

```text
executedToolBatch.terminate = false
→ hasMoreToolCalls = true
→ toolResult 交给模型继续处理

executedToolBatch.terminate = true
→ hasMoreToolCalls = false
→ 不再因为这批工具结果请求模型
```

## `finishTurn()`

每轮完成时，`runLoop()` 调用：

```ts
const decision = await config.finishTurn?.(lastCompletedTurn, signal);
```

`finishTurn` 没有 Pi 固定的内部判断。它是创建 `Agent` 时由外部代码可选传入的函数：

```ts
this.finishTurn = runtimeOptions.finishTurn;
```

因此具体规则由使用 Agent 的代码自己定义。它接收：

```text
turn.message
turn.toolResults
turn.context
turn.newMessages
```

并可返回：

```text
undefined
→ 不作额外决定，按默认流程继续

{ action: "continue" }
→ 明确要求再继续一轮

{ action: "end" }
→ 发出 agent_end 并退出整个 runLoop
```

## steering 与 follow-up：谁决定使用哪一个

Pi 内部提供两条队列和不同处理时机：

```ts
agent.steer(message);
agent.followUp(message);
```

消息本身通常没有自动标签说“我是 steering”或“我是 follow-up”。由上层应用根据用户意图决定调用哪个方法：

```ts
function handleUserMessage(message: AgentMessage, intent: "steer" | "followUp") {
	if (intent === "steer") {
		agent.steer(message);
	} else {
		agent.followUp(message);
	}
}
```

```text
用户希望立刻改变当前任务方向
→ agent.steer(message)
→ 当前内层循环优先处理

用户希望当前任务完成后再做下一件事
→ agent.followUp(message)
→ 内层循环自然结束后才读取
```

## 模型流式消息：开始时追加，更新时替换

`streamAssistantResponse()` 收到模型的 `start` 事件时，消息第一次进入上下文：

```ts
partialMessage = event.partial;
context.messages.push(partialMessage);
addedPartial = true;
```

后续收到文字、思考或工具调用的更新事件时，更新的是同一条尚未完成的 assistant 消息：

```ts
partialMessage = event.partial;
context.messages[context.messages.length - 1] = partialMessage;
```

例如回复逐渐变为“我”“我来”“我来读取文件”。如果每次都 `push()`，会把同一条回复存成三条；替换最后一条后，`context.messages` 中始终只有当前最新版本。代码随后发出 `message_update` 事件，通知外部消息已更新。

## `executeToolCalls()`：选择工具执行方式

`runLoop()` 从 assistant 消息中发现 `toolCall` 后，调用 `executeToolCalls()`。这个函数再次从消息内容中筛出本次所有工具调用，然后选择执行方式：

```ts
if (config.toolExecution === "sequential" || hasSequentialToolCall) {
	return executeToolCallsSequential(...);
}

return executeToolCallsParallel(...);
```

```text
整体配置要求 sequential
或本批任一工具要求 sequential
→ 顺序执行：一个接一个

否则
→ 并行执行
```

完成后返回 `ExecutedToolCallBatch`，其中 `messages` 是工具结果，`terminate` 表示是否终止工具后的继续流程。

## 顺序执行：两个结果数组

每处理完一个工具，代码会分别追加到两个数组：

```ts
finalizedCalls.push(finalized);
messages.push(toolResultMessage);
```

```text
finalizedCalls
→ 保存每个工具调用的最终处理结果
→ 用来判断已处理的工具是否全部要求 terminate

messages
→ 保存整理好的 toolResult 消息
→ 返回给 runLoop，供后续写入上下文
```

如果 `signal?.aborted` 为真，`break` 会停止处理剩余工具。函数随后返回已处理工具的 `messages` 和整批 `terminate`。`terminate` 只有在至少处理过一个工具、且每个已处理工具的 `result.terminate` 都为 `true` 时才为 `true`。

这里工具的 `for` 循环已经结束；返回的 `terminate` 是给外层 Agent 循环判断是否继续使用这批工具结果请求模型的。

## Week 2 验收：一次 `read` 调用

以下是正常运行的示例：没有取消、steering、follow-up 或工具终止。

```text
用户：读取 package.json
→ agent_start
→ turn_start
→ 用户消息的 message_start / message_end

→ 第一次请求模型
→ assistant message_start / message_update / message_end
  （assistant 消息包含 read 的 toolCall）

→ tool_execution_start
→ read.execute(...) 读取文件
→ tool_execution_end
→ toolResult 的 message_start / message_end
→ toolResult 写入 currentContext.messages 和 newMessages
→ turn_end

→ turn_start
→ 第二次请求模型，模型从上下文读取 toolResult
→ assistant message_start / message_update / message_end
  （模型给出最终回复）
→ turn_end
→ agent_end，携带 newMessages
```

主闭环是：

```text
assistant toolCall
→ read 执行
→ toolResult 写入 currentContext.messages
→ 下一次请求模型时，模型读到 toolResult
→ assistant 继续回答
```

`currentContext.messages` 是模型使用的完整上下文；`newMessages` 是本次 Agent 运行新增的消息，最终作为结果返回。

## 取消链路

本次运行的同一个 `signal` 会传给模型请求 `streamFunction(...)`，也会传给工具的 `execute(...)`。取消运行后，模型和工具都可以通过该信号得知取消状态。

本周主链已读通。测试文件和工具准备函数内部暂时跳过，需要时再回看。
