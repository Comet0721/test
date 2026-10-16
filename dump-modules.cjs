const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  await page.goto('https://cloud.tencent.com/act/pro/featured-202607', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(5000);
  const result = await page.evaluate(async () => {
    const w = window['webpackChunk_tencent_qcact_ssr'];
    let req = null;
    w.push([[Math.floor(Math.random()*1e9)], {}, function(__webpack_require__) { req = __webpack_require__; }]);
    // force-load sign module
    try {
      const yo = req(8579);
      await yo.dm.he();
      await yo.dm.ge(['post', , '/dianshi/do-goods', , {}, , {}, , , 'UA', 'skey'], Date.now());
    } catch (e) {}
    const mods = {};
    for (const [id, factory] of Object.entries(req.m)) {
      mods[id] = factory.toString();
    }
    return {
      mods,
      runtimeKeys: Object.keys(req),
      publicPath: req.p,
      chunkIds: Object.keys(req.m).length
    };
  });
  fs.writeFileSync(path.join(__dirname, 'runtime', 'modules.json'), JSON.stringify(result.mods));
  console.log('modules saved:', Object.keys(result.mods).length);
  console.log('runtimeKeys:', result.runtimeKeys.join(', '));
  console.log('publicPath:', result.publicPath);
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
