# Pi Harness Notes

学习 Pi Harness 源码的公开笔记。

目标：用 8 周理解 Pi 的单 Agent Loop、Session、工具、上下文管理与 Durable Harness，为后续独立实现 Multi-Agent Coding Agent 打基础。

## 导航

- [8 周学习计划](PI_HARNESS_PLAN.md)
- [每日笔记模板](daily/TEMPLATE.md)
- [架构图说明](architecture/README.md)
- [设计笔记说明](design-notes/README.md)
- [Week 1 详细学习记录](daily/week-1-cli-agent-session.md)

## 仓库结构

```text
daily/          每日学习笔记与模板
architecture/   调用图、时序图和状态图
design-notes/   从 Pi 提炼出的 Multi-Agent 设计判断
pi-source/      完整 Pi 源码快照，以及学习时添加的中文注释
```

`pi-source/` 不包含本机的 `.git`、依赖目录或个人配置。公司电脑与家里主机都从本仓库拉取、修改和推送；中文注释与笔记会跟随同一次提交同步。

## 记录原则

每篇笔记只追一条真实调用链，并固定说明：输入、核心逻辑、状态变化、下一步调用。源码只引用必要的小片段，主要记录自己的理解和调用图。
