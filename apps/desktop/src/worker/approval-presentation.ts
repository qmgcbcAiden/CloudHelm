import { redactOutput, type ApprovalRequest } from '@cloudhelm/core';

const reasons: Record<string, string> = {
  'high-impact-command': '可能改变主机访问、服务可用性，或大范围删除数据',
  'high-impact-file': '目标文件涉及主机访问或安全配置',
  'uncertain-command': '无法可靠判断这条命令的实际影响',
  'script-uninspectable': '执行前无法安全读取脚本内容',
  'script-uncertain': '脚本包含无法可靠判断的操作',
  'ai-review-unavailable': '独立审核未完成，需要你判断',
  'ai-review-uncertain': '独立审核无法确定风险，需要你判断',
  'ai-denial-manual-review': '你要求对这条被独立审核拒绝的操作进行一次人工复核'
};

export function approvalPresentation(request: ApprovalRequest): { title: string; explanation: string; recovery: string } {
  const operation = request.operation;
  const label = operation.kind === 'runtime' ? '运行组件操作' : operation.kind === 'command' ? '远程命令' : operation.kind === 'write-file' ? '写入文件'
    : operation.kind === 'delete-path' ? '删除路径' : '上传文件';
  const reason = reasons[request.ruleId] ?? redactOutput(request.reason).slice(0, 240);
  return {
    title: `批准这次${label}`,
    explanation: `AI 请求执行下方的${label}。触发规则 ${request.ruleId}：${reason}。请根据显示的具体操作决定，批准仅适用于这一次。`,
    recovery: operation.kind === 'command' ? '执行后核验实际结果；若结果未知，先确认远端状态。'
      : '结构化文件操作会尝试保留恢复副本；执行后显示副本路径。'
  };
}
