/**
 * test-signup-adz-unit.js — signup_adz.js 纯函数离线单元测试
 *
 * 不联网、不启动浏览器，秒级完成。验证：
 *   - pickSocialType 取值合法
 *   - generateSocialHandle 按类型生成且符合命名规则
 *   - socialHandleMatches 正/负样本
 *   - generateLoginName 去空格/小写/后缀/唯一性
 *   - classifySignupPage 成功/失败/待定分类
 *
 * 用法: node test-signup-adz-unit.js
 */

import {
    pickSocialType,
    generateSocialHandle,
    socialHandleMatches,
    generateLoginName,
    classifySignupPage,
    normalizeCurrentIp,
    normalizeSmartLink,
    SOCIAL_HANDLE_REGEX,
} from './shared/adz-utils.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

const SOCIAL_TYPES = ['whatsapp', 'wechat', 'skype', 'telegram'];

// ---------- pickSocialType ----------
{
    const seen = new Set();
    for (let i = 0; i < 500; i++) seen.add(pickSocialType());
    check('pickSocialType 只返回合法类型', [...seen].every(t => SOCIAL_TYPES.includes(t)), `得到: ${[...seen].join(',')}`);
    check('pickSocialType 覆盖全部 4 种', seen.size === 4, `覆盖 ${seen.size} 种`);
}

// ---------- generateSocialHandle ----------
{
    let allMatch = true;
    const samples = {};
    for (const t of SOCIAL_TYPES) {
        samples[t] = generateSocialHandle(t);
        for (let i = 0; i < 200; i++) {
            if (!socialHandleMatches(t, generateSocialHandle(t))) allMatch = false;
        }
    }
    check('generateSocialHandle 各类均符合命名规则 (200次/类)', allMatch,
        SOCIAL_TYPES.map(t => `${t}=${samples[t]}`).join(' | '));

    check('whatsapp 前缀为 +1 且 10 位数字',
        /^\+1\d{10}$/.test(generateSocialHandle('whatsapp')), generateSocialHandle('whatsapp'));
    check('wechat 前缀为 wxid_',
        generateSocialHandle('wechat').startsWith('wxid_'), generateSocialHandle('wechat'));
    check('skype 前缀为 live:',
        generateSocialHandle('skype').startsWith('live:'), generateSocialHandle('skype'));
    check('telegram 前缀为 @',
        generateSocialHandle('telegram').startsWith('@'), generateSocialHandle('telegram'));
}

// ---------- socialHandleMatches ----------
{
    check('whatsapp 正样本', socialHandleMatches('whatsapp', '+15558340127'));
    check('whatsapp 负样本(位数不足)', !socialHandleMatches('whatsapp', '+155583401'));
    check('wechat 正样本', socialHandleMatches('wechat', 'wxid_k3n8vq2a'));
    check('wechat 负样本(大写)', !socialHandleMatches('wechat', 'wxid_K3N8VQ2A'));
    check('skype 正样本', socialHandleMatches('skype', 'live:ab12cd34ef'));
    check('telegram 正样本', socialHandleMatches('telegram', '@ab12cd34'));
    check('telegram 负样本(含下划线)', !socialHandleMatches('telegram', '@john_x9k2'));
    check('未知类型返回 false', !socialHandleMatches('foo', 'bar'));
}

// ---------- generateLoginName ----------
{
    const g = generateLoginName('Willie Butler');
    check('loginName 去空格并转小写', g.startsWith('williebutler'), g);
    check('loginName 仅含小写字母数字', /^[a-z0-9]+$/.test(g), g);
    check('loginName 长度 >= 3', g.length >= 3, `len=${g.length}`);
    check('loginName 带 4 位后缀', g.length === 'williebutler'.length + 4, g);

    const g2 = generateLoginName('  John  Doe!! ');
    check('loginName 剔除非法字符', /^[a-z0-9]+$/.test(g2) && g2.startsWith('johndoe'), g2);

    const g3 = generateLoginName('');
    check('loginName 空用户名有兜底', /^[a-z0-9]+$/.test(g3) && g3.length >= 3, g3);

    // 唯一性（随机后缀）
    const set = new Set();
    for (let i = 0; i < 2000; i++) set.add(generateLoginName('Willie Butler'));
    check('loginName 2000 次几乎不重复', set.size >= 1990, `唯一 ${set.size}/2000`);
}

// ---------- classifySignupPage ----------
{
    check('跳转 account.php → success',
        classifySignupPage({ url: 'https://adz2you.xyz/account.php' }) === 'success');
    check('成功文案 → success',
        classifySignupPage({ bodyText: 'Your account created successfully!' }) === 'success');
    check('邮箱已存在 → failed',
        classifySignupPage({ url: 'https://adz2you.xyz/signup.php', bodyText: 'This email is already registered.' }) === 'failed');
    check('用户名已占用 → failed',
        classifySignupPage({ bodyText: 'Username is taken, try again.' }) === 'failed');
    check('注册页无提示 → pending',
        classifySignupPage({ url: 'https://adz2you.xyz/signup.php', bodyText: 'Sign Up' }) === 'pending');
    check('空输入 → pending', classifySignupPage({}) === 'pending');
}

// ---------- normalizeCurrentIp ----------
{
    check('IP 去空白', normalizeCurrentIp('  174.44.75.106 \n') === '174.44.75.106');
    check('IP 为 Nil → 空串', normalizeCurrentIp('Nil') === '');
    check('IP 为 nil（小写）→ 空串', normalizeCurrentIp(' nil ') === '');
    check('IP 为空 → 空串', normalizeCurrentIp('') === '');
    check('IP 为 null → 空串', normalizeCurrentIp(null) === '');
    check('IPv4 原样保留', normalizeCurrentIp('8.8.8.8') === '8.8.8.8');
}

// ---------- normalizeSmartLink ----------
{
    check('合法 https URL 保留',
        normalizeSmartLink(' https://smartss.top/serve/dl.php?user=NjkzNQ%3D%3D ') === 'https://smartss.top/serve/dl.php?user=NjkzNQ%3D%3D');
    check('合法 http URL 保留',
        normalizeSmartLink('http://a.b/c') === 'http://a.b/c');
    check('非 URL → 空串', normalizeSmartLink('not a link') === '');
    check('空 → 空串', normalizeSmartLink('') === '');
    check('null → 空串', normalizeSmartLink(null) === '');
}

// ---------- 汇总 ----------
console.log('\n========================================');
console.log('📋 signup_adz 单元测试结果:');
let allPass = true;
for (const r of results) {
    if (!r.ok) allPass = false;
    console.log(`   ${r.ok ? '✅ PASS' : '❌ FAIL'}  ${r.name}${r.detail ? ` (${r.detail})` : ''}`);
}
console.log('========================================');
console.log(allPass ? '🎉 单元测试全部通过' : '💥 单元测试存在失败项');
process.exit(allPass ? 0 : 1);