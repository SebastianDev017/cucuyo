// scripts/schema/lib/schema-io.mjs
//
// File-level IO for the schema generator (EDITOR-ARCHITECTURE.md §7):
//   * locate / replace the {% schema %}…{% endschema %} body of a Liquid file
//     (everything outside the tag is kept byte for byte);
//   * the canonical JSON layout (2 spaces, LF, top-level key order
//     name/tag/class/limit/max_blocks/settings/blocks/presets, then the rest);
//   * config/settings_schema.json as a whole-file JSON document;
//   * the theme model used by the cross-file validators (every section and
//     theme block schema, the theme settings, static block calls);
//   * manifest discovery and kind detection;
//   * line-ending normalisation and a small unified-diff printer for --check.
//
// Node standard library only. Also the reusable layer for the template-compat
// check (scripts/schema/check-templates.mjs, reserved for T3.2): see README.md.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const SCHEMA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(SCHEMA_DIR, '..', '..');
export const THEME_SETTINGS_FILE = 'config/settings_schema.json';

/** Canonical order of the top-level schema keys; unknown keys follow in their own order. */
export const CANONICAL_KEYS = [
  'name', 'tag', 'class', 'limit', 'max_blocks', 'settings', 'blocks', 'presets',
  'default', 'locales', 'enabled_on', 'disabled_on',
];

export class SchemaIOError extends Error {
  constructor(reason, file) {
    super(file ? `${file}: ${reason}` : reason);
    this.name = 'SchemaIOError';
    this.reason = reason;
    this.file = file;
  }
}

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const clone = (v) => (v === undefined ? undefined : structuredClone(v));
export const deepEqual = (a, b) => isDeepStrictEqual(a, b);
export const toPosix = (p) => p.split(path.sep).join('/');

/** Posix path of `abs` relative to `root`, or the absolute posix path when it is outside. */
export function displayPath(root, abs) {
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return toPosix(abs);
  return toPosix(rel);
}

export function normalizeEol(text) {
  return text.replace(/\r\n/g, '\n');
}

export function readText(abs) {
  return fs.readFileSync(abs, 'utf8');
}

export function writeText(abs, text) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, 'utf8');
}

export function parseJSON(text, label) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new SchemaIOError(`invalid JSON: ${err.message}`, label);
  }
}

// ---------------------------------------------------------------- schema tag

const OPEN_TAG = /\{%-?\s*schema\s*-?%\}/g;
const CLOSE_TAG = /\{%-?\s*endschema\s*-?%\}/g;

/**
 * Locates the single {% schema %} tag of a Liquid source.
 * Returns null when there is none; throws when there are several or it is unclosed.
 * Offsets: start (tag start) < bodyStart <= bodyEnd < end (end of {% endschema %}).
 */
export function findSchemaTag(source, file) {
  const opens = [...source.matchAll(OPEN_TAG)];
  if (opens.length === 0) return null;
  if (opens.length > 1) {
    throw new SchemaIOError(`${opens.length} {% schema %} tags found; a file may hold only one`, file);
  }
  const open = opens[0];
  const bodyStart = open.index + open[0].length;
  const closeRe = new RegExp(CLOSE_TAG.source, 'g');
  closeRe.lastIndex = bodyStart;
  const close = closeRe.exec(source);
  if (!close) throw new SchemaIOError('{% schema %} has no matching {% endschema %}', file);
  return {
    start: open.index,
    bodyStart,
    bodyEnd: close.index,
    end: close.index + close[0].length,
    openTag: open[0],
    closeTag: close[0],
    body: source.slice(bodyStart, close.index),
  };
}

/** { tag, schema } of a Liquid source; schema is null when the file has no schema tag. */
export function readLiquidSchema(source, file) {
  const tag = findSchemaTag(source, file);
  if (!tag) return { tag: null, schema: null };
  let schema;
  try {
    schema = JSON.parse(tag.body);
  } catch (err) {
    throw new SchemaIOError(`invalid JSON in {% schema %}: ${err.message}`, file);
  }
  return { tag, schema };
}

/** The Liquid outside the schema tag (the part that must stay byte-identical). */
export function outsideSchema(source, file) {
  const tag = findSchemaTag(source, file);
  if (!tag) return { before: source, after: '', openTag: '', closeTag: '' };
  return {
    before: source.slice(0, tag.start),
    after: source.slice(tag.end),
    openTag: tag.openTag,
    closeTag: tag.closeTag,
  };
}

