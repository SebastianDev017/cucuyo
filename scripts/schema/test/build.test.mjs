// CLI tests for build.mjs (the --check gate) and import.mjs. Everything that writes runs in
// a temporary theme under the OS temp folder; the repository is only read.
//
// Run: node --test "scripts/schema/test/*.test.mjs"

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readLiquidSchema, outsideSchema, deepEqual } from '../lib/schema-io.mjs';

const SCHEMA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(SCHEMA_DIR, '..', '..');
const BUILD = path.join(SCHEMA_DIR, 'build.mjs');
const IMPORT = path.join(SCHEMA_DIR, 'import.mjs');
const EXAMPLE_MANIFEST = path.join(SCHEMA_DIR, 'manifests', 'sections', '_example.json');
const EXAMPLE_TARGET = 'scripts/schema/test/fixtures/scratch/home-grid.liquid.txt';

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function tmp(prefix = 'schema-build-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function write(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  return root;
}

function run(script, args) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: REPO, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}\n${r.stderr}` };
}

const SECTION = (schemaText, crlf = true) => {
  const text = `{%- comment -%}\n  A fixture section — liquid outside the schema must survive byte for byte.\n{%- endcomment -%}\n<section class="fixture">{{ section.settings.heading }}</section>\n\n{% schema %}\n${schemaText}\n{% endschema %}\n`;
  return crlf ? text.replace(/\n/g, '\r\n') : text;
};
const ONE_LINE_SCHEMA = '{ "name": "Fixture", "tag": "section", "settings": [ { "type": "text", "id": "heading", "label": "Heading" }, { "type": "select", "id": "align", "label": "Align", "options": [ { "value": "left", "label": "Left" }, { "value": "center", "label": "Centre" } ], "default": "center" } ], "presets": [ { "name": "Fixture" } ] }';

function fixtureTheme(extra = {}) {
  const root = tmp('schema-theme-');
  write(root, { 'sections/fixture.liquid': SECTION(ONE_LINE_SCHEMA), 'config/settings_schema.json': [{ name: 'theme_info', theme_name: 'T', theme_version: '1', theme_author: 'A', theme_documentation_url: 'https://x.test', theme_support_url: 'https://x.test' }], ...extra });
  return root;
}

// ------------------------------------------------------------ the gate

test('--check exits 0 on the untouched repo with the example manifest pointing at its scratch copy', () => {
  const manifests = tmp('schema-manifests-');
  write(manifests, { 'sections/_example.json': fs.readFileSync(EXAMPLE_MANIFEST, 'utf8') });
  const before = fs.readFileSync(path.join(REPO, EXAMPLE_TARGET));
  const r = run(BUILD, ['--check', '--manifests', manifests]);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, new RegExp(`ok {6}${EXAMPLE_TARGET.replace(/\./g, '\\.')} \\(unchanged\\)`));
  assert.match(r.out, /^OK: 0 error\(s\), 0 warning\(s\), 0 file\(s\) would change$/m);
  assert.ok(before.equals(fs.readFileSync(path.join(REPO, EXAMPLE_TARGET))), '--check never writes');
});

test('--check exits 1 and prints a unified diff when a manifest is edited (nothing is written)', () => {
  const manifest = JSON.parse(fs.readFileSync(EXAMPLE_MANIFEST, 'utf8'));
  manifest.schema.settings.find((s) => s.id === 'heading').label = 'Heading text';
  const manifests = tmp('schema-manifests-');
  write(manifests, { 'sections/_example.json': manifest });
  const before = fs.readFileSync(path.join(REPO, EXAMPLE_TARGET));
  const r = run(BUILD, ['--check', '--manifests', manifests]);
  assert.equal(r.code, 1, r.all);
  assert.match(r.out, new RegExp(`DRIFT +${EXAMPLE_TARGET.replace(/\./g, '\\.')} \\(schema changed`));
  assert.ok(r.out.includes(`--- a/${EXAMPLE_TARGET}`), r.out);
  assert.ok(r.out.includes(`+++ b/${EXAMPLE_TARGET} (generated)`), r.out);
  assert.match(r.out, /^@@ -\d+,\d+ \+\d+,\d+ @@$/m);
  assert.match(r.out, /^- {6}"label": "Heading",$/m);
  assert.match(r.out, /^\+ {6}"label": "Heading text",$/m);
  assert.match(r.out, /^FAILED: 0 error\(s\), 0 warning\(s\), 1 file\(s\) would change$/m);
  assert.ok(before.equals(fs.readFileSync(path.join(REPO, EXAMPLE_TARGET))), '--check never writes');
});

test('build writes in place, keeps the Liquid outside the tag byte for byte, and is idempotent', () => {
  const root = fixtureTheme();
  const original = fs.readFileSync(path.join(root, 'sections/fixture.liquid'), 'utf8');
  const manifests = path.join(root, '_manifests');
  let r = run(IMPORT, ['sections/fixture.liquid', '--root', root, '--manifests', manifests]);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /round trip deep-equal: yes; the first build reformats the schema/);

  r = run(BUILD, ['--root', root, '--manifests', manifests, '--check']);
  assert.equal(r.code, 1, 'the one-line schema is not canonical yet');
  assert.match(r.out, /DRIFT +sections\/fixture\.liquid \(reformat only: the schema JSON is deep-equal/);

  r = run(BUILD, ['--root', root, '--manifests', manifests]);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /wrote +sections\/fixture\.liquid \(reformat only/);
  const built = fs.readFileSync(path.join(root, 'sections/fixture.liquid'), 'utf8');
  const a = outsideSchema(original);
  const b = outsideSchema(built);
  assert.equal(b.before, a.before);
  assert.equal(b.after, a.after);
  assert.ok(deepEqual(readLiquidSchema(built).schema, readLiquidSchema(original).schema));
  assert.ok(readLiquidSchema(built).tag.body.startsWith('\n{\n  "name": "Fixture",\n  "tag": "section",\n  "settings": ['), 'canonical layout with LF');

  r = run(BUILD, ['--root', root, '--manifests', manifests]);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /ok {6}sections\/fixture\.liquid \(unchanged\)/);
  assert.equal(fs.readFileSync(path.join(root, 'sections/fixture.liquid'), 'utf8'), built, 'second build changes nothing');

  fs.writeFileSync(path.join(root, 'sections/fixture.liquid'), built.replace(/\r?\n/g, '\r\n'));
  r = run(BUILD, ['--root', root, '--manifests', manifests, '--check']);
  assert.equal(r.code, 0, `a line-ending-only difference is not drift\n${r.all}`);
});

test('--only selects by theme path or manifest path; an unknown target fails', () => {
  const root = fixtureTheme({ 'sections/other.liquid': SECTION('{ "name": "Other" }', false) });
  const manifests = path.join(root, '_manifests');
  assert.equal(run(IMPORT, ['sections/fixture.liquid', 'sections/other.liquid', '--root', root, '--manifests', manifests]).code, 0);
  let r = run(BUILD, ['--root', root, '--manifests', manifests, '--only', 'sections/other.liquid', '--check']);
  assert.equal(r.code, 1);
  assert.match(r.out, /DRIFT +sections\/other\.liquid/);
  assert.doesNotMatch(r.out, /fixture\.liquid/);
  r = run(BUILD, ['--root', root, '--manifests', manifests, '--only', path.join(manifests, 'sections', 'fixture.json'), '--check']);
  assert.match(r.out, /DRIFT +sections\/fixture\.liquid/);
  assert.doesNotMatch(r.out, /other\.liquid/);
  r = run(BUILD, ['--root', root, '--manifests', manifests, '--only', 'sections/nope.liquid']);
  assert.equal(r.code, 1);
  assert.match(r.out, /ERROR \[usage\] sections\/nope\.liquid: no manifest generates this file/);
});

test('a validation error fails the build with file, path, reason and origin, and writes nothing', () => {
  const root = fixtureTheme();
  const manifests = path.join(root, '_manifests');
  write(manifests, {
    'sections/fixture.json': {
      file: 'sections/fixture.liquid',
      schema: { name: 'Fixture', tag: 'section', settings: [{ ref: 'setting', type: 'range', id: 'padding_top', label: 'Top', min: 0, max: 160, step: 4, default: 6 }] },
    },
  });
  const before = fs.readFileSync(path.join(root, 'sections/fixture.liquid'));
  const r = run(BUILD, ['--root', root, '--manifests', manifests]);
  assert.equal(r.code, 1, r.all);
  assert.match(r.out, /ERROR \[range\] sections\/fixture\.liquid > settings\[0\]\.default: "padding_top": default 6 is not on a step/);
  assert.match(r.out, /from _manifests\/sections\/fixture\.json schema\.settings\[0\]/);
  assert.match(r.out, /nothing written/);
  assert.ok(before.equals(fs.readFileSync(path.join(root, 'sections/fixture.liquid'))));
});

test('fragment errors name the manifest entry and the fragment', () => {
  const root = fixtureTheme();
  const manifests = path.join(root, '_manifests');
  const fragments = path.join(root, '_fragments');
  write(fragments, { 'grp.json': { params: { prefix: { required: true } }, settings: [{ type: 'text', id: '{{prefix}}_x', label: '{{lable}}' }] } });
  write(manifests, { 'sections/fixture.json': { file: 'sections/fixture.liquid', schema: { name: 'Fixture', settings: [{ ref: 'grp', prefix: 'a' }] } } });
  const r = run(BUILD, ['--root', root, '--manifests', manifests, '--fragments', fragments]);
  assert.equal(r.code, 1, r.all);
  assert.match(r.out, /ERROR \[expand\] _manifests\/sections\/fixture\.json > schema\.settings\[0\] > ref "grp": unknown placeholder \{\{lable\}\} at fragments\/grp\.json settings\[0\]/);
});

test('json: a manifest that is not valid JSON is reported with its path', () => {
  const root = fixtureTheme();
  const manifests = path.join(root, '_manifests');
  write(manifests, { 'sections/fixture.json': '{ "file": "sections/fixture.liquid", "schema": { "name": "Fixture", } }' });
  const r = run(BUILD, ['--root', root, '--manifests', manifests]);
  assert.equal(r.code, 1);
  assert.match(r.out, /ERROR \[json\] _manifests\/sections\/fixture\.json: invalid JSON/);
});

test('json: --lint reports a section whose {% schema %} body is not valid JSON', () => {
  const root = fixtureTheme({ 'sections/broken.liquid': '<div></div>\n{% schema %}\n{ "name": "Broken", }\n{% endschema %}\n' });
  const r = run(BUILD, ['--root', root, '--manifests', path.join(root, '_none'), '--lint']);
  assert.equal(r.code, 1, r.all);
  assert.match(r.out, /ERROR \[json\] sections\/broken\.liquid: invalid JSON in \{% schema %\}: \S/);
});

test('--lint validates schemas that no manifest generates', () => {
  const root = fixtureTheme({ 'sections/bad.liquid': SECTION('{ "name": "Bad", "settings": [ { "type": "range", "id": "r", "label": "R", "min": 0, "max": 200, "step": 1, "default": 10 } ] }', false) });
  const r = run(BUILD, ['--root', root, '--manifests', path.join(root, '_none'), '--lint']);
  assert.equal(r.code, 1, r.all);
  assert.match(r.out, /ERROR \[range\] sections\/bad\.liquid > settings\[0\]: "r": 0–200 by 1 gives 201 values; Shopify rejects more than 101/);
});

test('manifest envelope problems: unknown keys, duplicate targets, missing targets, unknown kind', () => {
  const root = fixtureTheme();
  const manifests = path.join(root, '_manifests');
  write(manifests, {
    'sections/a.json': { file: 'sections/fixture.liquid', schema: { name: 'A' } },
    'sections/b.json': { file: 'sections/fixture.liquid', schema: { name: 'B' } },
    'sections/c.json': { file: 'sections/missing.liquid', schema: { name: 'C' } },
    'sections/d.json': { file: 'sections/fixture.liquid', schema: { name: 'D' }, schmea: {} },
    'misc/e.json': { file: 'snippets/x.liquid', schema: { name: 'E' } },
  });
  const r = run(BUILD, ['--root', root, '--manifests', manifests]);
  assert.equal(r.code, 1);
  assert.match(r.out, /ERROR \[manifest\] _manifests\/sections\/b\.json > file: sections\/fixture\.liquid is already generated by _manifests\/sections\/a\.json/);
  assert.match(r.out, /ERROR \[target\] sections\/missing\.liquid: the target file does not exist/);
  assert.match(r.out, /ERROR \[manifest\] _manifests\/sections\/d\.json: unknown key "schmea"/);
  assert.match(r.out, /ERROR \[manifest\] _manifests\/misc\/e\.json: cannot tell whether this manifest describes a section/);
});

test('--only is not blocked by another task\'s broken manifest or unused broken fragment; the full gate is', () => {
  const root = fixtureTheme({ 'sections/other.liquid': SECTION('{ "name": "Other" }', false) });
  const manifests = path.join(root, '_manifests');
  const fragments = path.join(root, '_fragments');
  assert.equal(run(IMPORT, ['sections/fixture.liquid', '--root', root, '--manifests', manifests]).code, 0);
  write(manifests, { 'sections/other.json': '{ "file": "sections/other.liquid", "schema": { "name": "Other", ' });
  write(fragments, { 'half-written.json': '{ "settings": [ ' });
  const base = ['--root', root, '--manifests', manifests, '--fragments', fragments];

  let r = run(BUILD, [...base, '--only', 'sections/fixture.liquid']);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /warn  \[json\] _manifests\/sections\/other\.json: invalid JSON.*\(not part of this --only build\)/);
  assert.match(r.out, /warn  \[fragment\] fragments\/half-written\.json: invalid JSON.*\(not part of this --only build\)/);
  assert.match(r.out, /wrote +sections\/fixture\.liquid/);

  r = run(BUILD, [...base, '--only', 'sections/other.liquid']);
  assert.equal(r.code, 1, 'the broken manifest is the selected one (matched by name)');
  assert.match(r.out, /ERROR \[json\] _manifests\/sections\/other\.json: invalid JSON/);

  r = run(BUILD, [...base, '--check']);
  assert.equal(r.code, 1, 'the full gate fails');
  assert.match(r.out, /ERROR \[json\] _manifests\/sections\/other\.json/);
  assert.match(r.out, /ERROR \[fragment\] fragments\/half-written\.json/);

  write(manifests, { 'sections/other.json': { file: 'sections/other.liquid', schema: { name: 'Other', settings: [{ ref: 'half-written' }] } } });
  r = run(BUILD, [...base, '--only', 'sections/other.liquid']);
  assert.equal(r.code, 1);
  assert.match(r.out, /ERROR \[expand\] _manifests\/sections\/other\.json > schema\.settings\[0\]: fragment "half-written" cannot be used: fragments\/half-written\.json: invalid JSON/);
});

test('config/settings_schema.json: import, rebuild, and theme-scope visible_if from a fragment', () => {
  const root = tmp('schema-theme-');
  write(root, { 'config/settings_schema.json': fs.readFileSync(path.join(REPO, 'config/settings_schema.json'), 'utf8') });
  const original = JSON.parse(fs.readFileSync(path.join(root, 'config/settings_schema.json'), 'utf8'));
  const manifests = path.join(root, '_manifests');
  let r = run(IMPORT, ['config/settings_schema.json', '--root', root, '--manifests', manifests]);
  assert.equal(r.code, 0, r.all);
  assert.ok(fs.existsSync(path.join(manifests, 'theme-settings.json')));
  r = run(BUILD, ['--root', root, '--manifests', manifests]);
  assert.equal(r.code, 0, r.all);
  assert.ok(deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'config/settings_schema.json'), 'utf8')), original), 'deep-equal after the rebuild');

  const manifest = JSON.parse(fs.readFileSync(path.join(manifests, 'theme-settings.json'), 'utf8'));
  manifest.schema.push({ name: 'Typography — example', settings: [{ header: 'Menu links' }, { ref: '_example', prefix: 'type_nav', style: 'nav', size: false }] });
  write(manifests, { 'theme-settings.json': manifest });
  r = run(BUILD, ['--root', root, '--manifests', manifests, '--check']);
  assert.equal(r.code, 1);
  assert.match(r.out, /\+ {8}"visible_if": "\{\{ settings\.type_nav_adjust \}\}"/);
  r = run(BUILD, ['--root', root, '--manifests', manifests]);
  assert.equal(r.code, 0, r.all);
  const built = JSON.parse(fs.readFileSync(path.join(root, 'config/settings_schema.json'), 'utf8'));
  assert.deepEqual(built.at(-1).settings.map((s) => s.id ?? s.type), ['header', 'type_nav_type', 'type_nav_adjust', 'type_nav_font', 'type_nav_case']);
  assert.ok(fs.readFileSync(path.join(root, 'config/settings_schema.json'), 'utf8').endsWith(']\n'));
});

test('manifests, fragments and settings_schema.json saved with a UTF-8 byte order mark (PowerShell 5.1) are read', () => {
  const BOM = '﻿';
  const root = fixtureTheme();
  const settingsPath = path.join(root, 'config/settings_schema.json');
  fs.writeFileSync(settingsPath, BOM + fs.readFileSync(settingsPath, 'utf8'));
  const manifests = path.join(root, '_manifests');
  const fragments = path.join(root, '_fragments');
  write(fragments, { 'grp.json': BOM + JSON.stringify({ params: { prefix: { required: true } }, settings: [{ type: 'text', id: '{{prefix}}_note', label: 'Note' }] }) });
  write(manifests, {
    'sections/fixture.json': BOM + JSON.stringify({ file: 'sections/fixture.liquid', schema: { name: 'Fixture', tag: 'section', settings: [{ ref: 'setting', type: 'text', id: 'heading', label: 'Heading' }, { ref: 'grp', prefix: 'cta' }] } }),
  });
  const r = run(BUILD, ['--root', root, '--manifests', manifests, '--fragments', fragments, '--lint']);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /wrote +sections\/fixture\.liquid \(schema changed/);
  assert.deepEqual(readLiquidSchema(fs.readFileSync(path.join(root, 'sections/fixture.liquid'), 'utf8')).schema.settings.map((s) => s.id), ['heading', 'cta_note']);
});

test('import refuses to overwrite a manifest without --force; usage errors exit 2', () => {
  const root = fixtureTheme();
  const manifests = path.join(root, '_manifests');
  assert.equal(run(IMPORT, ['sections/fixture.liquid', '--root', root, '--manifests', manifests]).code, 0);
  const again = run(IMPORT, ['sections/fixture.liquid', '--root', root, '--manifests', manifests]);
  assert.equal(again.code, 1);
  assert.match(again.err, /already exists \(use --force to overwrite\)/);
  assert.equal(run(IMPORT, ['sections/fixture.liquid', '--root', root, '--manifests', manifests, '--force']).code, 0);
  assert.equal(run(BUILD, ['--bogus']).code, 2);
  assert.equal(run(BUILD, ['--only']).code, 2);
  assert.equal(run(IMPORT, []).code, 2);
  const help = run(BUILD, ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /--check/);
});
