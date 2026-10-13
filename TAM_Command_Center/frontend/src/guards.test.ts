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
    for (const f of files.filter((x) => /\.(css|tsx?)$/.test(x) && !x.endsWith('tokens.css') && !/\.test\.tsx?$/.test(x))) {
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
});
