#!/usr/bin/env node
// scripts/schema/import.mjs — turn an existing {% schema %} into a manifest (EDITOR-ARCHITECTURE.md §7.2).
//
//   node scripts/schema/import.mjs sections/home-grid.liquid
//   node scripts/schema/import.mjs config/settings_schema.json
//
// Every setting becomes { "ref": "setting", …verbatim… } (headers and paragraphs included),
// presets and every other attribute are copied as they are, so the owner starts from an
// exact copy and then replaces runs of settings with fragment refs. The import proves its
// own round trip before writing: expanding the new manifest gives a schema deep-equal to
// the source (arrays order-sensitive, object keys order-insensitive).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPO_ROOT, SCHEMA_DIR, THEME_SETTINGS_FILE, SchemaIOError, deepEqual, displayPath, readLiquidSchema,
  canonicalizeSchema, formatSchemaBody, formatJSONDocument, parseJSON, resolveTarget, detectKind, normalizeEol,
} from './lib/schema-io.mjs';
import { expandManifest, manifestSchemaFrom, FragmentError } from './lib/fragments.mjs';

export const USAGE = `Usage: node scripts/schema/import.mjs <file> [<file> …] [options]

  <file>              a section or theme block (.liquid), or config/settings_schema.json
  --out <path>        manifest to write (single input only; "-" prints it). Default:
                      scripts/schema/manifests/sections/<name>.json, …/blocks/<name>.json or
                      …/theme-settings.json
  --file <path>       the "file" recorded in the manifest (default: the input, relative to --root)
  --kind <kind>       section | block | theme (default: from the path)
  --root <dir>        theme root (default: the repository root)
  --manifests <dir>   manifests folder for the default --out (default: scripts/schema/manifests)
  --force             overwrite an existing manifest
  --help              this text`;

class UsageError extends Error {}

export function parseArgs(argv) {
  const opts = { inputs: [], out: null, file: null, kind: null, root: null, manifests: null, force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('--') && next !== '-')) throw new UsageError(`${flag} needs a value`);
      i += 1;
      return next;
    };
    if (!arg.startsWith('--') || arg === '-') {
      opts.inputs.push(arg);
      continue;
    }
    switch (flag) {
      case '--out': opts.out = value(); break;
      case '--file': opts.file = value(); break;
      case '--kind': opts.kind = value(); break;
      case '--root': opts.root = value(); break;
      case '--manifests': opts.manifests = value(); break;
      case '--force': opts.force = true; break;
      case '--help': opts.help = true; break;
      default: throw new UsageError(`unknown argument "${arg}"`);
    }
  }
  if (!opts.help && !opts.inputs.length) throw new UsageError('name at least one file to import');
  if (opts.inputs.length > 1 && (opts.out || opts.file)) throw new UsageError('--out and --file work with a single input only');
  if (opts.kind && !['section', 'block', 'theme'].includes(opts.kind)) throw new UsageError('--kind must be section, block or theme');
  return opts;
}

const posix = (p) => p.replace(/\\/g, '/');

function kindFromPath(rel) {
  if (rel === THEME_SETTINGS_FILE || rel.endsWith('/settings_schema.json')) return 'theme';
  if (rel.startsWith('blocks/') || rel.includes('/blocks/')) return 'block';
  return 'section';
}

function baseName(rel) {
  return path.posix.basename(rel).replace(/\.liquid(\.txt)?$/, '').replace(/\.json$/, '');
}

/**
 * Imports one file. Returns { manifest, out, report } and writes the manifest unless out is "-".
 * Throws SchemaIOError / FragmentError / UsageError on problems.
 */
