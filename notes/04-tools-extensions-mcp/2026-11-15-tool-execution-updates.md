# 2026-11-15：工具执行中的部分更新

## 当前阅读位置

`packages/agent/src/agent-loop.ts` 的 `executePreparedToolCall()`。

在实际调用 Tool 前，Pi 建立四个执行状态：

```ts
const updateEvents: Promise<void>[] = [];
let acceptingUpdates = true;
const startedAt = performance.now();
const elapsed = () => Math.round(performance.now() - startedAt);
```

## partial update 为什么需要两个状态

假设一个 Tool 在执行中陆续产生三段输出。

```text
第 1 段输出 → 调用 onUpdate()
第 2 段输出 → 调用 onUpdate()
第 3 段输出 → 调用 onUpdate()
```

`updateEvents` 收集每次 `onUpdate()` 对应的异步完成任务。Tool 得到最终结果后，Pi 会等待这些任务全部完成，避免最终 ToolResult 已返回、但较早的部分输出尚未发送完。

`acceptingUpdates` 是是否继续接收部分更新的开关：

```text
true  → 接收 Tool 产生的 partial update
false → 忽略迟到的 partial update
```

Tool 已结束后，Pi 将它设为 `false`。这样异步 Tool 即使晚到一条更新，也不会在最终结果之后继续写入事件流。

`startedAt` 和 `elapsed()` 用于计算这次 Tool 执行的耗时，最后放入执行结果。

## Tool 正常结束后的收尾

`Tool.execute()` 返回最终结果后，Pi 按以下顺序收尾：

```text
计算 durationMs
→ acceptingUpdates = false，拒绝迟到的 partial update
→ 等待 updateEvents 中已开始的上报任务完成
→ 返回 result、isError 和 durationMs
```

因此，模型收到最终 ToolResult 前，已经开始发送的部分输出不会被丢下；但 Tool 结束后新到的过期更新不会继续写入事件流。
