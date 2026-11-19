# 2026-11-19：工具结果交给扩展处理

`emitToolResult()` 可以理解为工具结果与扩展之间的中转。它找到注册了 `tool_result` 的处理函数，把工具结果交给它们；扩展可以返回修改，Pi 保存这些修改，之后交回上层。

```text
工具执行完成
→ Agent Loop 调用 afterToolCall
→ AgentSession._afterToolCall()
→ runner.emitToolResult()
→ 扩展检查或修改工具结果
→ afterToolCall 将处理结果交回 Agent Loop
```

`emitToolResult()` 位于 `afterToolCall` 执行过程中。它先复制事件到 `currentEvent`，并将 `modified` 初始化为 `false`，后续有扩展修改时再更新。

**假设例子**：`read` 返回 `密码是 123456`；某扩展收到 `tool_result` 后，将内容改成 `密码是 [已隐藏]`。Pi 使用扩展返回的修改；没有扩展修改时，继续使用原结果。

## 扩展之间的修改与最终结果

`emitToolResult()` 中，扩展 A 返回新内容后，Pi 先更新事件副本 `currentEvent`；后续扩展 B 接收到的是更新后的事件。如果扩展只替换 `content`，没有同时提供新的 `structuredContent`，Pi 会删除旧的结构化内容，避免两者不一致。

扩展处理结束后，`AgentSession._afterToolCall()` 将处理结果交回 Agent Loop；`finalizeExecutedToolCall()` 再把 Hook 返回的字段合并到工具执行结果。前一步让扩展之间看到最新修改，后一步整理最终工具结果。

## 按事件名称注册扩展函数

`pi.on(event, handler)` 接收事件名称和扩展处理函数，Pi 将处理函数的包装函数保存到该事件对应的列表。注册时只是保存函数，不会立刻执行。

```text
pi.on("tool_call", handler)   → 保存到工具执行前的事件列表
pi.on("tool_result", handler) → 保存到工具执行后的事件列表
```

我的理解：只要注册函数时指定它属于 `tool_result` 事件，Pi 就帮它保存；执行前的事件名称是 `tool_call`。`tool_call` 和 `tool_result` 是事件名称，不是类。`on()` 是通用方法，具体事件名称由扩展调用时传入。

例如同一个扩展先后注册两个 `tool_result` 函数：先取出这个事件已有的列表，把新包装函数 `push` 进去，再按事件名保存。事件发生后，Pi 按名称找到列表并调用其中的函数。

### 取消注册

`pi.on()` 保存处理函数后，会创建并返回对应的取消函数；只有以后调用这个取消函数时，才会从事件列表中移除本次注册的函数。

**假设例子**：

```ts
const cancelA = pi.on("tool_result", handlerA);
const cancelB = pi.on("tool_result", handlerB);
cancelA();
```

调用 `cancelA()` 只移除 A，B 仍然保留。两次 `on()` 分别创建取消函数，各自记住那次注册的包装函数；如果某个事件的处理函数全部移除，Pi 也会删除对应的空列表。

### 按事件查找处理函数

`snapshotEventHandlers(extensions, "tool_result")` 遍历扩展，查找各自注册的 `tool_result` 函数列表。有列表时用 `slice()` 复制数组；没有时使用空数组。复制的是数组，里面仍是原来的函数，此时还没有执行。

**假设例子**：扩展 A 注册了 A1、A2，扩展 B 没有注册。返回的两项分别是 `{ ext: 扩展A, handlers: [A1, A2] }` 和 `{ ext: 扩展B, handlers: [] }`。后续遍历 B 的空数组时不会执行任何处理函数。

## 扩展如何获得 API

Pi 在 `initializeExtension()` 中先调用 `createExtension()` 创建扩展对象，再把它交给 `createExtensionAPI()` 创建扩展 API。之后 Pi 调用扩展入口函数 `factory(load.api)`，将 API 传给扩展；扩展在入口函数里可以使用 `pi.on(...)` 注册处理函数。入口执行成功后调用 `load.commit()`。

扩展使用者不需要自己创建这个 API；扩展入口接收到的 `pi` 参数就是 Pi 传入的 API。

## MCP 工具接入链路

Pi 根据 Server 配置、工作目录和可选认证提供者创建 `transport`，再通过 `client.connect(transport)` 等待连接。

首次获取工具列表的顺序：

```text
准备连接信息并创建 transport
→ client 连接 MCP Server
→ 登记工具列表变化通知（此时不刷新）
→ 检查 Server 是否声明支持工具
→ 支持时调用 client.listTools() 首次获取列表，否则使用空数组
```

以后 Server 发出工具列表变化通知，Pi 才调用已登记的回调，通过 `refreshTools(client)` 刷新列表。

从 Server 获取到工具列表后，Pi 逐个调用 `createMcpToolDefinition()` 创建工具定义，再调用 `pi.registerTool()` 注册。创建函数的具体配置参数暂时浅看。

注册前，`definitions.set(definition.name, definition)` 按名称保存一份定义，供后续查找。隐藏不一定是用户主动操作：例如 Server 原来提供 `search`，刷新后的列表中不再包含它，Pi 会取出旧定义并重新注册为 `"hidden"`；这段代码不能说明 Server 为什么不再提供它。Server 被禁用时，Pi 也会使用保存的定义隐藏工具。

### 注册定义与 Server 实际执行

Pi 注册的是 MCP 工具在 Pi 内的定义：包含工具名称、参数规则和调用时使用的 `execute()`。注册让 Pi 后面能找到工具、校验参数并执行调用入口；它不会把 Server 上的工具实现搬到本地。

### 一个 MCP 工具的六步主链

1. **获取**：Pi 连接 MCP Server，获取它提供的工具信息。
2. **创建**：Pi 用其中一个工具的信息创建工具定义，包含名称、参数规则和 `execute()`。
3. **注册**：Pi 调用 `pi.registerTool(definition)`，登记这份定义。
4. **调用**：模型请求该工具后，Pi 找到定义并执行其中的 `execute()`。
5. **转发**：`execute()` 通过客户端的 `callTool()` 把工具名称和参数发给 MCP Server，由 Server 执行。
6. **返回**：Server 返回结果；Pi 用 `convertMcpResult()` 转换后从 `execute()` 交回 Agent Loop。之后执行后 Hook 可以处理结果，Pi 再整理成 `toolResult` 消息加入上下文。

**假设例子**：MCP Server 提供 `search_docs`，可以搜索文档。

```text
先准备工具：
1. 获取：Pi 连接 Server，拿到 search_docs 的信息
2. 创建：Pi 根据这些信息创建工具定义
3. 注册：Pi 把工具定义登记起来
```

到这里，Pi 知道工具叫什么、需要什么参数、怎么调用它；还没有执行搜索。

```text
之后模型请求搜索：
4. 调用：Pi 找到已注册的工具，执行它的 execute()
5. 转发：execute() 把名称和参数发给 Server，由 Server 执行搜索
6. 返回：Server 返回搜索结果，Pi 转换后交给 Agent Loop
```

Agent Loop 后续再经过执行后 Hook，把结果整理成 `toolResult` 消息，供模型继续使用。
