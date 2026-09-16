// Post-build verification — the project's test suite.
// Runs against dist/ after `astro build`. Fails CI if the build is missing
// expected pages/assets, leaks a forbidden term or an em dash, drops the
// canonical name, contains a broken internal link, ships an oversized
// asset, regresses bundle size, or exposes /audit anywhere.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join } from 'node:path';

const DIST = process.env.DIST || 'dist';

// Group errors by category so the failure output triages itself instead of
// dumping a flat list. CI logs become much easier to scan.
const WORD_BUDGET = 450;
const groups = {
  pages: [],
  assets: [],
  forbidden_terms: [],
  word_budget: [],
  identity: [],
  broken_links: [],
  asset_budget: [],
  bundle_budget: [],
  pdf_scan: [],
  stata_caption: [],
  contrast: [],
  og_dimensions: [],
  em_dash: [],
  sitemap: [],
};
const fail = (group, m) => { groups[group].push(m); };
const must = (group, cond, m) => { if (!cond) fail(group, m); };

if (!existsSync(DIST)) {
  console.error('✗ no dist/ — run `npm run build` first');
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const files = walk(DIST).map((f) => f.replace(/\\/g, '/'));
const htmlFiles = files.filter((f) => f.endsWith('.html'));

// 1. expected pages
for (const p of ['index.html', '404.html']) {
  must('pages', existsSync(join(DIST, p)), `missing page: ${p}`);
}

// 2. expected assets
for (const a of ['og-default.png', 'favicon.svg', 'sitemap-index.xml']) {
  must('assets', existsSync(join(DIST, a)), `missing asset: ${a}`);
}

// 3. no forbidden identity/positioning leakage — the two private names must
//    never appear (commit messages, file names, alt text are checked outside
//    this script), plus the terms this landing must never echo.
// Two private names the site must never carry; encoded so this public list is not itself the leak.
const privateNames = ['TWFzc2lm', 'U2lsbGFnZQ=='].map((b) => Buffer.from(b, 'base64').toString());
const forbidden = [...privateNames, 'theoh-io', 'Urban Science', 'false alarm', 'false-alarm', 'Alessandro', "the robot's path", 'faults found'];
for (const f of htmlFiles) {
  const html = readFileSync(f, 'utf8');
  for (const term of forbidden) {
    if (html.includes(term)) fail('forbidden_terms', `"${term}" found in ${f}`);
  }
}

// 5. identity
const home = readFileSync(join(DIST, 'index.html'), 'utf8');
must('identity', home.includes('Théo Hermann'), 'canonical name missing from homepage');

// 5b. stata replay caption must match the sidecar meta exactly — the numbers
//     in the caption are rendered at build time from this file, so a drift
//     between them means the copy stopped tracking the data.
const STATA_META = 'public/data/stata-replay.meta.json';
if (existsSync(STATA_META)) {
  const meta = JSON.parse(readFileSync(STATA_META, 'utf8'));
  must(
    'stata_caption',
    home.includes(`${meta.duration_s} s`),
    `stata caption missing "${meta.duration_s} s" (from ${STATA_META})`,
  );
  must(
    'stata_caption',
    home.includes(`${meta.events} detector events`),
    `stata caption missing "${meta.events} detector events" (from ${STATA_META})`,
  );
  const lostMetres = Number(meta.lost_window.position_error_median_m).toFixed(1);
  const lostCm = Math.round(meta.lost_window.amcl_reported_sigma_median_m * 100);
  must(
    'stata_caption',
    home.includes(`${lostMetres} metres`),
    `hero legend missing "${lostMetres} metres" (from ${STATA_META})`,
  );
  must(
    'stata_caption',
    home.includes(`${lostCm} centimetres`),
    `hero legend missing "${lostCm} centimetres" (from ${STATA_META})`,
  );
  // Scoped to the artifact band only: the problem paragraph below cites
  // stock Nav2 AMCL verbatim, so a bare home.includes('AMCL') would false-fire.
  const bandMatch = home.match(/<section class="artifact-band">[\s\S]*?<\/section>/);
  const band = bandMatch ? bandMatch[0] : '';
  must('stata_caption', band.length > 0, 'artifact-band section not found in rendered homepage');
  must('stata_caption', !band.includes('AMCL'), 'hero band must not render "AMCL"');
}

// 5c. word budget above the contact block: a buyer decides in twenty seconds.
//     Keyed on the contact section id, not on a section list or a literal count.
{
  const cut = home.indexOf('id="contact"');
  must('word_budget', cut > 0, 'contact section not found in rendered homepage');
  if (cut > 0) {
    const above = home.slice(home.indexOf('<body'), cut);
    const text = above.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ');
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    must('word_budget', words <= WORD_BUDGET, `${words} words above the contact block (budget ${WORD_BUDGET})`);
    console.log(`  words above the contact block: ${words} (budget ${WORD_BUDGET})`);
  }
}

// 6. internal links resolve to a built file
function resolveLink(href) {
  let path = href.split('#')[0].split('?')[0];
  if (!path.startsWith('/') || path.startsWith('//')) return null; // external / anchor
  if (path === '/') return 'index.html';
  if (path.endsWith('/')) path += 'index.html';
  else if (!/\.[a-z0-9]+$/i.test(path.slice(path.lastIndexOf('/') + 1))) path += '/index.html';
  return path.replace(/^\//, '');
}
const linkRe = /(?:href|src|data-url)="([^"]+)"/g;
let linkCount = 0;
for (const f of htmlFiles) {
  const html = readFileSync(f, 'utf8');
  for (const m of html.matchAll(linkRe)) {
    const target = resolveLink(m[1]);
    if (!target) continue;
    linkCount++;
    if (!existsSync(join(DIST, target))) {
      fail('broken_links', `"${m[1]}" in ${f} (→ ${target})`);
    }
  }
}

