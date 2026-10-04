#!/usr/bin/env node
// scripts/css/check-bindings.mjs
//
// Asserts that the rules re-declared in the theme's {% stylesheet %} bundles
// keep today's rendering (EDITOR-ARCHITECTURE.md §6.5, §7.6):
//   (a) coverage   — a bundle that re-declares a property of an asset selector
//                    re-declares EVERY asset rule that sets it for that selector
//                    (same @media wrapper, same order, same !important), plus
//                    the shorthands/longhands that interact with it;
//   (b) fallback   — with no binding variable set, each re-declared value is the
//                    asset value (the innermost fallback of a var() chain);
//   (c) uniqueness — no (selector, property) is bound in two theme files;
//   (d) :root      — no custom property assigned in the :root blocks of
//                    snippets/css-variables.liquid is declared on :root in the
//                    asset CSS (css-variables renders before base.css, so such a
//                    token would be dead), except the allow-list;
//   (e) report     — bundle selectors that match no asset selector and are not
//                    new components (blk-*, newsletter*, [data-color-scheme],
//                    [data-hover-tuned]).
// Exit 1 on any failed assertion (a–d), with file / selector / property / reason.
// See README.md. Node standard library only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from './lib/css-parse.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..', '..');

/** The five card tokens css-variables emits but base.css re-declares on
 *  :root (dead settings, EDITOR-ARCHITECTURE.md §4.4). Stage B1 (T5.1) deletes
 *  the base.css lines; from then on run with --allow none (or empty this list). */
export const DEFAULT_ROOT_ALLOW = Object.freeze([
  '--card-gap',
  '--card-text-inset',
  '--card-text-start',
  '--card-text-top',
  '--card-text-space',
]);

/** New components: bundle selectors containing these are not reported by (e). */
export const NEW_COMPONENT_MARKERS = Object.freeze(['.blk-', '.newsletter', '[data-color-scheme', '[data-hover-tuned']);

const THEME_DIRS = ['sections', 'snippets', 'blocks'];
const USER_ACTION = /:(?:hover|focus-visible|focus-within|focus|active)(?![A-Za-z0-9_-])/g;
const ALL_CHECKS = ['a', 'b', 'c', 'd', 'e'];

/* --------------------------------------------------------------------------
   Inputs
   -------------------------------------------------------------------------- */

/** Every {% stylesheet %} of sections/, snippets/ and blocks/, parsed. */
export function scanTheme(root) {
  const files = [];
  const counts = {};
  for (const dir of THEME_DIRS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) { counts[dir] = 0; continue; }
    const names = fs.readdirSync(abs).filter((n) => n.endsWith('.liquid')).sort();
    counts[dir] = names.length;
    for (const name of names) {
      const file = `${dir}/${name}`;
      const blocks = P.extractStylesheets(fs.readFileSync(path.join(abs, name), 'utf8'));
      if (!blocks.length) continue;
      const rules = [];
      const warnings = [];
      for (const b of blocks) {
        const parsed = P.parseCss(b.css, { source: file, lineOffset: b.line - 1 });
        rules.push(...parsed.rules);
        warnings.push(...parsed.warnings);
        if (!b.closed) warnings.push({ source: file, line: b.line, message: '{% stylesheet %} has no {% endstylesheet %}', severity: 'error' });
      }
      files.push({ file, blocks: blocks.length, rules, warnings });
    }
  }
  return { files, counts };
}

/** Custom property names assigned inside the :root blocks of css-variables
 *  (Liquid tags are opaque; names built with {{ }} become wildcard patterns). */
