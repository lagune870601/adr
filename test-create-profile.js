/**
 * test-create-profile.js — 测试创建 AdsPower 环境
 * 创建一个带固定代理的环境，保持打开让你检查，按 Ctrl+C 退出并自动删除
 */

const ADSPOWER_API = 'http://127.0.0.1:50325';
const ADSPOWER_API_KEY = '1bf5df8fe0c39df2d1c395dd9d45250600900ced223770de';

const FIXED_PROXY_HOST = '104.233.202.50';
const FIXED_PROXY_PORT = 7891;
const FIXED_PROXY_TYPE = 'socks5';

async function adsPowerApi(path, params = {}) {
    const url = new URL(path, ADSPOWER_API);
    Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    });
    const resp = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${ADSPOWER_API_KEY}` },
    });
    const data = await resp.json();
    if (data.code !== 0) throw new Error(`API 错误 (code=${data.code}): ${data.msg}`);
    return data;
}

async function adsPowerApiPost(path, body = {}) {
    const resp = await fetch(new URL(path, ADSPOWER_API).toString(), {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${ADSPOWER_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (data.code !== 0) throw new Error(`API 错误 (code=${data.code}): ${data.msg}`);
    return data;
}

async function getDefaultGroupId() {
    const result = await adsPowerApi('/api/v1/group/list');
    const groups = result.data?.list || [];
    if (groups.length > 0) {
        console.log(`📂 使用分组: ${groups[0].group_name} (group_id=${groups[0].group_id})`);
        return groups[0].group_id;
    }
    console.log('📂 没有分组，自动创建 Default...');
    const r = await adsPowerApiPost('/api/v1/group/create', { group_name: 'Default' });
    console.log(`✅ 默认分组已创建: group_id=${r.data?.group_id}`);
    return r.data?.group_id;
}

async function main() {
    console.log('🧪 测试创建 AdsPower 环境\n');

    // 1. 获取分组
    const groupId = await getDefaultGroupId();

    // 2. 创建环境
    console.log('\n🔧 创建环境...');
    const result = await adsPowerApiPost('/api/v2/browser-profile/create', {
        name: `test_${Date.now()}`,
        group_id: groupId,
        user_proxy_config: {
            proxy_soft: 'other',
            proxy_type: FIXED_PROXY_TYPE,
            proxy_host: FIXED_PROXY_HOST,
            proxy_port: String(FIXED_PROXY_PORT),
            proxy_user: '',
            proxy_password: '',
        },
        fingerprint_config: {
            random_ua: {
                ua_system_version: ['Windows'],
            },
        },
    });
    const userId = result.data?.profile_id || result.data?.id || result.data?.user_id;
    console.log(`✅ 环境已创建: user_id=${userId}`);
    console.log(`   返回数据: ${JSON.stringify(result.data)}\n`);

    // 3. 启动浏览器
    console.log('🔧 启动浏览器...');
    const browserData = await adsPowerApi('/api/v1/browser/start', { user_id: userId });
    console.log(`✅ 浏览器已启动`);
    console.log(`   WebSocket: ${browserData.data?.ws?.puppeteer || browserData.data?.ws}\n`);

    console.log('='.repeat(50));
    console.log('🎯 浏览器已打开，请检查环境是否正常（代理、指纹等）');
    console.log('   按 Ctrl+C 退出（会自动删除环境）');
    console.log('='.repeat(50));

    // 保持运行，等待手动退出
    const cleanup = async () => {
        console.log('\n🔌 清理中...');
        try { await adsPowerApi('/api/v1/browser/stop', { user_id: userId }); } catch {}
        try { await adsPowerApiPost('/api/v2/browser-profile/delete', { profile_ids: [userId] }); } catch {}
        console.log('✅ 环境已删除，退出');
        process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    // 保持进程不退出
    await new Promise(() => {});
}

main().catch(err => {
    console.error('❌', err.message);
    process.exit(1);
});