// Unit tests for lib/validate.mjs: every rule of EDITOR-ARCHITECTURE.md §7.3 (and the
// platform extras) has at least one failing fixture, asserted by file, path and reason,
// next to a passing counterpart.
//
// Run: node --test "scripts/schema/test/*.test.mjs"

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateSchemaFile, validateThemeSettings, validateSettingValue, checkRichtext, analyseVisibleIf } from '../lib/validate.mjs';
import { loadThemeModel } from '../lib/schema-io.mjs';

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const liquid = (schema, body = '<div class="fixture"></div>') => `${body}\n{% schema %}\n${JSON.stringify(schema, null, 2)}\n{% endschema %}\n`;

function theme(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-validate-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof content === 'string' ? content : rel.endsWith('.json') ? JSON.stringify(content) : liquid(content));
  }
  return root;
}

const FILE = 'sections/fixture.liquid';

function check({ schema, kind = 'section', file = FILE, files, source = '', limits, sizeBytes }) {
  const model = files ? loadThemeModel(theme(files)) : null;
  return validateSchemaFile({ file, kind, schema, source, model, limits, sizeBytes });
}

function list(issues) {
  return issues.map((i) => `${i.level} [${i.rule}] ${i.file} > ${i.path}: ${i.message}`).join('\n') || '(no issues)';
}

function expectIssue(issues, { rule, path: at, includes, level = 'error', file = FILE }) {
  const candidates = issues.filter((i) => i.rule === rule && i.path === at && i.level === level);
  const hit = candidates.find((i) => !includes || i.message.includes(includes)) ?? candidates[0];
  assert.ok(hit, `expected ${level} [${rule}] at "${at}"; got:\n${list(issues)}`);
  assert.equal(hit.file, file, 'issue names the file');
  assert.equal(typeof hit.message, 'string');
  assert.ok(hit.message.length > 10, 'issue gives a reason');
  if (includes) assert.ok(hit.message.includes(includes), `reason "${hit.message}" should mention "${includes}"`);
  return hit;
}

function expectClean(issues) {
  const errors = issues.filter((i) => i.level === 'error');
  assert.equal(errors.length, 0, `expected no errors; got:\n${list(errors)}`);
}

const text = (id, extra = {}) => ({ type: 'text', id, label: id, ...extra });
const range = (id, extra) => ({ type: 'range', id, label: id, ...extra });

// ------------------------------------------------------------- json

test('json: a schema body that is not an object is reported', () => {
  const issues = check({ schema: [] });
  expectIssue(issues, { rule: 'json', path: '', includes: 'JSON object' });
});

// ------------------------------------------------------- name-length

test('name-length: section and block names over 25 characters fail, 25 pass', () => {
  const issues = check({
    schema: {
      name: 'A section name of 26 chars',
      blocks: [{ type: 'card', name: 'A block name of 26 chars!!', settings: [] }],
    },
  });
  expectIssue(issues, { rule: 'name-length', path: 'name', includes: '26 characters' });
  expectIssue(issues, { rule: 'name-length', path: 'blocks[0].name', includes: 'the limit is 25' });
  expectClean(check({ schema: { name: 'Exactly twenty-five chars', blocks: [{ type: 'card', name: 'Card', settings: [] }] } }));
});

test('name-length: a theme block file name is checked too', () => {
  const issues = check({ kind: 'block', file: 'blocks/heading.liquid', schema: { name: 'Heading block with a long name' } });
  expectIssue(issues, { rule: 'name-length', path: 'name', file: 'blocks/heading.liquid' });
});

// -------------------------------------------------------------- range

test('range: default not on a step fails ((default − min) % step)', () => {
  const issues = check({ schema: { name: 'X', settings: [range('padding_top', { min: 0, max: 160, step: 4, default: 6 })] } });
  expectIssue(issues, { rule: 'range', path: 'settings[0].default', includes: 'not on a step' });
});

test('range: min must be below max', () => {
  const issues = check({ schema: { name: 'X', settings: [range('r', { min: 10, max: 10, step: 1, default: 10 })] } });
  expectIssue(issues, { rule: 'range', path: 'settings[0]', includes: 'must be less than max' });
});

