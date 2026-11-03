# 00 链路概述与学习计划

这里放总览、8 周计划、笔记模板，以及跨周使用的架构图和设计笔记。

## Pi 的主链路

```text
CLI
  → main.ts
  → AgentSessionRuntime
  → AgentSessionServices
  → AgentSession
  → pi-agent-core Agent
  → pi-ai Provider
  → Tool
  → AgentSession
  → TUI / print / RPC
```

## 未来 Durable Multi-Agent 的目标链路

```text
Harness
  → Conversation / Submission
  → GenerationTask
  → ToolTask / Child Task
  → atomic commit
  → Scheduler / Storage
  → resume / task graph
```

## 内容

- [8 周学习计划](PI_HARNESS_PLAN.md)
- [每日笔记模板](daily-note-template.md)
- [架构图说明](architecture/README.md)
- [设计笔记说明](design-notes/README.md)
