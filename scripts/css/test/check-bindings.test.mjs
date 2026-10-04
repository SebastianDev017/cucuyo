// Tests for scripts/css/check-bindings.mjs. The required fixtures live in
// fixtures/check/<scenario> (+ fixtures/asset/base.css, fixtures/vars/*):
//   clean            every golden bundle pasted + hand-written rules → exit 0
//   missing-media    .title has a desktop rule and two media variants; the
//                    (min-width: 750px) and (max-width: 989.98px) one is missing → (a)
//   wrong-fallback   the (max-width: 989px) chain ends in 1.3rem, not calc(…) → (b)
//   duplicate-owner  .title { font-size } bound in two sections → (c)
//   root collision   clean + a css-variables that also emits --fixture-gap → (d)
// The Liquid fixtures are stored as *.liquid.txt: Theme Check lints every
// *.liquid inside a sections/ or snippets/ folder anywhere in the repository,
// so real names would add offenses to the theme's gate. materialize() copies a
// scenario into a temporary theme with the real names. The other cases build
// small themes under the OS temp folder too; the repository is only read.
//
// Run: node --test "scripts/css/test/*.test.mjs"

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkBindings, DEFAULT_ROOT_ALLOW } from '../check-bindings.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(TEST_DIR, 'fixtures');
const CHECK = path.resolve(TEST_DIR, '..', 'check-bindings.mjs');
const REPO = path.resolve(TEST_DIR, '..', '..', '..');
const ASSET = path.join(FIX, 'asset', 'base.css');
const VARS = path.join(FIX, 'vars', 'css-variables.liquid.txt');
const VARS_COLLISION = path.join(FIX, 'vars', 'css-variables-collision.liquid.txt');

const temps = [];
after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

const run = (args, cwd = TEST_DIR) => {
  const r = spawnSync(process.execPath, [CHECK, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const listFiles = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name))])).sort();

/** The Liquid fixtures are stored as *.liquid.txt (Theme Check scans every
 *  *.liquid under sections/ or snippets/ folders, wherever they are); this
 *  copies fixtures/check/<name> into a temporary theme with the real names. */
const materialized = new Map();
function materialize(name) {
  if (materialized.has(name)) return materialized.get(name);
  const src = path.join(FIX, 'check', name);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `css-fx-${name}-`));
  temps.push(root);
  for (const rel of listFiles(src)) {
    const dst = path.join(root, rel.replace(/\.liquid\.txt$/, '.liquid'));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(src, rel), dst);
  }
  materialized.set(name, root);
  return root;
}
const scenario = (name, ...extra) => run(['--root', materialize(name), '--css', ASSET, '--vars', VARS, ...extra]);

/** A temporary theme: the fixture asset + css-variables and the given files. */
function theme(files, { css = fs.readFileSync(ASSET, 'utf8') } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'css-check-'));
  temps.push(root);
  fs.mkdirSync(path.join(root, 'assets'));
  fs.mkdirSync(path.join(root, 'snippets'));
  fs.mkdirSync(path.join(root, 'sections'));
  fs.writeFileSync(path.join(root, 'assets', 'base.css'), css);
  fs.copyFileSync(VARS, path.join(root, 'snippets', 'css-variables.liquid'));
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
  return root;
}
const sheet = (css) => `<div></div>\n{% stylesheet %}\n${css}\n{% endstylesheet %}\n`;
const LABEL_TOP = '.label {\n  letter-spacing: var(--label-ls, 0.1em);\n}';
const LABEL_MOBILE = '@media (max-width: 749px) {\n  .label {\n    letter-spacing: var(--label-ls-m, var(--label-ls, 0.1em));\n  }\n}';

/* --------------------------------------------------- required fixtures */