test('range: values must be numbers, not strings', () => {
  const issues = check({ schema: { name: 'X', settings: [range('r', { min: '0', max: 10, step: 1, default: 5 })] } });
  expectIssue(issues, { rule: 'range', path: 'settings[0].min', includes: 'must be a number' });
});

test('range: default outside min–max fails', () => {
  const issues = check({ schema: { name: 'X', settings: [range('r', { min: 0, max: 10, step: 1, default: 12 })] } });
  expectIssue(issues, { rule: 'range', path: 'settings[0].default', includes: 'outside' });
});

test('range: step must be positive', () => {
  const issues = check({ schema: { name: 'X', settings: [range('r', { min: 0, max: 10, step: 0, default: 0 })] } });
  expectIssue(issues, { rule: 'range', path: 'settings[0].step', includes: 'greater than 0' });
});

test('range: fewer than 3 steps (selectable values) fails', () => {
  const issues = check({ schema: { name: 'X', settings: [range('r', { min: 0, max: 1, step: 1, default: 0 }), range('s', { min: 0, max: 10, step: 6, default: 0 })] } });
  expectIssue(issues, { rule: 'range', path: 'settings[0]', includes: 'at least 3 steps' });
  expectIssue(issues, { rule: 'range', path: 'settings[1]', includes: 'gives only 2 value(s)' });
});

test('range: more than 101 values fails (Shopify upload limit)', () => {
  const issues = check({ schema: { name: 'X', settings: [range('type_body_size', { min: 50, max: 200, step: 1, default: 100 })] } });
  expectIssue(issues, { rule: 'range', path: 'settings[0]', includes: 'at most 101' });
});

test('range: boundary cases pass (0–100 by 1 = 101 values; 50–200 by 2; 2–4 by 1 = 3 values)', () => {
  expectClean(
    check({
      schema: {
        name: 'X',
        settings: [
          range('a', { min: 0, max: 100, step: 1, default: 37 }),
          range('b', { min: 50, max: 200, step: 2, default: 100 }),
          range('c', { min: 2, max: 4, step: 1, default: 3 }),
          range('d', { min: 0, max: 1, step: 0.1, default: 0.3 }),
        ],
      },
    }),
  );
});

// ------------------------------------------------------ select-default

test('select-default: a default that is not an option fails (select and radio)', () => {
  const opts = [{ value: '756/957', label: 'Portrait' }, { value: '1/1', label: 'Square' }];
  const issues = check({
    schema: {
      name: 'X',
      settings: [
        { type: 'select', id: 'ratio', label: 'Shape', options: opts, default: 'theme' },
        { type: 'radio', id: 'side', label: 'Side', options: [{ value: 'left', label: 'Left' }], default: 'right' },
      ],
    },
  });
  expectIssue(issues, { rule: 'select-default', path: 'settings[0].default', includes: 'not one of the options' });
  expectIssue(issues, { rule: 'select-default', path: 'settings[1].default', includes: '"right"' });
});

test('select-default: empty and duplicate options fail; a valid select passes', () => {
  const issues = check({
    schema: {
      name: 'X',
      settings: [
        { type: 'select', id: 'a', label: 'A', options: [] },
        { type: 'select', id: 'b', label: 'B', options: [{ value: 'x', label: 'X' }, { value: 'x', label: 'Y' }] },
      ],
    },
  });
  expectIssue(issues, { rule: 'select-default', path: 'settings[0].options', includes: 'non-empty' });
  expectIssue(issues, { rule: 'select-default', path: 'settings[1].options[1]', includes: 'duplicate option value' });
  expectClean(check({ schema: { name: 'X', settings: [{ type: 'select', id: 'a', label: 'A', options: [{ value: 'x', label: 'X' }], default: 'x' }] } }));
});

// ---------------------------------------------------------- visible-if

test('visible-if: a reference to a missing section setting fails', () => {
  const issues = check({
    schema: { name: 'X', settings: [{ type: 'checkbox', id: 'label_adjust', label: 'Adjust' }, text('label_x', { visible_if: '{{ section.settings.lable_adjust }}' })] },
  });
  expectIssue(issues, { rule: 'visible-if', path: 'settings[1].visible_if', includes: '"section.settings.lable_adjust" is not a setting of this section' });
});

