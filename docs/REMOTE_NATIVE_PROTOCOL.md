# 远端原生组件与提交协议

固定 Go 1.27.3、creack/pty v1.1.24、golang.org/x/sys v0.49.0，静态编译 Linux amd64/arm64。应用随包保存两种 ELF、长度、SHA-256 与协议版本 1。SSH 字节流只上传固定工件；模型不能提供 helper 或下载地址。

部署与启动由 backend 生成 runtime 操作，经 SafetyGate 绑定工件、路径、身份、策略、会话与连接代次。默认私有目录在 `/tmp`；可配置位置来自主机设置。无 Bash/noexec/架构或协议不匹配，能够确认时反馈业务未启动。请求发送后失去确认仍保留未知结果。

## 组件职责

- `native/protocol`：版本、会话/操作/代次绑定，有界帧与结构校验。
- `native/process`：独立 Bash/argv 进程监督、PTY 输出、停止后继续观察退出。认证通过私有 Unix socket，不经过业务 stdin。
- `native/su`：独立认证 PTY、ECHO 校验，root 私有副本摘要校验，root peer credentials 与 UID/EUID 验证，root 侧同时校验对端 PID 等于原 broker PID。root 副本不会通过退出 trap 隐含删除，清理由单独审核的 cleanup 请求完成。
- `native/files`：目录句柄、快照、属性保留、暂存、备份、最后复核、原子替换与提交凭据；无网络服务。

帧最大 2 MiB；文件最多 1 MiB，所有帧带 `version/sessionId/operationId/generation`。控制与认证挑战也必须匹配。重复、乱序、超长或无法验证的消息使当前通道失败封闭，不触发另一后端。认证帧必须带原始提示的 `promptSha256`；显示净化不能改变缓存匹配依据。`started` 的 `supervisorUid/supervisorEuid` 只描述监督进程，不能作为 sudo payload 身份证明。普通命令保留 SSH 非交互环境，包括其已有的 BASH_ENV；组件只移除自己使用的敏感环境变量。

## 文件事务

```text
受读取策略保护的快照 → 最终计划与旧新预览 → SafetyGate
→ 主进程 prepared CAS/ACK → native暂存及backup
→ file-staged → 主进程 staged CAS/ACK → 复核授权 → file-commit
→ 最后版本/目录检查 → 原子提交 → fsync/读回/receipt
→ 主进程确认结果
```

状态与内容分离；旧文件正文与认证答案不进入事务日志。完整文件预览经专用 IPC 进入主进程内存（最多 16 项、32 MiB、15 分钟），审批及操作卡按权威操作绑定读取；普通事件、模型和审计中不含旧正文。远端 manifest 绑定原计划与审批指纹。recovery 不创建提交凭据、不重新 apply；“当前内容匹配”只说明观察结果，“receipt-confirmed”才证明原事务提交成功。未知写锁先保存主进程恢复结论再解除。

既有文件的最后复核与 rename 之间仍有非合作写入方竞争窗口；新目标采用 no-replace。目录句柄防止跟随替换后的符号链接，提交前后重开路径确认目录对象。无法取得允许的旧快照、无法保留属性或遇到特殊文件时停止。

## 开源依据

- [Mutagen SSH agent install v0.18.1](https://github.com/mutagen-io/mutagen/blob/v0.18.1/pkg/agent/install.go)：按平台分发固定原生组件和 SSH 部署；本项目采用短生命周期目录，不照搬持久安装。
- [creack/pty Linux v1.1.24](https://github.com/creack/pty/blob/v1.1.24/pty_linux.go)：PTY、进程会话与终端控制。
- [Ansible atomic_move v2.19.3](https://github.com/ansible/ansible/blob/v2.19.3/lib/ansible/module_utils/basic.py#L1718)：元数据和 SELinux 标签在原子替换前设置。
- [filepath-securejoin v0.4.1](https://github.com/cyphar/filepath-securejoin/blob/v0.4.1/open_linux.go)：路径逐级句柄绑定与 no-follow。
- [Cockpit askpass 304](https://github.com/cockpit-project/cockpit/blob/304/src/bridge/askpass.c)：认证交互独立于普通终端输入。
- [sudo tgetpass 1.9.15p5](https://github.com/sudo-project/sudo/blob/SUDO_1_9_15p5/src/tgetpass.c#L319)：askpass 提示不提供可信挑战类型，不能根据文本证明 OTP/密码。

借鉴上述机制不等于继承其全部安全保证；本轮验收证据独立记录在 TOOLS_REPAIR_STATUS.md。
