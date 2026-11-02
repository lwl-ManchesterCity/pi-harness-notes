/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */

import { createInterface } from "node:readline";
import { type ImageContent, modelsAreEqual } from "@earendil-works/pi-ai";
import { setCapabilityOverrides } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { type Args, type Mode, normalizeSessionName, parseArgs, printHelp } from "./cli/args.ts";
import {
	type AuthCheckResult,
	checkProviderAuth,
	createAuthCheckModelRuntime,
	getProviderCredential,
} from "./cli/auth-check.ts";
import {
	type AuthCommand,
	AuthCommandError,
	getAuthCommandName,
	getAuthCommandUsage,
	isAuthCommandHelp,
	parseAuthCommand,
	printAuthCommandHelp,
	validateAuthCommandArgs,
} from "./cli/auth-command.ts";
import { resolveCredentialForPrint } from "./cli/credential-print.ts";
import { processFileArguments } from "./cli/file-processor.ts";
import { buildInitialMessage } from "./cli/initial-message.ts";
import { listModels } from "./cli/list-models.ts";
import { createProjectTrustContext } from "./cli/project-trust.ts";
import { selectSession } from "./cli/session-picker.ts";
import { shouldRunFirstTimeSetup, showFirstTimeSetup, showStartupSelector } from "./cli/startup-ui.ts";
import { APP_NAME, ENV_SESSION_DIR, expandTildePath, getAgentDir, getPackageDir, VERSION } from "./config.ts";
import { type CreateAgentSessionRuntimeFactory, createAgentSessionRuntime } from "./core/agent-session-runtime.ts";
import {
	type AgentSessionRuntimeDiagnostic,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./core/agent-session-services.ts";
import { formatNoModelsAvailableMessage } from "./core/auth-guidance.ts";
import { AuthStorage, ReadOnlyAuthStorage } from "./core/auth-storage.ts";
import { exportFromFile } from "./core/export-html/index.ts";
import type { InlineExtension } from "./core/extensions/types.ts";
import { applyHttpProxySettings, configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { resolveCliModel, resolveModelScope, type ScopedModel } from "./core/model-resolver.ts";
import { ModelRuntime } from "./core/model-runtime.ts";
import { restoreStdout, takeOverStdout } from "./core/output-guard.ts";
import { type AppMode, resolveProjectTrusted } from "./core/project-trust.ts";
import type { CreateAgentSessionOptions } from "./core/sdk.ts";
import {
	formatMissingSessionCwdPrompt,
	getMissingSessionCwdIssue,
	MissingSessionCwdError,
	type SessionCwdIssue,
} from "./core/session-cwd.ts";
import { assertValidSessionId, SessionManager } from "./core/session-manager.ts";
import { collectSettingsDiagnostics, deduplicateDiagnostics } from "./core/settings-diagnostics.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { printTimings, resetTimings, time } from "./core/timings.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "./core/trust-manager.ts";
import { builtInExtensions } from "./extensions/index.ts";
import { loadMcpCommand } from "./extensions/mcp/cli.lazy.ts";
import { runMigrations, showDeprecationWarnings } from "./migrations.ts";
// 文件加载时，main.ts 统一从 modes/index.ts 取得三个模式入口；这不是 main() 运行后才发生的函数调用。
// 真正执行哪个入口，要到 main() 末尾按 appMode 再决定。
import { InteractiveMode, runPrintMode, runRpcMode } from "./modes/index.ts";
import { initTheme, setThemeJsonValidator, stopThemeWatcher } from "./modes/interactive/theme/theme.ts";
import { validateThemeJson } from "./modes/interactive/theme/theme-schema.ts";
import { cleanupManagedInstall, handleConfigCommand, handlePackageCommand } from "./package-manager-cli.ts";
import { isLocalPath, normalizePath, resolvePath } from "./utils/paths.ts";
import { cleanupWindowsSelfUpdateQuarantine } from "./utils/windows-self-update.ts";

const EXTENSION_LOAD_FAILURE_HINT = `Hint: Start without extensions using "${APP_NAME} -ne".`;

/**
 * Read all content from piped stdin.
 * Returns undefined if stdin is a TTY (interactive terminal).
 */
async function readPipedStdin(): Promise<string | undefined> {
	// If stdin is a TTY, we're running interactively - don't read stdin
	if (process.stdin.isTTY) {
		return undefined;
	}

	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => {
			resolve(data.trim() || undefined);
		});
		process.stdin.resume();
	});
}

function reportDiagnostics(diagnostics: readonly AgentSessionRuntimeDiagnostic[]): void {
	for (const diagnostic of diagnostics) {
		const color = diagnostic.type === "error" ? chalk.red : diagnostic.type === "warning" ? chalk.yellow : chalk.dim;
		const prefix = diagnostic.type === "error" ? "Error: " : diagnostic.type === "warning" ? "Warning: " : "";
		console.error(color(`${prefix}${diagnostic.message}`));
	}
}

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function resolveAppMode(parsed: Args, stdinIsTTY: boolean, stdoutIsTTY: boolean): AppMode {
	if (parsed.mode === "rpc") {
		return "rpc";
	}
	if (parsed.mode === "json") {
		return "json";
	}
	if (parsed.print || !stdinIsTTY || !stdoutIsTTY) {
		return "print";
	}
	return "interactive";
}

function toPrintOutputMode(appMode: AppMode): Exclude<Mode, "rpc"> {
	return appMode === "json" ? "json" : "text";
}

function isPlainRuntimeMetadataCommand(parsed: Args): boolean {
	return !parsed.print && parsed.mode === undefined && (parsed.help === true || parsed.listModels !== undefined);
}

async function runAuthCommand(args: string[]): Promise<boolean> {
	if (isAuthCommandHelp(args)) {
		printAuthCommandHelp();
		return true;
	}

	let command: AuthCommand | undefined;
	try {
		command = parseAuthCommand(args);
	} catch (error) {
		const message = error instanceof AuthCommandError ? error.message : "Failed to parse auth command";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
	if (!command) return false;

	const parsed = parseArgs(command.args);
	if (parsed.unknownFlags.size > 0) {
		const option = parsed.unknownFlags.keys().next().value;
		console.error(chalk.red(`Unknown option --${option} for "${getAuthCommandName(command.kind)}".`));
		console.error(chalk.dim(`Use "${APP_NAME} --help" or "${getAuthCommandUsage(command.kind)}".`));
		process.exitCode = 1;
		return true;
	}
	try {
		if (parsed.diagnostics.length > 0) {
			throw new AuthCommandError(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
		}
		if (command.kind !== "check") {
			const signal = AbortSignal.timeout(15_000);
			const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, signal });
			const credential = await resolveCredentialForPrint(
				parsed,
				modelRuntime,
				command.kind,
				command.minExpiryMs,
				signal,
			);
			process.stdout.write(`${credential}\n`);
			return true;
		}

		const requestedAuth = validateAuthCommandArgs(parsed, command.kind);
		let result: AuthCheckResult;
		let credential: string | undefined;
		try {
			const credentials = command.noRefresh ? new ReadOnlyAuthStorage() : AuthStorage.create();
			const modelRuntime = await createAuthCheckModelRuntime(credentials);
			result = await checkProviderAuth(parsed, modelRuntime, { refresh: !command.noRefresh });
			if (command.credentials && result.status === "ready") {
				credential = await getProviderCredential(result.provider, modelRuntime, credentials, {
					refresh: !command.noRefresh,
				});
				if (!credential) {
					result = { status: "not_ready", provider: result.provider, reason: "credential_not_available" };
				}
			}
		} catch {
			result = {
				status: "invalid",
				provider: requestedAuth.provider ?? requestedAuth.model!,
				reason: "invalid_state",
			};
		}
		const output = command.json
			? JSON.stringify({ ...result, ...(credential ? { credentials: credential } : {}) })
			: (credential ?? result.status);
		process.stdout.write(`${output}\n`);
		process.exitCode = result.status === "ready" ? 0 : result.status === "not_ready" ? 1 : 2;
	} catch (error) {
		const message = error instanceof AuthCommandError ? error.message : "Failed to resolve credential";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = command.kind === "check" ? 2 : 1;
	}
	return true;
}

