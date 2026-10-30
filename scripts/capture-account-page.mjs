// node capture-account-page.mjs <base url> <work dir> <out dir>; run by make-account-page.py
import { launch } from '/home/theo/Perso/site-review/harness/cdp.mjs';
import { execFileSync } from 'node:child_process';
const [base, work, out] = process.argv.slice(2);
const b = await launch({ reducedMotion: true });
const acc = await b.page({ width: 794, height: 1123, dpr: 2 });
await acc.goto(`${base}/account.html`, { settle: 600 });
await acc.screenshot(`${work}/account-p1.png`);
// the picture stops under the table, where the finding is; the thumb keeps the whole first page
const cut = Math.round(await acc.eval(`document.querySelector('table').getBoundingClientRect().bottom + 16`)) * 2;
execFileSync('python3', ['-c', `from PIL import Image
im = Image.open('${work}/account-p1.png').convert('RGB')
im.crop((0, 0, im.width, ${cut})).save('${out}/account-page.jpg', quality=82)
im.resize((144, round(144 * im.height / im.width)), Image.LANCZOS).save('${out}/account-thumb.jpg', quality=85)`]);
await b.close();
