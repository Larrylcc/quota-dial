const { spawn } = require('node:child_process');
const { homedir } = require('node:os');
const { createInterface } = require('node:readline');

class CodexError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

class AppServer {
  constructor(executable, version, onNotification, { spawnProcess = spawn, timeoutMs = 10_000, shutdownTimeoutMs = 1_000 } = {}) {
    this.version = version;
    this.onNotification = onNotification;
    this.timeoutMs = timeoutMs;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;

    try {
      this.child = spawnProcess(executable, ['app-server'], {
        cwd: homedir(),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch {
      throw new CodexError('startup');
    }
    this.reader = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.reader.on('line', (line) => this.handleLine(line));
    this.child.stderr.resume();
    this.shutdown = new Promise((resolve) => {
      this.finishShutdown = resolve;
      this.child.once('close', () => {
        this.close();
        clearTimeout(this.shutdownTimer);
        resolve();
      });
    });
    this.child.on('error', () => this.close(new CodexError('startup')));
    this.child.stdin.on('error', () => this.close());
    this.reader.on('error', () => this.close());
  }

  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'codex_quota_vscode', title: 'Quota Dial', version: this.version }
    });
    this.send({ method: 'initialized' });
  }

  request(method, params) {
    if (this.closed) return Promise.reject(new CodexError('connection'));

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => this.close(new CodexError('timeout')), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.send({ id, method, params });
    });
  }

  send(message) {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleLine(line) {
    if (this.closed) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;

    if (typeof message.method === 'string') {
      if (Object.hasOwn(message, 'id')) {
        this.send({ id: message.id, error: { code: -32601, message: 'Method not supported' } });
      } else {
        this.onNotification(message.method, message.params);
      }
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);

    if (message.error) {
      const { code, message: detail } = message.error;
      if (code === -32601) {
        pending.reject(new CodexError('unsupported'));
      } else if (/\b401\b|unauthori[sz]ed|not logged in/i.test(detail ?? '')) {
        pending.reject(new CodexError('signed-out'));
      } else {
        pending.reject(new CodexError('connection'));
      }
      return;
    }
    pending.resolve(message.result);
  }

  close(error = new CodexError('connection')) {
    if (this.closed) return this.shutdown;
    this.closed = true;
    this.reader.close();
    const child = this.child;
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    for (const { reject, timeout } of this.pending.values()) {
      clearTimeout(timeout);
      reject(error);
    }
    this.pending.clear();

    if (child.exitCode === null && child.signalCode === null) {
      this.shutdownTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        child.unref?.();
        this.finishShutdown();
      }, this.shutdownTimeoutMs);
      child.kill();
    } else {
      this.finishShutdown();
    }
    return this.shutdown;
  }
}

module.exports = { AppServer, CodexError };
