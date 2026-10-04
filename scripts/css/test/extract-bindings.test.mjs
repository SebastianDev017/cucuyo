// Tests for scripts/css/extract-bindings.mjs: the golden-file test on the
// fixture bindings, the structural guarantees (every media variant, verbatim
// @media strings, original value as innermost fallback), the asset-file
// discovery (base.css alone / base.css + base-pages.css / CRLF), the media
// defaults and the error cases. Everything that writes runs under the OS temp
// folder; the repository is only read.
//
// Run: node --test "scripts/css/test/*.test.mjs"

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as P from '../lib/css-parse.mjs';
import { normalizeBindings, extractBindings, readRegion } from '../extract-bindings.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(TEST_DIR, 'fixtures');
const EXTRACT = path.resolve(TEST_DIR, '..', 'extract-bindings.mjs');
const CHECK = path.resolve(TEST_DIR, '..', 'check-bindings.mjs');
const ASSET = path.join(FIX, 'asset', 'base.css');
const BINDINGS = path.join(FIX, 'extract', 'bindings.json');
const EXPECTED = path.join(FIX, 'extract', 'expected');
const VARS = path.join(FIX, 'vars', 'css-variables.liquid.txt');

const temps = [];
after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });
function tmp(prefix = 'css-extract-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(d);
  return d;
}
const lf = (s) => s.replace(/\r\n/g, '\n');
const run = (script, args, cwd = TEST_DIR) => {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const listFiles = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name), base) : [P.toPosix(path.relative(base, path.join(dir, e.name)))])).sort();
function writeJson(dir, name, data) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
  return p;
}
/** fixtures/check/<name> (Liquid stored as *.liquid.txt so Theme Check does not
 *  lint it) copied into a temporary theme with the real file names. */
function materialize(name) {
  const src = path.join(FIX, 'check', name);
  const root = tmp(`css-fx-${name}-`);
  for (const rel of listFiles(src)) {
    const dst = path.join(root, rel.replace(/\.liquid\.txt$/, '.liquid'));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(src, rel), dst);
  }
  return root;
}
/** In-process extraction against an inline asset stylesheet. */
function extractInline(css, bindings, opts = {}) {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(root, 'assets', 'base.css'), css);
  const { entries, errors } = normalizeBindings(bindings, 'inline.json');
  assert.deepEqual(errors, []);
  return { ...extractBindings({ root, entries, bindingsLabel: 'inline.json', varsFile: null, ...opts }), root };
}

/* ------------------------------------------------------------------ golden */

