const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const { AntigravityError, AntigravityMonitor, parseAntigravityUsage, readAntigravityQuota } = require('../src/antigravity');
const { AppServer, CodexError } = require('../src/app-server');
const { findCodexExecutable } = require('../src/codex-path');
const { QuotaMonitor, quotaWindows, refreshIntervalMs, windowLabel } = require('../src/quota');

const CHATGPT_ACCOUNT = { account: { type: 'chatgpt', email: 'first@example.test', planType: 'plus' } };
const SHORT_WINDOW = { windowDurationMins: 300, usedPercent: 22, resetsAt: 1795140000 };
const LONG_WINDOW = { windowDurationMins: 10080, usedPercent: 58, resetsAt: 1795744800 };
const SNAPSHOT = { primary: SHORT_WINDOW, secondary: LONG_WINDOW };
const AGY_REPORT = JSON.stringify({
  status: 'SUCCESS',
  num_turns: 0,
  command: {
    name: 'usage',
    data: {
      groups: [
        { name: 'Gemini Models', buckets: [
          { name: 'Weekly Limit', window: 'weekly', remaining_fraction: 0.785, reset_time: '2026-11-23T12:00:00Z' },
          { name: 'Five Hour Limit', window: 'five_hour', remaining_fraction: 0, reset_time: null }
        ] },
        { name: 'Other models', buckets: [
          { name: 'Monthly Limit', window: 'monthly', remaining_fraction: 0.42, reset_time: 'invalid' }
        ] }
      ]
    }
  }
});

test('Antigravity preserves model groups, quota windows, zero and unavailable reset times', () => {
  assert.deepEqual(parseAntigravityUsage(AGY_REPORT), [
    { group: 'Gemini Models', period: 'Weekly Limit', minutes: 10080, remaining: 79, resetAt: Date.parse('2026-11-23T12:00:00Z') },
    { group: 'Gemini Models', period: 'Five Hour Limit', minutes: 300, remaining: 0, resetAt: null },
    { group: 'Other models', period: 'Monthly Limit', minutes: null, remaining: 42, resetAt: null }
  ]);
  assert.throws(() => parseAntigravityUsage('{'), { code: 'connection' });
  assert.throws(() => parseAntigravityUsage(JSON.stringify({ ...JSON.parse(AGY_REPORT), num_turns: 1 })), { code: 'unsupported' });
});

test('Antigravity gates its read-only usage command on the CLI version', async () => {
  for (const installedVersion of ['agy version 1.1.10', 'v1.1.11-preview.1', 'unknown']) {
    const runOld = async (_executable, args) => {
      assert.deepEqual(args, ['--version']);
      return { stdout: installedVersion };
    };
    await assert.rejects(readAntigravityQuota('agy', undefined, runOld), { code: 'unsupported' });
  }

  const calls = [];
  const windows = await readAntigravityQuota('agy', undefined, async (_executable, args) => {
    calls.push(args);
    return { stdout: calls.length === 1 ? 'Antigravity CLI v1.1.11' : AGY_REPORT };
  });
  assert.deepEqual(calls, [['--version'], ['--print', '/usage', '--output-format', 'json']]);
  assert.equal(windows.length, 3);
});

test('Antigravity reports a sign-in requirement without exposing command output', async () => {
  const execute = async (_executable, args) => {
    if (args[0] === '--version') return { stdout: 'agy version 1.4.0' };
    throw Object.assign(new Error('CLI error'), { code: 1, stderr: 'Not authenticated' });
  };
  await assert.rejects(readAntigravityQuota('agy', undefined, execute), { code: 'signed-out', message: 'signed-out' });
});

