// Round-trip proof (EDITOR-ARCHITECTURE.md §7.2): import.mjs + build.mjs reproduce a schema
// as deep-equal JSON (arrays order-sensitive, object keys order-insensitive) with the Liquid
// outside the {% schema %} tag byte-identical. The first build reformats the body (one-line
// option objects, key order name/tag/settings/max_blocks/…); that reformat is reported as a
// diagnostic, not treated as a failure. The repository is only read.
//
// Run: node --test "scripts/schema/test/*.test.mjs"

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readLiquidSchema, outsideSchema, spliceSchemaBody, formatJSONDocument, deepEqual, normalizeEol, THEME_SETTINGS_FILE } from '../lib/schema-io.mjs';
import { expandManifest, manifestSchemaFrom } from '../lib/fragments.mjs';

const SCHEMA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(SCHEMA_DIR, '..', '..');
const BUILD = path.join(SCHEMA_DIR, 'build.mjs');
const IMPORT = path.join(SCHEMA_DIR, 'import.mjs');

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function copyIntoTemp(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-roundtrip-'));
  roots.push(root);
  for (const rel of files) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.copyFileSync(path.join(REPO, rel), abs);
  }
  return root;
}

const run = (script, args) => {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: REPO, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, all: `${r.stdout}\n${r.stderr}` };
};
const lineCount = (text) => normalizeEol(text).split('\n').length;

function assertSameOutside(original, rebuilt, file) {
  const a = outsideSchema(original, file);
  const b = outsideSchema(rebuilt, file);
  assert.equal(b.openTag, a.openTag, `${file}: schema tag`);
  assert.equal(b.closeTag, a.closeTag, `${file}: endschema tag`);
  assert.ok(b.before === a.before, `${file}: Liquid before the schema tag must be byte-identical`);
  assert.ok(b.after === a.after, `${file}: Liquid after the schema tag must be byte-identical`);
}

test('round trip: import.mjs + build.mjs --only reproduce sections/home-grid.liquid', (t) => {
  const file = 'sections/home-grid.liquid';
  const root = copyIntoTemp([file, THEME_SETTINGS_FILE]);
  const manifests = path.join(root, '_manifests');

  const imported = run(IMPORT, [file, '--root', root, '--manifests', manifests]);
  assert.equal(imported.code, 0, imported.all);
  assert.match(imported.out, /round trip deep-equal: yes/);

  const built = run(BUILD, ['--root', root, '--manifests', manifests, '--only', file]);
  assert.equal(built.code, 0, built.all);
  assert.match(built.out, /(wrote +sections\/home-grid\.liquid \(reformat only: the schema JSON is deep-equal|ok +sections\/home-grid\.liquid \(unchanged\))/);

  const original = fs.readFileSync(path.join(REPO, file), 'utf8');
  const rebuilt = fs.readFileSync(path.join(root, file), 'utf8');
  assert.ok(deepEqual(readLiquidSchema(rebuilt, file).schema, readLiquidSchema(original, file).schema), 'schema JSON is deep-equal');
  assertSameOutside(original, rebuilt, file);

  const before = readLiquidSchema(original, file).tag.body;
  const after_ = readLiquidSchema(rebuilt, file).tag.body;
  t.diagnostic(`${file}: deep-equal JSON, Liquid outside the tag byte-identical; schema body ${before === after_ ? 'unchanged' : `reformatted ${lineCount(before.trim())} → ${lineCount(after_.trim())} lines`}`);
  t.diagnostic(`import: ${imported.out.trim()}`);
});

test('round trip holds for every section, theme block and config/settings_schema.json in the working tree', (t) => {
  const liquid = [];
  for (const dir of ['sections', 'blocks']) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(REPO, dir));
    } catch {
      continue;
    }
    for (const name of names.sort()) if (name.endsWith('.liquid')) liquid.push(`${dir}/${name}`);
  }
  assert.ok(liquid.length > 0);
  let reformatted = 0;
  for (const file of liquid) {
    const kind = file.startsWith('blocks/') ? 'block' : 'section';
    const source = fs.readFileSync(path.join(REPO, file), 'utf8');
    const { tag, schema } = readLiquidSchema(source, file);
    if (!tag) continue;
    const manifest = { file, schema: manifestSchemaFrom(schema, kind) };
    const rebuilt = spliceSchemaBody(source, tag, expandManifest(manifest, { kind, manifestFile: '(round trip)' }));
    assert.ok(deepEqual(readLiquidSchema(rebuilt, file).schema, schema), `${file}: schema JSON is deep-equal`);
    assertSameOutside(source, rebuilt, file);
    if (normalizeEol(rebuilt) !== normalizeEol(source)) reformatted += 1;
  }
  const settingsText = fs.readFileSync(path.join(REPO, THEME_SETTINGS_FILE), 'utf8');
  const settings = JSON.parse(settingsText);
  const regenerated = formatJSONDocument(expandManifest({ file: THEME_SETTINGS_FILE, schema: manifestSchemaFrom(settings, 'theme') }, { kind: 'theme' }));
  assert.ok(deepEqual(JSON.parse(regenerated), settings), 'config/settings_schema.json is deep-equal');
  t.diagnostic(`${liquid.length} Liquid schemas round-trip (${reformatted} would be reformatted by their first build); ${THEME_SETTINGS_FILE} ${normalizeEol(regenerated) === normalizeEol(settingsText) ? 'regenerates byte-identical (modulo line endings)' : 'round-trips deep-equal (reformatted)'}`);
});
