/**
 * Manages sticky-session rotation for resident proxies.
 *
 * Caches the current proxy and schedules rotation at a configurable interval.
 * On rotation, selects a different IP from the pool to guarantee actual IP change.
 *
 * All timer/callback coordination is external — this class is pure state management.
 * Timers are scheduled externally via scheduleRotation(callback) so the manager
 * can orchestrate the full fetch → select → validate → rotate flow.
 */
export class RotationManager {
  /**
   * @param {object} options
   * @param {number} [options.rotationInterval=1800000] - Sticky session duration in ms (default 30 min)
   * @param {'random'|'sequential'} [options.strategy='random'] - Proxy selection strategy
   */
  constructor(options = {}) {
    this.rotationInterval = Math.max(options.rotationInterval ?? 30 * 60 * 1000, 10000); // min 10s
    this.strategy = options.strategy || 'random';

    /** @type {object|null} */
    this.currentProxy = null;

    /** @type {number|null} */
    this.lastRotationTime = null;

    /** @type {NodeJS.Timeout|null} */
    this._timerId = null;

    /** @type {number} */
    this._sequentialIndex = 0;
  }

  /**
   * Select a proxy from the pool using the configured strategy.
   * Excludes the currently-held proxy (by host) to guarantee IP rotation.
   *
   * @param {Array<{host: string}>} proxies - Available proxy pool
   * @returns {object|null} Selected proxy, or null if pool is empty
   */
  selectProxy(proxies) {
    if (!proxies || proxies.length === 0) {
      return null;
    }

    // Build candidate pool — exclude current proxy to ensure rotation
    const currentHost = this.currentProxy?.host;
    let candidates = proxies;
    if (currentHost && proxies.length > 1) {
      candidates = proxies.filter(p => p.host !== currentHost);
      if (candidates.length === 0) {
        // All proxies have the same IP as current — fall back to full pool
        candidates = proxies;
      }
    }

    let selected;
    if (this.strategy === 'sequential') {
      selected = candidates[this._sequentialIndex % candidates.length];
      this._sequentialIndex = (this._sequentialIndex + 1) % candidates.length;
    } else {
      // random
      const idx = Math.floor(Math.random() * candidates.length);
      selected = candidates[idx];
    }

    return selected;
  }

  /**
   * Get the currently cached proxy.
   * @returns {object|null}
   */
  getCurrentProxy() {
    return this.currentProxy;
  }

  /**
   * Schedule the next rotation callback.
   * Clears any existing timer first.
   * Uses unref() so the timer doesn't keep the process alive.
   *
   * @param {() => void} callback - Called when the rotation interval elapses
   */
  scheduleRotation(callback) {
    this.cancelRotation();
    this._timerId = setTimeout(() => {
      this._timerId = null;
      callback();
    }, this.rotationInterval);
    // Don't keep the process alive just for the rotation timer
    if (this._timerId.unref) {
      this._timerId.unref();
    }
  }

  /**
   * Cancel the pending rotation timer.
   */
  cancelRotation() {
    if (this._timerId) {
      clearTimeout(this._timerId);
      this._timerId = null;
    }
  }

  /**
   * Update the current proxy to a new one and record the rotation time.
   * @param {object} newProxy
   */
  rotate(newProxy) {
    this.currentProxy = newProxy;
    this.lastRotationTime = Date.now();
  }

  /**
   * Check if the current proxy has exceeded the rotation interval.
   * @returns {boolean}
   */
  isStale() {
    if (!this.currentProxy || !this.lastRotationTime) {
      return true;
    }
    return (Date.now() - this.lastRotationTime) >= this.rotationInterval;
  }

  /**
   * Get the time remaining until the next rotation, in ms.
   * Returns 0 if the proxy is already stale or no proxy is set.
   * @returns {number}
   */
  timeUntilRotation() {
    if (!this.currentProxy || !this.lastRotationTime) {
      return 0;
    }
    const elapsed = Date.now() - this.lastRotationTime;
    return Math.max(0, this.rotationInterval - elapsed);
  }
}