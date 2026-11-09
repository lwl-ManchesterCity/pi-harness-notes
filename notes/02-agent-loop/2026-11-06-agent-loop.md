# 2026-11-06：`runLoop()` 的入口与 steering 队列

## 阅读范围

- `packages/agent/src/agent-loop.ts`，`runLoop()` 入口（第 156 行起）

## 三层函数调用

```text
agentLoop()
→ runAgentLoop()
→ runLoop()
```

这不是三层循环：前两个函数负责创建事件流和准备上下文，`runLoop()` 才是实际执行模型、工具、工具结果和下一轮模型请求的循环。

## `runLoop()` 开始时的 steering 消息

```ts
let pendingMessages: AgentMessage[] =
	(await config.getSteeringMessages?.()) || [];
```

这行只读取 `steeringQueue`，不读取 `followUpQueue`。

一次取几条消息不由这行决定，而由 `steeringQueue.mode` 决定：

```text
默认 one-at-a-time：
steeringQueue = [A, B]
→ 本次 pendingMessages = [A]
→ B 留在队列，之后再取

all 模式：
steeringQueue = [A, B]
→ 本次 pendingMessages = [A, B]
```

因此：

```text
getSteeringMessages()
→ steeringQueue

getFollowUpMessages()
→ followUpQueue
```

## 内外两层循环

```ts
while (true) {
	let hasMoreToolCalls = true;

	while (hasMoreToolCalls || pendingMessages.length > 0) {
		...
	}
}
```

```text
外层循环：内层结束后，处理 follow-up 和显式继续。

内层循环：只要还有工具调用，或有 steering 消息，就继续当前轮。
```

每次外层开始都先设：

```ts
let hasMoreToolCalls = true;
```

确保内层至少进入一次，发起一次模型请求。
