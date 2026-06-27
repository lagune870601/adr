import net from 'node:net';

/**
 * Dual-validation proxy health checker.
 *
 * 1. Server-side check: calls proxy-seller's proxyCheck() API to verify
 *    the proxy is alive and routable from their infrastructure.
 * 2. Local TCP check: opens a TCP connection to the proxy host:port from
 *    the local machine to verify firewall/network reachability.
 *
 * A proxy is considered valid only if BOTH checks pass.
 */
export class HealthChecker {
  /**
   * @param {object} options
   * @param {number} [options.timeout=5000] - Timeout in ms for each check
   * @param {string} [options.protocol='http'] - 'http' or 'socks5'
   * @param {boolean} [options.skipServerCheck=false] - Skip server-side proxyCheck (use for resident proxies)
   */
  constructor(options = {}) {
    this.timeout = options.timeout ?? 5000;
    this.protocol = options.protocol || 'http';
    this.skipServerCheck = options.skipServerCheck === true;
  }

  /**
   * Run both server-side and local validation checks concurrently.
   * A proxy is valid only if both checks pass.
   * Falls back to local-only if server check fails with an unsupported proxy type
   * (e.g., resident gateway proxies don't support proxyCheck).
   *
   * @param {object} proxyConfig - {host, port, username, password}
   * @param {object} fetcher - ProxyFetcher instance (for serverCheck)
   * @returns {Promise<{valid: boolean, latency: number|null, serverValid: boolean, localValid: boolean, error: string|null}>}
   */
  async validate(proxyConfig, fetcher) {
    // For resident proxies, skip server-side proxyCheck (not supported for gateways)
    if (this.skipServerCheck) {
      const localResult = await this.localCheck(proxyConfig);
      return {
        valid: localResult.valid,
        latency: localResult.latency,
        serverValid: true,
        localValid: localResult.valid,
        error: localResult.valid ? null : `Local check failed: ${localResult.error}`,
      };
    }

    const [serverResult, localResult] = await Promise.allSettled([
      this.serverCheck(proxyConfig, fetcher),
      this.localCheck(proxyConfig),
    ]);

    const localValid = localResult.status === 'fulfilled' && localResult.value.valid;
    let serverValid = serverResult.status === 'fulfilled' && serverResult.value.valid;

    // If server check failed with "not found" or similar, the proxy type
    // (e.g. resident gateway) doesn't support proxyCheck. Fall back to local-only.
    const serverError = serverResult.status === 'fulfilled' ? serverResult.value.error : (serverResult.reason?.message || '');
    const serverCheckUnsupported = serverError && (
      serverError.includes('not found') ||
      serverError.includes('not supported') ||
      serverError.includes('Not found')
    );

    const valid = serverCheckUnsupported ? localValid : (serverValid && localValid);

    // Collect error info
    let error = null;
    if (!valid) {
      if (!localValid) {
        const reason = localResult.status === 'fulfilled' ? localResult.value.error : localResult.reason?.message;
        error = `Local check failed: ${reason || 'unknown'}`;
      } else if (!serverValid && !serverCheckUnsupported) {
        const reason = serverResult.status === 'fulfilled' ? serverResult.value.error : serverResult.reason?.message;
        error = `Server check failed: ${reason || 'unknown'}`;
      }
    }

    const latency = serverResult.status === 'fulfilled' ? serverResult.value.latency : null;

    return { valid, latency, serverValid: serverCheckUnsupported ? true : serverValid, localValid, error };
  }

  /**
   * Server-side proxy check via proxy-seller API.
   *
   * @param {object} proxyConfig - {host, port, username, password}
   * @param {object} fetcher - ProxyFetcher instance
   * @returns {Promise<{valid: boolean, latency: number, error: string|null}>}
   */
  async serverCheck(proxyConfig, fetcher) {
    const proxyString = `${proxyConfig.username}:${proxyConfig.password}@${proxyConfig.host}:${proxyConfig.port}`;

    try {
      const result = await fetcher.checkProxy(proxyString);
      return {
        valid: result.valid,
        latency: result.time,
        error: result.valid ? null : 'Proxy marked invalid by server',
      };
    } catch (err) {
      return {
        valid: false,
        latency: null,
        error: err.message || 'Server check threw an error',
      };
    }
  }

  /**
   * Local TCP connectivity check.
   * Opens a TCP socket to the proxy host:port to verify local reachability.
   *
   * @param {object} proxyConfig - {host, port}
   * @returns {Promise<{valid: boolean, latency: number, error: string|null}>}
   */
  localCheck(proxyConfig) {
    const startTime = Date.now();

    return new Promise((resolve) => {
      const socket = new net.Socket();
      let settled = false;

      const finish = (valid, error) => {
        if (settled) return;
        settled = true;
        const latency = Date.now() - startTime;
        socket.destroy();
        resolve({ valid, latency, error });
      };

      socket.setTimeout(this.timeout);

      socket.on('connect', () => {
        finish(true, null);
      });

      socket.on('timeout', () => {
        finish(false, `Connection timed out after ${this.timeout}ms`);
      });

      socket.on('error', (err) => {
        finish(false, err.message || 'Connection error');
      });

      socket.connect(proxyConfig.port, proxyConfig.host);
    });
  }
}