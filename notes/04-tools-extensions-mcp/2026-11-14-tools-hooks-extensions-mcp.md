# 2026-11-14：Week 4 工具执行链概览

## 本周问题

模型只会提出“想调用什么工具”。Pi 需要把这个请求变成一次真实、可控、可记录、可扩展的执行。

## 主链

```text
模型提出 Tool Call
→ Pi 查找对应 Tool
→ 参数预处理与 schema 校验
→ beforeToolCall Hook 决定允许、拒绝或修改流程
→ 执行 Tool
→ 发送 partial update
→ afterToolCall Hook 处理最终结果
→ ToolResult 按模型原有调用顺序写回上下文
→ 模型根据结果继续推理
```

工具可并行执行；写入 transcript 的 ToolResult 仍按模型原始 Tool Call 顺序排列。

## 各对象的边界

- Tool：实际执行能力，例如读文件、运行命令、写文件。
- Hook：执行路径的控制点。权限、审计、拦截和结果改写应在这里实现，不能只依赖 prompt。
- Extension：改变 Pi 行为的接入机制，可以注册 Tool、Hook、命令和渲染器。
- MCP：外部 Server 提供 Tool 的协议。Pi 将外部 Tool 转为自己的 `AgentTool` 后，仍走同一条 Tool 和 Hook 链。
- Skill：主要给模型增加工作指令，不提供实际执行能力。

## Multi-Agent 映射

```text
模型决定“请求什么”
Tool 定义“能做什么”
Hook 决定“此刻是否允许做”
Extension 决定“如何接入新能力”
MCP 决定“如何接入外部能力”
AgentSession / transcript 记录“做了什么、结果是什么”
```

未来可按角色分配不同的 Tool 集合和 Hook 策略：

| 角色 | 允许工具 | 禁止工具 | 审批点 | 结果格式 |
| --- | --- | --- | --- | --- |
| Planner | 读代码、读会话、生成计划 | 写文件、破坏性 Shell | 无写入权限；需要升级权限时转交审批 | 计划、风险、待确认项 |
| Worker | 读写文件、运行测试、开发工具 | 未获批准的高风险外部操作 | 写入或高风险命令可由 Hook 审批 | 改动、验证结果、遗留风险 |
| Reviewer | 读代码、读 diff、运行测试 | 修改工作区 | 不拥有写权限；发现问题返回 Worker | 发现项、证据、建议 |

本周验收：将以上三种角色的允许工具、禁止工具、审批点和结果格式，落实为明确的工具矩阵。
