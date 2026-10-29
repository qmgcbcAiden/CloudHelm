# 工具 P0–P2 修复状态

基线：`34d8ce8`；修复分支：`codex/tool-safety-repair`。无已确认 P0。本表只记录本轮代码和证据，不沿用历史 Python/SFTP 实现的验收结论。

## 实现与回归对应

| 编号 | 实现 | 主要回归证据 |
| --- | --- | --- |
| F1 | 句柄读取 uid/gid/mode、访问 ACL、受支持 xattr/SELinux；目标与备份在提交前设置、验证并 fsync；无法保留则拒绝 | `Tests/native/files` 的 ReplacePreservesMetadata、AccessACL、AttributeValues、DeleteRetainsOriginalMetadata；`Tests/native/selinux` enforcing 标签和备份验证 |
| F2 | 普通文件句柄检查、no-follow、1 MiB + 1 有界读取；特殊模式、多个硬链接和不支持安全属性拒绝 | `Tests/native/files` RefusesSpecialFilesLinksAndOversize、FileGrowthBeyondLimitAfterStaging、MetadataSyscallFailure；`Tests/application/file-transactions.test.ts` 有界快照和内容摘要检查 |
| F3 | 旧新完整正文只经专用消息进入主进程有界预览存储；审批和操作卡按操作 ID 读取；文本差异、二进制 Base64、完整展开与属性说明 | `Tests/desktop/renderer/file-approval-preview.test.tsx`、`file-line-diff.test.ts`、`Tests/desktop/main/file-preview-store.test.ts`、`Tests/smoke/file-preview-smoke.mjs` |
| F4 | cron、系统/用户 systemd、root/普通账户 Shell 启动入口共享高影响规则，覆盖写入/上传/删除/可识别 Shell 修改 | `Tests/core/tool-repair-policy.test.ts`，三种审核模式逐项检查 |
| F5 | 旧版本或不存在快照绑定审核；暂存前与提交前再检；新目标 no-replace；冲突不重放 | `Tests/native/files` RejectsChangedTarget、LastVersionRecheck、ChangedStagedArtifactsCannotReplaceOriginal；`Tests/application/file-transactions.test.ts` |
| F6 | 逐级目录句柄与 O_NOFOLLOW；相对句柄提交；提交前后重新打开路径确认父目录 device/inode | `Tests/native/files` ParentReplacementAfterStagingCannotRedirectCommit |
| F7 | 主进程 SQLite CAS/ACK 后派发；准备/暂存/提交/确认记录、备份与 receipt；恢复只核验，最终持久化后解除锁；解除锁 ACK 丢失可幂等重试 | `Tests/adapters/file-transaction-store.test.ts`、`Tests/desktop/main/file-recovery-ipc.test.ts`、`Tests/desktop/worker/file-recovery-runtime.test.ts`、native 提交/receipt 故障测试 |
| F8 | 业务文件读取、提交和删除统一使用原生协议；删除旧 SFTP 写事务入口 | `Tests/native/process/files_ssh_linux_test.go` 在禁用 SFTP 的真实 sshd 中提交 |
| T1 | 固定工件 install/launch/su-bootstrap/cleanup 独立经过 SafetyGate；资源意图主进程确认；按任务/会话/代次独占资源 | `Tests/desktop/worker/native-runtime-preparation.test.ts`、`privileged-runtime-revocation.test.ts`、`Tests/desktop/main/runtime-resource-journal.test.ts`、`Tests/adapters/native-runtime-cleanup.test.ts` |
| T2 | 放弃控制权不创建人工 Shell；显式打开或首次人工输入才创建；Agent/Human 输入端口分离 | `Tests/adapters/ssh-command-terminal.test.ts`、`Tests/application/terminal-manager.test.ts` |
| T3 | 按任务追踪并关闭全部终端代次；root 业务授权立即撤销，清理结束关闭保留连接；未知资源不自动删除 | `Tests/application/terminal-manager.test.ts`、native-runtime-preparation 生命周期测试 |
| T4 | 普通命令以完整 Bash source 独立运行；结构化 sudo 保留实际 executable/argv；无法保存状态的混合 sudo 形式拒绝 | `Tests/core/command-execution-plan.test.ts`、真实 Linux BashSourcePTYAndExit |
| R1 | 缓存默认禁用；主机启用并由用户登记单密码；仅一次挑战成功才保存，完整绑定、5 分钟非滑动 TTL；多阶段/变化/失败/接管清除 | `Tests/application/sudo-credential-cache.test.ts`、`Tests/desktop/worker/operation-input-bridge.test.ts`、真实 PAM 密码 + TOTP 测试；Alpine 原包未启用 PAM，专用 musl fixture 使用校验源码后编译的真实 PAM 版 sudo |
| R2 | 统一 Go 启动协议；su 私有认证 PTY/ECHO、root 私有副本摘要、双向 peer PID/UID 校验；sudo 独立 askpass | `Tests/native/process` 真实 sudo/su/root SSH、错误密码、损坏副本、伪 sudo、替换 broker socket、受限 root 负向测试 |
| R3 | 审核前绑定逐步骤目标身份，多身份摘要；root 会话由真实 UID probe 激活；supervisor UID 与 payload 身份明确区分 | `Tests/core/command-execution-plan.test.ts`、`Tests/desktop/worker/task-runner-sudo-context.test.ts`、`task-runner-compound-sudo-intent.test.ts`（含 v11 存盘恢复屏障）、真实 su/root SSH UID 测试 |