export function canonicalizeSchema(schema) {
  if (!isPlainObject(schema)) return schema;
  const out = {};
  for (const key of CANONICAL_KEYS) if (Object.hasOwn(schema, key)) out[key] = schema[key];
  for (const key of Object.keys(schema)) if (!Object.hasOwn(out, key)) out[key] = schema[key];
  return out;
}

/** The generated schema body: canonical key order, 2-space JSON, no trailing newline. */
export function formatSchemaBody(schema) {
  return JSON.stringify(canonicalizeSchema(schema), null, 2);
}

/**
 * Replaces the body of `tag` (from findSchemaTag on the same source) with the
 * generated JSON. The tag delimiters and every byte outside them are kept.
 * The body is written with LF line endings (git normalises the working copy).
 */
export function spliceSchemaBody(source, tag, schema) {
  return `${source.slice(0, tag.bodyStart)}\n${formatSchemaBody(schema)}\n${source.slice(tag.bodyEnd)}`;
}

/** Whole-file JSON (manifests, config/settings_schema.json): 2 spaces, LF, final newline. */
export function formatJSONDocument(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// ------------------------------------------------- templates (for T3.2's check)

/** Strips the leading block comment Shopify writes at the top of templates/*.json and section groups. */
export function stripLeadingComment(text) {
  return text.replace(/^﻿?\s*\/\*[\s\S]*?\*\/\s*/, '');
}

export function parseTemplateJSON(text, file) {
  return parseJSON(stripLeadingComment(text), file);
}

// ------------------------------------------------------------- static blocks

const LIQUID_COMMENTS = [
  /\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g,
  /\{%-?\s*doc\s*-?%\}[\s\S]*?\{%-?\s*enddoc\s*-?%\}/g,
  /\{%-?\s*raw\s*-?%\}[\s\S]*?\{%-?\s*endraw\s*-?%\}/g,
  /\{%-?\s*#[^%]*-?%\}/g,
  /\{%-?\s*schema\s*-?%\}[\s\S]*?\{%-?\s*endschema\s*-?%\}/g,
];

/** Blanks comments, {% doc %}, {% raw %} and the schema body (newlines kept so offsets stay meaningful). */
export function stripLiquidComments(source) {
  let out = source;
  for (const re of LIQUID_COMMENTS) out = out.replace(re, (m) => m.replace(/[^\n]/g, ' '));
  return out;
}

const CONTENT_FOR_BLOCK = /\bcontent_for\s+(['"])block\1\s*,([^\n%]*)/g;

/** Every {% content_for 'block', type: '…', id: '…' %} call (type/id null when not a string literal). */
export function findStaticBlockCalls(source) {
  const calls = [];
  for (const m of stripLiquidComments(source ?? '').matchAll(CONTENT_FOR_BLOCK)) {
    const args = m[2];
    const type = /\btype\s*:\s*(['"])(.*?)\1/.exec(args)?.[2] ?? null;
    const id = /\bid\s*:\s*(['"])(.*?)\1/.exec(args)?.[2] ?? null;
    calls.push({ type, id });
  }
  return calls;
}

// ---------------------------------------------------------------- theme model

function themeSettingIds(schema) {
  if (!Array.isArray(schema)) return null;
  const ids = new Set();
  for (const panel of schema) {
    if (!isPlainObject(panel) || !Array.isArray(panel.settings)) continue;
    for (const s of panel.settings) if (isPlainObject(s) && typeof s.id === 'string') ids.add(s.id);
  }
  return ids;
}

function themePalette(schema) {
  if (!Array.isArray(schema)) return null;
  for (const panel of schema) {
    if (!isPlainObject(panel) || !Array.isArray(panel.settings)) continue;
    for (const s of panel.settings) {
      if (isPlainObject(s) && s.type === 'color_palette' && typeof s.id === 'string') {
        return { id: s.id, keys: new Set(isPlainObject(s.default) ? Object.keys(s.default) : []) };
      }
    }
  }
  return null;
}

function loadSchemaEntry(root, file, overrides) {
  const type = path.posix.basename(file, '.liquid');
  if (overrides.has(file)) {
    const o = overrides.get(file);
    return { file, type, source: o.source ?? '', schema: o.schema, error: null, generated: true, staticBlocks: findStaticBlockCalls(o.source ?? '') };
  }
  let source = '';
  let schema = null;
  let error = null;
  try {
    source = fs.readFileSync(path.join(root, file), 'utf8');
    schema = readLiquidSchema(source, file).schema;
  } catch (err) {
    error = err.reason ?? `cannot read the file: ${err.message}`;
  }
  return { file, type, source, schema, error, generated: false, staticBlocks: findStaticBlockCalls(source) };
}

/**
 * Reads every sections/*.liquid, blocks/*.liquid and config/settings_schema.json under `root`.
 * `overrides` (Map target → { schema, source }) replaces the on-disk version of generated files,
 * so validators see what the build is about to write.
 *
 * Returns { root, sections: Map(type → entry), blocks: Map(type → entry), settings,
 *           globalSettingIds: Set|null, palette: { id, keys }|null }.
 */
export function loadThemeModel(root, overrides = new Map()) {
  const model = { root, sections: new Map(), blocks: new Map(), settings: null, globalSettingIds: null, palette: null };
  for (const dir of ['sections', 'blocks']) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(root, dir));
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!name.endsWith('.liquid')) continue;
      model[dir].set(name.slice(0, -'.liquid'.length), loadSchemaEntry(root, `${dir}/${name}`, overrides));
    }
  }
  for (const [file, o] of overrides) {
    const m = /^(sections|blocks)\/([^/]+)\.liquid$/.exec(file);
    if (m && !model[m[1]].has(m[2])) model[m[1]].set(m[2], loadSchemaEntry(root, file, new Map([[file, o]])));
  }
  if (overrides.has(THEME_SETTINGS_FILE)) {
    model.settings = { file: THEME_SETTINGS_FILE, schema: overrides.get(THEME_SETTINGS_FILE).schema, error: null, generated: true };
  } else if (fs.existsSync(path.join(root, THEME_SETTINGS_FILE))) {
    try {
      model.settings = { file: THEME_SETTINGS_FILE, schema: parseJSON(readText(path.join(root, THEME_SETTINGS_FILE)), THEME_SETTINGS_FILE), error: null, generated: false };
    } catch (err) {
      model.settings = { file: THEME_SETTINGS_FILE, schema: null, error: err.reason ?? err.message, generated: false };
    }
  }
  model.globalSettingIds = themeSettingIds(model.settings?.schema);
  model.palette = themePalette(model.settings?.schema);
  return model;
}

/** Optional locales/en.default.schema.json lookup for "t:" names. */
export function loadSchemaLocale(root) {
  try {
    const json = JSON.parse(readText(path.join(root, 'locales', 'en.default.schema.json')));
    return (key) => key.split('.').reduce((v, k) => (isPlainObject(v) ? v[k] : undefined), json);
  } catch {
    return null;
  }
}

/** Theme check's ExcessiveSettingsCount limit (default 40) as configured in .theme-check.yml. */
export function readThemeCheckSettingsLimit(root) {
  const fallback = { max: 40, enabled: true, source: "theme check's default" };
  let text;
  try {
    text = readText(path.join(root, '.theme-check.yml'));
  } catch {
    return fallback;
  }
  const block = /^ExcessiveSettingsCount:[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$))*)/m.exec(text);
  if (!block) return fallback;
  const max = /^[ \t]+maxSettings:[ \t]*(\d+)/m.exec(block[1]);
  return {
    max: max ? Number(max[1]) : 40,
    enabled: !/^[ \t]+enabled:[ \t]*false\b/m.test(block[1]),
    source: '.theme-check.yml',
  };
}

// ----------------------------------------------------------------- manifests

/** Every *.json under `dir`, recursively, as sorted posix paths relative to `dir`. */
export function listManifestFiles(dir) {
  const out = [];
  const walk = (abs, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(abs, e.name), r);
      else if (e.isFile() && e.name.endsWith('.json')) out.push(r);
    }
  };
  walk(dir, '');
  return out;
}

