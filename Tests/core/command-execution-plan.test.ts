import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { BashAnalyzer } from '../../packages/adapters/src/bash-analyzer.js';
import { buildCommandExecutionPlan, commandExecutionIdentities } from '../../packages/core/src/command-execution-plan.js';
import { sanitizeAuthenticationPrompt } from '../../packages/core/src/authentication-prompt.js';
import { isPrivateInputAnswer as coreAnswer } from '../../packages/core/src/remote-runtime.js';
import { isPrivateInputAnswer as contractAnswer } from '../../packages/contracts/src/private-input.js';
import { fixtureBash } from '../bash-fixture.js';

const analyzer = new BashAnalyzer();
describe('reviewed final command launch plans', () => {
  it('retains ordinary Bash builtins and pipeline semantics in one explicit Bash process', async () => {
    const command = "readonly value='hello'; printf '%s\\n' \"$value\" | tr a-z A-Z";
    const plan = buildCommandExecutionPlan(await analyzer.analyze(command), 'deploy');
    const [step] = plan.steps;
    expect(plan.steps).toHaveLength(1);
    expect(step).toMatchObject({ runAs: 'deploy', authentication: 'none' });
    expect(step!.argv[0]).toBe('/bin/bash');
    expect(execFileSync(fixtureBash(), step!.argv.slice(1), { encoding: 'utf8' })).toBe('HELLO\n');
  });
  it('binds actual mixed identities and final sudo arguments before approval', async () => {
    const plan = buildCommandExecutionPlan(await analyzer.analyze("sudo id && printf '%s\\n' '$HOME'; /usr/bin/sudo -u postgres -- id"), 'deploy');
    expect(commandExecutionIdentities(plan)).toEqual(['root', 'deploy', 'postgres']);
    expect(plan.steps[0]).toEqual({ condition: 'always', argv: ['sudo', '-A', 'id'], runAs: 'root', authentication: 'sudo' });
    expect(plan.steps[2]).toMatchObject({ argv: ['/usr/bin/sudo', '-A', '-u', 'postgres', '--', 'id'], runAs: 'postgres' });
    const ordinary = plan.steps[1]!;
    expect(ordinary.condition).toBe('success');
    expect(ordinary.argv[0]).toBe('/bin/bash');
    expect(execFileSync(fixtureBash(), ordinary.argv.slice(1), { encoding: 'utf8' })).toBe('$HOME\n');
  });
  it.each(['sudo cat /etc/shadow | head', 'sudo echo "$HOME"', 'sudo sh -c "id"; su root', 'sudo -S id', 'su root', 'sudo id > /tmp/result'])(
    'rejects unsupported authentication form before dispatch: %s', async (command) => {
      const analysis = await analyzer.analyze(command);
      expect(() => buildCommandExecutionPlan(analysis, 'deploy')).toThrow();
    }
  );
  it.each(['cd /tmp; sudo pwd', 'umask 077; sudo touch /tmp/fixture', 'exec true; sudo id', 'exit 0; sudo id', 'export KEY=value; sudo id'])(
    'refuses to silently change shell state or control-flow semantics: %s', async (command) => {
      const analysis = await analyzer.analyze(command);
      expect(() => buildCommandExecutionPlan(analysis, 'deploy')).toThrow();
    }
  );
});

it('sanitizes controls for display without collapsing changes beyond the display limit', () => {
  expect(sanitizeAuthenticationPrompt('\u001b[31mPassword\u001b[0m\u202e:\n')).toBe('Password :');
  expect(sanitizeAuthenticationPrompt('a'.repeat(300) + 'password')).not.toBe(sanitizeAuthenticationPrompt('a'.repeat(300) + 'OTP'));
});

it.each([coreAnswer, contractAnswer])('validates private IPC answers without accepting unknown fields', (validate) => {
  for (const value of ['fixture', null, { action: 'cancel' }, { action: 'submit', value: 'fixture', cacheAsPassword: true }]) expect(validate(value)).toBe(true);
  for (const value of [undefined, [], 1, { action: 'submit', value: 1 }, { action: 'submit', value: 'x', cacheAsPassword: 'yes' },
    { action: 'cancel', value: 'x' }, { action: 'submit', value: 'x', recipient: 'other-operation' }]) expect(validate(value)).toBe(false);
});
