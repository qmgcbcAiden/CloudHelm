import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

interface FixtureMessage { role: string; content?: string | Array<{ type: string; text?: string }>; tool_call_id?: string }
export interface FixtureRequest {
  model: string;
  authorization: string;
  review: boolean;
  messages: FixtureMessage[];
  stream: boolean;
}
export type FixtureResponse = { text: string } | { calls: Array<{ id: string; name: string; arguments: unknown }> };

export function fixtureMessageText(message: FixtureMessage): string {
  return typeof message.content === 'string' ? message.content
    : (message.content ?? []).map((part) => part.text ?? '').join('');
}

/** A loopback-only provider fixture; exercises Pi's real HTTP/SSE serialization. */
export async function openAiFixture(reply: (request: FixtureRequest) => Promise<FixtureResponse>) {
  const requests: FixtureRequest[] = [];
  const errors: string[] = [];
  const server = createServer((incoming, response) => {
    void handle(incoming, response).catch((error: unknown) => {
      errors.push(error instanceof Error ? error.message : String(error));
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Local test fixture rejected the request', type: 'fixture_error' } }));
    });
  });

  async function handle(incoming: IncomingMessage, response: ServerResponse): Promise<void> {
    if (incoming.method !== 'POST' || incoming.url !== '/v1/chat/completions') throw new Error(`Unexpected route: ${incoming.url}`);
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Pick<FixtureRequest, 'model' | 'messages' | 'stream'>;
    const request = { ...body, authorization: incoming.headers.authorization ?? '', review: body.messages.some((message) =>
      ['system', 'developer'].includes(message.role) && fixtureMessageText(message).includes('independent security reviewer')) };
    requests.push(request);
    const result = await reply(request);
    if (!request.stream) throw new Error('Expected a real streaming Pi request');
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const id = `fixture-${requests.length}`;
    const chunk = (delta: unknown, finish_reason: string | null = null) => ({
      id, object: 'chat.completion.chunk', created: 1, model: request.model,
      choices: [{ index: 0, delta, finish_reason }]
    });
    const send = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
    send(chunk({ role: 'assistant', content: '' }));
    if ('text' in result) send(chunk({ content: result.text }));
    else for (const [index, call] of result.calls.entries()) {
      send(chunk({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }] }));
      const argumentsJson = JSON.stringify(call.arguments);
      const midpoint = Math.floor(argumentsJson.length / 2);
      // Split tool arguments so the actual Pi incremental parser is exercised too.
      for (const fragment of [argumentsJson.slice(0, midpoint), argumentsJson.slice(midpoint)]) {
        send(chunk({ tool_calls: [{ index, function: { arguments: fragment } }] }));
      }
    }
    send(chunk({}, 'text' in result ? 'stop' : 'tool_calls'));
    response.end('data: [DONE]\n\n');
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests, errors,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}