export function importFile(input, opts = {}) {
  const root = path.resolve(opts.root ?? REPO_ROOT);
  const manifestsDir = path.resolve(opts.manifests ?? path.join(SCHEMA_DIR, 'manifests'));
  // A relative input is a theme path first (relative to --root), then a path from the current folder.
  let abs = path.resolve(root, input);
  if (!fs.existsSync(abs)) abs = path.resolve(input);
  if (!fs.existsSync(abs)) throw new UsageError(`${input}: file not found`);
  const relToRoot = displayPath(root, abs);
  const recorded = opts.file ? resolveTarget(root, opts.file) : relToRoot;
  if (!opts.file && path.isAbsolute(relToRoot)) throw new UsageError(`${input} is outside the theme root ${root}; pass --file or --root`);
  const kind = opts.kind ?? kindFromPath(recorded);
  const source = fs.readFileSync(abs, 'utf8');

  let schema;
  let oldBody;
  if (kind === 'theme') {
    schema = parseJSON(source, relToRoot);
    oldBody = source;
  } else {
    const { tag, schema: parsed } = readLiquidSchema(source, relToRoot);
    if (!tag) throw new SchemaIOError('no {% schema %} tag to import', relToRoot);
    schema = parsed;
    oldBody = tag.body;
  }

  const out =
    opts.out ??
    path.join(manifestsDir, kind === 'theme' ? 'theme-settings.json' : path.join(kind === 'block' ? 'blocks' : 'sections', `${baseName(recorded)}.json`));
  // "kind" is written only when neither the manifest's location nor its target tells it.
  const relOut = out === '-' ? '' : posix(path.relative(manifestsDir, path.resolve(out)));
  const needsKind = detectKind(relOut, { file: recorded }) !== kind;
  const schemaPart = manifestSchemaFrom(schema, kind);
  const manifest = needsKind ? { file: recorded, kind, schema: schemaPart } : { file: recorded, schema: schemaPart };

  const expanded = expandManifest(manifest, { kind, manifestFile: '(import)', fragments: new Map() });
  const expected = kind === 'theme' ? schema : canonicalizeSchema(schema);
  if (!deepEqual(expanded, expected)) throw new SchemaIOError('internal error: the imported manifest does not expand back to the same schema', relToRoot);

  const newBody = kind === 'theme' ? formatJSONDocument(expanded) : `\n${formatSchemaBody(expanded)}\n`;
  const lines = (t) => normalizeEol(t).replace(/\n$/, '').split('\n').length;
  const reformat = normalizeEol(oldBody).trim() === normalizeEol(newBody).trim() ? 'already in canonical form' : `the first build reformats the schema (${lines(oldBody.trim())} → ${lines(newBody.trim())} lines, deep-equal JSON)`;

  const text = formatJSONDocument(manifest);
  if (out === '-') {
    process.stdout.write(text);
  } else {
    if (fs.existsSync(out) && !opts.force) throw new UsageError(`${displayPath(root, path.resolve(out))} already exists (use --force to overwrite)`);
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, text, 'utf8');
  }
  const counts =
    kind === 'theme'
      ? `${schema.filter((p) => p && Array.isArray(p.settings)).length} panel(s), ${schema.reduce((n, p) => n + (Array.isArray(p?.settings) ? p.settings.length : 0), 0)} setting(s)`
      : `${(schema.settings ?? []).length} setting(s), ${(schema.blocks ?? []).length} block(s), ${(schema.presets ?? []).length} preset(s)`;
  const report = `imported ${relToRoot} (${kind}: ${counts}) → ${out === '-' ? 'stdout' : displayPath(root, path.resolve(out))}; round trip deep-equal: yes; ${reformat}`;
  return { manifest, out, report };
}

export function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  let status = 0;
  for (const input of opts.inputs) {
    try {
      const { report } = importFile(input, opts);
      if (opts.out !== '-') console.log(report);
      else console.error(report);
    } catch (err) {
      if (!(err instanceof UsageError || err instanceof SchemaIOError || err instanceof FragmentError)) throw err;
      console.error(`import failed: ${err.message}`);
      status = 1;
    }
  }
  return status;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  const invoked = path.resolve(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === invoked.toLowerCase() : self === invoked;
}

if (isMainModule()) process.exitCode = main(process.argv.slice(2));
