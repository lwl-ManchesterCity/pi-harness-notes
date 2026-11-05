# 2026-11-04：Agent Loop 的核心类型

## 今天的目标

先建立单 Agent Loop 的数据地图：上下文、运行配置、事件和工具各保存什么。

## 阅读范围

- `packages/agent/src/types.ts`

## 调用链

```text
Agent.prompt(...)
→ AgentContext（消息与可执行工具）
→ AgentLoopConfig（模型请求与运行回调）
→ Agent Loop 发出 AgentEvent
→ AgentTool.execute(...) 执行模型请求的工具
```

## AgentContext

```ts
interface AgentContext {
  messages: AgentMessage[];
  tools?: AgentTool<any>[];
}
```

- `messages` 是完整的模型工作上下文。assistant 回复和 `toolResult` 会继续追加到这里，供下一轮模型请求使用。
- `tools` 是 Pi 本地可执行的工具。模型只产生 `toolCall`；Pi 再按工具名从这里找到并执行工具。

## AgentLoopConfig

`AgentLoopConfig` 是启动一次 loop 的配置对象。

- `model`：本轮要请求的模型。
- `convertToLlm(messages)`：将 Pi 内部的 `AgentMessage[]` 转成模型可接收的 `Message[]`。
  - 返回 `Message[]`：立即完成。
  - 返回 `Promise<Message[]>`：异步完成后得到消息数组。
- `transformContext`：转换为模型消息前，先异步处理上下文。
- `getApiKey`：按 provider 获取 API Key。
- `finishTurn`：一轮 assistant 回复及工具结果完成后，决定结束或继续。
- `prepareRequest`：每次模型请求前，可调整本次请求的 context、model 或 thinking level。
- `prepareNextTurn`：上一轮结束、下一轮开始前，可调整下一轮状态。
- `getSteeringMessages`：取得运行中插入下一轮的消息。
- `getFollowUpMessages`：Agent 本应结束时，取得要继续处理的消息。
- `toolExecution`：多个工具调用采用顺序或并行执行。
- `beforeToolCall` / `afterToolCall`：工具执行前后拦截或调整结果。

## AgentEvent

`AgentEvent` 是事件对象的格式规范。每个事件的 `type` 值决定必须带哪些字段。

```text
agent_start                  → 无额外字段
agent_end                    → messages
turn_start                   → 无额外字段
turn_end                     → message, toolResults
message_start/update/end     → message（update 另有 assistantMessageEvent）
tool_execution_start         → toolCallId, toolName, args
tool_execution_update        → toolCallId, toolName, args, partialResult
tool_execution_end           → toolCallId, toolName, result, isError, durationMs?
```

`agent_end.messages` 是本次运行新增的消息记录，不是完整历史上下文；完整历史在 `context.messages`。

## AgentTool

`AgentTool` 继承基础 `Tool`，因此同时拥有基础工具信息和 Pi 的执行字段。

```text
Tool 提供：name、description、parameters
AgentTool 增加：label、execute、replay、executionMode 等
```

- `TParameters` 是工具参数规则的 Schema 类型。
- `Static<TParameters>` 是根据该 Schema 推导出的实际参数对象类型。
- 例如参数规则要求 `path` 为字符串时，实际参数对象是 `{ path: string }`。
- `execute(toolCallId, params, signal, onUpdate)` 异步返回最终工具结果。

`AgentTool` 接口只规定 `execute` 必须接收哪些输入、最终返回哪种结果；它不在这里调用工具。具体工具作者会实现 `execute`，之后 Agent Loop 才通过 `tool.execute(...)` 调用该实现。

```text
tool.execute(...) 的括号内是输入：toolCallId、params、signal、onUpdate
await tool.execute(...) 的最终结果是 AgentToolResult
```

## 必要的 TypeScript

- `interface`：规定对象应有哪些字段。
- `extends`：继承基础类型的字段。
- `?`：字段或参数可省略。
- `A | B`：值可以是 A 或 B。
- `Promise<T>`：异步操作完成后得到 T。
- `type AgentEvent = A | B`：事件可以是多种对象格式之一。

## Harness 设计收获

Pi 将模型上下文、执行工具、运行配置和 UI/Session 事件分开：模型读取 `messages`，Pi 执行 `tools`，外部通过 `AgentEvent` 观察持续过程。

## 未解决问题

- [ ] `runLoop()` 如何把 `toolResult` 追加到 `context.messages` 后发起下一轮模型请求？
- [ ] `AgentEvent` 在 `Agent` 中如何被转发给 Session 和 UI？
