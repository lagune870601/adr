import { ApiError, AuthenticationError } from './errors.js';

/**
 * Country name/alpha-2 → alpha-3 lookup for common countries.
 * Extended as needed.
 */
const COUNTRY_TO_ALPHA3 = {
  'US': 'USA', 'USA': 'USA', 'UNITED STATES': 'USA', 'UNITED STATES OF AMERICA': 'USA',
  'GB': 'GBR', 'GBR': 'GBR', 'UNITED KINGDOM': 'GBR', 'UK': 'GBR',
  'DE': 'DEU', 'DEU': 'DEU', 'GERMANY': 'DEU',
  'FR': 'FRA', 'FRA': 'FRA', 'FRANCE': 'FRA',
  'CA': 'CAN', 'CAN': 'CAN', 'CANADA': 'CAN',
  'JP': 'JPN', 'JPN': 'JPN', 'JAPAN': 'JPN',
  'AU': 'AUS', 'AUS': 'AUS', 'AUSTRALIA': 'AUS',
  'BR': 'BRA', 'BRA': 'BRA', 'BRAZIL': 'BRA',
  'IN': 'IND', 'IND': 'IND', 'INDIA': 'IND',
  'NL': 'NLD', 'NLD': 'NLD', 'NETHERLANDS': 'NLD',
  'SG': 'SGP', 'SGP': 'SGP', 'SINGAPORE': 'SGP',
  'KR': 'KOR', 'KOR': 'KOR', 'SOUTH KOREA': 'KOR', 'KOREA': 'KOR',
  'RU': 'RUS', 'RUS': 'RUS', 'RUSSIA': 'RUS',
  'CN': 'CHN', 'CHN': 'CHN', 'CHINA': 'CHN',
  'IT': 'ITA', 'ITA': 'ITA', 'ITALY': 'ITA',
  'ES': 'ESP', 'ESP': 'ESP', 'SPAIN': 'ESP',
};

/**
 * Wraps proxy-seller SDK calls for resident proxies.
 *
 * Resident proxies use a gateway model:
 * 1. residentList() — returns IP lists with geo config
 * 2. proxyDownload('resident', ...) — returns gateway endpoints as text
 * 3. Each line in the download is: login:password@host:port
 *
 * - Normalizes field names (snake_case → camelCase)
 * - Filters proxy lists by country
 * - Retries API calls with exponential backoff
 */
export class ProxyFetcher {
  /**
   * @param {object} sdkClient - Instance of ProxySellerUserApi
   * @param {object} options
   * @param {string} [options.country='US'] - Country filter (alpha-2, alpha-3, or full name)
   * @param {number} [options.listId] - Specific resident list ID (optional)
   * @param {string} [options.protocol='http'] - 'http' or 'socks5'
   * @param {number} [options.maxRetries=3] - Max API call retries
   * @param {number} [options.retryDelay=1000] - Base retry delay in ms
   */
  constructor(sdkClient, options = {}) {
    this.sdk = sdkClient;
    this.country = options.country || 'US';
    this.listId = options.listId || null;
    this.protocol = options.protocol || 'http';
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelay = options.retryDelay ?? 1000;

    // Normalize country to alpha-2 for matching (resident lists use alpha-2 in geo)
    const key = this.country.toUpperCase().trim();
    this._countryAlpha2 = COUNTRY_TO_ALPHA3[key] ? key : this.country.toUpperCase();
  }

