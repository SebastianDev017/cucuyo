// Unit tests for scripts/css/lib/css-parse.mjs (the tolerant tokenizer/parser
// shared by extract-bindings.mjs and check-bindings.mjs).
//
// Run: node --test "scripts/css/test/*.test.mjs"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from '../lib/css-parse.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (rel) => fs.readFileSync(path.join(FIX, rel), 'utf8');

const decl = (rule, prop) => rule.declarations.find((d) => d.prop === prop);

test('comments, strings and unquoted url() never end a rule or a declaration', () => {
  const { rules, warnings } = P.parseCss(`
    /* } { ; , */
    .a { content: "x } y; z"; background: url(data:image/svg+xml;utf8,<svg/>) no-repeat; /* ; } */ color: red }
    .b { content: 'it\\'s'; }
  `);
  assert.deepEqual(warnings, []);
  assert.equal(rules.length, 2);
  assert.equal(decl(rules[0], 'content').value, '"x } y; z"');
  assert.equal(decl(rules[0], 'background').value, 'url(data:image/svg+xml;utf8,<svg/>) no-repeat');
  assert.equal(decl(rules[0], 'color').value, 'red');
  assert.equal(decl(rules[1], 'content').value, "'it\\'s'");
});

test('selector lists split on top-level commas only', () => {
  const { rules } = P.parseCss('.a, :is(.b, .c) > .d, [data-x="1,2"], .e:not(.f, .g) { color: red }');
  assert.deepEqual(rules[0].members.map((m) => m.text), ['.a', ':is(.b, .c) > .d', '[data-x="1,2"]', '.e:not(.f, .g)']);
});

test('!important is detected (with or without a space) and stripped from the value', () => {
  const { rules } = P.parseCss('.a { font-size: 0.75rem !important; color: red ! IMPORTANT; width: 1px }');
  assert.deepEqual(rules[0].declarations.map((d) => [d.prop, d.value, d.important]), [
    ['font-size', '0.75rem', true],
    ['color', 'red', true],
    ['width', '1px', false],
  ]);
});

test('CRLF is normalised and line numbers refer to the original file', () => {
  const crlf = '.a {\r\n  color: red;\r\n}\r\n\r\n@media (max-width: 989px) {\r\n  .a {\r\n    color: blue;\r\n  }\r\n}\r\n';
  const { rules, warnings } = P.parseCss(crlf);
  assert.deepEqual(warnings, []);
  assert.equal(rules[0].line, 1);
  assert.equal(rules[0].declarations[0].line, 2);
  assert.equal(rules[1].line, 6);
  assert.equal(rules[1].declarations[0].value, 'blue');
  assert.equal(rules[1].wrappers[0].prelude, '(max-width: 989px)');
  assert.ok(!rules[1].declarations[0].value.includes('\r'));
});

test('@media / @supports wrappers are recorded verbatim, nested ones in order', () => {
  const { rules } = P.parseCss(read('asset/base.css'));
  const title = rules.filter((r) => r.members.some((m) => m.key === '.title'));
  assert.deepEqual(title.map((r) => P.wrapperLabel(r.wrappers)), [
    '',
    '@media (max-width: 989px)',
    '@media (min-width: 750px) and (max-width: 989.98px)',
  ]);
  const media = rules.find((r) => r.selector === '.media');
  assert.deepEqual(media.wrappers.map((w) => [w.name, w.prelude]), [['supports', '(aspect-ratio: 1)'], ['media', '(min-width: 750px)']]);
});

test('@keyframes steps are not style rules; @font-face is set aside', () => {
  const { rules, atRules } = P.parseCss('@font-face { font-family: X; src: url(x.woff2); } @keyframes k { from { opacity: 0 } to { opacity: 1 } } .a { color: red }');
  assert.deepEqual(rules.map((r) => r.selector), ['.a']);
  assert.deepEqual(atRules.map((a) => a.type).sort(), ['declarations', 'keyframes']);
});

test('the fixture asset CSS parses without warnings', () => {
  const { rules, warnings } = P.parseCss(read('asset/base.css'));
  assert.deepEqual(warnings, []);
  // :root, .title/.subtitle, .title:hover, .title--small, .box, .box::before, .label,
  // 989 .title/.subtitle, 989 .box, 750–989.98 .title, 749 .box, hover .label:hover, .media
  assert.equal(rules.length, 13);
});