async function prepareInitialMessage(
	parsed: Args,
	stdinContent?: string,
): Promise<{
	initialMessage?: string;
	initialImages?: ImageContent[];
}> {
	if (parsed.fileArgs.length === 0) {
		return buildInitialMessage({ parsed, stdinContent });
	}

	// AgentSession resizes these after extension hooks select the request model.
	const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages: false });
	return buildInitialMessage({
		parsed,
		fileText: text,
		fileImages: images,
		stdinContent,
	});
}

/** Result from resolving a session argument */
type ResolvedSession =
	| { type: "path"; path: string } // Direct file path
	| { type: "local"; path: string } // Found in current project
	| { type: "global"; path: string; cwd: string } // Found in different project
	| { type: "not_found"; arg: string }; // Not found anywhere

/**
 * Resolve a session argument to a file path.
 * If it looks like a path, use as-is. Otherwise try to match as session ID prefix.
 */
function findLocalSessionByExactId(
	sessionId: string,
	cwd: string,
	sessionDir?: string,
): { type: "local"; path: string } | undefined {
	const path = SessionManager.findById(cwd, sessionId, sessionDir);
	return path ? { type: "local", path } : undefined;
}

async function resolveSessionPath(sessionArg: string, cwd: string, sessionDir?: string): Promise<ResolvedSession> {
	// If it looks like a file path, resolve it before handing it to the session manager.
	if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
		return { type: "path", path: resolvePath(sessionArg, cwd) };
	}

	// Exact IDs only require reading session headers. Fall back to the full
	// metadata listing for prefix matches.
	const exactLocalMatch = findLocalSessionByExactId(sessionArg, cwd, sessionDir);
	if (exactLocalMatch) {
		return exactLocalMatch;
	}

	const localSessions = await SessionManager.list(cwd, sessionDir);
	const localMatch = localSessions.find((s) => s.id.startsWith(sessionArg));

	if (localMatch) {
		return { type: "local", path: localMatch.path };
	}

	// Try global search across all projects
	const allSessions = await SessionManager.listAll(sessionDir);
	const globalMatch =
		allSessions.find((s) => s.id === sessionArg) ?? allSessions.find((s) => s.id.startsWith(sessionArg));

	if (globalMatch) {
		return { type: "global", path: globalMatch.path, cwd: globalMatch.cwd };
	}

	// Not found anywhere
	return { type: "not_found", arg: sessionArg };
}

/** Prompt user for yes/no confirmation */
async function promptConfirm(message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
		});
	});
}

function validateForkFlags(parsed: Args): void {
	if (!parsed.fork) return;

	const conflictingFlags = [
		parsed.session ? "--session" : undefined,
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
		parsed.noSession ? "--no-session" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) {
		console.error(chalk.red(`Error: --fork cannot be combined with ${conflictingFlags.join(", ")}`));
		process.exit(1);
	}
}

