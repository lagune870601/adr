import EventEmitter from 'node:events';
import ProxySellerUserApi from 'proxy-seller-user-api';
import { ProxyFetcher } from './ProxyFetcher.js';
import { RotationManager } from './RotationManager.js';
import { HealthChecker } from './HealthChecker.js';
import { TrafficMonitor } from './TrafficMonitor.js';
import {
  AuthenticationError,
  PackageExpiredError,
  PackageInactiveError,
  NoProxiesAvailableError,
  ProxyValidationError,
} from './errors.js';

/**
 * Default options applied at construction time.
 */
const DEFAULT_OPTIONS = {
  rotationInterval: 30 * 60 * 1000,   // 30 minutes
  rotationStrategy: 'random',
  country: 'US',
  protocol: 'http',
  healthCheckEnabled: true,
  healthCheckTimeout: 5000,
  healthCheckInterval: 60000,         // 1 minute
  trafficCheckEnabled: true,
  trafficCheckInterval: 60000,        // 1 minute
  trafficWarningPercent: 10,
  trafficCriticalPercent: 5,
  maxRetries: 3,
  retryDelay: 1000,
  paymentId: 1,
  generateAuth: 'N',
  verbose: false,
  autoStart: true,
};

/**
 * Resident Proxy Manager — the main public API.
 *
 * Manages the full lifecycle of a resident proxy for web scraping:
 *   - Fetches and filters proxies by country
 *   - Maintains sticky sessions with auto-rotation (30 min default)
 *   - Validates proxy health (server-side + local TCP)
 *   - Monitors traffic usage with threshold alerts
 *
 * @emits proxy:ready       - {host, port, username, password} — new proxy validated and ready
 * @emits proxy:rotated     - {previous, current} — rotation occurred
 * @emits proxy:health-fail - {proxy, error} — current proxy failed health check
 * @emits traffic:warning   - {usedPercent, remainingBytes, limitBytes}
 * @emits traffic:critical  - {usedPercent, remainingBytes, limitBytes}
 * @emits traffic:depleted  - {usedPercent, remainingBytes, limitBytes}
 * @emits package:expired   - {expiredAt}
 * @emits package:inactive  - {}
 * @emits error             - {error, context} — non-fatal errors
 */
export class ResidentProxyManager extends EventEmitter {
  /**
   * @param {object} options - See DEFAULT_OPTIONS for all fields
   * @param {string} options.apiKey - [REQUIRED] Proxy-seller API key
   */
  constructor(options = {}) {
    super();

    if (!options.apiKey) {
      throw new Error('options.apiKey is required. Get your key at https://proxy-seller.com/personal/api/');
    }

    this._opts = { ...DEFAULT_OPTIONS, ...options };

    // Validate and normalize
    if (this._opts.rotationInterval < 10000) {
      this._opts.rotationInterval = 10000;
    }
    if (this._opts.trafficWarningPercent <= this._opts.trafficCriticalPercent) {
      this._opts.trafficWarningPercent = this._opts.trafficCriticalPercent + 5;
    }

    // Initialize SDK client
    const sdk = new ProxySellerUserApi({ key: this._opts.apiKey });
    sdk.setPaymentId(this._opts.paymentId);
    sdk.setGenerateAuth(this._opts.generateAuth);

    // Initialize sub-components
    this._fetcher = new ProxyFetcher(sdk, {
      country: this._opts.country,
      listId: this._opts.listId,
      protocol: this._opts.protocol,
      maxRetries: this._opts.maxRetries,
      retryDelay: this._opts.retryDelay,
    });

    this._rotation = new RotationManager({
      rotationInterval: this._opts.rotationInterval,
      strategy: this._opts.rotationStrategy,
    });

    this._health = new HealthChecker({
      timeout: this._opts.healthCheckTimeout,
      protocol: this._opts.protocol,
      skipServerCheck: true, // resident gateway proxies don't support proxyCheck API
    });

    this._traffic = new TrafficMonitor(this._fetcher, {
      enabled: this._opts.trafficCheckEnabled,
      interval: this._opts.trafficCheckInterval,
      warningPercent: this._opts.trafficWarningPercent,
      criticalPercent: this._opts.trafficCriticalPercent,
    });

    // Forward traffic events
    this._traffic.on('traffic:warning', (d) => this.emit('traffic:warning', d));
    this._traffic.on('traffic:critical', (d) => this.emit('traffic:critical', d));
    this._traffic.on('traffic:depleted', (d) => this.emit('traffic:depleted', d));
    this._traffic.on('package:inactive', (d) => {
      this._packageValid = false;
      this.emit('package:inactive', d);
    });
    this._traffic.on('package:expired', (d) => {
      this._packageValid = false;
      this.emit('package:expired', d);
    });

    // Internal state
    this._started = false;
    this._packageValid = true;
    this._rotating = false;
    this._rotationPromise = null;
    this._healthTimerId = null;

    // Auto-start if requested
    if (this._opts.autoStart) {
      // Schedule start on next tick so caller can attach listeners
      this._startPromise = Promise.resolve().then(() => this.start());
    }
  }

