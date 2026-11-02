import { join } from "node:path";
import { Agent, type AgentMessage, setDefaultStreamFn, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { clampThinkingLevel, type Message, type Model, streamSimple } from "@earendil-works/pi-ai/compat";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import { AgentSession } from "./agent-session.ts";
import { formatNoModelsAvailableMessage } from "./auth-guidance.ts";
import { CacheWarmer } from "./cache-warmer.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { ExtensionRunner, LoadExtensionsResult, SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { createToolNameMatcher } from "./mcp-servers.ts";
import { convertToLlm } from "./messages.ts";
import { findInitialModel } from "./model-resolver.ts";
import { ModelRuntime } from "./model-runtime.ts";
import { mergeProviderAttributionHeaders } from "./provider-attribution.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import { DefaultResourceLoader } from "./resource-loader.ts";
import { getDefaultSessionDir, SessionManager } from "./session-manager.ts";
import {
	applyToolModifiers,
	DEFAULT_TOOL_NAMES,
	getToolListError,
	isToolModifier,
	SettingsManager,
} from "./settings-manager.ts";
import { time } from "./timings.ts";
import {
	createBashTool,
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createPowerShellTool,
	createReadOnlyTools,
	createReadTool,
	createWriteTool,
	withFileMutationQueue,
} from "./tools/index.ts";
import { getBranchSelection } from "./virtual-models.ts";

// sdk.ts 被加载时，先登记 Agent 的默认流式模型请求方式；
// 后面创建当前 session 的 Agent 时会传入专用 streamFn，未传时才使用这个备用默认值。
setDefaultStreamFn(streamSimple);

export interface CreateAgentSessionOptions {
	// 可选：项目目录与 Pi 全局目录；未传时 createAgentSession(...) 会自行使用默认值。
	cwd?: string;
	agentDir?: string;
	// 可选：已准备好的模型运行环境；未传时函数自行创建。
	modelRuntime?: ModelRuntime;
	// 可选：本次要使用的模型、思考等级，以及交互模式可切换的模型范围。
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	// 可选：本次工具的启用、排除、完全禁用与自定义工具配置。
	noTools?: "all" | "builtin";
	tools?: string[];
	excludeTools?: string[];
	customTools?: ToolDefinition[];
	// 可选：已准备好的资源加载器、session 管理器与设置管理器；未传时函数自行创建默认对象。
	resourceLoader?: ResourceLoader;
	sessionManager?: SessionManager;
	settingsManager?: SettingsManager;
	// 可选：记录本次 session 为什么启动，例如首次启动、恢复或分叉。
	sessionStartEvent?: SessionStartEvent;
}

// createAgentSession(...) 成功后的返回结果格式；
// agent-session-services.ts 的 createAgentSessionFromServices(...) 接到后，原样返回给 main.ts。
// main.ts 再用它继续创建 runtime。
export interface CreateAgentSessionResult {
	// 真正创建好的 AgentSession；后续由 AgentSessionRuntime 保存并管理。
	session: AgentSession;
	// 本次资源加载得到的扩展结果；交互界面等后续逻辑可据此取得扩展提供的信息。
	extensionsResult: LoadExtensionsResult;
	// 可选：恢复旧 session 时，原模型不可用而改用其他模型的提示文字。
	modelFallbackMessage?: string;
}

export * from "./agent-session-runtime.ts";
export type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	InlineExtension,
	SlashCommandInfo,
	SlashCommandSource,
	ToolDefinition,
} from "./extensions/index.ts";
export type { PromptTemplate } from "./prompt-templates.ts";
export type { Skill } from "./skills.ts";
export type { Tool } from "./tools/index.ts";

export {
	withFileMutationQueue,
	createCodingTools,
	createReadOnlyTools,
	createReadTool,
	createBashTool,
	createEditTool,
	createWriteTool,
	createGrepTool,
	createFindTool,
	createLsTool,
	createPowerShellTool,
};

function getDefaultAgentDir(): string {
	return getAgentDir();
}

