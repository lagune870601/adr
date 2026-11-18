/**
 * mnd-pac — 本地 PAC 服务：仅 mnd 域名走上游 SOCKS5，其余直连
 *
 * Chrome 不支持 file:// 形式的 PAC，且 PAC 只能按主机名路由、不能携带认证，
 * 因此由本地 HTTP 服务提供 PAC 内容。每轮浏览器启动前用不同的 PAC URL
 * （带 nonce）指向该轮获取的代理，避免 Chrome 复用缓存的 PAC。
 */

import http from 'http';

const PAC_HOST = '127.0.0.1';
const PROXY_HOST_RE = /^[0-9a-zA-Z.-]+$/;

// 额外放行的域名：主机名不含 mnd，但广告素材需要加载
const EXTRA_ALLOWED_HOSTS = new Set([
    'icon.dt.ssnhmnc.com',
]);

/** 放行主机名包含 mnd 的域名，以及显式白名单中的域名（大小写不敏感） */
export function isMndHost(host) {
    if (!host) return false;
    const h = host.toLowerCase();
    return h.includes('mnd') || EXTRA_ALLOWED_HOSTS.has(h);
}

/**
 * 启动 PAC 服务。
 * @returns {Promise<{pacUrlFor: (proxy: {host: string, port: number}) => string, close: () => void}>}
 */
export async function startMndPac() {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://${PAC_HOST}`);
        const proxyHost = url.searchParams.get('host') || '';
        const proxyPort = parseInt(url.searchParams.get('port'), 10);

        if (!PROXY_HOST_RE.test(proxyHost) || !Number.isInteger(proxyPort) ||
            proxyPort < 1 || proxyPort > 65535) {
            res.writeHead(400, { 'content-type': 'text/plain' });
            res.end('invalid proxy');
            return;
        }

        const extraCond = [...EXTRA_ALLOWED_HOSTS]
            .map(h => `host.toLowerCase() === '${h}'`)
            .join(' || ');
        const rule = `host.toLowerCase().indexOf('mnd') !== -1${extraCond ? ` || ${extraCond}` : ''}`;
        const pac = `function FindProxyForURL(url, host) {
  if (${rule}) return 'SOCKS5 ${proxyHost}:${proxyPort}';
  return 'DIRECT';
}`;

        res.writeHead(200, {
            'content-type': 'application/x-ns-proxy-autoconfig',
            'cache-control': 'no-store',
        });
        res.end(pac);
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, PAC_HOST, resolve);
    });
    const port = server.address().port;
    let seq = 0;

    return {
        /** 为一次浏览器启动生成 PAC 地址；nonce 保证每次重新拉取 */
        pacUrlFor(proxy) {
            const qs = new URLSearchParams({
                host: proxy.host,
                port: String(proxy.port),
                v: `${Date.now()}-${++seq}`,
            });
            return `http://${PAC_HOST}:${port}/proxy.pac?${qs}`;
        },
        close() {
            server.close();
        },
    };
}