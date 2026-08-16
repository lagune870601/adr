/**
 * proxy-seller-resident — 使用 proxy-seller SDK 直接获取住宅代理
 *
 * 参考: https://github.com/proxy-seller/user-api-nodejs
 *
 * @example
 * ```js
 * import { ResidentProxyManager } from './proxy.js';
 *
 * const manager = new ResidentProxyManager({
 *   apiKey: 'YOUR_API_KEY',
 *   country: 'US',
 * });
 *
 * await manager.start();
 * const proxy = await manager.getProxy();
 * // { host: '1.2.3.4', port: 1234, username: 'user', password: 'pass' }
 * ```
 */

import ProxySellerUserApi from 'proxy-seller-user-api';

// ──────────────────────── 重试工具 ────────────────────────

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

/**
 * 判断错误是否可重试（5xx 服务端错误 或 网络错误）
 */
function isRetryableError(err) {
    const status = err.response?.status;
    if (status && status >= 500 && status < 600) return true;
    const code = err.code;
    if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' ||
        code === 'ENOTFOUND' || code === 'EAI_AGAIN') return true;
    const msg = (err.message || '').toLowerCase();
    if (msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('socket hang up')) return true;
    return false;
}

/**
 * 带指数退避的重试包装器
 */
async function retryWithBackoff(fn, label, logFn, maxRetries = MAX_RETRIES) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            if (attempt > 0) {
                const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1) * (0.5 + Math.random() * 0.5);
                logFn(`[${label}] 第 ${attempt} 次重试，等待 ${(delay / 1000).toFixed(1)}s...`);
                await new Promise(r => setTimeout(r, delay));
            }
            return await fn();
        } catch (err) {
            lastError = err;
            if (!isRetryableError(err)) throw err;
            if (attempt === maxRetries) {
                logFn(`[${label}] 重试 ${maxRetries} 次后仍失败`);
                throw err;
            }
            const status = err.response?.status || 'network';
            logFn(`[${label}] 服务端错误 (${status})，将重试...`);
        }
    }
    throw lastError;
}

// ──────────────────────── ResidentProxyManager ────────────────────────

export class ResidentProxyManager {
    /**
     * @param {object} options
     * @param {string} options.apiKey - [必填] Proxy-seller API key
     * @param {string} [options.country='US'] - 国家过滤
     * @param {number} [options.listId] - 指定 resident list ID
     * @param {string} [options.protocol='http'] - 协议 (http / socks5)
     * @param {number} [options.rotationInterval] - 保留参数，简洁版不使用
     * @param {boolean} [options.verbose=false] - 是否打印详细日志
     */
    constructor(options = {}) {
        if (!options.apiKey) {
            throw new Error('options.apiKey is required. Get your key at https://proxy-seller.com/personal/api/');
        }

        this._apiKey = options.apiKey;
        this._country = options.country || 'US';
        this._listId = options.listId || null;
        this._protocol = options.protocol || 'http';
        this._verbose = options.verbose === true;

        /** @type {object|null} */
        this._proxy = null;

        /** @type {ProxySellerUserApi|null} */
        this._sdk = null;

        this._started = false;
    }

