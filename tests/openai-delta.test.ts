import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { processOpenAIChunks, type OpenAIChunk } from '../src/llm/openai-compat.js';
import type { StreamEvent } from '../src/llm/types.js';

async function collect(chunks: OpenAIChunk[]): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  let n = 0;
  for await (const ev of processOpenAIChunks(chunks, () => `gen_${++n}`)) out.push(ev);
  return out;
}

describe('processOpenAIChunks', () => {
  it('assembles a tool call streamed across many deltas', async () => {
    const events = await collect([
      { choices: [{ delta: { role: 'assistant', content: '' } as never }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'read_file', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th": "src' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '/a.ts"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 120, completion_tokens: 20 } },
    ]);
    const calls = events.filter((e) => e.type === 'tool_call');
    assert.equal(calls.length, 1);
    const call = (calls[0] as Extract<StreamEvent, { type: 'tool_call' }>).call;
    assert.equal(call.id, 'call_abc');
    assert.equal(call.name, 'read_file');
    assert.deepEqual(call.arguments, { path: 'src/a.ts' });
    const usage = events.find((e) => e.type === 'usage') as Extract<StreamEvent, { type: 'usage' }>;
    assert.equal(usage.usage.promptTokens, 120);
    const done = events.at(-1) as Extract<StreamEvent, { type: 'done' }>;
    assert.equal(done.finishReason, 'tool_calls');
  });

  it('handles two parallel tool calls by index', async () => {
    const events = await collect([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'x', arguments: '{}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'y', arguments: '{"k":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '1}' } }] } }] },
    ]);
    const calls = events.filter((e) => e.type === 'tool_call') as Extract<StreamEvent, { type: 'tool_call' }>[];
    assert.deepEqual(
      calls.map((c) => c.call.name),
      ['x', 'y'],
    );
    assert.deepEqual(calls[1].call.arguments, { k: 1 });
  });

  it('emits text deltas and reasoning separately', async () => {
    const events = await collect([
      { choices: [{ delta: { reasoning_content: 'hmm' } }] },
      { choices: [{ delta: { content: 'Hello' } }] },
      { choices: [{ delta: { content: ' world' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
    assert.deepEqual(
      events.map((e) => e.type),
      ['thinking_delta', 'text_delta', 'text_delta', 'done'],
    );
  });

  it('generates an id when the server omits it and repairs broken argument JSON', async () => {
    const events = await collect([{ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'shell', arguments: "{'command': 'ls',}" } }] } }] }]);
    const call = (events[0] as Extract<StreamEvent, { type: 'tool_call' }>).call;
    assert.equal(call.id, 'gen_1');
    assert.deepEqual(call.arguments, { command: 'ls' });
  });

  it('throws on server error chunks', async () => {
    await assert.rejects(() => collect([{ error: { message: 'model not loaded' } }]), /model not loaded/);
  });
});
