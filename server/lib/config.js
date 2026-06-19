/**
 * User config: ~/.config/pr-replies/config.json.
 *
 * loadConfig never throws and always returns a complete config — bad values
 * fall back to DEFAULTS with a human-readable warning per problem.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONFIG_PATH = path.join(os.homedir(), '.config', 'pr-replies', 'config.json');

const DEFAULTS = {
  signature: '',
  defaultTriageAction: null,
  autoResolveFixedThreads: true,
  sessionTimeoutMins: 120,
  waitTimeoutSecs: 540,
  historyMax: 200,
  theme: 'system',
  // Display name of the coding agent driving the session (e.g. "Codex",
  // "Claude"). null → the UI falls back to the neutral "the agent".
  agentLabel: null,
};

const TRIAGE_ACTIONS = [null, 'fix', 'reply', 'skip'];
const THEMES = ['light', 'dark', 'system'];
const MAX_SIGNATURE_CHARS = 500;
const MAX_AGENT_LABEL_CHARS = 40;
const MAX_SESSION_TIMEOUT_MINS = 1440;
// 3540s = 59 min: stays under typical 1h tool-call ceilings.
const MAX_WAIT_TIMEOUT_SECS = 3540;
const MAX_HISTORY = 2000;

function timeoutValue(key, value, max, warnings) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    warnings.push(`config: ${key} must be a positive number; using default ${DEFAULTS[key]}`);
    return DEFAULTS[key];
  }
  if (value > max) {
    warnings.push(`config: ${key} capped at ${max} (was ${value})`);
    return max;
  }
  return value;
}

function loadConfig({ configPath = CONFIG_PATH } = {}) {
  const config = { ...DEFAULTS };
  const warnings = [];

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') warnings.push(`config: cannot read ${configPath}: ${e.message}`);
    return { config, warnings };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    warnings.push(`config: invalid JSON in ${configPath}: ${e.message}`);
    return { config, warnings };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnings.push(`config: expected a JSON object in ${configPath}`);
    return { config, warnings };
  }

  for (const [key, value] of Object.entries(parsed)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
      warnings.push(`config: unknown key "${key}" ignored`);
      continue;
    }
    switch (key) {
      case 'signature':
        if (typeof value !== 'string') {
          warnings.push('config: signature must be a string; using default');
        } else if (value.length > MAX_SIGNATURE_CHARS) {
          warnings.push(`config: signature exceeds ${MAX_SIGNATURE_CHARS} characters; using default`);
        } else {
          config.signature = value;
        }
        break;
      case 'defaultTriageAction':
        if (!TRIAGE_ACTIONS.includes(value)) {
          warnings.push('config: defaultTriageAction must be null, "fix", "reply", or "skip"; using default');
        } else {
          config.defaultTriageAction = value;
        }
        break;
      case 'autoResolveFixedThreads':
        if (typeof value !== 'boolean') {
          warnings.push('config: autoResolveFixedThreads must be a boolean; using default');
        } else {
          config.autoResolveFixedThreads = value;
        }
        break;
      case 'sessionTimeoutMins':
        config.sessionTimeoutMins = timeoutValue(key, value, MAX_SESSION_TIMEOUT_MINS, warnings);
        break;
      case 'waitTimeoutSecs':
        config.waitTimeoutSecs = timeoutValue(key, value, MAX_WAIT_TIMEOUT_SECS, warnings);
        break;
      case 'historyMax':
        config.historyMax = timeoutValue(key, value, MAX_HISTORY, warnings);
        break;
      case 'theme':
        if (!THEMES.includes(value)) {
          warnings.push('config: theme must be "light", "dark", or "system"; using default');
        } else {
          config.theme = value;
        }
        break;
      case 'agentLabel':
        if (value === null) {
          config.agentLabel = null;
        } else if (typeof value !== 'string') {
          warnings.push('config: agentLabel must be a string or null; using default');
        } else if (value.length > MAX_AGENT_LABEL_CHARS) {
          warnings.push(`config: agentLabel exceeds ${MAX_AGENT_LABEL_CHARS} characters; using default`);
        } else {
          const trimmed = value.trim();
          config.agentLabel = trimmed || null;
        }
        break;
    }
  }

  return { config, warnings };
}

module.exports = { loadConfig, CONFIG_PATH, DEFAULTS };
