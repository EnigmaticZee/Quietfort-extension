// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Real-site regression sweep for the filtering proxy: loads 40 popular sites in
// headless Chrome directly and through tools/devproxy (127.0.0.1:8899, started
// separately: `cargo run --release -p devproxy`), and fails if any site's status
// differs or a page that has text directly comes up empty through the proxy.
// Catches proxy-only breakage such as oversized headers (YouTube 502).
// Extra lists (e.g. uBO / AdGuard, downloaded to a scratch folder, never into
// the repo): `cargo run --release -p devproxy -- dev-data/easylist.txt
// dev-data/easyprivacy.txt --trusted /tmp/x/filters.min.txt ...`.
import puppeteer from 'puppeteer-core';
const sites = ['youtube.com','google.com','wikipedia.org','reddit.com','amazon.com','nytimes.com','theverge.com','x.com','linkedin.com','github.com','stackoverflow.com','netflix.com','bbc.co.uk','cnn.com','theguardian.com','espn.com','twitch.tv','instagram.com','facebook.com','apple.com','microsoft.com','yahoo.com','ebay.com','imdb.com','spotify.com','medium.com','paypal.com','booking.com','weather.com','zillow.com','walmart.com','target.com','nike.com','etsy.com','discord.com','notion.so','figma.com','cnet.com','duckduckgo.com','bing.com'];
const results = {};
const content = { direct: {}, proxy: {} };
for (const mode of ['direct', 'proxy']) {
  const args = mode === 'proxy' ? ['--proxy-server=http://127.0.0.1:8899', '--ignore-certificate-errors'] : [];
  const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args });
  const out = [];
  await Promise.all(sites.map(async (s, i) => {
    await new Promise(r => setTimeout(r, i * 150));
    const p = await b.newPage();
    try {
      const r = await p.goto('https://www.' + s.replace(/^www\./, '') + '/', { timeout: 30000, waitUntil: 'domcontentloaded' });
      await new Promise((res) => setTimeout(res, 3000));
      const text = await p.evaluate(() => (document.body?.innerText ?? '').length).catch(() => -1);
      out.push([s, r?.status()]);
      content[mode][s] = text > 100;
    }
    catch (e) { out.push([s, String(e).slice(0, 50)]); }
    await p.close();
  }));
  out.sort();
  console.log(mode, JSON.stringify(Object.fromEntries(out)));
  results[mode] = Object.fromEntries(out);
  await b.close();
}
const diff = sites.filter((s) => String(results.direct[s]) !== String(results.proxy[s]) || (content.direct[s] && content.proxy[s] === false));
const empty = sites.filter((s) => content.direct[s] && content.proxy[s] === false);
if (empty.length) console.log(`empty through the proxy: ${empty.join(', ')}`);
console.log(diff.length ? `DIFFERENT: ${diff.map((s) => `${s} ${results.direct[s]} vs ${results.proxy[s]}`).join(', ')}` : `real-site sweep: ${sites.length} sites identical through the proxy`);
process.exit(diff.length ? 1 : 0);
