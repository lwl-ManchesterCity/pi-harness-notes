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

## 暂存的 bash 消息和自定义消息

`_startRun()` 的 `finally` 会处理还未写入 session 的 bash 消息和自定义消息。

**Bash 消息示例（假设值）：**用户输入 `!pwd`，命令输出 `/Users/lwl/Desktop/pi`，Pi 可以记录：

```ts
{
    role: "bashExecution",
    command: "pwd",
    output: "/Users/lwl/Desktop/pi",
    exitCode: 0,
    // 实际消息还有时间、是否取消等字段
}
```

它记录用户运行了什么命令、得到了什么结果。

**自定义消息示例（假设值）：**扩展可以通过 `sendCustomMessage()` 传入：

```ts
{
    customType: "project-check",
    content: "项目检查完成，发现 2 个待处理问题。",
    display: true,
}
```

Pi 会将它整理为 `role: "custom"` 的消息。具体类型和内容由扩展决定。

扩展可以理解为插件。自定义消息就是插件提供给 Pi 的消息，不一定是用户亲自在输入框里写的。例如，假设项目检查插件发来“项目检查完成，发现两个问题”，内容和消息类型由插件定义。

当自定义消息触发一次运行时，`_prepareRun()` 会先创建空的 `messages` 数组；如果 `trigger.messageType === "custom"`，就把 `trigger.message` 放进去，供后续交给 Agent。普通用户输入走另一个分支。

写入 session 是为了保存会话记录并刷新上下文。是否发给模型还取决于消息类型和配置；例如 bash 消息可以设置 `excludeFromContext`。某些运行中产生的消息会先暂存，在合适时机写入；`finally` 会处理仍未写入的消息。

## 本次运行的工具选择

`_prepareRun()` 通知扩展 Agent 即将开始，并比较扩展处理前后的配置工具列表。如果扩展直接修改了配置中的 `selectedTools`，就保留修改后的列表；如果没有修改，就用 `getActiveToolNames()` 读取 Agent 当前启用的工具，更新本次运行的配置。

可以理解为：扩展直接修改的配置列表优先；没有直接修改时，配置跟随 Agent 当前的工具列表。这个判断针对本次运行的配置。

## 必要的 TypeScript

`await` 等待后面的异步操作完成，再继续执行后面的代码。`break` 退出当前循环；`continue` 回到当前循环开头。

## 下一步

继续追踪 `_prepareRun()` 如何把 `trigger` 准备成消息数组。