  // ──────────────────────── Public API ────────────────────────

  /**
   * Start the manager: verify connectivity, validate package, fetch initial proxy,
   * begin rotation timer and traffic monitoring.
   *
   * Idempotent — calling start() multiple times is safe.
   *
   * @returns {Promise<void>}
   * @throws {AuthenticationError} If API key is invalid
   * @throws {PackageExpiredError|PackageInactiveError} If package is not usable
   * @throws {NoProxiesAvailableError} If no proxies match the filters
   */
  async start() {
    if (this._started) return;

    this._log('Starting ResidentProxyManager...');

    // 1. Verify API connectivity
    this._log('Checking API connectivity...');
    const alive = await this._fetcher.ping();
    if (!alive) {
      throw new AuthenticationError('Cannot reach proxy-seller API. Check your API key and network.');
    }

    // 2. Validate package
    this._log('Checking package status...');
    const pkg = await this._fetcher.fetchPackageInfo();
    if (!pkg.isActive) {
      throw new PackageInactiveError('Resident proxy package is not active. Please check your subscription.');
    }
    if (pkg.expiredAt) {
      const expiryDate = this._parseExpiry(pkg.expiredAt);
      if (expiryDate && expiryDate < new Date()) {
        throw new PackageExpiredError(`Package expired at ${pkg.expiredAt}`);
      }
    }
    this._log(`Package active. Traffic: ${this._formatBytes(pkg.trafficUsage)} / ${pkg.trafficLimit ? this._formatBytes(pkg.trafficLimit) : 'unlimited'}`);

    // 3. Fetch and validate initial proxy
    this._log('Fetching proxy list...');
    await this._fetchAndRotate();

    // 4. Start rotation timer
    this._scheduleRotation();

    // 5. Start traffic monitoring
    this._traffic.start();

    // 6. Start periodic health check
    if (this._opts.healthCheckEnabled) {
      this._startHealthCheck();
    }

    this._started = true;
    this._log('ResidentProxyManager started successfully.');
  }

  /**
   * Stop the manager: clear rotation timer, stop traffic monitor, stop health checks.
   * Does not destroy the instance — can be restarted with start().
   */
  stop() {
    this._rotation.cancelRotation();
    this._traffic.stop();
    this._stopHealthCheck();
    this._started = false;
    this._log('ResidentProxyManager stopped.');
  }

  /**
   * Get the current proxy configuration for use with puppeteer/playwright.
   *
   * If the proxy is stale (rotation interval elapsed), triggers an inline rotation
   * and returns the new proxy. If a rotation is already in progress, awaits it.
   *
   * @returns {Promise<{host: string, port: number, username: string, password: string}>}
   * @throws {Error} If start() hasn't been called
   * @throws {PackageExpiredError|PackageInactiveError} If package is no longer valid
   * @throws {NoProxiesAvailableError} If no proxy is available
   */
  async getProxy() {
    this._ensureStarted();

    // If a rotation is in progress, wait for it
    if (this._rotationPromise) {
      await this._rotationPromise;
    }

    // Check package validity
    if (!this._packageValid) {
      const pkg = this._traffic.getSnapshot();
      if (pkg && !pkg.isActive) {
        throw new PackageInactiveError();
      }
      throw new PackageExpiredError();
    }

    // If stale, trigger rotation
    if (this._rotation.isStale()) {
      this._log('Proxy is stale, triggering rotation via getProxy()...');
      await this._fetchAndRotate();
    }

    const proxy = this._rotation.getCurrentProxy();
    if (!proxy) {
      throw new NoProxiesAvailableError('No proxy available. Ensure start() completed successfully.');
    }

    return this._toProxyConfig(proxy);
  }