test('visible-if: the expression must take the form {{ … }}', () => {
  const issues = check({ schema: { name: 'X', settings: [{ type: 'checkbox', id: 'a', label: 'A' }, text('b', { visible_if: 'section.settings.a' })] } });
  expectIssue(issues, { rule: 'visible-if', path: 'settings[1].visible_if', includes: '{{ <expression> }}' });
});

test('visible-if: section settings cannot refer to block settings; parentheses are rejected', () => {
  const issues = check({
    schema: {
      name: 'X',
      settings: [{ type: 'checkbox', id: 'a', label: 'A' }, text('b', { visible_if: '{{ block.settings.a }}' }), text('c', { visible_if: "{{ (section.settings.a == true) }}" })],
    },
  });
  expectIssue(issues, { rule: 'visible-if', path: 'settings[1].visible_if', includes: "can't refer to \"block\"" });
  expectIssue(issues, { rule: 'visible-if', path: 'settings[2].visible_if', includes: 'parentheses' });
});

test('visible-if: local block settings resolve block.settings against the block and section.settings against the section', () => {
  const issues = check({
    schema: {
      name: 'X',
      settings: [{ type: 'checkbox', id: 'carousel', label: 'Carousel' }],
      blocks: [
        {
          type: 'card',
          name: 'Card',
          settings: [
            { type: 'checkbox', id: 'label_adjust', label: 'Adjust' },
            text('ok_block', { visible_if: '{{ block.settings.label_adjust }}' }),
            text('ok_section', { visible_if: "{{ section.settings.carousel and block.settings.label_adjust }}" }),
            text('bad', { visible_if: '{{ block.settings.missing }}' }),
          ],
        },
      ],
    },
  });
  expectIssue(issues, { rule: 'visible-if', path: 'blocks[0].settings[3].visible_if', includes: '"block.settings.missing" is not a setting of this block' });
  assert.equal(issues.filter((i) => i.rule === 'visible-if').length, 1, list(issues));
});

test('visible-if: theme settings can only use settings.<id>, which must exist', () => {
  const issues = validateThemeSettings({
    file: 'config/settings_schema.json',
    schema: [
      { name: 'theme_info', theme_name: 'T', theme_version: '1', theme_author: 'A', theme_documentation_url: 'https://x.test', theme_support_url: 'https://x.test' },
      {
        name: 'Typography',
        settings: [
          { type: 'checkbox', id: 'type_body_adjust', label: 'Fine-tune' },
          text('type_body_ok', { visible_if: '{{ settings.type_body_adjust }}' }),
          text('type_body_bad', { visible_if: '{{ settings.type_body_adjst }}' }),
          text('type_body_section', { visible_if: '{{ section.settings.type_body_adjust }}' }),
        ],
      },
    ],
  });
  const file = 'config/settings_schema.json';
  expectIssue(issues, { rule: 'visible-if', path: '[1].settings[2].visible_if', includes: 'is not a theme setting', file });
  expectIssue(issues, { rule: 'visible-if', path: '[1].settings[3].visible_if', includes: "can't refer to \"section\"", file });
  assert.equal(issues.filter((i) => i.rule === 'visible-if').length, 2, list(issues));
});

test('visible-if: settings.<id> in a section is checked against the theme settings when known', () => {
  const issues = check({
    files: { 'config/settings_schema.json': [{ name: 'Cards', settings: [{ type: 'checkbox', id: 'cards_on', label: 'On' }] }] },
    schema: { name: 'X', settings: [text('a', { visible_if: '{{ settings.cards_on }}' }), text('b', { visible_if: '{{ settings.cards_off }}' })] },
  });
  expectIssue(issues, { rule: 'visible-if', path: 'settings[1].visible_if', includes: '"settings.cards_off" is not a theme setting' });
  assert.equal(issues.filter((i) => i.rule === 'visible-if').length, 1, list(issues));
});