export function rootTokensFromVariables(liquidText) {
  const text = P.blankLiquidRegions(P.normalizeNewlines(P.stripBom(String(liquidText))));
  const names = [];
  const warnings = [];
  const frames = [];
  let selStart = 0;
  const stripLiquid = (s) => s.replace(/\{%[\s\S]*?%\}|\{\{[\s\S]*?\}\}/g, ' ');
  const collect = (body, bodyStart) => {
    const clean = P.stripComments(body, ' ');
    const re = /(^|[;{}\s])(--(?:[A-Za-z0-9_-]|\{\{[\s\S]*?\}\})+)\s*:/g;
    for (const m of clean.matchAll(re)) {
      const name = m[2];
      const line = P.lineNumberAt(text, bodyStart + m.index + m[1].length);
      if (name.includes('{{')) {
        const source = name.split(/\{\{[\s\S]*?\}\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[A-Za-z0-9_-]+');
        names.push({ name, pattern: new RegExp(`^${source}$`), line });
      } else names.push({ name, pattern: null, line });
    }
    for (const m of clean.matchAll(/(^|[;{}\s])\{\{[\s\S]*?\}\}\s*:/g)) {
      warnings.push(`css-variables line ${P.lineNumberAt(text, bodyStart + m.index + m[1].length)}: a custom property name built entirely by Liquid is not checked`);
    }
  };
  for (let i = 0; i < text.length; ) {
    if (text.startsWith('{%', i)) { const j = text.indexOf('%}', i + 2); i = j < 0 ? text.length : j + 2; continue; }
    if (text.startsWith('{{', i)) { const j = text.indexOf('}}', i + 2); i = j < 0 ? text.length : j + 2; continue; }
    const c = text[i];
    if (c === '"' || c === "'") { i = P.endOfString(text, i); continue; }
    if (c === '/' && text[i + 1] === '*') { i = P.endOfComment(text, i); continue; }
    if (c === '{') {
      const selector = P.stripComments(stripLiquid(text.slice(selStart, i)), ' ').trim();
      const root = P.splitTopLevel(selector, ',').some((m) => m.trim() && P.isRootSelector(m.trim()));
      frames.push({ root, bodyStart: i + 1 });
      selStart = i + 1;
      i++;
      continue;
    }
    if (c === '}') {
      const f = frames.pop();
      if (f && f.root) collect(text.slice(f.bodyStart, i), f.bodyStart);
      selStart = i + 1;
      i++;
      continue;
    }
    if (c === ';') selStart = i + 1;
    i++;
  }
  return { names, warnings };
}

/** Reads an allow-list: 'none', an inline list "--a,--b", a JSON array (or
 *  { "names": [...] }) file, or a text file with one name per line (# comments). */
export function loadAllowList(spec) {
  if (spec === undefined || spec === null) return { names: new Set(DEFAULT_ROOT_ALLOW), label: 'built-in: the five card tokens (B1 repair)' };
  const s = String(spec).trim();
  if (s === '' || s.toLowerCase() === 'none') return { names: new Set(), label: 'none' };
  let list;
  let label;
  if (fs.existsSync(s) && fs.statSync(s).isFile()) {
    const raw = P.stripBom(fs.readFileSync(s, 'utf8'));
    label = P.toPosix(s);
    try {
      const j = JSON.parse(raw);
      list = Array.isArray(j) ? j : j && Array.isArray(j.names) ? j.names : null;
      if (!list) throw new Error('not a list');
    } catch {
      list = raw.split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
    }
  } else if (/^--[A-Za-z0-9_-]+(\s*,\s*--[A-Za-z0-9_-]+)*$/.test(s)) {
    list = s.split(',').map((x) => x.trim());
    label = 'inline';
  } else {
    throw new Error(`--allow: "${s}" is neither a file, "none", nor a list of --names`);
  }
  for (const n of list) if (typeof n !== 'string' || !/^--[A-Za-z0-9_-]+$/.test(n)) throw new Error(`--allow: invalid name ${JSON.stringify(n)}`);
  return { names: new Set(list), label };
}

/* --------------------------------------------------------------------------
   Helpers
   -------------------------------------------------------------------------- */

function lcsAlign(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/** Connected components of `props` under "shares a longhand". */
function propertyGroups(props) {
  const list = [...props];
  const parent = list.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) if (P.propsRelated(list[i], list[j])) parent[find(i)] = find(j);
  }
  const groups = new Map();
  list.forEach((p, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, new Set());
    groups.get(r).add(p);
  });
  return [...groups.values()];
}

