import { Type, type Static } from 'typebox';
import { NativeFileArtifactSchema } from './file-transactions.js';
const Id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9][a-zA-Z0-9.:_-]*$' });
const Path = Type.String({ minLength: 1, maxLength: 4096, pattern: '^/[^\\u0000]*$' });
export const RuntimeResourceSchema = Type.Object({ id: Id, taskId: Id, hostId: Id, terminalId: Id,
  terminalGeneration: Type.Integer({ minimum: 1 }), loginAs: Type.String({ minLength: 1, maxLength: 128 }),
  runAs: Type.String({ minLength: 1, maxLength: 128 }), revision: Type.Integer({ minimum: 1 }),
  generation: Type.Integer({ minimum: 0 }), plan: Type.Object({ version: Type.Literal(1),
    action: Type.Union([Type.Literal('install'), Type.Literal('launch'), Type.Literal('su-bootstrap'), Type.Literal('cleanup')]),
    directory: Path, executable: Path, artifact: NativeFileArtifactSchema, sessionId: Id,
    purpose: Type.Union([Type.Literal('execute'), Type.Literal('recover')]), parentOperationId: Type.Optional(Id)
  }, { additionalProperties: false }), state: Type.Union([Type.Literal('prepared'), Type.Literal('ready'), Type.Literal('cleaning'), Type.Literal('unknown'), Type.Literal('closed')]),
  updatedAt: Type.Integer({ minimum: 0 }) }, { additionalProperties: false });
export type RuntimeResourceView = Static<typeof RuntimeResourceSchema>;
export type RuntimeResourceRequest = { runtimeResourceRequest: { id: string; record: RuntimeResourceView } };
export type RuntimeResourceResult = { runtimeResourceResult: { id: string; error?: string } };