// 7. asset budgets — guard against accidentally shipping a 17MB hero.gif.
//    Per-extension limits because a paper PDF reasonably weighs more than
//    a hero image. Per CLAUDE.md feedback-perf-nonnegotiable: perf is a
//    definition-of-done constraint.
const KB = 1024, MB = 1024 * 1024;
const ASSET_BUDGETS = {
  // ext: [hard limit bytes, warn-above bytes]
  png:  [1 * MB, 500 * KB],
  jpg:  [1 * MB, 500 * KB],
  jpeg: [1 * MB, 500 * KB],
  webp: [1 * MB, 500 * KB],
  gif:  [1 * MB, 500 * KB],
  svg:  [200 * KB, 80 * KB],
  webm: [3 * MB, 1.5 * MB],   // hero videos legitimately bigger
  mp4:  [3 * MB, 1.5 * MB],
  mp3:  [5 * MB, 2 * MB],
  woff: [200 * KB, 100 * KB],
  woff2:[200 * KB, 100 * KB],
  pdf:  [2 * MB, 1 * MB],     // academic papers / reports
  bin:  [150 * KB, 60 * KB],  // point-cloud datasets (largest today ~50KB)
  json: [200 * KB, 60 * KB],  // replay/sidecar data (stata-replay.json etc.)
};
const assetWarnings = [];
for (const f of files) {
  const ext = f.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase();
  const budget = ext && ASSET_BUDGETS[ext];
  if (!budget) continue;
  const [limit, warn] = budget;
  const size = statSync(f).size;
  if (size > limit) {
    fail('asset_budget', `${f} is ${(size / MB).toFixed(2)} MB (limit ${(limit / MB).toFixed(1)} MB for .${ext})`);
  } else if (size > warn) {
    assetWarnings.push(`${f} is ${(size / KB).toFixed(0)} KB (warn ≥ ${(warn / KB).toFixed(0)} KB for .${ext})`);
  }
}

