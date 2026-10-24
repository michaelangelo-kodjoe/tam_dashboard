// Repository guards from the design guidelines / PM spec, enforced as tests.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const SRC = __dirname;
const files = walk(SRC);

describe('guards', () => {
  it('no raw colour values outside styles/tokens.css (guidelines §1)', () => {
    const offenders: string[] = [];
    for (const f of files.filter((x) => /\.(css|tsx?)$/.test(x) && !x.endsWith('tokens.css') && !x.endsWith('lib/richText.ts') /* the fixed note text-colour palette the server sanitiser accepts */ && !/\.test\.tsx?$/.test(x))) {
      const text = readFileSync(f, 'utf8');
      if (/#[0-9a-fA-F]{3,8}\b(?![\w-])/.test(text.replace(/&#\d+;/g, '')) || /\brgba?\(/.test(text) || /\bhsla?\(/.test(text)) offenders.push(relative(SRC, f));
    }
    expect(offenders).toEqual([]);
  });

  it('fetch is only called inside src/data (single data boundary)', () => {
    const offenders = files
      .filter((x) => /\.tsx?$/.test(x) && !/\.test\.tsx?$/.test(x) && !relative(SRC, x).startsWith('data/'))
      .filter((x) => /\bfetch\s*\(/.test(readFileSync(x, 'utf8')))
      .map((x) => relative(SRC, x));
    expect(offenders).toEqual([]);
  });

  it('no native <select>, no Tailwind classes, no dangerouslySetInnerHTML', () => {
    const tsx = files.filter((x) => /\.tsx$/.test(x) && !/\.test\.tsx$/.test(x));
    for (const f of tsx) {
      const t = readFileSync(f, 'utf8');
      expect(t, relative(SRC, f)).not.toMatch(/<select[\s>]/);
      expect(t, relative(SRC, f)).not.toMatch(/dangerouslySetInnerHTML/);
    }
    const pkg = JSON.parse(readFileSync(join(SRC, '../package.json'), 'utf8'));
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => /tailwind/i.test(d))).toEqual([]);
  });

  it('banned visual effects are not used (gradients, backdrop blur)', () => {
    for (const f of files.filter((x) => x.endsWith('.css'))) {
      const t = readFileSync(f, 'utf8');
      expect(t, relative(SRC, f)).not.toMatch(/gradient\(|backdrop-filter/);
    }
  });

  // ---- Run 2 (docs/02_DESIGN_GUIDELINES.md §15.6 item 10, T-70) -------------------------------------------------
  // Scoped to the Run 2 files: the Run 1 overlay entrance, skeleton pulse and refresh spinner predate §15 and are
  // already disabled under prefers-reduced-motion; QA decides whether to retire them.
  const run2Css = ['instruments.css', 'today.css', 'refresh.css'].map((f) => join(SRC, 'styles', f));
  const run2Tsx = files.filter((x) => /(components\/ui\/Instruments|pages\/today\/|pages\/workspace\/(HeaderBand|TopItem|UpgradeTimeline)|pages\/AccountsPage)[^/]*\.tsx$/.test(x) && !/\.test\./.test(x));

  it('Run 2 files: no animation, keyframes, gradients, blur or shadows; radii only from tokens', () => {
    expect(run2Tsx.length).toBeGreaterThanOrEqual(7);
    for (const f of [...run2Css, ...run2Tsx, join(SRC, 'lib/triage.ts'), join(SRC, 'lib/instruments.ts')]) {
      const t = readFileSync(f, 'utf8');
      const name = relative(SRC, f);
      expect(t, name).not.toMatch(/@keyframes|animation\s*:|animation-/);
      expect(t, name).not.toMatch(/gradient\(|backdrop-filter|filter\s*:\s*blur/);
      expect(t, name).not.toMatch(/box-shadow/);
      for (const m of t.matchAll(/border-radius\s*:\s*([^;}]+)/g)) {
        expect(m[1].trim(), `${name}: ${m[0]}`).toMatch(/^(var\(--r-(sm|md|lg|round)\)|1px(\s+1px\s+0\s+0)?|0)$/);
      }
      expect(t, name).not.toMatch(/style=\{\{[^}]*(color|background)\s*:/);
    }
  });

  it('Today detail has no steps, next action or completion control (D-28)', () => {
    const todayFiles = files.filter((x) => /pages\/today\//.test(x) && /\.tsx$/.test(x) && !/\.test\./.test(x)).concat(join(SRC, 'pages/workspace/TopItem.tsx'), join(SRC, 'lib/triage.ts'));
    for (const f of todayFiles) {
      const t = readFileSync(f, 'utf8');
      expect(t, relative(SRC, f)).not.toMatch(/What to do|Mark complete|next[- ]action|\bsteps\b/i);
    }
  });

  it('the three solid tint surfaces equal the status colour at 12% over --surface-1 (§15.2)', () => {
    const css = readFileSync(join(SRC, 'styles/tokens.css'), 'utf8');
    const hex = (name: string) => {
      const m = new RegExp(`--${name}:\\s*#([0-9a-fA-F]{6})`).exec(css);
      if (!m) throw new Error(`token ${name} not found`);
      return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
    };
    const blend = (fg: number[], bg: number[]) => fg.map((c, i) => Math.round(bg[i] + 0.12 * (c - bg[i])));
    const surface = hex('surface-1');
    for (const [tint, colour] of [['surface-warning', 'warning'], ['surface-danger', 'danger'], ['surface-accent', 'accent']] as const) {
      const got = hex(tint);
      const want = blend(hex(colour), surface);
      got.forEach((c, i) => expect(Math.abs(c - want[i]), `${tint}[${i}]`).toBeLessThanOrEqual(1));
    }
  });

  it('import UI: no percentage, score or similarity text or field; calm rules in import.css (D-42, §15.6)', () => {
    const imp = files.filter((x) => /components\/import\/|SimilarAccountPanel/.test(x) && /\.tsx?$/.test(x) && !/\.test\./.test(x)).concat(join(SRC, 'styles/import.css'));
    expect(imp.length).toBeGreaterThan(5);
    for (const f of imp) {
      const t = readFileSync(f, 'utf8');
      const name = relative(SRC, f);
      expect(t, name).not.toMatch(/similarity|\bscore\b|percent/i);
      if (/\.tsx?$/.test(f)) expect(t, name).not.toMatch(/\d\s?%(?![\w)])/);
      expect(t, name).not.toMatch(/gradient\(|backdrop-filter|@keyframes|\banimation\s*:/);
      expect(t, name).not.toMatch(/box-shadow/);
    }
    // the data layer never maps a numeric score either
    expect(readFileSync(join(SRC, 'types.ts'), 'utf8').split('Account bulk import and duplicate check')[1]).not.toMatch(/similarity|score|percent/i);
  });
});
