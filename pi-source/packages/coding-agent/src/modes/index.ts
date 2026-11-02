/**
 * 运行模式的统一转发入口。
 *
 * main.ts 在文件加载时从这里统一拿到三个模式：正常终端聊天、一次性输出、RPC。
 * 这不是 main() 运行时“调用 index.ts”；而是 import 建立的模块关系。
 * 此文件不创建 Session、模型或 UI，也不调用任何模式；它只把真正实现所在文件的名称转交出去。
 * 这样 main.ts 无需分别记住三个深层路径；将来内部文件移动时，只需修改此处的转发路径。
 */

// 正常终端聊天模式的控制器；真正实现在 interactive/interactive-mode.ts。
export { InteractiveMode, type InteractiveModeOptions } from "./interactive/interactive-mode.ts";
// JSON 模式会使用的事件类型；type 只用于 TypeScript 检查，运行时不会执行。
export type { JsonAgentSessionEvent } from "./json-event.ts";
// 一次性任务模式：文本或 JSON 输出一次结果后退出；真正实现在 print-mode.ts。
export { type PrintModeOptions, runPrintMode } from "./print-mode.ts";
// RPC 模式相关的类型定义；type 同样只用于 TypeScript 检查。
export { type ModelInfo, RpcClient, type RpcClientOptions, type RpcEventListener } from "./rpc/rpc-client.ts";
// RPC 长期运行模式的入口；真正实现在 rpc/rpc-mode.ts。
export { runRpcMode } from "./rpc/rpc-mode.ts";
// RPC 命令、请求和响应的类型定义；运行时不在这里处理它们。
export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "./rpc/rpc-types.ts";
