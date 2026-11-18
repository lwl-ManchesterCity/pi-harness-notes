// 学习网络的数据。新增内容时加入一个节点；节点之间的关系写入 links。
// group 可选 flow（主流程）、tool（工具 / Hook）、data（状态 / 数据）。
window.PI_LEARNING_GRAPH = {
  nodes: [
    ['cli','CLI 启动','flow','解析启动参数，创建运行时服务并进入交互、打印或 RPC 模式。','packages/coding-agent/src/main.ts'],
    ['args','参数与运行模式','data','Week 1：解析命令行输入，确定 interactive、print、JSON 或 RPC 模式。','packages/coding-agent/src/main.ts'],
    ['services','Session 服务','flow','创建工作目录绑定的设置、模型运行时和资源加载器，再交给会话创建流程。','packages/coding-agent/src/core/agent-session-services.ts'],
    ['runtime','AgentSessionRuntime','flow','Week 1：创建并管理当前 session 与服务，也支持后续切换。','packages/coding-agent/src/core/agent-session-runtime.ts'],
    ['sdk','createAgentSession','flow','创建底层 Agent 与 AgentSession，并注入会话所需的服务。','packages/coding-agent/src/core/sdk.ts'],
    ['session','AgentSession','flow','接收用户输入，准备并启动 Agent 运行；处理运行后续状态。','packages/coding-agent/src/core/agent-session.ts'],
    ['session_run','prompt / _startRun','flow','Week 3：接收用户输入，准备消息并调用底层 Agent；运行后检查是否继续。','packages/coding-agent/src/core/agent-session.ts'],
    ['post_run','运行后检查','flow','Week 3：检查中止、重试、压缩和排队消息；重试内部只做过概览。','packages/coding-agent/src/core/agent-session.ts'],
    ['manager','SessionManager','data','维护 session 记录与分支；根据当前分支构建会话上下文。','packages/coding-agent/src/core/session-manager.ts'],
    ['entries','session 记录与文件','data','Week 3：fileEntries 保存内存中的记录；session 文件用于持久保存。','packages/coding-agent/src/core/session-manager.ts'],
    ['branch','当前分支','data','Week 3：leafId 标记当前位置，沿 parentId 找到父记录并还原分支。','packages/coding-agent/src/core/session-manager.ts'],
    ['edits','压缩与 context_edit','data','Week 3：上下文投影应用压缩记录和编辑；保留起点的选择过程尚未深入。','packages/coding-agent/src/core/session-manager.ts'],
    ['agent','Agent','flow','持有模型、工具和消息状态，通过 prompt 启动 Agent Loop。','packages/agent/src/agent.ts'],
    ['loop','Agent Loop','flow','请求模型、处理工具调用与结果，并在需要时继续下一轮。','packages/agent/src/agent-loop.ts'],
    ['messages','运行时消息','data','Week 2：currentContext.messages 是工作上下文，newMessages 记录本次运行新增消息。','packages/agent/src/agent-loop.ts'],
    ['stream','模型请求','flow','流式读取 assistant 回复，包括文本、思考和工具调用事件。','packages/agent/src/agent-loop.ts'],
    ['convert','convertToLlm','data','将 Pi 的 AgentMessage 转换为模型请求使用的消息。','packages/coding-agent/src/core/messages.ts'],
    ['calls','Tool Call 批次','tool','从 assistant 回复提取工具调用，选择顺序或并行执行。','packages/agent/src/agent-loop.ts'],
    ['prepare','prepareToolCall','tool','查找真实 Tool、预处理和校验参数，执行 beforeToolCall；可直接返回错误。','packages/agent/src/agent-loop.ts'],
    ['before','beforeToolCall','tool','工具执行前的控制点，可检查调用并阻止执行。','packages/agent/src/agent-loop.ts'],
    ['extension_bridge','AgentSession._beforeToolCall','tool','将已校验的工具调用转换为 tool_call 事件，交给扩展检查。','packages/coding-agent/src/core/agent-session.ts'],
    ['extension_runner','emitToolCall','tool','依次调用扩展注册的处理函数；block 为 true 时停止检查并返回阻止结果。','packages/coding-agent/src/core/extensions/runner.ts'],
    ['extension_decision','扩展检查结果','tool','block 为 true 时返回错误且不执行工具；未阻止时继续准备执行。','packages/agent/src/agent-loop.ts'],
    ['parallel','并行执行','tool','按顺序准备各调用，随后启动待执行函数；结果按原调用顺序整理。','packages/agent/src/agent-loop.ts'],
    ['execute','executePreparedToolCall','tool','调用 Tool.execute，处理部分更新、取消、结果和耗时。','packages/agent/src/agent-loop.ts'],
    ['update','partial update','data','工具运行时的部分结果；已开始的更新会在最终返回前等待完成。','packages/agent/src/agent-loop.ts'],
    ['after','afterToolCall','tool','工具执行后可查看并覆盖结果或错误状态。','packages/agent/src/agent-loop.ts'],
    ['after_bridge','_afterToolCall','tool','Week 4：AgentSession 将工具执行结果发送给注册了 tool_result 的扩展，并处理结果内容。','packages/coding-agent/src/core/agent-session.ts'],
    ['tool_result_hook','tool_result 扩展','tool','Week 4：工具执行后的扩展处理时机，可以检查或修改结果。','packages/coding-agent/src/core/extensions/runner.ts'],
    ['result','toolResult','data','将最终执行结果封装为消息，加入上下文供后续模型请求处理。','packages/agent/src/agent-loop.ts'],
    ['tools','内置 Tool','tool','已阅读工具目录：read、bash、powershell、edit、write、grep、find、ls。','packages/coding-agent/src/core/tools/index.ts'],
    ['read','read Tool','tool','创建工具定义；按路径读取图片或文本，并处理取消、选行和截断。','packages/coding-agent/src/core/tools/read.ts'],
    ['context','上下文投影','data','从当前分支整理上下文，应用压缩记录和 context_edit。','packages/coding-agent/src/core/session-manager.ts'],
    ['queues','消息队列','data','steering 与 follow-up 在 Agent Loop 的不同位置进入后续运行。','packages/agent/src/agent-loop.ts']
  ],
  // 每条关系依次为：起点 id、终点 id、关系说明。
  links: [
    ['cli','args','解析'],['cli','runtime','启动'],['runtime','services','准备'],['services','sdk','交给'],['sdk','session','创建'],['sdk','agent','创建'],
    ['session','session_run','处理输入'],['session_run','agent','调用'],['session_run','post_run','运行后'],['session','manager','使用'],['manager','entries','保存'],['manager','branch','组织'],['branch','context','构建'],['context','edits','应用'],['agent','loop','启动'],
    ['loop','messages','维护'],['loop','stream','请求'],['stream','convert','转换'],['loop','calls','处理'],['loop','queues','读取'],
    ['calls','prepare','准备'],['prepare','before','检查'],['calls','parallel','可并行'],['parallel','execute','启动'],
    ['before','extension_bridge','交给'],['extension_bridge','extension_runner','发送事件'],['extension_runner','extension_decision','返回结果'],['extension_decision','parallel','未阻止'],
    ['execute','update','上报'],['execute','after','执行后'],['after','after_bridge','交给'],['after_bridge','tool_result_hook','通知扩展'],['after','result','生成'],['result','loop','回传'],
    ['tools','read','创建'],['prepare','tools','查找']
  ]
};
