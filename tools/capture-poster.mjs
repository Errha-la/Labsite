/* 產生首頁首屏海報（assets/images/hero-desktop.webp、hero-mobile.webp）
 *
 * 首屏顯示的是與 3D 開場取景一致的預先渲染畫面；3D 場景改動後請重跑這支腳本。
 * 僅供開發使用，網站本身不依賴它。需要 puppeteer-core、sharp（在有這兩個套件的資料夾內執行）與 Chrome：
 *
 *   python3 -m http.server 8765            # 在專案根目錄
 *   cd <裝了 puppeteer-core 與 sharp 的資料夾>
 *   CHROME_PATH=/usr/bin/google-chrome node <專案>/tools/capture-poster.mjs http://localhost:8765/index.html <專案>/assets/images
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
/* 從目前資料夾的 node_modules 載入（ESM 預設不會往上層專案找） */
const req = createRequire(process.cwd() + '/');
const load = async name => { const m = await import(pathToFileURL(req.resolve(name)).href); return m.default || m; };
const puppeteer = await load('puppeteer-core');
const sharp = await load('sharp');
const [url, outDir] = process.argv.slice(2);
const chrome = process.env.CHROME_PATH || '/usr/bin/google-chrome';

const shots = [
  { name: 'hero-desktop', vp: { width: 1440, height: 900 }, out: { width: 1440, height: 900, quality: 70 } },
  { name: 'hero-mobile', vp: { width: 390, height: 800, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, out: { width: 780, height: 1600, quality: 68 } }
];
const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
for (const s of shots) {
  const page = await browser.newPage(); await page.setViewport(s.vp);
  await page.goto(url, { waitUntil: 'load' });
  await page.mouse.move(40, 40);                                   // 觸發 3D 載入
  await page.waitForFunction(() => { const f = document.getElementById('lineFallback'); return f && getComputedStyle(f).display === 'none'; }, { timeout: 30000 });
  /* 只留畫布：拿掉標題、外框、導覽、裁切，再擷取 */
  await page.addStyleTag({ content: '#heroTitle,#heroFrame,header,#actNav,#bleedFrame,#stationUI{display:none!important} #worldBox{clip-path:none!important}' });
  await new Promise(r => setTimeout(r, 1200));
  const el = await page.$('#lineCanvas');
  const png = await el.screenshot({ type: 'png' });
  const webp = await sharp(png).resize(s.out.width, s.out.height, { fit: 'cover' }).webp({ quality: s.out.quality }).toBuffer();
  fs.writeFileSync(`${outDir}/${s.name}.webp`, webp);
  console.log(s.name, webp.length, 'bytes');
  await page.close();
}
await browser.close();
