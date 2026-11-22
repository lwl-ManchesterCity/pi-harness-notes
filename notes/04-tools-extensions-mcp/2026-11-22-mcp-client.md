# 2026-11-22：MCP 的两次通信

获取工具列表和调用工具都会经过 Pi 的 client、transport 与 MCP Server；两次请求的目的不同。

```text
准备、注册工具：
client 发出 tools/list 请求
→ transport 送给 Server
→ Server 返回工具列表
→ Pi 根据工具信息创建并注册定义
```

```text
模型请求执行已注册的 MCP 工具：
Pi 找到工具定义
→ client 发出 tools/call 请求，带上工具名称和参数
→ transport 送给 Server
→ Server 执行工具并返回结果
```

第一次是问 Server 提供哪些工具；第二次是请求 Server 执行某个工具。这里的注册流程是当前学习的 MCP 路径，工具是否直接展示给模型还取决于 exposure 等配置。

## 请求编号与等待记录

MCP 客户端用 `pending` 暂存已经发出、还在等待处理结果的请求。Server 的回复带有请求 `id`；客户端根据它找到对应等待记录，移除该记录，再将结果或错误交回请求方。取消和超时也会结束等待并移除记录；移除的不是 session 历史或工具结果。

编号由 `nextRequestId` 生成，初始为 1；`const id = this.nextRequestId++` 先取当前值，再递增。

**假设例子**：已发出 1、2、3，`pending` 中有三条等待记录。编号 1 收到回复后被移除，剩下 2、3；下一个新请求的编号是 4，不会因为移除 1 而重新使用它。

## 收到 Server 消息后的分发

连接时，客户端通过 `transport.onMessage((message) => this.handleMessage(message))` 登记处理函数；这时只是告诉 transport 收到消息后该调用谁，并没有立即收到消息。

之后 Server 发来消息，transport 收到后调用登记的函数，将消息交给客户端的 `handleMessage()`。客户端再判断消息类型并分发：回复交给 `handleResponse()`，通知交给通知处理函数。

```text
连接时登记回调 → 等待 Server 消息
→ transport 收到消息并调用回调
→ client 判断消息类型 → 交给对应处理函数
```

## Week 4：三角色工具矩阵

这是未来 Multi-Agent Coding Agent 的设计初稿，可以把 Planner、Worker、Reviewer 理解为三个子 Agent 角色；不代表 Pi 当前已经按这三个角色实现。

| 角色 | 允许工具 | 默认禁止或受限 | 审批点 | 结果格式 |
| --- | --- | --- | --- | --- |
| Planner | 读取文件、搜索代码 | 写文件、执行有写入效果的 Shell 命令 | 计划涉及删除数据、部署等操作时，先请求用户批准 | 任务步骤、涉及文件、验收条件 |
| Worker | 读取、搜索、编辑文件；运行任务需要的命令 | 超出任务范围的删除、提交、推送或部署 | 不可逆操作和用户要求审批的操作先请求批准 | 修改内容、涉及文件、执行结果 |
| Reviewer | 读取文件、查看 diff、运行测试 | 默认不能编辑源码或执行写入型 Shell 命令 | 测试需要外部服务、费用或会改动环境时先确认 | 发现的问题、位置、验证结果 |

假设修改登录页面：主 Agent 接收任务，Planner 分析并拆分，Worker 修改代码，Reviewer 检查改动，最后主 Agent 汇总结果。工具权限需要通过实际工具集合及执行前 Hook 等控制点落实，不能只依赖角色提示词。
