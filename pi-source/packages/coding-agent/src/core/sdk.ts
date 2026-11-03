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

	// 将 Pi 的 session 消息转换为模型消息；若设置禁止读图，再把图片内容替换为提示文字。
	const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
		// 先使用通用转换，得到可直接发送给模型的 Message[]。
		const converted = convertToLlm(messages);
		// 未开启“禁止图片读取”时，不修改图片内容，直接返回转换结果。
		if (!settingsManager.getBlockImages()) {
			return converted;
		}
		// 逐条生成新的模型消息；只有用户消息和工具结果可能含有要屏蔽的图片。
		return converted.map((msg) => {
			if (msg.role === "user" || msg.role === "toolResult") {
				const content = msg.content;
				// 纯文字 content 不可能含图片；只有内容块数组才继续检查。
				if (Array.isArray(content)) {
					// 数组中至少有一张图片时，才创建替换后的内容数组。
					const hasImages = content.some((c) => c.type === "image");
					if (hasImages) {
						// 图片块改为文字提示；其他文字或内容块原样保留。
						const filteredContent = content
							.map((c) =>
								// as const 让 TypeScript 把 type 固定识别为 "text"，符合文字内容块格式。
								c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
							)
							// 连续多张图片会生成重复提示；这里只保留第一条，移除后面相邻的同样提示。
							.filter(
								(c, i, arr) =>
									!(
										// 当前是提示文字、不是数组第一项，且前一项也是相同提示时，返回 false 将它过滤掉。
										c.type === "text" &&
										c.text === "Image reading is disabled." &&
										i > 0 &&
										arr[i - 1].type === "text" &&
										(arr[i - 1] as { type: "text"; text: string }).text === "Image reading is disabled."
									),
							);
						// ...msg 复制原消息字段，只把 content 换成已屏蔽图片的 filteredContent。
						return { ...msg, content: filteredContent };
					}
				}
			}
			// 不属于目标角色、内容不是数组或不含图片时，原消息不变。
			return msg;
		});
	};

	// 缓存预热器会在模型提示词缓存快过期时发送小型刷新请求；此处先准备给它的依赖。
	// ExtensionRunner 还未创建，因此先用这个空盒子保存它；后面创建完成后再写入 current。
	const extensionRunnerRef: { current?: ExtensionRunner } = {};
	const cacheWarmer = new CacheWarmer(
			// 之后用模型运行环境发送刷新缓存的模型请求。
		modelRuntime,
			// 之后读取当前 session 历史、记录刷新请求的用量。
		sessionManager,
			// 每次需要判断时再读取当前缓存预热设置。
		() => settingsManager.getCacheWarmingMode(),
			// 扩展已准备好时可改变本次预热决定；没有扩展时使用 Pi 原本的 event.action。
		async (event) => extensionRunnerRef.current?.emitCacheWarmingDecision(event) ?? event.action,
	);

	// 每次请求模型前，合并本次调用传入的设置与 Pi 配置中的超时、重试、请求头设置。
	const buildRequestOptions = (
		// 本次实际要请求的模型；后面用于生成该 provider 的请求头。
		requestModel: Model<any>,
		// 调用者没有额外传入请求设置时，默认使用空对象。
		options: ModelsSimpleStreamOptions = {},
	): ModelsSimpleStreamOptions => {
		// 读取 Pi 设置中 provider 的默认超时和重试配置。
		const providerRetrySettings = settingsManager.getProviderRetrySettings();
		// 读取“请求没有新数据时最多等待多久”的空闲超时设置。
		const httpIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
		// 设置为 0 表示不设空闲超时；用一个很大的毫秒数近似表示。
		const effectiveTimeoutMs = httpIdleTimeoutMs === 0 ? 2147483647 : httpIdleTimeoutMs;
		// 取出后面创建好的扩展运行器；它可能仍不存在，因此后续调用前会检查。
		const headerRunner = extensionRunnerRef.current;
		return {
			// 先保留调用者本次传入的其他请求选项。
			...options,
			// 超时优先级：本次调用的 timeoutMs → Pi 配置 → 0 被转换后的无空闲超时值。
			timeoutMs: options.timeoutMs ?? providerRetrySettings.timeoutMs ?? effectiveTimeoutMs,
			// WebSocket 连接超时：本次调用优先，没有时读取 Pi 配置。
			websocketConnectTimeoutMs: options.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs(),
			// 重试次数和每次重试的最大等待时间：本次调用优先，没有时读取 Pi 配置。
			maxRetries: options.maxRetries ?? providerRetrySettings.maxRetries,
			maxRetryDelayMs: options.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,

			// 真正发送模型网络请求前执行：先补充 Pi 的 Provider/session 请求头，再允许扩展最后修改。
			transformHeaders: async (requestHeaders) => {
				// 合并调用者原有请求头、当前模型、Pi 设置和本次 session 所需的 Provider 标识信息。
				const headers = mergeProviderAttributionHeaders(
					requestModel,
					settingsManager,
					options.sessionId,
					requestHeaders,
				);
				// 有扩展注册 before_provider_headers 时交给扩展处理；没有时直接使用合并结果。
				// headers 为空时用 {}，保证最终传出的始终是请求头对象。
				return headerRunner?.hasHandlers("before_provider_headers")
					? headerRunner.emitBeforeProviderHeaders(headers ?? {})
					: (headers ?? {});
			},
		};
	};

	// 为缓存预热器生成一个“之后再检查”的函数：之前记住的消息，是否仍原样处于当前消息的开头。
	const cacheContextIsCurrent = (requestModel: Model<any>) => {
		// 先记住准备预热时的消息数组；返回的函数在未来执行时会与当前消息比较。
		const messages = agent.state.messages;
		return () => {
			// 预热真正发生前，重新读取 Agent 此刻使用的模型和消息。
			const currentModel = agent.state.model;
			const currentMessages = agent.state.messages;
		// 模型未变，且之前记住的每条消息仍在当前历史开头的相同位置时，返回 true。
		// 切换模型、历史被替换或变短时，返回 false。
			return (
				currentModel.provider === requestModel.provider &&
				currentModel.id === requestModel.id &&
				messages.length <= currentMessages.length &&
				messages.every((message, index) => currentMessages[index] === message)
			);
		};
	};

	// 模型 Provider 请求真正发出前执行：扩展可在这里查看或修改本次请求内容。
	const transformProviderPayload = async (payload: unknown) => {
		// 取出已创建的扩展运行器；当前阶段它也可能不存在。
		const runner = extensionRunnerRef.current;
		// 没有扩展注册 before_provider_request 时，请求内容保持原样。
		if (!runner?.hasHandlers("before_provider_request")) return payload;
		// 交给扩展处理；扩展返回的内容会成为实际发送给 Provider 的请求内容。
		return runner.emitBeforeProviderRequest(payload);
	};

	// Provider 返回 HTTP 响应后调用；这里只通知扩展，不修改响应或 session。
	const handleProviderResponse: NonNullable<ModelsSimpleStreamOptions["onResponse"]> = async (response) => {
		// 取出已创建的扩展运行器；可能不存在。
		const runner = extensionRunnerRef.current;
		// runner 不存在，或没有扩展监听 after_provider_response 时，直接结束。
		if (!runner?.hasHandlers("after_provider_response")) return;
		// 将 Provider 的状态码和响应头发送给监听此事件的扩展。
		await runner.emit({
			type: "after_provider_response",
			status: response.status,
			headers: response.headers,
		});
	};
	// 模型流式输出期间，每收到一个 Provider 数据片段就调用；不同于上面的 HTTP 响应事件只通知一次。
	const handleProviderStreamEvent: NonNullable<ModelsSimpleStreamOptions["onProviderStreamEvent"]> = async (
		data,
		model,
	) => {
		// 取出已创建的扩展运行器；可能不存在。
		const runner = extensionRunnerRef.current;
		// 没有扩展监听 provider_stream_event 时，不处理当前流式片段。
		if (!runner?.hasHandlers("provider_stream_event")) return;
		// 将当前片段和本次模型的 Provider、API、模型名通知给扩展。
		await runner.emit({
			data,
			type: "provider_stream_event",
			provider: model.provider,
			api: model.api,
			model: model.id,
		});
	};

	// 创建真正负责模型请求和工具调用循环的 Agent；下方才会用它创建产品层的 AgentSession。
	const agent = new Agent({
		// Agent 刚创建时保存的初始状态包。
		initialState: {
			// 系统提示词和工具稍后由 AgentSession 与资源加载流程补充；此刻先为空。
			systemPrompt: "",
			// 前面已确定的本次模型和思考等级。
			model,
			thinkingLevel,
			// 工具同样在后面注册；恢复旧 session 时带入已有聊天历史，新 session 时通常为空数组。
			tools: [],
			messages: existingSession.messages,
		},
		// 将 Pi 的消息格式转换为模型所需格式；开启图片屏蔽时会先替换图片内容。
		convertToLlm: convertToLlmWithBlockImages,

		// Agent 以后需要模型回答时调用这里：整理请求设置、按需启动缓存预热，再真正发送流式模型请求。
		streamFn: async (model, context, options) => {
			// 合并本次请求传入的设置与 Pi 的超时、重试、请求头配置。
			const requestOptions = buildRequestOptions(model, options);
			// 只有请求属于当前 session 时，才让缓存预热器跟踪这次模型请求。
			if (options?.sessionId === sessionManager.getSessionId()) {
				// 保存模型、上下文和最终请求设置；第二个参数供之后确认上下文是否仍相同。
				cacheWarmer.start({ model, context, options: requestOptions }, cacheContextIsCurrent(model));
			}
			// 真正向 Provider 发送流式请求；Agent 会继续读取它返回的文字和工具调用等事件。
			return modelRuntime.streamSimple(model, context, requestOptions);
		},

		// 以下函数此刻不执行，交给 Agent 保存；之后 Agent 启动模型循环时，在对应阶段调用它们。
		onPayload: transformProviderPayload, // 请求发给 Provider 前处理请求内容。
		onResponse: handleProviderResponse, // Provider 返回一次 HTTP 响应后通知扩展。
		onProviderStreamEvent: handleProviderStreamEvent, // 每收到一个流式片段时通知扩展。
		// 当前 session 的 ID；Agent 后续创建模型循环配置时会继续传入。
		sessionId: sessionManager.getSessionId(),

		// 每次模型请求前处理完整消息上下文；扩展可在这里补充、删除或改写消息。
		transformContext: async (messages) => {
			// 取出已创建的扩展运行器；可能不存在。
			const runner = extensionRunnerRef.current;
			// 没有扩展时，完整上下文不作修改，原样交回 Agent。
			if (!runner) return messages;
			// 有扩展时，将完整消息数组交给扩展；扩展返回的数组成为最终模型上下文。
			return runner.emitContext(messages);
		},
		// 以下运行规则直接从 Pi 设置读取，交给 Agent 保存；具体处理发生在之后的 Agent 模型循环中。
		steeringMode: settingsManager.getSteeringMode(), // Agent 回答中用户又输入消息时的处理方式。
		followUpMode: settingsManager.getFollowUpMode(), // 当前回答结束后，等待消息的处理方式。
		transport: settingsManager.getTransport(), // 请求模型时使用的传输方式。
		thinkingBudgets: settingsManager.getThinkingBudgets(), // 各思考等级对应的额度设置。
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs, // 重试请求每次最多等待多久。
	});

	// 将本次使用的模型和思考等级写入 session 历史，供之后恢复 session 时读取。
	if (hasExistingSession) {
		// 旧 session 通常已有模型记录；只有历史缺少思考等级记录时才补写。
		if (!hasThinkingEntry) {
			sessionManager.appendThinkingLevelChange(thinkingLevel);
		}
	} else {
		// 新 session 尚无历史；先记录它从哪个模型开始。
		if (model) {
			sessionManager.appendModelChange(model.provider, model.id);
		}
		// 无论模型是否可用，都记录本次初始思考等级。
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}

	// 创建 Pi 的 AgentSession：它管理对话历史、设置、资源、工具和扩展，并在内部使用上面创建的 Agent。
	const session = new AgentSession({
		agent, // 刚创建的模型请求与工具调用循环对象。
		sessionManager, // 当前 session 的历史记录和 session 文件管理器。
		settingsManager, // 当前项目与 Pi 全局设置。
		cwd, // 当前 session 所属项目目录。
		// 用户本次可切换的模型范围；未指定时为 undefined，不额外限制。
		scopedModels: options.scopedModels,
		// 已加载项目 extensions、skills、提示词模板等资源的加载器。
		resourceLoader,
		// 调用者额外传入的自定义工具；未传时为 undefined。
		customTools: options.customTools,
		// 查询模型、认证状态和刷新模型信息所需的运行环境。
		modelRuntime,
		// 前面创建的提示词缓存预热器；AgentSession 会在合适时机通知它。
		cacheWarmer,
		// 启动时实际先启用的工具：用户选择或默认工具列表，并已去除 --exclude-tools 指定的名称。
		initialActiveToolNames,
		// 用户未直接指定工具列表，或使用 +write、-bash 这类修改符号，且未要求禁用工具时，表示本次使用默认工具规则。
		usesDefaultTools: (options.tools === undefined || toolModifiers !== undefined) && !options.noTools,
		// 用户传入的 +工具、-工具修改符号；AgentSession 之后可据此重新计算默认工具。
		defaultToolModifiers: toolModifiers,
		// 整个 session 期间只允许使用的工具名单；undefined 表示不设置这项限制。
		allowedToolNames,
		// 用户通过 --exclude-tools 指定的禁止工具名单。
		excludedToolNames,
		// 供 AgentSession 创建扩展运行器后写入的共享引用；前面 Agent 的 Hook 也通过它取得运行器。
		extensionRunnerRef,
		// 本次为何开始 session，例如首次启动、new、resume 或 fork。
		sessionStartEvent: options.sessionStartEvent,
	});

	// 取出前面已加载的扩展结果；这里只读取，不会重新加载项目资源。
	const extensionsResult = resourceLoader.getExtensions();

	// createAgentSession(...) 的最终结果：交回 agent-session-services.ts 的 createAgentSessionFromServices(...)。
	return {
		// 刚创建好的 Pi 对话 session，内部包含 Agent、历史、资源和工具管理。
		session,
		// 已加载扩展提供的结果，后续界面等逻辑可据此取得扩展信息。
		extensionsResult,
		// 恢复旧模型失败时的可选提示；正常情况为 undefined。
		modelFallbackMessage,
	};
}