// 8. bundle budget — JS regression guard.
//    Baseline established 2026-06-08 at ~8 KB single chunk. The 10x ceiling
//    is generous; the point is to catch a runaway `import { ... } from
//    'some-huge-lib'` that accidentally hydrates a page.
const JS_BUDGET_BYTES = 80 * 1024; // 80 KB total across _astro/*.js
let totalJsBytes = 0;
const astroDir = join(DIST, '_astro');
if (existsSync(astroDir)) {
  for (const f of walk(astroDir)) {
    if (f.endsWith('.js')) totalJsBytes += statSync(f).size;
  }
}
if (totalJsBytes > JS_BUDGET_BYTES) {
  fail('bundle_budget', `JS bundle is ${(totalJsBytes / 1024).toFixed(1)} KB (budget ${JS_BUDGET_BYTES / 1024} KB)`);
}

// 9. PDF text scan — forbidden identity terms and phone numbers must not
//    ship inside any PDF. Best-effort pure-node extraction (no dependency):
//    inflate FlateDecode streams, read literal + hex text-show strings, and
//    decode hex strings through any ToUnicode CMaps found in the file
//    (weasyprint & friends emit glyph-ID hex strings, so the CMap pass is
//    what makes the scan see real words). If a PDF yields no text at all
//    (scanned/exotic), warn and move on — never fail blind.
const PDF_FORBIDDEN = [...new Set(forbidden)];
const PHONE_RE = /\+\d{1,3}[\d\s.-]{7,}/g;
// A raw +\d… match can be a decimal from an academic report ("+42.00000…")
// or wrong-font decode noise ("+000000000000"), not a phone. A phone has
// 8–15 digits total (E.164 cap), no long digit run right after a decimal
// point, a country code that never starts with 0, and in practice at
// least 3 distinct digits.
const isPhoneLike = (m) => {
  const digits = m.replace(/\D/g, '');
  return (
    digits.length >= 8 && digits.length <= 15 &&
    !/\.\d{5,}/.test(m) && !/^\+0/.test(m) &&
    new Set(digits).size >= 3
  );
};

function pdfStreams(buf) {
  const out = [];
  let i = 0;
  while ((i = buf.indexOf('stream', i)) !== -1) {
    let start = i + 6;
    if (buf[start] === 0x0d) start++;
    if (buf[start] === 0x0a) start++;
    const end = buf.indexOf('endstream', start);
    if (end === -1) break;
    const raw = buf.subarray(start, end);
    try { out.push(inflateSync(raw).toString('latin1')); }
    catch { out.push(raw.toString('latin1')); }
    i = end + 9;
  }
  return out;
}

// One map per ToUnicode stream. Subset fonts reuse the same glyph-ID codes
// with different meanings, so a single union map would decode text through
// the wrong font and could garble a forbidden term past the scan. The
// whole document is instead decoded once per font map and every variant is
// scanned; the correct decoding is always among the variants (the wrong
// ones are just noise that can only over-trigger, never hide a term).
function toUnicodeMaps(streams) {
  const maps = [];
  for (const text of streams) {
    if (!/beginbf(char|range)/.test(text)) continue;
    const map = new Map(); // hex glyph code (uppercase, fixed width) -> string
    const addPair = (src, dst) => {
      let s = '';
      for (let k = 0; k + 4 <= dst.length; k += 4) {
        s += String.fromCharCode(parseInt(dst.slice(k, k + 4), 16));
      }
      if (s) map.set(src.toUpperCase(), s);
    };
    for (const m of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const p of m[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) addPair(p[1], p[2]);
    }
    for (const m of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const r of m[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g)) {
        const lo = parseInt(r[1], 16), hi = parseInt(r[2], 16), width = r[1].length;
        if (hi - lo > 0xffff) continue;
        if (r[3]) {
          const base = parseInt(r[3], 16);
          for (let c = lo; c <= hi; c++) {
            map.set(c.toString(16).toUpperCase().padStart(width, '0'), String.fromCharCode(base + (c - lo)));
          }
        } else if (r[4]) {
          const dsts = [...r[4].matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => x[1]);
          for (let c = lo; c <= hi && c - lo < dsts.length; c++) {
            addPair(c.toString(16).toUpperCase().padStart(width, '0'), dsts[c - lo]);
          }
        }
      }
    }
    if (map.size) maps.push(map);
  }
  return maps;
}

