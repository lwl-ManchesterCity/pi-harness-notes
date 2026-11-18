// 每周只列出已学的主链与必要分支；说明中标明阅读程度。
window.PI_WEEK_GRAPHS = {
  '1': {
    nodes: [
      ['w1cli','CLI 入口','flow','已学习：接收命令行参数并交给 main。','packages/coding-agent/src/cli.ts'],
      ['w1main','main()','flow','已学习：组织启动、创建会话并选择运行模式。','packages/coding-agent/src/main.ts'],
      ['w1args','parseArgs / appMode','data','已学习：解析参数并确定交互、打印、JSON 或 RPC 模式。','packages/coding-agent/src/main.ts'],
      ['w1dirs','工作目录与设置目录','data','已学习：cwd、agentDir 和 sessionDir 分别关联项目、全局数据和 session 文件目录。','packages/coding-agent/src/main.ts'],
      ['w1trust','项目信任','data','已学习：信任判断影响项目设置和资源的使用。','packages/coding-agent/src/main.ts'],
      ['w1manager','SessionManager','data','Week 1 浅看用途；Week 3 已继续学习记录、分支与文件。','packages/coding-agent/src/core/session-manager.ts'],
      ['w1runtime','createAgentSessionRuntime','flow','已学习：调用创建流程，并用结果创建外层 runtime。','packages/coding-agent/src/core/agent-session-runtime.ts'],
      ['w1services','createRuntime / services','flow','已学习：为目标 session 准备设置、模型与资源等服务。','packages/coding-agent/src/core/agent-session-services.ts'],
      ['w1sdk','createAgentSession','flow','已学习：使用服务创建底层 Agent 和 AgentSession。','packages/coding-agent/src/core/sdk.ts'],
      ['w1agent','Agent / AgentSession','flow','已学习：Agent 执行运行；AgentSession 管理对话。内部在后续周继续学习。','packages/coding-agent/src/core/sdk.ts'],
      ['w1mode','运行模式','flow','已学习：main 根据模式启动 interactive、print、JSON 或 RPC。','packages/coding-agent/src/main.ts'],
      ['w1switch','切换 session','flow','已学习：准备目标 session，收尾旧内容并重新绑定。','packages/coding-agent/src/core/agent-session-runtime.ts']
    ],
    links: [['w1cli','w1main','调用'],['w1main','w1args','解析'],['w1main','w1dirs','使用'],['w1main','w1trust','检查'],['w1main','w1manager','创建或打开'],['w1main','w1runtime','创建'],['w1runtime','w1services','准备'],['w1services','w1sdk','交给'],['w1sdk','w1agent','创建'],['w1runtime','w1mode','提供运行内容'],['w1runtime','w1switch','支持']],
    positions: {w1cli:[-1250,0],w1main:[-960,0],w1args:[-960,-250],w1dirs:[-960,250],w1trust:[-650,-260],w1manager:[-650,260],w1runtime:[-650,0],w1services:[-300,0],w1sdk:[30,0],w1agent:[360,0],w1mode:[-300,250],w1switch:[30,250]}
  },
  '2': {
    nodes: [
      ['w2prompt','Agent.prompt / continue','flow','已学习：接收新消息或基于已有消息继续运行。','packages/agent/src/agent.ts'],
      ['w2entry','运行入口','flow','源码核对，待复习：prompt 经 runPromptMessages 直接调用 runAgentLoop；agentLoop 是另一种 EventStream 入口。','packages/agent/src/agent.ts'],
      ['w2loop','runAgentLoop / runLoop','flow','已学习：准备上下文，进入模型、工具和继续处理循环。','packages/agent/src/agent-loop.ts'],
      ['w2context','currentContext.messages','data','已学习：本次循环使用的完整工作上下文，包含旧历史和新消息。','packages/agent/src/agent-loop.ts'],
      ['w2new','newMessages','data','已学习：记录本次运行新增的消息，不包括之前的旧历史。','packages/agent/src/agent-loop.ts'],
      ['w2model','模型流式回复','flow','已学习：请求模型，接收流式事件并得到 assistant 消息。','packages/agent/src/agent-loop.ts'],
      ['w2tool','toolCall / 工具执行','tool','已学习主流程；工具准备、并行与执行细节后来在 Week 4 学习。','packages/agent/src/agent-loop.ts'],
      ['w2result','toolResult','data','已学习：工具结果写入上下文，正常继续时供下一轮模型请求使用。','packages/agent/src/agent-loop.ts'],
      ['w2queues','steering / follow-up','data','已学习：steering 中途介入；follow-up 在当前内层处理结束后处理。','packages/agent/src/agent.ts'],
      ['w2events','事件转发','data','已学习：Agent Loop 发出消息、工具与运行事件，Agent 接收并通知监听方。','packages/agent/src/agent.ts'],
      ['w2abort','AbortSignal','data','已理解基本作用；传给模型和工具的具体位置属源码核对，待复习。','packages/agent/src/agent-loop.ts'],
      ['w2end','继续或 agent_end','flow','已学习：处理工具结果和队列；没有后续工作时结束运行。','packages/agent/src/agent-loop.ts']
    ],
    links: [['w2prompt','w2entry','进入'],['w2entry','w2loop','启动'],['w2loop','w2context','维护'],['w2loop','w2new','记录'],['w2loop','w2model','请求'],['w2model','w2tool','提出调用'],['w2tool','w2result','产生'],['w2result','w2end','决定继续'],['w2loop','w2queues','读取'],['w2loop','w2events','发送'],['w2loop','w2abort','传递信号']],
    positions: {w2prompt:[-1250,0],w2entry:[-950,0],w2loop:[-620,0],w2context:[-800,-250],w2new:[-500,-250],w2model:[-260,0],w2tool:[70,0],w2result:[400,0],w2end:[730,0],w2queues:[-620,260],w2events:[-260,260],w2abort:[70,260]}
  },
  '3': {
    nodes: [
      ['w3prompt','AgentSession.prompt','flow','已学习：接收输入，按运行状态排队或启动。','packages/coding-agent/src/core/agent-session.ts'],
      ['w3start','_startRun / _prepareRun','flow','已学习：准备起始消息、调用 Agent，并处理运行后的继续判断。','packages/coding-agent/src/core/agent-session.ts'],
      ['w3agent','Agent.prompt / continue','flow','已学习：接收准备好的消息或继续底层 Agent 运行。','packages/agent/src/agent.ts'],
      ['w3post','运行后检查','flow','已学习：检查中止、重试、压缩和排队消息；重试内部仅浅看。','packages/coding-agent/src/core/agent-session.ts'],
      ['w3events','事件桥接','data','浅看：AgentSession 接收 Agent 事件并转发；消息完成时记录到 session。','packages/coding-agent/src/core/agent-session.ts'],
      ['w3manager','SessionManager','data','已学习：管理 session 记录、当前分支和文件保存。','packages/coding-agent/src/core/session-manager.ts'],
      ['w3entries','fileEntries / session 文件','data','已学习：fileEntries 是内存记录；session 文件用于持久保存。','packages/coding-agent/src/core/session-manager.ts'],
      ['w3branch','leafId / parentId','data','已学习：沿父记录 ID 追溯当前分支，再整理为从父到子的路径。','packages/coding-agent/src/core/session-manager.ts'],
      ['w3projection','上下文投影','data','已学习：根据当前分支、压缩记录和上下文编辑生成消息。','packages/coding-agent/src/core/session-manager.ts'],
      ['w3compact','压缩与保留起点','data','已学习读取侧如何使用 firstKeptEntryId；起点如何选择尚未深入。','packages/coding-agent/src/core/session-manager.ts'],
      ['w3edit','context_edit','data','已学习：构建上下文时应用替换或排除，原始历史仍保留。','packages/coding-agent/src/core/session-manager.ts'],
      ['w3convert','convertToLlm','data','已学习：转换普通消息、自定义消息、bash 记录和摘要。','packages/coding-agent/src/core/messages.ts']
    ],
    links: [['w3prompt','w3start','启动'],['w3start','w3agent','调用'],['w3agent','w3post','运行后'],['w3agent','w3events','发送事件'],['w3events','w3manager','记录消息'],['w3manager','w3entries','保存'],['w3manager','w3branch','组织'],['w3branch','w3projection','构建'],['w3projection','w3compact','使用'],['w3projection','w3edit','应用'],['w3projection','w3convert','转换']],
    positions: {w3prompt:[-1250,0],w3start:[-950,0],w3agent:[-600,0],w3post:[-270,0],w3events:[-600,250],w3manager:[-270,250],w3entries:[-270,500],w3branch:[60,250],w3projection:[400,250],w3compact:[400,0],w3edit:[700,0],w3convert:[750,250]}
  }
};
