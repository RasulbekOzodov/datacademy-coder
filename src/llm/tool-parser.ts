import { jsonrepair } from 'jsonrepair';
import type { ToolCall } from './types.js';

export interface ParsedToolCalls {
  /** Tool calls found in the text, in order. */
  calls: ToolCall[];
  /** The text with tool-call blocks (and <think> blocks) removed. */
  text: string;
  /** Blocks that looked like tool calls but could not be parsed. */
  errors: string[];
}

export const TOOL_CALL_OPEN = '<tool_call>';
export const TOOL_CALL_CLOSE = '</tool_call>';

const THINK_RE = /<think>[\s\S]*?<\/think>/g;
const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g;
const FENCE_RE = /```(?:json|tool_call|tool)?\s*\n?([\s\S]*?)```/g;

function tryParseJson(raw: string): unknown {
  let s = raw.trim();
  // Strip a fence that may wrap the JSON inside a <tool_call> block.
  s = s.replace(/^```[a-zA-Z_]*\s*\n?/, '').replace(/```\s*$/, '').trim();
  if (!s) throw new Error('empty');
  try {
    return JSON.parse(s);
  } catch {
    return JSON.parse(jsonrepair(s));
  }
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * Accepts the shapes small models produce:
 *   {"name": "x", "arguments": {...}}
 *   {"name": "x", "parameters": {...}} / {"name":"x","args":{...}}
 *   {"tool_call": {...}} / {"function": {"name":..,"arguments":..}} / {"tool": "x", "input": {...}}
 *   {"name":"x","arguments":"{\"path\":\"a\"}"}  (stringified arguments)
 */
export function normalizeCallObject(v: unknown, requireArgs = false): { name: string; arguments: Record<string, unknown> } | undefined {
  let obj = asObject(v);
  if (!obj) return undefined;
  for (const wrapper of ['tool_call', 'function', 'function_call', 'call']) {
    const inner = asObject(obj[wrapper]);
    if (inner && (typeof inner.name === 'string' || typeof inner.tool === 'string')) {
      obj = inner;
      break;
    }
  }
  const name = (obj.name ?? obj.tool ?? obj.tool_name ?? obj.function_name) as unknown;
  if (typeof name !== 'string' || !name.trim()) return undefined;
  const hasArgsKey = ['arguments', 'parameters', 'params', 'args', 'input'].some((k) => k in obj);
  // Outside an explicit <tool_call> block, an object with just a "name" is ordinary JSON, not a call.
  if (requireArgs && !hasArgsKey) return undefined;
  let args: unknown = obj.arguments ?? obj.parameters ?? obj.params ?? obj.args ?? obj.input;
  if (typeof args === 'string') {
    const s = args.trim();
    if (!s) args = {};
    else {
      try {
        args = tryParseJson(s);
      } catch {
        return undefined;
      }
    }
  }
  if (args === undefined || args === null) args = {};
  const argsObj = asObject(args);
  if (!argsObj) return undefined;
  return { name: name.trim(), arguments: argsObj };
}

/** Find balanced top-level {...} objects in text. Returns [start, end) ranges. */
function findBalancedObjects(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '{') {
      i++;
      continue;
    }
    let depth = 0;
    let inStr = false;
    let esc = false;
    let j = i;
    for (; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          out.push([i, j + 1]);
          break;
        }
      }
    }
    i = depth === 0 ? j + 1 : i + 1;
  }
  return out;
}

export function stripThinking(text: string): { text: string; thinking: string } {
  let thinking = '';
  const stripped = text.replace(THINK_RE, (m) => {
    thinking += m.slice(7, -8);
    return '';
  });
  return { text: stripped, thinking };
}

/**
 * Parse tool calls out of raw assistant text.
 * Ladder: <tool_call> blocks -> ```json fences -> bare balanced JSON objects with a tool-call shape.
 */