test('tolerant: an unterminated block is reported, not thrown', () => {
  const { rules, warnings } = P.parseCss('.a { color: red; } .b { color: blue');
  assert.equal(rules.length, 2);
  assert.ok(warnings.some((w) => /unterminated rule/.test(w.message)));
});

test('canonicalSelector treats spacing and attribute quoting as the same text', () => {
  assert.equal(P.canonicalSelector('.a>.b'), P.canonicalSelector('.a  >  .b'));
  assert.equal(P.canonicalSelector(".swatches[role='list']"), P.canonicalSelector('.swatches[role="list"]'));
  assert.equal(P.canonicalSelector('.nav-drawer__nav  .site-header__link'), '.nav-drawer__nav .site-header__link');
  assert.notEqual(P.canonicalSelector('.a .b'), P.canonicalSelector('.a.b'));
});

test('canonicalPrelude: media queries compare case- and spacing-insensitively', () => {
  assert.equal(P.canonicalPrelude('(MIN-WIDTH:750px)  and (max-width : 989.98px)'), P.canonicalPrelude('(min-width: 750px) and (max-width: 989.98px)'));
  assert.notEqual(P.canonicalPrelude('(max-width: 989px)'), P.canonicalPrelude('(max-width: 989.98px)'));
});

test('varChain and stripForeignVars recover the asset value of a chain', () => {
  const v = 'var(--nh-size, var(--t-editorial-title-size, calc(1.528rem * var(--heading-scale, 1))))';
  assert.deepEqual(P.varChain(v), { vars: ['--nh-size', '--t-editorial-title-size'], innermost: 'calc(1.528rem * var(--heading-scale, 1))' });
  const keep = P.customPropsIn('calc(1.528rem * var(--heading-scale, 1))');
  assert.equal(P.stripForeignVars(v, keep).value, 'calc(1.528rem * var(--heading-scale, 1))');
  assert.deepEqual(P.stripForeignVars('var(--x)', new Set()).unresolved, ['--x']);
  // a colour chain whose asset value is itself a var()
  assert.equal(P.stripForeignVars('var(--fl-ink, var(--color-link, var(--color-muted)))', new Set(['--color-muted'])).value, 'var(--color-muted)');
});

test('extractStylesheets ignores {% stylesheet %} inside comments, raw and schema, and flags Liquid inside one', () => {
  const liquid = [
    '{% comment %}{% stylesheet %}.x { color: red }{% endstylesheet %}{% endcomment %}',
    '{%- raw -%}{% stylesheet %}.y{}{% endstylesheet %}{%- endraw -%}',
    '<p class="z"></p>',
    '{%- stylesheet -%}',
    '.z { color: blue; }',
    '{%- endstylesheet -%}',
    '{% stylesheet %}.w { color: {{ section.settings.c }}; }{% endstylesheet %}',
  ].join('\n');
  const blocks = P.extractStylesheets(liquid);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].css.trim(), '.z { color: blue; }');
  assert.equal(blocks[0].line, 4);
  assert.equal(blocks[0].liquid, false);
  assert.equal(blocks[1].liquid, true);
});

test('liquidCustomProps reads css-variables: :root names, Liquid-built patterns, scheme blocks, @media', () => {
  const { names, warnings } = P.liquidCustomProps(read('vars/css-variables.liquid.txt'));
  assert.deepEqual(warnings, []);
  const root = names.filter((n) => n.root).map((n) => n.name);
  assert.deepEqual(root, ['--font-heading', '--color-accent', '--card-gap', '--t-title-size', '--t-title-size-m', '--t-{{ style }}-lh', '--page-margin']);
  assert.deepEqual(names.filter((n) => !n.root).map((n) => n.name), ['--color-heading', '--color-link-hover']);
  const pattern = names.find((n) => n.pattern).pattern;
  assert.ok(pattern.test('--t-card-label-lh') && !pattern.test('--t-card-label-size'));
  assert.ok(!names.some((n) => n.name === '--fixture-gap'), 'comments are not declarations');
});

test('liquidCustomProps reads the real snippets/css-variables.liquid (27 :root names)', () => {
  const file = path.resolve(FIX, '..', '..', '..', '..', 'snippets', 'css-variables.liquid');
  const { names } = P.liquidCustomProps(fs.readFileSync(file, 'utf8'));
  const root = new Set(names.filter((n) => n.root).map((n) => n.name));
  for (const n of ['--color-bg', '--card-gap', '--card-text-space', '--page-margin', '--swatch-margin']) assert.ok(root.has(n), n);
  assert.ok(!root.has('--header-height'));
});

