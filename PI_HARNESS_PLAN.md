# Pi Harness 源码学习计划（8 周）

## 目标

本计划只服务于一个目标：在两个月内理解 Pi 的 Harness 设计，并能把其中可复用的设计原则带入后续自己的 Multi-Agent Coding Agent。

学习完成不等于逐行读完 Pi，也不等于立刻实现产品。完成标准是能够：

1. 从 CLI 的用户输入追到模型请求、工具调用、工具结果和下一轮请求。
2. 解释 `pi-agent-core` 的即时 Agent Loop 与 `pi-durable` 的持久化任务 Harness 有何不同。
3. 说明多 Agent 所需的任务所有权、前台/后台边界、取消、恢复、上下文隔离和结果回传应如何设计。
4. 为后续实现阶段写出自己的 Harness 组件图、任务状态机和关键数据边界。

## 源码全景结论

本仓库的主要源码约 20 万行，其中：

| 包 | 规模 | 实际职责 | 与本计划的优先级 |
| --- | ---: | --- | --- |
| `packages/coding-agent` | 约 8.2 万行 | Pi CLI、Session、内置工具、扩展、交互模式 | 高 |
| `packages/ai` | 约 2.7 万行 | 统一模型消息、工具 schema、流式 Provider API | 高，但只读抽象层 |
| `packages/durable` | 约 2.5 万行 | 持久化 Conversation、Task、Scheduler、Storage | 高，面向 Multi-Agent |
| `packages/tui` | 约 2 万行 | 终端渲染与输入组件 | 低，只看事件消费边界 |
| `packages/chord` | 约 1.4 万行 | Durable 使用的状态复制、文档与 RPC 基础设施 | 低，只看其对 Durable 的接口 |
| `packages/codemode` | 约 3000 行 | 受限 JavaScript 沙箱，通过注入工具工作 | 中，按需 |
| `packages/mcp` | 约 3300 行 | MCP 客户端、传输和 OAuth | 中，按需 |
| `packages/env` | 约 2300 行 | Durable 的远程执行环境 | 低，后续实现远程执行时再读 |

### 两条必须区分的链路

```text
当前 Pi Coding Agent 的主链路
CLI → AgentSession → pi-agent-core Agent → pi-ai → Tool → AgentSession → TUI

未来 Multi-Agent 可借鉴的持久化链路
Harness → Conversation / Submission → GenerationTask → ToolTask / Child Task
        → atomic commit → Scheduler → Storage → resume / task graph
```

`pi-coding-agent` 依赖 `pi-agent-core`、`pi-ai`、`pi-mcp`、`pi-codemode` 和 `pi-tui`，但不依赖 `pi-durable`。

因此：

- `pi-agent-core` 是当前 CLI 的核心单 Agent 循环。
- `pi-durable` 是另一套更强的持久化 Harness，包含 Task、所有权、恢复和前后台边界；它对 Multi-Agent 设计更直接。
- Pi CLI 本身没有内建的通用 Supervisor、Plan Mode 或 Worktree 子 Agent 调度器。仓库根 README 明确说明这些功能应由扩展或用户自行构建。Coding Agent 中的 worktree 代码主要处理项目上下文发现，不是多 Agent 工作区编排。

## 学习规则

### 每次只读一小段

每次 45 到 90 分钟，只追 1 到 4 个相邻函数。对每个函数固定写下：

1. **输入**：谁调用它，传入什么。
2. **核心逻辑**：做了哪些判断、转换或异步工作。
3. **输出/状态变化**：返回什么，修改了什么消息、Session、Task 或存储记录。
4. **下一跳**：调用谁，或由谁消费它发出的事件。

### 每周固定产物

- 一张不超过 15 个节点的调用图或状态图。
- 一个真实 trace：从一个输入开始，列出经过的函数和状态变化。
- 一页术语笔记，只记录本周实际遇到的 TypeScript 与 Harness 概念。
- 一个“未解决问题”列表；不猜，下一周由源码或测试验证。

### TypeScript 只学阅读所需部分

- `type` / `interface`：数据字段和函数契约。
- `async` / `await`：异步边界和暂停点。
- 联合类型：例如 `status` 或 `event.type` 决定哪个分支可用。
- 泛型：例如 `EventStream<AgentEvent, AgentMessage[]>` 表示过程事件和最终值。
- `...object`：复制对象后覆盖少量字段。

