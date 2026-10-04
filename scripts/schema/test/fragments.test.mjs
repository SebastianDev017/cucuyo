// Unit tests for lib/fragments.mjs: placeholders, $if/$each, lookups, $setting reuse,
// nested refs, generic alias renaming, override/omit, visible_if scope detection,
// import's inverse, and the two worked examples of README.md (computed from the shipped
// fragments/_example.json).
//
// Run: node --test "scripts/schema/test/*.test.mjs"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandManifest, expandSettingsArray, evalCondition, loadFragments, manifestSchemaFrom, renameInVisibleIf, FragmentError } from '../lib/fragments.mjs';
import { canonicalizeSchema, deepEqual } from '../lib/schema-io.mjs';

const SCHEMA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function frags(defs) {
  const map = new Map();
  for (const [id, def] of Object.entries(defs)) {
    const params = {};
    for (const [name, spec] of Object.entries(def.params ?? {})) params[name] = spec && typeof spec === 'object' && !Array.isArray(spec) && ('default' in spec || 'required' in spec) ? spec : { default: spec };
    map.set(id, { id, file: `fragments/${id}.json`, params, lookup: def.lookup ?? {}, settings: def.settings });
  }
  return map;
}

function expand(entries, { fragments = new Map(), scope = 'section', data = {}, kind = 'section' } = {}) {
  return expandSettingsArray(entries, { fragments, data, kind, scope, manifestFile: 'manifests/sections/t.json', where: 'schema.settings' });
}

const ids = (settings) => settings.map((s) => s.id ?? `[${s.type}]`);

// ------------------------------------------------------------- placeholders

test('placeholders: whole-value placeholders keep their type; partial ones interpolate', () => {
  const fragments = frags({
    t: {
      params: { prefix: { required: true }, def: 100, opts: [{ value: 'a', label: 'A' }], on: false },
      settings: [
        { type: 'range', id: '{{prefix}}_size', label: 'Size of {{prefix}}', min: 50, max: 150, step: 1, default: '{{def}}' },
        { type: 'select', id: '{{prefix}}_pick', label: 'Pick', options: '{{opts}}', default: 'a' },
        { type: 'checkbox', id: '{{prefix}}_on', label: 'On', default: '{{on}}' },
      ],
    },
  });
  const out = expand([{ ref: 't', prefix: 'label' }], { fragments });
  assert.deepEqual(out[0], { type: 'range', id: 'label_size', label: 'Size of label', min: 50, max: 150, step: 1, default: 100 });
  assert.deepEqual(out[1].options, [{ value: 'a', label: 'A' }]);
  assert.equal(out[2].default, false);
});

test('placeholders: Liquid output written with spaces is left alone; nesting builds visible_if', () => {
  const fragments = frags({
    t: { params: { prefix: { required: true } }, settings: [{ type: 'color', id: '{{prefix}}_color', label: 'C', default: '{{ settings.colors.accent }}', visible_if: '{{ {{scope_settings}}.{{prefix}}_adjust }}' }] },
  });
  const [s] = expand([{ ref: 't', prefix: 'nav' }], { fragments });
  assert.equal(s.default, '{{ settings.colors.accent }}');
  assert.equal(s.visible_if, '{{ section.settings.nav_adjust }}');
});

test('placeholders: an unknown placeholder is an error naming the template position', () => {
  const fragments = frags({ t: { params: { prefix: { required: true } }, settings: [{ type: 'text', id: '{{prefx}}_x', label: 'X' }] } });
  assert.throws(() => expand([{ ref: 't', prefix: 'a' }], { fragments }), (err) => err instanceof FragmentError && /unknown placeholder \{\{prefx\}\}/.test(err.message) && /fragments\/t\.json settings\[0\]/.test(err.message));
});

test('placeholders: a property whose value is null (optional parameter) is omitted', () => {
  const fragments = frags({ t: { params: { prefix: { required: true }, info: null }, settings: [{ type: 'text', id: '{{prefix}}_x', label: 'X', info: '{{info}}' }] } });
  assert.deepEqual(expand([{ ref: 't', prefix: 'a' }], { fragments })[0], { type: 'text', id: 'a_x', label: 'X' });
  assert.equal(expand([{ ref: 't', prefix: 'a', info: 'Hi' }], { fragments })[0].info, 'Hi');
});

// --------------------------------------------------------------- conditions

