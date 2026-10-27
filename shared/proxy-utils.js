import ProxySellerUserApi from 'proxy-seller-user-api';

const PROXY_API_KEY = 'k8mjLdpotEiL';

// 重试配置
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

/**
 * 判断错误是否可重试（5xx 服务端错误 或 网络错误）
 */
function isRetryableError(err) {
    // Axios 5xx 错误
    const status = err.response?.status;
    if (status && status >= 500 && status < 600) return true;
    // 网络错误
    const code = err.code;
    if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' ||
        code === 'ENOTFOUND' || code === 'EAI_AGAIN') return true;
    // 消息中包含常见网络错误
    const msg = (err.message || '').toLowerCase();
    if (msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('socket hang up')) return true;
    return false;
}

/**
 * 带指数退避的重试包装器
 * @param {() => Promise<any>} fn - 要执行的异步函数
 * @param {string} label - 日志标签
 * @param {number} [maxRetries=MAX_RETRIES] - 最大重试次数
 * @returns {Promise<any>}
 */
async function retryWithBackoff(fn, label, maxRetries = MAX_RETRIES) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            if (attempt > 0) {
                // 指数退避 + 随机抖动
                const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1) * (0.5 + Math.random() * 0.5);
                console.log(`   🔄 [${label}] 第 ${attempt} 次重试，等待 ${(delay / 1000).toFixed(1)}s...`);
                await new Promise(r => setTimeout(r, delay));
            }
            return await fn();
        } catch (err) {
            lastError = err;
            // 不可重试的错误直接抛出
            if (!isRetryableError(err)) {
                throw err;
            }
            if (attempt === maxRetries) {
                console.log(`   ❌ [${label}] 重试 ${maxRetries} 次后仍失败`);
                throw err;
            }
            const status = err.response?.status || 'network';
            console.log(`   ⚠️  [${label}] 服务端错误 (${status})，将重试...`);
        }
    }
    throw lastError;
}

/**
 * 使用 proxy-seller SDK 直接获取住宅代理
 *
 * 参考: https://github.com/proxy-seller/user-api-nodejs
 *
 * @param {object} [options]
 * @param {string} [options.apiKey] - API Key，不传则使用默认值
 * @param {string} [options.country='US'] - 国家过滤 (alpha-2)
 * @param {number} [options.listId] - 指定 resident list ID，不传则按 country 自动匹配
 * @param {string} [options.protocol='http'] - 协议 (http / socks5)
 * @returns {Promise<{ proxy: {host, port, username, password}, manager: object }>}
 */
