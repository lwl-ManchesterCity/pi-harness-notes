# 2026-10-26：CLI 入口与请求路由

## 今天的目标

沿 Pi 的真实启动链路，从 `cli.ts` 进入 `main.ts`，理解为什么程序不会立即创建 Agent。

## 阅读范围

- `packages/coding-agent/src/cli.ts`
- `packages/coding-agent/src/main.ts`
- `packages/coding-agent/src/cli/auth-command.ts`
- `packages/coding-agent/src/core/export-html/index.ts`

## 调用链

```text
用户执行 pi
  → package.json 的 bin 指向 cli.js
  → cli.ts：main(process.argv.slice(2))
  → main.ts：先识别管理命令
  → 普通任务才继续准备 AgentSession
```

完整的后续链路：

```text
cli.ts
  → main.ts：main(...)
  → main.ts：createAgentSessionRuntime(...)
  → main.ts：createRuntime(...)
  → agent-session-services.ts：createAgentSessionFromServices(...)
  → sdk.ts：createAgentSession(...)
  → sdk.ts：new AgentSession(...)
```

## 输入

Node 把命令行参数放入 `process.argv`。`cli.ts` 通过下面的调用去掉 Node 和脚本路径，只把用户输入传给 `main()`：

```ts
main(process.argv.slice(2));
```

例如：

```bash
pi --model openai/gpt-5 帮我修复 bug
```

传给 `main()` 的参数是：

```ts
["--model", "openai/gpt-5", "帮我修复", "bug"]
```

## 核心逻辑

`main.ts` 先处理不需要启动 Agent 的管理命令：

```text
pi auth check ...    → 检查凭证，不创建 Agent
pi update            → 更新 Pi，不创建 Agent
pi config ...        → 读取或修改配置，不创建 Agent
pi mcp list          → 管理 MCP 服务，不创建 Agent
pi --version         → 输出版本号，不创建 Agent
pi --export ...      → 导出历史会话，不创建 Agent
```

普通任务，例如 `pi 帮我修复 bug`，不会命中这些提前出口。它先调用：

```ts
const parsed = parseArgs(args);
```

`parseArgs()` 将字符串数组拆成结构化的选项、用户消息和诊断信息。参数拼写错误会写入 `parsed.diagnostics`；存在错误时，Pi 输出错误并以状态码 `1` 退出。

`--export` 的例子：

```bash
pi --export session.jsonl output.html
```

它把已保存的 `session.jsonl` 会话文件转成浏览器可打开的 `output.html`，不调用模型也不创建 Agent。

## 输出与状态变化

管理命令被处理后，`main()` 直接返回或调用 `process.exit(...)`。此时不会创建 `SessionManager`、`Agent` 或 `AgentSession`。

普通任务经过参数解析和错误检查后，才会继续处理运行模式、会话和模型配置。

## 下一步调用谁

下一次从 `main.ts` 的运行模式判断开始：

```ts
let appMode = resolveAppMode(parsed, process.stdin.isTTY, process.stdout.isTTY);
```

## 必要的 TypeScript

- `process.argv.slice(2)`：返回从索引 2 开始的新数组，用于去掉 Node 与脚本路径。
- `await`：等待异步函数完成后再取得结果。
- `if (...) { return; }`：命中管理命令时结束当前启动流程。
- `try { ... } catch { ... }`：处理可能失败的操作，例如导出文件。

## Harness 设计收获

启动 Agent 前要先做请求路由。不是每个 CLI 输入都应启动 Agent；凭证检查、配置、升级和导出等请求可由更轻量的命令路径直接处理。

## 未解决问题

- [ ] `resolveAppMode()` 如何在 interactive、print、json 与 rpc 模式之间选择？
