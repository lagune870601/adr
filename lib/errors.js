/**
 * Custom error classes for proxy-seller-resident module.
 */

export class ProxySellersError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {object} [context={}]
   */
  constructor(message, code, context = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.context = context;
    Error.captureStackTrace(this, this.constructor);
  }
}

/** SDK/network failures after retry exhaustion */
export class ApiError extends ProxySellersError {
  constructor(message, context = {}) {
    super(message, 'API_ERROR', context);
  }
}

/** Invalid or revoked API key */
export class AuthenticationError extends ProxySellersError {
  constructor(message = 'Invalid API key. Check your key at https://proxy-seller.com/personal/api/', context = {}) {
    super(message, 'AUTHENTICATION_ERROR', context);
  }
}

/** Resident package has expired */
export class PackageExpiredError extends ProxySellersError {
  constructor(message = 'Resident proxy package has expired', context = {}) {
    super(message, 'PACKAGE_EXPIRED', context);
  }
}

/** Resident package is not active */
export class PackageInactiveError extends ProxySellersError {
  constructor(message = 'Resident proxy package is not active', context = {}) {
    super(message, 'PACKAGE_INACTIVE', context);
  }
}

/** No proxies available matching the configured filters */
export class NoProxiesAvailableError extends ProxySellersError {
  constructor(message = 'No proxies available matching the configured filters', context = {}) {
    super(message, 'NO_PROXIES_AVAILABLE', context);
  }
}

/** All proxies failed health check validation */
export class ProxyValidationError extends ProxySellersError {
  constructor(message = 'All proxies failed health check validation', context = {}) {
    super(message, 'PROXY_VALIDATION_ERROR', context);
  }
}

/** Traffic has been fully depleted */
export class TrafficDepletedError extends ProxySellersError {
  constructor(message = 'Proxy traffic has been fully depleted', context = {}) {
    super(message, 'TRAFFIC_DEPLETED', context);
  }
}