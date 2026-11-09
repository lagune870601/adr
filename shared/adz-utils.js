/**
 * shared/adz-utils.js — Adz2You 注册的纯函数（零重依赖，供单元测试离线 import）
 *
 * 这里只放不依赖浏览器/网络的逻辑：Social Contact 生成、登录名生成、注册结果分类。
 * signup_adz.js 会 re-export 这些函数；单元测试直接从本文件导入以避免拉起浏览器依赖。
 */

export const SOCIAL_TYPES = ['whatsapp', 'wechat', 'skype', 'telegram'];
export const PASSWORD = '123456789_Chen';

/** 各类型社交账号的校验正则 */
export const SOCIAL_HANDLE_REGEX = {
    whatsapp: /^\+1\d{10}$/,
    wechat: /^wxid_[a-z0-9]{8}$/,
    skype: /^live:[a-z0-9]{10}$/,
    telegram: /^@[a-z0-9]{8}$/,
};

const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';
const randDigits = (n, random = Math.random) =>
    Array.from({ length: n }, () => Math.floor(random() * 10)).join('');
const randAlnum = (n, random = Math.random) =>
    Array.from({ length: n }, () => ALNUM[Math.floor(random() * ALNUM.length)]).join('');

/** 随机选一个 Social Contact 类型 */
export function pickSocialType(random = Math.random) {
    return SOCIAL_TYPES[Math.floor(random() * SOCIAL_TYPES.length)];
}

/** 按 Social Contact 类型生成符合命名规则的虚拟社交账号 */
export function generateSocialHandle(type, random = Math.random) {
    switch (type) {
        case 'whatsapp': return '+1' + randDigits(10, random);
        case 'wechat': return 'wxid_' + randAlnum(8, random);
        case 'skype': return 'live:' + randAlnum(10, random);
        case 'telegram': return '@' + randAlnum(8, random);
        default: return randAlnum(8, random);
    }
}

/** 生成的社交账号是否符合对应类型的命名规则 */
export function socialHandleMatches(type, handle) {
    const re = SOCIAL_HANDLE_REGEX[type];
    return !!re && re.test(String(handle || ''));
}

/**
 * 由 task.username 生成登录用户名（同 signup.js：去空格+小写+4位随机后缀）。
 * 额外剔除字母数字以外的字符，保证符合站点"至少 3 字符"的规则。
 */
export function generateLoginName(username, random = Math.random) {
    const base = String(username || '')
        .replace(/\s+/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
    const suffix = randAlnum(4, random);
    return (base || 'user') + suffix;
}

/**
 * 根据页面 URL / 文案 / 标题判定注册结果（纯函数，便于单测）。
 * @returns {'success'|'failed'|'pending'}
 */
export function classifySignupPage({ url = '', bodyText = '', title = '' } = {}) {
    const u = String(url).toLowerCase();
    const b = String(bodyText).toLowerCase();
    const t = String(title).toLowerCase();

    const successHints = [
        'registration successful', 'account created', 'signup successful',
        'successfully registered', 'registration success', 'welcome',
    ];
    const errorHints = [
        'already registered', 'already exists', 'already been taken', 'already in use',
        'is taken', 'invalid email', 'invalid username', 'not a valid',
        'try again', 'error', 'failed',
    ];

    if (u.includes('account.php') || successHints.some(k => b.includes(k))) return 'success';
    if (errorHints.some(k => b.includes(k) || t.includes(k))) return 'failed';
    return 'pending';
}

/**
 * 归一化 account.php 的 "Current IP" 文本。
 * 空 / "Nil"（新账号未记录）→ 返回空串，否则返回 trim 后的原值。
 */
export function normalizeCurrentIp(text) {
    const v = String(text ?? '').trim();
    if (!v || /^nil$/i.test(v)) return '';
    return v;
}

/**
 * 归一化 account.php 的 Smart Link（#url_2 的 value）。
 * 仅当形如 http(s):// 开头才返回，否则返回空串。
 */
export function normalizeSmartLink(text) {
    const v = String(text ?? '').trim();
    return /^https?:\/\//i.test(v) ? v : '';
}