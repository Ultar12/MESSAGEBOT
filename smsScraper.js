import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

export async function startSmsScraper(activeClients, telegramBot, targetGroupId) {
    console.log("[SCRAPER] Initializing Time SMS Monitor...");

    const browser = await puppeteer.launch({
    headless: true,
    // On Heroku with the official Chrome buildpack, 
    // the path is usually provided by GOOGLE_CHROME_BIN
    executablePath: process.env.GOOGLE_CHROME_BIN || null,
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--single-process'
    ]
});



    const page = await browser.newPage();

    // Block images/CSS to save RAM on Heroku
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        if (['image', 'stylesheet', 'font'].includes(req.resourceType())) {
            req.abort();
        } else {
            req.continue();
        }
    });

    try {
        await page.goto('https://timesms.net/login', { waitUntil: 'networkidle2' });

        // Login Logic
        await page.type('input[name="username"]', 'Ultarscny');
        await page.type('input[name="password"]', 'Ultarscny');

        // Solve Math Captcha
        const captchaText = await page.evaluate(() => document.body.innerText);
        const nums = captchaText.match(/(\d+)\s*\+\s*(\d+)/);
        if (nums) {
            const sum = parseInt(nums[1]) + parseInt(nums[2]);
            await page.type('input[name="captcha_ans"]', sum.toString());
        }

        await page.click('button[type="submit"]');
        await page.waitForNavigation();

        // Navigate to SMS CDR
        await page.goto('http://timesms.net/client/SMSCDRStats', { waitUntil: 'networkidle2' });

        let lastCode = "";

        // Monitoring Loop
        setInterval(async () => {
            try {
                // Refresh table by clicking "Show Report"
                await page.click('button.btn-primary'); 
                await new Promise(r => setTimeout(r, 1000)); // Wait for update

                const data = await page.evaluate(() => {
                    const row = document.querySelector('table#datatable tbody tr:first-child');
                    if (!row) return null;
                    const cols = row.querySelectorAll('td');
                    return {
                        number: cols[2]?.innerText.trim(),
                        sms: cols[5]?.innerText.trim()
                    };
                });

                if (data && data.sms && data.sms !== lastCode) {
                    lastCode = data.sms;
                    console.log(`[SCRAPER] New SMS Found: ${data.sms}`);
                    
                    // Call your existing forwarder logic here or trigger a custom function
                    // to send the Levanter design to TG and WA
                }
            } catch (e) {
                console.error("[SCRAPER LOOP ERROR]", e.message);
            }
        }, 3000); // 3 seconds is safer for Heroku stability

    } catch (err) {
        console.error("[SCRAPER FATAL]", err.message);
        await browser.close();
    }
}
