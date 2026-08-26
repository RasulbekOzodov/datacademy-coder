import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyEdit, closestMatch } from '../src/tools/edit-file.js';

const FILE = ['function a() {', '  return 1;', '}', '', 'function b() {', '  return 2;', '}', ''].join('\n');

describe('applyEdit', () => {
  it('replaces an exact unique match', () => {
    const r = applyEdit(FILE, '  return 1;', '  return 10;');
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.level, 'exact');
      assert.equal(r.line, 2);
      assert.ok(r.content.includes('return 10;'));
    }
  });

  it('rejects ambiguous matches with line numbers', () => {
    const r = applyEdit(FILE, '}', '};');
    assert.ok(!r.ok);
    if (!r.ok) assert.match(r.error, /matches 2 times \(lines 3, 7\)/);
  });

  it('replace_all replaces every occurrence', () => {
    const r = applyEdit(FILE, 'return', 'yield', true);
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.replacements, 2);
      assert.ok(!r.content.includes('return'));
    }
  });

  it('normalizes CRLF in old/new', () => {
    const r = applyEdit(FILE, 'function b() {\r\n  return 2;', 'function b() {\r\n  return 20;');
    assert.ok(r.ok);
    if (r.ok) assert.ok(r.content.includes('return 20;'));
  });

  it('matches ignoring trailing whitespace', () => {
    const r = applyEdit(FILE, 'function b() {   \n  return 2;  ', 'function b() {\n  return 3;');
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.level, 'trailing-ws');
      assert.ok(r.content.includes('return 3;'));
    }
  });

  it('matches ignoring indentation and re-indents the replacement', () => {
    const r = applyEdit(FILE, 'function b() {\nreturn 2;\n}', 'function b() {\nreturn 2 + 1;\n}');
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.level, 'indent');
      assert.ok(r.content.includes('function b() {\n  return 2 + 1;\n}'), r.content);
    }
  });

  it('re-indents multi-line replacements by the indentation delta', () => {
    const file = '    if (x) {\n        doIt();\n    }\n';
    const r = applyEdit(file, 'if (x) {\n    doIt();\n}', 'if (x) {\n    doIt();\n    done();\n}');
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.content, '    if (x) {\n        doIt();\n        done();\n    }\n');
  });

  it('reports the closest match when nothing matches', () => {
    const r = applyEdit(FILE, '  return 42;', '  return 43;');
    assert.ok(!r.ok);
    if (!r.ok) {
      assert.match(r.error, /not found/);
      assert.match(r.error, /Closest match/);
    }
  });

  it('rejects empty old and identical old/new', () => {
    assert.ok(!applyEdit(FILE, '', 'x').ok);
    assert.ok(!applyEdit(FILE, 'return 1;', 'return 1;').ok);
  });
});

describe('closestMatch', () => {
  it('finds the most similar window', () => {
    const m = closestMatch(FILE, '  return 22;');
    assert.ok(m);
    assert.ok([2, 6].includes(m!.startLine));
  });
});
