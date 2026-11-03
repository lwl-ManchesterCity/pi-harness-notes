# 01 CLI 到 AgentSession

状态：已完成。

本周回答的问题：用户在终端输入一句话后，谁创建 Session、模型、工具、资源和 UI？

主链路：

```text
cli.ts
  → main.ts
  → modes/index.ts
  → AgentSessionRuntime
  → AgentSessionServices
  → sdk.ts / createAgentSession(...)
  → new AgentSession(...)
```

每天的学习过程保存在 [daily/](daily/)；汇总笔记在 [week-1-cli-agent-session.md](daily/week-1-cli-agent-session.md)。