test('conditions: truthiness, !, ==, !=, has, &&, || and parentheses', () => {
  const ctx = { size: false, prefix: 'nav', roles: ['text', 'bg'], alias_font: null, n: 0, empty: [] };
  const c = (s) => evalCondition(s, ctx);
  assert.equal(c('size'), false);
  assert.equal(c('!size'), true);
  assert.equal(c('alias_font'), false);
  assert.equal(c('n'), true, '0 is truthy');
  assert.equal(c('empty'), false);
  assert.equal(c("prefix == 'nav'"), true);
  assert.equal(c("prefix != 'nav'"), false);
  assert.equal(c("roles has 'bg'"), true);
  assert.equal(c("roles has 'border'"), false);
  assert.equal(c("!size && roles has 'text'"), true);
  assert.equal(c("size || prefix == 'x'"), false);
  assert.equal(c("(size || roles has 'bg') && !alias_font"), true);
  assert.throws(() => c('sise'), /unknown name "sise"/);
  assert.throws(() => c("prefix == 'nav' extra"), /unexpected/);
});

test('$if picks entries in settings lists and values', () => {
  const fragments = frags({
    t: {
      params: { prefix: { required: true }, hover: false, roles: ['text'] },
      settings: [
        { type: 'color', id: '{{prefix}}_color', label: 'Colour' },
        { $if: 'hover', then: [{ type: 'color', id: '{{prefix}}_hover_color', label: 'Colour on hover' }] },
        { $if: "roles has 'bg'", then: { type: 'color', id: '{{prefix}}_bg', label: 'Background' }, else: [] },
        { type: 'text', id: '{{prefix}}_note', label: { $if: 'hover', then: 'Interactive', else: 'Static' } },
      ],
    },
  });
  assert.deepEqual(ids(expand([{ ref: 't', prefix: 'link' }], { fragments })), ['link_color', 'link_note']);
  const out = expand([{ ref: 't', prefix: 'btn', hover: true, roles: ['text', 'bg'] }], { fragments });
  assert.deepEqual(ids(out), ['btn_color', 'btn_hover_color', 'btn_bg', 'btn_note']);
  assert.equal(out[3].label, 'Interactive');
});

// ------------------------------------------------------- $each and lookups

const STYLES = [
  { id: 'card-label', label: 'Card name', panel: 'headings-labels', size_px: '13.3' },
  { id: 'body', label: 'Body text', panel: 'body-links', size_px: '12.6' },
  { id: 'nav', label: 'Menu links', panel: 'headings-labels', size_px: null },
];

test('$each iterates data (styles.json) and parameters, with where filters and _index', () => {
  const fragments = frags({
    t: {
      params: { prefix: { required: true }, extra: [] },
      settings: [
        { type: 'select', id: '{{prefix}}_type', label: 'Typography', options: [{ value: 'inherit', label: 'Inherit' }, { $each: 'styles', as: 's', do: { value: '{{s.id}}', label: '{{s.label}}' } }], default: 'inherit' },
        { $each: 'extra', as: 'x', do: { type: 'text', id: '{{prefix}}_{{x}}', label: 'Extra {{x_index}}' } },
      ],
    },
  });
  const out = expand([{ ref: 't', prefix: 'el', extra: ['a', 'b'] }], { fragments, data: { styles: STYLES } });
  assert.deepEqual(out[0].options.map((o) => o.value), ['inherit', 'card-label', 'body', 'nav']);
  assert.deepEqual(out.slice(1).map((s) => [s.id, s.label]), [['el_a', 'Extra 0'], ['el_b', 'Extra 1']]);

  const panel = expand([{ $each: 'styles', as: 's', where: { panel: 'headings-labels' }, do: [{ header: '{{s.label}}' }] }], { data: { styles: STYLES }, scope: 'theme' });
  assert.deepEqual(panel.map((s) => s.content), ['Card name', 'Menu links']);
});

test('$each over missing data says that styles.json is missing', () => {
  const fragments = frags({ t: { settings: [{ $each: 'styles', do: { type: 'text', id: 'x', label: 'x' } }] } });
  assert.throws(() => expand([{ ref: 't' }], { fragments }), /styles\.json is missing/);
});

test('lookup binds the style record for info texts; a missing record is an error', () => {
  const fragments = frags({
    t: {
      params: { prefix: { required: true }, style: { required: true } },
      lookup: { s: { from: 'styles', key: 'id', value: '{{style}}' } },
      settings: [{ type: 'range', id: '{{prefix}}_size', label: 'Size', min: 50, max: 150, step: 1, default: 100, info: '100% = {{s.size_px}}px as designed ({{s.label}}).' }],
    },
  });
  assert.equal(expand([{ ref: 't', prefix: 'label', style: 'card-label' }], { fragments, data: { styles: STYLES } })[0].info, '100% = 13.3px as designed (Card name).');
  assert.throws(() => expand([{ ref: 't', prefix: 'label', style: 'nope' }], { fragments, data: { styles: STYLES } }), /no record in "styles" with id = "nope"/);
});

