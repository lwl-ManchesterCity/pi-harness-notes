#!/usr/bin/env node
import { setupCli } from "./cli/setup.ts";
import { main } from "./main.ts";
//cli.ts：把用户输入交给 main()

// 初始化进程级 CLI 行为，例如错误处理和终端相关设置。
setupCli();
// 移除 Node 可执行文件与脚本路径，只把用户输入的参数传入主启动流程。
main(process.argv.slice(2));
