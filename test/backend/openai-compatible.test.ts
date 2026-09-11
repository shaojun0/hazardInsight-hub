import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAICompatibleProvider } from '../../server/providers/openai-compatible.js';

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('OpenAICompatibleProvider retries a 200 response with empty assistant content', async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return response({
        choices: [{ message: { content: '', reasoning_content: 'hidden reasoning' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      });
    }
    return response({
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const provider = new OpenAICompatibleProvider({
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'test-key',
    model: 'test-model',
    maxRetries: 1,
  });
  const result = await provider.chat('system', 'user');

  assert.equal(calls, 2);
  assert.equal(result.text, '{"ok":true}');
  assert.equal(result.attempts, 2);
});

test('OpenAICompatibleProvider normalizes segmented visible content', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response({
    choices: [{
      message: {
        content: [
          { type: 'text', text: '{"ok":' },
          { type: 'text', text: { value: 'true}' } },
        ],
        reasoning_content: 'must not be returned',
      },
      finish_reason: 'stop',
    }],
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  const provider = new OpenAICompatibleProvider({
    baseUrl: 'https://example.invalid/v1/chat/completions',
    apiKey: 'test-key',
    model: 'test-model',
    maxRetries: 0,
  });
  const result = await provider.chat('system', 'user');

  assert.equal(result.text, '{"ok":true}');
});

test('OpenAICompatibleProvider reports safe diagnostics after empty-response retries are exhausted', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response({
    choices: [{ message: { content: null, reasoning_content: 'private' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 10, completion_tokens: 8000, total_tokens: 8010 },
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  const provider = new OpenAICompatibleProvider({
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'test-key',
    model: 'test-model',
    maxRetries: 0,
  });

  await assert.rejects(
    provider.chat('system', 'user'),
    /finish_reason=length, reasoning_content=present, completion_tokens=8000/
  );
});

test('OpenAICompatibleProvider streams only visible content and ignores reasoning_content', async (t) => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"private"},"finish_reason":null}],"usage":null}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"公开"},"finish_reason":null}],"usage":null}\n'));
      controller.enqueue(encoder.encode('\ndata: {"choices":[{"delta":{"content":"摘要"},"finish_reason":"stop"}],"usage":null}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}\n\ndata: [DONE]\n\n'));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
  t.after(() => { globalThis.fetch = originalFetch; });

  const deltas: string[] = [];
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'https://example.invalid/v1', apiKey: 'test-key', model: 'test-model', maxRetries: 0,
  });
  const result = await provider.chatStream('system', 'user', { onTextDelta: (delta) => deltas.push(delta) });

  assert.deepEqual(deltas, ['公开', '摘要']);
  assert.equal(result.text, '公开摘要');
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.usage?.totalTokens, 16);
  assert.equal(JSON.stringify(deltas).includes('private'), false);
});

test('OpenAICompatibleProvider does not retry after a visible stream delta', async (t) => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    let reads = 0;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ === 0) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"部分"},"finish_reason":null}]}\n\n'));
        } else {
          controller.error(new Error('network interrupted'));
        }
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const deltas: string[] = [];
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'https://example.invalid/v1', apiKey: 'test-key', model: 'test-model', maxRetries: 2,
  });
  await assert.rejects(provider.chatStream('system', 'user', { onTextDelta: (delta) => deltas.push(delta) }), /network interrupted/);
  assert.equal(calls, 1);
  assert.deepEqual(deltas, ['部分']);
});
