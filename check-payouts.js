import { launch } from 'cloakbrowser/puppeteer';
import os from 'os';
import mysql from 'mysql2/promise';
import { ResidentProxyManager } from './proxy.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const isLinux = os.platform() === 'linux';

const PROXY_API_KEY = '629a2e2ce2532c8c4ad034fbc4f3c8a5';
const DB_CONFIG = { host: '166.0.19.103', port: 13307, user: 'root', password: 'root', database: 'ad' };
const ACCOUNT = 'shangsaal@bibi.biz.st';
const LOGIN_URL = 'https://beta.publishers.adsterra.com/login';

function convertCookies(rawCookies) {
    return rawCookies
        .filter(c => c.session !== true)
        .map(c => {
            const cookie = {
                name: c.name, value: c.value, domain: c.domain,
                path: c.path || '/', httpOnly: c.httpOnly || false, secure: c.secure || false,
            };
            if (c.expirationDate) cookie.expires = c.expirationDate;
            if (c.sameSite) {
                const mapping = { 'no_restriction': 'None', 'lax': 'Lax', 'strict': 'Strict', 'unspecified': 'Lax' };
                cookie.sameSite = mapping[c.sameSite] || 'Lax';
            }
            return cookie;
        });
}

async function getAccountCookies(account) {
    const connection = await mysql.createConnection(DB_CONFIG);
    try {
        const [rows] = await connection.execute('SELECT account, cookie FROM adsterra_account WHERE account = ?', [account]);
        if (rows.length === 0) { console.warn('Account not found'); return null; }
        const rawCookies = typeof rows[0].cookie === 'string' ? JSON.parse(rows[0].cookie) : rows[0].cookie;
        console.log(`Cookies: ${rawCookies.length} raw -> ${convertCookies(rawCookies).length} valid`);
        return convertCookies(rawCookies);
    } finally { await connection.end(); }
}

async function main() {
    console.log('=== Check PayPal Payouts Status ===');
    console.log(`Account: ${ACCOUNT}\n`);

    let browser, proxyManager;
    try {
        // 1. Cookies
        const cookies = await getAccountCookies(ACCOUNT);
        if (!cookies?.length) { console.log('No cookies!'); return; }

        // 2. Proxy
        proxyManager = new ResidentProxyManager({ apiKey: PROXY_API_KEY, country: 'US', rotationInterval: 30 * 60 * 1000, protocol: 'http', verbose: false });
        await proxyManager.start();
        const proxy = await proxyManager.getProxy();
        console.log(`Proxy: ${proxy.host}:${proxy.port}`);

        // 3. Launch browser
        browser = await launch({
            headless: isLinux,
            proxy: 'http://' + proxy.username + ':' + proxy.password + '@' + proxy.host + ':' + proxy.port,
            humanize: true,
            timezone: 'America/New_York',
            locale: 'en-US',
            viewport: { width: 1920, height: 1080 },
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
            ]
        });
        const page = await browser.newPage();
        await page.authenticate({ username: proxy.username, password: proxy.password });
        await page.setViewport({ width: 1920, height: 1080 });

        // 4. Login page to establish domain
        console.log('Navigating to login page...');
        await page.goto(LOGIN_URL, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
        await sleep(2000);

        // 5. Set cookies
        await page.setCookie(...cookies);
        console.log('Cookies set');

        // 6. Go to websites page first (which we know works)
        const WEBSITES_URL = 'https://beta.publishers.adsterra.com/websites';
        console.log(`Navigating to ${WEBSITES_URL}...`);
        await page.goto(WEBSITES_URL, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
        await sleep(3000);
        let url = page.url();
        console.log(`Current URL: ${url}`);

        if (url.includes('login') || url.includes('chrome-error')) {
            console.log('Login/cookie issue, trying to reload...');
            await page.goto(WEBSITES_URL, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
            await sleep(3000);
            url = page.url();
            console.log(`After reload: ${url}`);
        }

        // 7. Navigate to payouts page
        const PAYOUTS_URL = 'https://beta.publishers.adsterra.com/payouts';
        console.log(`\nNavigating to ${PAYOUTS_URL}...`);
        await page.goto(PAYOUTS_URL, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
        await sleep(5000);

        const title = await page.title();
        url = page.url();
        console.log(`\nPage: ${title}`);
        console.log(`URL: ${url}`);

        // 7. Screenshot
        await page.screenshot({ path: 'payouts-screenshot.png', fullPage: true });
        console.log('Screenshot saved: payouts-screenshot.png');

        // 8. Extract ALL page text to find next payout info
        const pageText = await page.evaluate(() => {
            return document.body?.innerText?.substring(0, 2000) || 'no text';
        });
        console.log('\n--- Full Page Text ---');
        console.log(pageText);

        console.log('\nDone. Closing browser...');
        await browser.close();
        if (proxyManager) proxyManager.destroy();
        process.exit(0);
    } catch (error) {
        console.error('Error:', error.message);
        if (browser) await browser.close();
        if (proxyManager) proxyManager.destroy();
        process.exit(1);
    }
}

process.on('SIGINT', async () => { console.log('\nClosing...'); process.exit(0); });
main().catch(e => { console.error(e); process.exit(1); });