export async function createProxyFromAPI(options = {}) {
    const {
        apiKey = PROXY_API_KEY,
        country = 'US',
        listId = 20858948,
        protocol = 'http',
    } = options;

    console.log('🔌 获取代理...');

    // 1. 初始化 SDK
    const sdk = new ProxySellerUserApi({ key: apiKey });
    sdk.setPaymentId(1);
    sdk.setGenerateAuth('N');

    // 2. 验证 API 连通性（带重试）
    console.log('   🌐 检查 API 连通性...');
    await retryWithBackoff(() => sdk.ping(), 'ping');
    console.log('   ✅ API 连接正常');

    // 3. 检查套餐状态（带重试）
    console.log('   📦 检查套餐状态...');
    const pkg = await retryWithBackoff(() => sdk.residentPackage(), 'residentPackage');
    if (!pkg.is_active) {
        throw new Error('代理套餐未激活，请检查订阅状态');
    }
    const usedGB = (pkg.traffic_usage / 1024 / 1024 / 1024).toFixed(2);
    const limitGB = pkg.traffic_limit > 0
        ? (pkg.traffic_limit / 1024 / 1024 / 1024).toFixed(2) + ' GB'
        : '无限';
    console.log(`   ✅ 套餐活跃 | 已用: ${usedGB} GB / ${limitGB}`);

    // 4. 获取 resident lists（带重试）
    console.log('   📋 获取代理列表...');
    const lists = await retryWithBackoff(() => sdk.residentList(), 'residentList');
    if (!Array.isArray(lists) || lists.length === 0) {
        throw new Error('未找到任何住宅代理列表');
    }
    console.log(`   📋 共 ${lists.length} 个代理列表`);

    // 5. 匹配目标列表
    let targetList = null;

    // 优先按 listId 精确匹配
    if (listId) {
        targetList = lists.find(l => l.id === listId);
        if (!targetList) {
            console.log(`   ⚠️  未找到 listId=${listId}，尝试按国家匹配...`);
        }
    }

    // 按国家匹配
    if (!targetList && country) {
        const countryUpper = country.toUpperCase().trim();
        targetList = lists.find(l => {
            if (!l.geo || !Array.isArray(l.geo) || l.geo.length === 0) return false;
            return l.geo.some(g => (g.country || '').toUpperCase() === countryUpper);
        });
    }

    // 兜底：使用第一个列表
    if (!targetList) {
        targetList = lists[0];
        console.log(`   ⚠️  未精确匹配，使用默认列表`);
    }

    console.log(`   🎯 选中列表: "${targetList.title}" (ID: ${targetList.id})`);

    // 6. 下载代理端点（带重试）
    const protoParam = protocol === 'socks5' ? 'socks5' : '';
    const proxyText = await retryWithBackoff(
        () => sdk.proxyDownload('resident', 'txt', protoParam, targetList.id),
        'proxyDownload'
    );

    if (!proxyText || typeof proxyText !== 'string') {
        throw new Error('代理下载返回空数据');
    }

    // 7. 解析并随机选取一个代理
    const lines = proxyText.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) {
        throw new Error('代理列表为空');
    }
    console.log(`   📡 获取到 ${lines.length} 个代理端点`);

    // 随机选取
    const line = lines[Math.floor(Math.random() * lines.length)];
    const match = line.match(/^([^:]+):(.+?)@(.+?):(\d+)$/);
    if (!match) {
        throw new Error(`无法解析代理地址: ${line}`);
    }

    const proxy = {
        host: match[3],
        port: parseInt(match[4], 10),
        username: match[1],
        password: match[2],
    };

    console.log(`   📡 代理地址: ${proxy.host}:${proxy.port}`);
    console.log(`   👤 代理账号: ${proxy.username}`);

    // 8. 构造 manager 对象（保持向后兼容）
    const manager = {
        _sdk: sdk,
        stop() {},
        destroy() {},
        async getProxy() {
            return proxy;
        },
        async getStatus() {
            return { started: true, packageValid: true, proxy: { current: proxy } };
        },
    };

    return { proxy, manager };
}

// ──────────────────────── 固定代理 ────────────────────────

const FIXED_PROXY_URL = 'socks5://chenchao:chenchao@104.233.202.50:17891';
const FIXED_PROXY_HOST = '104.233.202.50';
const FIXED_PROXY_PORT = 17891;
const FIXED_NAME = "chenchao";
const FIXED_PWD = "chenchao";

/**
 * 使用固定 SOCKS5 代理（替代 Proxy-Seller API）
 *
 * 原 createProxyFromAPI 保留但不再使用，如需切换回 API 方式，
 * 将下方 createProxy 改为调用 createProxyFromAPI 即可。
 *
 * @returns {Promise<{ proxy: {url, host, port, username, password}, manager: object }>}
 */
export async function createProxy(_options = {}) {
    console.log('🔌 使用固定代理...');

    const proxy = {
        url: FIXED_PROXY_URL,
        host: FIXED_PROXY_HOST,
        port: FIXED_PROXY_PORT,
        username: FIXED_NAME,
        password: FIXED_PWD,
    };

    console.log(`   📡 代理地址: ${proxy.host}:${proxy.port} (SOCKS5)`);

    const manager = {
        stop() {},
        destroy() {},
        async getProxy() {
            return proxy;
        },
        async getStatus() {
            return { started: true, packageValid: true, proxy: { current: proxy } };
        },
    };

    return { proxy, manager };
}