不以高级类型体操、构建工具配置或所有 Provider 的 HTTP 细节为学习目标。

## 第 1 周：定位真实运行入口与装配层

### 要回答的问题

用户在终端输入一句话后，谁创建 Session、模型、工具、资源和 UI？

### 阅读顺序

1. `packages/coding-agent/src/cli.ts`
2. `packages/coding-agent/src/main.ts`
3. `packages/coding-agent/src/modes/index.ts`
4. `packages/coding-agent/src/core/agent-session-runtime.ts`
5. `packages/coding-agent/src/core/agent-session-services.ts`
6. `packages/coding-agent/src/core/sdk.ts`

### 重点

- `cli.ts` 只启动环境并调用 `main()`；它不是业务编排中心。
- `main.ts` 解析参数、选择 `interactive` / `print` / `json` / `rpc` 模式，创建运行时。
- `createAgentSessionServices()` 负责 cwd 相关服务：设置、资源加载、扩展发现。
- `createAgentSession()` 选择模型、创建内置工具和 `Agent`，再交给 `AgentSession`。

### 不读

认证细节、参数的每一个分支、主题初始化、安装/迁移逻辑。

### 本周验收

```text
pi 命令
→ main
→ createAgentSessionRuntime
→ createAgentSessionServices
→ createAgentSession
→ AgentSession
→ InteractiveMode / PrintMode / RpcMode
```

## 第 2 周：pi-agent-core 的单 Agent 循环

### 要回答的问题

一个用户消息如何完成“模型 → 工具 → 工具结果 → 模型”的闭环？

### 阅读顺序

1. `packages/agent/src/types.ts`：只读 `AgentContext`、`AgentLoopConfig`、`AgentEvent`、`AgentTool`。
2. `packages/agent/src/agent.ts`：只读 `Agent.prompt()`、`Agent.continue()`、事件转发和队列。
3. `packages/agent/src/agent-loop.ts`：`agentLoop → runAgentLoop → runLoop → streamAssistantResponse → executeToolCalls`。
4. `packages/agent/test/agent-loop.test.ts`：只挑与当前函数对应的测试作为行为证据。

### 必须理解

- `context.messages` 是模型工作上下文；`newMessages` 是当前运行新增的消息记录。
- `EventStream` 把持续过程事件和最终消息结果分开。
- 内层循环处理工具和 steering；外层循环处理 follow-up 与显式继续。
- `AbortSignal` 同时传给模型与工具，形成取消链路。

### 本周验收

画出一次 `read` 调用的时序：`agent_start`、assistant tool call、工具事件、`toolResult`、下一轮 assistant、`agent_end`。

## 第 3 周：Coding Agent 的 Session 包装层

### 要回答的问题

为什么 `AgentSession` 不直接等同于 `Agent`？

### 阅读顺序

1. `packages/coding-agent/src/core/agent-session.ts`：构造函数、事件桥接、`prompt()`、`_startRun()`、`_prepareRun()`、`_handlePostAgentRun()`。
2. `packages/coding-agent/src/core/session-manager.ts`：Session 文件、分支和 `buildSessionContext()`。
3. `packages/coding-agent/src/core/messages.ts`：`convertToLlm` 的职责。
4. 相关测试：`agent-session-runtime-events`、`agent-session-queue`、`agent-session-retry`。

### 必须理解

- `Agent` 负责通用循环；`AgentSession` 负责 Pi 产品语义。
- 这一层加入技能展开、Extension 事件、自动重试、Session 记录、Compaction、工具载入和 UI 事件。
- `AgentSession._startRun()` 在外部包住 `agent.prompt()` / `agent.continue()`，处理重试、压缩和“本次 Agent 已真正 settled”的边界。

### 本周验收

写出 `InteractiveMode → session.prompt() → _startRun() → agent.prompt()` 的 trace，并标出每层额外增加的职责。

## 第 4 周：工具、Hook、Extension、MCP

### 要回答的问题

模型提出 Tool Call 后，怎样变成安全、可观察、可扩展的实际执行？

### 阅读顺序

