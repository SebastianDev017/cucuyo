// Unit tests for lib/schema-io.mjs: locating and replacing the {% schema %} body (bytes
// outside the tag kept, CRLF included), tags inside comments ignored, canonical key order,
// static block discovery, manifest kind detection, target paths, template comments and the
// unified diff used by --check.
//
// Run: node --test "scripts/schema/test/*.test.mjs"   (or `node --test` inside scripts/schema)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findSchemaTag, readLiquidSchema, outsideSchema, spliceSchemaBody, formatSchemaBody, canonicalizeSchema,
  findStaticBlockCalls, detectKind, resolveTarget, stripLeadingComment, unifiedDiff, normalizeEol, SchemaIOError,
} from '../lib/schema-io.mjs';

const CRLF_SOURCE = '{%- comment -%}\r\n  keep me\r\n{%- endcomment -%}\r\n<div>{{ section.settings.a }}</div>\r\n\r\n{% schema %}\r\n{ "settings": [], "name": "X", "presets": [ { "name": "X" } ], "tag": "section" }\r\n{% endschema %}\r\n<!-- trailing -->\r\n';

test('spliceSchemaBody replaces only the body: canonical 2-space JSON with LF, every byte outside kept (CRLF too)', () => {
  const tag = findSchemaTag(CRLF_SOURCE, 'x');
  const out = spliceSchemaBody(CRLF_SOURCE, tag, readLiquidSchema(CRLF_SOURCE).schema);
  const a = outsideSchema(CRLF_SOURCE);
  const b = outsideSchema(out);
  assert.equal(b.before, a.before);
  assert.equal(b.after, a.after);
  assert.equal(b.openTag, '{% schema %}');
  assert.equal(b.closeTag, '{% endschema %}');
  const body = findSchemaTag(out).body;
  assert.equal(body, '\n{\n  "name": "X",\n  "tag": "section",\n  "settings": [],\n  "presets": [\n    {\n      "name": "X"\n    }\n  ]\n}\n');
  assert.ok(!body.includes('\r'), 'the generated body uses LF');
});

test('findSchemaTag: whitespace-control delimiters; none → null; two tags or an unclosed tag throw', () => {
  const src = 'a\n{%- schema -%}\n{"name":"A"}\n{%- endschema -%}\nb';
  const tag = findSchemaTag(src);
  assert.equal(tag.openTag, '{%- schema -%}');
  assert.equal(tag.closeTag, '{%- endschema -%}');
  assert.deepEqual(JSON.parse(tag.body), { name: 'A' });
  assert.equal(findSchemaTag('<div></div>'), null);
  assert.throws(() => findSchemaTag('{% schema %}{}{% endschema %}{% schema %}{}{% endschema %}', 'f.liquid'), (e) => e instanceof SchemaIOError && /2 \{% schema %\} tags found/.test(e.message));
  assert.throws(() => findSchemaTag('{% schema %}{}', 'f.liquid'), /no matching \{% endschema %\}/);
});

test('findSchemaTag ignores schema tags written inside comments, {% doc %}, {% raw %} and inline comments', () => {
  const src = [
    '{% comment %} an old {% schema %}{"name":"Old"}{% endschema %} {% endcomment %}',
    '{% doc %} Example: {% schema %} … {% enddoc %}',
    '{% raw %}{% schema %}{% endraw %}',
    '{% # {% schema %} %}',
    '<div></div>',
    '{% schema %}',
    '{"name":"Real"}',
    '{% endschema %}',
  ].join('\n');
  const tag = findSchemaTag(src);
  assert.deepEqual(JSON.parse(tag.body), { name: 'Real' });
  assert.equal(src.slice(tag.start, tag.end).startsWith('{% schema %}\n{"name":"Real"}'), true);
});

test('canonicalizeSchema orders name/tag/class/limit/max_blocks/settings/blocks/presets, then the rest as written', () => {
  const schema = { presets: [], zeta: 1, settings: [], blocks: [], max_blocks: 3, class: 'c', name: 'N', limit: 1, tag: 'div', locales: {} };
  assert.deepEqual(Object.keys(canonicalizeSchema(schema)), ['name', 'tag', 'class', 'limit', 'max_blocks', 'settings', 'blocks', 'presets', 'locales', 'zeta']);
  assert.equal(formatSchemaBody({ b: 1, name: 'x' }), '{\n  "name": "x",\n  "b": 1\n}');
});

