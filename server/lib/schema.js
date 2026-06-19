'use strict';

/**
 * Payload schema v2 validation. Returns an array of path-specific error
 * strings; empty array = valid. No v1 compatibility.
 */

const ACTIONS = ['fix', 'reply'];
const CONFIDENCES = ['high', 'medium', 'low'];
const PROVIDERS = ['github', 'gitlab'];
const TEMPLATE_SCOPES = ['reply', 'guidance', 'both'];
const MAX_TEMPLATES = 200;
const MAX_TEMPLATE_BODY = 8000;

function err(errors, where, msg) {
  errors.push(`${where}: ${msg}`);
}

function checkString(errors, where, val, { optional = false } = {}) {
  if (val == null) {
    if (!optional) err(errors, where, 'missing required string');
    return;
  }
  if (typeof val !== 'string') err(errors, where, `expected string, got ${typeof val}`);
}

function isStringArray(v) { return Array.isArray(v) && v.every((x) => typeof x === 'string'); }

function checkEnum(errors, where, val, allowed, { optional = false } = {}) {
  if (val == null) {
    if (!optional) err(errors, where, `missing; expected one of ${allowed.join('|')}`);
    return;
  }
  if (!allowed.includes(val)) err(errors, where, `expected one of ${allowed.join('|')}, got ${JSON.stringify(val)}`);
}

function checkCommon(errors, payload) {
  if (!payload || typeof payload !== 'object') {
    err(errors, 'payload', 'not an object');
    return false;
  }
  if (payload.version !== 2) err(errors, 'version', `expected 2, got ${JSON.stringify(payload.version)}`);
  if (!payload.repo || typeof payload.repo.nameWithOwner !== 'string') err(errors, 'repo.nameWithOwner', 'missing');
  if (!payload.pr || !Number.isInteger(payload.pr.number)) err(errors, 'pr.number', 'missing or not an integer');
  // provider/host are additive-optional: an absent provider means GitHub, so
  // every pre-existing v2 payload (and GitHub-only callers) validate unchanged.
  checkEnum(errors, 'provider', payload.provider, PROVIDERS, { optional: true });
  if (payload.repo) checkString(errors, 'repo.host', payload.repo.host, { optional: true });
  if (payload.pr) {
    checkString(errors, 'pr.title', payload.pr.title);
    checkString(errors, 'pr.url', payload.pr.url);
  }
  if (!Array.isArray(payload.reviewThreads)) err(errors, 'reviewThreads', 'missing array');
  if (!Array.isArray(payload.issueComments)) err(errors, 'issueComments', 'missing array');
  return errors.length === 0;
}

function checkComments(errors, where, comments) {
  if (!Array.isArray(comments) || comments.length === 0) {
    err(errors, `${where}.comments`, 'missing non-empty array');
    return;
  }
  comments.forEach((c, i) => {
    checkString(errors, `${where}.comments[${i}].author`, c.author);
    checkString(errors, `${where}.comments[${i}].body`, c.body);
  });
}

function checkThreadCore(errors, where, t) {
  checkString(errors, `${where}.id`, t.id);
  checkString(errors, `${where}.path`, t.path);
  if (t.replyToDatabaseId == null) err(errors, `${where}.replyToDatabaseId`, 'missing');
  if (typeof t.isOutdated !== 'boolean') err(errors, `${where}.isOutdated`, 'missing boolean');
  if (typeof t.viewerCanResolve !== 'boolean') err(errors, `${where}.viewerCanResolve`, 'missing boolean');
  checkString(errors, `${where}.assignee`, t.assignee, { optional: true });
  // A free-form classification (e.g. "tests", "error-handling") the agent may
  // tag for the learning loop; persisted into history for `suggest` priors.
  checkString(errors, `${where}.category`, t.category, { optional: true });
  checkComments(errors, where, t.comments);
}