export const MANIFEST_KINDS = ['section', 'block', 'theme'];

/**
 * Kind of a manifest: explicit "kind", else its location inside the manifests
 * folder (theme-settings.json → theme, sections/ → section, blocks/ → block),
 * else its target path. Returns null when it cannot be told.
 */
export function detectKind(relManifest, manifest) {
  if (isPlainObject(manifest) && typeof manifest.kind === 'string') return manifest.kind;
  if (relManifest === 'theme-settings.json') return 'theme';
  const first = relManifest.split('/')[0];
  if (first === 'sections' && relManifest.includes('/')) return 'section';
  if (first === 'blocks' && relManifest.includes('/')) return 'block';
  const file = isPlainObject(manifest) ? manifest.file : undefined;
  if (file === THEME_SETTINGS_FILE) return 'theme';
  if (typeof file === 'string' && file.startsWith('sections/')) return 'section';
  if (typeof file === 'string' && file.startsWith('blocks/')) return 'block';
  return null;
}

/** Validates a manifest "file" and returns its normalised posix path relative to root. */
export function resolveTarget(root, file) {
  if (typeof file !== 'string' || !file.trim()) throw new SchemaIOError('"file" must name the target file, relative to the theme root');
  if (path.isAbsolute(file) || /^[A-Za-z]:/.test(file)) throw new SchemaIOError(`"file" must be relative to the theme root (got ${file})`);
  const rel = path.posix.normalize(file.replace(/\\/g, '/'));
  if (rel === '..' || rel.startsWith('../')) throw new SchemaIOError(`"file" escapes the theme root (got ${file})`);
  return rel;
}