function validateSessionIdFlags(parsed: Args): void {
	if (parsed.sessionId === undefined) return;

	const conflictingFlags = [
		parsed.session ? "--session" : undefined,
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) {
		console.error(chalk.red(`Error: --session-id cannot be combined with ${conflictingFlags.join(", ")}`));
		process.exit(1);
	}

	try {
		assertValidSessionId(parsed.sessionId);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

function openSessionOrExit(path: string, sessionDir?: string): SessionManager {
	try {
		return SessionManager.open(path, sessionDir);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

function forkSessionOrExit(sourcePath: string, cwd: string, sessionDir?: string, sessionId?: string): SessionManager {
	try {
		return SessionManager.forkFrom(sourcePath, cwd, sessionDir, { id: sessionId });
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

export async function createSessionManager(
	parsed: Args,
	cwd: string,
	sessionDir: string | undefined,
	settingsManager: SettingsManager,
): Promise<SessionManager> {
	if (parsed.noSession || parsed.help || parsed.listModels !== undefined) {
		return SessionManager.inMemory(cwd, parsed.sessionId !== undefined ? { id: parsed.sessionId } : undefined);
	}

	if (parsed.fork) {
		if (parsed.sessionId) {
			const existingTarget = findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir);
			if (existingTarget) {
				console.error(chalk.red(`Session already exists with id '${parsed.sessionId}'`));
				process.exit(1);
			}
		}

		const resolved = await resolveSessionPath(parsed.fork, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
			case "global":
				return forkSessionOrExit(resolved.path, cwd, sessionDir, parsed.sessionId);

			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	if (parsed.session) {
		const resolved = await resolveSessionPath(parsed.session, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
				return openSessionOrExit(resolved.path, sessionDir);

			case "global": {
				console.log(chalk.yellow(`Session found in different project: ${resolved.cwd}`));
				const shouldFork = await promptConfirm("Fork this session into current directory?");
				if (!shouldFork) {
					console.log(chalk.dim("Aborted."));
					process.exit(0);
				}
				return forkSessionOrExit(resolved.path, cwd, sessionDir);
			}

			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	if (parsed.resume) {
		try {
			const selectedPath = await selectSession(
				(onProgress, signal) => SessionManager.list(cwd, sessionDir, onProgress, signal),
				(onProgress, signal) => SessionManager.listAll(sessionDir, onProgress, signal),
				settingsManager,
			);
			if (!selectedPath) {
				console.log(chalk.dim("No session selected"));
				process.exit(0);
			}
			return SessionManager.open(selectedPath, sessionDir);
		} finally {
			stopThemeWatcher();
		}
	}

	if (parsed.continue) {
		return SessionManager.continueRecent(cwd, sessionDir);
	}

	if (parsed.sessionId) {
		const existingSession = findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir);
		if (existingSession) {
			return SessionManager.open(existingSession.path, sessionDir);
		}
		console.error(
			chalk.yellow(
				`Warning: No project session found with id '${parsed.sessionId}'; creating a new session with that id.`,
			),
		);
	}

	return SessionManager.create(cwd, sessionDir, { id: parsed.sessionId });
}

function buildSessionOptions(
	parsed: Args,
	scopedModels: ScopedModel[],
	hasExistingSession: boolean,
	modelRuntime: ModelRuntime,
	settingsManager: SettingsManager,
): {
	options: CreateAgentSessionOptions;
	cliThinkingFromModel: boolean;
	diagnostics: AgentSessionRuntimeDiagnostic[];
} {
	const options: CreateAgentSessionOptions = {};
	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	let cliThinkingFromModel = false;

	// Model from CLI
	// - supports --provider <name> --model <pattern>
	// - supports --model <provider>/<pattern>
	if (parsed.provider && !parsed.model) {
		diagnostics.push({
			type: "error",
			message: `--provider requires --model (for example: --provider ${parsed.provider} --model <pattern>)`,
		});
	}
	if (parsed.model) {
		const resolved = resolveCliModel({
			cliProvider: parsed.provider,
			cliModel: parsed.model,
			cliThinking: parsed.thinking,
			inlineApiKey: Boolean(parsed.apiKey),
			modelRuntime,
		});
		if (resolved.warning) {
			diagnostics.push({ type: "warning", message: resolved.warning });
		}
		if (resolved.error) {
			diagnostics.push({ type: "error", message: resolved.error });
		}
		if (resolved.model) {
			options.model = resolved.model;
			// Allow "--model <pattern>:<thinking>" as a shorthand.
			// Explicit --thinking still takes precedence (applied later).
			if (!parsed.thinking && resolved.thinkingLevel) {
				options.thinkingLevel = resolved.thinkingLevel;
				cliThinkingFromModel = true;
			}
		}
	}

	if (!options.model && scopedModels.length > 0 && !hasExistingSession) {
		// Check if saved default is in scoped models - use it if so, otherwise first scoped model
		const savedProvider = settingsManager.getDefaultProvider();
		const savedModelId = settingsManager.getDefaultModel();
		const savedModel = savedProvider && savedModelId ? modelRuntime.getModel(savedProvider, savedModelId) : undefined;
		const savedInScope = savedModel ? scopedModels.find((sm) => modelsAreEqual(sm.model, savedModel)) : undefined;

		if (savedInScope) {
			options.model = savedInScope.model;
			// Use thinking level from scoped model config if explicitly set
			if (!parsed.thinking && savedInScope.thinkingLevel) {
				options.thinkingLevel = savedInScope.thinkingLevel;
			}
		} else {
			options.model = scopedModels[0].model;
			// Use thinking level from first scoped model if explicitly set
			if (!parsed.thinking && scopedModels[0].thinkingLevel) {
				options.thinkingLevel = scopedModels[0].thinkingLevel;
			}
		}
	}

	// Thinking level from CLI (takes precedence over scoped model thinking levels set above)
	if (parsed.thinking) {
		options.thinkingLevel = parsed.thinking;
	}

	// Scoped models for Ctrl+P cycling
	// Keep thinking level undefined when not explicitly set in the model pattern.
	// Undefined means "inherit current session thinking level" during cycling.
	if (scopedModels.length > 0) {
		options.scopedModels = scopedModels.map((sm) => ({
			model: sm.model,
			thinkingLevel: sm.thinkingLevel,
		}));
	}

	// API key from CLI - set as a non-persistent runtime override
	// (handled by caller before createAgentSession)

	// Tools
	if (parsed.noTools) {
		options.noTools = "all";
	} else if (parsed.noBuiltinTools) {
		options.noTools = "builtin";
	}
	if (parsed.tools) {
		options.tools = [...parsed.tools];
	}
	if (parsed.excludeTools) {
		options.excludeTools = [...parsed.excludeTools];
	}

	return { options, cliThinkingFromModel, diagnostics };
}

function resolveCliPaths(cwd: string, paths: string[] | undefined): string[] | undefined {
	return paths?.map((value) => (isLocalPath(value) ? resolvePath(value, cwd) : value));
}

async function promptForMissingSessionCwd(
	issue: SessionCwdIssue,
	settingsManager: SettingsManager,
): Promise<string | undefined> {
	return showStartupSelector(settingsManager, formatMissingSessionCwdPrompt(issue), [
		{ label: "Continue", value: issue.fallbackCwd },
		{ label: "Cancel", value: undefined },
	]);
}

export interface MainOptions {
	extensionFactories?: InlineExtension[];
}

export async function main(args: string[], options?: MainOptions) {
	// 每次启动都从空的耗时记录开始，便于后续输出各启动阶段耗时。
	resetTimings();
	// 命令和启动选择器可能在创建运行时之前加载用户主题，因此先注册主题 JSON 校验器。
	setThemeJsonValidator(validateThemeJson);
	// 内置扩展始终存在；测试或嵌入调用方可额外提供扩展工厂。
	const extensionFactories = [...builtInExtensions, ...(options?.extensionFactories ?? [])];
	// --offline 或环境变量会禁止网络相关启动行为。
	const offlineMode = args.includes("--offline") || isTruthyEnvFlag(process.env.PI_OFFLINE);
	if (offlineMode) {
		process.env.PI_OFFLINE = "1";
		process.env.PI_SKIP_VERSION_CHECK = "1";
	}

	// 先处理不需要启动 Agent 的管理命令。
	// 命中任意一个命令后都会直接结束；只有普通任务才会继续创建 AgentSession。
	// 例如：pi 帮我修复 bug 不会命中下面四个判断。
	// 例如：pi auth check --provider openai 只检查凭证，不创建 Agent。
	if (await runAuthCommand(args)) {
		return;
	}

	if (process.platform === "win32") {
		cleanupWindowsSelfUpdateQuarantine(getPackageDir());
	}
	cleanupManagedInstall();

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	// 此阶段尚未确认项目是否可信，只读取启动所需的全局设置。
	const bootstrapSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	applyHttpProxySettings(bootstrapSettingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher();

	// 例如：pi update 用于更新 Pi 本身，更新完成后直接退出，不创建 Agent。
	if (await handlePackageCommand(args, { extensionFactories })) {
		const exitCode = process.exitCode ?? 0;
		if (process.platform === "win32" && exitCode === 0 && args[0] === "update") {
			// 包管理命令通常使用 process.exit(0)，避免异常扩展让一次性命令无法退出。
			// 但 Windows 上，fetch() 清理期间调用 process.exit(0) 可能触发 Node 断言；
			// 因此成功的 pi update 改为让进程自然结束。
			// https://github.com/nodejs/node/issues/56645
			return;
		}
		process.exit(exitCode);
		return;
	}

	// 例如：pi config ... 用于读取或修改配置，完成后直接退出，不创建 Agent。
	if (await handleConfigCommand(args, { extensionFactories })) {
		return;
	}

	// 例如：pi mcp list 只管理 MCP 服务；第一个参数是 mcp 时才加载对应实现。
	if (args[0] === "mcp") {
		const { runMcpCommand } = await loadMcpCommand();
		process.exitCode = await runMcpCommand(args.slice(1), { cwd, agentDir });
		return;
	}
    // 进入到普通任务
	// 把用户输入的字符串数组拆成结构化的选项、消息和诊断信息。
	const parsed = parseArgs(args);
	// diagnostics 不为空表示参数中有错误或警告，例如未知选项 --modle。
	if (parsed.diagnostics.length > 0) {
		// 逐条输出诊断：错误显示为红色，警告显示为黄色。
		for (const d of parsed.diagnostics) {
			const color = d.type === "error" ? chalk.red : chalk.yellow;
			console.error(color(`${d.type === "error" ? "Error" : "Warning"}: ${d.message}`));
		}
		// 只要存在一条错误，就停止启动；只有警告时仍可继续。
		if (parsed.diagnostics.some((d) => d.type === "error")) {
			process.exit(1);
		}
	}
	// 记录“解析参数”这一步花了多少时间，用于启动耗时分析。
	time("parseArgs");

	// 用户输入 pi --version 时，只输出版本号并正常退出；普通任务会跳过这里继续向下执行。
	if (parsed.version) {
		console.log(VERSION);
		process.exit(0);
	}

	// 用户输入 pi --export session.jsonl output.html 时，
	// 将已保存的会话文件转换为浏览器可打开的 HTML；不启动 Agent。
	if (parsed.export) {
		let result: string;
		try {
			const outputPath = parsed.messages.length > 0 ? parsed.messages[0] : undefined;
			result = await exportFromFile(parsed.export, outputPath);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Failed to export session";
			console.error(chalk.red(`Error: ${message}`));
			process.exit(1);
		}
		console.log(`Exported to: ${result}`);
		process.exit(0);
	}

	// 决定这次如何与 Agent 交互，而不是决定创建哪一种 Agent：
	// 人在终端持续聊天用 interactive；一次任务后退出用 print；
	// 程序读取执行事件用 json；程序长期连续发送任务用 rpc。
	// parsed 表示用户是否主动传入 --mode；stdin.isTTY 表示输入来自人还是管道；
	// stdout.isTTY 表示输出直接显示给人，还是交给文件或其他程序。
	let appMode = resolveAppMode(parsed, process.stdin.isTTY, process.stdout.isTTY);
	const shouldTakeOverStdout = appMode !== "interactive" && !isPlainRuntimeMetadataCommand(parsed);
	if (shouldTakeOverStdout) {
		// 系统原本就有 stdout（正式结果）和 stderr（提示、日志、报错）两条输出通道。
		// 非交互模式下，将普通输出转到 stderr，保留 stdout 给外部程序读取正式结果。
		takeOverStdout();
	}

	// RPC 模式通过 stdin 接收程序发送的命令，不能再使用 @文件 参数；
	// 例如 pi --mode rpc @prompt.txt 会报错并以状态码 1 退出。
	if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) {
		console.error(chalk.red("Error: @file arguments are not supported in RPC mode"));
		process.exit(1);
	}

	// --fork 表示复制旧会话并创建新会话；不能同时要求直接打开或继续旧会话。
	validateForkFlags(parsed);
	// --session-id 表示指定会话 ID；不能与 --session、--continue、--resume 混用。
	validateSessionIdFlags(parsed);

	// 启动前迁移旧数据：cwd 是当前项目目录，用于项目级 .pi/ 配置；
	// agentDir 是所有项目共用的 Pi 全局目录，用于凭证、历史会话等全局数据。
	const { migratedAuthProviders: migratedProviders, deprecationWarnings } = runMigrations(cwd);
	time("runMigrations");

	// 读取并合并两层设置：agentDir/settings.json 是所有项目共用的全局设置，
	// cwd/.pi/settings.json 是当前项目的设置。
	const startupSettingsManager = SettingsManager.create(cwd, agentDir);
	// 取出设置文件读取或格式错误产生的警告，后续由 main 决定何时显示。
	const startupSettingsDiagnostics = collectSettingsDiagnostics(startupSettingsManager);

	// 实验性的首次启动设置：选择主题并决定是否启用分析数据收集。
	// 必须在创建运行时服务前执行，才能让选择的设置在本次启动的所有位置生效。
	if (appMode === "interactive" && !parsed.help && parsed.listModels === undefined && shouldRunFirstTimeSetup()) {
		// 显示首次设置向导：选择主题，并决定是否启用分析数据收集；选择会保存到设置中。
		await showFirstTimeSetup(startupSettingsManager);
		// 仅记录首次设置这一步的启动耗时，不显示任何内容。
		time("firstTimeSetup");
	}

	// 直接在终端运行 pi 时默认是 interactive；只有用户传入 --use-theme 时，
	// 才在本次运行中覆盖主题，不写回设置文件。
	if (appMode === "interactive" && parsed.useTheme !== undefined) {
		startupSettingsManager.applyOverrides({ theme: parsed.useTheme });
	}

	// 创建依赖 cwd 的运行时服务前，先确定这次最终使用哪个项目目录。
	// --session 和 --resume 可能选中其他项目的会话；因此只有确定目标会话的 cwd 后，
	// 才能读取该项目的设置、资源、provider 注册和模型。启动时创建的设置管理器
	// 只在选择会话期间用于查找 sessionDir。
	// 例如从项目 A 启动后恢复项目 B 的 session：后续按项目 B 的上下文运行，
	// 新对话追加到该 session 的已保存历史中；如需复制历史并创建新会话，应使用 --fork。
	// 读取环境变量 PI_SESSION_DIR；用户可用它指定 session 文件的存放目录。
	const envSessionDir = process.env[ENV_SESSION_DIR];
	// 按优先级确定 sessionDir：命令行 --session-dir > 环境变量 > 设置文件中的默认值。
	// sessionDir 只是存放多个 session 文件的文件夹，不代表本次已选中某个具体 session。
	const sessionDir =
		(parsed.sessionDir ? normalizePath(parsed.sessionDir) : undefined) ??
		(envSessionDir ? expandTildePath(envSessionDir) : undefined) ??
		startupSettingsManager.getSessionDir();
	// 根据用户的 --session、--resume、--fork 等参数，创建、打开或复制一个 session。
	// 例如 --continue 会在 sessionDir 中选取最近使用的 session 文件。
	let sessionManager = await createSessionManager(parsed, cwd, sessionDir, startupSettingsManager);
	// 旧 session 文件可能没有有效 cwd；先检查是否需要用户补选所属项目目录。
	const missingSessionCwdIssue = getMissingSessionCwdIssue(sessionManager, cwd);
	if (missingSessionCwdIssue) {
		if (appMode === "interactive") {
			// 交互模式下询问用户选择哪个项目目录；取消则正常退出。
			const selectedCwd = await promptForMissingSessionCwd(missingSessionCwdIssue, startupSettingsManager);
			if (!selectedCwd) {
				process.exit(0);
			}
			// 用用户选择的 cwd 重新打开同一个 session 文件。
			sessionManager = SessionManager.open(missingSessionCwdIssue.sessionFile!, sessionDir, selectedCwd);
		} else {
			// 非交互模式无法提问，因此直接报告错误并退出。
			console.error(chalk.red(new MissingSessionCwdError(missingSessionCwdIssue).message));
			process.exit(1);
		}
	}
	// 用户传入 --name 时，为当前 session 写入一个便于识别的名称；空名称直接报错。
	if (parsed.name !== undefined) {
		const name = normalizeSessionName(parsed.name);
		if (name === undefined) {
			console.error(chalk.red("Error: --name requires a non-empty value"));
			process.exit(1);
		}
		sessionManager.appendSessionInfo(name);
	}
	// 仅记录创建、打开或复制 session 这一步的启动耗时。
	time("createSessionManager");

	// trustStore 保存在 Pi 全局目录中的“项目可信任记录”，不是可信任的 session 列表。
	const trustStore = new ProjectTrustStore(agentDir);
	// session 只提供它所属项目的目录；后续用这个目录查询该项目是否被信任。
	const sessionCwd = sessionManager.getCwd();
	// 用户未强制指定信任状态，且当前项目暂时没有需要确认的资源时，
	// 记住该 cwd 交给交互界面；之后重新加载并出现此类资源时，才可保存本次隐式信任。
	const autoTrustOnReloadCwd =
		parsed.projectTrustOverride === undefined && !hasTrustRequiringProjectResources(sessionCwd)
			? sessionCwd
			: undefined;
	// --help 和 --list-models 不显示交互式信任询问。
	const trustPromptMode: AppMode = parsed.help || parsed.listModels !== undefined ? "print" : appMode;
	// 在本次 Pi 进程中缓存“项目目录 → 是否信任”，避免重新创建 runtime 时重复询问。
	const projectTrustByCwd = new Map<string, boolean>();

	// parsed 中这些字段来自用户可选的 --extension、--skill、--prompt-template、--theme 参数。
	// 例如 cwd 是 /Users/lwl/Desktop/pi、用户传入 --skill ./skills 时，
	// ./skills 会处理为 /Users/lwl/Desktop/pi/skills；这里只准备路径，尚未加载资源。
	const resolvedExtensionPaths = resolveCliPaths(cwd, parsed.extensions);
	const resolvedSkillPaths = resolveCliPaths(cwd, parsed.skills);
	const resolvedPromptTemplatePaths = resolveCliPaths(cwd, parsed.promptTemplates);
	const resolvedThemePaths = resolveCliPaths(cwd, parsed.themes);

	// 定义“创建运行环境”的函数，暂不执行。调用方会传入一个资料对象；
	// 参数中的 { cwd, agentDir, ... } 只是从该对象取出五个字段，不是解析用户命令。
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd,
		agentDir,
		sessionManager,
		sessionStartEvent,
		projectTrustContext,
	}) => {
		// 没有已有的 session 启动事件，说明这是当前 session 第一次创建运行环境。
		const isInitialRuntime = sessionStartEvent === undefined;
		// 收集信任检查过程中的警告，后面会交给运行环境显示。
		const projectTrustDiagnostics: AgentSessionRuntimeDiagnostic[] = [];
		// 从本次 Pi 进程的缓存中，查询当前项目是否已做过信任判断；首次创建时通常没有结果。
		const cachedProjectTrust = projectTrustByCwd.get(cwd);
		// 检查整套项目资源中是否有需确认项：.pi/settings.json、扩展、技能、MCP、提示词等。
		// 这决定是否需要项目级信任判断，不只检查 settings.json。
		const hasTrustRequiringResources = hasTrustRequiringProjectResources(cwd);
		// 只有用户没有强制指定、缓存没有结果、且项目确有此类资源时，才需要现在完成一次信任判断。
		const shouldResolveProjectTrust =
			parsed.projectTrustOverride === undefined && cachedProjectTrust === undefined && hasTrustRequiringResources;

		// projectTrusted 是“现在能否读取当前项目 .pi/ 配置”的开关：true 可读，false 暂不读。
		// 若仍需判断信任，先取 false 防止项目配置抢先加载；后面的服务创建流程会取得最终结果。
		const projectTrusted = shouldResolveProjectTrust
			? false
			: (cachedProjectTrust ??
				parsed.projectTrustOverride ??
				(!hasTrustRequiringResources || trustStore.get(cwd) === true));
		// 创建设置管理器。它只负责 settings.json：projectTrusted 为 false 时仍读 Pi 全局设置，
		// 但跳过 cwd/.pi/settings.json；扩展、技能等其余项目资源由后面的资源加载器按同一信任结果处理。
		const runtimeSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });

		// 调用已在别处定义的 createAgentSessionServices，不是在这里定义它；await 会等待它准备完成，
		// 再将返回结果保存到 services。下面对象中的每个字段，都是准备服务时交给它的输入资料。
		const services = await createAgentSessionServices({
			// 当前 session 所属项目目录；从这里读取项目资源。
			cwd,
			// Pi 全局目录；从这里读取所有项目共用的设置、认证和数据。
			agentDir,
			// 已按当前信任状态创建的设置管理器；它决定能否读取项目 .pi/settings.json。
			settingsManager: runtimeSettingsManager,
			// 模型初始化最多等待 15 秒；超时则取消，避免 Pi 一直卡在启动阶段。
			modelRuntimeSignal: AbortSignal.timeout(15_000),
			// Pi 不认识、但用户可能传给扩展的命令行参数，例如扩展自定义的 --my-flag。
			extensionFlagValues: parsed.unknownFlags,
			// 仅当项目还需要做信任判断时提供：main 将“如何确认信任”的流程交给资源加载器。
			// 资源加载器加载项目资源时需要确认才调用它；其中 resolveProjectTrusted 会查记录或弹窗并得出 true/false。
			resourceLoaderReloadOptions: shouldResolveProjectTrust
				? {
						resolveProjectTrust: async ({ extensionsResult }) => {
							const trusted = await resolveProjectTrusted({
								cwd,
								trustStore,
								trustOverride: parsed.projectTrustOverride,
								defaultProjectTrust: startupSettingsManager.getDefaultProjectTrust(),
								extensionsResult,
								projectTrustContext:
									projectTrustContext ??
									createProjectTrustContext({
										cwd,
										mode: isInitialRuntime ? trustPromptMode : appMode,
										settingsManager: startupSettingsManager,
										hasUI: isInitialRuntime && trustPromptMode === "interactive",
									}),
								onExtensionError: (message) => projectTrustDiagnostics.push({ type: "warning", message }),
							});
							projectTrustByCwd.set(cwd, trusted);
							return trusted;
						},
					}
				: undefined,
			// 告诉资源加载器：额外从哪里加载资源、以及用户通过命令行要求禁用哪些资源。
			resourceLoaderOptions: {
				// 用户通过 --extension、--skill、--prompt-template、--theme 指定的额外资源路径。
				additionalExtensionPaths: resolvedExtensionPaths,
				additionalSkillPaths: resolvedSkillPaths,
				additionalPromptTemplatePaths: resolvedPromptTemplatePaths,
				additionalThemePaths: resolvedThemePaths,
				// 用户传入对应的 --no-* 参数时，禁止加载相应类别的项目资源。
				noExtensions: parsed.noExtensions,
				disabledBuiltinExtensions: parsed.noMcp ? ["mcp"] : undefined,
				noSkills: parsed.noSkills,
				noPromptTemplates: parsed.noPromptTemplates,
				noThemes: parsed.noThemes,
				noContextFiles: parsed.noContextFiles,
				// 用户直接传入的系统提示词，以及要追加到默认系统提示词后的内容。
				systemPrompt: parsed.systemPrompt,
				appendSystemPrompt: parsed.appendSystemPrompt,
				// Pi 内置扩展的创建方法；不是用户项目目录里的扩展文件。
				extensionFactories,
			},
		});

		// services 是刚准备好的工具箱；这里取出后续要单独使用的三项，未再次创建它们：
		// settingsManager 读取最终设置；modelRuntime 管理 AI 模型和认证；resourceLoader 管理已加载的项目资源。
		const { settingsManager, modelRuntime, resourceLoader } = services;

		// 将启动过程各处发现的问题合并为 diagnostics，暂不直接输出；后面由运行环境统一显示。
		const diagnostics: AgentSessionRuntimeDiagnostic[] = [
			// 信任判断、准备 services、读取设置时产生的问题；数组前的 ... 会把其中每一项直接放入 diagnostics，
			// 而不是把整个数组作为 diagnostics 的一个元素。
			...projectTrustDiagnostics,
			...services.diagnostics,
			...collectSettingsDiagnostics(settingsManager),
			// 扩展加载器分别提供错误和警告；.map(...) 会把每一项扩展问题转换为 diagnostics 的 { type, message } 格式。
			...resourceLoader.getExtensions().errors.map(({ path, error }) => ({
				type: "error" as const,
				message: `Failed to load extension "${path}": ${error}`,
			})),
			...(resourceLoader.getExtensions().warnings ?? []).map(({ path, warning }) => ({
				type: "warning" as const,
				message: `Extension package "${path}": ${warning}`,
			})),
		];

		// 先确定本次允许从哪些模型中选择：用户传入 --models 时优先使用，否则读取设置中的默认启用模型。
		// modelPatterns 只是“想允许的名单”，还未表示本次一定会选中其中某一个模型。
		const modelPatterns = parsed.models ?? settingsManager.getEnabledModels();
		// 将名单与当前实际可用的模型（provider 和认证状态）对照，得到真正可选的 scopedModels。
		// 没有模型名单时返回空数组；本段只划定可选范围，具体选哪个模型在后面的 buildSessionOptions 中决定。
		const scopedModels =
			modelPatterns && modelPatterns.length > 0
				? await resolveModelScope(modelPatterns, modelRuntime, { signal: AbortSignal.timeout(15_000) })
				: [];

		// 调用同一文件前面定义的 buildSessionOptions：它会用下面 5 个输入计算并校验创建 session 的选项，
		// 而不是简单地把 5 个参数打包。返回值有 3 项；这里同时从返回对象取出它们。
		const {
			// 返回对象的 options 字段，改名保存为 sessionOptions：最终模型、思考等级、工具等创建选项。
			options: sessionOptions,
			// true/false 标记：思考等级是否来自用户写在 --model 中的简写。
			cliThinkingFromModel,
			// 返回对象的 diagnostics 字段，改名保存为 sessionOptionDiagnostics：模型或工具参数的错误、警告。
			diagnostics: sessionOptionDiagnostics,
		} = buildSessionOptions(
			// 用户本次输入的 --model、--thinking、--tools 等已解析参数。
			parsed,
			// 前面确认过的、当前实际可选模型列表。
			scopedModels,
			// 当前 session 是否已有历史消息：大于 0 为 true，表示这是旧 session；否则为新 session。
			sessionManager.buildSessionContext().messages.length > 0,
			// 查询模型信息、provider 与认证状态。
			modelRuntime,
			// 读取默认模型和默认 provider 等设置。
			settingsManager,
		);

		// diagnostics 是 main 的总问题清单；sessionOptionDiagnostics 是 buildSessionOptions 返回的模型、工具参数问题小清单。
		// 将小清单中的每一项展开后加入总清单，sessionOptionDiagnostics 自身不会改变。
		diagnostics.push(...sessionOptionDiagnostics);

		// 用户传入 --api-key 时，Pi 必须先知道本次使用的模型，才能确定将这把 Key 交给哪个 provider。
		if (parsed.apiKey) {
			if (!sessionOptions.model) {
				// 只有 API Key、没有模型时无法确定 provider；先记录错误，后面统一显示。
				diagnostics.push({
					type: "error",
					message: "--api-key requires a model to be specified via --model, --provider/--model, or --models",
				});
			} else {
				// 将 Key 临时交给该模型所属 provider；仅本次运行有效，不写入 Pi 的设置文件。
				await modelRuntime.setRuntimeApiKey(sessionOptions.model.provider, parsed.apiKey);
			}
		}

		// 将前面准备好的 services、当前 session 历史和本次模型/工具选项重新组合，
		// 立即交给下一层 createAgentSession(...) 真正创建 AgentSession；这里不会只停在封装数据。
		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model: sessionOptions.model,
			thinkingLevel: sessionOptions.thinkingLevel,
			scopedModels: sessionOptions.scopedModels,
			tools: sessionOptions.tools,
			excludeTools: sessionOptions.excludeTools,
			noTools: sessionOptions.noTools,
			customTools: sessionOptions.customTools,
		});

		// created 是创建函数返回的结果包，不是 AgentSession 本身；真正的 session 在 created.session 中，
		// 因此 thinkingLevel 属性与 setThinkingLevel(...) 方法都要通过 created.session 访问。
		const cliThinkingOverride = parsed.thinking !== undefined || cliThinkingFromModel;
		// && 表示两个条件必须同时成立：session 已选中模型，且用户本次明确指定了思考等级；
		// 只有此时才在该 session 上重新应用当前 thinkingLevel，确保本次命令的选择优先。
		if (created.session.model && cliThinkingOverride) {
			created.session.setThinkingLevel(created.session.thinkingLevel);
		}

		// created 是“刚刚创建 AgentSession”得到的结果包：session、extensionsResult、modelFallbackMessage。
		// 下面的 return 不会再次创建 AgentSession；它把这些结果连同 services、diagnostics 交还给
		// 调用 createRuntime(...) 的 createAgentSessionRuntime(...)。对象中的 ...created 会展开 created 的三项字段。
		return {
			...created,
			services,
			diagnostics,
		};
	};

	// 只开始记录 createRuntime 实际执行的耗时，不创建任何对象。
	time("createRuntime");
	// 现在将“创建配方” createRuntime 和当前 session 的资料交给 createAgentSessionRuntime。
	// 它会在内部调用 createRuntime(...)，接收上面 return 的结果包，再创建外层 AgentSessionRuntime。
	// 这里不会重新创建 AgentSession；runtime 只是包住已有 session、services、diagnostics 的运行管理容器。
	const runtime = await createAgentSessionRuntime(createRuntime, {
		// 取当前选中 session 所属项目的目录；恢复其他项目的 session 时，这里就是那个项目的 cwd。
		cwd: sessionManager.getCwd(),
		// Pi 所有项目共用的全局数据目录。
		agentDir,
		// 管理当前 session 文件和历史记录的对象。
		sessionManager,
	});
	time("createAgentSessionRuntime");

	const { services, session, modelFallbackMessage } = runtime;
	const { settingsManager, modelRuntime, resourceLoader } = services;
	// 应用设置中手动指定的终端显示能力，例如是否支持真彩色、超链接或图片；后续界面按此显示。
	setCapabilityOverrides(settingsManager.getTerminalCapabilityOverrides());
	// 若设置中提供 httpProxy，则为当前 Pi 进程设置 HTTP_PROXY、HTTPS_PROXY，使后续模型等网络请求走代理。
	applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
	// 配置后续所有 HTTP 请求共用的网络处理器：读取代理设置，并使用设置中的空闲超时时间。
	configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());

	// 只有用户输入 pi --help 时 parsed.help 才是 true；普通任务跳过整个代码块，继续往下启动 Agent。
	if (parsed.help) {
		// 先显示读取启动设置时已经发现的警告，避免帮助输出掩盖设置问题。
		reportDiagnostics(startupSettingsDiagnostics);
		// resourceLoader.getExtensions() 取已加载扩展的结果；其中 extensions 是每个扩展组成的数组。
		// 对数组里的每个 extension：extension.flags 是“参数名 → 参数定义”的 Map；
		// .values() 只取参数定义，Array.from(...) 将它转成普通数组，flatMap(...) 再把所有扩展的数组合并。
		// 最终 extensionFlags 是全部扩展提供的命令行参数定义，供 pi --help 一起显示。
		const extensionFlags = resourceLoader
			.getExtensions()
			.extensions.flatMap((extension) => Array.from(extension.flags.values()));
		// 打印 Pi 内置参数和 extensionFlags 中的扩展参数。
		printHelp(extensionFlags);
		// 帮助已输出；状态码 0 表示正常结束，不再创建或运行 Agent 对话。
		process.exit(0);
	}

	// 只有用户输入 --list-models 时才进入；普通任务跳过此块，继续准备并运行 Agent。
	if (parsed.listModels !== undefined) {
		// 与 --help 相同：先输出启动设置的警告，再输出模型列表。
		reportDiagnostics(startupSettingsDiagnostics);
		// 三元判断：若 --list-models 后有字符串筛选词（如 gpt），就使用它；否则为 undefined，表示列出全部模型。
		const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
		// 查询并输出模型列表；AbortSignal.timeout(15_000) 表示最多等待 15 秒，避免网络查询一直卡住。
		await listModels(modelRuntime, searchPattern, AbortSignal.timeout(15_000));
		// 模型列表已输出；状态码 0 表示正常结束，不再进入 Agent 对话。
		process.exit(0);
	}

	// stdin 是正常终端（TTY）时，人可持续键盘输入，Pi 可保持 interactive 聊天；
	// stdin 是管道时（如 echo "任务" | pi），Pi 只能读到一次文字，读完管道即结束。
	// RPC 也使用 stdin 接收程序命令，因此不能把它误读成普通用户任务。
	let stdinContent: string | undefined;
	if (appMode !== "rpc") {
		// 读取管道中的文字；正常终端没有管道内容时会得到 undefined。
		stdinContent = await readPipedStdin();
		if (stdinContent !== undefined && appMode === "interactive") {
			// 已读到一次性管道任务时，不再打开需要持续键盘输入的聊天界面；改为执行一次并输出结果的 print 模式。
			appMode = "print";
		}
	}
	// 仅记录读取 stdin 花费的启动时间。
	time("readPipedStdin");

	// 调用已实现的 prepareInitialMessage：把 parsed 中的首条命令行消息、@文件内容，
	// 以及普通管道读到的 stdinContent 整理成首条可发送内容；此处只准备，尚未发送给模型。
	// await 会等待 @文件的文字或图片读取完成；左侧 { initialMessage, initialImages } 是对象解构，
	// 等价于从返回对象分别取 result.initialMessage（文字）和 result.initialImages（图片）。
	const { initialMessage, initialImages } = await prepareInitialMessage(parsed, stdinContent);
	// 仅记录整理首条消息所花的启动时间。
	time("prepareInitialMessage");
	// 前面已确定 appMode；这里不重新判断模式，只复用结果决定主题是否需要监听文件变化。
	// getTheme() 读取当前最终设置中的主题名。前面的 --use-theme 只临时改过主题设置；这里才真正加载主题。
	// interactive 为 true 时还会监听主题文件，修改主题后交互界面可重新加载；print/json/rpc 为 false，只加载一次。
	initTheme(settingsManager.getTheme(), appMode === "interactive");
	// 仅记录加载主题所花的启动时间。
	time("initTheme");

	// 只有交互模式且迁移旧配置时发现过期用法，才向当前用户显示提醒；
	// print/json/rpc 不显示，避免将提示混入一次性输出或程序协议输出。
	if (appMode === "interactive" && deprecationWarnings.length > 0) {
		// await 等待提醒界面显示流程完成；这里只告知用户，不创建 Agent 也不修改当前 session。
		await showDeprecationWarnings(deprecationWarnings);
	}

	// 仅记录启动耗时；这里不会再次调用 resolveModelScope(...)。只有 PI_TIMING=1 时才会收集并输出这类耗时。
	time("resolveModelScope");
	// 合并“读取设置”与“创建 runtime”两个阶段的问题；数组中的 ... 会展开两份清单，
	// deduplicateDiagnostics(...) 去掉重复项，得到启动阶段要显示的总问题清单。
	const startupDiagnostics = deduplicateDiagnostics([...startupSettingsDiagnostics, ...runtime.diagnostics]);
	// .some(...) 检查 runtime.diagnostics 中是否至少有一条 type 为 error；有则为 true。
	const hasRuntimeErrors = runtime.diagnostics.some((diagnostic) => diagnostic.type === "error");

	// || 表示任意一边成立即可：非交互模式总是立刻输出启动问题；交互模式只有存在 runtime 错误时才立刻输出。
	if (appMode !== "interactive" || hasRuntimeErrors) {
		reportDiagnostics(startupDiagnostics);
	}
	// runtime 创建阶段有错误时，不能安全进入聊天或执行任务，因此在显示问题后以状态码 1 退出。
	if (hasRuntimeErrors) {
		// 检查错误信息是否包含“扩展加载失败”；若有则额外告诉用户可用 -ne 禁用扩展后启动，便于排查。
		if (runtime.diagnostics.some((diagnostic) => diagnostic.message.includes("Failed to load extension"))) {
			console.error(chalk.yellow(EXTENSION_LOAD_FAILURE_HINT));
		}
		process.exit(1);
	}
	// 仅记录到 AgentSession 创建完成这一阶段的启动耗时；不会再次创建 session。
	time("createAgentSession");

	// && 表示两个条件都成立才报错：print/json/rpc 等非交互模式要求立刻执行任务，
	// 因而 session 必须已有模型；interactive 可先打开界面，再让用户选择模型或处理认证。
	if (appMode !== "interactive" && !session.model) {
		// 没有模型无法执行一次性任务，输出说明后以状态码 1 退出。
		console.error(chalk.red(formatNoModelsAvailableMessage()));
		process.exit(1);
	}

	// 读取 PI_STARTUP_BENCHMARK 环境变量；值为 1、true 或 yes 时开启交互界面启动测速。
	// 测速只额外记录并输出各启动步骤耗时，不改变正常 Agent 对话逻辑。
	const startupBenchmark = isTruthyEnvFlag(process.env.PI_STARTUP_BENCHMARK);
	// 启动测速还会测量 interactiveMode.init()；print/json/rpc 没有该界面初始化步骤，不能开启。
	if (startupBenchmark && appMode !== "interactive") {
		console.error(chalk.red("Error: PI_STARTUP_BENCHMARK only supports interactive mode"));
		process.exit(1);
	}

	// RPC 是长期运行模式，后续 Agent 请求需要最新模型、Provider 和认证可用状态。
	// 它可先使用启动时已有的模型信息接收请求，同时在后台刷新，避免“先等网络刷新”拖慢 RPC 启动。
	// interactive 模式也会刷新，但会在后面的终端界面初始化后才开始。
	if (!offlineMode && appMode === "rpc") {
		// AbortController 提供取消开关；15 秒仍未完成时停止这次后台刷新，但 RPC 本身继续运行。
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 15_000);
		// void 表示开始异步刷新但不 await 等待；.catch 忽略本次后台刷新失败，.finally 清理计时器。
		void modelRuntime
			.refresh({ signal: controller.signal })
			.catch(() => {})
			.finally(() => clearTimeout(timeout));
	}

	// 到这里才按前面已确定的 appMode 正式启动对应运行模式；不是再次创建 AgentSession。
	if (appMode === "rpc") {
		// 仅在 PI_TIMING=1 时输出此前收集的启动耗时；正常运行时不输出。
		printTimings();
		// 将已创建的 runtime（含 session、services 等）交给 RPC 运行器；
		// await 等待其持续读取和处理 RPC 命令，RPC 结束后 main.ts 才能结束。
		await runRpcMode(runtime);
	} else if (appMode === "interactive") {
		// 创建正常终端聊天模式的控制器和启动环境；复用已有 runtime，不会重新创建 AgentSession。
		// 此处只创建 interactiveMode；后面的 interactiveMode.run() 才真正启动界面并持续接收键盘输入。
		const interactiveMode = new InteractiveMode(runtime, {
			// 迁移旧认证配置时得到的 Provider 信息，以及启动阶段收集的问题或模型替换提示。
			migratedProviders,
			startupDiagnostics,
			modelFallbackMessage,
			// 运行中重新加载项目资源时使用的信任信息。
			autoTrustOnReloadCwd,
			// 启动 Pi 前已给出的首条文字、图片，以及剩余命令行消息。
			initialMessage,
			initialImages,
			initialMessages: parsed.messages,
			// 用户传入的终端界面显示选项。
			verbose: parsed.verbose,
			tuiMode: parsed.tuiMode,
			initialThemeSetting: parsed.useTheme,
		});

		// 启动测速模式不进入正常聊天：只初始化界面来测耗时，随后停止并退出。
		if (startupBenchmark) {
			// 准备终端聊天界面，但尚未进入持续读取键盘输入的 run() 循环。
			await interactiveMode.init();
			// 记录交互界面初始化完成这一阶段的耗时。
			time("interactiveMode.init");
			// 给终端约 150ms 返回初始化查询结果（键盘协议、终端属性、字符格大小等），再恢复终端状态。
			await new Promise((resolve) => setTimeout(resolve, 150));
			// 停止临时初始化的聊天界面和主题监听，避免测速结束后遗留后台工作。
			interactiveMode.stop();
			stopThemeWatcher();
			// 输出前面记录的全部启动耗时。
			printTimings();
			// 若标准输出仍有等待写出的文字，则等待 drain 事件，确保测速结果已真正写完再退出。
			if (process.stdout.writableLength > 0) {
				await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
			}
			// 标准错误输出同样需要等待写完。
			if (process.stderr.writableLength > 0) {
				await new Promise<void>((resolve) => process.stderr.once("drain", resolve));
			}
			// 测速已完成；return 会跳过下方第二个 printTimings() 和 interactiveMode.run()，
			// 因此同一次运行不会输出两次测速结果，也不会进入正常聊天循环。
			return;
		}

		// 只有 startupBenchmark 为 false 才会到这里；正常 interactive 路径若开启 PI_TIMING=1，
		// 先输出一次启动耗时，否则不输出，然后进入聊天界面。
		printTimings();
		// 此前只创建了 interactiveMode；run() 才真正打开终端聊天界面，持续接收用户第二、第三等后续输入。
		// await 会等待用户退出聊天界面后才返回，随后 main.ts 才结束。
		await interactiveMode.run();
	} else {
		// 前面 RPC 和 interactive 都不成立才会进入：这里处理 print（文本一次性输出）和 json（结构化一次性输出）模式。
		// 若开启 PI_TIMING=1，先输出启动耗时；否则不输出。
		printTimings();
		// 使用已有 runtime 执行一次任务并等待结束；返回的 exitCode 表示成功（0）或失败（非 0）。
		const exitCode = await runPrintMode(runtime, {
			// 内部 appMode 为 json 时使用 json 输出；print 时转换为 text 输出。
			mode: toPrintOutputMode(appMode),
			// prepareInitialMessage 取走首条后剩余的命令行消息，以及已整理的首次文字和图片输入。
			messages: parsed.messages,
			initialMessage,
			initialImages,
		});
		// 非交互模式也要结束主题相关后台监听，避免一次性任务结束后残留工作。
		stopThemeWatcher();
		// 前面非交互模式曾接管 stdout，保留它给正式结果；任务结束后恢复原本的 stdout 行为。
		restoreStdout();
		// 非 0 表示任务失败：只设置进程最终退出码，让 Node 有机会完成清理和输出写入；不立刻 process.exit()。
		if (exitCode !== 0) {
			process.exitCode = exitCode;
		}
		// print/json 一次性任务已经完成；结束 main()，Pi 进程随后自然退出。
		return;
	}
}
