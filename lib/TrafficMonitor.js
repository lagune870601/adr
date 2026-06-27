import EventEmitter from 'node:events';
import { PackageExpiredError, PackageInactiveError } from './errors.js';

/**
 * Traffic usage monitor for resident proxy packages.
 *
 * Polls residentPackage() at a configurable interval and emits events
 * when traffic crosses warning/critical/depleted thresholds.
 *
 * Also monitors package active/expired state.
 *
 * Events are only emitted once per threshold level transition to avoid
 * spamming the consumer on every poll cycle.
 */
export class TrafficMonitor extends EventEmitter {
  /**
   * @param {object} fetcher - ProxyFetcher instance
   * @param {object} options
   * @param {boolean} [options.enabled=true]
   * @param {number} [options.interval=60000] - Poll interval in ms
   * @param {number} [options.warningPercent=10] - Emit traffic:warning when this % remains
   * @param {number} [options.criticalPercent=5] - Emit traffic:critical when this % remains
   */
  constructor(fetcher, options = {}) {
    super();
    this.fetcher = fetcher;
    this.enabled = options.enabled !== false;
    this.interval = Math.max(options.interval ?? 60000, 10000); // min 10s
    this.warningPercent = options.warningPercent ?? 10;
    this.criticalPercent = options.criticalPercent ?? 5;

    // Ensure warning > critical
    if (this.warningPercent <= this.criticalPercent) {
      this.warningPercent = this.criticalPercent + 5;
    }

    /** @type {NodeJS.Timeout|null} */
    this._timerId = null;

    /** @type {string} Last emitted threshold level: 'normal', 'warning', 'critical', 'depleted' */
    this._lastLevel = 'normal';

    /** @type {boolean} */
    this._packageWasActive = true;

    /** @type {object|null} */
    this._lastSnapshot = null;
  }

  /**
   * Start polling traffic stats.
   */
  start() {
    if (!this.enabled) return;
    this.stop();
    this._timerId = setInterval(() => this.check(), this.interval);
    // Don't block process exit
    if (this._timerId.unref) {
      this._timerId.unref();
    }
  }

  /**
   * Stop polling.
   */
  stop() {
    if (this._timerId) {
      clearInterval(this._timerId);
      this._timerId = null;
    }
  }

  /**
   * Perform a single traffic check and emit events if thresholds crossed.
   * @returns {Promise<object|null>} Traffic snapshot, or null if check failed
   */
  async check() {
    try {
      const pkg = await this.fetcher.fetchPackageInfo();

      // Check package state
      if (!pkg.isActive && this._packageWasActive) {
        this._packageWasActive = false;
        this.emit('package:inactive', {});
      }

      // Check expiry
      if (pkg.expiredAt) {
        const expiryDate = this._parseDate(pkg.expiredAt);
        if (expiryDate && expiryDate < new Date()) {
          this.emit('package:expired', { expiredAt: pkg.expiredAt });
        }
      }

      // Calculate traffic usage
      const snapshot = {
        isActive: pkg.isActive,
        trafficLimit: pkg.trafficLimit,
        trafficUsage: pkg.trafficUsage,
        trafficRemaining: Math.max(0, pkg.trafficLimit - pkg.trafficUsage),
        usedPercent: pkg.trafficLimit > 0
          ? (pkg.trafficUsage / pkg.trafficLimit) * 100
          : 0,
        expiredAt: pkg.expiredAt,
        autoRenew: pkg.autoRenew,
        rotation: pkg.rotation,
        tarifId: pkg.tarifId,
      };

      this._lastSnapshot = snapshot;

      // Skip threshold checks if traffic limit is 0 (unlimited plan)
      if (pkg.trafficLimit <= 0) {
        return snapshot;
      }

      const remainingPercent = 100 - snapshot.usedPercent;
      let newLevel = 'normal';

      if (snapshot.trafficUsage >= pkg.trafficLimit) {
        newLevel = 'depleted';
      } else if (remainingPercent <= this.criticalPercent) {
        newLevel = 'critical';
      } else if (remainingPercent <= this.warningPercent) {
        newLevel = 'warning';
      }

      // Only emit on level transitions
      if (newLevel !== this._lastLevel) {
        this._lastLevel = newLevel;
        const payload = {
          usedPercent: snapshot.usedPercent,
          remainingBytes: snapshot.trafficRemaining,
          limitBytes: snapshot.trafficLimit,
          usageBytes: snapshot.trafficUsage,
        };

        if (newLevel === 'depleted') {
          this.emit('traffic:depleted', payload);
        } else if (newLevel === 'critical') {
          this.emit('traffic:critical', payload);
        } else if (newLevel === 'warning') {
          this.emit('traffic:warning', payload);
        }
      }

      return snapshot;
    } catch (err) {
      // Swallow errors during polling — don't crash the process
      // The error event will be emitted by the manager
      return null;
    }
  }

  /**
   * Get the most recent traffic snapshot.
   * @returns {object|null}
   */
  getSnapshot() {
    return this._lastSnapshot;
  }

  /**
   * Parse a date string in "d.m.Y H:i:s" format (common in proxy-seller responses).
   * Falls back to native Date parsing.
   */
  _parseDate(dateStr) {
    if (!dateStr) return null;
    // Try "d.m.Y H:i:s" format
    const parts = dateStr.split(' ');
    if (parts.length >= 1) {
      const dateParts = parts[0].split('.');
      if (dateParts.length === 3) {
        const timeParts = parts[1] ? parts[1].split(':') : [0, 0, 0];
        const d = parseInt(dateParts[0], 10);
        const m = parseInt(dateParts[1], 10) - 1;
        const y = parseInt(dateParts[2], 10);
        const h = parseInt(timeParts[0], 10) || 0;
        const min = parseInt(timeParts[1], 10) || 0;
        const s = parseInt(timeParts[2], 10) || 0;
        return new Date(y, m, d, h, min, s);
      }
    }
    // Fallback
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? null : d;
  }
}