// Returns one text variant per ToUnicode map (plus a literal-strings-only
// variant when no maps exist). Adjacency of kerned fragments survives only
// inside the correct font's variant — which is exactly the one scanned.
function extractPdfTexts(buf) {
  const allStreams = pdfStreams(buf);
  const cmaps = toUnicodeMaps(allStreams);
  const streams = allStreams.filter((s) => /\b(Tj|TJ|Tf|BT)\b/.test(s));
  const unescapeLit = (s) =>
    s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, c) => {
      if (/^[0-7]+$/.test(c)) return String.fromCharCode(parseInt(c, 8));
      return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[c] ?? c;
    });
  const decodeHex = (cmap, h) => {
    const hex = h.replace(/\s+/g, '').toUpperCase();
    let best = '', bestOk = -1;
    for (const width of [4, 2]) {
      let out = '', ok = 0;
      for (let k = 0; k + width <= hex.length; k += width) {
        const mapped = cmap.get(hex.slice(k, k + width));
        if (mapped !== undefined) { out += mapped; ok++; }
      }
      if (ok > bestOk) { best = out; bestOk = ok; }
    }
    return best;
  };
  return (cmaps.length ? cmaps : [new Map()]).map((cmap) => {
    let text = '';
    for (const s of streams) {
      for (const m of s.matchAll(/\(((?:\\.|[^\\()])*)\)|<([0-9A-Fa-f\s]+)>/g)) {
        text += m[1] !== undefined ? unescapeLit(m[1]) : decodeHex(cmap, m[2]);
      }
      text += '\n';
    }
    return text;
  });
}

const pdfWarnings = [];
for (const f of files.filter((f) => f.endsWith('.pdf'))) {
  const texts = extractPdfTexts(readFileSync(f));
  if (!texts.some((t) => t.trim().length >= 10)) {
    pdfWarnings.push(`${f}: no text extracted — scan skipped (scanned/exotic PDF?)`);
    continue;
  }
  const found = new Set();
  for (const text of texts) {
    const squashed = text.replace(/\s+/g, '').toLowerCase();
    for (const term of PDF_FORBIDDEN) {
      if (squashed.includes(term.replace(/\s+/g, '').toLowerCase())) found.add(`"${term}" found in ${f}`);
    }
    for (const m of text.match(PHONE_RE) ?? []) {
      if (isPhoneLike(m)) found.add(`phone-number pattern "${m.trim()}" found in ${f}`);
    }
  }
  for (const msg of found) fail('pdf_scan', msg);
}