test('analyseVisibleIf extracts lookups and ignores keywords and literals', () => {
  assert.deepEqual(analyseVisibleIf("{{ section.settings.mode == 'custom' and settings.x != blank }}").lookups, [
    ['section', 'settings', 'mode'],
    ['settings', 'x'],
  ]);
});

// ---------------------------------------------------------- unique-ids

test('unique-ids: duplicate setting ids and duplicate local block types fail', () => {
  const issues = check({
    schema: {
      name: 'X',
      settings: [text('heading'), text('heading')],
      blocks: [
        { type: 'card', name: 'Card', settings: [text('label'), text('label')] },
        { type: 'card', name: 'Card again', settings: [] },
      ],
    },
  });
  expectIssue(issues, { rule: 'unique-ids', path: 'settings[1].id', includes: 'duplicate id "heading"' });
  expectIssue(issues, { rule: 'unique-ids', path: 'blocks[0].settings[1].id', includes: 'duplicate id "label"' });
  expectIssue(issues, { rule: 'unique-ids', path: 'blocks[1].type', includes: 'duplicate block type "card"' });
});

test('unique-ids: theme setting ids are unique across all panels', () => {
  const issues = validateThemeSettings({
    file: 'config/settings_schema.json',
    schema: [
      { name: 'theme_info', theme_name: 'T', theme_version: '1', theme_author: 'A', theme_documentation_url: 'https://x.test', theme_support_url: 'https://x.test' },
      { name: 'Colours', settings: [{ type: 'color', id: 'accent', label: 'Accent' }] },
      { name: 'Cards', settings: [{ type: 'color', id: 'accent', label: 'Accent again' }] },
    ],
  });
  expectIssue(issues, { rule: 'unique-ids', path: '[2].settings[0].id', includes: 'already used by [1].settings[0]', file: 'config/settings_schema.json' });
});

// -------------------------------------------------------- header-group

test('header-group: two headers in a row and a trailing header fail', () => {
  const issues = check({
    schema: {
      name: 'X',
      settings: [{ type: 'header', content: 'Content' }, { type: 'header', content: 'Layout' }, text('columns'), { type: 'header', content: 'Colours' }],
    },
  });
  expectIssue(issues, { rule: 'header-group', path: 'settings[1]', includes: 'two headers in a row' });
  expectIssue(issues, { rule: 'header-group', path: 'settings[3]', includes: 'empty group' });
  expectClean(check({ schema: { name: 'X', settings: [{ type: 'header', content: 'A' }, { type: 'paragraph', content: 'Note' }, { type: 'header', content: 'B' }, text('b')] } }));
});

// -------------------------------------------------------------- presets

test('presets: unknown setting keys, invalid values and unknown block types fail', () => {
  const issues = check({
    schema: {
      name: 'X',
      max_blocks: 2,
      settings: [{ type: 'select', id: 'columns', label: 'Columns', options: [{ value: '1', label: '1' }, { value: '2', label: '2' }], default: '1' }],
      blocks: [{ type: 'card', name: 'Card', settings: [text('label')] }],
      presets: [
        {
          name: 'Grid',
          settings: { colums: '2', columns: 3 },
          blocks: [{ type: 'card', settings: { lable: 'x' } }, { type: 'tile' }, { type: 'card' }],
        },
      ],
    },
  });
  expectIssue(issues, { rule: 'presets', path: 'presets[0].settings.colums', includes: 'is not a setting of this section' });
  expectIssue(issues, { rule: 'presets', path: 'presets[0].settings.columns', includes: 'must be a string' });
  expectIssue(issues, { rule: 'presets', path: 'presets[0].blocks[0].settings.lable', includes: 'is not a setting of block "card"' });
  expectIssue(issues, { rule: 'presets', path: 'presets[0].blocks[1].type', includes: 'block type "tile" is not defined' });
  expectIssue(issues, { rule: 'presets', path: 'presets[0].blocks', includes: 'exceed max_blocks (2)' });
});

