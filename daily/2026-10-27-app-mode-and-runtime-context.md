# 2026-10-27：运行模式与项目/全局目录

## 今天的目标

理解 Pi 如何根据使用方式选择运行模式，以及启动前为什么要区分当前项目目录和 Pi 的全局目录。

## 阅读范围

- `packages/coding-agent/src/main.ts`
- `packages/coding-agent/src/core/output-guard.ts`
- `packages/coding-agent/src/migrations.ts`

## 调用链

```text
parseArgs(args)
  → resolveAppMode(parsed, stdin.isTTY, stdout.isTTY)
  → 检查 RPC、session 参数组合
  → runMigrations(cwd)
  → 创建 SettingsManager
```

## 输入

`resolveAppMode()` 接收三项信息：

```text
parsed          → 用户是否传入 --mode
stdin.isTTY     → 输入来自人，还是来自管道/程序
stdout.isTTY    → 输出直接显示给人，还是交给文件/程序
```

## 核心逻辑

Pi 的 Agent 可以使用四种交互外壳：

```text
interactive → 人在终端持续聊天
print       → 一次任务、一次输出、随后退出
json        → 程序读取每一步的 JSON 事件
rpc         → 程序长期连续发送任务
```

用户直接在终端运行 Pi 时，默认是 `interactive`：

```bash
pi
pi --use-theme dark
```

下列情况会选择其他模式：

```text
pi --mode json ...      → json
pi --mode rpc           → rpc
echo "任务" | pi        → print
pi "任务" > result.txt  → print
pi --print "任务"       → print
```

`--use-theme dark` 只有在 `interactive` 模式下才生效。它只覆盖本次运行的主题，不会改写设置文件。

非 `interactive` 模式下，Pi 会保护 stdout：正式结果留在 stdout，提示、日志和报错转到 stderr，避免污染外部程序读取的结果。

例如：

```bash
pi --mode json "帮我修复 bug" > result.jsonl
```

`result.jsonl` 应只包含 JSON 事件，不能混入“正在加载配置”之类的提示文字。

## 输出与状态变化

启动前还会运行：

```ts
runMigrations(cwd)
```

它将旧版本的数据迁移为当前 Pi 能读取的格式，例如旧凭证文件、旧会话位置和旧扩展目录。

目录分工：

```text
cwd      = 当前项目目录
agentDir = 所有 Pi 项目共用的个人数据目录
```

例如：

```text
cwd
  → 当前项目/.pi/
  → 当前项目自己的配置

agentDir
  → ~/.pi/agent/
  → 凭证、历史会话、全局设置
```

它们不是父子目录关系：多个项目的 `cwd` 会共用一个 `agentDir`。

### 恢复会话与短期记忆的区别

从项目 A 启动 Pi 后，用户可以选择恢复项目 B 的 session。此时 Pi 会读取 session B 已保存到磁盘的历史，并改用项目 B 的 cwd、设置、资源和模型配置；后续消息会追加到 session B，不会覆盖旧历史。

这不是“短期记忆自动跨对话”：

```text
新的 session A 与 session B
  → 默认互不共享历史

恢复 session B
  → 重新加载 session B 已保存的历史

--fork session B
  → 明确复制 B 的历史，创建一个新 session
```

恢复的内容是持久化的会话历史和配置，不包括上一次进程中所有临时运行状态。

### sessionDir、session 文件与 --continue

这三个概念不同：

```text
sessionDir
  → 存放多个 session 文件的文件夹

session 文件
  → 一次具体对话的历史记录，例如 login-fix.jsonl

sessionManager
  → 管理本次选中 session 文件的对象
```

`sessionDir` 只告诉 Pi 去哪个文件夹找 session，不代表已经选中了某个 session。

```text
pi
  → 在 sessionDir 创建新 session 文件

pi --continue
  → 在 sessionDir 找最近使用的 session 文件并打开

pi --resume
  → 列出旧 session，由用户选择一个

pi --session login-fix
  → 在 sessionDir 找指定的 session 文件

pi --fork login-fix
  → 复制指定 session 的历史，创建新 session 文件
```

## 下一步调用谁

`runMigrations(cwd)` 后，`main.ts` 创建：

```ts
const startupSettingsManager = SettingsManager.create(cwd, agentDir);
```

## 必要的 TypeScript

- `let`：定义后允许重新赋值的变量；`appMode` 后续可能从 `interactive` 改为 `print`。
- `const`：定义后不允许重新赋值的变量。
- 解构并改名：`{ migratedAuthProviders: migratedProviders }` 表示从返回对象取出 `migratedAuthProviders`，保存为本地变量 `migratedProviders`。

## Harness 设计收获

Agent 的核心逻辑应与交互外壳分离。同一个 Agent 可以服务于人类终端、一次性脚本、事件流和长期 RPC 调用。

项目级状态与全局用户状态也应分开保存：项目配置放在项目目录，共享凭证和跨项目会话放在全局目录。

## 未解决问题

- [ ] `SettingsManager.create(cwd, agentDir)` 分别从哪些文件读取设置？