test('changing the Antigravity executable cancels the previous query', async (t) => {
  const statuses = [];
  const windows = parseAntigravityUsage(AGY_REPORT);
  let requests = 0;
  let firstSignal;
  const monitor = new AntigravityMonitor((signal) => {
    if (++requests > 1) return Promise.resolve(windows);
    firstSignal = signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, (status) => statuses.push(status));
  t.after(() => monitor.dispose());

  void monitor.refresh();
  await monitor.reconnect();
  assert.equal(firstSignal.aborted, true);
  assert.deepEqual(statuses.map((status) => status.state), ['loading', 'ready']);
  assert.deepEqual(statuses[1].reading.windows, windows);
});

test('Antigravity distinguishes unavailable, zero remaining and temporarily stale readings', async (t) => {
  const windows = parseAntigravityUsage(AGY_REPORT);
  let failure = 'not-installed';
  const monitor = new AntigravityMonitor(async () => {
    if (failure) throw new AntigravityError(failure);
    return windows;
  }, () => {});
  t.after(() => monitor.dispose());

  assert.deepEqual(await monitor.refresh(), { state: 'not-installed', reading: undefined });
  failure = undefined;
  const ready = await monitor.refresh();
  assert.equal(ready.state, 'ready');
  assert.ok(ready.reading.windows.some(({ remaining }) => remaining === 0));
  failure = 'connection';
  assert.deepEqual(await monitor.refresh(), { state: 'connection', reading: ready.reading });
  failure = 'signed-out';
  assert.deepEqual(await monitor.refresh(), { state: 'signed-out', reading: undefined });
});

test('the refresh interval setting uses seconds and defaults to one minute', () => {
  const { default: seconds, minimum, maximum } = require('../package.json').contributes.configuration
    .properties['codexQuota.refreshIntervalSeconds'];
  assert.equal(refreshIntervalMs(seconds), 60_000);
  assert.equal(refreshIntervalMs(minimum), 1_000);
  assert.equal(refreshIntervalMs(120), 120_000);
  assert.equal(refreshIntervalMs(maximum), maximum * 1000);
  for (const value of [undefined, '120', 0, -1, 1.5, maximum + 1]) {
    assert.equal(refreshIntervalMs(value), 60_000);
  }
});

test('quota periods are sorted by duration and show remaining percentages', () => {
  assert.deepEqual(quotaWindows({ primary: LONG_WINDOW, secondary: SHORT_WINDOW }), [
    { minutes: 300, remaining: 78, resetAt: 1795140000000 },
    { minutes: 10080, remaining: 42, resetAt: 1795744800000 }
  ]);
  assert.deepEqual([300, 10080, 90, null].map(windowLabel), ['5h', '7d', '90m', null]);
});

test('Chinese translations cover the manifest and runtime messages with matching placeholders', () => {
  const readText = (file) => readFileSync(join(__dirname, '..', file), 'utf8');
  const defaultManifest = JSON.parse(readText('package.nls.json'));
  const manifestKeys = [...readText('package.json').matchAll(/"%([^%"]+)%"/g)].map((match) => match[1]);
  const messages = [...readText('src/extension.js').matchAll(/vscode\.l10n\.t\(\s*'([^']+)'/g)].map((match) => match[1]);
  const placeholders = (text) => (text.match(/\{\d+\}/g) ?? []).sort();

  assert.deepEqual(Object.keys(defaultManifest).sort(), [...new Set(manifestKeys)].sort());
  for (const locale of ['zh-cn', 'zh-tw']) {
    const manifest = JSON.parse(readText(`package.nls.${locale}.json`));
    const runtime = JSON.parse(readText(`l10n/bundle.l10n.${locale}.json`));
    assert.deepEqual(Object.keys(manifest).sort(), Object.keys(defaultManifest).sort(), locale);
    assert.deepEqual(Object.keys(runtime).sort(), [...new Set(messages)].sort(), locale);
    for (const [message, translation] of Object.entries(runtime)) {
      assert.deepEqual(placeholders(translation), placeholders(message), `${locale} ${message}`);
    }
  }
});

test('a weekly-only response retains zero remaining and an unknown reset time', () => {
  assert.deepEqual(quotaWindows({ primary: { ...LONG_WINDOW, usedPercent: 100, resetsAt: null } }), [
    { minutes: 10080, remaining: 0, resetAt: null }
  ]);
  assert.deepEqual(quotaWindows({ primary: null, secondary: { usedPercent: null } }), []);
});

function fakeServer(onNotification, read, readAccount = () => CHATGPT_ACCOUNT) {
  return {
    closed: false,
    async initialize() {},
    async request(method) {
      return method === 'account/read' ? readAccount() : read();
    },
    async close() {
      this.closed = true;
    },
    onNotification
  };
}

function mockRefreshClock(t) {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return (milliseconds) => {
    now += milliseconds;
    t.mock.timers.tick(milliseconds);
  };
}

test('changing the interval reschedules from the previous completion on the same connection', async (t) => {
  const advance = mockRefreshClock(t);
  let reads = 0;
  let connections = 0;
  const monitor = new QuotaMonitor((notify) => {
    connections++;
    return fakeServer(notify, () => {
      reads++;
      return { rateLimits: SNAPSHOT };
    });
  }, () => {});
  t.after(() => monitor.dispose());

  await monitor.refresh();
  advance(20_000);
  monitor.setRefreshInterval(30_000);
  advance(9_999);
  await Promise.resolve();
  assert.equal(reads, 1);

  advance(1);
  await Promise.resolve();
  assert.equal(reads, 2);
  assert.equal(connections, 1);
});

test('an interval change during an active query applies after that query finishes', async (t) => {
  const advance = mockRefreshClock(t);
  const firstRead = Promise.withResolvers();
  const started = Promise.withResolvers();
  let reads = 0;
  const monitor = new QuotaMonitor((notify) => fakeServer(notify, () => {
    if (++reads === 1) {
      started.resolve();
      return firstRead.promise;
    }
    return { rateLimits: SNAPSHOT };
  }), () => {});
  t.after(() => monitor.dispose());

  const refresh = monitor.refresh();
  await started.promise;
  monitor.setRefreshInterval(5_000);
  advance(6_000);
  assert.equal(reads, 1);
  firstRead.resolve({ rateLimits: SNAPSHOT });
  await refresh;

  advance(4_999);
  await Promise.resolve();
  assert.equal(reads, 1);
  advance(1);
  await Promise.resolve();
  assert.equal(reads, 2);
});

test('a newer notification updates immediately and a pending read cannot overwrite it', async (t) => {
  const statuses = [];
  const nextRead = Promise.withResolvers();
  const readStarted = Promise.withResolvers();
  let count = 0;
  let server;
  const monitor = new QuotaMonitor((onNotification) => {
    server = fakeServer(onNotification, () => {
      if (++count === 1) {
        return { rateLimits: { primary: LONG_WINDOW }, rateLimitsByLimitId: { codex: SNAPSHOT } };
      }
      readStarted.resolve();
      return nextRead.promise;
    });
    return server;
  }, (status) => statuses.push(status));
  t.after(() => monitor.dispose());

  await monitor.refresh();
  assert.deepEqual(statuses.at(-1).reading.windows.map((window) => window.remaining), [78, 42]);
  const refresh = monitor.refresh();
  assert.equal(monitor.refresh(), refresh);
  await readStarted.promise;
  server.onNotification('account/rateLimits/updated', {
    rateLimits: { limitId: 'other', primary: { ...SHORT_WINDOW, usedPercent: 99 } }
  });
  assert.equal(statuses.length, 1);
  server.onNotification('account/rateLimits/updated', {
    rateLimits: { limitId: 'codex', primary: { ...SHORT_WINDOW, usedPercent: 30 } }
  });
  assert.deepEqual(statuses.at(-1).reading.windows.map((window) => window.remaining), [70, 42]);
  nextRead.resolve({ rateLimits: SNAPSHOT });
  await refresh;
  assert.equal(statuses.length, 2);
});

test('an initial full read fills in windows omitted by rolling updates', async (t) => {
  const started = Promise.withResolvers();
  const full = Promise.withResolvers();
  const statuses = [];
  let server;
  const monitor = new QuotaMonitor((notify) => {
    server = fakeServer(notify, () => {
      started.resolve();
      return full.promise;
    });
    return server;
  }, (status) => statuses.push(status));
  t.after(() => monitor.dispose());

  const refresh = monitor.refresh();
  await started.promise;
  for (const usedPercent of [30, 34]) {
    server.onNotification('account/rateLimits/updated', {
      rateLimits: { primary: { ...SHORT_WINDOW, usedPercent }, secondary: null }
    });
  }
  assert.deepEqual(statuses.at(-1).reading.windows.map(w => w.remaining), [66]);
  full.resolve({ rateLimits: SNAPSHOT });
  await refresh;
  assert.deepEqual(statuses.at(-1).reading.windows.map(w => w.remaining), [66, 42]);
});

test('a different backend account cannot inherit a concurrent quota update', async (t) => {
  const started = Promise.withResolvers();
  const full = Promise.withResolvers();
  const statuses = [];
  let server;
  let reads = 0;
  const monitor = new QuotaMonitor((notify) => {
    server = fakeServer(notify, () => {
      if (++reads === 1) return { accountId: 'workspace-a', rateLimits: SNAPSHOT };
      started.resolve();
      return full.promise;
    });
    return server;
  }, (status) => statuses.push(status));
  t.after(() => monitor.dispose());

  await monitor.refresh();
  const refresh = monitor.refresh();
  await started.promise;
  const previousServer = server;
  server.onNotification('account/rateLimits/updated', { rateLimits: { primary: SHORT_WINDOW } });
  full.resolve({ accountId: 'workspace-b', rateLimits: { primary: null, secondary: LONG_WINDOW } });
  await refresh;
  previousServer.onNotification('account/rateLimits/updated', { rateLimits: SNAPSHOT });
  assert.deepEqual(statuses.at(-1).reading.windows, quotaWindows({ secondary: LONG_WINDOW }));
});

test('a failed refresh retains the last successful reading and the timer reconnects', async (t) => {
  const statuses = [];
  const recovered = Promise.withResolvers();
  const servers = [];
  let polls = 0;
  const monitor = new QuotaMonitor((onNotification) => {
    const server = fakeServer(onNotification, () => {
      if (++polls === 2) throw new CodexError('timeout');
      return { rateLimits: SNAPSHOT };
    });
    servers.push(server);
    return server;
  }, (status) => {
    statuses.push(status);
    if (statuses.length === 3) recovered.resolve();
  }, 10);
  t.after(() => monitor.dispose());

  await monitor.refresh();
  await monitor.refresh();
  assert.equal(statuses.at(-1).state, 'timeout');
  assert.equal(statuses.at(-1).reading, statuses[0].reading);
  assert.equal(servers[0].closed, true);

  await recovered.promise;
  assert.equal(statuses.at(-1).state, 'ready');
  assert.equal(servers.length, 2);
});

test('a signed-out account is detected before requesting quota', async (t) => {
  const statuses = [];
  const server = fakeServer(undefined, () => assert.fail('Quota requires sign-in'), () => ({ account: null }));
  const monitor = new QuotaMonitor(() => server, (status) => statuses.push(status));
  t.after(() => monitor.dispose());

  await monitor.refresh();
  assert.deepEqual(statuses, [{ state: 'signed-out' }]);
  assert.equal(server.closed, true);
});

test('failed reads cannot show a previous account or workspace quota', async (t) => {
  const secondEmail = { ...CHATGPT_ACCOUNT.account, email: 'second@example.test' };
  const cases = [
    ['legacy email', CHATGPT_ACCOUNT, { account: secondEmail }],
    ['user ID', { ...CHATGPT_ACCOUNT, userId: 'a' }, { ...CHATGPT_ACCOUNT, userId: 'b' }],
    ['workspace', CHATGPT_ACCOUNT, { account: { ...CHATGPT_ACCOUNT.account, workspaceName: 'Other' } }],
    ['unavailable identity', CHATGPT_ACCOUNT, { account: { type: 'chatgpt', email: null } }]
  ];
  for (const [name, previous, next] of cases) {
    await t.test(name, async (t) => {
      const statuses = [];
      let identity = previous;
      const monitor = new QuotaMonitor(notify => fakeServer(notify, () => {
        if (identity === next) throw new CodexError('timeout');
        return { rateLimits: SNAPSHOT };
      }, () => identity), status => statuses.push(status));
      t.after(() => monitor.dispose());
      await monitor.refresh();
      identity = next;
      await monitor.refresh();
      assert.deepEqual(statuses.map(s => s.state), ['ready', 'loading', 'timeout']);
      assert.ok(statuses.slice(1).every(s => !s.reading));
    });
  }
});

test('sign-out discards an outstanding quota response and late notifications from its connection', async (t) => {
  const started = Promise.withResolvers();
  const delayed = Promise.withResolvers();
  const statuses = [];
  let server;
  let reads = 0;
  const monitor = new QuotaMonitor((notify) => {
    server = fakeServer(notify, () => {
      if (++reads === 1) return { rateLimits: SNAPSHOT };
      started.resolve();
      return delayed.promise;
    });
    return server;
  }, status => statuses.push(status));
  t.after(() => monitor.dispose());
  await monitor.refresh();
  const refresh = monitor.refresh();
  await started.promise;
  server.onNotification('account/updated', { authMode: null });
  assert.deepEqual(statuses.at(-1), { state: 'signed-out' });
  server.onNotification('account/rateLimits/updated', { rateLimits: SNAPSHOT });
  delayed.resolve({ rateLimits: SNAPSHOT });
  await refresh;
  assert.deepEqual(statuses.map(s => s.state), ['ready', 'signed-out']);
  const old = server;
  await monitor.refresh();
  assert.notEqual(server, old);
  old.onNotification('account/rateLimits/updated', { rateLimits: { primary: SHORT_WINDOW } });
  assert.deepEqual(statuses.at(-1).reading.windows, quotaWindows(SNAPSHOT));
  server.onNotification('account/updated', { authMode: 'apikey' });
  assert.deepEqual(statuses.at(-1), { state: 'chatgpt-required' });
});

test('an unidentified account can read quota without reusing it after account verification fails', async (t) => {
  const statuses = [];
  let accounts = 0;
  let server;
  const monitor = new QuotaMonitor(notify => {
    server = fakeServer(notify, () => ({ rateLimits: SNAPSHOT }), () => {
      if (++accounts === 1) return { account: { type: 'chatgpt', email: null } };
      throw new CodexError('timeout');
    });
    return server;
  }, status => statuses.push(status));
  t.after(() => monitor.dispose());
  await monitor.refresh();
  assert.deepEqual(statuses.at(-1).reading.windows, quotaWindows(SNAPSHOT));
  server.onNotification('account/rateLimits/updated', { rateLimits: { primary: { ...SHORT_WINDOW, usedPercent: 100 } } });
  assert.equal(statuses.at(-1).reading.windows[0].remaining, 0);
  await monitor.refresh();
  assert.deepEqual(statuses.at(-1), { state: 'timeout', reading: undefined });
});

test('a ChatGPT sign-in during account/read verifies the new account before showing quota', async (t) => {
  const started = Promise.withResolvers();
  const delayed = Promise.withResolvers();
  const statuses = [];
  let server;
  let accounts = 0;
  let reads = 0;
  const monitor = new QuotaMonitor((notify) => {
    server = fakeServer(notify, () => {
      reads++;
      return { rateLimits: SNAPSHOT };
    }, () => {
      if (++accounts > 1) return CHATGPT_ACCOUNT;
      started.resolve();
      return delayed.promise;
    });
    return server;
  }, status => statuses.push(status));
  t.after(() => monitor.dispose());

  const refresh = monitor.refresh();
  await started.promise;
  const recheck = server.onNotification('account/updated', { authMode: 'chatgptAuthTokens' });
  server.onNotification('account/rateLimits/updated', { rateLimits: SNAPSHOT });
  delayed.resolve({ account: null });
  await Promise.all([refresh, recheck]);
  assert.deepEqual(statuses.map(s => s.state), ['loading', 'ready']);
  assert.equal(accounts, 2);
  assert.equal(reads, 1);
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    child.signalCode = 'SIGTERM';
    child.stdout.end();
    child.stderr.end();
    queueMicrotask(() => child.emit('close', null, child.signalCode));
  };
  return child;
}

test('stdio handshake, fragmented replies and unsolicited quota notifications', async (t) => {
  const child = fakeChild();
  const messages = [];
  child.stdin.on('data', (chunk) => {
    const message = JSON.parse(chunk.toString());
    messages.push(message.method);
    if (message.method === 'initialize') {
      child.stdout.write(`{"id":${message.id},`);
      child.stdout.write('"result":{}}\r\n');
    } else if (message.method === 'account/rateLimits/read') {
      child.stdout.write(`${JSON.stringify({ method: 'account/rateLimits/updated', params: { rateLimits: SNAPSHOT } })}\n`);
      child.stdout.write(`${JSON.stringify({ id: message.id, result: { rateLimits: SNAPSHOT } })}\n`);
    }
  });

  const notices = [];
  let spawnArgs;
  const server = new AppServer('codex', '0.1.0', (...args) => notices.push(args), {
    spawnProcess: (_executable, args) => {
      spawnArgs = args;
      return child;
    }
  });
  t.after(() => server.close());
  assert.deepEqual(spawnArgs, ['app-server']);
  await server.initialize();
  assert.deepEqual(await server.request('account/rateLimits/read'), { rateLimits: SNAPSHOT });
  assert.deepEqual(messages, ['initialize', 'initialized', 'account/rateLimits/read']);
  assert.deepEqual(notices, [['account/rateLimits/updated', { rateLimits: SNAPSHOT }]]);
});

test('a timed-out protocol request stops its child process', async (t) => {
  const child = fakeChild();
  const server = new AppServer('codex', '0.1.0', () => {}, { spawnProcess: () => child, timeoutMs: 5 });
  t.after(() => server.close());
  await assert.rejects(server.initialize(), { code: 'timeout' });
  await server.close();
  assert.equal(child.signalCode, 'SIGTERM');
});

test('a child that never closes cannot block the next automatic refresh', async (t) => {
  const advance = mockRefreshClock(t);
  const child = fakeChild();
  const signals = [];
  let unreferenced = false;
  child.kill = (signal = 'SIGTERM') => {
    signals.push(signal);
    return true;
  };
  child.unref = () => { unreferenced = true; };
  const timedOut = Promise.withResolvers();
  const recovered = Promise.withResolvers();
  let launches = 0;
  const monitor = new QuotaMonitor((notify) => {
    if (++launches > 1) return fakeServer(notify, () => ({ rateLimits: SNAPSHOT }));
    return new AppServer('codex', '0.2.3', notify, {
      spawnProcess: () => child, timeoutMs: 5, shutdownTimeoutMs: 10
    });
  }, ({ state }) => {
    if (state === 'timeout') timedOut.resolve();
    if (state === 'ready') recovered.resolve();
  }, 100);
  t.after(() => monitor.dispose());

  const first = monitor.refresh();
  advance(5);
  await timedOut.promise;
  assert.deepEqual(signals, ['SIGTERM']);
  advance(10);
  await first;
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.ok(unreferenced && child.stdout.destroyed && child.stderr.destroyed);
  advance(100);
  await recovered.promise;
  await monitor.refresh();
  assert.equal(launches, 2);
});

test('Windows npm discovery supports both native package layouts in priority order', {
  skip: process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)
}, (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'quota-dial-npm-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'codex.cmd'), '');
  const triple = process.arch === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc';
  const main = join(directory, 'node_modules', '@openai', 'codex');
  const native = join(main, 'node_modules', '@openai', `codex-win32-${process.arch}`);
  for (const root of [main, native]) {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'package.json'), '{}');
    for (const subdirectory of ['codex', 'bin']) {
      const executable = join(root, 'vendor', triple, subdirectory, 'codex.exe');
      mkdirSync(dirname(executable), { recursive: true });
      writeFileSync(executable, '');
      assert.equal(findCodexExecutable({ searchPath: directory }), executable);
    }
  }
});