test('isRootSelector: :root and html with a class or attribute, not plain html or body', () => {
  for (const s of [':root', 'html:root', 'html.js', ':root.x', 'html[lang]', ':root:not(.x)', ':is(:root, .x)', 'html:not(.js)']) assert.ok(P.isRootSelector(s), s);
  // pseudo-class arguments are not the subject: :not(:root) never targets the root,
  // :where(:root) has specificity 0 and loses to css-variables' :root
  for (const s of ['html', 'body', 'html body', '.root', ':root .x', ':not(:root)', '*:not(:root)', ':where(:root)', '.x:has(:root)', '[data-x=":root"]']) assert.ok(!P.isRootSelector(s), s);
});

test('normalizeValue: spacing around * and /, case of units, hex colours, functions and CSS-wide keywords', () => {
  const same = [
    ['calc( 1.3rem*var(--heading-scale,1) )', 'calc(1.3rem * var(--heading-scale, 1))'],
    ['calc(100% - var(--page-margin)*2)', 'calc(100% - var(--page-margin) * 2)'],
    ['3/4', '3 / 4'],
    ['12px/1.5 Persona', '12px / 1.5 Persona'],
    ['2REM', '2rem'],
    ['-0.5EM', '-0.5em'],
    ['.5Em', '.5em'],
    ['#FFF', '#fff'],
    ['#623827', '#623827'],
    ['INHERIT', 'inherit'],
    ['Revert-Layer', 'revert-layer'],
    ['VAR(--x, 1PX)', 'var(--x, 1px)'],
    ['MIN(12.5VW,56PX)', 'min(12.5vw, 56px)'],
  ];
  for (const [a, b] of same) assert.equal(P.normalizeValue(a), P.normalizeValue(b), `${a} ≡ ${b}`);
  assert.equal(P.normalizeValue('calc( 1.3rem*var(--heading-scale,1) )'), 'calc(1.3rem * var(--heading-scale, 1))');
  const different = [
    ['var(--t-3XL)', 'var(--t-3xl)'],   // custom property names are case-sensitive
    ['"A/B"', '"a / b"'],               // strings are kept as they are
    ['Persona', 'persona'],             // other identifiers keep their case
    ['1.3rem', '1.4rem'],
    ['calc(1rem - 2px)', 'calc(1rem + 2px)'],
  ];
  for (const [a, b] of different) assert.notEqual(P.normalizeValue(a), P.normalizeValue(b), `${a} ≢ ${b}`);
  // unquoted url() contents are copied as they are
  assert.equal(P.normalizeValue('url(data:image/svg+xml;utf8,<svg/>) no-repeat'), 'url(data:image/svg+xml;utf8,<svg/>) no-repeat');
});

test('valueComponents splits a value on top-level spaces only', () => {
  assert.deepEqual(P.valueComponents('var(--note-top, 208px) var(--page-margin)  var(--note-bottom, 208px)'), ['var(--note-top, 208px)', 'var(--page-margin)', 'var(--note-bottom, 208px)']);
  assert.deepEqual(P.valueComponents('"a b" url(x y) calc(1px + 2px)'), ['"a b"', 'url(x y)', 'calc(1px + 2px)']);
});

test('specificity and shorthand relations used by the cascade warnings', () => {
  assert.deepEqual(P.specificity('.a .b:hover'), [0, 3, 0]);
  assert.deepEqual(P.specificity('html.js .site-header'), [0, 2, 1]);
  assert.deepEqual(P.specificity(':where(.a) .b'), [0, 1, 0]);
  assert.ok(P.propsRelated('padding', 'padding-top'));
  assert.ok(P.propsRelated('margin-block', 'margin-top'));
  assert.ok(P.propsRelated('inset', 'left'));
  assert.ok(!P.propsRelated('padding-top', 'padding-bottom'));
  assert.ok(!P.propsRelated('--a', '--b'));
});

test('hasVendorPseudo', () => {
  assert.ok(P.hasVendorPseudo('.a::-webkit-details-marker'));
  assert.ok(P.hasVendorPseudo('input:-moz-focusring'));
  assert.ok(!P.hasVendorPseudo('.a::before'));
});