const photoBlock = { name: 'Photo', settings: [{ type: 'image_picker', id: 'image', label: 'Image' }] };
const headingBlock = { name: 'Heading', settings: [text('text')], presets: [{ name: 'Heading' }] };
const STATIC_SOURCE = "<div>{% content_for 'block', type: '_photo', id: 'photo' %}{% content_for 'blocks' %}</div>";

test('presets: a static block needs an id and static: true, matching a content_for of the Liquid', () => {
  const issues = check({
    files: { 'blocks/_photo.liquid': photoBlock, 'blocks/heading.liquid': headingBlock },
    source: STATIC_SOURCE,
    schema: {
      name: 'X',
      blocks: [{ type: '@theme' }, { type: '_photo' }],
      presets: [
        { name: 'No id', blocks: [{ type: '_photo', static: true }] },
        { name: 'Wrong id', blocks: [{ type: '_photo', static: true, id: 'picture' }] },
        { name: 'Missing flag', blocks: [{ type: '_photo', id: 'photo' }] },
      ],
    },
  });
  expectIssue(issues, { rule: 'presets', path: 'presets[0].blocks[0]', includes: 'needs an "id"' });
  expectIssue(issues, { rule: 'presets', path: 'presets[1].blocks[0]', includes: "no {% content_for 'block', type: '_photo', id: 'picture' %}" });
  expectIssue(issues, { rule: 'presets', path: 'presets[2].blocks[0]', includes: 'needs "static": true' });
});

test('presets: a correct static preset (array and keyed forms) passes', () => {
  const issues = check({
    files: { 'blocks/_photo.liquid': photoBlock, 'blocks/heading.liquid': headingBlock },
    source: STATIC_SOURCE,
    schema: {
      name: 'X',
      blocks: [{ type: 'heading' }, { type: '_photo' }],
      presets: [
        { name: 'Array', blocks: [{ type: '_photo', static: true, id: 'photo', settings: { image: '' } }, { type: 'heading', settings: { text: 'Hi' } }] },
        { name: 'Keyed', blocks: { photo: { type: '_photo', static: true }, h1: { type: 'heading' } }, block_order: ['h1'] },
      ],
    },
  });
  expectClean(issues);
});

// --------------------------------------------------------- theme-blocks

test('theme-blocks: a section with theme blocks has no local block definitions', () => {
  const issues = check({
    files: { 'blocks/heading.liquid': headingBlock },
    schema: { name: 'X', blocks: [{ type: '@theme' }, { type: 'heading' }, { type: 'card', name: 'Card', settings: [] }] },
  });
  expectIssue(issues, { rule: 'theme-blocks', path: 'blocks', includes: "can't mix local block definitions (card)" });
});

test('theme-blocks: a section with local blocks cannot render static theme blocks', () => {
  const issues = check({
    files: { 'blocks/_photo.liquid': photoBlock },
    source: STATIC_SOURCE,
    schema: { name: 'X', blocks: [{ type: 'card', name: 'Card', settings: [] }] },
  });
  expectIssue(issues, { rule: 'theme-blocks', path: 'blocks', includes: "can't render static theme blocks" });
});

test('theme-blocks: a theme block file cannot define local blocks', () => {
  const issues = check({ kind: 'block', file: 'blocks/group.liquid', schema: { name: 'Group', blocks: [{ type: 'card', name: 'Card', settings: [] }] } });
  expectIssue(issues, { rule: 'theme-blocks', path: 'blocks[0]', includes: "theme blocks can't define local blocks", file: 'blocks/group.liquid' });
});

// ------------------------------------------------------- private-blocks

test('private-blocks: a private block used in a preset must be listed explicitly (@theme is not enough)', () => {
  const issues = check({
    files: { 'blocks/_marquee.liquid': { name: 'Marquee', settings: [] } },
    schema: { name: 'X', blocks: [{ type: '@theme' }], presets: [{ name: 'P', blocks: [{ type: '_marquee' }] }] },
  });
  expectIssue(issues, { rule: 'private-blocks', path: 'presets[0].blocks[0].type', includes: 'must be listed explicitly' });
});