1. `packages/agent/src/agent-loop.ts`：`prepareToolCall`、`executePreparedToolCall`、`finalizeExecutedToolCall`。
2. `packages/coding-agent/src/core/tools/index.ts` 与一个具体工具：先读 `read.ts`，再选 `bash.ts`。
3. `packages/coding-agent/src/core/extensions/runner.ts`、`wrapper.ts`。
4. `packages/coding-agent/src/extensions/mcp/`：只追一个 MCP tool 注册到 AgentTool 的路径。
5. `packages/mcp/src/client.ts`：只理解客户端、transport 和 protocol 的边界。

### 必须理解

- 工具路径：查找 → 参数预处理 → schema 校验 → `beforeToolCall` → execute → partial update → `afterToolCall` → tool result。
- 工具可并行执行，但写入 transcript 的 ToolResult 保持模型原有调用顺序。
- Hook 是实际控制点，不能只用 prompt 约束权限。
- Extension 改变 Pi 行为；MCP 从外部 Server 取得工具；Skill 主要给模型增加工作指令。

### Multi-Agent 映射

未来应按角色分配不同工具集合。Worker 可以写文件，Reviewer 默认只能读取 diff 和运行测试，Planner 不应拥有 Shell 写入权限。

### 本周验收

写一份三角色工具矩阵：Planner、Worker、Reviewer 的允许工具、禁止工具、审批点和结果格式。

## 第 5 周：Session、Context 与 Compaction

### 要回答的问题

历史、Session 文件、模型上下文和摘要各自是什么，为什么不能混为一谈？

### 阅读顺序

1. `packages/coding-agent/src/core/session-manager.ts`：只追 append、加载、branch context。
2. `packages/coding-agent/src/core/compaction/compaction.ts`。
3. `packages/coding-agent/src/core/compaction/branch-summarization.ts`。
4. `packages/coding-agent/src/core/agent-session.ts` 中 `_checkCompaction()` 与 `_runAutoCompaction()`。
5. `packages/coding-agent/docs/session-format.md`、`docs/compaction.md` 和对应测试。

### 必须理解

- 完整 Session 是可追溯记录，不等于每次都发给模型的 Context。
- Compaction 保留持久历史，但把旧消息替换为模型可用摘要。
- `prepareRequest` / `prepareNextTurn` 类 Hook 是长操作与下一轮请求之间的接缝。
- 分支 Session 与未来子 Agent 的独立 transcript 相似，但不是同一件事。

### 本周验收

画出三层数据：`完整 Session 记录`、`本轮 Agent Context`、`模型 payload`，并注明每层谁读写。

## 第 6 周：pi-ai 的消息与流式模型边界

### 要回答的问题

Pi 为什么把 Agent Harness 与 Provider HTTP 实现分开？

### 阅读顺序

1. `packages/ai/src/types.ts`：消息、工具、stream event、stop reason。
2. `packages/ai/src/utils/event-stream.ts`。
3. `packages/ai/src/utils/transcript.ts`。
4. `packages/ai/src/compat.ts` 与一个 Provider 示例，例如 `api/anthropic-messages.ts` 的请求/流解析边界。
5. `packages/agent/src/agent-loop.ts` 的 `streamAssistantResponse()` 回看转换点。

### 不读

所有 Provider、OAuth 细节、模型目录生成代码和图像生成接口。

### 必须理解

- Agent 使用可扩展的 `AgentMessage`；模型只接收统一 `Message`。
- `convertToLlm()` 是产品自定义消息和 Provider 标准格式之间的隔离层。
- 流式增量持续更新同一条 assistant message，最终 result 才是稳定记录。

### 本周验收

画出：`AgentMessage[] → transformContext → convertToLlm → Message[] → stream events → AssistantMessage`。

## 第 7 周：pi-durable 的持久化 Harness 与 Subagent

### 要回答的问题

进程重启、任务等待、子 Agent、前后台边界和取消，怎样成为可恢复的系统行为？

### 阅读顺序