// sdk.ts 的实际创建入口：接收已准备好的资料或自行补默认值，最终创建 Agent 与 AgentSession。
// agent-session-services.ts 的 createAgentSessionFromServices(...) 会调用此函数。
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	// 调用者未传 options 时使用空对象；后面每项资料按各自规则补默认值。
	// cwd 按优先级选择：明确传入的 cwd → sessionManager 所属项目目录 → 进程当前目录。
	const cwd = resolvePath(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd());
	// 调用者传入 agentDir 时使用它；未传时使用 Pi 默认全局目录。
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getDefaultAgentDir();
	// 优先复用调用者已准备好的资源加载器；若没有，后面的 if 才创建默认加载器。
	// 使用 let 是因为后面可能将 undefined 重新赋值为新建的 DefaultResourceLoader。
	let resourceLoader = options.resourceLoader;

	// 调用者明确指定 agentDir 时，从该目录读取认证与模型配置；未指定时交给 ModelRuntime 使用自己的默认路径。
	const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
	const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
	// 已传入 modelRuntime 时直接复用；否则以确定的配置路径创建新的模型运行环境。
	const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create({ authPath, modelsPath }));

	// sdk.ts 不实现这些对象：调用者传入现成对象就复用，未传才调用其他文件已有的 create / new 补齐。
	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const sessionManager = options.sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));

	if (!resourceLoader) {
		// 调用者未传资源加载器时，才按当前项目目录、Pi 全局目录和设置创建默认加载器。
		resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		// 创建加载器后，真正加载扩展、skills、提示词模板等项目资源。
		await resourceLoader.reload();
		// 记录本次资源加载耗时，供启动测速输出使用。
		time("resourceLoader.reload");
	}

	// 整理当前 session 的历史，得到聊天消息、思考等级等已有状态。
	const existingSession = sessionManager.buildSessionContext();
	// 检查是否已有聊天消息；后面据此决定是否尝试恢复旧 session 的状态。
	const hasExistingSession = existingSession.messages.length > 0;
	// 单独检查当前历史分支中是否保存过思考等级记录；有消息不代表一定有这条记录。
	const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");

	// 先使用调用者明确指定的模型；若没有，后面再尝试恢复旧 session 的模型或选择默认模型。
	let model = options.model;
	// 旧 session 的模型无法恢复时，在这里保存稍后返回给调用者的提示文字；目前尚无提示。
	let modelFallbackMessage: string | undefined;

	// 从 session 历史中找之前选用的模型标识（provider 和 modelId），还不是完整模型对象。
	const sessionModel = getBranchSelection(
		sessionManager.getBranch(),
		// 此查找函数供 getBranchSelection 内部按需使用，帮助判断历史中的模型选择（包括虚拟模型）。
		(provider, modelId) => modelRuntime.getModel(provider, modelId),
	);

	// 调用者未指定模型，且 session 有消息和历史模型标识时，尝试恢复旧模型。
	if (!model && hasExistingSession && sessionModel) {
		// 根据找到的标识再次查模型：这次取回完整模型对象，供当前 session 使用。
		const restoredModel = modelRuntime.getModel(sessionModel.provider, sessionModel.modelId);
		// 模型存在且已配置对应 provider 的认证时，使用这个旧模型。
		if (restoredModel && modelRuntime.hasConfiguredAuth(restoredModel.provider)) {
			model = restoredModel;
		}
		// 无法恢复时记下提示；后面继续尝试选择其他模型。
		if (!model) {
			modelFallbackMessage = `Could not restore model ${sessionModel.provider}/${sessionModel.modelId}`;
		}
	}

	// 若调用者没有指定模型、也未能恢复旧模型，就根据设置和当前可用模型寻找初始模型。
	if (!model) {
		const result = await findInitialModel({
			// 此处传入的限定模型列表为空；hasExistingSession 表示当前 session 是否已有消息。
			scopedModels: [],
			isContinuing: hasExistingSession,
			// 从设置中取得默认 provider、默认模型，以及默认和各模型的思考等级。
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelThinkingLevels: settingsManager.getAllModelThinkingLevels(),
			// 用模型运行环境查询当前模型及认证信息。
			modelRuntime,
		});
		// 使用 findInitialModel 找到的模型，可能是设置里的默认模型，也可能是当前可用模型中的其他选择。
		model = result.model;
		if (!model) {
			// 没找到任何可用模型时，保存提示；后面会把 thinkingLevel 设为 off。
			modelFallbackMessage = formatNoModelsAvailableMessage();
		} else if (modelFallbackMessage) {
			// 旧 session 的模型恢复失败、但找到替代模型时，把实际替代模型也写进提示。
			modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
		}
	}

	// 先采用调用者本次明确传入的思考等级；未传时再尝试恢复或使用默认值。
	let thinkingLevel = options.thinkingLevel;

	// 未指定思考等级且 session 有聊天历史时，优先恢复历史中记录的等级。
	if (thinkingLevel === undefined && hasExistingSession) {
		thinkingLevel = hasThinkingEntry
			// 有思考等级记录：使用旧 session 的等级。
			? (existingSession.thinkingLevel as ThinkingLevel)
			// 没有记录：使用 Pi 配置的默认等级；配置也未设置时使用内置默认等级。
			: (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
	}

	// 前面仍未确定等级、且已选到模型时，先查这个模型自己的思考等级配置。
	if (thinkingLevel === undefined && model) {
		// 例如 openai/gpt-5 可在设置中单独配置为 high。
		const perModel = settingsManager.getModelThinkingLevel(model.provider, model.id);
		if (perModel) {
			// 找到模型专属配置后，作为本次 session 的思考等级。
			thinkingLevel = perModel;
		}
	}
	// 新 session 没有历史等级、模型也没有专属配置时，使用全局默认值；仍没有则用内置默认值。
	if (thinkingLevel === undefined) {
		thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	}
	// 没有可用模型时，无法进行模型思考，强制关闭。
	if (!model) {
		thinkingLevel = "off";
	} else {
		// 已选到模型时，把等级限制在该模型实际支持的范围内，再作为最终等级。
		thinkingLevel = clampThinkingLevel(model, thinkingLevel) as ThinkingLevel;
	}

	// 用户指定了工具列表时才检查其格式；未指定时没有工具列表错误。
	const toolListError = options.tools ? getToolListError(options.tools) : undefined;
	// 工具列表不合法时停止创建 session，避免带着错误的工具配置继续运行。
	if (toolListError) throw new Error(`Invalid tools option: ${toolListError}`);
	// 用户要求禁用工具时默认列表为空；否则先读 Pi 配置，配置没有才使用内置默认工具。
	const defaultToolNames = options.noTools ? [] : (settingsManager.getDefaultTools() ?? DEFAULT_TOOL_NAMES);

	// 检查用户工具列表中是否含 +write、-bash 这类“在默认列表上增删”的修改符号。
	// options.tools 未传时，?. 会直接得到 undefined，不会调用 some(...)。
	const toolModifiers = options.tools?.some(isToolModifier) ? options.tools : undefined;
	// 有修改符号时，把增删要求应用到默认工具列表；否则用户传入的列表就是最终选择。
	const selectedToolNames = toolModifiers ? applyToolModifiers(defaultToolNames, toolModifiers) : options.tools;

	// allowedToolNames 是 session 的“只允许这些工具”限制。--no-tools 会在 main.ts 转为 noTools: "all"。
	const allowedToolNames = toolModifiers
		// 用户传入 +write、-bash 这类修改符号时：只有先 --no-tools 关闭全部工具，
		// 才把修改后留下的 selectedToolNames 作为允许名单；否则仅修改默认启动工具，不设硬限制。
		? options.noTools === "all"
			? selectedToolNames
			: undefined
		// 用户传入普通工具列表时，直接作为允许名单；只传 --no-tools 时，空数组表示不允许任何工具。
		: (options.tools ?? (options.noTools === "all" ? [] : undefined));

	// 用户通过 --exclude-tools 指定本次启动时要排除的工具名称。
	const excludedToolNames = options.excludeTools;
	// 有排除名单时，创建“某个工具名是否应排除”的判断函数；没有名单则不创建。
	const isExcludedTool = excludedToolNames ? createToolNameMatcher(excludedToolNames) : undefined;
	// 从用户选中的工具或默认工具开始，逐个过滤掉排除名单中的工具，得到初始启用列表。
	const initialActiveToolNames = (selectedToolNames ?? defaultToolNames).filter((name) => !isExcludedTool?.(name));

	const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
		const converted = convertToLlm(messages);
		if (!settingsManager.getBlockImages()) {
			return converted;
		}
		return converted.map((msg) => {
			if (msg.role === "user" || msg.role === "toolResult") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const hasImages = content.some((c) => c.type === "image");
					if (hasImages) {
						const filteredContent = content
							.map((c) =>
								c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
							)
							.filter(
								(c, i, arr) =>
									!(
										c.type === "text" &&
										c.text === "Image reading is disabled." &&
										i > 0 &&
										arr[i - 1].type === "text" &&
										(arr[i - 1] as { type: "text"; text: string }).text === "Image reading is disabled."
									),
							);
						return { ...msg, content: filteredContent };
					}
				}
			}
			return msg;
		});
	};

	const extensionRunnerRef: { current?: ExtensionRunner } = {};
	const cacheWarmer = new CacheWarmer(
		modelRuntime,
		sessionManager,
		() => settingsManager.getCacheWarmingMode(),
		async (event) => extensionRunnerRef.current?.emitCacheWarmingDecision(event) ?? event.action,
	);
	const buildRequestOptions = (
		requestModel: Model<any>,
		options: ModelsSimpleStreamOptions = {},
	): ModelsSimpleStreamOptions => {
		const providerRetrySettings = settingsManager.getProviderRetrySettings();
		const httpIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
		const effectiveTimeoutMs = httpIdleTimeoutMs === 0 ? 2147483647 : httpIdleTimeoutMs;
		const headerRunner = extensionRunnerRef.current;
		return {
			...options,
			timeoutMs: options.timeoutMs ?? providerRetrySettings.timeoutMs ?? effectiveTimeoutMs,
			websocketConnectTimeoutMs: options.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs(),
			maxRetries: options.maxRetries ?? providerRetrySettings.maxRetries,
			maxRetryDelayMs: options.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
			transformHeaders: async (requestHeaders) => {
				const headers = mergeProviderAttributionHeaders(
					requestModel,
					settingsManager,
					options.sessionId,
					requestHeaders,
				);
				return headerRunner?.hasHandlers("before_provider_headers")
					? headerRunner.emitBeforeProviderHeaders(headers ?? {})
					: (headers ?? {});
			},
		};
	};
	const cacheContextIsCurrent = (requestModel: Model<any>) => {
		const messages = agent.state.messages;
		return () => {
			const currentModel = agent.state.model;
			const currentMessages = agent.state.messages;
			return (
				currentModel.provider === requestModel.provider &&
				currentModel.id === requestModel.id &&
				messages.length <= currentMessages.length &&
				messages.every((message, index) => currentMessages[index] === message)
			);
		};
	};
	const transformProviderPayload = async (payload: unknown) => {
		const runner = extensionRunnerRef.current;
		if (!runner?.hasHandlers("before_provider_request")) return payload;
		return runner.emitBeforeProviderRequest(payload);
	};
	const handleProviderResponse: NonNullable<ModelsSimpleStreamOptions["onResponse"]> = async (response) => {
		const runner = extensionRunnerRef.current;
		if (!runner?.hasHandlers("after_provider_response")) return;
		await runner.emit({
			type: "after_provider_response",
			status: response.status,
			headers: response.headers,
		});
	};
	const handleProviderStreamEvent: NonNullable<ModelsSimpleStreamOptions["onProviderStreamEvent"]> = async (
		data,
		model,
	) => {
		const runner = extensionRunnerRef.current;
		if (!runner?.hasHandlers("provider_stream_event")) return;
		await runner.emit({
			data,
			type: "provider_stream_event",
			provider: model.provider,
			api: model.api,
			model: model.id,
		});
	};

	const agent = new Agent({
		initialState: {
			systemPrompt: "",
			model,
			thinkingLevel,
			tools: [],
			messages: existingSession.messages,
		},
		convertToLlm: convertToLlmWithBlockImages,
		streamFn: async (model, context, options) => {
			const requestOptions = buildRequestOptions(model, options);
			if (options?.sessionId === sessionManager.getSessionId()) {
				cacheWarmer.start({ model, context, options: requestOptions }, cacheContextIsCurrent(model));
			}
			return modelRuntime.streamSimple(model, context, requestOptions);
		},
		onPayload: transformProviderPayload,
		onResponse: handleProviderResponse,
		onProviderStreamEvent: handleProviderStreamEvent,
		sessionId: sessionManager.getSessionId(),
		transformContext: async (messages) => {
			const runner = extensionRunnerRef.current;
			if (!runner) return messages;
			return runner.emitContext(messages);
		},
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		transport: settingsManager.getTransport(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
	});

	if (hasExistingSession) {
		if (!hasThinkingEntry) {
			sessionManager.appendThinkingLevelChange(thinkingLevel);
		}
	} else {
		if (model) {
			sessionManager.appendModelChange(model.provider, model.id);
		}
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		scopedModels: options.scopedModels,
		resourceLoader,
		customTools: options.customTools,
		modelRuntime,
		cacheWarmer,
		initialActiveToolNames,
		usesDefaultTools: (options.tools === undefined || toolModifiers !== undefined) && !options.noTools,
		defaultToolModifiers: toolModifiers,
		allowedToolNames,
		excludedToolNames,
		extensionRunnerRef,
		sessionStartEvent: options.sessionStartEvent,
	});

	const extensionsResult = resourceLoader.getExtensions();

	return {
		session,
		extensionsResult,
		modelFallbackMessage,
	};
}