test('private-blocks: a private block that defines presets and is listed by a section is an error (both sides)', () => {
  const files = {
    'blocks/_photo.liquid': { ...photoBlock, presets: [{ name: 'Photo' }] },
    'sections/image-text.liquid': liquid({ name: 'Text beside image', blocks: [{ type: '_photo' }, { type: 'heading' }] }, STATIC_SOURCE),
    'blocks/heading.liquid': headingBlock,
  };
  const sectionSide = check({ files, source: STATIC_SOURCE, schema: { name: 'X', blocks: [{ type: 'heading' }, { type: '_photo' }] } });
  expectIssue(sectionSide, { rule: 'private-blocks', path: 'blocks[1].type', includes: '"Add block" picker' });

  const model = loadThemeModel(theme(files));
  const blockSide = validateSchemaFile({ file: 'blocks/_photo.liquid', kind: 'block', schema: { ...photoBlock, presets: [{ name: 'Photo' }] }, model });
  expectIssue(blockSide, { rule: 'private-blocks', path: 'presets', includes: 'listed by sections/image-text.liquid', file: 'blocks/_photo.liquid' });

  const withoutPresets = validateSchemaFile({ file: 'blocks/_photo.liquid', kind: 'block', schema: photoBlock, model });
  expectClean(withoutPresets);
});

// ------------------------------------------------------------- richtext

test('richtext: defaults and preset values must use <p>/<ul> at the top level', () => {
  const issues = check({
    schema: {
      name: 'X',
      settings: [
        { type: 'richtext', id: 'body', label: 'Body', default: 'Plain words' },
        { type: 'richtext', id: 'title', label: 'Title', default: '<h2>Title</h2>' },
        { type: 'richtext', id: 'ok', label: 'OK', default: '<p>One <strong>two</strong></p><ul><li>three</li></ul>' },
      ],
      presets: [{ name: 'P', settings: { ok: 'No paragraph here' } }],
    },
  });
  expectIssue(issues, { rule: 'richtext', path: 'settings[0].default', includes: 'outside <p>/<ul>' });
  expectIssue(issues, { rule: 'richtext', path: 'settings[1].default', includes: 'top-level <h2>' });
  expectIssue(issues, { rule: 'richtext', path: 'presets[0].settings.ok', includes: 'only <p> or <ul>' });
  assert.equal(issues.filter((i) => i.rule === 'richtext').length, 3, list(issues));
});

test('checkRichtext accepts empty strings and nested inline markup', () => {
  assert.equal(checkRichtext(''), null);
  assert.equal(checkRichtext('<p>a<br/>b <a href="/x">link</a></p>'), null);
  assert.match(checkRichtext('<p>open'), /not closed/);
});

// ---------------------------------------------------------- soft-limits

test('soft-limits: theme check ExcessiveSettingsCount (40), 120 settings and 200 KB warn without failing', () => {
  const many = Array.from({ length: 41 }, (_, i) => text(`s${i}`));
  const issues = check({
    schema: { name: 'X', settings: many, blocks: [{ type: 'b', name: 'B', settings: Array.from({ length: 80 }, (_, i) => text(`b${i}`)) }] },
    sizeBytes: 210 * 1024,
  });
  expectIssue(issues, { rule: 'soft-limits', path: 'settings', level: 'warning', includes: 'ExcessiveSettingsCount' });
  expectIssue(issues, { rule: 'soft-limits', path: '', level: 'warning', includes: 'soft limit 120' });
  expectIssue(issues, { rule: 'soft-limits', path: '', level: 'warning', includes: 'soft limit 200 KB' });
  expectClean(issues);
  const raised = check({ schema: { name: 'X', settings: many }, limits: { excessive: { max: 120, enabled: true, source: '.theme-check.yml' } } });
  assert.equal(raised.filter((i) => i.rule === 'soft-limits').length, 0, list(raised));
});

// -------------------------------------------------------- setting-shape

