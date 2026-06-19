'use strict';

/**
 * Provider factory. `createProvider(name, opts)` returns a backend exposing the
 * canonical interface (postReviewReply / postIssueComment / resolveThread, plus
 * the read ops). An unknown name falls back to GitHub so a missing/legacy
 * `provider` field always behaves as it did before multi-provider support.
 */

const { createGithubProvider } = require('./github');
const { createGitlabProvider } = require('./gitlab');

const PROVIDERS = { github: createGithubProvider, gitlab: createGitlabProvider };

function isProviderName(name) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, name);
}

function createProvider(name, opts) {
  const make = PROVIDERS[name] || PROVIDERS.github;
  return make(opts);
}

module.exports = { createProvider, isProviderName, PROVIDERS };
