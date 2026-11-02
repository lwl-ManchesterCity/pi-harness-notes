import { constants, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join, parse, resolve } from "node:path";
import { resolvePath } from "../utils/paths.ts";
import type { AgentSession } from "./agent-session.ts";
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./agent-session-services.ts";
import type {
	ProjectTrustContext,
	ReplacedSessionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
// 该结果类型定义在 sdk.ts：createAgentSession(...) 创建完成后返回 session、extensionsResult、modelFallbackMessage。
// 此处 import type 只引用它的结构，不会在运行时执行 sdk.ts 的任何创建逻辑。
import type { CreateAgentSessionResult } from "./sdk.ts";
import { assertSessionCwdExists } from "./session-cwd.ts";
import { SessionManager } from "./session-manager.ts";

// 规定“创建 runtime 后交出的完整结果包”必须包含什么；这里只是 TypeScript 类型说明，不创建任何对象。
// extends 表示继承 CreateAgentSessionResult 中已有的 session、extensionsResult、modelFallbackMessage，
// 再额外要求 services（模型、设置、资源等工具）和 diagnostics（启动警告、错误列表）。
export interface CreateAgentSessionRuntimeResult extends CreateAgentSessionResult {
	services: AgentSessionServices;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}
// 规定 createRuntime 这类“运行环境创建函数”必须长什么样；这里只定义函数规格，不会调用它。
// 它接收一个 options 对象，异步完成后（Promise）返回上面定义的完整结果包。
export type CreateAgentSessionRuntimeFactory = (options: {
	// 本次目标 session 所属项目的目录；据此读取该项目的设置和资源。
	cwd: string;
	// Pi 所有项目共用的全局目录；据此读取全局设置、认证和数据。
	agentDir: string;
	// 管理本次 session 文件、历史消息和所属 cwd 的对象。
	sessionManager: SessionManager;
	// 可选：本次为何开始 session，例如首次启动、new、resume 或 fork。
	sessionStartEvent?: SessionStartEvent;
	// 可选：项目可信确认所需的交互上下文。
	projectTrustContext?: ProjectTrustContext;
}) => Promise<CreateAgentSessionRuntimeResult>;

// /import 指向不存在的 JSONL session 文件时使用的自定义错误类型；首次启动主链不会执行到这里。
export class SessionImportFileNotFoundError extends Error {
	// 每个错误对象自己的文件路径；readonly 表示 TypeScript 不允许在 constructor 赋值后重新修改，
	// 不是 static 静态字段，多个错误对象可分别保存不同路径。
	readonly filePath: string;

	constructor(filePath: string) {
		// 调用父类 Error，生成给用户看的错误文字。
		super(`File not found: ${filePath}`);
		// 指定错误类型名称，后续代码可区分“导入文件不存在”和其他普通错误。
		this.name = "SessionImportFileNotFoundError";
		this.filePath = filePath;
	}
}

// 从用户消息中抽取纯文字，供后面的 /fork 在复制消息分支时使用；不创建或修改 session。
// content 可以是直接字符串，也可以是文字、图片等多段内容组成的数组。
function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	// 已经是普通文字时无需处理，直接返回。
	if (typeof content === "string") {
		return content;
	}
	// 多段内容时：filter 只保留有 text 字符串的文字段；map 取每段文字；join("") 拼成一个字符串。
	// (part): part is ... 是 TypeScript 类型判断，告诉后续 map：保留下来的 part 一定可以安全读取 text。
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

// 运行容器：持有当前 AgentSession 与其绑定到项目 cwd 的 services。
// 后面的切换、创建、分叉、导入 session 都会先关闭旧 runtime，再创建并应用新的 runtime；
// 若新建失败，错误交给调用者决定如何向用户显示。
export class AgentSessionRuntime {
	// 切换到新 session 后，由外部界面注册的回调；它可把 UI 重新绑定到新的 AgentSession。
	private rebindSession?: (session: AgentSession) => Promise<void>;
	// 旧 session 即将失效前，由外部界面注册的同步清理回调。
	private beforeSessionInvalidate?: () => void;

	// 当前正在运行的 AgentSession：保存消息、模型、工具调用等本次对话状态。
	private _session: AgentSession;
	// 与当前项目 cwd 绑定的服务：模型、设置、资源加载等工具。
	private _services: AgentSessionServices;
	// 重新创建 runtime 的函数配方；以后 /new、/resume、/fork、/import 都复用它创建新的 session 和 services。
	// readonly 表示构造完成后不会把它替换为另一份配方。
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	// 当前 runtime 创建阶段收集的警告和错误。
	private _diagnostics: AgentSessionRuntimeDiagnostic[];
	// 恢复旧 session 时，若原模型不可用而改用其他模型，保存给用户显示的可选提示。
	private _modelFallbackMessage?: string;

	// new AgentSessionRuntime(...) 时自动执行。它不负责创建 AgentSession，
	// 只把外面已准备好的内容保存到本对象的内部字段，组成一个 runtime 容器。
	constructor(
		// 已创建好的当前 AgentSession：本轮会话的消息、模型和工具调用状态。
		_session: AgentSession,
		// 与该 session 对应的服务：设置、模型运行时、资源加载器等。
		_services: AgentSessionServices,
		// 以后执行 /new、/resume、/fork、/import 时，重新创建一整套 session + services 的函数配方。
		createRuntime: CreateAgentSessionRuntimeFactory,
		// 本次创建时收集到的诊断信息；调用者没有传时，= [] 表示默认使用空数组。
		_diagnostics: AgentSessionRuntimeDiagnostic[] = [],
		// 可选：恢复 session 时原模型不可用而发生降级时，给用户显示的提示；没有则为 undefined。
		_modelFallbackMessage?: string,
	) {
		// 参数名带 _ 只是用来和下面要保存的私有字段区分；不是特殊 TypeScript 语法。
		this._session = _session;
		this._services = _services;
		this.createRuntime = createRuntime;
		this._diagnostics = _diagnostics;
		this._modelFallbackMessage = _modelFallbackMessage;
	}

	// 对外读取入口：后续代码从 runtime 取当前 session、服务、项目目录或启动诊断；这里不创建也不修改数据。
	get services(): AgentSessionServices {
		return this._services;
	}
	get session(): AgentSession {
		return this._session;
	}
	get cwd(): string {
		return this._services.cwd;
	}
	get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
		return this._diagnostics;
	}
	get modelFallbackMessage(): string | undefined {
		return this._modelFallbackMessage;
	}

	setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void {
		//记住外部提供的“换 session 后如何重新绑定 UI”处理；此处只保存，不执行。
		this.rebindSession = rebindSession;
	}

	setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
		//外部提供的“旧 session 失效前如何清理 UI”处理；此处只保存，不执行。
		this.beforeSessionInvalidate = beforeSessionInvalidate;
	}

	private async emitBeforeSwitch(
		reason: "new" | "resume",
		targetSessionFile?: string,
	): Promise<{ cancelled: boolean }> {
		// 切换到新建或旧 session 前，先询问当前 session 的扩展是否要取消本次切换。
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_switch")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_switch",
			reason,
			targetSessionFile,
		});
		return { cancelled: result?.cancel === true };
	}

	private async emitBeforeFork(
		entryId: string,
		options: { position: "before" | "at" },
	): Promise<{ cancelled: boolean }> {
		// 分叉 session 前，先询问当前 session 的扩展是否要取消本次分叉。
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_fork")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_fork",
			entryId,
			...options,
		});
		return { cancelled: result?.cancel === true };
	}

	// 替换 runtime 当前的 session 前，先完整收尾旧 session；本函数结束后，后续代码才会装入新 session。
	private async teardownCurrent(reason: SessionShutdownEvent["reason"], targetSessionFile?: string): Promise<void> {
		// 替换 session 前，先让当前正在进行的回答或工具调用停止；已产生的内容会保存进即将离开的旧 session。
		//先等旧 session 真正停下来，再通知扩展、清理 UI、关闭旧 session
		await this.session.abort();
		// 旧 session 停止后，通知其中的扩展开始收尾；等待扩展处理完成，再继续关闭。
		await emitSessionShutdownEvent(this.session.extensionRunner, {
			type: "session_shutdown",
			reason,
			targetSessionFile,
		});
		// 若前面保存过 UI 清理函数，就在旧 session 失效前执行它。
		this.beforeSessionInvalidate?.();
		// 正式关闭旧 session；下一步才会把新 session 装入 runtime。
		this.session.dispose();
	}

	// 旧 session 已收尾后，接收 createRuntime 创建的新运行结果包：新 session、配套 services、诊断与可选模型提示。
	// 再用这整包内容替换 runtime 当前保存的旧内容。
	private apply(result: CreateAgentSessionRuntimeResult): void {
		this._session = result.session;
		this._services = result.services;
		this._diagnostics = result.diagnostics;
		this._modelFallbackMessage = result.modelFallbackMessage;
	}

	// 新 session 已装入 runtime 后，执行外部需要的后续动作，使界面和本次调用者开始使用新 session。
	private async finishSessionReplacement(withSession?: (ctx: ReplacedSessionContext) => Promise<void>): Promise<void> {
		if (this.rebindSession) {
			// 每次切换都可执行的长期动作：让外部界面重新绑定当前新 session。
			await this.rebindSession(this.session);
		}
		if (withSession) {
			// 仅本次切换传入的临时动作：交给调用者处理新 session 的后续工作。
			await withSession(this.session.createReplacedSessionContext());
		}
	}

	// 恢复一个已保存的旧 session，并用它替换 runtime 当前 session；切换成功时会同步换掉配套 services。
	async switchSession(
		// 要恢复的旧 session 文件路径。
		sessionPath: string,
		options?: {
			// 可选：用指定项目目录覆盖旧 session 原本记录的 cwd。
			cwdOverride?: string;
			// 可选：本次恢复完成后，调用者针对新 session 要执行的临时动作。
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
			// 可选：目标项目需要确认信任时，创建相应的确认上下文。
			projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
		},
	): Promise<{ cancelled: boolean }> { // 返回本次恢复是否被扩展取消。
		// 恢复旧 session 前，先允许当前 session 的扩展取消本次切换；取消时保持当前 session 不变。
		const beforeResult = await this.emitBeforeSwitch("resume", sessionPath);

		// 扩展取消时立刻结束整个恢复流程；后面不会关闭当前 session，也不会打开目标旧 session。
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		// 记住当前 session 文件，后面创建恢复后的 session 时会记录本次从哪里切换而来。
		const previousSessionFile = this.session.sessionFile;
		// 打开目标旧 session 的管理对象；此时还未关闭当前 session，也未把目标 session 装入 runtime。
		const sessionManager = SessionManager.open(sessionPath, undefined, options?.cwdOverride);
		// 先确认目标旧 session 记录的项目目录仍存在；不满足时抛出错误，当前 session 保持不变。
		assertSessionCwdExists(sessionManager, this.cwd);

		// 目标旧 session 已确认可用；现在收尾并关闭当前 session。
		await this.teardownCurrent("resume", sessionManager.getSessionFile());
		// 使用目标旧 session 自己的项目目录与 sessionManager，重新创建它的一整套运行结果；apply(...) 随后替换当前 runtime 内容。
		this.apply(
			await this.createRuntime({
				// 目标旧 session 所属项目；若目标来自另一个项目，这里会随之改变。
				cwd: sessionManager.getCwd(),
				// Pi 全局目录，不随项目切换而改变。
				agentDir: this.services.agentDir,
				// 刚打开的目标旧 session 管理对象。
				sessionManager,
				// 记录新 session 是因恢复旧 session 启动，并保留切换前 session 文件的信息。
				sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
				// 目标项目需要确认信任时，按目标 cwd 创建对应的确认上下文。
				projectTrustContext: options?.projectTrustContextFactory?.(sessionManager.getCwd()),
			}),
		);
		// 新 session 已成为当前 session；执行界面重新绑定和本次恢复专属的后续动作。
		await this.finishSessionReplacement(options?.withSession);
		// 整个恢复流程完成，返回 false 表示没有被扩展取消。
		return { cancelled: false };
	}

	// 新开一段 session 并替换 runtime 当前 session；它不是恢复旧 session，也不是复制历史分叉。
	// options 是可选的“额外资料盒子”；函数完成后返回本次新建是否被取消。
	async newSession(options?: {
		// 可选：记录与哪个旧 session 有关系。
		parentSession?: string;
		// 可选：新 session 创建后的额外准备动作。
		setup?: (sessionManager: SessionManager) => Promise<void>;
		// 可选：本次切换完成后的额外动作。
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }> {
		// 第一步：因为新建也会切换当前 session，先询问扩展是否同意本次切换，并取得回答。
		const beforeResult = await this.emitBeforeSwitch("new");
		// 扩展取消时立刻结束；当前 session 保持不变。
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		// 记住当前 session 文件，后面创建新 session 时会记录本次从哪里切换而来。
		const previousSessionFile = this.session.sessionFile;
		// 当前 session 文件所在目录；仅当前 session 已保存到文件时会用于新建文件。
		const sessionDir = this.session.sessionManager.getSessionDir();
		// 新 session 跟随当前 session 的保存方式：当前有文件则在 sessionDir 创建新文件；当前仅在内存则继续只在内存创建。
		const sessionManager = this.session.sessionManager.isPersisted()
			// 当前 session 已保存：创建带新 session 文件的管理对象。
			? SessionManager.create(this.cwd, sessionDir)
			// 当前 session 未保存：创建只存在内存中的管理对象。
			: SessionManager.inMemory(this.cwd);

		// 若调用者指定父 session，只记录两者关系；不会复制聊天历史或执行 fork。
		if (options?.parentSession) {
			sessionManager.newSession({ parentSession: options.parentSession });
		}

		// 新 session 的管理对象已准备好；以“新建”为原因收尾并关闭当前 session。
		await this.teardownCurrent("new", sessionManager.getSessionFile());
		// 新建 session 仍属于当前项目 cwd；按新 sessionManager 创建新结果包，再由 apply(...) 替换 runtime 当前内容。
		this.apply(
			await this.createRuntime({
				// 新建不会切到其他项目，继续使用当前项目目录。
				cwd: this.cwd,
				// Pi 全局目录，不随本次新建而改变。
				agentDir: this.services.agentDir,
				// 上面刚创建的新 session 管理对象。
				sessionManager,
				// 记录本次启动新 session 的原因，以及切换前 session 文件。
				sessionStartEvent: { type: "session_start", reason: "new", previousSessionFile },
			}),
		);
		// 若调用者要求额外准备新 session，先执行准备动作，再刷新新 session 的上下文。
		if (options?.setup) {
			await options.setup(this.session.sessionManager);
			this.session.refreshContext();
		}
		// 新 session 已准备好；执行界面重新绑定和本次新建专属的后续动作。
		await this.finishSessionReplacement(options?.withSession);
		// 整个新建流程完成，返回 false 表示没有被扩展取消。
		return { cancelled: false };
	}

	// 从当前 session 历史的指定位置创建新分支，并让 runtime 切换到该分支；不是恢复旧文件，也不是空白新建。
	async fork(
		// 当前 session 历史中作为分叉点的记录 ID。
		entryId: string,
		options?: {
			// 可选：before 表示在该记录前分叉；at 表示分支包含该记录。未传时默认 before。
			position?: "before" | "at";
			// 可选：本次分叉完成后，调用者针对新分支 session 要执行的临时动作。
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
		},
	): Promise<{ cancelled: boolean; selectedText?: string }> { // 返回本次分叉是否被取消，必要时附带分叉点的用户文字。
		// 未指定分叉位置时，默认在目标记录前分叉。
		const position = options?.position ?? "before";
		// 分叉前先允许当前 session 的扩展取消本次操作。
		const beforeResult = await this.emitBeforeFork(entryId, { position });
		// 扩展取消时立刻结束；当前 session 保持不变。
		if (beforeResult.cancelled) {
			return { cancelled: true };
		}

		// 后面确定新分支要保留到哪条历史记录时，存放那条记录的 ID。
		let targetLeafId: string | null;
		// 必要时保存分叉点用户消息的文字，供后续调用者使用。
		let selectedText: string | undefined;

		// 按 entryId 从当前 session 历史中找到要作为分叉点的记录。
		const selectedEntry = this.session.sessionManager.getEntry(entryId);
		// 分叉点不存在就无法继续；此时当前 session 不变，也不会创建新分支。
		if (!selectedEntry) {
			throw new Error("Invalid entry ID for forking");
		}

		if (position === "at") {
			// 新分支包含选中的记录，因此保留到该记录为止。
			targetLeafId = selectedEntry.id;
		} else {
			// before 分叉只允许选中用户消息；Agent 回复、工具结果等记录不能作为“排除它本身”的分叉点。
			if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
				throw new Error("Invalid entry ID for forking");
			}
			// 新分支不包含选中的用户消息，因此保留到它的前一条记录（parentId）为止。
			targetLeafId = selectedEntry.parentId;
			// 同时取出被排除的用户消息文字，供本次 fork 的后续调用者使用。
			selectedText = extractUserMessageText(selectedEntry.message.content);
		}

		// 记住当前 session 文件，后面创建新分支时会记录本次从哪里切换而来。
		const previousSessionFile = this.session.sessionFile;
		// 当前历史有保存文件时，复制文件历史创建独立的新分支文件。
		if (this.session.sessionManager.isPersisted()) {
			// 当前既然已保存，必须拿到它的实际文件路径；后面分叉会从该文件复制历史。
			const currentSessionFile = this.session.sessionFile;
			// 保存状态与文件路径不一致时无法安全分叉，直接停止。
			if (!currentSessionFile) {
				throw new Error("Persisted session is missing a session file");
			}
			// 新分支文件会创建在当前 session 所在的 session 文件夹。
			const sessionDir = this.session.sessionManager.getSessionDir();

			// 分叉点前没有任何旧历史可保留时，不能复制历史；改为创建空的新分支。
			if (!targetLeafId) {
				// 在当前 session 文件夹中创建空的新 session 文件。
				const sessionManager = SessionManager.create(this.cwd, sessionDir);
				// 初始化空分支，并在它的元数据中记录父 session 文件路径；不复制任何聊天消息。
				sessionManager.newSession({ parentSession: currentSessionFile });
				// 以下复用统一替换流程：收尾当前 session，创建空分支结果，装入 runtime，再重新绑定外部。
				await this.teardownCurrent("fork", sessionManager.getSessionFile());
				this.apply(
					await this.createRuntime({
						cwd: this.cwd,
						agentDir: this.services.agentDir,
						sessionManager,
						sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
					}),
				);
				await this.finishSessionReplacement(options?.withSession);
				return { cancelled: false, selectedText };
			}

			// 路径字符串存在不代表文件仍在磁盘上；原 session 文件已删除时无法复制历史。
			if (!existsSync(currentSessionFile)) {
				throw new Error("This session has not been saved yet. Send a message before cloning or forking it.");
			}
			// 打开原 session 文件，准备从中读取并复制分叉点之前的历史。
			const sessionManager = SessionManager.open(currentSessionFile, sessionDir);
			// 将从历史开头到 targetLeafId 的记录写成新的分支 session 文件；随后 sessionManager 改为管理该新分支。
			const forkedSessionPath = sessionManager.createBranchedSession(targetLeafId);
			// 新分支文件创建失败时，不能继续关闭当前 session 或替换 runtime。
			if (!forkedSessionPath) {
				throw new Error("Failed to create forked session");
			}

			// 新分支文件已创建；以“分叉”为原因收尾并关闭当前原 session。
			await this.teardownCurrent("fork", sessionManager.getSessionFile());
			// 使用新分支自己的 cwd 和 sessionManager 创建运行结果，再由 apply(...) 替换 runtime 当前内容。
			this.apply(
				await this.createRuntime({
					// 从新分支 B 自己的 sessionManager 读取项目目录；fork 后通常与原 session 相同。
					cwd: sessionManager.getCwd(),
					// Pi 全局目录，不随 session 分叉改变。
					agentDir: this.services.agentDir,
					// 当前已改为管理新分支文件的 sessionManager。
					sessionManager,
					// 记录该 session 因 fork 启动，并保留切换前原 session 文件。
					sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
				}),
			);
			// 新分支已成为当前 session；执行界面重新绑定和本次分叉专属的后续动作。
			await this.finishSessionReplacement(options?.withSession);
			// fork 完成；false 表示没有被扩展取消，selectedText 可能携带 before 分叉时排除的用户消息文字。
			return { cancelled: false, selectedText };
		}

		// 当前历史只在内存中时，没有文件可复制；直接用内存中的管理对象创建分支。
		// 当前 session 没有文件可复制，直接取得当前内存中的管理对象来生成分支。
		const sessionManager = this.session.sessionManager;
		// 先关闭当前 AgentSession；sessionManager 已保存到局部变量，后面仍可用于创建新分支。
		await this.teardownCurrent("fork", sessionManager.getSessionFile());
		// 没有旧历史可复制时，初始化空分支，只记录父 session 关系。
		if (!targetLeafId) {
			sessionManager.newSession({ parentSession: previousSessionFile });
		} else {
			// 有旧历史可复制时，从开头到 targetLeafId 创建内存中的历史分支。
			sessionManager.createBranchedSession(targetLeafId);
		}
		this.apply(
			await this.createRuntime({
				cwd: this.cwd,
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
			}),
		);
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false, selectedText };
	}

	/**
	 * 导入外部 session JSONL 文件，再让 runtime 切换到导入后的 session。
	 * 扩展取消时返回 cancelled: true；源文件不存在或导入 session 的 cwd 无法使用时会报错。
	 */
	async importFromJsonl(
		// 用户指定的外部 JSONL session 文件路径。
		inputPath: string,
		// 可选：导入文件原本记录的项目目录不可用时，指定这次应使用的项目目录。
		cwdOverride?: string,
	): Promise<{ cancelled: boolean }> {
		// 将用户输入的路径整理成实际读取的最终路径。
		const resolvedPath = resolvePath(inputPath);
		// 外部源文件不存在时无法导入；当前 session 保持不变。
		if (!existsSync(resolvedPath)) {
			throw new SessionImportFileNotFoundError(resolvedPath);
		}

		// 导入后的 JSONL 最终存放到 Pi 当前使用的 session 文件夹。
		const sessionDir = this.session.sessionManager.getSessionDir();
		// 文件夹不存在时先创建；recursive: true 表示缺失的上级文件夹也一起创建。
		if (!existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}

		// 先以“Pi 的 session 文件夹 + 源文件名”作为导入后的目标路径。
		// 例如 Downloads/chat.jsonl 的默认目标是 ~/.pi/sessions/chat.jsonl。
		let destinationPath = join(sessionDir, basename(resolvedPath));
		// 判断源文件是否本来就位于这个目标位置：
		// 是 → 已由 Pi 保存，不必再复制；否 → 是外部文件，后面会复制进 sessionDir。
		const sourceAlreadyStored = resolve(destinationPath) === resolvedPath;
		if (!sourceAlreadyStored) {
			// 外部文件导入时，若目标同名文件已存在，保留原文件并改用 chat-1.jsonl、chat-2.jsonl 等名称。
			const { name, ext } = parse(destinationPath);
			let suffix = 1;
			while (existsSync(destinationPath)) {
				destinationPath = join(sessionDir, `${name}-${suffix++}${ext}`);
			}
		}

		// 导入完成后会切换到该 session；先让当前 session 的扩展决定是否取消这次切换。
		// "resume" 表示本次会像恢复旧 session 一样，使用 destinationPath 对应的 session 文件。
		const beforeResult = await this.emitBeforeSwitch("resume", destinationPath);
		if (beforeResult.cancelled) {
			// 扩展取消时立即结束：不复制外部文件，也不关闭或替换当前 session。
			return beforeResult;
		}

		// 记住切换前正在使用的 session 文件，后面创建新 runtime 时记录本次从哪里切换而来。
		const previousSessionFile = this.session.sessionFile;
		// 与前一个同条件的 if 不同：前一个 if 只负责给外部文件确定不重名的目标名称；
		// 这里才真正将外部 JSONL 从 resolvedPath 复制到 destinationPath。
		// 文件本来就在 Pi 的 session 文件夹时，跳过复制，直接使用该文件。
		if (!sourceAlreadyStored) {
			copyFileSync(resolvedPath, destinationPath, constants.COPYFILE_EXCL);
		}

		// 不创建新的 session 或 JSONL 文件；打开已有的 destinationPath，得到负责管理该文件的 sessionManager。
		// 后续可通过 sessionManager 取得此文件、它所属的项目目录等信息。
		const sessionManager = SessionManager.open(destinationPath, sessionDir, cwdOverride);
		// 导入文件记录的项目目录必须仍可使用，否则不关闭当前 session，直接报错。
		assertSessionCwdExists(sessionManager, this.cwd);
		// 以下是导入成功后的统一切换流程：收尾当前 session，再换成导入文件对应的新运行内容。
		// "resume" 表示本次是切换到已有 session；目标文件由刚打开的 sessionManager 给出。
		await this.teardownCurrent("resume", sessionManager.getSessionFile());
		// runtime 已经存在：this.createRuntime(...) 只创建新 session、services 等替换内容，
		// 不创建新的 AgentSessionRuntime；再由 apply(...) 替换当前 runtime 保存的旧内容。
		this.apply(
			await this.createRuntime({
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				// 记录这次是从导入前的旧 session 切换而来。
				sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
			}),
		);
		// 新 session 已装入 runtime；执行界面重新绑定等切换后的动作。
		await this.finishSessionReplacement();
		// 没有被扩展取消，导入并切换成功。
		return { cancelled: false };
	}

	// Pi 准备退出时调用：通知扩展、执行外部清理，再关闭当前 AgentSession。
	async dispose(): Promise<void> {
		// 通知当前 session 的扩展 Pi 将因 quit 退出；这是通知，扩展不能取消退出。
		await emitSessionShutdownEvent(this.session.extensionRunner, {
			type: "session_shutdown",
			reason: "quit",
		});
		// 若外部此前登记过清理动作（例如解除 UI 与 session 的绑定），则执行它。
		this.beforeSessionInvalidate?.();
		// 真正关闭当前 AgentSession，结束其运行。
		this.session.dispose();
	}
}

// Pi 第一次启动时，用“创建配方”与本次初始 session 目标创建第一个 runtime。
// 它不同于上面的 this.createRuntime(...)：后者用于已有 runtime 切换 session 时准备替换内容。
// 同一份 createRuntime 会保存进返回的 AgentSessionRuntime，供后续 /new、/resume、/fork、/import 复用。
export async function createAgentSessionRuntime(
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: {
		cwd: string;
		agentDir: string;
		sessionManager: SessionManager;
		sessionStartEvent?: SessionStartEvent;
	},
): Promise<AgentSessionRuntime> {
	// 先确认选中的 sessionManager 有可用的项目 cwd。
	assertSessionCwdExists(options.sessionManager, options.cwd);
	// 执行从 main.ts 传进来的 createRuntime 配方，真正创建 session、services、diagnostics 等内容。
	const result = await createRuntime(options);
	// 再用 new 创建外层 AgentSessionRuntime；new 会自动调用上面的 constructor，
	// 将 result 的内容保存进 runtime 容器，而不是再次创建 AgentSession。
	return new AgentSessionRuntime(
		result.session,
		result.services,
		createRuntime,
		result.diagnostics,
		result.modelFallbackMessage,
	);
}

export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