function validateTriagePayload(payload) {
  const errors = [];
  if (!checkCommon(errors, payload)) return errors;
  if (payload.pr.reviewers != null && !Array.isArray(payload.pr.reviewers)) {
    err(errors, 'pr.reviewers', 'expected array');
  }
  if (payload.pr.assignableUsers != null && !isStringArray(payload.pr.assignableUsers)) {
    err(errors, 'pr.assignableUsers', 'expected array of strings');
  }
  payload.reviewThreads.forEach((t, i) => {
    const where = `reviewThreads[${i}]`;
    checkThreadCore(errors, where, t);
    checkEnum(errors, `${where}.suggestedAction`, t.suggestedAction, ACTIONS, { optional: true });
    checkEnum(errors, `${where}.confidence`, t.confidence, CONFIDENCES, { optional: true });
    checkString(errors, `${where}.fixPlan`, t.fixPlan, { optional: true });
    checkString(errors, `${where}.proposedDiff`, t.proposedDiff, { optional: true });
  });
  payload.issueComments.forEach((c, i) => {
    const where = `issueComments[${i}]`;
    if (c.databaseId == null) err(errors, `${where}.databaseId`, 'missing');
    checkString(errors, `${where}.author`, c.author);
    checkString(errors, `${where}.body`, c.body);
    checkEnum(errors, `${where}.suggestedAction`, c.suggestedAction, ACTIONS, { optional: true });
    checkEnum(errors, `${where}.confidence`, c.confidence, CONFIDENCES, { optional: true });
    checkString(errors, `${where}.fixPlan`, c.fixPlan, { optional: true });
    checkString(errors, `${where}.proposedDiff`, c.proposedDiff, { optional: true });
    checkString(errors, `${where}.assignee`, c.assignee, { optional: true });
    checkString(errors, `${where}.category`, c.category, { optional: true });
  });
  return errors;
}

function validateReplyPayload(payload) {
  const errors = [];
  if (!checkCommon(errors, payload)) return errors;
  if (payload.pr.assignableUsers != null && !isStringArray(payload.pr.assignableUsers)) {
    err(errors, 'pr.assignableUsers', 'expected array of strings');
  }
  payload.reviewThreads.forEach((t, i) => {
    const where = `reviewThreads[${i}]`;
    checkThreadCore(errors, where, t);
    checkString(errors, `${where}.draft`, t.draft, { optional: true });
    checkString(errors, `${where}.draftHumanized`, t.draftHumanized, { optional: true });
    checkString(errors, `${where}.fixedIn`, t.fixedIn, { optional: true });
    if (t.resolveDefault != null && typeof t.resolveDefault !== 'boolean') {
      err(errors, `${where}.resolveDefault`, 'expected boolean');
    }
  });
  payload.issueComments.forEach((c, i) => {
    const where = `issueComments[${i}]`;
    if (c.databaseId == null) err(errors, `${where}.databaseId`, 'missing');
    checkString(errors, `${where}.author`, c.author);
    checkString(errors, `${where}.body`, c.body);
    checkString(errors, `${where}.draft`, c.draft, { optional: true });
    checkString(errors, `${where}.draftHumanized`, c.draftHumanized, { optional: true });
    checkString(errors, `${where}.fixedIn`, c.fixedIn, { optional: true });
    checkString(errors, `${where}.assignee`, c.assignee, { optional: true });
  });
  return errors;
}

function validateTemplates(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    err(errors, 'payload', 'not an object');
    return errors;
  }
  if (!Array.isArray(payload.templates)) {
    err(errors, 'templates', 'missing array');
    return errors;
  }
  if (payload.templates.length > MAX_TEMPLATES) err(errors, 'templates', `too many (max ${MAX_TEMPLATES})`);
  const ids = new Set();
  payload.templates.forEach((t, i) => {
    const where = `templates[${i}]`;
    checkString(errors, `${where}.id`, t && t.id);
    checkString(errors, `${where}.name`, t && t.name);
    checkString(errors, `${where}.body`, t && t.body);
    if (t && typeof t.id === 'string') {
      if (ids.has(t.id)) err(errors, `${where}.id`, `duplicate id "${t.id}"`);
      ids.add(t.id);
    }
    if (t && typeof t.body === 'string' && t.body.length > MAX_TEMPLATE_BODY) {
      err(errors, `${where}.body`, `exceeds ${MAX_TEMPLATE_BODY} characters`);
    }
    checkEnum(errors, `${where}.scope`, t && t.scope, TEMPLATE_SCOPES, { optional: true });
    if (t && t.tags != null && !Array.isArray(t.tags)) err(errors, `${where}.tags`, 'expected array');
  });
  return errors;
}

module.exports = { validateTriagePayload, validateReplyPayload, validateTemplates };
