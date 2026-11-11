# 2026-11-11：Agent 运行后的两次等待

## 今天的目标

理解 `AgentSession._startRun()` 在底层 Agent 结束后，为什么要等待运行后的检查和继续运行。

## 阅读范围

- `packages/coding-agent/src/core/agent-session.ts`：`_startRun()` 中的运行后循环。

## 调用链

```text
Agent 运行结束
→ 等待 _handlePostAgentRun() 检查结果
→ 需要继续且没有中止请求时，调用 agent.continue()
→ 等待 Agent 运行结束
→ 回到循环开头，再检查结果
```

## 两次等待

```ts
if (await this._handlePostAgentRun()) {
    if (this._agentRunAbortRequested) break;
    await this.agent.continue();
    continue;
}
```

第一次等待 `await this._handlePostAgentRun()`：前一次 Agent 运行已经结束。Session 等待运行后的检查完成，得到是否需要继续的结果。例如，遇到可重试的错误时，检查可能包含重试前的等待。返回 `true` 才进入分支；返回 `false` 则跳过分支。

第二次等待 `await this.agent.continue()`：没有中止请求时，让 Agent 基于现有消息再运行一次，并等这次运行结束。之后 `continue` 回到循环开头，检查这次的结果。

## 必要的 TypeScript

`await` 等待后面的异步操作完成，再继续执行后面的代码。`break` 退出当前循环；`continue` 回到当前循环开头。

## 下一步

继续看 `_handlePostAgentRun()` 返回 `false` 时，`_startRun()` 如何处理。
