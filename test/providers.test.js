'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProvider, isProviderName, PROVIDERS } = require('../server/lib/providers');

test('factory: known names build the matching provider', () => {
  assert.equal(createProvider('github').name, 'github');
  assert.equal(createProvider('gitlab').name, 'gitlab');
});

test('factory: an unknown or missing name falls back to GitHub', () => {
  assert.equal(createProvider('bitbucket').name, 'github');
  assert.equal(createProvider(undefined).name, 'github');
  assert.equal(createProvider(null).name, 'github');
});

test('isProviderName: only the registered names are valid', () => {
  assert.equal(isProviderName('github'), true);
  assert.equal(isProviderName('gitlab'), true);
  assert.equal(isProviderName('bitbucket'), false);
  assert.equal(isProviderName(''), false);
  assert.deepEqual(Object.keys(PROVIDERS).sort(), ['github', 'gitlab']);
});

test('every provider exposes the canonical write interface', () => {
  for (const name of Object.keys(PROVIDERS)) {
    const p = createProvider(name);
    for (const m of ['postReviewReply', 'postIssueComment', 'resolveThread']) {
      assert.equal(typeof p[m], 'function', `${name}.${m}`);
    }
  }
});
