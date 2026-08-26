import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolCallGate, normalizeCallObject, parseToolCalls } from '../src/llm/tool-parser.js';

const ids = () => {
  let n = 0;
  return () => `c${++n}`;
};

describe('parseToolCalls', () => {
  it('parses a clean Hermes-style block', () => {
    const r = parseToolCalls('<tool_call>\n{"name": "read_file", "arguments": {"path": "src/a.ts"}}\n</tool_call>', ids());
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].name, 'read_file');
    assert.deepEqual(r.calls[0].arguments, { path: 'src/a.ts' });
    assert.equal(r.text, '');
    assert.equal(r.errors.length, 0);
  });

  it('keeps surrounding prose as text and ignores trailing chatter', () => {
    const r = parseToolCalls('Let me look at the file.\n<tool_call>\n{"name":"read_file","arguments":{"path":"a.ts"}}\n</tool_call>\nThe file probably contains...', ids());
    assert.equal(r.calls.length, 1);
    assert.equal(r.text.replace(/\n+/g, '\n'), 'Let me look at the file.\nThe file probably contains...');
  });

  it('handles a missing closing tag (stop sequence ate it)', () => {
    const r = parseToolCalls('<tool_call>\n{"name":"list_dir","arguments":{"path":"."}}', ids());
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].name, 'list_dir');
  });

  it('parses JSON wrapped in a fence inside the block', () => {
    const r = parseToolCalls('<tool_call>\n```json\n{"name":"glob","arguments":{"pattern":"**/*.py"}}\n```\n</tool_call>', ids());
    assert.equal(r.calls.length, 1);
    assert.deepEqual(r.calls[0].arguments, { pattern: '**/*.py' });
  });

  it('repairs sloppy JSON (trailing comma, single quotes)', () => {
    const r = parseToolCalls("<tool_call>\n{'name': 'grep', 'arguments': {'pattern': 'TODO',}}\n</tool_call>", ids());
    assert.equal(r.calls.length, 1);
    assert.deepEqual(r.calls[0].arguments, { pattern: 'TODO' });
  });

  it('accepts "parameters" and stringified arguments', () => {
    const r1 = parseToolCalls('<tool_call>{"name":"read_file","parameters":{"path":"x"}}</tool_call>', ids());
    assert.deepEqual(r1.calls[0].arguments, { path: 'x' });
    const r2 = parseToolCalls('<tool_call>{"name":"read_file","arguments":"{\\"path\\":\\"y\\"}"}</tool_call>', ids());
    assert.deepEqual(r2.calls[0].arguments, { path: 'y' });
  });

  it('falls back to a ```json fence without tags', () => {
    const r = parseToolCalls('I will run:\n```json\n{"name": "shell", "arguments": {"command": "npm test"}}\n```', ids());
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].name, 'shell');
    assert.equal(r.text, 'I will run:');
  });

  it('falls back to a bare JSON object', () => {
    const r = parseToolCalls('{"name": "list_dir", "arguments": {"path": "src"}}', ids());
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].name, 'list_dir');
  });

  it('strips <think> blocks', () => {
    const r = parseToolCalls('<think>I should read it</think>\n<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>', ids());
    assert.equal(r.calls.length, 1);
    assert.equal(r.text, '');
  });

  it('returns multiple calls in order', () => {
    const r = parseToolCalls('<tool_call>{"name":"a","arguments":{}}</tool_call>\n<tool_call>{"name":"b","arguments":{}}</tool_call>', ids());
    assert.deepEqual(
      r.calls.map((c) => c.name),
      ['a', 'b'],
    );
  });

  it('reports unparseable blocks as errors', () => {
    const r = parseToolCalls('<tool_call>\nthis is not json at all\n</tool_call>', ids());
    assert.equal(r.calls.length, 0);
    assert.equal(r.errors.length, 1);
  });

  it('does not treat ordinary JSON in prose as a tool call', () => {
    const r = parseToolCalls('The config looks like {"name": "app", "version": "1.0"} which is fine.', ids());
    assert.equal(r.calls.length, 0);
  });

  it('plain text yields no calls', () => {
    const r = parseToolCalls('Done! I created the file and ran the tests.', ids());
    assert.equal(r.calls.length, 0);
    assert.equal(r.text, 'Done! I created the file and ran the tests.');
  });
});