// ------------------------------------------------------------ $setting

const raw = (s) => ({ ref: 'setting', ...s });

test('$setting reuses a raw setting verbatim, moves it into the group, appends options and merges keys', () => {
  const fragments = frags({
    t: {
      params: { prefix: { required: true }, alias_font: null },
      settings: [
        { type: 'checkbox', id: '{{prefix}}_adjust', label: 'Fine-tune', default: false },
        { $if: 'alias_font', then: { $setting: '{{alias_font}}', $append_options: [{ value: 'inherit', label: 'Inherit' }, { value: 'body', label: 'dup' }], visible_if: '{{ {{scope_settings}}.{{prefix}}_adjust }}' } },
      ],
    },
  });
  const labelFont = { type: 'select', id: 'label_font', label: 'Label typeface', options: [{ value: 'heading', label: 'Primary' }, { value: 'body', label: 'Secondary' }], default: 'heading' };
  const out = expand([raw({ type: 'text', id: 'label', label: 'Label' }), raw(labelFont), raw({ type: 'color', id: 'label_color', label: 'Colour' }), { ref: 't', prefix: 'label', alias_font: 'label_font' }], { fragments, scope: 'block' });
  assert.deepEqual(ids(out), ['label', 'label_color', 'label_adjust', 'label_font']);
  assert.deepEqual(out[3], { ...labelFont, options: [...labelFont.options, { value: 'inherit', label: 'Inherit' }], visible_if: '{{ block.settings.label_adjust }}' });
});

test('$setting falls back when the raw setting is absent, and fails without a fallback', () => {
  const fragments = frags({
    pad: {
      params: { custom_ids: ['padding_top'] },
      settings: [{ $setting: '{{custom_ids.0}}', $fallback: { type: 'range', id: '{{custom_ids.0}}', label: 'Top', min: 0, max: 240, step: 4, default: 0 }, visible_if: "{{ {{scope_settings}}.pad_top_preset == 'custom' }}" }],
    },
    strict: { settings: [{ $setting: 'nope' }] },
  });
  const kept = expand([raw({ type: 'range', id: 'padding_top', label: 'Padding top', min: 0, max: 160, step: 4, default: 0 }), { ref: 'pad' }], { fragments });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].max, 160, 'the kept definition wins');
  assert.equal(kept[0].visible_if, "{{ section.settings.pad_top_preset == 'custom' }}");
  const fresh = expand([{ ref: 'pad' }], { fragments });
  assert.equal(fresh[0].max, 240, 'the fallback is used when nothing is kept');
  assert.throws(() => expand([{ ref: 'strict' }], { fragments }), /no raw entry with that id/);
});

test('$setting cannot reuse the same raw setting twice', () => {
  const fragments = frags({ t: { settings: [{ $setting: 'a' }] } });
  assert.throws(() => expand([raw({ type: 'text', id: 'a', label: 'A' }), { ref: 't' }, { ref: 't' }], { fragments }), /reused twice/);
});

// --------------------------------------------- nested refs, aliases, override

test('nested refs receive templated parameters and inherit the visible_if scope', () => {
  const fragments = frags({
    type: { params: { prefix: { required: true } }, settings: [{ type: 'checkbox', id: '{{prefix}}_adjust', label: 'A' }, { type: 'text', id: '{{prefix}}_ls', label: 'LS', visible_if: '{{ {{scope_settings}}.{{prefix}}_adjust }}' }] },
    card: { params: { prefix: 'label' }, settings: [{ header: 'Card {{prefix}}' }, { ref: 'type', prefix: '{{prefix}}' }, { type: 'color', id: 'badge_color', label: 'Badge' }] },
  });
  const out = expand([{ ref: 'card' }], { fragments, scope: 'block' });
  assert.deepEqual(ids(out), ['[header]', 'label_adjust', 'label_ls', 'badge_color']);
  assert.equal(out[0].content, 'Card label');
  assert.equal(out[2].visible_if, '{{ block.settings.label_adjust }}');
});

test('fragment cycles are detected', () => {
  const fragments = frags({ a: { settings: [{ ref: 'b' }] }, b: { settings: [{ ref: 'a' }] } });
  assert.throws(() => expand([{ ref: 'a' }], { fragments }), /fragment cycle: a > b > a/);
});

