# CloudHelm 开发约束

- 依赖只能沿 `application → core`、`adapters → core`、`desktop 装配入口 → application + adapters + contracts`、`renderer/preload → contracts` 方向。禁止循环依赖与反向导入。
- Core 定义业务类型、端口和纯策略；Application 协调业务；Adapters 封装 Pi、SSH、SQLite 和 Bash 解析；Electron 主进程负责窗口、凭据与 IPC；utility process 运行 Agent 和 SSH。
- 手写源文件原则上不超过 800 行；函数保持单一职责。复用逻辑提取成职责明确的模块，不建立万能工具类。
- 后端状态是任务、审核、认证请求的唯一权威来源。Renderer 只投影状态，不自行决定输入投递目标、SSH 写入权限或命令批准。
- 所有 Agent 发起的远端变更都必须经过统一 `SafetyGate`。批准绑定操作内容、主机、目录、身份、策略版本与终端代次；执行前复核。安全组件失败时不自动放行。
- 密码与验证码不能进入模型上下文、普通 Shell 输入、审计正文或本地日志。新增交互必须绑定具体操作和接收方，并处理超时、重复提交、断线和人工接管。
- 不要假定 `agent.abort()` 会终止远端进程。未知结果先核验，不直接重放。
- 固定经过验证的依赖版本。数据库修改使用版本化迁移。提交信息使用简体中文。