1. `packages/durable/README.md` 的 Concepts、Persist and Resume、Abort and Subagents、Child Tasks、Task Graph。
2. `packages/durable/src/types.ts`：Task、TaskState、TaskOwnership、Conversation、Storage 类型。
3. `packages/durable/src/harness/harness.ts`：Harness 和 Conversation 入口。
4. `packages/durable/src/harness/generation.ts`：GenerationTask 的阶段状态机。
5. `packages/durable/src/harness/tool.ts`：ToolTask 与持久化 Tool Call。
6. `packages/durable/src/harness/scheduler.ts`：只读任务调度、等待和取消边界。
7. `packages/durable/test/examples/22-subagent-foreground.ts`、`23-subagent-background.ts`、`24-child-tasks.ts`。

### 必须理解

- 所有可恢复状态必须先通过 atomic commit 落盘，之后才能向外显示。
- Task 用 checkpoint 表示可恢复状态机；重启后 `running` 会回到可调度的 pending。
- 所有权是取消与等待的基础：父任务拥有子任务，父 Conversation 拥有普通任务。
- `background` 是所有权树上的边界：默认取消/等待不会跨过它。
- 子 Agent 在 Durable 中是被 Task 拥有的 Conversation；前台子 Agent 会影响父级 idle，后台子 Agent 不会。

### 本周验收

画出一个前台 Worker 与一个后台 Reporter 的所有权树，标出：谁等待谁、取消能传播到哪里、重启后从哪个 checkpoint 恢复。

## 第 8 周：把两套 Harness 转为自己的设计原则

### 要回答的问题

未来的 Multi-Agent Coding Agent 应该继承 Pi 的哪些边界，而不是复制哪些实现细节？

### 对比表

| 问题 | `pi-agent-core` | `pi-durable` | 自己的 Multi-Agent 原型建议 |
| --- | --- | --- | --- |
| 单轮运行 | 内存内 Agent Loop | GenerationTask 阶段机 | 保持简单 Loop，但把关键任务状态持久化 |
| 消息 | Context 与 EventStream | immutable Entry + commit | 子 Agent transcript 独立；Supervisor 只接收摘要 |
| 工具 | Hook 前后拦截 | ToolTask + replay policy | 工具权限由角色工具集和 Hook 双重控制 |
| 取消 | AbortSignal | durable abort mark + ownership tree | 取消必须沿任务树传播，并记录最终状态 |
| 重启恢复 | 由产品 Session 层处理 | Scheduler 从 checkpoint 恢复 | Worker 的执行意图、结果和重试号必须保存 |
| 并发 | 同轮工具并行 | 子 Task 等待 / policy | 并发只发生在无文件冲突的子任务之间 |

### 本周产物

只写设计，不实现产品：

1. Supervisor、Planner、Worker、Reviewer 的职责边界。
2. Task 数据模型：`id`、父任务、角色、输入摘要、worktree、状态、checkpoint、artifact、错误、重试次数。
3. 任务状态机：`queued → running → waiting → completed / failed / cancelled`。
4. 角色工具矩阵与审批点。
5. 一个端到端例子：用户任务拆成 Worker，Worker 产生 diff，Reviewer 验收，Supervisor 汇总。
6. 六个故障场景：超时、取消、重启、重复提交、同文件冲突、Reviewer 拒绝。

## 不作为两个月必修内容

- `packages/tui` 的渲染算法、编辑器实现和主题系统。
- 20 多个模型 Provider 的具体 HTTP 格式。
- `packages/chord` 的 delta 算法和 RPC 细节。
- `packages/env` 的 SSH daemon 和远程执行细节。
- 打包、发布、安装锁和 telemetry 实现。

这些模块已完成结构遍历；当后续实现遇到明确需求时再按调用链回读。

## 两个月结束时的自测

能够不看资料解释并画出：

1. CLI 输入如何到达 `AgentSession` 和 `Agent`。
2. 一个 Tool Call 的校验、Hook、执行、事件和 ToolResult 路径。
3. Session 记录、模型 Context、模型 payload 的区别。
4. 为什么单 Agent 内存循环不足以支撑可恢复的 Multi-Agent 系统。
5. Durable 的 Task ownership 与 background boundary 如何避免错误取消和错误等待。
6. 为什么 Worktree 只是隔离策略之一，不能代替任务状态、权限、结果协议和冲突处理。

若以上六项能做到，后续两个月实现自己的 Coding Agent 时，已经具备了足够的 Pi Harness 设计基础。
