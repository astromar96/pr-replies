/**
 * Cross-platform "open this URL in the default browser".
 */
'use strict';

const { execFile } = require('node:child_process');

function defaultExec(file, argv) {
  return new Promise((resolve, reject) => {
    execFile(file, argv, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

async function openUrl(url, { platform = process.platform, exec = defaultExec } = {}) {
  // win32: the empty "" is the window title `start` would otherwise eat the
  // quoted URL as.
  const [file, argv] =
    platform === 'darwin' ? ['open', [url]]
    : platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try {
    await exec(file, argv);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { openUrl };
