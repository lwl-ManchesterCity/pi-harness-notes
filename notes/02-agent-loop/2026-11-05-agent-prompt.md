# 2026-11-05：Agent.prompt() 的入口与重载

## 今天的目标

理解用户输入如何进入 `Agent.prompt()`，以及为什么这个函数写了两个对外调用签名和一个实际实现。

## 阅读范围

- `packages/agent/src/agent.ts`，`Agent.prompt()`（第 324–334 行）

## 调用链

```text
外部调用 Agent.prompt(...)
→ 检查 activeRun
→ normalizePromptInput(input, images)
→ runPromptMessages(messages)
```

## 输入

`prompt()` 对外允许四种正确调用：

```ts
agent.prompt("读取 package.json");
agent.prompt("读取 package.json", images);
agent.prompt(message);
agent.prompt([message1, message2]);
```

其中：

- 字符串输入可以带可选图片数组。
- 已准备好的 `AgentMessage` 或消息数组不能带图片数组。

## 核心逻辑

源码前两行是对外调用签名：

```ts
async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
async prompt(input: string, images?: ImageContent[]): Promise<void>;
```

第三行带函数体，是实际实现：

```ts
async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
```

实现签名必须接收 `images`，因为字符串输入可以携带图片；但 TypeScript 对外只使用前两个签名检查调用格式。因此它会阻止：

```ts
agent.prompt(message, images);
```

这类调用。若允许它，`normalizePromptInput()` 在看到非字符串 `message` 时会直接返回该消息，图片不会被使用。

`this.activeRun` 表示当前是否已有 Agent Loop 正在运行。已有运行时，`prompt()` 抛出错误，防止两个 loop 同时修改同一个 Agent 的状态。

## 输出与状态变化

`prompt()` 返回 `Promise<void>`，不直接返回模型回答。它等待本次 Agent Loop 结束。

当前函数先得到统一的 `AgentMessage[]`，再交给 `runPromptMessages()`；该函数本身不直接修改 `this._state.messages`。

## 下一步调用谁

```ts
await this.runPromptMessages(messages);
```

下一步阅读 `runPromptMessages()` 如何创建 `AgentContext`、`AgentLoopConfig` 并调用 `runAgentLoop()`。

## 必要的 TypeScript

- 函数重载：前两行规定外部可用的调用格式；带函数体的第三行是真正实现。
- `A | B`：参数可以是 A 或 B。
- `images?`：图片参数可省略。
- `Promise<void>`：异步完成，但不返回具体结果值。

---

## Agent.continue()：根据队列决定是否启动下一轮

## 阅读范围

- `packages/agent/src/agent.ts`，`Agent.continue()`（第 342–378 行）

## 这段代码的位置

`continue()` 不接收新的用户输入。它在已有 `context.messages` 的基础上，根据最后一条消息和两个队列，决定是否可以开始下一轮 Agent Loop。

## 核心判断

若已有 Agent Loop 在运行，`this.activeRun` 为真，不能同时再运行一次 `continue()`。

接着读取完整上下文中的最后一条消息：

```ts
const lastMessage = this._state.messages[this._state.messages.length - 1];
```

若没有消息，或上下文只有 `system` 消息，则没有可继续的对话。

当最后一条消息是 `assistant` 时，`continue()` 不会直接请求模型，而是按以下优先级检查消息队列：

```text
steeringQueue
→ followUpQueue
→ 两者都为空则报错
```

## steering 与 follow-up

`steering` 是优先的纠正或转向消息。它由 `agent.steer(message)` 放入 `steeringQueue`：

```ts
steer(message: AgentMessage): void {
	this.steeringQueue.enqueue(message);
}
```

例子：`“停止修改文件，只告诉我原因”`。下一轮应优先听从这类消息。

`followUp` 是普通的后续请求。它由 `agent.followUp(message)` 放入 `followUpQueue`。

例子：`“再帮我总结成三点”`。只有没有 steering 时，才执行它。

## drain() 与状态变化

```ts
const queuedSteering = this.steeringQueue.drain();
```

`drain()` 会取出队列内当前消息，并从队列删除这些消息：

```text
原队列：steeringQueue = ["不要改文件"]
取出后：queuedSteering = ["不要改文件"]
        steeringQueue = []
```

有 steering 时：

```ts
await this.runPromptMessages(queuedSteering, { skipInitialSteeringPoll: true });
return;
```

`skipInitialSteeringPoll: true` 表示 steering 已在 `continue()` 取出，内部不应再取一次。`return` 表示本轮决定完成，不再检查 follow-up。

若没有 steering，才会取出并运行 `followUpQueue`。两个队列都为空时，`continue()` 无法凭空继续，因此抛出错误。

优先级由实际控制流决定，而不是额外的优先级配置：

```ts
const queuedSteering = this.steeringQueue.drain();

if (queuedSteering.length > 0) {
	await this.runPromptMessages(queuedSteering, { skipInitialSteeringPoll: true });
	return;
}

const queuedFollowUps = this.followUpQueue.drain();
```