test('findStaticBlockCalls: one-line, multi-line and {% liquid %} calls; doc examples, comments and the schema ignored', () => {
  const src = [
    "{% doc %} @example {% content_for 'block', type: 'doc_only', id: 'x' %} {% enddoc %}",
    "{% comment %}{% content_for 'block', type: 'commented', id: 'c' %}{% endcomment %}",
    "<div>{%- content_for 'block', type: '_photo', id: 'photo' -%}</div>",
    '{% content_for "block",',
    '   type: "_newsletter-form",',
    '   id: "form",',
    '   closest.product: product %}',
    '{% liquid',
    "  assign x = 1",
    "  content_for 'block', type: 'heading', id: 'title'",
    "  render 'other', id: 'not-a-block'",
    '%}',
    "{% content_for 'blocks' %}",
    "{% content_for 'block', type: block_type, id: 'dyn' %}",
    "{% schema %}{\"name\":\"X\",\"info\":\"{% content_for 'block', type: 'in_schema', id: 's' %}\"}{% endschema %}",
  ].join('\n');
  assert.deepEqual(findStaticBlockCalls(src), [
    { type: '_photo', id: 'photo' },
    { type: '_newsletter-form', id: 'form' },
    { type: 'heading', id: 'title' },
    { type: null, id: 'dyn' },
  ]);
});

test('detectKind: explicit kind, then the manifest location, then the target path', () => {
  assert.equal(detectKind('theme-settings.json', {}), 'theme');
  assert.equal(detectKind('sections/home-grid.json', { file: 'sections/home-grid.liquid' }), 'section');
  assert.equal(detectKind('sections/_example.json', { file: 'scripts/schema/test/fixtures/scratch/home-grid.liquid.txt' }), 'section');
  assert.equal(detectKind('blocks/heading.json', {}), 'block');
  assert.equal(detectKind('misc/x.json', { file: 'blocks/x.liquid' }), 'block');
  assert.equal(detectKind('misc/x.json', { file: 'config/settings_schema.json' }), 'theme');
  assert.equal(detectKind('misc/x.json', { file: 'blocks/x.liquid', kind: 'section' }), 'section');
  assert.equal(detectKind('misc/x.json', { file: 'snippets/x.liquid' }), null);
});

test('resolveTarget keeps the target inside the theme root', () => {
  assert.equal(resolveTarget('/r', 'sections\\home-grid.liquid'), 'sections/home-grid.liquid');
  assert.equal(resolveTarget('/r', './sections/../sections/a.liquid'), 'sections/a.liquid');
  assert.throws(() => resolveTarget('/r', '../outside.liquid'), /escapes the theme root/);
  assert.throws(() => resolveTarget('/r', 'C:/abs/x.liquid'), /relative to the theme root/);
  assert.throws(() => resolveTarget('/r', ''), /must name the target file/);
});

test('stripLeadingComment removes the comment Shopify writes at the top of templates and section groups', () => {
  const text = '\uFEFF/*\n * ------------------------------------------------------------\n * IMPORTANT: auto-generated\n */\n{"sections":{}}';
  assert.deepEqual(JSON.parse(stripLeadingComment(text)), { sections: {} });
  assert.equal(stripLeadingComment('{"a":1}'), '{"a":1}');
});

test('unifiedDiff: empty when equal modulo line endings; hunks with headers and context otherwise; capped output', () => {
  assert.equal(unifiedDiff('a\r\nb\r\n', 'a\nb\n'), '');
  const oldText = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].join('\n');
  const newText = ['1', '2', '3', '4', 'five', '6', '7', '8', '9', '10', '11'].join('\n');
  const diff = unifiedDiff(oldText, newText, { oldLabel: 'a/x', newLabel: 'b/x', context: 1 });
  assert.equal(diff, ['--- a/x', '+++ b/x', '@@ -4,3 +4,3 @@', ' 4', '-5', '+five', ' 6', '@@ -10,1 +10,2 @@', ' 10', '+11'].join('\n'));
  const capped = unifiedDiff(oldText, newText, { context: 1, maxLines: 4 });
  assert.equal(capped.split('\n').length, 5);
  assert.match(capped, /more diff lines not shown/);
  assert.equal(normalizeEol('a\r\nb'), 'a\nb');
});
