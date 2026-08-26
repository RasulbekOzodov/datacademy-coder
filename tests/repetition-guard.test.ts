import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RepetitionGuard } from '../src/agent/loop.js';

describe('RepetitionGuard', () => {
  it('cuts after the same long line repeats consecutively', () => {
    const g = new RepetitionGuard(3, 6);
    const line = '{"name": "read_file", "arguments": {"path": "index.js"}}\n';
    assert.equal(g.push(line), false);
    assert.equal(g.push(line), false);
    assert.equal(g.push(line), true);
  });

  it('cuts when a line recurs many times non-consecutively', () => {
    const g = new RepetitionGuard(3, 4);
    const a = '{"name": "read_file", "arguments": {"path": "index.js"}}\n';
    const b = '{"name": "edit_file", "arguments": {"path": "index.js", "old": "x"}}\n';
    let cut = false;
    for (let i = 0; i < 4 && !cut; i++) {
      cut = g.push(a) || g.push(b);
    }
    assert.equal(cut, true);
  });

  it('ignores short lines and normal prose', () => {
    const g = new RepetitionGuard();
    for (let i = 0; i < 10; i++) assert.equal(g.push('ok\n'), false);
    assert.equal(g.push('Here is a summary of the changes I made to the file:\n'), false);
    assert.equal(g.push('- fixed the add function\n- ran the tests\n'), false);
  });

  it('handles deltas that split lines', () => {
    const g = new RepetitionGuard(2, 10);
    const line = 'this line is long enough to be tracked by the guard';
    assert.equal(g.push(line.slice(0, 10)), false);
    assert.equal(g.push(`${line.slice(10)}\n${line.slice(0, 5)}`), false);
    assert.equal(g.push(`${line.slice(5)}\n`), true);
  });
});