  /**
   * Immediately force a rotation to a new proxy, bypassing the timer.
   * Returns the new proxy configuration.
   *
   * If a rotation is already in progress, returns the existing promise.
   *
   * @returns {Promise<{host: string, port: number, username: string, password: string}>}
   */
  async forceRotation() {
    this._ensureStarted();

    if (this._rotationPromise) {
      return this._rotationPromise.then(p => this._toProxyConfig(p));
    }

    this._rotation.cancelRotation();
    const proxy = await this._fetchAndRotate();
    this._scheduleRotation();
    return this._toProxyConfig(proxy);
  }

  /**
   * Get a full status snapshot of the manager.
   *
   * @returns {Promise<object>}
   */
  async getStatus() {
    const trafficSnapshot = this._traffic.getSnapshot();
    const currentProxy = this._rotation.getCurrentProxy();

    return {
      package: trafficSnapshot || null,
      proxy: {
        current: currentProxy ? this._toProxyConfig(currentProxy) : null,
        stale: this._rotation.isStale(),
        lastRotation: this._rotation.lastRotationTime,
        timeUntilRotation: this._rotation.timeUntilRotation(),
      },
      started: this._started,
      packageValid: this._packageValid,
    };
  }

  /**
   * Fully destroy the manager: stop everything, remove all listeners, release references.
   * After destroy(), the instance is unusable.
   */
  destroy() {
    this.stop();
    this._traffic.removeAllListeners();
    this.removeAllListeners();
    this._fetcher = null;
    this._rotation = null;
    this._health = null;
    this._traffic = null;
    this._log('ResidentProxyManager destroyed.');
  }

  // ──────────────────────── Internal ────────────────────────

  /**
   * Core rotation flow: fetch proxies → select → validate → rotate.
   * Sets `_rotationPromise` to allow concurrent callers to await.
   *
   * @returns {Promise<object>} The new proxy object
   */
  async _fetchAndRotate() {
    if (this._rotationPromise) {
      return this._rotationPromise;
    }

    this._rotationPromise = this._doFetchAndRotate();
    try {
      return await this._rotationPromise;
    } finally {
      this._rotationPromise = null;
    }
  }

  async _doFetchAndRotate() {
    this._rotating = true;
    const previousProxy = this._rotation.getCurrentProxy();

    try {
      // 1. Fetch fresh proxy list
      const proxies = await this._fetcher.fetchProxies();
      this._log(`Fetched ${proxies.length} proxies matching country filter.`);

      if (proxies.length === 0) {
        const err = new NoProxiesAvailableError(
          `No proxies found for country "${this._opts.country}". Check your filters or package.`
        );
        if (previousProxy) {
          // Keep old proxy, emit error, continue
          this.emit('error', { error: err, context: 'rotation' });
          return previousProxy;
        }
        throw err;
      }

      // 2. Try to select and validate a proxy (with retries)
      const candidates = this._buildCandidateList(proxies, previousProxy);
      let lastError = null;

      for (let attempt = 0; attempt < this._opts.maxRetries; attempt++) {
        const selected = this._rotation.selectProxy(candidates);
        if (!selected) break;

        this._log(`Attempt ${attempt + 1}: Testing proxy ${selected.host}:${selected.port}...`);

        if (this._opts.healthCheckEnabled) {
          const result = await this._health.validate(selected, this._fetcher);
          if (result.valid) {
            this._log(`Proxy ${selected.host} validated (${result.latency}ms).`);
            this._rotation.rotate(selected);
            this._rotation.lastRotationTime = Date.now();
            this.emit('proxy:ready', this._toProxyConfig(selected));
            if (previousProxy) {
              this.emit('proxy:rotated', {
                previous: this._toProxyConfig(previousProxy),
                current: this._toProxyConfig(selected),
              });
            }
            return selected;
          }
          this._log(`Proxy ${selected.host} failed validation: ${result.error}`);
          lastError = result.error;
        } else {
          // No health check — accept immediately
          this._rotation.rotate(selected);
          this._rotation.lastRotationTime = Date.now();
          this.emit('proxy:ready', this._toProxyConfig(selected));
          if (previousProxy) {
            this.emit('proxy:rotated', {
              previous: this._toProxyConfig(previousProxy),
              current: this._toProxyConfig(selected),
            });
          }
          return selected;
        }
      }

      // All validation attempts failed
      if (previousProxy) {
        this._log('All proxies failed validation. Keeping current proxy.');
        this.emit('error', {
          error: new ProxyValidationError(`All ${this._opts.maxRetries} validation attempts failed: ${lastError}`),
          context: 'rotation',
        });
        return previousProxy;
      }

      throw new ProxyValidationError('All proxies failed validation and no fallback proxy exists.');
    } finally {
      this._rotating = false;
    }
  }

