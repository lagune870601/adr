/**
 * mnd-pac — 本地 PAC 服务：仅 mnd 域名走上游 SOCKS5，其余直连
 *
 * Chrome 不支持 file:// 形式的 PAC，且 PAC 只能按主机名路由、不能携带认证，
 * 因此由本地 HTTP 服务提供 PAC 内容。要求上游 SOCKS5 免认证。
 */

import http from 'http';

const PAC_HOST = '127.0.0.1';

/** 仅放行主机名包含 mnd 的域名（含子域名，大小写不敏感） */
export function isMndHost(host) {
    return !!host && host.toLowerCase().includes('mnd');
}

/**
 * 启动 PAC 服务。
 * @returns {Promise<{pacUrl: string, close: () => void}>}
 */
export async function startMndPac(proxy) {
    const pac = `function FindProxyForURL(url, host) {
  if (host.toLowerCase().indexOf('mnd') !== -1) return 'SOCKS5 ${proxy.host}:${proxy.port}';
  return 'DIRECT';
}`;

    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/x-ns-proxy-autoconfig' });
        res.end(pac);
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, PAC_HOST, resolve);
    });

    return {
        pacUrl: `http://${PAC_HOST}:${server.address().port}/proxy.pac`,
        close() {
            server.close();
        },
    };
}