describe('normalizeCallObject', () => {
  it('unwraps function-call style objects', () => {
    assert.deepEqual(normalizeCallObject({ function: { name: 'x', arguments: { a: 1 } } }), { name: 'x', arguments: { a: 1 } });
    assert.deepEqual(normalizeCallObject({ tool: 'y', input: { b: 2 } }), { name: 'y', arguments: { b: 2 } });
  });
  it('rejects objects without a name', () => {
    assert.equal(normalizeCallObject({ arguments: {} }), undefined);
  });
});

describe('ToolCallGate', () => {
  it('passes text through and withholds from the tag onward', () => {
    const g = new ToolCallGate();
    assert.equal(g.push('Hello '), 'Hello ');
    assert.equal(g.push('world <tool_call>{"name"'), 'world ');
    assert.equal(g.push(': "x"}'), '');
    assert.equal(g.isClosed, true);
  });
  it('holds back a possible tag prefix at a chunk boundary', () => {
    const g = new ToolCallGate();
    assert.equal(g.push('abc <tool'), 'abc ');
    assert.equal(g.push('_call>'), '');
    assert.equal(g.isClosed, true);
  });
  it('does not hold back text that cannot start the tag', () => {
    const g = new ToolCallGate();
    assert.equal(g.push('a < b'), 'a < b');
    assert.equal(g.flush(), '');
  });
  it('flushes a false-positive prefix at the end', () => {
    const g = new ToolCallGate();
    assert.equal(g.push('a <to'), 'a ');
    assert.equal(g.flush(), '<to');
  });
  it('hides a fenced JSON tool call and everything after it', () => {
    const g = new ToolCallGate();
    let shown = g.push('Sure.\n```json\n{"name": "list_dir", ');
    shown += g.push('"arguments": {"path": "."}}\n```\nThe folder contains...');
    assert.equal(shown, 'Sure.\n');
    assert.equal(g.isClosed, true);
  });
  it('shows a fenced code block that is not a tool call', () => {
    const g = new ToolCallGate();
    let shown = g.push('Example:\n```json\n{"name": "app", ');
    shown += g.push('"version": "1.0"}\n```\nDone.');
    shown += g.flush();
    assert.equal(shown, 'Example:\n```json\n{"name": "app", "version": "1.0"}\n```\nDone.');
  });
  it('hides bare JSON tool calls at line start', () => {
    const g = new ToolCallGate();
    let shown = g.push('{"name": "read_file", "argu');
    shown += g.push('ments": {"path": "a.ts"}}\n{"name": "x", "arguments": {}}');
    shown += g.flush();
    assert.equal(shown, '');
  });
  it('does not leak the fence prefix while waiting for the JSON body', () => {
    const g = new ToolCallGate();
    let shown = g.push('```');
    shown += g.push('json\n');
    shown += g.push('{"name": "list_dir", "arguments": {"path": "."}}\n```');
    assert.equal(shown, '');
    assert.equal(g.isClosed, true);
  });
  it('shows code fences that are not JSON', () => {
    const g = new ToolCallGate();
    let shown = g.push('Here:\n```ts\n');
    shown += g.push('const a = 1;\n```\n');
    shown += g.flush();
    assert.equal(shown, 'Here:\n```ts\nconst a = 1;\n```\n');
  });
  it('shows a bare JSON object that is not a tool call', () => {
    const g = new ToolCallGate();
    let shown = g.push('{"ok": true}\ntext after');
    shown += g.flush();
    assert.equal(shown, '{"ok": true}\ntext after');
  });
});