test('setting-shape: leftover directives, unsupported visible_if, missing label and wrong default types fail', () => {
  const issues = check({
    schema: {
      name: 'X',
      settings: [
        { ref: 'setting', type: 'text', id: 'a', label: 'A' },
        { type: 'checkbox', id: 'on', label: 'On' },
        { type: 'product', id: 'product', label: 'Product', visible_if: '{{ section.settings.on }}' },
        { type: 'text', id: 'nolabel' },
        { type: 'checkbox', id: 'flag', label: 'Flag', default: 'yes' },
      ],
    },
  });
  expectIssue(issues, { rule: 'setting-shape', path: 'settings[0].ref', includes: 'generator directive' });
  expectIssue(issues, { rule: 'setting-shape', path: 'settings[2].visible_if', includes: 'do not support conditional display' });
  expectIssue(issues, { rule: 'setting-shape', path: 'settings[3]', includes: 'needs "label"' });
  expectIssue(issues, { rule: 'setting-shape', path: 'settings[4].default', includes: 'true or false' });
});

// --------------------------------------------------------- block-target

test('block-target: missing block files and blocks not allowed by the container fail', () => {
  const issues = check({
    files: { 'blocks/heading.liquid': headingBlock, 'blocks/text.liquid': { name: 'Text', settings: [], presets: [{ name: 'Text' }] } },
    source: "{% content_for 'block', type: 'ghost', id: 'g' %}",
    schema: { name: 'X', blocks: [{ type: 'heading' }, { type: 'missing' }], presets: [{ name: 'P', blocks: [{ type: 'text' }] }] },
  });
  expectIssue(issues, { rule: 'block-target', path: 'blocks[1].type', includes: "'blocks/missing.liquid' does not exist" });
  expectIssue(issues, { rule: 'block-target', path: 'liquid', includes: 'blocks/ghost.liquid does not exist' });
  expectIssue(issues, { rule: 'block-target', path: 'presets[0].blocks[0].type', includes: 'is not allowed' });
});

// -------------------------------------------------------- static-blocks

test('static-blocks: one static id used for two block types fails', () => {
  const issues = check({
    files: { 'blocks/_photo.liquid': photoBlock, 'blocks/heading.liquid': headingBlock },
    source: "{% content_for 'block', type: '_photo', id: 'x' %}{% content_for 'block', type: 'heading', id: 'x' %}",
    schema: { name: 'X', blocks: [{ type: 'heading' }] },
  });
  expectIssue(issues, { rule: 'static-blocks', path: 'liquid', includes: 'used for two types' });
});

// ---------------------------------------------------------- schema-keys

test('schema-keys: unknown attributes, invalid tag and max_blocks over 50 fail', () => {
  const issues = check({ schema: { name: 'X', tag: 'span', max_blocks: 51, colour: 'red' } });
  expectIssue(issues, { rule: 'schema-keys', path: 'colour', includes: 'not a section schema attribute' });
  expectIssue(issues, { rule: 'schema-keys', path: 'tag', includes: 'tag must be one of' });
  expectIssue(issues, { rule: 'schema-keys', path: 'max_blocks', includes: '1 to 50' });
});

// ---------------------------------------------- color-palette / color-default

const themeInfo = { name: 'theme_info', theme_name: 'T', theme_version: '1', theme_author: 'A', theme_documentation_url: 'https://x.test', theme_support_url: 'https://x.test' };

test('color-palette: only in theme settings; names and hex values are checked', () => {
  const inSection = check({ schema: { name: 'X', settings: [{ type: 'color_palette', id: 'colors', default: { ink: '#302C2C' } }] } });
  expectIssue(inSection, { rule: 'color-palette', path: 'settings[0]', includes: 'only allowed in config/settings_schema.json' });
  const theme_ = validateThemeSettings({
    file: 'config/settings_schema.json',
    schema: [themeInfo, { name: 'Colours', settings: [{ type: 'color_palette', id: 'colors', default: { ink: '#302C2C', '2nd': '#FFF', accent: '#62382780' } }] }],
  });
  expectIssue(theme_, { rule: 'color-palette', path: '[1].settings[0].default.2nd', includes: 'start with a letter', file: 'config/settings_schema.json' });
  expectIssue(theme_, { rule: 'color-palette', path: '[1].settings[0].default.accent', includes: 'without alpha', file: 'config/settings_schema.json' });
});

