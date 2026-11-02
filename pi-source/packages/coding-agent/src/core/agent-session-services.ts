import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import type { SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { ModelRuntime } from "./model-runtime.ts";
import {
	DefaultResourceLoader,
	type DefaultResourceLoaderOptions,
	type ResourceLoader,
	type ResourceLoaderReloadOptions,
} from "./resource-loader.ts";
import { type CreateAgentSessionOptions, type CreateAgentSessionResult, createAgentSession } from "./sdk.ts";
import type { SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";

// 创建 services 或 AgentSession 时发现的问题记录；这里只规定格式，不负责输出或停止 Pi。
export interface AgentSessionRuntimeDiagnostic {
	// 问题等级：提示、警告或错误。
	type: "info" | "warning" | "error";
	// 给用户或上层调用者看的具体问题说明。
	message: string;
}

export interface CreateAgentSessionServicesOptions {
	// 必传：本次 session 所属的项目目录。
	cwd: string;
	// 可选：Pi 全局目录；不传时函数会使用默认全局目录。
	agentDir?: string;
	// 可选：已创建好的设置管理器；传入则复用，不传则函数自己创建。
	settingsManager?: SettingsManager;
	// 可选：已创建好的模型运行环境；传入则复用，不传则函数自己创建。
	modelRuntime?: ModelRuntime;
	// 可选：创建模型运行环境时使用的取消/超时信号。
	modelRuntimeSignal?: AbortSignal;
	// 可选：用户通过命令行传给扩展的“参数名 → 参数值”。
	extensionFlagValues?: Map<string, boolean | string>;
	// 可选：创建资源加载器时的额外配置；cwd、agentDir、settingsManager 由本函数统一提供。
	resourceLoaderOptions?: Omit<DefaultResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager">;
	// 可选：实际重新加载扩展、skills 等资源时使用的配置。
	resourceLoaderReloadOptions?: ResourceLoaderReloadOptions;
}

export interface CreateAgentSessionFromServicesOptions {
	// 第一步已准备好的设置、模型运行环境和资源加载器。
	services: AgentSessionServices;
	// 必传：本次 AgentSession 使用哪份 session 文件或内存 session。
	sessionManager: SessionManager;
	// 可选：记录本次 session 为何启动，例如首次启动、恢复或分叉。
	sessionStartEvent?: SessionStartEvent;
	// 可选：本次明确指定的模型与思考等级。
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	// 可选：限制本次可选模型范围，并可为每个模型指定思考等级。
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	// 可选：只启用的工具名称、要排除的工具，或完全禁用工具。
	tools?: string[];
	excludeTools?: CreateAgentSessionOptions["excludeTools"];
	noTools?: CreateAgentSessionOptions["noTools"];
	// 可选：额外加入的自定义工具定义。
	customTools?: ToolDefinition[];
}

// 第一步 createAgentSessionServices(...) 返回的 services 格式；
// 第二步 createAgentSessionFromServices(...) 会接收这个真实的 services 对象。
export interface AgentSessionServices {
	// 当前 session 所属项目目录，以及 Pi 全局目录。
	cwd: string;
	agentDir: string;
	// 已准备好的模型运行环境、设置管理器和项目资源加载器。
	modelRuntime: ModelRuntime;
	settingsManager: SettingsManager;
	resourceLoader: ResourceLoader;
	// 准备这些内容时收集到的问题记录。
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

// 校验用户传给扩展的命令行参数；有效值写入扩展，问题以 diagnostics 返回。
function applyExtensionFlagValues(
	resourceLoader: ResourceLoader,
	extensionFlagValues: Map<string, boolean | string> | undefined,
): AgentSessionRuntimeDiagnostic[] {
	if (!extensionFlagValues) {
		// 用户没有传扩展参数时，无需处理。
		return [];
	}
	// 先创建空数组，后面把未知参数、缺少参数值等问题记录到这里。
	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	// 取得已加载扩展及其声明支持的命令行参数，供后面检查用户输入。
	const extensionsResult = resourceLoader.getExtensions();
	// 先收集全部扩展声明支持的“参数名 → 参数类型”。
	const registeredFlags = new Map<string, { type: "boolean" | "string" }>();
	for (const extension of extensionsResult.extensions) {
		for (const [name, flag] of extension.flags) {
			registeredFlags.set(name, { type: flag.type });
		}
	}

	const unknownFlags: string[] = [];
	// 逐个校验用户传入的参数：有效则写入扩展运行时，无效则收集错误。
	for (const [name, value] of extensionFlagValues) {
		const flag = registeredFlags.get(name);
		if (!flag) {
			unknownFlags.push(name);
			continue;
		}
		if (flag.type === "boolean") {
			// 扩展声明为开关参数：用户只要写了该参数，就保存为 true。
			extensionsResult.runtime.flagValues.set(name, true);
			continue;
		}
		if (typeof value === "string") {
			// 扩展声明需要文字值：例如用户写 --branch main，就保存 branch = "main"。
			extensionsResult.runtime.flagValues.set(name, value);
			continue;
		}
		// 已知参数要求文字值，但用户只写了名称、没有提供值时，记录错误。
		diagnostics.push({
			type: "error",
			message: `Extension flag "--${name}" requires a value`,
		});
	}

	if (unknownFlags.length > 0) {
		// 存在未知参数时，将它们合并为一条错误；一个用 option，多个用 options。
		diagnostics.push({
			type: "error",
			message: `Unknown option${unknownFlags.length === 1 ? "" : "s"}: ${unknownFlags.map((name) => `--${name}`).join(", ")}`,
		});
	}

	// 返回全部错误记录；上层决定是否显示或停止 Pi。
	return diagnostics;
}


// 第一步：根据调用者传入的资料包，准备模型、设置和资源加载器；不创建 AgentSession。
export async function createAgentSessionServices(
	// options 只是参数名，表示调用者传入的全部资料；例如 cwd、agentDir 和可复用的服务。
	options: CreateAgentSessionServicesOptions,
): Promise<AgentSessionServices> {
	// 将传入的项目目录整理为最终使用的路径。
	const cwd = resolvePath(options.cwd);
	// 调用者传入 agentDir 时使用它；未传时取得 Pi 默认全局目录。
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getAgentDir();
	// 调用者已准备 modelRuntime 时直接复用；未传时才根据 Pi 全局目录中的认证和模型配置创建。
	const modelRuntime =
		options.modelRuntime ??
		(await ModelRuntime.create({
			// auth.json 保存认证信息；models.json 保存模型相关配置。
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			// 创建过程可使用调用者传入的取消/超时信号。
			signal: options.modelRuntimeSignal,
		}));
	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	// 先创建资源加载器：调用者传入的额外加载配置会展开到对象中，
	// cwd、agentDir、settingsManager 则由本函数统一提供。
	const resourceLoader = new DefaultResourceLoader({
		...(options.resourceLoaderOptions ?? {}),
		cwd,
		agentDir,
		settingsManager,
	});
	// 此处才真正加载扩展、skills、提示词模板等资源。
	await resourceLoader.reload(options.resourceLoaderReloadOptions);

	// 收集扩展注册 provider 时发生的问题，后面与其他问题一起返回。
	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	// 资源加载阶段，扩展提出的“新增 provider”请求会暂存在 extensionsResult 中。
	const extensionsResult = resourceLoader.getExtensions();
	// 现在 modelRuntime 已准备好，逐个将扩展待注册的普通 provider 真正注册进去。
	for (const { name, config, extensionPath } of extensionsResult.runtime.pendingProviderRegistrations) {
		try {
			modelRuntime.registerProvider(name, config);
		} catch (error) {
			// 某个扩展的 provider 配置无效时，记录错误，不在这里中断整个启动流程。
			const message = error instanceof Error ? error.message : String(error);
			diagnostics.push({
				type: "error",
				message: `Extension "${extensionPath}" error: ${message}`,
			});
		}
	}
	// 这批待注册请求已处理，清空以避免之后重复注册。
	extensionsResult.runtime.pendingProviderRegistrations = [];
	// 与普通 provider 相同的待办处理流程；区别是扩展直接交来已实现的 native provider 对象。
	for (const { provider, extensionPath } of extensionsResult.runtime.pendingNativeProviderRegistrations) {
		try {
			modelRuntime.registerNativeProvider(provider);
		} catch (error) {
			// 某个扩展交来的 native provider 无效时，记录错误，不中断整个启动流程。
			const message = error instanceof Error ? error.message : String(error);
			diagnostics.push({
				type: "error",
				message: `Extension "${extensionPath}" error: ${message}`,
			});
		}
	}
	// 这批 native provider 已登记，清空待办列表以避免之后重复登记。
	extensionsResult.runtime.pendingNativeProviderRegistrations = [];
	// 同样处理扩展待注册的虚拟模型：它是一个模型选择名称，后续会路由到真实模型。
	for (const { definition, extensionPath } of extensionsResult.runtime.pendingVirtualModelRegistrations) {
		try {
			modelRuntime.registerVirtualModel(definition);
		} catch (error) {
			// 某个扩展交来的虚拟模型定义无效时，记录错误，不中断整个启动流程。
			const message = error instanceof Error ? error.message : String(error);
			diagnostics.push({
				type: "error",
				message: `Extension "${extensionPath}" error: ${message}`,
			});
		}
	}
	// 这批虚拟模型已登记，清空待办列表以避免之后重复登记。
	extensionsResult.runtime.pendingVirtualModelRegistrations = [];

	// 三类登记可能改变可用模型列表；刷新 modelRuntime，使后续创建 session 时看到最新结果。
	// allowNetwork: false 表示本次只使用本地信息，不为刷新模型列表额外联网。
	await modelRuntime.refresh({ allowNetwork: false });
	// 校验函数返回的是错误数组；... 将每条错误分别加入 diagnostics，保持它是一维错误列表。
	diagnostics.push(...applyExtensionFlagValues(resourceLoader, options.extensionFlagValues));

	// 第一步完成：将已准备好的目录、模型、设置、资源和问题记录打包为 services 返回给调用者。
	// 这里使用对象简写：cwd 等同于 cwd: cwd，其他字段同理。
	return {
		cwd,
		agentDir,
		modelRuntime,
		settingsManager,
		resourceLoader,
		diagnostics,
	};
}


// 第二步：使用第一步已准备好的 services，加上本次 session 的专属选项，交给 sdk.ts 真正创建 AgentSession。
export async function createAgentSessionFromServices(
	// options 包含 services、要使用的 sessionManager，以及模型和工具等本次 session 专属选项。
	options: CreateAgentSessionFromServicesOptions,
): Promise<CreateAgentSessionResult> {
	// 本函数不自行创建 AgentSession；只将资料转交给 sdk.ts 的 createAgentSession(...).
	return createAgentSession({
		// 这些通用运行资料来自第一步返回的 services。
		cwd: options.services.cwd,
		agentDir: options.services.agentDir,
		modelRuntime: options.services.modelRuntime,
		settingsManager: options.services.settingsManager,
		resourceLoader: options.services.resourceLoader,
		// 这份 session 专属资料来自调用者本次传入的 options。
		sessionManager: options.sessionManager,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		scopedModels: options.scopedModels,
		tools: options.tools,
		excludeTools: options.excludeTools,
		noTools: options.noTools,
		customTools: options.customTools,
		sessionStartEvent: options.sessionStartEvent,
	});
}