    /**
     * 启动管理器：验证 API、检查套餐、获取代理
     * @returns {Promise<void>}
     */
    async start() {
        if (this._started) return;

        this._log('启动 ResidentProxyManager...');

        // 1. 初始化 SDK
        this._sdk = new ProxySellerUserApi({ key: this._apiKey });
        this._sdk.setPaymentId(1);
        this._sdk.setGenerateAuth('N');

        // 2. 验证 API 连通性（带重试）
        this._log('检查 API 连通性...');
        await retryWithBackoff(() => this._sdk.ping(), 'ping', msg => this._log(msg));
        this._log('API 连接正常');

        // 3. 检查套餐状态（带重试）
        this._log('检查套餐状态...');
        const pkg = await retryWithBackoff(() => this._sdk.residentPackage(), 'residentPackage', msg => this._log(msg));
        if (!pkg.is_active) {
            throw new Error('代理套餐未激活，请检查订阅状态');
        }
        const usedGB = (pkg.traffic_usage / 1024 / 1024 / 1024).toFixed(2);
        const limitGB = pkg.traffic_limit > 0
            ? (pkg.traffic_limit / 1024 / 1024 / 1024).toFixed(2) + ' GB'
            : '无限';
        this._log(`套餐活跃 | 已用: ${usedGB} GB / ${limitGB}`);

        // 4. 获取 resident lists（带重试）
        this._log('获取代理列表...');
        const lists = await retryWithBackoff(() => this._sdk.residentList(), 'residentList', msg => this._log(msg));
        if (!Array.isArray(lists) || lists.length === 0) {
            throw new Error('未找到任何住宅代理列表');
        }
        this._log(`共 ${lists.length} 个代理列表`);

        // 5. 匹配目标列表
        let targetList = null;

        if (this._listId) {
            targetList = lists.find(l => l.id === this._listId);
            if (!targetList) {
                this._log(`未找到 listId=${this._listId}，尝试按国家匹配...`);
            }
        }

        if (!targetList && this._country) {
            const countryUpper = this._country.toUpperCase().trim();
            targetList = lists.find(l => {
                if (!l.geo || !Array.isArray(l.geo) || l.geo.length === 0) return false;
                return l.geo.some(g => (g.country || '').toUpperCase() === countryUpper);
            });
        }

        if (!targetList) {
            targetList = lists[0];
            this._log('未精确匹配，使用默认列表');
        }

        this._log(`选中列表: "${targetList.title}" (ID: ${targetList.id})`);

        // 6. 下载代理端点（带重试）
        const protoParam = this._protocol === 'socks5' ? 'socks5' : '';
        const proxyText = await retryWithBackoff(
            () => this._sdk.proxyDownload('resident', 'txt', protoParam, targetList.id),
            'proxyDownload',
            msg => this._log(msg)
        );

        if (!proxyText || typeof proxyText !== 'string') {
            throw new Error('代理下载返回空数据');
        }

        // 7. 解析并随机选取
        const lines = proxyText.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length === 0) {
            throw new Error('代理列表为空');
        }
        this._log(`获取到 ${lines.length} 个代理端点`);

        const line = lines[Math.floor(Math.random() * lines.length)];
        const match = line.match(/^([^:]+):(.+?)@(.+?):(\d+)$/);
        if (!match) {
            throw new Error(`无法解析代理地址: ${line}`);
        }

        this._proxy = {
            host: match[3],
            port: parseInt(match[4], 10),
            username: match[1],
            password: match[2],
        };

        this._started = true;
        this._log(`代理就绪: ${this._proxy.host}:${this._proxy.port}`);
    }

    /**
     * 获取当前代理配置
     * @returns {Promise<{host: string, port: number, username: string, password: string}>}
     */
    async getProxy() {
        if (!this._started) {
            throw new Error('请先调用 start()');
        }
        if (!this._proxy) {
            throw new Error('代理未就绪');
        }
        return { ...this._proxy };
    }

    /**
     * 停止管理器
     */
    stop() {
        this._started = false;
        this._log('已停止');
    }

    /**
     * 销毁管理器，释放资源
     */
    destroy() {
        this.stop();
        this._sdk = null;
        this._proxy = null;
        this._log('已销毁');
    }

    /**
     * 获取状态快照
     * @returns {Promise<object>}
     */
    async getStatus() {
        return {
            started: this._started,
            packageValid: true,
            proxy: { current: this._proxy },
        };
    }

    /** @param {string} msg */
    _log(msg) {
        if (this._verbose) {
            process.stderr.write(`[proxy-seller] ${msg}\n`);
        }
    }
}

// 重新导出错误类（保持向后兼容）
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