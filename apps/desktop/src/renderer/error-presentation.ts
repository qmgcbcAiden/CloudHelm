export interface ErrorPresentation {
  code: string;
  title: string;
  description: string;
  severity: 'error' | 'warning';
  action?: 'model-settings';
  details: string;
}

interface ErrorRule extends Omit<ErrorPresentation, 'details'> { pattern: RegExp }

// Only constant, recognised diagnostic phrases may reach the UI. Provider errors can
// echo arbitrary credentials (including passwords with spaces); regex masking of
// token-shaped strings alone cannot make a raw error body safe to display or copy.
const rules: ErrorRule[] = [
  { code: 'model-key-missing', pattern: /请先配置所选供应商的 API Key|请输入 API Key|API Key is missing/iu,
    title: '请先配置模型', description: '当前供应商还没有可用的 API Key。请在模型设置中填写密钥、选择模型并保存，再回来发送消息。', severity: 'warning', action: 'model-settings' },
  { code: 'model-account-changed', pattern: /API Key 或地址已变更|尚未绑定模型凭据|Saved credentials changed|Please reselect the account/iu,
    title: '请重新确认对话模型', description: '这段对话的模型连接或账户已变化。请在输入框下方重新选择模型，确认接下来使用的连接和计费账户。', severity: 'warning' },
  { code: 'model-invalid', pattern: /所选模型不在(?: Pi)? 模型目录中|所选模型不在供应商目录中|Choose a Pi model provider|Choose a model from the selected Pi provider|Unknown Pi model provider|selected model is unavailable in the Pi catalog|请选择供应商和模型/iu,
    title: '请选择可用的模型', description: '当前供应商或模型不可用。请在模型设置中选择供应商和模型，再保存配置。', severity: 'warning', action: 'model-settings' },
  { code: 'model-url', pattern: /Custom model URL is required|Model API address must use HTTPS or local HTTP|Invalid URL/iu,
    title: '请检查模型地址', description: '模型地址需要使用完整的 HTTPS URL；本机服务也可以使用 HTTP。你可以恢复供应商的预置地址后再测试连接。', severity: 'warning', action: 'model-settings' },
  { code: 'model-test', pattern: /模型连接测试失败/iu,
    title: '暂时无法连接模型', description: '请检查 API Key、Base URL 和模型使用权限，再测试连接。', severity: 'error', action: 'model-settings' },
  { code: 'model-auth', pattern: /Incorrect API key|Invalid API key|invalid_api_key|authentication_error|HTTP 401|status(?: code)?[: =]+401|Unauthorized/iu,
    title: '模型身份验证未通过', description: '请检查当前供应商的 API Key 是否有效，以及它是否有权使用所选模型。', severity: 'warning', action: 'model-settings' },
  { code: 'model-quota', pattern: /insufficient_quota|rate_limit_exceeded|Too Many Requests|HTTP 429|status(?: code)?[: =]+429/iu,
    title: '模型服务暂时无法接受请求', description: '可能已达到调用频率或账户额度限制。请稍后再试，或到供应商处检查账户额度。', severity: 'warning' },
  { code: 'ssh-agent', pattern: /SSH Agent is unavailable/iu, title: 'SSH Agent 尚未就绪',
    description: '请启动本机 SSH Agent 并加载私钥，或在主机设置中改用私钥文件或密码连接。', severity: 'warning' },
  { code: 'ssh-credentials', pattern: /SSH password is required|Private key path is required|All configured authentication methods failed|Authentication failed|Cannot parse privateKey|Invalid private key|Encrypted private/iu,
    title: 'SSH 身份验证未通过', description: '请打开主机的“编辑主机”，核对账户、认证方式和凭据，再重新连接。', severity: 'warning' },
  { code: 'ssh-test-expired', pattern: /Host connection test confirmation expired/iu,
    title: '本次测试确认已失效', description: '连接配置已变化或确认已超时，请点击“测试连接”重新核对。', severity: 'warning' },
  { code: 'ssh-fingerprint-expired', pattern: /Fingerprint is no longer pending/iu,
    title: '主机指纹确认已失效', description: '连接状态已变化。请重新连接主机，核对这次连接显示的指纹后再继续。', severity: 'warning' },
  { code: 'ssh-fingerprint', pattern: /Verify SSH host key|Host key verification failed|host key mismatch|主机指纹发生变化/iu,
    title: '请核对服务器身份', description: '服务器身份尚未确认或指纹发生变化。请通过可信渠道核对主机指纹，再重新连接。', severity: 'warning' },
  { code: 'input-expired', pattern: /Input request expired|Input bridge authorization expired/iu,
    title: '这次输入请求已失效', description: '认证阶段或终端状态已经变化。请等待新的输入请求，或接管终端检查；不要将密码粘贴到普通终端。', severity: 'warning' },
  { code: 'approval-expired', pattern: /Approval expired|authorization expired|authorization revoked|批准已失效/iu,
    title: '这次授权已失效', description: '操作内容、策略或终端控制权发生了变化。请查看最新操作并重新审核后再继续。', severity: 'warning' },
  { code: 'human-control', pattern: /Return terminal control to the Agent|not a human-controlled Agent session|taken over/iu,
    title: '请先确认终端控制权', description: '终端控制状态已经变化。请在终端顶部查看当前状态，需要继续 AI 时手动交还终端。', severity: 'warning' },
  { code: 'disconnected', pattern: /Host is not connected|Not connected|ECONNRESET|EPIPE|Connection (?:lost|closed)|Terminal not found|disconnected/iu,
    title: 'SSH 连接已断开', description: '请从左侧重新连接主机。已启动的远端命令可能仍在运行，继续前需要核验结果。', severity: 'warning' },
  { code: 'connection-refused', pattern: /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|Connection refused/iu,
    title: '暂时无法建立连接', description: '请检查网络、目标地址和端口是否正确，以及目标服务是否正在运行，再重新连接。', severity: 'error' },
  { code: 'timeout', pattern: /ETIMEDOUT|ESOCKETTIMEDOUT|Timed out|timeout|连接超时/iu,
    title: '连接等待超时', description: '对方没有及时响应。请检查网络和服务状态；若已发出远端命令，先核验结果再重试。', severity: 'warning' },
  { code: 'permission', pattern: /Permission denied|EACCES|EPERM|Access denied/iu,
    title: '当前账户没有足够权限', description: '请核对当前账户以及目标文件或服务的访问权限，再决定是否继续。', severity: 'warning' },
  { code: 'credential-storage', pattern: /OS credential (?:encryption|decryption) is unavailable/iu,
    title: '系统凭据存储暂不可用', description: 'CloudHelm 暂时无法安全保存或读取凭据。请确认系统钥匙串或凭据存储已解锁，再试一次。', severity: 'error' },
  { code: 'host-settings', pattern: /Invalid host settings|Invalid safety settings|Choose an existing direct SSH host|Choose an active direct host|Only one jump host is supported/iu,
    title: '请检查主机设置', description: '请核对地址、端口、账户和保护路径。使用跳板机时，只能选择一台可直接连接的主机。', severity: 'warning' },
  { code: 'runtime-unavailable', pattern: /AI 运行进程已停止|Task runtime is unavailable|对话尚未恢复|请先恢复对话/iu,
    title: 'AI 对话暂时无法继续', description: '请尝试恢复对话；如果仍无法继续，请重新打开 CloudHelm。恢复后会先核验远端状态。', severity: 'warning' },
  { code: 'context-limit', pattern: /超出所选模型的上下文窗口|占满上下文窗口|无法安全整理/iu,
    title: '这次对话需要整理', description: '当前内容无法安全放入所选模型的上下文。请缩短输入、减少附件，或切换到上下文更大的模型后再试。', severity: 'warning' },
  { code: 'request-limit', pattern: /Conversation request budget reached/iu,
    title: '本次对话已达到请求上限', description: '请查看已经完成的结果，再决定是否继续处理剩余工作。', severity: 'warning' },
  { code: 'read-only-history', pattern: /旧的多主机对话仅供查看/iu,
    title: '这段历史对话仅供查看', description: '请选择目标主机，在右侧开始新的单主机对话；原有记录会保留。', severity: 'warning' },
  { code: 'missing-record', pattern: /Host not found|Task not found|Unknown host|Unknown conversation/iu,
    title: '这条记录已不可用', description: '当前主机或对话状态已变化。请从左侧重新选择，再进行操作。', severity: 'warning' },
  { code: 'busy', pattern: /Operation is already in progress|Task is already active|AI 正在暂停/iu,
    title: '操作仍在处理中', description: '请等待当前操作完成，查看最新状态后再继续。', severity: 'warning' }
];

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error';
}