  /**
   * Build a candidate list for selection, preferring proxies different from the current one.
   */
  _buildCandidateList(proxies, currentProxy) {
    if (!currentProxy) return proxies;

    const different = proxies.filter(p => p.host !== currentProxy.host);
    if (different.length > 0) return different;

    // All proxies have the same IP — just use the full list
    return proxies;
  }

  /**
   * Schedule the rotation timer callback.
   */
  _scheduleRotation() {
    this._rotation.scheduleRotation(async () => {
      this._log('Rotation timer fired.');
      this._rotation.cancelRotation();
      try {
        await this._fetchAndRotate();
      } catch (err) {
        this.emit('error', { error: err, context: 'rotation-timer' });
      }
      this._scheduleRotation();
    });
  }

  /**
   * Start periodic health checks on the current proxy.
   */
  _startHealthCheck() {
    this._stopHealthCheck();
    this._healthTimerId = setInterval(async () => {
      const proxy = this._rotation.getCurrentProxy();
      if (!proxy) return;

      const result = await this._health.validate(proxy, this._fetcher);
      if (!result.valid) {
        this._log(`Periodic health check failed: ${result.error}`);
        this.emit('proxy:health-fail', {
          proxy: this._toProxyConfig(proxy),
          error: result.error,
        });

        // Trigger immediate rotation
        this._rotation.cancelRotation();
        try {
          await this._fetchAndRotate();
        } catch (err) {
          this.emit('error', { error: err, context: 'health-check-rotation' });
        }
        this._scheduleRotation();
      }
    }, this._opts.healthCheckInterval);
    if (this._healthTimerId.unref) {
      this._healthTimerId.unref();
    }
  }

  /**
   * Stop periodic health checks.
   */
  _stopHealthCheck() {
    if (this._healthTimerId) {
      clearInterval(this._healthTimerId);
      this._healthTimerId = null;
    }
  }

  /**
   * Convert internal proxy object to public config {host, port, username, password}.
   */
  _toProxyConfig(proxy) {
    return {
      host: proxy.host,
      port: proxy.port,
      username: proxy.username,
      password: proxy.password,
    };
  }

  /**
   * Ensure start() has been called.
   */
  _ensureStarted() {
    if (!this._started && this._opts.autoStart) {
      throw new Error(
        'ResidentProxyManager is still starting (autoStart is true). ' +
        'Await manager.start() explicitly, or listen for the "proxy:ready" event.'
      );
    }
    if (!this._started) {
      throw new Error('Call start() before using getProxy().');
    }
  }

  /** @param {string} msg */
  _log(msg) {
    if (this._opts.verbose) {
      process.stderr.write(`[proxy-seller-resident] ${msg}\n`);
    }
  }

  /** @param {number} bytes */
  _formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
  }

  /**
   * Parse expiry date string.
   */
  _parseExpiry(dateStr) {
    if (!dateStr) return null;
    const parts = dateStr.split(' ');
    if (parts.length >= 1) {
      const dateParts = parts[0].split('.');
      if (dateParts.length === 3) {
        const timeParts = parts[1] ? parts[1].split(':') : [0, 0, 0];
        return new Date(
          parseInt(dateParts[2], 10),
          parseInt(dateParts[1], 10) - 1,
          parseInt(dateParts[0], 10),
          parseInt(timeParts[0], 10) || 0,
          parseInt(timeParts[1], 10) || 0,
          parseInt(timeParts[2], 10) || 0
        );
      }
    }
    return new Date(dateStr);
  }
}