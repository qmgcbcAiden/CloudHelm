export interface SudoCachePolicy {
  mode: 'disabled' | 'single-password-auto';
  revision: number;
}

/** Legacy string replies never opt a credential into caching. */
export type PrivateInputAnswer = string | null
  | { action: 'submit'; value: string; cacheAsPassword?: boolean }
  | { action: 'cancel' };

export function isPrivateInputAnswer(value: unknown): value is PrivateInputAnswer {
  if (value === null || typeof value === 'string') return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const answer = value as Record<string, unknown>;
  return answer.action === 'cancel' ? Object.keys(answer).length === 1
    : answer.action === 'submit' && typeof answer.value === 'string'
      && (answer.cacheAsPassword === undefined || typeof answer.cacheAsPassword === 'boolean')
      && Object.keys(answer).every((key) => ['action', 'value', 'cacheAsPassword'].includes(key));
}
