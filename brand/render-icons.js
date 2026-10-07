/* آیکون‌های PNG را از SVG لوگو می‌سازد (با مرورگر هِدلس رندر می‌شوند). */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ICONS = path.join(ROOT, 'public', 'icons');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const TARGETS = [
  { svg: 'app-icon.svg', out: 'icon-192.png', size: 192 },
  { svg: 'app-icon.svg', out: 'icon-512.png', size: 512 },
  { svg: 'app-icon-maskable.svg', out: 'icon-maskable-512.png', size: 512 },
];

(async () => {
  fs.mkdirSync(ICONS, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME });

  for (const { svg, out, size } of TARGETS) {
    const markup = fs.readFileSync(path.join(__dirname, svg), 'utf8');
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(
      `<style>html,body{margin:0;padding:0}svg{display:block;width:${size}px;height:${size}px}</style>${markup}`
    );
    await page.screenshot({ path: path.join(ICONS, out), omitBackground: true });
    await page.close();
    console.log(`ساخته شد: ${out} (${size}×${size})`);
  }

  // آیکون لانچر اندروید از همان فایل‌ها
  const android = path.join(ROOT, 'android/app/src/main/res');
  for (const [dir, src] of Object.entries({
    'mipmap-hdpi': 'icon-192.png',
    'mipmap-xhdpi': 'icon-192.png',
    'mipmap-xxhdpi': 'icon-512.png',
    'mipmap-xxxhdpi': 'icon-512.png',
  })) {
    fs.copyFileSync(path.join(ICONS, src), path.join(android, dir, 'ic_launcher.png'));
  }
  console.log('آیکون‌های لانچر اندروید کپی شد');

  await browser.close();
})();