// --------------------------------------------------------------------- diff

function splitLines(text) {
  const lines = normalizeEol(text).split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const MYERS_MAX_D = 2500;

function myers(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((l) => ['+', l]);
  if (m === 0) return a.map((l) => ['-', l]);
  const max = n + m;
  const off = max;
  const v = new Int32Array(2 * max + 2);
  const trace = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    if (d > MYERS_MAX_D) return null;
    trace.push(v.slice(off - d, off + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  const ops = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const w = trace[d];
    const at = (kk) => w[kk + d];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push([' ', a[x - 1]]);
      x -= 1;
      y -= 1;
    }
    if (x === prevX) {
      ops.push(['+', b[y - 1]]);
      y -= 1;
    } else {
      ops.push(['-', a[x - 1]]);
      x -= 1;
    }
  }
  while (x > 0 && y > 0) {
    ops.push([' ', a[x - 1]]);
    x -= 1;
    y -= 1;
  }
  return ops.reverse();
}

/** Line operations [op, line] (op ' ', '-', '+') turning `a` into `b`. */
export function diffOps(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1;
  let ea = a.length;
  let eb = b.length;
  while (ea > pre && eb > pre && a[ea - 1] === b[eb - 1]) {
    ea -= 1;
    eb -= 1;
  }
  const midA = a.slice(pre, ea);
  const midB = b.slice(pre, eb);
  const mid = myers(midA, midB) ?? [...midA.map((l) => ['-', l]), ...midB.map((l) => ['+', l])];
  return [...a.slice(0, pre).map((l) => [' ', l]), ...mid, ...a.slice(ea).map((l) => [' ', l])];
}

/**
 * Unified diff of two texts (line endings normalised). Empty string when equal.
 * `maxLines` (> 0) truncates the output with a note.
 */
export function unifiedDiff(oldText, newText, { oldLabel = 'a', newLabel = 'b', context = 3, maxLines = 0 } = {}) {
  const ops = diffOps(splitLines(oldText), splitLines(newText));
  const changes = [];
  ops.forEach((op, i) => {
    if (op[0] !== ' ') changes.push(i);
  });
  if (!changes.length) return '';
  const pos = [];
  let al = 1;
  let bl = 1;
  for (const [op] of ops) {
    pos.push([al, bl]);
    if (op !== '+') al += 1;
    if (op !== '-') bl += 1;
  }
  const ranges = [];
  let start = changes[0];
  let end = changes[0];
  for (const i of changes.slice(1)) {
    if (i - end <= 2 * context) end = i;
    else {
      ranges.push([start, end]);
      start = i;
      end = i;
    }
  }
  ranges.push([start, end]);
  const out = [`--- ${oldLabel}`, `+++ ${newLabel}`];
  for (const [s, e] of ranges) {
    const from = Math.max(0, s - context);
    const to = Math.min(ops.length - 1, e + context);
    let aCount = 0;
    let bCount = 0;
    for (let i = from; i <= to; i++) {
      if (ops[i][0] !== '+') aCount += 1;
      if (ops[i][0] !== '-') bCount += 1;
    }
    const [aStart, bStart] = pos[from];
    out.push(`@@ -${aCount ? aStart : aStart - 1},${aCount} +${bCount ? bStart : bStart - 1},${bCount} @@`);
    for (let i = from; i <= to; i++) out.push(ops[i][0] + ops[i][1]);
  }
  if (maxLines > 0 && out.length > maxLines) {
    const hidden = out.length - maxLines;
    out.length = maxLines;
    out.push(`... (${hidden} more diff lines not shown; raise --diff-lines)`);
  }
  return out.join('\n');
}
