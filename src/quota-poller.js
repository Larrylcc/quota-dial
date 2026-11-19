const DEFAULT_REFRESH_INTERVAL_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function refreshIntervalMs(seconds) {
  const milliseconds = Number.isInteger(seconds) ? seconds * 1000 : 0;
  return milliseconds > 0 && milliseconds <= MAX_TIMER_DELAY_MS ? milliseconds : DEFAULT_REFRESH_INTERVAL_MS;
}

class QuotaPoller {
  constructor(intervalMs = DEFAULT_REFRESH_INTERVAL_MS) {
    this.intervalMs = intervalMs;
    this.generation = 0;
    this.disposed = false;
  }

  refresh() {
    if (this.disposed) return Promise.resolve();
    if (this.refreshing) return this.refreshing;

    this.cancelScheduledRefresh();
    this.refreshing = this.read(this.generation).finally(() => {
      this.refreshing = undefined;
      if (!this.disposed) {
        this.finishedAt = performance.now();
        this.scheduleRefresh();
      }
    });
    return this.refreshing;
  }

  setRefreshInterval(intervalMs) {
    if (this.intervalMs === intervalMs) return;
    this.intervalMs = intervalMs;
    if (this.timer !== undefined) this.scheduleRefresh();
  }

  scheduleRefresh() {
    this.cancelScheduledRefresh();
    const elapsed = performance.now() - this.finishedAt;
    const delay = Math.max(0, Math.ceil(this.intervalMs - elapsed));
    this.timer = setTimeout(() => void this.refresh(), delay);
  }

  cancelScheduledRefresh() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  isCurrent(generation) {
    return !this.disposed && generation === this.generation;
  }

  dispose() {
    this.disposed = true;
    this.cancelScheduledRefresh();
  }
}

module.exports = { QuotaPoller, refreshIntervalMs };
