#!/usr/bin/env node
// scripts/schema/build.mjs — the schema generator (EDITOR-ARCHITECTURE.md §7.2).
//
//   node scripts/schema/build.mjs                       expand every manifest, validate, write
//   node scripts/schema/build.mjs --check               regenerate in memory; exit 1 on drift (prints a diff)
//   node scripts/schema/build.mjs --only sections/home-grid.liquid [--only …]
//   node scripts/schema/build.mjs --lint                also validate every schema without a manifest
//
// Reads scripts/schema/manifests/**/*.json, expands {"ref": "<fragment>"} entries from
// scripts/schema/fragments/*.json, validates (lib/validate.mjs) and writes each target's
// {% schema %} body in place (2-space JSON, LF, canonical key order; every byte outside the
// tag is kept) or config/settings_schema.json (from manifests/theme-settings.json).
// Nothing is written when any error is found. Node standard library only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPO_ROOT, SCHEMA_DIR, THEME_SETTINGS_FILE, SchemaIOError, deepEqual, displayPath, normalizeEol,
  findSchemaTag, readLiquidSchema, spliceSchemaBody, formatJSONDocument, loadThemeModel, loadSchemaLocale,
  readThemeCheckSettingsLimit, listManifestFiles, detectKind, resolveTarget, unifiedDiff, parseJSON, MANIFEST_KINDS,
} from './lib/schema-io.mjs';
import { loadFragments, loadData, expandManifest, manifestProblems, FragmentError } from './lib/fragments.mjs';
import { validateSchemaFile, validateThemeSettings } from './lib/validate.mjs';

export const USAGE = `Usage: node scripts/schema/build.mjs [options]

  --check              regenerate in memory; exit 1 when a file would change (unified diff printed)
  --only <file>        limit to one target (theme path such as sections/home-grid.liquid, or the
                       manifest path); repeat or comma-separate for several
  --lint               also validate every sections/*.liquid, blocks/*.liquid and
                       config/settings_schema.json that no manifest generates (report only)
  --root <dir>         theme root (default: the repository root)
  --manifests <dir>    manifests folder (default: scripts/schema/manifests)
  --fragments <dir>    fragments folder (default: scripts/schema/fragments)
  --styles <file>      style data (default: scripts/schema/styles.json, optional)
  --diff-lines <n>     cap each printed diff at n lines (default 400; 0 = no cap)
  --json               print the result as JSON
  --quiet              print only problems and the summary
  --help               this text

Exit status: 0 clean · 1 drift (--check), validation error or expansion error · 2 bad usage.`;

class UsageError extends Error {}

export function parseArgs(argv) {
  const opts = { check: false, lint: false, only: [], root: null, manifests: null, fragments: null, styles: null, diffLines: 400, json: false, quiet: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new UsageError(`${flag} needs a value`);
      i += 1;
      return next;
    };
    switch (flag) {
      case '--check': opts.check = true; break;
      case '--lint': opts.lint = true; break;
      case '--only': opts.only.push(...value().split(',').map((s) => s.trim()).filter(Boolean)); break;
      case '--root': opts.root = value(); break;
      case '--manifests': opts.manifests = value(); break;
      case '--fragments': opts.fragments = value(); break;
      case '--styles': opts.styles = value(); break;
      case '--diff-lines': {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 0) throw new UsageError('--diff-lines needs a whole number');
        opts.diffLines = n;
        break;
      }
      case '--json': opts.json = true; break;
      case '--quiet': case '-q': opts.quiet = true; break;
      case '--help': case '-h': opts.help = true; break;
      default: throw new UsageError(`unknown argument "${arg}"`);
    }
  }
  return opts;
}

const posix = (p) => p.replace(/\\/g, '/');

