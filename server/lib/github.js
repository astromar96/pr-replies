'use strict';

/**
 * Back-compat shim. The GitHub provider moved to ./providers/github as part of
 * the multi-provider refactor; this keeps `require('./github')` working for
 * existing callers and tests. New code should use ./providers (createProvider).
 */

const { createGithubProvider, ghExec, isRetryable } = require('./providers/github');

module.exports = { createGithub: createGithubProvider, ghExec, isRetryable };