test('clean fixture: exit 0, every check ok, new components and added variants accepted', () => {
  const r = scenario('clean');
  assert.equal(r.code, 0, r.out);
  // .title--small is re-declared verbatim (order only): re-declared, not bound
  assert.match(r.out, /pairs {10}bound 12 · re-declared 13 · new 3 · added variants 1/);
  assert.match(r.out, /\(a\) coverage {3}ok — 13 re-declared selector\/property pair\(s\) fully covered, 1 added variant/);
  assert.match(r.out, /\(b\) fallback {3}ok — 19 declaration\(s\) compared/);
  assert.match(r.out, /\(c\) uniqueness ok/);
  assert.match(r.out, /\(d\) :root {6}ok — 7 custom properties on :root in .*; 1 also on :root in the asset CSS, all allow-listed/);
  assert.match(r.out, /allow-listed {2}--card-gap/);
  assert.match(r.out, /snippets\/label\.liquid:24 \.label \{ letter-spacing \} in @media \(max-width: 749px\)/);
  // strict is the default, and nothing is found
  assert.match(r.out, /\(strict\) {7}ok — no cascade-order, hover-default or shared-token finding/);
  assert.ok(!/warnings \(/.test(r.out), r.out);
  assert.match(r.out, /\nPASS\n$/);
  assert.equal(scenario('clean', '--strict').code, 0);
  assert.match(scenario('clean', '--lenient').out, /\(strict\) {7}off \(--lenient\) — 0 cascade-order/);
});

test('missing media coverage: exit 1 naming file, selector, property and the verbatim query', () => {
  const r = scenario('missing-media');
  assert.equal(r.code, 1);
  assert.match(r.out, /\(a\) coverage {3}FAIL — 1 problem\(s\)/);
  assert.match(r.out, /sections\/hero\.liquid:\d+ \.title \{ font-size \}: missing @media \(min-width: 750px\) and \(max-width: 989\.98px\): .*base\.css:\d+ "font-size: 1\.4rem" is not re-declared/);
  // the covered variant is not reported
  assert.ok(!/missing @media \(max-width: 989px\)/.test(r.out));
  assert.match(r.out, /\(b\) fallback {3}ok/);
  assert.match(r.out, /FAIL — 1 failed assertion\(s\)\n$/);
});

test('wrong fallback: exit 1 with the innermost value and the asset value', () => {
  const r = scenario('wrong-fallback');
  assert.equal(r.code, 1);
  assert.match(r.out, /\(a\) coverage {3}ok/);
  assert.match(r.out, /sections\/hero\.liquid:\d+ \.title \{ font-size \}: innermost fallback "1\.3rem" ≠ asset value "calc\(1\.3rem \* var\(--heading-scale, 1\)\)" \(.*base\.css:\d+, @media \(max-width: 989px\)\)/);
});

test('duplicate owner: exit 1 naming both files', () => {
  const r = scenario('duplicate-owner');
  assert.equal(r.code, 1);
  assert.match(r.out, /\(a\) coverage {3}ok/);
  assert.match(r.out, /\(c\) uniqueness FAIL — 1 problem\(s\)\n {2}sections\/hero\.liquid \+ sections\/promo\.liquid \.title \{ font-size \}: bound in 2 theme files/);
});

test(':root collision: exit 1 naming the token, both places and the reason; allow-list fixes it', () => {
  const r = run(['--root', materialize('clean'), '--css', ASSET, '--vars', VARS_COLLISION]);
  assert.equal(r.code, 1);
  assert.match(r.out, /\(d\) :root {6}FAIL — 1 problem\(s\)\n {2}.*base\.css:8 --fixture-gap: --fixture-gap is emitted by .*css-variables-collision\.liquid\.txt \(line 10\) and also declared on :root at .*base\.css:8; the later declaration wins, so the setting is dead/);
  const allowed = run(['--root', materialize('clean'), '--css', ASSET, '--vars', VARS_COLLISION, '--allow', '--card-gap,--fixture-gap']);
  assert.equal(allowed.code, 0, allowed.out);
  // and the default allow-list does not cover anything but the five card tokens
  const none = scenario('clean', '--allow', 'none');
  assert.equal(none.code, 1);
  assert.match(none.out, /--card-gap: --card-gap is emitted by/);
});

test('allow-list files: JSON array, {"names": [...]} and one name per line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'css-allow-'));
  temps.push(dir);
  const files = {
    'a.json': JSON.stringify(['--card-gap', '--fixture-gap']),
    'b.json': JSON.stringify({ names: ['--card-gap', '--fixture-gap'] }),
    'c.txt': '# B1 repair pending\n--card-gap\n--fixture-gap   # shadowed by base.css\n',
  };
  for (const [f, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, f), text);
    const r = run(['--root', materialize('clean'), '--css', ASSET, '--vars', VARS_COLLISION, '--allow', path.join(dir, f)]);
    assert.equal(r.code, 0, `${f}: ${r.out}`);
  }
  assert.equal(run(['--root', materialize('clean'), '--allow', 'not a list']).code, 2);
});