/** Whether an --only value names this manifest (by its target, or its own path in any spelling). */
function matchesOnly(job, wanted, root, manifestsDir) {
  const w = posix(wanted).replace(/^\.\//, '');
  const candidates = new Set([job.manifestFile, `manifests/${job.rel}`, job.rel]);
  if (job.target) candidates.add(job.target);
  if (candidates.has(w)) return true;
  const abs = path.resolve(wanted);
  return (job.target !== undefined && abs === path.resolve(root, job.target)) || abs === path.resolve(manifestsDir, job.rel);
}

function oldSchemaOf(kind, source, target) {
  try {
    return kind === 'theme' ? parseJSON(source, target) : readLiquidSchema(source, target).schema;
  } catch {
    return undefined;
  }
}

/**
 * Runs the generator. Returns { exitCode, root, issues, files, counts } without printing.
 * files: [{ target, manifest, status: 'unchanged'|'written'|'drift', reformatOnly?, diff? }]
 */
export function runBuild(options = {}) {
  const root = path.resolve(options.root ?? REPO_ROOT);
  const manifestsDir = path.resolve(options.manifests ?? path.join(SCHEMA_DIR, 'manifests'));
  const fragmentsDir = path.resolve(options.fragments ?? path.join(SCHEMA_DIR, 'fragments'));
  const stylesFile = path.resolve(options.styles ?? path.join(SCHEMA_DIR, 'styles.json'));
  const result = { exitCode: 0, root, issues: [], files: [], counts: { manifests: 0, fragments: 0, styles: false, linted: 0 } };
  const error = (rule, file, path_, message) => result.issues.push({ level: 'error', rule, file, path: path_, message });
  const only = options.only?.length ? options.only : null;
  // Under --only, problems of manifests/fragments the selection does not use are warnings, so
  // tasks building their own files in a shared working tree are not blocked by each other.
  const unselected = (issue) => ({ ...issue, level: 'warning', message: `${issue.message} (not part of this --only build)` });

  const fragments = loadFragments(fragmentsDir);
  let data = {};
  try {
    data = loadData(stylesFile);
  } catch (err) {
    data = { $errors: { styles: `${err.where}: ${err.reason ?? err.message}` } };
    const issue = { level: 'error', rule: 'json', file: displayPath(root, stylesFile), path: '', message: err.reason ?? err.message };
    result.issues.push(only ? unselected(issue) : issue);
  }
  for (const frag of fragments.values()) {
    if (!frag.error) continue;
    const issue = { level: 'error', rule: 'fragment', file: frag.file, path: '', message: frag.error };
    result.issues.push(only ? unselected(issue) : issue);
  }
  result.counts.fragments = [...fragments.values()].filter((f) => !f.error).length;
  result.counts.styles = Boolean(data.styles);

  const jobs = [];
  const loadProblems = [];
  for (const rel of listManifestFiles(manifestsDir)) {
    const manifestFile = displayPath(root, path.join(manifestsDir, rel));
    const problem = (rule, path_, message, target) => loadProblems.push({ rel, manifestFile, target, issue: { level: 'error', rule, file: manifestFile, path: path_, message } });
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(manifestsDir, rel), 'utf8'));
    } catch (err) {
      problem('json', '', `invalid JSON: ${err.message}`);
      continue;
    }
    const envelope = manifestProblems(manifest);
    if (envelope.length) {
      for (const p of envelope) problem('manifest', '', p);
      continue;
    }
    let target;
    try {
      target = resolveTarget(root, manifest.file);
    } catch (err) {
      problem('manifest', 'file', err.reason ?? err.message);
      continue;
    }
    const kind = detectKind(rel, manifest);
    if (!MANIFEST_KINDS.includes(kind)) {
      problem('manifest', '', 'cannot tell whether this manifest describes a section, a block or the theme settings: put it under manifests/sections/ or manifests/blocks/, or add "kind"', target);
      continue;
    }
    if (kind === 'theme' && target !== THEME_SETTINGS_FILE) {
      problem('manifest', 'file', `a theme-settings manifest must target ${THEME_SETTINGS_FILE}`, target);
      continue;
    }
    jobs.push({ rel, manifestFile, manifest, kind, target });
  }
  result.counts.manifests = jobs.length;

  const byTarget = new Map();
  for (const job of jobs) {
    const first = byTarget.get(job.target);
    if (!first) byTarget.set(job.target, job);
    else {
      loadProblems.push({
        rel: job.rel,
        manifestFile: job.manifestFile,
        target: job.target,
        also: first,
        issue: { level: 'error', rule: 'manifest', file: job.manifestFile, path: 'file', message: `${job.target} is already generated by ${first.manifestFile}` },
      });
    }
  }

  // A manifest that could not be read has no known target: under --only it counts as selected
  // when its name matches the wanted file's name (manifests/sections/home-grid.json ↔ sections/home-grid.liquid).
  const stem = (p) => path.posix.basename(posix(p)).replace(/\.liquid(\.txt)?$|\.json$/, '');
  const concerns = (p, wanted) =>
    matchesOnly(p, wanted, root, manifestsDir) || (p.also && matchesOnly(p.also, wanted, root, manifestsDir)) || (p.target === undefined && stem(p.rel) === stem(wanted));
  let selected = [...byTarget.values()];
  if (only) {
    selected = [];
    for (const wanted of only) {
      const hits = [...byTarget.values()].filter((job) => matchesOnly(job, wanted, root, manifestsDir));
      if (!hits.length && !loadProblems.some((p) => concerns(p, wanted))) error('usage', wanted, '', 'no manifest generates this file');
      for (const hit of hits) if (!selected.includes(hit)) selected.push(hit);
    }
  }
  for (const p of loadProblems) {
    const relevant = !only || only.some((w) => concerns(p, w));
    result.issues.push(relevant ? p.issue : unselected(p.issue));
  }

  const origins = new WeakMap();
  const outputs = new Map();
  for (const job of selected) {
    try {
      const schema = expandManifest(job.manifest, { kind: job.kind, manifestFile: job.manifestFile, fragments, data, origins });
      const abs = path.join(root, job.target);
      if (!fs.existsSync(abs)) {
        error('target', job.target, '', `the target file does not exist (generated by ${job.manifestFile})`);
        continue;
      }
      const oldSource = fs.readFileSync(abs, 'utf8');
      let newSource;
      if (job.kind === 'theme') {
        newSource = formatJSONDocument(schema);
      } else {
        const tag = findSchemaTag(oldSource, job.target);
        if (!tag) {
          error('target', job.target, '', 'the target has no {% schema %} tag to fill');
          continue;
        }
        newSource = spliceSchemaBody(oldSource, tag, schema);
      }
      outputs.set(job.target, { job, schema, oldSource, newSource });
    } catch (err) {
      if (!(err instanceof FragmentError || err instanceof SchemaIOError)) throw err;
      error('expand', job.manifestFile, err.where ?? '', err.reason ?? err.message);
    }
  }

  const overrides = new Map([...outputs].map(([target, o]) => [target, { schema: o.schema, source: o.newSource }]));
  const model = loadThemeModel(root, overrides);
  const limits = { excessive: readThemeCheckSettingsLimit(root) };
  const resolveT = loadSchemaLocale(root);
  for (const [target, o] of outputs) {
    const issues =
      o.job.kind === 'theme'
        ? validateThemeSettings({ file: target, schema: o.schema, origins })
        : validateSchemaFile({ file: target, kind: o.job.kind, schema: o.schema, source: o.newSource, model, origins, limits, resolveT, sizeBytes: Buffer.byteLength(o.newSource) });
    result.issues.push(...issues);
  }

  if (options.lint) {
    const managed = new Set(byTarget.keys());
    for (const [dir, kind] of [['sections', 'section'], ['blocks', 'block']]) {
      for (const entry of model[dir].values()) {
        if (managed.has(entry.file)) continue;
        result.counts.linted += 1;
        if (entry.error) error('json', entry.file, '', entry.error);
        else if (entry.schema) result.issues.push(...validateSchemaFile({ file: entry.file, kind, schema: entry.schema, source: entry.source, model, limits, resolveT, sizeBytes: Buffer.byteLength(entry.source) }));
      }
    }
    if (model.settings && !managed.has(THEME_SETTINGS_FILE)) {
      result.counts.linted += 1;
      if (model.settings.error) error('json', THEME_SETTINGS_FILE, '', model.settings.error);
      else result.issues.push(...validateThemeSettings({ file: THEME_SETTINGS_FILE, schema: model.settings.schema }));
    }
  }

  if (result.issues.some((i) => i.level === 'error')) {
    result.exitCode = 1;
    return result;
  }

  for (const [target, o] of outputs) {
    const unchanged = normalizeEol(o.oldSource) === normalizeEol(o.newSource);
    const file = { target, manifest: o.job.manifestFile, status: unchanged ? 'unchanged' : options.check ? 'drift' : 'written' };
    if (!unchanged) {
      file.reformatOnly = deepEqual(oldSchemaOf(o.job.kind, o.oldSource, target), o.schema);
      file.diff = unifiedDiff(o.oldSource, o.newSource, { oldLabel: `a/${target}`, newLabel: `b/${target} (generated)`, maxLines: options.diffLines ?? 400 });
      if (!options.check) fs.writeFileSync(path.join(root, target), o.newSource, 'utf8');
    }
    result.files.push(file);
  }
  if (options.check && result.files.some((f) => f.status === 'drift')) result.exitCode = 1;
  return result;
}