export function parseToolCalls(raw: string, makeId: () => string = defaultIdGen()): ParsedToolCalls {
  const calls: ToolCall[] = [];
  const errors: string[] = [];
  let { text } = stripThinking(raw);

  // 1. Explicit <tool_call> blocks (Hermes / Qwen format).
  const blocks: Array<{ start: number; end: number; body: string }> = [];
  for (const m of text.matchAll(TOOL_CALL_RE)) {
    blocks.push({ start: m.index!, end: m.index! + m[0].length, body: m[1] });
  }
  if (blocks.length) {
    for (const b of blocks) {
      const body = b.body.trim();
      if (!body) continue;
      try {
        const parsed = normalizeCallObject(tryParseJson(body));
        if (parsed) calls.push({ id: makeId(), ...parsed });
        else errors.push(`Tool call JSON must have "name" and "arguments": ${body.slice(0, 200)}`);
      } catch (err) {
        errors.push(`Invalid JSON inside <tool_call>: ${(err as Error).message}: ${body.slice(0, 200)}`);
      }
    }
    text = removeRanges(
      text,
      blocks.map((b) => [b.start, b.end] as [number, number]),
    );
    return { calls, text: text.trim(), errors };
  }

  // 2. Fenced JSON blocks that look like tool calls.
  const fenceRanges: Array<[number, number]> = [];
  for (const m of text.matchAll(FENCE_RE)) {
    const body = m[1].trim();
    if (!body.startsWith('{')) continue;
    try {
      const parsed = normalizeCallObject(tryParseJson(body), true);
      if (parsed) {
        calls.push({ id: makeId(), ...parsed });
        fenceRanges.push([m.index!, m.index! + m[0].length]);
      }
    } catch {
      /* not a tool call */
    }
  }
  if (calls.length) {
    return { calls, text: removeRanges(text, fenceRanges).trim(), errors };
  }

  // 3. Bare JSON objects with a tool-call shape.
  if (/"(name|tool)"\s*:/.test(text) && /"(arguments|parameters|params|args|input)"\s*:/.test(text)) {
    const ranges: Array<[number, number]> = [];
    for (const [s, e] of findBalancedObjects(text)) {
      const body = text.slice(s, e);
      if (!/"(name|tool)"\s*:/.test(body)) continue;
      try {
        const parsed = normalizeCallObject(tryParseJson(body), true);
        if (parsed) {
          calls.push({ id: makeId(), ...parsed });
          ranges.push([s, e]);
        }
      } catch {
        /* skip */
      }
    }
    if (calls.length) return { calls, text: removeRanges(text, ranges).trim(), errors };
  }

  return { calls, text: text.trim(), errors };
}

function removeRanges(text: string, ranges: Array<[number, number]>): string {
  if (!ranges.length) return text;
  let out = '';
  let pos = 0;
  for (const [s, e] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (s < pos) continue;
    out += text.slice(pos, s);
    pos = e;
  }
  out += text.slice(pos);
  return out;
}

export function defaultIdGen(prefix = 'call'): () => string {
  let n = 0;
  return () => `${prefix}_${Date.now().toString(36)}_${++n}`;
}

/** Serialize a tool call in the text format (used when writing assistant history in text mode). */
export function formatToolCallText(call: ToolCall): string {
  return `${TOOL_CALL_OPEN}\n${JSON.stringify({ name: call.name, arguments: call.arguments })}\n${TOOL_CALL_CLOSE}`;
}

/**
 * Streaming display gate. Text passes through until something that may be a tool call starts:
 *   - `<tool_call` closes the gate immediately (everything after is a call);
 *   - a ``` fence or a `{` at the start of a line is buffered until it completes, then shown only
 *     if it does NOT parse as a tool call (so ordinary JSON/code in answers still renders).
 * Once a tool call is detected, the rest of the stream is withheld.
 */
export class ToolCallGate {
  private pending = '';
  private buffer = '';
  private state: 'pass' | 'buffer' | 'closed' = 'pass';
  private static readonly TAG = '<tool_call';
  private static readonly FENCE = '```';

  /** Returns the portion of the delta that is safe to display. */
  push(delta: string): string {
    if (this.state === 'closed') return '';
    let out = '';
    if (this.state === 'buffer') {
      this.buffer += delta;
      out += this.drainBuffer();
      const after: string = this.state; // drainBuffer mutates state
      if (after !== 'pass') return out;
      delta = '';
    }
    this.pending += delta;
    return out + this.drainPending();
  }