test('(e) report: unknown bundle selectors are listed, new components are not', () => {
  const r = scenario('clean');
  assert.match(r.out, /\(e\) report {5}1 bundle selector\(s\) match nothing in the asset CSS:\n {2}sections\/hero\.liquid:\d+ \.title:focus-visible {2}\[state variant of an asset selector\]/);
  assert.ok(!/\.blk-quote|\[data-hover-tuned\] \.title/.test(r.out.split('(e) report')[1]));
  // in blocks/ (theme blocks are scanned like sections and snippets)
  const root = theme({ 'blocks/x.liquid': sheet('.mystery { color: red; }\n.newsletter__field { color: red; }\n[data-color-scheme] .x { color: red; }\n.blk-heading { color: red; }') });
  const e = run(['--root', root]);
  assert.equal(e.code, 0, 'a report, not a failure');
  assert.match(e.out, /stylesheets {4}1 \{% stylesheet %\} block\(s\) in 1 of 2 theme files \(sections 0, snippets 1, blocks 1\)/);
  assert.match(e.out, /1 bundle selector\(s\) match nothing in the asset CSS:\n {2}blocks\/x\.liquid:\d+ \.mystery {2}\[no match\]/);
  assert.match(run(['--root', root, '--new', '.mystery']).out, /every bundle selector matches an asset selector or a new component/);
});

/* ----------------------------------------------------------- coverage */

test('(a) out of order, !important, missing top level and a variant without counterpart', () => {
  const desktop = '.title {\n  font-size: var(--a, calc(1.5rem * var(--heading-scale, 1)));\n}';
  const m989 = '@media (max-width: 989px) {\n  .title {\n    font-size: var(--a-m, calc(1.3rem * var(--heading-scale, 1)));\n  }\n}';
  const m750 = '@media (min-width: 750px) and (max-width: 989.98px) {\n  .title {\n    font-size: var(--a-m, 1.4rem);\n  }\n}';
  const cases = [
    [`${m989}\n${desktop}\n${m750}`, /out of order: the (top level|@media \(max-width: 989px\)) re-declaration must keep its position/],
    [`${desktop.replace(';', ' !important;')}\n${m989}\n${m750}`, /!important differs from .*base\.css:\d+ \(top level\)/],
    [`${m989}\n${m750}`, /missing top level: .*"font-size: calc\(1\.5rem \* var\(--heading-scale, 1\)\)" is not re-declared/],
    [`${desktop}\n${m989}\n${m750}\n@media (max-width: 480px) {\n  .title {\n    font-size: var(--a-s, 1rem);\n  }\n}`, /@media \(max-width: 480px\) has no counterpart in the asset CSS for this selector; added variants are allowed only where the asset sets the property at top level only/],
  ];
  for (const [css, re] of cases) {
    const r = run(['--root', theme({ 'sections/x.liquid': sheet(css) })]);
    assert.equal(r.code, 1, css);
    assert.match(r.out, re);
  }
});

test('(a) a re-declared longhand without the shorthand that shares it fails', () => {
  const box = '.box {\n  padding-top: var(--box-pt, 12px);\n}';
  const r = run(['--root', theme({ 'snippets/box.liquid': sheet(box) })]);
  assert.equal(r.code, 1);
  assert.match(r.out, /\.box \{ padding \}: missing @media \(max-width: 749px\): .*"padding: 8px 10px" is not re-declared/);
});

