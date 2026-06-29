import { ResidentProxyManager } from '../proxy.js';

const PROXY_API_KEY = '629a2e2ce2532c8c4ad034fbc4f3c8a5';

/**
 * 创建并启动一个 ResidentProxyManager，返回代理信息和管理器实例
 * @param {object} [options] - 覆盖默认的代理配置
 * @returns {{ proxy: { host, port, username, password }, manager: ResidentProxyManager }}
 */
export async function createProxy(options = {}) {
    console.log('🔌 获取代理...');

    const manager = new ResidentProxyManager({
        apiKey: PROXY_API_KEY,
        country: 'US',
        rotationInterval: 30 * 60 * 1000,
        protocol: 'http',
        verbose: true,
        ...options,
    });

    manager.on('proxy:ready', (proxy) => {
        console.log(`   ✅ 代理就绪: ${proxy.host}:${proxy.port}`);
    });

    manager.on('error', ({ error }) => {
        console.warn(`   ⚠️  代理错误: ${error.message}`);
    });

    await manager.start();
    const proxy = await manager.getProxy();
    console.log(`   📡 代理地址: ${proxy.host}:${proxy.port}`);
    console.log(`   👤 代理账号: ${proxy.username}`);

    return { proxy, manager };
}