function formatIssue(issue) {
  const where = issue.path ? ` > ${issue.path}` : '';
  const lines = [`${issue.level === 'error' ? 'ERROR' : 'warn '} [${issue.rule}] ${issue.file}${where}: ${issue.message}`];
  if (issue.origin) lines.push(`        from ${issue.origin}`);
  return lines.join('\n');
}

export function printResult(result, opts, out = console.log) {
  if (opts.json) {
    out(JSON.stringify(result, null, 2));
    return;
  }
  const mode = opts.check ? 'check' : 'build';
  if (!opts.quiet) {
    out(`schema ${mode}: ${result.counts.manifests} manifest(s), ${result.counts.fragments} fragment(s), styles.json ${result.counts.styles ? 'loaded' : 'absent'}${opts.lint ? `, ${result.counts.linted} unmanaged schema(s) linted` : ''}`);
  }
  for (const issue of result.issues) out(formatIssue(issue));
  for (const file of result.files) {
    if (file.status === 'unchanged') {
      if (!opts.quiet) out(`ok      ${file.target} (unchanged)`);
      continue;
    }
    const what = file.reformatOnly ? 'reformat only: the schema JSON is deep-equal, only its layout changes' : 'schema changed';
    out(`${file.status === 'drift' ? 'DRIFT ' : 'wrote '}  ${file.target} (${what}; manifest ${file.manifest})`);
    if (file.status === 'drift' && file.diff) out(file.diff);
  }
  const errors = result.issues.filter((i) => i.level === 'error').length;
  const warnings = result.issues.length - errors;
  const drift = result.files.filter((f) => f.status === 'drift').length;
  const written = result.files.filter((f) => f.status === 'written').length;
  const parts = [`${errors} error(s)`, `${warnings} warning(s)`];
  if (opts.check) parts.push(`${drift} file(s) would change`);
  else parts.push(`${written} file(s) written`);
  if (errors) parts.push('nothing written');
  out(`${result.exitCode === 0 ? 'OK' : 'FAILED'}: ${parts.join(', ')}`);
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
  const result = runBuild(opts);
  printResult(result, opts);
  return result.exitCode;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  const invoked = path.resolve(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === invoked.toLowerCase() : self === invoked;
}

if (isMainModule()) process.exitCode = main(process.argv.slice(2));