test('golden: the fixture bindings reproduce the expected per-owner rule sets byte for byte', () => {
  const out = tmp();
  const r = run(EXTRACT, [BINDINGS, '--root', path.join(FIX, 'extract'), '--css', ASSET, '--no-vars', '--out', out]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(listFiles(out), listFiles(EXPECTED));
  for (const f of listFiles(EXPECTED)) {
    assert.equal(lf(fs.readFileSync(path.join(out, f), 'utf8')), lf(fs.readFileSync(path.join(EXPECTED, f), 'utf8')), f);
  }
});

test('golden: every media variant of each bound selector is re-declared, @media strings verbatim, original value innermost', () => {
  const asset = P.parseCss(fs.readFileSync(ASSET, 'utf8'));
  const index = P.indexBySelector(asset.rules);
  const { entries } = normalizeBindings(JSON.parse(fs.readFileSync(BINDINGS, 'utf8')));
  for (const e of entries) {
    const text = lf(fs.readFileSync(path.join(EXPECTED, `${e.file}.css`), 'utf8'));
    const out = P.parseCss(text);
    const assetDecls = P.declarationsFor(index, e.selKey).filter((d) => d.decl.prop === e.prop);
    assert.ok(assetDecls.length > 0, `${e.selector} { ${e.property} } exists in the fixture`);
    const outDecls = P.declarationsFor(P.indexBySelector(out.rules), e.selKey).filter((d) => d.decl.prop === e.prop);
    // same sequence of wrappers (one emitted rule per asset rule, same order)
    assert.deepEqual(outDecls.map((d) => P.wrapperLabel(d.rule.wrappers)), assetDecls.map((d) => P.wrapperLabel(d.rule.wrappers)), `${e.selector} { ${e.property} }`);
    assetDecls.forEach((a, i) => {
      const o = outDecls[i];
      for (const w of a.rule.wrappers) assert.ok(text.includes(`@${w.name} ${w.prelude} {`), `verbatim "@${w.name} ${w.prelude}" in ${e.file}`);
      const label = `${e.selector} { ${e.property} } in ${P.wrapperLabel(a.rule.wrappers) || 'top level'}`;
      if (e.verbatim) {
        // "var": [], "token": []: re-declared as it is (only the order matters)
        assert.equal(o.decl.value, a.decl.value, label);
        return;
      }
      assert.ok(P.varChain(o.decl.value).vars.length >= 1, `${o.decl.value} is a var() chain`);
      // the original value is the innermost fallback, verbatim: "var(--a, var(--b, <original>))"
      assert.match(o.decl.value, new RegExp(`, ${a.decl.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)+$`), label);
      // and with the binding variables unset the chain renders exactly the asset value
      assert.equal(P.stripForeignVars(o.decl.value, P.customPropsIn(a.decl.value)).value, a.decl.value, label);
      assert.equal(o.decl.important, a.decl.important);
    });
  }
});

test('golden: .title keeps the desktop rule and both media variants with the §6.3 mobile chain', () => {
  const hero = lf(fs.readFileSync(path.join(EXPECTED, 'sections', 'hero.liquid.css'), 'utf8'));
  assert.match(hero, /^\.title \{\n {2}font-size: var\(--hero-title-size, var\(--t-title-size, calc\(1\.5rem \* var\(--heading-scale, 1\)\)\)\);$/m);
  // §6.3: var(--x-size-m, var(--x-size, var(--t-…-size-m, <original>)))
  assert.match(hero, /@media \(max-width: 989px\) \{\n {2}\.title \{\n {4}font-size: var\(--hero-title-size-m, var\(--hero-title-size, var\(--t-title-size-m, calc\(1\.3rem \* var\(--heading-scale, 1\)\)\)\)\);/);
  // the tablet variant reads no token ("media": { …: { "token": [] } }), so --t-title-size-m drives one value only
  assert.match(hero, /@media \(min-width: 750px\) and \(max-width: 989\.98px\) \{\n {2}\.title \{\n {4}font-size: var\(--hero-title-size-m, var\(--hero-title-size, 1\.4rem\)\);/);
  // the modifier is re-declared verbatim ("var": [], "token": []), after .title and before the 989px variants
  assert.match(hero, /\.title:hover \{[^}]*\}\n\n\.title--small \{\n {2}font-size: 1rem;\n\}\n\n@media \(max-width: 989px\)/);
  // only the bound property: margin / line-height of the same rules stay out
  assert.ok(!/margin|line-height/.test(hero));
  // the selector list ".title, .subtitle" is not dragged in
  assert.ok(!hero.includes('.subtitle'));
  // and the golden bindings raise no shared-token or cascade-order warning
  const r = run(EXTRACT, [BINDINGS, '--root', path.join(FIX, 'extract'), '--css', ASSET, '--no-vars']);
  assert.ok(!/shared token|cascade order/.test(r.err), r.err);
});

test('golden: a bound longhand brings the shorthand that shares it, verbatim (cascade kept)', () => {
  const box = lf(fs.readFileSync(path.join(EXPECTED, 'snippets', 'box.liquid.css'), 'utf8'));
  assert.match(box, /@media \(max-width: 749px\) \{\n {2}\.box \{\n {4}padding: 8px 10px;\n {2}\}\n\}/);
  const r = run(EXTRACT, [BINDINGS, '--root', path.join(FIX, 'extract'), '--css', ASSET, '--no-vars']);
  assert.match(r.err, /padding is re-declared verbatim too \(it shares longhands with padding-top\)/);
  // and the control does not reach the phone rule: said so, with the template pointer
  assert.match(r.err, /\.box \{ padding-top \} — inside "@media \(max-width: 749px\)" this selector sets padding-top only through "padding: 8px 10px" \(.*base\.css:\d+\), which is re-declared verbatim, so the control does not reach it there\. To carry it, bind padding too with a "template"/);
});

/* ------------------------------------------------------- asset discovery */

test('base.css alone, base.css + base-pages.css (split anywhere) and CRLF give the same output', () => {
  const css = fs.readFileSync(ASSET, 'utf8');
  const golden = run(EXTRACT, [BINDINGS, '--root', path.join(FIX, 'extract'), '--css', ASSET, '--no-vars']).out;
  const cut = css.indexOf('@media (max-width: 989px)');
  const layouts = {
    alone: { 'base.css': css },
    split: { 'base.css': css.slice(0, cut), 'base-pages.css': css.slice(cut) },
    crlf: { 'base.css': css.replace(/\r?\n/g, '\r\n') },
    'split-crlf': { 'base.css': css.slice(0, cut).replace(/\r?\n/g, '\r\n'), 'base-pages.css': css.slice(cut).replace(/\r?\n/g, '\r\n') },
  };
  for (const [name, files] of Object.entries(layouts)) {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'assets'));
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(root, 'assets', f), text);
    fs.copyFileSync(BINDINGS, path.join(root, 'bindings.json'));
    const r = run(EXTRACT, ['bindings.json', '--root', root, '--no-vars'], root);
    assert.equal(r.code, 0, `${name}: ${r.err}`);
    assert.equal(lf(r.out), lf(golden), name);
  }
});

test('the real assets parse cleanly and the sample media-overlay binding gives the §4.5 rules', () => {
  const repo = path.resolve(TEST_DIR, '..', '..', '..');
  // §4.5 spells the ≤989px chain with the -m variable only (B1 sets the desktop
  // inset, phones keep 24px / 28px), so the binding sets media_var explicitly
  const r = extractBindings({
    root: repo,
    varsFile: null,
    entries: normalizeBindings([
      { file: 'snippets/media-overlay.liquid', selector: '.media-overlay', property: ['right', 'left'], var: 'overlay-inset-x', media_var: 'overlay-inset-x-m' },
      { file: 'snippets/media-overlay.liquid', selector: '.media-overlay', property: 'bottom', var: 'overlay-inset-y', media_var: 'overlay-inset-y-m' },
    ]).entries,
  });
  assert.deepEqual(r.errors, []);
  const text = r.files.get('snippets/media-overlay.liquid').text;
  // §4.5: left/right: var(--overlay-inset-x, 50px); bottom: var(--overlay-inset-y, 65px); ≤989px: -m with 24px / 28px
  assert.match(text, /\.media-overlay \{\n {2}right: var\(--overlay-inset-x, 50px\);\n {2}bottom: var\(--overlay-inset-y, 65px\);\n {2}left: var\(--overlay-inset-x, 50px\);\n\}/);
  assert.match(text, /@media \(max-width: 989px\) \{\n {2}\.media-overlay \{\n {4}right: var\(--overlay-inset-x-m, 24px\);\n {4}bottom: var\(--overlay-inset-y-m, 28px\);\n {4}left: var\(--overlay-inset-x-m, 24px\);/);
  // without media_var the §6.3 default lets the desktop value reach phones
  const d = extractBindings({
    root: repo,
    varsFile: null,
    entries: normalizeBindings([{ file: 'snippets/media-overlay.liquid', selector: '.media-overlay', property: 'bottom', var: 'overlay-inset-y' }]).entries,
  });
  assert.match(d.files.get('snippets/media-overlay.liquid').text, /bottom: var\(--overlay-inset-y-m, var\(--overlay-inset-y, 28px\)\);/);
});

/* ---------------------------------------------------------- media defaults */

const MEDIA_CSS = `.x { font-size: 2rem; color: red; }
@media (max-width: 749px) { .x { font-size: 1.5rem; color: blue; } }
@media (min-width: 1200px) { .x { font-size: 3rem; } }
@media (hover: hover) and (pointer: fine) { .x:hover { color: green; } }
`;

test('narrowing (max-width) variants read <var>-m, <var>, <token>-m (§6.3); other queries read the top-level chain (with a note)', () => {
  const r = extractInline(MEDIA_CSS, [
    { file: 'sections/x.liquid', selector: '.x', property: 'font-size', var: 'x-size', token: '--t-x-size' },
    { file: 'sections/x.liquid', selector: '.x:hover', property: 'color', var: 'x-hover-ink' },
  ]);
  const text = r.files.get('sections/x.liquid').text;
  assert.match(text, /^\.x \{\n {2}font-size: var\(--x-size, var\(--t-x-size, 2rem\)\);/m);
  assert.match(text, /@media \(max-width: 749px\) \{\n {2}\.x \{\n {4}font-size: var\(--x-size-m, var\(--x-size, var\(--t-x-size-m, 1\.5rem\)\)\);/);
  assert.match(text, /@media \(min-width: 1200px\) \{\n {2}\.x \{\n {4}font-size: var\(--x-size, var\(--t-x-size, 3rem\)\);/);
  assert.match(text, /@media \(hover: hover\) and \(pointer: fine\) \{\n {2}\.x:hover \{\n {4}color: var\(--x-hover-ink, green\);/);
  assert.ok(r.warnings.some((w) => /inside "@media \(min-width: 1200px\)" \(not a max-width query\)/.test(w)));
  assert.ok(r.warnings.some((w) => /inside "@media \(hover: hover\) and \(pointer: fine\)" \(not a max-width query\)/.test(w)));
});

test('media_var / media_token override the -m defaults; [] means none; the media map sets one query', () => {
  const r = extractInline(MEDIA_CSS, [
    { file: 'sections/x.liquid', selector: '.x', property: 'font-size', var: 'x-size', token: '--t-x-size', media_var: 'x-size-m', media: { '(min-width: 1200px)': { var: 'x-size-wide', token: [] } } },
    { file: 'sections/x.liquid', selector: '.x', property: 'color', var: 'x-ink', token: '--color-heading', media_token: '--color-heading' },
  ]);
  const text = r.files.get('sections/x.liquid').text;
  // media_var "x-size-m" alone: the desktop override does not reach phones (§4.5 / §4.1 style)
  assert.match(text, /font-size: var\(--x-size-m, var\(--t-x-size-m, 1\.5rem\)\);/);
  assert.match(text, /color: var\(--x-ink-m, var\(--x-ink, var\(--color-heading, blue\)\)\);/);
  assert.match(text, /font-size: var\(--x-size-wide, 3rem\);/);
  const none = extractInline(MEDIA_CSS, [{ file: 'sections/x.liquid', selector: '.x', property: 'font-size', var: 'x-size', media_var: [] }]);
  assert.match(none.files.get('sections/x.liquid').text, /@media \(max-width: 749px\) \{\n {2}\.x \{\n {4}font-size: 1\.5rem;/);
  // several vars: every mobile name first, then the base names
  const many = extractInline(MEDIA_CSS, [{ file: 'sections/x.liquid', selector: '.x', property: 'font-size', var: ['a', 'b'] }]);
  assert.match(many.files.get('sections/x.liquid').text, /font-size: var\(--a-m, var\(--b-m, var\(--a, var\(--b, 1\.5rem\)\)\)\);/);
});

test('a selector list binding emits its members together; the other members of the asset rule stay out', () => {
  const r = extractInline('.a, .b, .c { color: red; }\n@media (max-width: 989px) { .a, .b, .c { color: blue; } }\n', [
    { file: 'sections/x.liquid', selector: '.a, .b', property: 'color', var: 'ab-ink' },
  ]);
  const text = r.files.get('sections/x.liquid').text;
  assert.match(text, /^\.a,\n\.b \{\n {2}color: var\(--ab-ink, red\);\n\}/m);
  assert.match(text, /@media \(max-width: 989px\) \{\n {2}\.a,\n {2}\.b \{\n {4}color: var\(--ab-ink-m, var\(--ab-ink, blue\)\);/);
  assert.ok(!text.includes('.c'));
});

test('a designed value replaces the literal and is marked for check-bindings', () => {
  const r = extractInline('.x { color: var(--color-ink); }\n', [
    { file: 'sections/x.liquid', selector: '.x', property: 'color', var: 'x-ink', token: '--color-link', value: 'var(--color-accent)' },
  ]);
  assert.match(r.files.get('sections/x.liquid').text, /color: var\(--x-ink, var\(--color-link, var\(--color-accent\)\)\) \/\* designed \(was: var\(--color-ink\)\) \*\/;/);
});

test('warnings: tokens css-variables does not emit, vendor-prefixed list members, cascade order', () => {
  const r = extractInline(`.y { color: red; }
.a, .a::-webkit-details-marker { color: red; }
.t { font-size: 1rem; }
.t--big { font-size: 2rem; }
`, [
    { file: 'sections/x.liquid', selector: '.y', property: 'color', var: 'y', token: '--color-heading' },
    { file: 'sections/x.liquid', selector: '.a', property: 'color', var: 'a', token: '--t-missing' },
    { file: 'sections/x.liquid', selector: '.t', property: 'font-size', var: 't' },
  ], { varsFile: VARS });
  const w = r.warnings.join('\n');
  assert.match(w, /token --t-missing is not assigned in /);
  assert.ok(!/token --color-heading is not assigned/.test(w), 'a scheme-block token counts as emitted');
  assert.match(w, /also lists "\.a::-webkit-details-marker"/);
  assert.match(w, /cascade order — .*"\.t--big" sets font-size with the same specificity after "\.t"; .* Bind "\.t--big" for font-size in sections\/x\.liquid too \(with "var": \[\], "token": \[\] it is re-declared verbatim, which only keeps today's order\)\. check-bindings fails on this unless run with --lenient/);
});

test('"var": [] with "token": [] re-declares verbatim, keeps the order and clears the cascade-order warning', () => {
  const css = '.t { font-size: 1rem; }\n.t--big { font-size: 2rem; }\n@media (max-width: 749px) { .t { font-size: 0.9rem; } .t--big { font-size: 1.5rem; } }\n';
  const loose = extractInline(css, [{ file: 'sections/x.liquid', selector: '.t', property: 'font-size', var: 't' }]);
  assert.ok(loose.warnings.some((w) => /cascade order — .*"\.t--big"/.test(w)));
  const r = extractInline(css, [
    { file: 'sections/x.liquid', selector: '.t', property: 'font-size', var: 't' },
    { file: 'sections/x.liquid', selector: '.t--big', property: 'font-size', var: [], token: [] },
  ]);
  assert.deepEqual(r.errors, []);
  assert.ok(!r.warnings.some((w) => /cascade order|not a max-width/.test(w)), r.warnings.join('\n'));
  assert.equal(
    r.files.get('sections/x.liquid').text.split('\n').slice(1).join('\n'),
    '.t {\n  font-size: var(--t, 1rem);\n}\n\n.t--big {\n  font-size: 2rem;\n}\n\n@media (max-width: 749px) {\n  .t {\n    font-size: var(--t-m, var(--t, 0.9rem));\n  }\n\n  .t--big {\n    font-size: 1.5rem;\n  }\n}\n',
  );
  // only one of the two given as empty: still "give var and/or token"
  const { errors } = normalizeBindings([{ file: 'sections/x.liquid', selector: '.t--big', property: 'font-size', var: [] }]);
  assert.match(errors.join('\n'), /give "var" \(the element variable\) and\/or "token", or a "template"; "var": \[\] with "token": \[\] re-declares the rules verbatim/);
});

/* ---------------------------------------------------- shorthands, templates */

const NOTE_CSS = `.note {
  padding: var(--note-top, 208px) var(--page-margin) var(--note-bottom, 208px);
  color: red;
}
@media (max-width: 749px) {
  .note {
    padding-top: calc(var(--note-top, 208px) * 0.45);
    padding-bottom: calc(var(--note-bottom, 208px) * 0.45);
  }
}
`;

test('a longhand bound where the top level writes a shorthand is warned; a "template" carries the control into the shorthand', () => {
  const plain = extractInline(NOTE_CSS, [{ file: 'sections/note.liquid', selector: '.note', property: 'padding-top', var: 'section-pt' }]);
  assert.ok(plain.warnings.some((w) => /\.note \{ padding-top \} — at top level this selector sets padding-top only through "padding: var\(--note-top, 208px\) var\(--page-margin\) var\(--note-bottom, 208px\)" \(.*:2\), which is re-declared verbatim/.test(w)), plain.warnings.join('\n'));
  const r = extractInline(NOTE_CSS, [
    { file: 'sections/note.liquid', selector: '.note', property: 'padding', template: 'var(--section-pt, $1) $2 var(--section-pb, $3)' },
    // ×0.45 of the desktop control on phones ("auto"), or the phone control when set
    { file: 'sections/note.liquid', selector: '.note', property: 'padding-top', template: { '(max-width: 749px)': 'var(--section-pt-m, calc(var(--section-pt, var(--note-top, 208px)) * 0.45))' } },
    { file: 'sections/note.liquid', selector: '.note', property: 'padding-bottom', var: 'section-pb', media_var: 'section-pb-m' },
  ]);
  assert.deepEqual(r.errors, []);
  assert.ok(!r.warnings.some((w) => /only through|template\[/.test(w)), r.warnings.join('\n'));
  const text = r.files.get('sections/note.liquid').text;
  assert.equal(text.split('\n').slice(1).join('\n'), [
    '.note {',
    '  padding: var(--section-pt, var(--note-top, 208px)) var(--page-margin) var(--section-pb, var(--note-bottom, 208px));',
    '}',
    '',
    '@media (max-width: 749px) {',
    '  .note {',
    '    padding-top: var(--section-pt-m, calc(var(--section-pt, var(--note-top, 208px)) * 0.45));',
    '    padding-bottom: var(--section-pb-m, calc(var(--note-bottom, 208px) * 0.45));',
    '  }',
    '}',
    '',
  ].join('\n'));
  // check-bindings accepts it as it is: coverage, fallback, strict
  fs.mkdirSync(path.join(r.root, 'sections'));
  fs.writeFileSync(path.join(r.root, 'sections', 'note.liquid'), `<p></p>\n{% stylesheet %}\n${text}{% endstylesheet %}\n`);
  const c = run(CHECK, ['--root', r.root, '--checks', 'a,b,c,e']);
  assert.equal(c.code, 0, c.out);
  assert.match(c.out, /\(b\) fallback {3}ok — 3 declaration\(s\) compared/);
});

test('template errors: a missing component, a value it does not rebuild, a var() without fallback; misuse with var / value', () => {
  const cases = [
    ['var(--a, $1) $4', /template "var\(--a, \$1\) \$4" uses \$4, but "padding: var\(--note-top, 208px\) var\(--page-margin\) var\(--note-bottom, 208px\)" \(.*base\.css:2, top level\) has 3 component\(s\)/],
    ['var(--a, 1px) $2 $3', /gives "var\(--a, 1px\) var\(--page-margin\) var\(--note-bottom, 208px\)", which renders "1px var\(--page-margin\) var\(--note-bottom, 208px\)" with its variables unset, not today's/],
    ['var(--a) $2 $3', /var\(--a\) has no fallback, so today's "var\(--note-top, 208px\) .*" is lost/],
  ];
  for (const [template, re] of cases) {
    const r = extractInline(NOTE_CSS, [{ file: 'sections/note.liquid', selector: '.note', property: 'padding', template }]);
    assert.match(r.errors.join('\n'), re, template);
  }
  const misuse = normalizeBindings([
    { file: 'sections/note.liquid', selector: '.note', property: 'padding', template: '$0', var: 'x' },
    { file: 'sections/note.liquid', selector: '.note', property: 'padding', template: '$0', value: '1px' },
    { file: 'sections/note.liquid', selector: '.note', property: 'padding', template: ['$0'] },
  ]).errors.join('\n');
  assert.match(misuse, /#1: a "template" string applies to every rule, so "var"\/"token" would never be used/);
  assert.match(misuse, /#2: "template" and "value" are exclusive/);
  assert.match(misuse, /#3: "template" must be a string or an object keyed by media query/);
  // $0 is the whole value; an unused query key is warned
  const whole = extractInline(NOTE_CSS, [{ file: 'sections/note.liquid', selector: '.note', property: 'color', template: { '': 'var(--note-ink, $0)', '(min-width: 990px)': 'var(--x, $0)' } }]);
  assert.match(whole.files.get('sections/note.liquid').text, /color: var\(--note-ink, red\);/);
  assert.ok(whole.warnings.some((w) => /template\["\(min-width: 990px\)"\] matched no rule of this binding/.test(w)));
});

test('shared tokens: one token read by rules whose values differ today is warned; scheme-only role tokens are not', () => {
  const css = '.x { font-size: 2rem; color: red; }\n@media (min-width: 1200px) { .x { font-size: 3rem; } }\n@media (max-width: 749px) { .x { color: blue; } }\n';
  const size = { file: 'sections/x.liquid', selector: '.x', property: 'font-size', var: 'x-size', token: '--t-title-size' };
  const r = extractInline(css, [size], { varsFile: VARS });
  assert.ok(r.warnings.some((w) => /^shared token --t-title-size drives rules whose values differ today: "2rem" at sections\/x\.liquid \.x \{ font-size \}; "3rem" at sections\/x\.liquid \.x \{ font-size \} in @media \(min-width: 1200px\)\. css-variables assigns it on :root, so they all render its one value/.test(w)), r.warnings.join('\n'));
  assert.deepEqual(r.tokens.shared.map((s) => [s.token, s.kind]), [['--t-title-size', 'root']]);
  const fixed = extractInline(css, [{ ...size, media: { '(min-width: 1200px)': { token: '--t-title-size-wide' } } }], { varsFile: VARS });
  assert.ok(!fixed.warnings.some((w) => /shared token/.test(w)), fixed.warnings.join('\n'));
  // --color-heading sits in a [data-color-scheme] block of the fixture css-variables only
  const ink = { file: 'sections/x.liquid', selector: '.x', property: 'color', var: 'x-ink', token: '--color-heading', media_token: '--color-heading' };
  const role = extractInline(css, [ink], { varsFile: VARS });
  assert.ok(!role.warnings.some((w) => /shared token/.test(w)), role.warnings.join('\n'));
  // without a css-variables file a token is assumed to land on :root
  const unknown = extractInline(css, [ink]);
  assert.ok(unknown.warnings.some((w) => /^shared token --color-heading .* Once css-variables assigns it on :root they all render its one value/.test(w)), unknown.warnings.join('\n'));
});

/* ------------------------------------------------------------------ errors */

test('errors: unknown selector, undeclared property, duplicates (same file / two files), bad input', () => {
  const dir = tmp();
  const cases = [
    [[{ file: 'sections/x.liquid', selector: '.nope', property: 'color', var: 'a' }], /no rule in .* declares "color" for the selector "\.nope" \(the selector does not occur/],
    [[{ file: 'sections/x.liquid', selector: '.title', property: 'width', var: 'a' }], /that selector declares: margin, font-size, line-height, color/],
    [[{ file: 'sections/x.liquid', selector: '.box', property: 'padding-bottom', var: 'a' }], /no rule .* declares "padding-bottom" .* sets it only through padding/],
    [[{ file: 'sections/x.liquid', selector: '.title', property: 'color', var: 'a' }, { file: 'sections/x.liquid', selector: '.title', property: 'color', var: 'b' }], /duplicate binding of \.title \{ color \}/],
    [[{ file: 'sections/x.liquid', selector: '.title', property: 'color', var: 'a' }, { file: 'sections/y.liquid', selector: '.title', property: 'color', var: 'b' }], /\.title \{ color \} is bound in two files: sections\/x\.liquid .* and sections\/y\.liquid/],
    [[{ file: 'sections/x.liquid', selector: '.box', property: 'padding-top', var: 'a' }, { file: 'snippets/y.liquid', selector: '.box', property: 'padding', var: 'b' }], /would be re-declared by two files/],
    [[{ file: 'templates/x.json', selector: '.title', property: 'color', var: 'a' }], /"file" must be sections\/<name>\.liquid/],
    [[{ file: 'sections/x.liquid', selector: '.title', property: 'color', var: 'a', colour: 'x' }], /unknown field "colour"/],
    [[{ file: 'sections/x.liquid', selector: '.title', property: 'color' }], /give "var" \(the element variable\) and\/or "token"/],
    [{ not: 'an array' }, /expected a JSON array of bindings/],
  ];
  cases.forEach(([doc, re], i) => {
    const r = run(EXTRACT, [writeJson(dir, `case${i}.json`, doc), '--root', dir, '--css', ASSET, '--no-vars']);
    assert.equal(r.code, 1, `case ${i}: ${r.out}${r.err}`);
    assert.match(r.err, re, `case ${i}`);
  });
  fs.writeFileSync(path.join(dir, 'bad.json'), '[ { "file": ');
  assert.match(run(EXTRACT, [path.join(dir, 'bad.json'), '--css', ASSET]).err, /invalid JSON/);
  assert.equal(run(EXTRACT, [path.join(dir, 'missing.json')]).code, 2);
  assert.equal(run(EXTRACT, ['--frobnicate']).code, 2);
});

test('two bindings files are read together and cross-file duplicates are errors', () => {
  const dir = tmp();
  const a = writeJson(dir, 'a.json', [{ file: 'sections/x.liquid', selector: '.title', property: 'color', var: 'a' }]);
  const b = writeJson(dir, 'b.json', [{ file: 'sections/y.liquid', selector: '.label', property: 'font-size', var: 'b' }]);
  const ok = run(EXTRACT, [a, b, '--root', dir, '--css', ASSET, '--no-vars']);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /---- sections\/x\.liquid ----[\s\S]*from a\.json[\s\S]*---- sections\/y\.liquid ----[\s\S]*from b\.json/);
  const c = writeJson(dir, 'c.json', [{ file: 'sections/z.liquid', selector: '.title', property: 'color', var: 'c' }]);
  assert.equal(run(EXTRACT, [a, c, '--root', dir, '--css', ASSET, '--no-vars']).code, 1);
});

/* --------------------------------------------------- --check and --write */

test('--check reports the clean fixture up to date and the missing-media fixture stale', () => {
  const clean = run(EXTRACT, [BINDINGS, '--root', materialize('clean'), '--css', ASSET, '--no-vars', '--check']);
  assert.equal(clean.code, 0, clean.out + clean.err);
  assert.match(clean.out, /up to date: sections\/hero\.liquid/);
  const hero = [{ file: 'sections/hero.liquid', selector: '.title', property: 'font-size', var: 'hero-title-size', token: '--t-title-size' }];
  const dir = tmp();
  const stale = run(EXTRACT, [writeJson(dir, 'hero.json', hero), '--root', materialize('missing-media'), '--css', ASSET, '--no-vars', '--check']);
  assert.equal(stale.code, 1);
  assert.match(stale.out, /STALE: sections\/hero\.liquid/);
});

test('the clean check fixture holds exactly the golden output inside its marked regions', () => {
  for (const f of listFiles(EXPECTED)) {
    const liquid = fs.readFileSync(path.join(FIX, 'check', 'clean', f.replace(/\.css$/, '.txt')), 'utf8');
    const region = readRegion(liquid);
    assert.ok(region.found, f);
    assert.equal(region.content.trim(), lf(fs.readFileSync(path.join(EXPECTED, f), 'utf8')).trim(), f);
  }
});

test('--write fills the marked region (keeping CRLF), then --check and check-bindings pass', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'assets'));
  fs.mkdirSync(path.join(root, 'snippets'));
  fs.mkdirSync(path.join(root, 'sections'));
  fs.copyFileSync(ASSET, path.join(root, 'assets', 'base.css'));
  fs.copyFileSync(VARS, path.join(root, 'snippets', 'css-variables.liquid'));
  const empty = '<p></p>\r\n\r\n{% stylesheet %}\r\n/* extract-bindings:start */\r\n/* extract-bindings:end */\r\n{% endstylesheet %}\r\n';
  for (const f of ['sections/hero.liquid', 'snippets/box.liquid', 'snippets/label.liquid', 'snippets/media.liquid']) fs.writeFileSync(path.join(root, f), empty);
  fs.copyFileSync(BINDINGS, path.join(root, 'bindings.json'));
  assert.equal(run(EXTRACT, ['bindings.json', '--root', root, '--check', '--quiet'], root).code, 1);
  const w = run(EXTRACT, ['bindings.json', '--root', root, '--write', '--quiet'], root);
  assert.equal(w.code, 0, w.err);
  assert.match(w.out, /written: sections\/hero\.liquid/);
  const hero = fs.readFileSync(path.join(root, 'sections', 'hero.liquid'), 'utf8');
  assert.ok(hero.includes('\r\n') && !/[^\r]\n/.test(hero), 'CRLF kept');
  assert.equal(run(EXTRACT, ['bindings.json', '--root', root, '--check', '--quiet'], root).code, 0);
  const c = run(CHECK, ['--root', root]);
  assert.equal(c.code, 0, c.out);
  assert.match(c.out, /\(a\) coverage {3}ok/);
});
