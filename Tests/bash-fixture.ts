import { existsSync } from 'node:fs';
import path from 'node:path';

/** Run the reviewed Bash source on each desktop CI host; Linux behavior is also
 * exercised through the actual remote component in the isolated SSH matrix. */
export function fixtureBash(): string {
  const executable = process.platform === 'win32'
    ? path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : '/bin/bash';
  if (!existsSync(executable)) throw new Error(`Bash is required for the shell regression fixture: ${executable}`);
  return executable;
}
