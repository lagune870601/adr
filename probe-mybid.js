/** 临时探针：加载本地空页面 + mbidadm 脚本，观察请求、DOM、广告形态、点击结果 */
import { launch } from 'cloakbrowser/puppeteer';

const TARGET = 'https://shop1.smacad.com/';
const SCRIPT = '<script async src="https://js.mbidadm.com/static/scripts.js" data-admpid="472979"></script>';
const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">${SCRIPT}</head><body>helloworld</body></html>`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const seed = 10000 + Math.floor(Math.random() * 90000);
const browser = await launch({
    headless: false,
    humanize: true,
    timezone: 'America/New_York',
    locale: 'en-US',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', `--fingerprint=${seed}`],
});
console.log(`seed=${seed}`);

const ctx = await browser.createBrowserContext();
const page = await ctx.newPage();

page.on('console', m => console.log(`[console:${m.type()}] ${m.text().slice(0, 300)}`));
page.on('pageerror', e => console.log(`[pageerror] ${e.message.slice(0, 300)}`));

const reqs = new Map();
page.on('request', req => {
    const u = req.url();
    if (!u.startsWith('https://shop1.smacad.com/')) {
        reqs.set(u, req.resourceType());
    }
});
page.on('requestfailed', req => {
    console.log(`[failed] ${req.url().slice(0, 150)} ${req.failure()?.errorText}`);
});
page.on('requestfinished', async req => {
    try {
        const res = req.response();
        if (res && res.status() >= 400) console.log(`[http ${res.status()}] ${req.url().slice(0, 150)}`);
    } catch {}
});

const newTargets = [];
browser.on('targetcreated', t => {
    if (t.type() === 'page') {
        newTargets.push(t.url());
        console.log(`[newpage] ${t.url()}`);
    }
});
await page.evaluateOnNewDocument(() => {
    const orig = window.open;
    window.open = function (...a) { console.log('WINDOW_OPEN ' + a[0]); return orig.apply(this, a); };
});

await page.setRequestInterception(true);
page.on('request', req => {
    const u = req.url();
    if (u.startsWith('https://shop1.smacad.com/') && req.isNavigationRequest() && req.frame() === page.mainFrame()) {
        req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: HTML }).catch(() => {});
    } else {
        req.continue().catch(() => {});
    }
});

page.setDefaultNavigationTimeout(60000);
await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 });
console.log(`URL now: ${page.url()}`);
await sleep(25000);

const info = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').slice(0, 400);
    const frames = Array.from(document.querySelectorAll('iframe')).map(f => {
        const r = f.getBoundingClientRect();
        const st = getComputedStyle(f);
        let inner = '';
        try { inner = clean(f.contentDocument?.body?.innerText) + ' | ' + f.contentDocument?.body?.innerHTML?.length; } catch (e) { inner = 'x-origin'; }
        return {
            src: f.src, srcdoc: clean(f.getAttribute('srcdoc')), id: f.id, cls: f.className,
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            display: st.display, visibility: st.visibility, opacity: st.opacity, zIndex: st.zIndex,
            inner,
        };
    });
    const body = clean(document.body.innerHTML);
    const fixed = Array.from(document.querySelectorAll('body *')).filter(el => {
        const st = getComputedStyle(el);
        return st.position === 'fixed' && st.display !== 'none' && el.offsetWidth > 50 && el.offsetHeight > 50;
    }).slice(0, 10).map(el => ({ tag: el.tagName, id: el.id, cls: el.className, rect: el.getBoundingClientRect().toJSON() }));
    return { bodyLen: document.body.innerHTML.length, body, frames, fixed };
});
console.log('\n===== DOM =====');
console.log(JSON.stringify(info, null, 1).slice(0, 6000));

await page.screenshot({ path: 'probe-mybid.png' }).catch(e => console.log('screenshot fail ' + e.message));
console.log('\n===== 外部请求 (' + reqs.size + ') =====');
for (const [u, t] of reqs) console.log(`${t} ${u.slice(0, 200)}`);

// 尝试点击第一个视口内 iframe
const rect = await page.evaluate(() => {
    for (const f of document.querySelectorAll('iframe')) {
        const r = f.getBoundingClientRect();
        const st = getComputedStyle(f);
        if (r.width > 20 && r.height > 20 && st.display !== 'none' && st.visibility !== 'hidden' &&
            r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight) {
            return { x: r.left, y: r.top, w: r.width, h: r.height, src: f.src };
        }
    }
    return null;
});
console.log('\n点击候选: ' + JSON.stringify(rect));
if (rect) {
    const x = Math.round(rect.x + rect.w * 0.5), y = Math.round(rect.y + rect.h * 0.5);
    await page.mouse.click(x, y);
    console.log(`已点击 (${x}, ${y})`);
    await sleep(8000);
    console.log(`点击后 URL: ${page.url()} | 新页面: ${JSON.stringify(newTargets)}`);
    const pages = await ctx.pages?.() ?? [];
    for (const p of pages) console.log(`页面: ${p.url()}`);
}

await browser.close();