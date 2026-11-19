const fs = require('node:fs');
const path = require('node:path');

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function configuredExecutable(file) {
  if (!path.isAbsolute(file) || (process.platform === 'win32' && !/\.exe$/i.test(file))) return;
  return isExecutable(file) ? file : undefined;
}

function executableDirectories(searchPath = process.env.PATH) {
  return (searchPath ?? '').split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter((directory) => path.isAbsolute(directory));
}

module.exports = { isExecutable, configuredExecutable, executableDirectories };
