/**
 * proxy-seller-resident — Reusable resident proxy module for Node.js
 *
 * @example
 * ```js
 * import { ResidentProxyManager } from 'proxy-seller-resident';
 *
 * const manager = new ResidentProxyManager({
 *   apiKey: 'YOUR_API_KEY',
 *   country: 'US',
 *   rotationInterval: 30 * 60 * 1000, // 30 minutes
 * });
 *
 * manager.on('proxy:ready', (proxy) => console.log('Proxy ready:', proxy));
 * manager.on('proxy:rotated', ({ previous, current }) => console.log('Rotated'));
 * manager.on('traffic:warning', (data) => console.warn('Traffic low!', data));
 * manager.on('error', ({ error }) => console.error('Error:', error.message));
 *
 * await manager.start();
 * const proxy = await manager.getProxy();
 * // { host: '1.2.3.4', port: 1234, username: 'user', password: 'pass' }
 * ```
 */

export { ResidentProxyManager } from './lib/ResidentProxyManager.js';
export {
  ProxySellersError,
  ApiError,
  AuthenticationError,
  PackageExpiredError,
  PackageInactiveError,
  NoProxiesAvailableError,
  ProxyValidationError,
  TrafficDepletedError,
} from './lib/errors.js';