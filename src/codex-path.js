const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { isExecutable, configuredExecutable, executableDirectories } = require('./executable-path');

function findWindowsNpmCodex(directory) {
  const triple = { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' }[process.arch];
  if (!triple || !fs.existsSync(path.join(directory, 'codex.cmd'))) return;

  const codexPackage = path.join(directory, 'node_modules', '@openai', 'codex');
  const packages = [codexPackage];
  const resolveFromCodex = createRequire(path.join(codexPackage, 'package.json')).resolve;
  try {
    const platformPackage = resolveFromCodex(`@openai/codex-win32-${process.arch}/package.json`);
    packages.unshift(path.dirname(platformPackage));
  } catch {
    // Some Codex releases ship the executable in the main package.
  }
  for (const root of packages) {
    for (const subdirectory of ['bin', 'codex']) {
      const candidate = path.join(root, 'vendor', triple, subdirectory, 'codex.exe');
      if (isExecutable(candidate)) return candidate;
    }
  }
}

function findCodexExecutable({ configuredPath, extensionPath, searchPath = process.env.PATH }) {
  const windows = process.platform === 'win32';
  const executable = windows ? 'codex.exe' : 'codex';
  if (configuredPath) return configuredExecutable(configuredPath);

  const platform = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform];
  const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
  if (extensionPath && platform && arch) {
    const bundled = path.join(extensionPath, 'bin', `${platform}-${arch}`, executable);
    if (isExecutable(bundled)) return bundled;
  }

  for (const directory of executableDirectories(searchPath)) {
    const candidate = path.join(directory, executable);
    if (isExecutable(candidate)) return candidate;
    if (windows) {
      const npmCodex = findWindowsNpmCodex(directory);
      if (npmCodex) return npmCodex;
    }
  }
}

module.exports = { findCodexExecutable };