## 验收记录

F1–F8、T1–T4、R1–R3 已实现并完成验收。功能实现提交为 `915fad33665fed8dc39f56db076daba0e2628634`，以下三个工作流均已通过。随后仅将认证请求标题统一为“认证挑战”并完善本文档；该标题所在的 35 项认证桥回归也已通过。

- Node/TypeScript 全量检查：三种桌面平台的 `pnpm check` 全部通过，包括类型、单元测试、lint、依赖方向、800 行、测试布局和版本检查。仅在适用环境运行的 SSH 测试未用本机跳过结果充当验收；实际适配器和原生身份/PAM 在下列隔离 Linux 作业执行。
- Linux 原生与应用适配器：`915fad3` 的[五项作业](https://github.com/qmgcbcAiden/CloudHelm/actions/runs/40892925191)全部通过。四环境为 amd64/arm64 × glibc/musl，包含真实 PAM、暂存/备份复核和故障注入；另一个作业从无组件的 sshd 开始，用实际 TypeScript 适配器流式部署，执行 Bash/sudo/su、su 后 sudo、文件暂存/提交和独立清理。该作业两项集成测试实际执行，无跳过。
- Fedora SELinux enforcing VM：`915fad3` 的[标签及备份验收](https://github.com/qmgcbcAiden/CloudHelm/actions/runs/40892925107)通过。
- 三种桌面包：同提交的[桌面完整 CI](https://github.com/qmgcbcAiden/CloudHelm/actions/runs/40892925098)全部通过（macOS arm64/x64、Windows x64）。包含 UI、Markdown、私密文件差异、开发版及打包版 Electron、两种 ELF 验证，以及 DMG/NSIS 安装包。arm64 作业曾因 GitHub runner 容量不足未启动，重试后实际执行并通过。
- 本机最新开发版、打包版 Electron 及 renderer/Markdown/文件差异预览浏览器冒烟均通过。桌面测试含凭据加密、SQLite/WASM、两种 ELF 完整性；文件预览浏览器验证实际 Main IPC 和过期审批拒绝。这些不替代远端 Linux 验收。

## 能力与保证边界

- 远端仅支持 Linux amd64/arm64；组件无动态运行库依赖，不要求 Python、SFTP 或常驻服务。需要 Bash、允许执行的显式部署目录及普通 SSH 字节流工具。默认 `/tmp` 不可执行或受保护时停止 Agent 操作，不自动换目录或退回旧后端。
- 结构化文件仅支持登录用户或 root SSH；文件上限 1 MiB，新文件 0600、事务目录 0700。成功备份保留，未决事务不自动清理。setuid/setgid、capability、immutable/append-only、未知安全属性及多硬链接文件需要人工处理。
- 已有文件最后复核与 rename 之间仍存在非合作写入方竞争窗口；目录句柄和冲突检测不等于强事务隔离。
- 中断请求、通道关闭和模型 abort 不证明远端进程退出。未知业务结果保持主机写锁；恢复只核验，不重放 apply。无法证明 receipt 的内容匹配不能升级为原操作提交成功。
- 独立文件恢复结束时关闭终端和 root SSH 连接；原业务写锁解除前不删除恢复用组件，组件资源记为 unknown 留待人工核验，不自动回收或重试删除。
- 缓存不落盘、不发送 Renderer；暂停、断线、接管及结束清除。askpass 只给提示文本，服务器改变 PAM 但提示不变时仍有用户已接受的类型识别风险。
- su root bootstrap 必须能读取原 broker 的 `/proc/PID/exe` 并在 root 私有目录校验复制；受限容器 root 无该能力时失败封闭。root SSH 不依赖此 su 复制流程。
- 原始认证提示摘要用于精确匹配，净化后的提示仅供显示。`started.supervisorUid/supervisorEuid` 只描述监督进程，不能用来冒充 sudo 目标进程的已验证 UID。
- 历史操作意图键保持 v11 编码兼容；新审批指纹绑定最终计划和策略。迁移 0012 不重写历史操作、不恢复旧提权授权。

机制来源与区别见 [原生协议](REMOTE_NATIVE_PROTOCOL.md)。
