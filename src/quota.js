const { isDeepStrictEqual } = require('node:util');
const { QuotaPoller, refreshIntervalMs } = require('./quota-poller');
const MINUTES_PER_DAY = 24 * 60;

function selectCodexSnapshot(result) {
  const snapshot = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits;
  if (snapshot && (!snapshot.limitId || snapshot.limitId === 'codex')) return snapshot;
}

function accountKey({ userId, account }) {
  const identity = userId || account.email;
  if (identity) return JSON.stringify([identity, account.workspaceName ?? null, account.planType ?? null]);
}

function quotaWindows(snapshot) {
  const windows = [];
  for (const window of [snapshot?.primary, snapshot?.secondary]) {
    if (!Number.isFinite(window?.usedPercent)) continue;
    const minutes = window.windowDurationMins > 0 && Number.isFinite(window.windowDurationMins)
      ? window.windowDurationMins
      : null;
    const resetAt = Number.isFinite(window.resetsAt) ? window.resetsAt * 1000 : null;
    windows.push({
      minutes,
      remaining: 100 - Math.round(Math.max(0, Math.min(100, window.usedPercent))),
      resetAt: resetAt !== null && Number.isFinite(new Date(resetAt).getTime()) ? resetAt : null
    });
  }
  return windows.sort((left, right) => (left.minutes ?? Infinity) - (right.minutes ?? Infinity));
}

function windowLabel(minutes) {
  if (minutes === null) return null;
  if (minutes % MINUTES_PER_DAY === 0) return `${minutes / MINUTES_PER_DAY}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

class QuotaMonitor extends QuotaPoller {
  constructor(createServer, publish, intervalMs) {
    super(intervalMs);
    this.createServer = createServer;
    this.publish = publish;
  }

  async reconnect() {
    if (this.disposed) return;

    const generation = ++this.generation;
    this.cancelScheduledRefresh();
    this.clearAccount('loading');
    await Promise.all([this.disconnect(), this.refreshing]);
    if (this.isCurrent(generation)) await this.refresh();
  }

  async dispose() {
    super.dispose();
    await this.disconnect();
  }

  disconnect() {
    const server = this.server;
    this.server = undefined;
    return server?.close();
  }

  async read(generation) {
    let server = this.server;
    try {
      if (this.account && !this.account.key) {
        this.clearAccount('loading');
        await this.disconnect();
        server = undefined;
      }
      if (this.account) this.account.server = undefined;
      if (server?.closed) {
        await server.close();
        server = undefined;
      }
      if (!this.isCurrent(generation)) return;

      if (!server) {
        server = this.createServer((method, params) => this.notify(server, method, params));
        this.server = server;
        await server.initialize();
        if (!this.isCurrent(generation)) return;
      }

      const identity = await server.request('account/read', { refreshToken: false });
      if (!this.isCurrent(generation)) return;
      if (identity.account?.type !== 'chatgpt') {
        this.clearAccount(identity.account ? 'chatgpt-required' : 'signed-out');
        await server.close();
        return;
      }

      const key = accountKey(identity);
      if (this.account && key !== this.account.key) {
        // Quota notifications carry no account ID. A new connection fences off the old account's messages.
        this.clearAccount('loading');
        await this.disconnect();
        if (this.isCurrent(generation)) await this.read(generation);
        return;
      }
      this.account ??= { key };
      this.account.server = server;
      await this.readLimits(server, this.account);
    } catch (error) {
      if (this.isCurrent(generation)) {
        if (error.code === 'signed-out') {
          this.clearAccount(error.code);
        } else {
          const account = this.account;
          const reading = account?.key && account.server === server ? account.reading : undefined;
          this.publish({ state: error.code ?? 'connection', reading });
        }
      }
      await server?.close();
    }
  }

  async readLimits(server, account) {
    const updates = {};
    account.updates = updates;
    try {
      const result = await server.request('account/rateLimits/read');
      if (this.disposed || this.account !== account) return;
      const snapshot = selectCodexSnapshot(result);
      const switched = result?.accountId && account.id && result.accountId !== account.id;
      account.id = result?.accountId ?? account.id;
      const mergeUpdates = !switched && Object.keys(updates).length > 0;
      this.showSnapshot(account, mergeUpdates ? { ...snapshot, ...updates } : snapshot, mergeUpdates);
      if (switched) await this.disconnect();
    } finally {
      account.updates = undefined;
    }
  }

  async notify(server, method, params) {
    if (this.disposed || !server || server !== this.server || server.closed) return;
    if (method === 'account/updated' && Object.hasOwn(params ?? {}, 'authMode')) {
      const generation = ++this.generation;
      const mode = params.authMode;
      const closing = this.account ? this.disconnect() : undefined;
      if (mode === 'chatgpt' || mode === 'chatgptAuthTokens') {
        this.clearAccount('loading');
        await Promise.all([closing, this.refreshing]);
        if (this.isCurrent(generation)) await this.refresh();
      } else {
        this.clearAccount(mode ? 'chatgpt-required' : 'signed-out');
      }
      return;
    }

    const account = this.account;
    if (method !== 'account/rateLimits/updated' || account?.server !== server) return;
    const update = selectCodexSnapshot(params);
    const windows = {};
    for (const period of ['primary', 'secondary']) {
      if (Number.isFinite(update?.[period]?.usedPercent)) windows[period] = update[period];
    }
    if (!Object.keys(windows).length) return;

    if (account.updates) Object.assign(account.updates, windows);
    this.showSnapshot(account, { ...account.snapshot, ...windows });
  }

  clearAccount(state) {
    this.account = undefined;
    this.publish({ state });
  }

  showSnapshot(account, snapshot, skipUnchanged = false) {
    account.snapshot = snapshot;
    const windows = quotaWindows(snapshot);
    if (skipUnchanged && isDeepStrictEqual(windows, account.reading?.windows)) return;
    account.reading = windows.length ? { windows, updatedAt: Date.now() } : undefined;
    this.publish(account.reading ? { state: 'ready', reading: account.reading } : { state: 'empty' });
  }
}

module.exports = { QuotaMonitor, quotaWindows, refreshIntervalMs, windowLabel };