export function unwrapError(error: unknown): string {
  let message = errorMessage(error).trim().slice(0, 32_000);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const next = message.replace(/^Error invoking remote method ['"][^'"\r\n]+['"]:\s*/u, '')
      .replace(/^(?:Error|TypeError|RangeError):\s*/u, '').trim();
    if (next === message) break;
    message = next;
  }
  return message;
}

export function presentError(error: unknown): ErrorPresentation {
  const message = unwrapError(error);
  const rule = rules.find((candidate) => candidate.pattern.test(message));
  const code = rule?.code ?? 'unexpected';
  // Capture only the recognised phrase. Never append the original suffix, response
  // body, URL, stack, input or headers: any of them may contain a secret.
  const diagnostic = rule?.pattern.exec(message)?.[0];
  return {
    code, title: rule?.title ?? '这次操作没有完成',
    description: rule?.description ?? 'CloudHelm 遇到了暂时无法识别的问题。请保留当前现场，检查连接状态；涉及远端命令时，先核验结果再重试。',
    severity: rule?.severity ?? 'error', action: rule?.action,
    details: `错误类型：${code}${diagnostic ? `\n识别到的原因：${diagnostic}` : ''}\n为保护凭据，未显示未经识别的原始返回内容。`
  };
}

/** Success callbacks must not erase another operation's pending error. */
export function inlineError(error: unknown): string {
  const value = presentError(error);
  return `${value.title}。${value.description}`;
}