test('(a) added variants: accepted after the top-level rule with today\'s value, refused otherwise', () => {
  assert.equal(run(['--root', theme({ 'snippets/label.liquid': sheet(`${LABEL_TOP}\n${LABEL_MOBILE}`) })]).code, 0);
  const before = run(['--root', theme({ 'snippets/label.liquid': sheet(`${LABEL_MOBILE}\n${LABEL_TOP}`) })]);
  assert.equal(before.code, 1);
  assert.match(before.out, /an added @media \(max-width: 749px\) variant must come after the re-declared top-level rule/);
  const alone = run(['--root', theme({ 'snippets/label.liquid': sheet(LABEL_MOBILE) })]);
  assert.equal(alone.code, 1);
  assert.match(alone.out, /missing top level/);
  const wrong = run(['--root', theme({ 'snippets/label.liquid': sheet(`${LABEL_TOP}\n${LABEL_MOBILE.replace('0.1em));', '0.2em));')}`) })]);
  assert.equal(wrong.code, 1);
  assert.match(wrong.out, /\(b\) fallback {3}FAIL[\s\S]*\.label \{ letter-spacing \}: .*≠ asset value "0\.1em"/);
  // a longhand variant whose value today comes from a shorthand cannot be derived
  const css = '.p {\n  padding: 4px;\n}\n';
  const sh = run(['--root', theme({ 'sections/x.liquid': sheet('.p {\n  padding: var(--p, 4px);\n}\n@media (max-width: 749px) {\n  .p {\n    padding-top: var(--pt-m, 4px);\n  }\n}') }, { css })]);
  assert.equal(sh.code, 1);
  assert.match(sh.out, /added @media \(max-width: 749px\) variant: today's padding-top of this selector comes from "padding: 4px"/);
});

/* ----------------------------------------------------------- fallback */

test('(b) a var() without fallback loses the asset value; designed values are listed, not failed', () => {
  const nofb = run(['--root', theme({ 'snippets/label.liquid': sheet('.label {\n  letter-spacing: var(--label-ls);\n}') })]);
  assert.equal(nofb.code, 1);
  assert.match(nofb.out, /var\(--label-ls\) has no fallback, so the asset value .*"0\.1em"/);
  const designed = run(['--root', theme({ 'snippets/label.liquid': sheet('.label {\n  letter-spacing: var(--label-ls, 0.14em) /* designed (was: 0.1em) */;\n}') })]);
  assert.equal(designed.code, 0, designed.out);
  assert.match(designed.out, /designed values \(Stage B1; not failures\):\n {2}snippets\/label\.liquid:\d+ \.label \{ letter-spacing \}: asset "0\.1em"/);
});

/* ------------------------------------------------- parse / strict / misc */

test('Liquid inside {% stylesheet %} and an unclosed {% stylesheet %} fail', () => {
  const liquid = run(['--root', theme({ 'sections/x.liquid': sheet('.mystery { color: {{ section.settings.c }}; }') })]);
  assert.equal(liquid.code, 1);
  assert.match(liquid.out, /parse {10}FAIL[\s\S]*sections\/x\.liquid:\d+: CSS parse error in \{% stylesheet %\}: Liquid \(\{\{ \}\} or \{% %\}\) inside \{% stylesheet %\} is not rendered/);
  const open = run(['--root', theme({ 'sections/x.liquid': '{% stylesheet %}\n.mystery { color: red; }\n' })]);
  assert.equal(open.code, 1);
  assert.match(open.out, /has no \{% endstylesheet %\}/);
});

/* .title re-declared in full (coverage and fallback are fine) */
const TITLE_TOP = '.title {\n  font-size: var(--a, calc(1.5rem * var(--heading-scale, 1)));\n}';
const TITLE_SMALL = '.title--small {\n  font-size: 1rem;\n}';
const TITLE_MEDIA = '@media (max-width: 989px) {\n  .title {\n    font-size: var(--a-m, var(--a, calc(1.3rem * var(--heading-scale, 1))));\n  }\n}\n@media (min-width: 750px) and (max-width: 989.98px) {\n  .title {\n    font-size: var(--a-m, var(--a, 1.4rem));\n  }\n}';

test('strict by default: cascade-order and hover-default findings fail; --lenient lists them as warnings', () => {
  // .title re-declared without .title--small (same specificity, later in the asset)
  const css = `${TITLE_TOP}\n${TITLE_MEDIA}\n.label:focus-visible {\n  color: var(--label-focus-ink, red);\n}`;
  const root = theme({ 'sections/x.liquid': sheet(css) });
  const def = run(['--root', root]);
  assert.equal(def.code, 1, def.out);
  assert.match(def.out, /\(a\) coverage {3}ok[\s\S]*\(b\) fallback {3}ok/);
  assert.match(def.out, /\(strict\) {7}FAIL — 2 cascade-order \/ hover-default \/ shared-token finding\(s\)/);
  assert.match(def.out, /sections\/x\.liquid \.title: cascade order — .*base\.css:\d+ "\.title--small" sets font-size with the specificity of "\.title" after it; where both match one element it wins today and loses to the re-declaration — re-declare "\.title--small" for font-size in sections\/x\.liquid too, after "\.title" \(verbatim is enough: extract-bindings "var": \[\], "token": \[\]\)/);
  assert.match(def.out, /sections\/x\.liquid:\d+ \.label:focus-visible \{ color \}: hover default: defaults to "red" but the element's hover color is "var\(--color-accent\)" today \(.*base\.css:\d+\)/);
  assert.equal(run(['--root', root, '--strict']).code, 1);
  for (const flag of ['--lenient', '--no-strict']) {
    const loose = run(['--root', root, flag]);
    assert.equal(loose.code, 0, loose.out);
    assert.match(loose.out, /\(strict\) {7}off \(--lenient\) — 2 cascade-order \/ hover-default \/ shared-token finding\(s\) listed under warnings/);
    assert.match(loose.out, /warnings \(\d+\):[\s\S]*cascade order — [\s\S]*hover default: defaults to "red"/);
  }
  // the API defaults to strict too; strict: false reports only
  assert.equal(checkBindings({ root }).ok, false);
  assert.equal(checkBindings({ root, strict: false }).ok, true);
  // the strict findings belong to (a)/(b): --checks d skips them
  assert.equal(run(['--root', root, '--checks', 'd']).code, 0);
});

test('cascade order: the modifier re-declared verbatim after the bound selector passes; in the wrong order it fails', () => {
  const ok = run(['--root', theme({ 'sections/x.liquid': sheet(`${TITLE_TOP}\n${TITLE_SMALL}\n${TITLE_MEDIA}`) })]);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /\(strict\) {7}ok/);
  const wrong = run(['--root', theme({ 'sections/x.liquid': sheet(`${TITLE_SMALL}\n${TITLE_TOP}\n${TITLE_MEDIA}`) })]);
  assert.equal(wrong.code, 1, wrong.out);
  assert.match(wrong.out, /\(strict\) {7}FAIL — 1 /);
  assert.match(wrong.out, /cascade order — "\.title(--small)?" and "\.title(--small)?" are both re-declared in sections\/x\.liquid, but not in the asset order \(asset: \.title top level → \.title--small top level → \.title @media \(max-width: 989px\) → \.title @media \(min-width: 750px\) and \(max-width: 989\.98px\); bundle: \.title--small top level → \.title top level → /);
  // a re-declaration of the modifier in ANOTHER file does not keep the order
  const two = run(['--root', theme({ 'sections/x.liquid': sheet(`${TITLE_TOP}\n${TITLE_MEDIA}`), 'sections/y.liquid': sheet(TITLE_SMALL) })]);
  assert.equal(two.code, 1);
  assert.match(two.out, /"\.title--small" sets font-size with the specificity of "\.title" after it and is re-declared in sections\/y\.liquid \(bundle order between files is not guaranteed: move both into one file\)/);
});

test('hover defaults are compared per media context', () => {
  const css = '.lnk {\n  color: red;\n}\n@media (max-width: 749px) {\n  .lnk {\n    color: blue;\n  }\n}\n';
  const top = '.lnk:focus-visible {\n  color: var(--f, red);\n}';
  // a top-level state rule defaulting to the top-level value: passes, with a note on the phone context
  const a = run(['--root', theme({ 'sections/x.liquid': sheet(top) }, { css })]);
  assert.equal(a.code, 0, a.out);
  assert.match(a.out, /\.lnk:focus-visible \{ color \} — today's color inside "@media \(max-width: 749px\)" is "blue" \(.*base\.css:6\), and no state rule of this bundle sits in that query/);
  // with the phone variant too: no note
  const both = run(['--root', theme({ 'sections/x.liquid': sheet(`${top}\n@media (max-width: 749px) {\n  .lnk:focus-visible {\n    color: var(--f, blue);\n  }\n}`) }, { css })]);
  assert.equal(both.code, 0, both.out);
  assert.ok(!/no state rule of this bundle/.test(both.out), both.out);
  // a phone variant with the desktop value: a finding
  const bad = run(['--root', theme({ 'sections/x.liquid': sheet(`${top}\n@media (max-width: 749px) {\n  .lnk:focus-visible {\n    color: var(--f, red);\n  }\n}`) }, { css })]);
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /\.lnk:focus-visible \{ color \}: hover default: defaults to "red" but the element's color is "blue" today \(@media \(max-width: 749px\), .*base\.css:6\)/);
});

test('shared token: one :root token read by re-declarations whose values differ fails; scheme-only tokens do not', () => {
  // --t-title-size-m is on :root in the fixture css-variables
  const media = TITLE_MEDIA.replace(/var\(--a-m, var\(--a, /g, 'var(--a-m, var(--a, var(--t-title-size-m, ').replace(/\)\);/g, ')));');
  const r = run(['--root', theme({ 'sections/x.liquid': sheet(`${TITLE_TOP}\n${TITLE_SMALL}\n${media}`) })]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /\(a\) coverage {3}ok[\s\S]*\(b\) fallback {3}ok/);
  assert.match(r.out, /shared token: --t-title-size-m \(assigned on :root in css-variables\) is read by re-declarations whose values differ today — "calc\(1\.3rem \* var\(--heading-scale, 1\)\)" at sections\/x\.liquid:\d+ \.title \{ font-size \} in @media \(max-width: 989px\); "1\.4rem" at sections\/x\.liquid:\d+ \.title \{ font-size \} in @media \(min-width: 750px\) and \(max-width: 989\.98px\)/);
  assert.equal(run(['--root', theme({ 'sections/x.liquid': sheet(`${TITLE_TOP}\n${TITLE_SMALL}\n${media}`) }), '--lenient']).code, 0);
  // --color-heading is assigned only in a [data-color-scheme] block: a common value there is the point
  const css = '.lnk {\n  color: red;\n}\n@media (max-width: 749px) {\n  .lnk {\n    color: blue;\n  }\n}\n';
  const role = run(['--root', theme({ 'sections/x.liquid': sheet('.lnk {\n  color: var(--x, var(--color-heading, red));\n}\n@media (max-width: 749px) {\n  .lnk {\n    color: var(--x-m, var(--x, var(--color-heading, blue)));\n  }\n}') }, { css })]);
  assert.equal(role.code, 0, role.out);
});

test('--only limits coverage to one file; --checks runs a subset; --json is machine-readable', () => {
  const root = materialize('duplicate-owner');
  const only = run(['--root', root, '--css', ASSET, '--vars', VARS, '--only', 'sections/promo.liquid']);
  assert.equal(only.code, 1, 'a uniqueness conflict involving the file is still reported');
  assert.match(only.out, /\(only: sections\/promo\.liquid\)/);
  const d = run(['--root', materialize('missing-media'), '--css', ASSET, '--vars', VARS, '--checks', 'd']);
  assert.equal(d.code, 0, 'the coverage failure is not part of --checks d');
  assert.match(d.out, /\(a\) coverage {3}skipped/);
  const j = run(['--root', materialize('wrong-fallback'), '--css', ASSET, '--vars', VARS, '--json']);
  assert.equal(j.code, 1);
  const parsed = JSON.parse(j.out);
  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.failures.map((f) => [f.check, f.file, f.selector, f.property]), [['b', 'sections/hero.liquid', '.title', 'font-size']]);
  assert.equal(run(['--checks', 'z']).code, 2);
  assert.equal(run(['--bogus']).code, 2);
});

/* ------------------------------------------------------------ real repo */

test('real repo: (d) passes with the built-in allow-list, and nothing but the five card tokens collides', () => {
  const r = checkBindings({ root: REPO, checks: ['d'] });
  assert.equal(r.ok, true, JSON.stringify(r.failures, null, 1));
  assert.ok(r.root_tokens.names >= 27, 'css-variables keeps at least today\'s 27 :root tokens');
  for (const a of r.root_tokens.allowed) assert.ok(DEFAULT_ROOT_ALLOW.includes(a.name), a.name);
  const none = checkBindings({ root: REPO, checks: ['d'], allow: 'none' });
  for (const c of none.root_tokens.collisions) assert.ok(DEFAULT_ROOT_ALLOW.includes(c.name), `${c.name} collides and is not one of the five card tokens`);
});

test('real repo: every {% stylesheet %} parses (no parse failures)', () => {
  const r = checkBindings({ root: REPO, checks: ['e'] });
  assert.deepEqual(r.failures.filter((f) => f.check === 'parse'), []);
});
