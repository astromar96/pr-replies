'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Load server/ui/app/util.js in a sandbox with the minimal browser globals it
// touches at load time, then exercise the pure PRR helpers. util.js attaches to
// a pre-existing PRR namespace (created by h.js in the browser), so seed it.
function loadPRR() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'server', 'ui', 'app', 'util.js'), 'utf8');
  const sandbox = {
    PRR: {},
    document: { addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    Date,
    Math,
    fetch: () => {},
    EventSource: function () {},
    CSS: { escape: (s) => s },
    setTimeout,
    clearTimeout,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.PRR;
}

const PRR = loadPRR();

test('markdown escapes raw HTML', () => {
  const out = PRR.renderMarkdown('<img src=x onerror=alert(1)>');
  assert.match(out, /&lt;img/);
  assert.doesNotMatch(out, /<img/);
});

test('markdown neutralizes javascript: links', () => {
  const out = PRR.renderMarkdown('[click](javascript:alert(1))');
  // Only http(s) links become anchors; a javascript: URL stays inert text.
  assert.doesNotMatch(out, /<a /);
  assert.doesNotMatch(out, /href=/);
});

test('markdown renders http links with rel=noopener', () => {
  const out = PRR.renderMarkdown('[site](https://example.com)');
  assert.match(out, /<a href="https:\/\/example\.com" target="_blank" rel="noopener">site<\/a>/);
});

test('markdown is not corrupted by $& and $\' replacement patterns', () => {
  // Escape-first means the literal dollars survive and the following char is
  // HTML-escaped — no regex replacement-string expansion duplicates content.
  const out = PRR.renderMarkdown("a $& b $' c");
  assert.equal((out.match(/\$/g) || []).length, 2);
  assert.match(out, /a \$&amp; b \$&#39; c/);
});

test('fenced code blocks stay escaped', () => {
  const out = PRR.renderMarkdown('```\n<script>alert(1)</script>\n```');
  assert.match(out, /<pre><code>/);
  assert.match(out, /&lt;script&gt;/);
  assert.doesNotMatch(out, /<script>/);
});

test('inline code, bold, italic', () => {
  assert.match(PRR.renderMarkdown('use `x` here'), /<code>x<\/code>/);
  assert.match(PRR.renderMarkdown('**bold**'), /<b>bold<\/b>/);
  assert.match(PRR.renderMarkdown('an *italic* word'), /<i>italic<\/i>/);
});

test('blockquote and lists', () => {
  assert.match(PRR.renderMarkdown('> quoted'), /<blockquote>quoted<\/blockquote>/);
  const ul = PRR.renderMarkdown('- a\n- b');
  assert.match(ul, /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  const ol = PRR.renderMarkdown('1. one\n2. two');
  assert.match(ol, /<ol><li>one<\/li><li>two<\/li><\/ol>/);
});

test('paragraph split and single-newline break', () => {
  const out = PRR.renderMarkdown('line one\nline two\n\nsecond para');
  assert.match(out, /line one<br>line two/);
  assert.equal((out.match(/<p>/g) || []).length, 2);
});

test('renderDiff classifies and escapes', () => {
  const out = PRR.renderDiff('@@ -1 +1 @@\n+added <tag>\n-removed\n unchanged');
  assert.match(out, /<span class="hd">@@/);
  assert.match(out, /<span class="add">\+added &lt;tag&gt;/);
  assert.match(out, /<span class="del">-removed/);
});