  /** Flush whatever is safe at end of stream. */
  flush(): string {
    if (this.state === 'closed') return '';
    if (this.state === 'buffer') {
      const b = this.buffer;
      this.buffer = '';
      this.state = 'pass';
      return isToolCallText(b) ? '' : b;
    }
    const out = this.pending;
    this.pending = '';
    return out;
  }

  get isClosed(): boolean {
    return this.state === 'closed';
  }

  private drainPending(): string {
    const p = this.pending;
    const tag = p.indexOf(ToolCallGate.TAG);
    const fence = p.indexOf(ToolCallGate.FENCE);
    const brace = lineStartBrace(p);
    const candidates = [tag, fence, brace].filter((i) => i >= 0);
    if (candidates.length) {
      const idx = Math.min(...candidates);
      const out = p.slice(0, idx);
      const rest = p.slice(idx);
      this.pending = '';
      if (idx === tag) {
        this.state = 'closed';
        return out;
      }
      this.state = 'buffer';
      this.buffer = rest;
      return out + this.drainBuffer();
    }
    const keep = Math.max(
      longestSuffixPrefix(p, ToolCallGate.TAG),
      longestSuffixPrefix(p, ToolCallGate.FENCE),
      /\n$/.test(p) ? 1 : 0, // a newline may be followed by "{"
    );
    const out = p.slice(0, p.length - keep);
    this.pending = p.slice(p.length - keep);
    return out;
  }

  /** Called in 'buffer' state. Emits or drops the buffered block once it is complete. */
  private drainBuffer(): string {
    const b = this.buffer;
    if (b.includes(ToolCallGate.TAG)) {
      this.state = 'closed';
      this.buffer = '';
      const before = b.slice(0, b.indexOf(ToolCallGate.TAG));
      return isToolCallText(before) ? '' : before;
    }
    let end = -1;
    if (b.startsWith(ToolCallGate.FENCE)) {
      const close = b.indexOf(ToolCallGate.FENCE, 3);
      if (close >= 0) end = close + 3;
    } else {
      const obj = firstBalancedObjectEnd(b);
      if (obj >= 0) end = obj;
    }
    if (end < 0) {
      // Bail out of buffering if it clearly is not a call: too long, or a fence whose body has
      // started with something other than "{" (e.g. a code sample).
      const fenceBodyStarted = b.startsWith(ToolCallGate.FENCE) && /^```[^\n]*\n\s*[^\s{]/.test(b);
      const fenceNotJsonLang = b.startsWith(ToolCallGate.FENCE) && /^```(?!json|tool_call|tool|\s*$)[a-zA-Z0-9_+-]+/.test(b);
      if (b.length > 4000 || fenceBodyStarted || fenceNotJsonLang) {
        this.buffer = '';
        this.state = 'pass';
        this.pending = '';
        return b;
      }
      return '';
    }
    const block = b.slice(0, end);
    const rest = b.slice(end);
    this.buffer = '';
    if (isToolCallText(block)) {
      this.state = 'closed';
      return '';
    }
    this.state = 'pass';
    this.pending = rest;
    return block + this.drainPending();
  }
}

function isToolCallText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  try {
    return parseToolCalls(t, () => 'x').calls.length > 0;
  } catch {
    return false;
  }
}

function lineStartBrace(s: string): number {
  if (s.startsWith('{')) return 0;
  const i = s.indexOf('\n{');
  return i >= 0 ? i + 1 : -1;
}

function firstBalancedObjectEnd(s: string): number {
  const ranges = findBalancedObjects(s);
  return ranges.length && ranges[0][0] === 0 ? ranges[0][1] : -1;
}

function longestSuffixPrefix(s: string, tag: string): number {
  const max = Math.min(s.length, tag.length - 1);
  for (let len = max; len > 0; len--) {
    if (s.endsWith(tag.slice(0, len))) return len;
  }
  return 0;
}
