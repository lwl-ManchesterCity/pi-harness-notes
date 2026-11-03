# Pi Harness Notes

学习 Pi Harness 源码的公开笔记。目标是用 8 周理解 Pi 的单 Agent Loop、Session、工具、上下文管理与 Durable Harness，为独立设计 Multi-Agent Coding Agent 打基础。

## 笔记导航

- [00 链路概述与学习计划](notes/00-overview/)
- [01 CLI 到 AgentSession](notes/01-cli-to-session/)
- [02 单 Agent Loop](notes/02-agent-loop/)
- [03 Coding Agent 的 Session 层](notes/03-agent-session/)
- [04 工具、扩展与 MCP](notes/04-tools-extensions-mcp/)
- [05 Session、Context 与 Compaction](notes/05-session-context-compaction/)
- [06 pi-ai 的消息与流式边界](notes/06-ai-message-streaming/)
- [07 Durable Harness 与 Subagent](notes/07-durable-subagents/)
- [08 设计归纳](notes/08-design-synthesis/)

## 源码快照

[notes/](notes/) 统一存放上面的 9 个笔记部分。

[pi-source/](pi-source/) 是完整 Pi 源码快照，包含学习时写入的中文注释。它独立于笔记目录；不包含本机 `.git`、依赖目录或个人配置。

公司电脑与家里主机都可从本仓库拉取、修改和推送；中文注释与笔记会跟随同一次提交同步。

## 记录原则

每篇笔记只追一条真实调用链，并固定说明：输入、核心逻辑、状态变化、下一步调用。源码只引用必要的小片段，主要记录自己的理解和调用图。
