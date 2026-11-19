const { execFile } = require('node:child_process');
const { homedir } = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { isExecutable, configuredExecutable, executableDirectories } = require('./executable-path');
const { QuotaPoller } = require('./quota-poller');

const MINIMUM_CLI_VERSION = '1.1.11';
const runFile = promisify(execFile);

class AntigravityError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function findAntigravityExecutable({ configuredPath, searchPath } = {}) {
  if (configuredPath) return configuredExecutable(configuredPath);

  const windows = process.platform === 'win32';
  const executable = windows ? 'agy.exe' : 'agy';
  const directories = executableDirectories(searchPath);
  if (windows) {
    if (process.env.LOCALAPPDATA && path.isAbsolute(process.env.LOCALAPPDATA)) {
      directories.push(path.join(process.env.LOCALAPPDATA, 'agy', 'bin'));
    }
  } else {
    directories.push(path.join(homedir(), '.local', 'bin'));
  }
  return directories.map((directory) => path.join(directory, executable)).find(isExecutable);
}

function supportsHeadlessUsage(stdout) {
  const version = stdout.trim().match(/^(?:(?:agy|Antigravity(?: CLI)?)(?: version)?\s+)?v?(\d+)\.(\d+)\.(\d+)(-[\w.-]+)?(?:\+[\w.-]+)?(?=\s|$)/i);
  if (!version) return false;

  const actual = version.slice(1, 4).map(Number);
  const minimum = MINIMUM_CLI_VERSION.split('.').map(Number);
  for (let index = 0; index < minimum.length; index++) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return !version[4];
}

function needsSignIn(detail) {
  return /not authenticated|not (?:logged|signed) in|(?:sign|log)[ -]?in required|authentication required|unauthenticated|without (?:an? )?(?:active )?(?:account|credentials)/i.test(detail);
}

function quotaDuration(window) {
  const kind = typeof window === 'string' ? window.toLowerCase().replace(/[-_\s]/g, '') : '';
  if (kind === 'weekly' || kind === '7d') return 10080;
  if (['fivehour', 'fivehours', '5hour', '5h'].includes(kind)) return 300;
  return null;
}

function parseAntigravityUsage(stdout) {
  let result;
  try {
    result = JSON.parse(stdout.trim());
  } catch {
    throw new AntigravityError('connection');
  }

  if (result?.status !== 'SUCCESS') {
    throw new AntigravityError(needsSignIn(result?.error ?? '') ? 'signed-out' : 'connection');
  }
  const groups = result.command?.data?.groups;
  if (result.command?.name !== 'usage' || !Array.isArray(groups) || result.num_turns > 0) {
    throw new AntigravityError('unsupported');
  }

  const windows = [];
  for (const group of groups) {
    if (!Array.isArray(group?.buckets)) continue;
    for (const bucket of group.buckets) {
      const fraction = bucket?.remaining_fraction;
      if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue;
      const resetAt = typeof bucket.reset_time === 'string' ? Date.parse(bucket.reset_time) : NaN;
      windows.push({
        group: typeof group.name === 'string' ? group.name.trim() : '',
        period: typeof bucket.name === 'string' ? bucket.name.trim() : '',
        minutes: quotaDuration(bucket.window),
        remaining: Math.round(fraction * 100),
        resetAt: Number.isFinite(resetAt) ? resetAt : null
      });
    }
  }
  return windows;
}

async function readAntigravityQuota(executable, signal, execute = runFile) {
  const options = { cwd: homedir(), windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024, signal };
  try {
    const { stdout: version } = await execute(executable, ['--version'], options);
    if (!supportsHeadlessUsage(version)) throw new AntigravityError('unsupported');
    const { stdout } = await execute(executable, ['--print', '/usage', '--output-format', 'json'], options);
    return parseAntigravityUsage(stdout);
  } catch (error) {
    if (error instanceof AntigravityError || error.code === 'ABORT_ERR') throw error;
    if (error.killed) throw new AntigravityError('timeout');
    if (error.code === 'ENOENT' || error.code === 'EACCES') throw new AntigravityError('startup');
    const detail = `${error.stderr ?? ''}\n${error.stdout ?? ''}`;
    throw new AntigravityError(needsSignIn(detail) ? 'signed-out' : 'connection');
  }
}

class AntigravityMonitor extends QuotaPoller {
  constructor(query, publish, intervalMs) {
    super(intervalMs);
    this.query = query;
    this.publish = publish;
  }

  async read(generation) {
    const controller = new AbortController();
    this.controller = controller;
    let state;
    try {
      const windows = await this.query(controller.signal);
      if (!this.isCurrent(generation)) return;

      this.reading = windows.length ? { windows, updatedAt: Date.now() } : undefined;
      state = this.reading ? 'ready' : 'empty';
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      if (['signed-out', 'not-installed', 'invalid-path'].includes(error.code)) this.reading = undefined;
      state = error.code ?? 'connection';
    } finally {
      this.controller = undefined;
    }
    const status = { state, reading: this.reading };
    this.publish(status);
    return status;
  }

  async reconnect() {
    if (this.disposed) return;
    this.generation++;
    this.cancelScheduledRefresh();
    this.reading = undefined;
    this.publish({ state: 'loading' });
    this.controller?.abort();
    await this.refreshing;
    await this.refresh();
  }

  dispose() {
    super.dispose();
    this.controller?.abort();
    return this.refreshing;
  }
}

module.exports = {
  AntigravityError,
  AntigravityMonitor,
  MINIMUM_CLI_VERSION,
  findAntigravityExecutable,
  parseAntigravityUsage,
  readAntigravityQuota
};