  /**
   * Retry wrapper with exponential backoff.
   * Does NOT retry on authentication errors (4xx).
   */
  async _retry(fn, label = 'API call') {
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const delay = this.retryDelay * Math.pow(2, attempt - 1) * (0.5 + Math.random() * 0.5);
          await new Promise(r => setTimeout(r, delay));
        }
        return await fn();
      } catch (err) {
        lastError = err;
        // Check for authentication errors — do not retry
        const msg = (err.message || '').toLowerCase();
        const responseStatus = err.response?.status;
        if (responseStatus === 401 || responseStatus === 403 || msg.includes('unauthorized') || msg.includes('invalid key')) {
          throw new AuthenticationError(err.message, { originalError: err });
        }
        // Do not retry on other 4xx errors
        if (responseStatus && responseStatus >= 400 && responseStatus < 500) {
          throw new ApiError(`${label}: ${err.message}`, { originalError: err, status: responseStatus });
        }
      }
    }
    throw new ApiError(`${label} failed after ${this.maxRetries + 1} attempts: ${lastError.message}`, {
      originalError: lastError,
      attempts: this.maxRetries + 1,
    });
  }

  /**
   * Fetch resident proxies by:
   * 1. Getting the list of IP lists (residentList)
   * 2. Filtering by country (geo.country)
   * 3. Downloading the gateway endpoints (proxyDownload)
   * 4. Parsing the text into proxy config objects
   *
   * @returns {Promise<Array<{host: string, port: number, username: string, password: string, listId: number, listTitle: string, country: string}>>}
   */
  async fetchProxies() {
    // 1. Get resident lists
    const lists = await this.fetchLists();

    // 2. Filter by country and/or specific listId
    let filteredLists = lists;

    if (this.listId) {
      filteredLists = filteredLists.filter(l => l.id === this.listId);
    }

    if (this._countryAlpha2) {
      filteredLists = filteredLists.filter(l => {
        // If list has no geo data, include it (gateway handles routing)
        if (!l.geo || l.geo.length === 0) return true;
        // Match by country alpha-2 code
        return l.geo.some(g => (g.country || '').toUpperCase() === this._countryAlpha2);
      });
    }

    if (filteredLists.length === 0) {
      return [];
    }

    // 3. Download proxy endpoints for each list
    const allProxies = [];
    for (const list of filteredLists) {
      try {
        const text = await this._retry(
          () => this.sdk.proxyDownload('resident', 'txt', '', list.id),
          `proxyDownload(resident, listId=${list.id})`
        );
        const parsed = this._parseDownloadText(text, list);
        allProxies.push(...parsed);
      } catch (err) {
        // Skip failed downloads for individual lists, try the rest
        if (err instanceof ApiError) {
          continue;
        }
        throw err;
      }
    }

    return allProxies;
  }

  /**
   * Parse the proxy download text format into proxy config objects.
   *
   * Format: login:password@host:port  (one per line)
   * Each line is a different port on the same gateway with the same auth.
   *
   * @param {string} text - Raw download text
   * @param {object} list - The resident list metadata
   * @returns {Array<object>}
   */
  _parseDownloadText(text, list) {
    if (!text || typeof text !== 'string') return [];

    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const proxies = [];

    for (const line of lines) {
      // Parse: username:password@host:port
      const match = line.match(/^([^:]+):(.+?)@(.+?):(\d+)$/);
      if (match) {
        const port = parseInt(match[4], 10);
        proxies.push({
          host: match[3],
          port: port,
          username: match[1],
          password: match[2],
          listId: list.id,
          listTitle: list.title,
          country: (list.geo && list.geo[0]?.country) || '',
        });
      }
    }

    return proxies;
  }

  /**
   * Fetch resident package info.
   * @returns {Promise<{isActive: boolean, rotation: number, tarifId: number, trafficLimit: number, trafficUsage: number, trafficLeft: number, expiredAt: string, autoRenew: boolean}>}
   */
  async fetchPackageInfo() {
    const raw = await this._retry(() => this.sdk.residentPackage(), 'residentPackage');

    return {
      isActive: raw.is_active === true || raw.is_active === '1' || raw.is_active === 1,
      rotation: parseInt(raw.rotation, 10) || 0,
      tarifId: parseInt(raw.tarif_id, 10) || 0,
      trafficLimit: parseInt(raw.traffic_limit, 10) || 0,
      trafficUsage: parseInt(raw.traffic_usage, 10) || 0,
      trafficLeft: parseInt(raw.traffic_left, 10) || 0,
      expiredAt: raw.expired_at || '',
      autoRenew: raw.auto_renew === true || raw.auto_renew === '1' || raw.auto_renew === 1,
    };
  }

  /**
   * Fetch resident IP lists with geo info.
   * @returns {Promise<Array<{id: number, title: string, login: string, password: string, rotation: number, geo: Array<{country: string, region: string, city: string}>}>>}
   */
  async fetchLists() {
    const raw = await this._retry(() => this.sdk.residentList(), 'residentList');
    if (!Array.isArray(raw)) return [];
    return raw.map(item => ({
      id: item.id || 0,
      title: item.title || '',
      login: item.login || '',
      password: item.password || '',
      rotation: parseInt(item.rotation, 10) || 0,
      geo: Array.isArray(item.geo) ? item.geo.map(g => ({
        country: (g.country || '').toUpperCase(),
        region: g.region || '',
        city: g.city || '',
      })) : [],
    }));
  }

  /**
   * Check a single proxy's validity via the proxy-seller API.
   * @param {string} proxyString - e.g. "user:password@host:port"
   * @returns {Promise<{valid: boolean, ip: string, port: number, protocol: string, time: number}>}
   */
  async checkProxy(proxyString) {
    const raw = await this._retry(() => this.sdk.proxyCheck(proxyString), 'proxyCheck');
    return {
      valid: raw.valid === true || raw.valid === 'true',
      ip: raw.ip || '',
      port: parseInt(raw.port, 10) || 0,
      protocol: raw.protocol || '',
      time: parseInt(raw.time, 10) || 0,
    };
  }

  /**
   * Check API availability.
   * @returns {Promise<boolean>}
   */
  async ping() {
    try {
      const result = await this._retry(() => this.sdk.ping(), 'ping');
      return !!result;
    } catch {
      return false;
    }
  }
}