有 steering 时会执行 `return`，所以代码不会走到读取 `followUpQueue` 的下一句。只有 steering 为空，才读取 follow-up。

## 消息如何进入队列

`A`、`B` 只是两条 `AgentMessage` 的简写。它们来自外部传给 `steer()` 或 `followUp()` 的参数：

```ts
agent.steer(messageA);
agent.steer(messageB);
```

`steer()` 再调用：

```ts
enqueue(message: AgentMessage): void {
	this.messages.push(message);
}
```

因此内部队列按加入顺序变化：

```text
第一次加入 messageA：this.messages = [messageA]
第二次加入 messageB：this.messages = [messageA, messageB]
```

## `slice(drained.length)` 如何删除已取出的消息

```ts
const drained = this.peek();
this.messages = this.messages.slice(drained.length);
```

假设：

```ts
this.messages = [A, B];
mode = "one-at-a-time";
```

`peek()` 只取第一条，所以：

```ts
drained = [A];
drained.length === 1;
```

于是第二句等价于：

```ts
this.messages = this.messages.slice(1);
```

`slice(1)` 从数组下标 `1` 开始复制到最后，结果是 `[B]`。`slice()` 不会直接修改旧数组；右边先得到新数组 `[B]`，再由 `=` 把内部字段 `this.messages` 更新为这个新数组。

最终：

```text
drained = [A]       // 本轮交给 Agent Loop
this.messages = [B] // 留在队列，等待下一次处理
```

如果最后一条不是 `assistant`（例如 user 或 toolResult），则：

```ts
await this.runContinuation();
```

沿已有上下文继续请求模型。

---

## `processEvents()`：接收 Agent Loop 事件并更新 Agent 状态

## 阅读范围

- `packages/agent/src/agent.ts`，`processEvents()`（第 529–587 行）

Agent 在启动 Loop 时传入回调：

```ts
(event) => this.processEvents(event)
```

这表示：Agent Loop 运行中每发生一个事件，就把事件对象传给 `processEvents()`。

`event.type` 的可选值由 Pi 在 `AgentEvent` 类型中预先规定；实际运行时是哪一个值，则由 Agent Loop 在对应节点产生并传入。`processEvents()` 本身不创建事件，只接收和处理。

```text
模型开始输出
→ Agent Loop 产生 { type: "message_start", ... }
→ processEvents(event)
→ 根据 event.type 更新 Agent 状态
```

区分：

```text
event.type
= 刚刚发生的事情，例如 message_start

agent.state
= Agent 根据事件保存的当前状态
```

### assistant 消息的三个阶段

```text
message_start
→ 开始生成：写入 streamingMessage

message_update
→ 持续生成：用最新内容更新 streamingMessage

message_end
→ 生成完成：清空 streamingMessage，把完整消息加入 messages
```

`streamingMessage` 是生成期间的临时消息，供外部通过 `agent.state.streamingMessage` 读取和显示；`message_end` 不会总结或改写消息，只是把完整的原始 assistant 消息加入正式历史 `messages`。

### 工具执行状态

`pendingToolCalls` 是一个 `Set`，保存已经开始、但尚未结束的工具调用 ID：

```text
tool_execution_start
→ 加入 toolCallId

tool_execution_end
→ 删除 toolCallId
```

它不保存工具结果或参数，只表示哪些工具仍在执行。代码更新的是 Agent 内部状态；前端可读取 `agent.state.pendingToolCalls`，或接收转发的工具事件后自行显示。

### 事件转发与取消信号

状态更新后，`processEvents()` 依次调用监听者：

```ts
await listener(event, signal);
```

```text
event  = 发生了什么事件，例如 message_start
signal = 当前这次 Agent 运行是否已取消
```

因此 `processEvents()` 的完整职责是：

```text
Agent Loop 产生 event
→ 更新 Agent 内部 state
→ 把 event 和 signal 转发给外部监听者
```

---

## `agent-loop.ts`：从入口进入真正循环

三个函数是调用层级，不是三个循环：

```text
agentLoop()
→ runAgentLoop()
→ runLoop()
```

它们的职责分别是：

```text
agentLoop()
= 创建并立即返回 EventStream；运行期间把 AgentEvent 推入 stream，完成时以新增消息结束 stream

runAgentLoop()
= 准备本轮消息和完整上下文，发出 agent_start、turn_start 等开始事件，再调用 runLoop()

runLoop()
= 真正执行模型、工具、工具结果、下一轮模型请求的循环
```

`runAgentLoop()` 中：

```ts
await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
```

表示进入 `runLoop()`，并等待真正循环结束后，才执行：

```ts
return newMessages;
```

其中：

```text
currentContext = 模型使用的完整上下文
newMessages    = 本轮从开始到结束新增的全部消息，最终返回
```
