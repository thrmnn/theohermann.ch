// Social card generator — replaces the hand-made public/og-default.png so
// the link-preview image can never drift from the site's own copy again.
//
// Satori renders text to real glyph-outline <path> elements (not <text>),
// so the rasterizer (sharp/librsvg) needs no system fonts — this host's
// fontconfig has neither Space Grotesk nor JetBrains Mono, and public/fonts/
// only ships woff2, which satori cannot read.
//
// The two source files in scripts/assets/fonts/ are the real variable TTFs
// (wght axis). Satori's bundled opentype.js fork cannot parse ANY variable
// font's fvar table (font.names is never populated before fvar.parse reads
// it — a real, unresolved upstream bug: vercel/satori#162, #320, #712).
// Work-around: fonttools instances each weight we need down to a static
// TTF (fvar dropped) before handing it to satori — same font, same OFL
// license, just pre-flattened on the weight axis. No look-alike substitute.
//
// Usage:
//   node scripts/make-og.mjs          # write public/og-default.png
//   node scripts/make-og.mjs --check  # render to a buffer, diff against the
//                                      # committed file, exit 1 on mismatch
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import satori from 'satori';
import sharp from 'sharp';

const ROOT = join(import.meta.dirname, '..');
const FONT_DIR = join(ROOT, 'scripts/assets/fonts');
const OUT = join(ROOT, 'public/og-default.png');

const { author } = await import(join(ROOT, 'src/data/author.ts'));
const tagline = 'I read robot navigation logs.';

const WIDTH = 1200;
const HEIGHT = 630;
const PALETTE = {
  bg: '#fafafa',
  textPrimary: '#171717',
  textSecondary: '#525252',
  textMuted: '#6b6b6b',
  accent: '#2563eb',
};

function instanceWeight(srcTtf, weight, workDir) {
  const out = join(workDir, `${weight}.ttf`);
  try {
    execFileSync(
      'fonttools',
      ['varLib.instancer', '--no-recalc-timestamp', '-o', out, srcTtf, `wght=${weight}`],
      { stdio: 'pipe' },
    );
  } catch (err) {
    console.error(
      '✗ `fonttools` (Python) is required to work around a satori/opentype.js bug that ' +
      'crashes on any variable font\'s fvar table (vercel/satori#162, #320, #712) — ' +
      'install it (pip install fonttools) and retry.',
    );
    console.error(err.message);
    process.exit(1);
  }
  return readFileSync(out);
}

function loadFonts(workDir) {
  const spaceGrotesk = join(FONT_DIR, 'SpaceGrotesk.ttf');
  const jetBrainsMono = join(FONT_DIR, 'JetBrainsMono.ttf');
  for (const p of [spaceGrotesk, jetBrainsMono]) {
    if (!existsSync(p)) {
      console.error(`✗ missing font: ${p} — download it first (see scripts/make-og.mjs header)`);
      process.exit(1);
    }
  }
  return {
    'Space Grotesk 700': { name: 'Space Grotesk', data: instanceWeight(spaceGrotesk, 700, workDir), weight: 700 },
    'Space Grotesk 600': { name: 'Space Grotesk', data: instanceWeight(spaceGrotesk, 600, workDir), weight: 600 },
    'Space Grotesk 400': { name: 'Space Grotesk', data: instanceWeight(spaceGrotesk, 400, workDir), weight: 400 },
    'JetBrains Mono 500': { name: 'JetBrains Mono', data: instanceWeight(jetBrainsMono, 500, workDir), weight: 500 },
  };
}

function buildTree() {
  const [firstName, ...restName] = author.name.split(' ');
  const eyebrow = 'independent practitioner';

  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        width: `${WIDTH}px`,
        height: `${HEIGHT}px`,
        padding: '84px',
        backgroundColor: PALETTE.bg,
        fontFamily: 'Space Grotesk',
      },
      children: [
        {
          type: 'div',
          props: {
            style: { display: 'flex', justifyContent: 'flex-end' },
            children: {
              type: 'span',
              props: {
                style: {
                  fontFamily: 'JetBrains Mono',
                  fontWeight: 500,
                  fontSize: 20,
                  letterSpacing: 3,
                  color: PALETTE.textMuted,
                },
                children: eyebrow,
              },
            },
          },
        },
        {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'column', flexGrow: 1, justifyContent: 'center' },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    flexWrap: 'wrap',
                    fontFamily: 'Space Grotesk',
                    fontWeight: 700,
                    fontSize: 74,
                    letterSpacing: -1.5,
                    lineHeight: 1.05,
                  },
                  children: [
                    { type: 'span', props: { style: { color: PALETTE.accent, marginRight: '20px' }, children: firstName } },
                    { type: 'span', props: { style: { color: PALETTE.textPrimary }, children: restName.join(' ') } },
                  ],
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    width: '110px',
                    height: '4px',
                    backgroundColor: PALETTE.accent,
                    marginTop: '26px',
                    marginBottom: '28px',
                  },
                  children: [],
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    fontFamily: 'Space Grotesk',
                    fontWeight: 600,
                    fontSize: 30,
                    lineHeight: 1.4,
                    color: PALETTE.textSecondary,
                    maxWidth: '760px',
                  },
                  children: tagline,
                },
              },
            ],
          },
        },
        {
          type: 'div',
          props: {
            style: { display: 'flex' },
            children: {
              type: 'span',
              props: {
                style: {
                  fontFamily: 'JetBrains Mono',
                  fontWeight: 500,
                  fontSize: 20,
                  letterSpacing: 2,
                  color: PALETTE.textMuted,
                },
                children: 'theohermann.ch',
              },
            },
          },
        },
      ],
    },
  };
}

async function render() {
  const workDir = mkdtempSync(join(tmpdir(), 'og-fonts-'));
  try {
    const fontMap = loadFonts(workDir);
    const svg = await satori(buildTree(), {
      width: WIDTH,
      height: HEIGHT,
      fonts: Object.values(fontMap),
    });
    return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

const checkMode = process.argv.includes('--check');
const png = await render();

if (checkMode) {
  if (!existsSync(OUT)) {
    console.error(`✗ ${OUT} does not exist — run \`node scripts/make-og.mjs\` first`);
    process.exit(1);
  }
  const committed = readFileSync(OUT);
  if (!committed.equals(png)) {
    console.error(`✗ public/og-default.png is stale (committed ${committed.length}B, regenerated ${png.length}B) — run \`node scripts/make-og.mjs\``);
    process.exit(1);
  }
  console.log(`✓ public/og-default.png matches the generator (${png.length}B)`);
} else {
  writeFileSync(OUT, png);
  console.log(`✓ wrote ${OUT} (${(png.length / 1024).toFixed(1)} KB)`);
}