test('color-default: dynamic colour defaults must name an existing palette colour', () => {
  const palette = { type: 'color_palette', id: 'colors', default: { background: '#FFFFFF', accent: '#623827' } };
  const issues = validateThemeSettings({
    file: 'config/settings_schema.json',
    schema: [
      themeInfo,
      { name: 'Colours', settings: [palette] },
      {
        name: 'Schemes',
        settings: [
          { type: 'color', id: 'scheme_cream_bg', label: 'Background', default: '{{ settings.colors.background }}' },
          { type: 'color', id: 'scheme_cream_link', label: 'Link', default: '{{ settings.colors.link }}' },
          { type: 'color', id: 'scheme_cream_text', label: 'Text', default: '{{ settings.color_ink }}' },
        ],
      },
    ],
  });
  const file = 'config/settings_schema.json';
  expectIssue(issues, { rule: 'color-default', path: '[2].settings[1].default', includes: 'no colour "link"', file });
  expectIssue(issues, { rule: 'color-default', path: '[2].settings[2].default', includes: 'settings.<palette id>.<key>', file });
  assert.equal(issues.filter((i) => i.rule === 'color-default').length, 2, list(issues));
});

// ------------------------------------------------------------ values

test('validateSettingValue (shared with the template-compat check)', () => {
  const r = { type: 'range', min: 0, max: 160, step: 4, default: 0 };
  assert.equal(validateSettingValue(r, 48), null);
  assert.match(validateSettingValue(r, 50), /not on a step/);
  assert.match(validateSettingValue(r, '48'), /must be a number/);
  assert.match(validateSettingValue(r, 164), /outside/);
  assert.equal(validateSettingValue({ type: 'checkbox' }, false), null);
  assert.match(validateSettingValue({ type: 'checkbox' }, 'true'), /true or false/);
  const sel = { type: 'select', options: [{ value: '1', label: '1' }] };
  assert.equal(validateSettingValue(sel, '1'), null);
  assert.match(validateSettingValue(sel, 1), /must be a string/);
  assert.match(validateSettingValue(sel, '2'), /not one of the options/);
  assert.equal(validateSettingValue({ type: 'richtext' }, '<p>x</p>'), null);
  assert.equal(validateSettingValue({ type: 'richtext' }, '{{ product.metafields.custom.body | metafield_tag }}'), null);
  assert.equal(validateSettingValue({ type: 'text' }, '{{ product.title }}'), null);
  assert.match(validateSettingValue({ type: 'text' }, 4), /must be a string/);
});

test('a realistic section passes every rule', () => {
  const issues = check({
    files: { 'config/settings_schema.json': [themeInfo, { name: 'Colours', settings: [{ type: 'color_palette', id: 'colors', default: { accent: '#623827', ink: '#302C2C' } }] }] },
    schema: {
      name: 'Featured collection',
      tag: 'section',
      max_blocks: 10,
      settings: [
        { type: 'header', content: 'Heading' },
        text('heading', { info: 'Leave empty for no heading' }),
        { type: 'select', id: 'heading_type', label: 'Typography', options: [{ value: 'section-title', label: 'Section heading' }], default: 'section-title' },
        { type: 'checkbox', id: 'heading_adjust', label: 'Fine-tune', default: false },
        range('heading_size', { min: 50, max: 150, step: 1, unit: '%', default: 100, visible_if: '{{ section.settings.heading_adjust }}' }),
        { type: 'color', id: 'heading_color', label: 'Colour', default: '{{ settings.colors.accent }}' },
        { type: 'header', content: 'Spacing' },
        range('padding_top', { min: 0, max: 160, step: 4, unit: 'px', default: 0 }),
      ],
      blocks: [{ type: 'card', name: 'Card', settings: [text('label'), { type: 'checkbox', id: 'label_adjust', label: 'Adjust' }, text('x', { visible_if: '{{ block.settings.label_adjust }}' })] }],
      presets: [{ name: 'Featured collection', settings: { heading: 'New' }, blocks: [{ type: 'card' }, { type: 'card', settings: { label: 'A' } }] }],
    },
  });
  assert.deepEqual(issues, [], list(issues));
});