test('alias_* renames the generated <prefix>_<suffix> id and rewrites visible_if references', () => {
  const fragments = frags({
    t: { params: { prefix: { required: true } }, settings: [{ type: 'checkbox', id: '{{prefix}}_adjust', label: 'A' }, { type: 'select', id: '{{prefix}}_tone', label: 'T', options: [{ value: 'dark', label: 'Dark' }], default: 'dark', visible_if: '{{ {{scope_settings}}.{{prefix}}_adjust }}' }] },
  });
  const out = expand([{ ref: 't', prefix: 'card_label', alias_adjust: 'label_tuned', alias_tone: 'label_tone' }], { fragments, scope: 'block' });
  assert.deepEqual(ids(out), ['label_tuned', 'label_tone']);
  assert.equal(out[1].visible_if, '{{ block.settings.label_tuned }}');
  assert.equal(renameInVisibleIf('{{ settings.a_x and section.settings.a_x }}', new Map([['a_x', 'b']])), '{{ settings.b and section.settings.b }}');
});

test('override patches generated settings (null deletes); omit drops them; both reject unknown ids', () => {
  const fragments = frags({ t: { params: { prefix: { required: true } }, settings: [{ type: 'text', id: '{{prefix}}_a', label: 'A', info: 'i' }, { type: 'text', id: '{{prefix}}_b', label: 'B' }] } });
  const out = expand([{ ref: 't', prefix: 'x', override: { x_a: { label: 'Alpha', info: null } }, omit: ['x_b'] }], { fragments });
  assert.deepEqual(out, [{ type: 'text', id: 'x_a', label: 'Alpha' }]);
  assert.throws(() => expand([{ ref: 't', prefix: 'x', override: { nope: {} } }], { fragments }), /override: no generated setting "nope"/);
  assert.throws(() => expand([{ ref: 't', prefix: 'x', omit: ['nope'] }], { fragments }), /omit: no generated setting "nope"/);
});

test('parameters: unknown names, missing required values and wrong types are errors', () => {
  const fragments = frags({ t: { params: { prefix: { required: true, type: 'string' }, size: { default: true, type: 'boolean' }, mode: { default: 'a', enum: ['a', 'b'] } }, settings: [] } });
  assert.throws(() => expand([{ ref: 't', prefix: 'a', sise: false }], { fragments }), /has no parameter "sise"/);
  assert.throws(() => expand([{ ref: 't' }], { fragments }), /needs parameter "prefix"/);
  assert.throws(() => expand([{ ref: 't', prefix: 'a', size: 'no' }], { fragments }), /must be boolean/);
  assert.throws(() => expand([{ ref: 't', prefix: 'a', mode: 'c' }], { fragments }), /must be one of/);
  assert.throws(() => expand([{ ref: 'missing' }], { fragments }), /unknown fragment "missing"/);
  assert.doesNotThrow(() => expand([{ ref: 't', prefix: 'a', alias_whatever: 'x', visible_if_scope: 'theme' }], { fragments }));
});

// ------------------------------------------------------- scope detection

test('visible_if scope is detected from the manifest location and can be forced', () => {
  const fragments = frags({ t: { settings: [{ type: 'checkbox', id: 'a', label: 'A' }, { type: 'text', id: 'b', label: 'B', visible_if: '{{ {{scope_settings}}.a }}' }] } });
  const section = expandManifest(
    { file: 'sections/x.liquid', schema: { name: 'X', settings: [{ ref: 't' }], blocks: [{ type: 'card', name: 'Card', settings: [{ ref: 't' }] }] } },
    { kind: 'section', fragments },
  );
  assert.equal(section.settings[1].visible_if, '{{ section.settings.a }}');
  assert.equal(section.blocks[0].settings[1].visible_if, '{{ block.settings.a }}');
  const block = expandManifest({ file: 'blocks/heading.liquid', schema: { name: 'Heading', settings: [{ ref: 't' }] } }, { kind: 'block', fragments });
  assert.equal(block.settings[1].visible_if, '{{ block.settings.a }}');
  const theme = expandManifest({ file: 'config/settings_schema.json', schema: [{ name: 'theme_info' }, { name: 'Typography', settings: [{ ref: 't' }] }] }, { kind: 'theme', fragments });
  assert.equal(theme[1].settings[1].visible_if, '{{ settings.a }}');
  const forced = expandManifest({ file: 'sections/x.liquid', schema: { name: 'X', settings: [{ ref: 't', visible_if_scope: 'theme' }] } }, { kind: 'section', fragments });
  assert.equal(forced.settings[1].visible_if, '{{ settings.a }}');
});

