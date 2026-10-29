/** Sanitized remote prompt. Retain its full content for pinning; it never proves credential type. */
export function sanitizeAuthenticationPrompt(prompt: string): string {
  return prompt.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ').trim();
}