// 10. WCAG contrast gate — parse --text-*/--bg-* hex tokens for both color
//     modes out of global.css and fail any text/bg pair below 4.5:1 (AA).
//     Pure regex/brace-matching parser; source file, not dist (tokens don't
//     survive to dist as literal hex strings once Tailwind compiles them).
const GLOBAL_CSS = 'src/styles/global.css';
function srgbToLinear(c) {
  c /= 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function relLuminance(hex) {
  const n = parseInt(hex, 16);
  return (
    0.2126 * srgbToLinear((n >> 16) & 255) +
    0.7152 * srgbToLinear((n >> 8) & 255) +
    0.0722 * srgbToLinear(n & 255)
  );
}
function contrastRatio(hexA, hexB) {
  const [a, b] = [relLuminance(hexA), relLuminance(hexB)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}
function extractBraceBlock(css, selector) {
  const start = css.indexOf(selector);
  if (start === -1) return null;
  const braceStart = css.indexOf('{', start);
  let depth = 1, i = braceStart + 1;
  while (depth > 0 && i < css.length) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
    i++;
  }
  return css.slice(braceStart + 1, i - 1);
}
function extractHexTokens(block, names) {
  const out = {};
  for (const name of names) {
    const m = block.match(new RegExp(`--${name}:\\s*#([0-9a-fA-F]{6})`));
    if (m) out[name] = m[1];
  }
  return out;
}
if (existsSync(GLOBAL_CSS)) {
  const css = readFileSync(GLOBAL_CSS, 'utf8');
  const textNames = ['text-primary', 'text-secondary', 'text-muted'];
  const bgNames = ['bg-primary', 'bg-secondary', 'bg-elevated', 'bg-accent'];
  const modes = [
    ['light', extractBraceBlock(css, ':root {')],
    ['dark', extractBraceBlock(css, '[data-theme="dark"] {')],
  ];
  for (const [mode, block] of modes) {
    if (!block) {
      fail('contrast', `could not locate the ${mode}-mode token block in ${GLOBAL_CSS}`);
      continue;
    }
    const text = extractHexTokens(block, textNames);
    const bg = extractHexTokens(block, bgNames);
    for (const [tname, thex] of Object.entries(text)) {
      for (const [bname, bhex] of Object.entries(bg)) {
        const ratio = contrastRatio(thex, bhex);
        if (ratio < 4.5) {
          fail(
            'contrast',
            `${mode} --${tname} (#${thex}) vs --${bname} (#${bhex}) = ${ratio.toFixed(2)}:1 (< 4.5:1 WCAG AA)`,
          );
        }
      }
    }
  }
} else {
  fail('contrast', `${GLOBAL_CSS} not found — cannot run the WCAG contrast gate`);
}

// 11. Social card dimensions — a corrupted/regenerated-wrong og-default.png
//     silently breaks every cold-outbound link preview.
const ogPath = join(DIST, 'og-default.png');
if (existsSync(ogPath)) {
  const ogBuf = readFileSync(ogPath);
  const ogWidth = ogBuf.readUInt32BE(16);
  const ogHeight = ogBuf.readUInt32BE(20);
  must(
    'og_dimensions',
    ogWidth === 1200 && ogHeight === 630,
    `dist/og-default.png is ${ogWidth}x${ogHeight}, expected 1200x630`,
  );
}

// 12. no em dash anywhere in rendered copy — U+2014.
for (const f of htmlFiles) {
  const html = readFileSync(f, 'utf8');
  if (html.includes('—')) fail('em_dash', `U+2014 (em dash) found in ${f}`);
}

// 13. /audit must never surface: not in the sitemap, not linked from any page.
const sitemapFiles = files.filter((f) => /sitemap(-index)?(-\d+)?\.xml$/.test(f));
for (const f of sitemapFiles) {
  const xml = readFileSync(f, 'utf8');
  if (xml.includes('/audit')) fail('sitemap', `"/audit" found in ${f}`);
}
for (const f of htmlFiles) {
  const html = readFileSync(f, 'utf8');
  if (html.includes('href="/audit')) fail('sitemap', `"/audit" linked from ${f}`);
}

const totalErrors = Object.values(groups).reduce((s, a) => s + a.length, 0);
if (totalErrors) {
  console.error(`\n✗ ${totalErrors} build check(s) failed:`);
  for (const [name, items] of Object.entries(groups)) {
    if (!items.length) continue;
    console.error(`\n  [${name}]`);
    items.forEach((e) => console.error('    • ' + e));
  }
  process.exit(1);
}

if (assetWarnings.length) {
  console.warn(`\n⚠ ${assetWarnings.length} asset(s) over the 500 KB soft warn:`);
  assetWarnings.forEach((w) => console.warn('    • ' + w));
}

if (pdfWarnings.length) {
  console.warn(`\n⚠ ${pdfWarnings.length} PDF(s) not scannable:`);
  pdfWarnings.forEach((w) => console.warn('    • ' + w));
}

console.log(
  `✓ build checks passed — ${htmlFiles.length} pages, ${linkCount} internal links, ` +
  `${(totalJsBytes / 1024).toFixed(1)} KB JS`,
);