test('manifest shorthands and raw entries; canonical key order of the output', () => {
  const out = expandManifest(
    { file: 'sections/x.liquid', schema: { presets: [{ name: 'X' }], settings: [{ header: 'Content', info: 'i' }, { paragraph: 'Note' }, { type: 'text', id: 'a', label: 'A' }], name: 'X', max_blocks: 3, tag: 'section' } },
    { kind: 'section' },
  );
  assert.deepEqual(Object.keys(out), ['name', 'tag', 'max_blocks', 'settings', 'presets']);
  assert.deepEqual(out.settings, [{ type: 'header', content: 'Content', info: 'i' }, { type: 'paragraph', content: 'Note' }, { type: 'text', id: 'a', label: 'A' }]);
  assert.throws(() => expandManifest({ schema: { name: 'X', settings: [{ id: 'nope' }] } }, { kind: 'section' }), /unrecognised settings entry/);
});

test('manifestSchemaFrom (import) expands back to a deep-equal schema', () => {
  const schema = {
    name: 'Featured collection',
    tag: 'section',
    settings: [{ type: 'header', content: 'Heading' }, { type: 'text', id: 'heading', label: 'Heading' }],
    max_blocks: 10,
    blocks: [{ type: 'card', name: 'Card', settings: [{ type: 'url', id: 'link', label: 'Link' }] }, { type: '@app' }],
    presets: [{ name: 'Featured collection', blocks: [{ type: 'card' }] }],
  };
  const manifest = { file: 'sections/home-grid.liquid', schema: manifestSchemaFrom(schema, 'section') };
  assert.equal(manifest.schema.settings[0].ref, 'setting');
  assert.ok(deepEqual(expandManifest(manifest, { kind: 'section' }), canonicalizeSchema(schema)));
  const themeSchema = [{ name: 'theme_info', theme_name: 'T' }, { name: 'Layout', settings: [{ type: 'range', id: 'page_margin', label: 'Margin', min: 16, max: 64, step: 4, default: 40 }] }];
  assert.ok(deepEqual(expandManifest({ file: 'config/settings_schema.json', schema: manifestSchemaFrom(themeSchema, 'theme') }, { kind: 'theme' }), themeSchema));
});

// ------------------------------------------- README worked examples (_example)

const shipped = loadFragments(path.join(SCHEMA_DIR, 'fragments'));

test('README example 1: card label with alias_font=label_font (block scope)', () => {
  const labelFont = { type: 'select', id: 'label_font', label: 'Label typeface', options: [{ value: 'heading', label: 'Primary' }, { value: 'body', label: 'Secondary' }], default: 'heading' };
  const out = expand([raw(labelFont), { ref: '_example', prefix: 'label', style: 'card-label', alias_font: 'label_font' }], { fragments: shipped, scope: 'block' });
  assert.deepEqual(ids(out), ['label_type', 'label_adjust', 'label_font', 'label_size', 'label_size_m', 'label_case']);
  assert.equal(out[0].default, 'card-label');
  assert.deepEqual(out[2].options.map((o) => o.value), ['heading', 'body', 'inherit']);
  assert.equal(out[2].default, 'heading');
  for (const s of out.slice(2)) assert.equal(s.visible_if, '{{ block.settings.label_adjust }}');
});

test('README example 2: menu links with size:false (section scope), and alias_size', () => {
  const nav = expand([{ ref: '_example', prefix: 'nav', style: 'nav', size: false }], { fragments: shipped });
  assert.deepEqual(ids(nav), ['nav_type', 'nav_adjust', 'nav_font', 'nav_case']);
  assert.equal(nav[2].visible_if, '{{ section.settings.nav_adjust }}');
  const menuSize = { type: 'range', id: 'menu_size', label: 'Menu link size', min: 13, max: 18, step: 1, unit: 'px', default: 17 };
  const withAlias = expand([raw(menuSize), { ref: '_example', prefix: 'nav', style: 'nav', alias_size: 'menu_size' }], { fragments: shipped });
  assert.deepEqual(ids(withAlias), ['nav_type', 'nav_adjust', 'nav_font', 'menu_size', 'nav_case']);
  assert.deepEqual(withAlias[3], { ...menuSize, visible_if: '{{ section.settings.nav_adjust }}' });
  const themeScope = expand([{ ref: '_example', prefix: 'type_nav', style: 'nav', size: false }], { fragments: shipped, scope: 'theme' });
  assert.equal(themeScope[2].visible_if, '{{ settings.type_nav_adjust }}');
});