const where = (w) => (w ? w : 'top level');
const isDesigned = (o) => o.comments.some((c) => /^designed\b/i.test(c));
const startsWithVar = (v) => /^var\(/i.test(String(v).trim());

/* --------------------------------------------------------------------------
   The check
   -------------------------------------------------------------------------- */

/**
 * @param {{root?: string, cssFiles?: string[], varsFile?: string, allow?: string,
 *          only?: string[], checks?: string[], newMarkers?: string[]}} opts
 */
export function checkBindings(opts = {}) {
  const root = path.resolve(opts.root || DEFAULT_ROOT);
  const checks = new Set(opts.checks && opts.checks.length ? opts.checks : ALL_CHECKS);
  const only = opts.only && opts.only.length ? new Set(opts.only.map((f) => P.toPosix(f).replace(/^\.\//, ''))) : null;
  const inScope = (file) => !only || only.has(file);
  const markers = [...NEW_COMPONENT_MARKERS, ...(opts.newMarkers || [])];
  const allow = loadAllowList(opts.allow);

  const asset = P.loadAssetCss(root, opts.cssFiles && opts.cssFiles.length ? opts.cssFiles : P.defaultAssetFiles(root));
  const index = P.indexBySelector(asset.rules);
  const theme = scanTheme(root);

  const failures = [];
  const warnings = [];
  const designed = [];
  const fail = (check, f) => failures.push({ check, ...f });

  for (const w of asset.warnings) warnings.push(`${w.source}:${w.line}: ${w.message}`);
  for (const f of theme.files) {
    for (const w of f.warnings) {
      if (w.severity === 'error' && inScope(f.file)) fail('parse', { file: f.file, line: w.line, reason: `CSS parse error in {% stylesheet %}: ${w.message}` });
      else warnings.push(`${w.source}:${w.line}: ${w.message}`);
    }
  }

  // bundle occurrences: one per (rule member × declaration), in file order
  const occurrences = [];
  for (const f of theme.files) {
    f.rules.forEach((rule, ri) => {
      if (rule.nested || rule.inKeyframes) return;
      rule.members.forEach((m) => {
        rule.declarations.forEach((d, di) => {
          occurrences.push({
            file: f.file,
            selKey: m.key,
            member: m.text,
            wrappers: rule.wrappers,
            wkey: P.wrapperKey(rule.wrappers),
            wlabel: P.wrapperLabel(rule.wrappers),
            prop: d.prop,
            property: d.property,
            value: d.value,
            important: d.important,
            comments: d.comments,
            line: d.line,
            pos: ri * 100000 + di,
          });
        });
      });
    });
  }

  const byFileSelector = new Map();
  for (const o of occurrences) {
    const k = `${o.file}\u0000${o.selKey}`;
    if (!byFileSelector.has(k)) byFileSelector.set(k, []);
    byFileSelector.get(k).push(o);
  }

  const redeclared = []; // { file, selKey, member, props, A, B }
  const newPairs = [];   // occurrences whose selector/property the asset never declares
  let compared = 0;

  for (const list of byFileSelector.values()) {
    list.sort((x, y) => x.pos - y.pos);
    const { file, selKey, member } = list[0];
    const assetDecls = P.declarationsFor(index, selKey).map(({ rule, decl, declIndex }) => ({
      prop: decl.prop,
      property: decl.property,
      value: decl.value,
      important: decl.important,
      wkey: P.wrapperKey(rule.wrappers),
      wlabel: P.wrapperLabel(rule.wrappers),
      source: rule.source,
      line: decl.line,
      order: rule.order,
      declIndex,
    }));
    const groups = propertyGroups(new Set([...assetDecls.map((d) => d.prop), ...list.map((o) => o.prop)]));
    for (const g of groups) {
      const B = list.filter((o) => g.has(o.prop));
      if (!B.length) continue;
      const A = assetDecls.filter((d) => g.has(d.prop));
      if (!A.length) { newPairs.push(...B); continue; }
      redeclared.push({ file, selKey, member, props: g, A, B });
      if (!inScope(file)) continue;

      // (a) coverage: same sequence of (wrapper, property, !important)
      const key = (x) => `${x.wkey}\u0001${x.prop}\u0001${x.important ? 1 : 0}`;
      const ka = A.map(key);
      const kb = B.map(key);
      let pairs;
      if (ka.length === kb.length && ka.every((k, i) => k === kb[i])) {
        pairs = A.map((a, i) => [a, B[i]]);
      } else {
        const aligned = lcsAlign(ka, kb);
        pairs = aligned.map(([i, j]) => [A[i], B[j]]);
        const missing = A.filter((_, i) => !aligned.some(([x]) => x === i));
        const extra = B.filter((_, j) => !aligned.some(([, y]) => y === j));
        for (const a of missing) {
          const twin = extra.findIndex((b) => key(b) === key(a));
          const impTwin = extra.findIndex((b) => b.wkey === a.wkey && b.prop === a.prop && b.important !== a.important);
          if (twin >= 0) {
            const b = extra.splice(twin, 1)[0];
            fail('a', { file, line: b.line, selector: member, property: a.property, reason: `out of order: the ${where(a.wlabel)} re-declaration must keep its position relative to the selector's other rules (asset order: ${A.map((x) => `${where(x.wlabel)} ${x.property}`).join(' → ')})` });
          } else if (impTwin >= 0) {
            const b = extra.splice(impTwin, 1)[0];
            fail('a', { file, line: b.line, selector: member, property: a.property, reason: `!important differs from ${a.source}:${a.line} (${where(a.wlabel)})` });
          } else {
            fail('a', { file, line: B[0].line, selector: member, property: a.property, reason: `missing ${where(a.wlabel)}: ${a.source}:${a.line} "${a.property}: ${a.value}${a.important ? ' !important' : ''}" is not re-declared — the bundle rule would override it` });
          }
        }
        for (const b of extra) {
          fail('a', { file, line: b.line, selector: member, property: b.property, reason: `${where(b.wlabel)} has no counterpart in the asset CSS for this selector (asset rules: ${A.map((x) => `${where(x.wlabel)} ${x.property}`).join(', ')})` });
        }
      }

      // (b) fallback: with no binding variable set the value is the asset value
      for (const [a, b] of pairs) {
        compared++;
        if (isDesigned(b)) {
          designed.push({ file, line: b.line, selector: member, property: b.property, asset: a.value, bundle: b.value, source: `${a.source}:${a.line}` });
          continue;
        }
        const r = P.stripForeignVars(b.value, P.customPropsIn(a.value));
        if (r.unresolved.length) {
          fail('b', { file, line: b.line, selector: member, property: b.property, reason: `var(${r.unresolved[0]}) has no fallback, so the asset value (${a.source}:${a.line} "${a.value}") is lost when it is unset` });
        } else if (P.normalizeValue(r.value) !== P.normalizeValue(a.value)) {
          const chain = P.varChain(b.value);
          const label = chain.vars.length && chain.innermost !== null ? `innermost fallback "${chain.innermost}"` : `value without variables "${P.normalizeValue(r.value)}"`;
          fail('b', { file, line: b.line, selector: member, property: b.property, reason: `${label} ≠ asset value "${a.value}" (${a.source}:${a.line}, ${where(a.wlabel)})` });
        }
      }
    }
  }

  // (c) uniqueness: (selector, longhand) re-declared or bound in two files
  if (checks.has('c')) {
    const owners = new Map();
    const add = (o) => {
      for (const l of P.longhandsOf(o.prop)) {
        const k = `${o.selKey}\u0000${l}`;
        if (!owners.has(k)) owners.set(k, new Map());
        const m = owners.get(k);
        if (!m.has(o.file)) m.set(o.file, o);
      }
    };
    for (const r of redeclared) r.B.forEach(add);
    for (const o of newPairs) if (startsWithVar(o.value)) add(o);
    const reported = new Map();
    for (const m of owners.values()) {
      if (m.size < 2) continue;
      const files = [...m.keys()].sort();
      if (!files.some(inScope)) continue;
      const first = m.get(files[0]);
      const k = `${first.selKey}\u0000${files.join('|')}`;
      if (!reported.has(k)) reported.set(k, { first, files, props: new Set() });
      for (const o of m.values()) reported.get(k).props.add(o.property);
    }
    for (const { first, files, props } of reported.values()) {
      fail('c', { file: files.join(' + '), selector: first.member, property: [...props].join(', '), reason: `bound in ${files.length} theme files (${files.join(', ')}); one owner per selector/property` });
    }
  }

  // (d) :root tokens
  const rootReport = { checked: false, names: 0, collisions: [], allowed: [], unusedAllow: [], file: null };
  if (checks.has('d')) {
    const varsFile = opts.varsFile ? path.resolve(root, opts.varsFile) : path.join(root, 'snippets', 'css-variables.liquid');
    rootReport.file = P.toPosix(path.relative(root, varsFile)) || varsFile;
    if (!fs.existsSync(varsFile)) {
      fail('d', { file: rootReport.file, reason: 'css-variables file not found: the :root check cannot run' });
    } else {
      rootReport.checked = true;
      const tokens = rootTokensFromVariables(fs.readFileSync(varsFile, 'utf8'));
      warnings.push(...tokens.warnings);
      rootReport.names = new Set(tokens.names.map((t) => t.name)).size;
      const rootDecls = [];
      const collectRoot = (rules, kind) => {
        for (const rule of rules) {
          if (rule.nested || rule.inKeyframes) continue;
          const roots = rule.members.filter((m) => P.isRootSelector(m.text));
          if (!roots.length) continue;
          for (const d of rule.declarations) {
            if (d.prop.startsWith('--')) rootDecls.push({ name: d.prop, source: rule.source, line: d.line, selector: roots.map((m) => m.text).join(', '), wlabel: P.wrapperLabel(rule.wrappers), kind });
          }
        }
      };
      collectRoot(asset.rules, 'asset');
      for (const f of theme.files) collectRoot(f.rules, 'bundle');
      const byName = new Map();
      for (const t of tokens.names) {
        for (const d of rootDecls) {
          if (t.pattern ? !t.pattern.test(d.name) : t.name !== d.name) continue;
          if (!byName.has(d.name)) byName.set(d.name, { name: d.name, token: t, at: [] });
          const entry = byName.get(d.name);
          if (!entry.at.some((x) => x.source === d.source && x.line === d.line)) entry.at.push(d);
        }
      }
      for (const c of [...byName.values()].sort((x, y) => x.name.localeCompare(y.name))) {
        const loc = c.at.map((d) => `${d.source}:${d.line}${d.wlabel ? ` (${d.wlabel})` : ''}`).join(', ');
        const item = { name: c.name, where: loc, css_variables_line: c.token.line };
        if (allow.names.has(c.name) && c.at.every((d) => d.kind === 'asset')) rootReport.allowed.push(item);
        else {
          rootReport.collisions.push(item);
          fail('d', { file: c.at[0].source, line: c.at[0].line, selector: c.at[0].selector, property: c.name, reason: `${c.name} is emitted by ${rootReport.file} (line ${c.token.line}) and also declared on :root at ${loc}; the later declaration wins, so the setting is dead` });
        }
      }
      rootReport.unusedAllow = [...allow.names].filter((n) => !rootReport.allowed.some((a) => a.name === n)).sort();
    }
  }

  // (e) bundle selectors that match nothing in the asset CSS
  const unknown = [];
  if (checks.has('e')) {
    const seen = new Set();
    for (const f of theme.files) {
      if (!inScope(f.file)) continue;
      for (const rule of f.rules) {
        if (rule.nested || rule.inKeyframes) continue;
        for (const m of rule.members) {
          const k = `${f.file}\u0000${m.key}`;
          if (seen.has(k) || index.has(m.key)) continue;
          seen.add(k);
          if (markers.some((x) => m.text.includes(x))) continue;
          const base = P.canonicalSelector(m.text.replace(USER_ACTION, ''));
          unknown.push({ file: f.file, line: rule.line, selector: m.text, kind: base !== m.key && index.has(base) ? 'state variant of an asset selector' : 'no match' });
        }
      }
    }
  }

  // warnings: cascade order and hover defaults
  const specCache = new Map();
  const spec = (t) => {
    if (!specCache.has(t)) specCache.set(t, P.specificity(t));
    return specCache.get(t);
  };
  const redeclaredBy = new Map(); // selKey → Map(file → Set(prop))
  for (const r of redeclared) {
    if (!redeclaredBy.has(r.selKey)) redeclaredBy.set(r.selKey, new Map());
    const m = redeclaredBy.get(r.selKey);
    if (!m.has(r.file)) m.set(r.file, new Set());
    for (const p of r.props) m.get(r.file).add(p);
  }
  for (const r of redeclared) {
    if (!inScope(r.file)) continue;
    const firstOrder = Math.min(...r.A.map((a) => a.order));
    const mine = spec(r.member);
    for (const rule of asset.rules) {
      if (rule.order <= firstOrder || rule.nested || rule.inKeyframes) continue;
      for (const m of rule.members) {
        if (m.key === r.selKey || P.compareSpecificity(spec(m.text), mine) !== 0 || !P.mayTargetSameElement(m.text, r.member)) continue;
        const hits = rule.declarations.filter((d) => [...r.props].some((p) => P.propsRelated(p, d.prop)));
        if (!hits.length) continue;
        const owners = redeclaredBy.get(m.key);
        const sameFile = owners && owners.has(r.file) && hits.every((d) => [...owners.get(r.file)].some((p) => P.propsRelated(p, d.prop)));
        if (sameFile) continue;
        const other = owners ? [...owners.keys()].filter((f) => f !== r.file) : [];
        warnings.push(`${r.file}: cascade order — ${rule.source}:${rule.line} "${m.text}" sets ${[...new Set(hits.map((d) => d.property))].join(', ')} with the specificity of "${r.member}" after it${other.length ? ` and is re-declared in ${other.join(', ')} (bundle order between files is not guaranteed)` : ''}; where both match one element it wins today and loses to the re-declaration`);
      }
    }
  }
  for (const o of newPairs) {
    if (!inScope(o.file) || !o.member.match(USER_ACTION)) continue;
    const base = P.canonicalSelector(o.member.replace(USER_ACTION, ''));
    const normal = P.declarationsFor(index, base).filter(({ decl }) => P.propsRelated(decl.prop, o.prop));
    if (!normal.length) continue;
    const values = [...new Set(normal.map(({ decl }) => P.normalizeValue(decl.value)))];
    const rendered = P.normalizeValue(P.stripForeignVars(o.value, new Set(normal.flatMap(({ decl }) => [...P.customPropsIn(decl.value)]))).value);
    if (values.length === 1 && values[0] === rendered) continue;
    warnings.push(values.length > 1
      ? `${o.file}:${o.line}: ${o.member} { ${o.property} } — the element's ${o.property} differs between rules (${values.join(' | ')}); check the hover default ("${rendered}") in each media context`
      : `${o.file}:${o.line}: ${o.member} { ${o.property} } defaults to "${rendered}" but the element's ${o.property} is "${values[0]}" today (§6.2: a new hover rule defaults to today's colour)`);
  }

  const pairs = (pred) => {
    const s = new Set();
    for (const o of occurrences) if (pred(o)) s.add(`${o.file}\u0000${o.selKey}\u0000${o.prop}`);
    return s.size;
  };
  const redeclaredSet = new Set();
  for (const r of redeclared) for (const b of r.B) redeclaredSet.add(`${b.file}\u0000${b.selKey}\u0000${b.prop}`);
  const newSet = new Set(newPairs.map((o) => `${o.file}\u0000${o.selKey}\u0000${o.prop}`));

  const active = failures.filter((f) => f.check === 'parse' || checks.has(f.check));
  return {
    root,
    asset: asset.sources,
    theme: { counts: theme.counts, files: theme.files.map((f) => ({ file: f.file, blocks: f.blocks, rules: f.rules.length })) },
    only: only ? [...only] : null,
    checks: [...checks],
    stats: {
      bound_pairs: pairs((o) => startsWithVar(o.value)),
      redeclared_pairs: redeclaredSet.size,
      new_pairs: newSet.size,
      declarations_compared: compared,
    },
    allow: { label: allow.label, names: [...allow.names] },
    root_tokens: rootReport,
    designed,
    unknown,
    warnings: [...new Set(warnings)],
    failures: active,
    ok: active.length === 0,
  };
}

/* --------------------------------------------------------------------------
   Report
   -------------------------------------------------------------------------- */

export function formatReport(r) {
  const out = [];
  const pad = (s) => s.padEnd(15);
  out.push(`check-bindings — ${P.toPosix(r.root)}`);
  out.push(`${pad('asset CSS')}${r.asset.map((s) => `${s.file} (${s.lines} lines, ${s.rules} rules)`).join(' + ')}`);
  const total = Object.values(r.theme.counts).reduce((a, b) => a + b, 0);
  const blocks = r.theme.files.reduce((a, f) => a + f.blocks, 0);
  out.push(`${pad('stylesheets')}${blocks} {% stylesheet %} block(s) in ${r.theme.files.length} of ${total} theme files (${Object.entries(r.theme.counts).map(([d, n]) => `${d} ${n}`).join(', ')})`);
  out.push(`${pad('pairs')}bound ${r.stats.bound_pairs} · re-declared ${r.stats.redeclared_pairs} · new ${r.stats.new_pairs}${r.only ? `   (only: ${r.only.join(', ')})` : ''}`);
  out.push('');
  const by = (c) => r.failures.filter((f) => f.check === c);
  const line = (label, c, okText) => {
    if (!r.checks.includes(c)) { out.push(`${pad(label)}skipped`); return; }
    const list = by(c);
    out.push(`${pad(label)}${list.length ? `FAIL — ${list.length} problem(s)` : `ok — ${okText}`}`);
    for (const f of list) {
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      const what = f.selector ? ` ${f.selector}${f.property ? ` { ${f.property} }` : ''}` : f.property ? ` ${f.property}` : '';
      out.push(`  ${loc}${what}: ${f.reason}`);
    }
  };
  const parse = by('parse');
  if (parse.length) {
    out.push(`${pad('parse')}FAIL — ${parse.length} problem(s)`);
    for (const f of parse) out.push(`  ${f.file}:${f.line}: ${f.reason}`);
  }
  const groups = new Set();
  line('(a) coverage', 'a', `${r.stats.redeclared_pairs} re-declared selector/property pair(s) fully covered`);
  line('(b) fallback', 'b', `${r.stats.declarations_compared} declaration(s) compared${r.designed.length ? `, ${r.designed.length} designed value(s) listed below` : ''}`);
  line('(c) uniqueness', 'c', 'no selector/property bound in two files');
  void groups;
  if (r.checks.includes('d')) {
    const t = r.root_tokens;
    const list = by('d');
    if (list.length) {
      out.push(`${pad('(d) :root')}FAIL — ${list.length} problem(s)`);
      for (const f of list) out.push(`  ${f.line ? `${f.file}:${f.line}` : f.file}${f.property ? ` ${f.property}` : ''}: ${f.reason}`);
    } else {
      out.push(`${pad('(d) :root')}ok — ${t.names} custom properties on :root in ${t.file}; ${t.allowed.length} also on :root in the asset CSS, all allow-listed (${r.allow.label})`);
    }
    for (const a of t.allowed) out.push(`  allow-listed  ${a.name}  ${a.where}`);
    if (t.unusedAllow.length) out.push(`  note: allow-list entries with no collision (remove them): ${t.unusedAllow.join(', ')}`);
  } else out.push(`${pad('(d) :root')}skipped`);
  if (r.checks.includes('e')) {
    out.push(`${pad('(e) report')}${r.unknown.length ? `${r.unknown.length} bundle selector(s) match nothing in the asset CSS:` : 'every bundle selector matches an asset selector or a new component'}`);
    for (const u of r.unknown) out.push(`  ${u.file}:${u.line} ${u.selector}  [${u.kind}]`);
  } else out.push(`${pad('(e) report')}skipped`);
  if (r.designed.length) {
    out.push('designed values (Stage B1; not failures):');
    for (const d of r.designed) out.push(`  ${d.file}:${d.line} ${d.selector} { ${d.property} }: asset "${d.asset}" (${d.source}) → bundle "${d.bundle}"`);
  }
  if (r.warnings.length) {
    out.push(`warnings (${r.warnings.length}):`);
    for (const w of r.warnings) out.push(`  ${w}`);
  }
  out.push('');
  out.push(r.ok ? 'PASS' : `FAIL — ${r.failures.length} failed assertion(s)`);
  return `${out.join('\n')}\n`;
}

/* --------------------------------------------------------------------------
   CLI
   -------------------------------------------------------------------------- */

const USAGE = `Usage: node scripts/css/check-bindings.mjs [options]

Checks every {% stylesheet %} in sections/, snippets/ and blocks/ against the
asset CSS: (a) coverage, (b) fallback, (c) uniqueness, (d) :root tokens,
(e) report of unknown selectors. Exit 1 on any failed assertion.

Options
  --only <file>       limit (a), (b), (e) and the warnings to this owning file; (c) to
                      conflicts that involve it (repeatable, or comma-separated)
  --checks <list>     run only these checks, e.g. --checks d   (default a,b,c,d,e)
  --allow <spec>      :root allow-list: a file (JSON array, {"names": [...]}, or one
                      name per line), an inline list "--a,--b", or "none"
                      (default: the five card tokens, repaired in Stage B1)
  --vars <file>       the css-variables snippet (default snippets/css-variables.liquid)
  --css <file>        asset stylesheet instead of assets/base.css [+ assets/base-pages.css];
                      repeatable, in cascade order
  --new <marker>      extra selector text that marks a new component for (e) (repeatable)
  --root <dir>        theme root (default: the repository containing this script)
  --json              print the result as JSON
  -h, --help          this text

Exit: 0 pass, 1 failed assertion, 2 usage or input error.`;

function parseArgs(argv) {
  const opts = { css: [], only: [], newMarkers: [], checks: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = (name) => {
      const eq = a.indexOf('=');
      if (eq >= 0) return a.slice(eq + 1);
      const v = argv[++i];
      if (v === undefined) throw new Error(`${name} needs a value`);
      return v;
    };
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--only' || a.startsWith('--only=')) opts.only.push(...take('--only').split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--checks' || a.startsWith('--checks=')) {
      const list = take('--checks').toLowerCase().split(/[\s,]+/).map((s) => s.replace(/[()]/g, '')).filter(Boolean);
      for (const c of list) if (!ALL_CHECKS.includes(c)) throw new Error(`--checks: unknown check "${c}" (use a, b, c, d, e)`);
      opts.checks = list;
    } else if (a === '--allow' || a.startsWith('--allow=')) opts.allow = take('--allow');
    else if (a === '--vars' || a.startsWith('--vars=')) opts.vars = take('--vars');
    else if (a === '--css' || a.startsWith('--css=')) opts.css.push(take('--css'));
    else if (a === '--new' || a.startsWith('--new=')) opts.newMarkers.push(take('--new'));
    else if (a === '--root' || a.startsWith('--root=')) opts.root = take('--root');
    else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

export function main(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    io.stderr.write(`check-bindings: ${err.message}\n\n${USAGE}\n`);
    return 2;
  }
  if (opts.help) { io.stdout.write(`${USAGE}\n`); return 0; }
  let result;
  try {
    result = checkBindings({
      root: opts.root,
      cssFiles: opts.css,
      varsFile: opts.vars,
      allow: opts.allow,
      only: opts.only,
      checks: opts.checks,
      newMarkers: opts.newMarkers,
    });
  } catch (err) {
    io.stderr.write(`check-bindings: ${err.message}\n`);
    return 2;
  }
  io.stdout.write(opts.json ? `${JSON.stringify(result, null, 2)}\n` : formatReport(result));
  return result.ok ? 0 : 1;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    const a = fs.realpathSync(path.resolve(process.argv[1]));
    const b = fs.realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

if (isMainModule()) process.exitCode = main();
