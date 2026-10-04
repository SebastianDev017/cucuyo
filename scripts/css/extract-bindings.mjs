#!/usr/bin/env node
// scripts/css/extract-bindings.mjs
//
// bindings.json → the complete re-declared rule set per owning Liquid file
// (EDITOR-ARCHITECTURE.md §6.5, §7.6). For every binding { file, selector,
// property, var, token? } it finds EVERY asset rule (assets/base.css, then
// assets/base-pages.css when it exists) whose selector list contains exactly
// that selector and declares that property, in source order, and re-declares
// each one for the owner's {% stylesheet %}: same selector, same @media
// wrapper copied verbatim, value rewritten as
//   var(--<var>, var(--<token>, <original value>))
// Narrowing (max-width) media variants read media_var (default '<var>-m' then
// '<var>', the §6.3 chain) and media_token (default '<token>-m'); other media
// variants read the top-level chain; a "media" map sets any query explicitly;
// "var": [] with "token": [] re-declares verbatim (order only); "template"
// writes a partial chain (e.g. into a shorthand). Shorthands/longhands that
// share a longhand with a bound property are re-declared verbatim alongside, so
// the cascade between them stays as it is. See README.md for the format and
// the workflow. Node standard library only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from './lib/css-parse.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
export const MARK_START = '/* extract-bindings:start */';
export const MARK_END = '/* extract-bindings:end */';

const ENTRY_KEYS = new Set([
  'file', 'selector', 'property', 'var', 'token', 'media_var', 'media_token', 'media', 'value', 'template', 'note', 'comment', '//',
]);
const OWNER_FILE = /^(sections|snippets|blocks)\/[^/\\]+\.liquid$/;
const NAME = /^[A-Za-z0-9_-]+$/;

/* --------------------------------------------------------------------------
   Bindings file
   -------------------------------------------------------------------------- */

/** null = not given (use the default); [] = explicitly none (false, "" or []). */
function nameList(value, field, where, errors) {
  if (value === undefined || value === null) return null;
  if (value === false || value === '') return [];
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  for (const x of list) {
    if (typeof x !== 'string' || !x.trim()) {
      errors.push(`${where}: "${field}" must be a custom property name or an array of names`);
      continue;
    }
    const name = x.trim().replace(/^--/, '');
    if (!name || !NAME.test(name)) {
      errors.push(`${where}: "${field}" has an invalid custom property name "${x}"`);
      continue;
    }
    out.push(name);
  }
  return out;
}

/** Comparison key of a `media` / `value` map key: a bare media query
 *  ("(max-width: 989px)") or a wrapper chain ("@supports (x) >> @media (y)").
 *  '' or "default" = the top-level rule. */
export function wrapperSpecKey(spec) {
  const s = String(spec).trim();
  if (s === '' || s.toLowerCase() === 'default' || s.toLowerCase() === 'none') return '';
  if (!s.startsWith('@')) return P.canonicalPrelude(s, 'media');
  return s
    .split('>>')
    .map((part) => {
      const m = /^@([A-Za-z-]+)\s*([\s\S]*)$/.exec(part.trim());
      if (!m) return part.trim();
      return `@${m[1].toLowerCase()} ${P.canonicalPrelude(m[2], m[1])}`;
    })
    .join(' >> ');
}

/**
 * Validates and expands a bindings document (array, or { bindings: [...] }).
 * One expanded entry per (selector member × property).
 */
export function normalizeBindings(doc, label = 'bindings') {
  const errors = [];
  const entries = [];
  const list = Array.isArray(doc) ? doc : doc && Array.isArray(doc.bindings) ? doc.bindings : null;
  if (!list) return { entries, errors: [`${label}: expected a JSON array of bindings (or { "bindings": [...] })`] };
  list.forEach((raw, i) => {
    const where = `${label} #${i + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errors.push(`${where}: each binding must be an object`); return; }
    for (const k of Object.keys(raw)) if (!ENTRY_KEYS.has(k)) errors.push(`${where}: unknown field "${k}"`);
    const file = typeof raw.file === 'string' ? raw.file.trim().replace(/\\/g, '/') : '';
    if (!OWNER_FILE.test(file)) errors.push(`${where}: "file" must be sections/<name>.liquid, snippets/<name>.liquid or blocks/<name>.liquid (got ${JSON.stringify(raw.file)})`);
    const selector = typeof raw.selector === 'string' ? raw.selector : '';
    const members = P.splitTopLevel(selector, ',').map((s) => s.trim()).filter(Boolean);
    if (!members.length) errors.push(`${where}: "selector" must be a non-empty selector (as written in the asset CSS)`);
    const props = (Array.isArray(raw.property) ? raw.property : [raw.property]).filter((p) => p !== undefined);
    const properties = [];
    for (const p of props) {
      if (typeof p !== 'string' || !p.trim() || /[:;{}\s]/.test(p.trim())) errors.push(`${where}: invalid "property" ${JSON.stringify(p)}`);
      else properties.push(p.trim());
    }
    if (!properties.length && !props.length) errors.push(`${where}: "property" is required`);
    const varsGiven = nameList(raw.var, 'var', where, errors);
    const tokensGiven = nameList(raw.token, 'token', where, errors);
    const vars = varsGiven || [];
    const tokens = tokensGiven || [];
    // "var": [] and "token": [] (both explicitly empty): re-declare verbatim,
    // only to keep the cascade order (e.g. a BEM modifier after a bound selector)
    const verbatim = varsGiven !== null && tokensGiven !== null && !vars.length && !tokens.length;
    let template;
    if (raw.template !== undefined) {
      if (typeof raw.template === 'string' && raw.template.trim()) template = { all: raw.template.trim(), used: new Set() };
      else if (raw.template && typeof raw.template === 'object' && !Array.isArray(raw.template)) {
        template = { byKey: new Map(), labels: new Map(), used: new Set() };
        for (const [k, v] of Object.entries(raw.template)) {
          if (typeof v !== 'string' || !v.trim()) { errors.push(`${where}: template["${k}"] must be a non-empty string`); continue; }
          template.byKey.set(wrapperSpecKey(k), v.trim());
          template.labels.set(wrapperSpecKey(k), k);
        }
      } else errors.push(`${where}: "template" must be a string or an object keyed by media query`);
      if (template && template.all !== undefined && (vars.length || tokens.length)) {
        errors.push(`${where}: a "template" string applies to every rule, so "var"/"token" would never be used; drop them, or key the template by query`);
      }
      if (raw.value !== undefined) errors.push(`${where}: "template" and "value" are exclusive (write the designed value into the template)`);
    }
    if (!vars.length && !tokens.length && !verbatim && !template) {
      errors.push(`${where}: give "var" (the element variable) and/or "token", or a "template"; "var": [] with "token": [] re-declares the rules verbatim`);
    }
    const mediaVarsExplicit = nameList(raw.media_var, 'media_var', where, errors);
    const mediaTokensExplicit = nameList(raw.media_token, 'media_token', where, errors);
    const media = new Map();
    if (raw.media !== undefined) {
      if (!raw.media || typeof raw.media !== 'object' || Array.isArray(raw.media)) errors.push(`${where}: "media" must be an object { "<media query>": { "var": …, "token": … } }`);
      else {
        for (const [k, v] of Object.entries(raw.media)) {
          if (!v || typeof v !== 'object' || Array.isArray(v)) { errors.push(`${where}: media["${k}"] must be an object with "var" and/or "token"`); continue; }
          for (const kk of Object.keys(v)) if (kk !== 'var' && kk !== 'token') errors.push(`${where}: media["${k}"] has unknown field "${kk}"`);
          media.set(wrapperSpecKey(k), {
            label: k,
            vars: nameList(v.var, `media["${k}"].var`, where, errors),
            tokens: nameList(v.token, `media["${k}"].token`, where, errors),
            used: false,
          });
        }
      }
    }
    let value;
    if (raw.value !== undefined) {
      if (typeof raw.value === 'string') value = { all: raw.value.trim() };
      else if (raw.value && typeof raw.value === 'object' && !Array.isArray(raw.value)) {
        value = { byKey: new Map() };
        for (const [k, v] of Object.entries(raw.value)) {
          if (typeof v !== 'string') errors.push(`${where}: value["${k}"] must be a string`);
          else value.byKey.set(wrapperSpecKey(k), v.trim());
        }
      } else errors.push(`${where}: "value" must be a string or an object keyed by media query`);
    }
    for (const member of members) {
      for (const property of properties) {
        entries.push({
          where,
          label,
          file,
          selector: member,
          selKey: P.canonicalSelector(member),
          property,
          prop: property.startsWith('--') ? property : property.toLowerCase(),
          vars,
          tokens,
          // narrowing (max-width) media variants, §6.3: the element's mobile
          // override, then its base override, then the mobile token —
          // var(--x-m, var(--x, var(--t-…-m, <original>)))
          mediaVars: mediaVarsExplicit ?? [...vars.map((v) => `${v}-m`), ...vars],
          mediaTokens: mediaTokensExplicit ?? tokens.map((t) => `${t}-m`),
          mediaVarsExplicit: !!mediaVarsExplicit,
          mediaTokensExplicit: !!mediaTokensExplicit,
          media,
          value,
          template,
          verbatim,
        });
      }
    }
  });
  return { entries, errors };
}

export function readBindingsFile(file, label = file) {
  const raw = fs.readFileSync(file, 'utf8');
  let doc;
  try {
    doc = JSON.parse(P.stripBom(raw));
  } catch (err) {
    return { entries: [], errors: [`${label}: invalid JSON (${err.message})`] };
  }
  return normalizeBindings(doc, label);
}

/* --------------------------------------------------------------------------
   Extraction
   -------------------------------------------------------------------------- */

/** Keys a wrapper chain answers to: the full chain ("@supports … >> @media …")
 *  and, when the innermost wrapper is an @media, its bare query. */
function wrapperKeys(wrappers) {
  const keys = [P.wrapperKey(wrappers)];
  const last = wrappers[wrappers.length - 1];
  if (last && last.name.toLowerCase() === 'media') keys.push(P.canonicalPrelude(last.prelude, 'media'));
  return keys;
}

function lookupMedia(entry, wrappers) {
  if (!entry.media.size || !wrappers.length) return null;
  for (const k of wrapperKeys(wrappers)) {
    const v = entry.media.get(k);
    if (v) { v.used = true; return v; }
  }
  return null;
}

function designedValueFor(entry, wrappers) {
  if (!entry.value) return undefined;
  if (entry.value.all !== undefined) return entry.value.all;
  if (!wrappers.length) return entry.value.byKey.get('');
  for (const k of wrapperKeys(wrappers)) if (entry.value.byKey.has(k)) return entry.value.byKey.get(k);
  return undefined;
}

/** A viewport-narrowing (mobile / tablet) wrapper chain: every wrapper is an
 *  @media whose query has a max-width and no hover / pointer / prefers-* /
 *  forced-colors / print feature. Its rules take the "-m" names by default. */
export function isNarrowingQuery(wrappers) {
  return wrappers.length > 0 && wrappers.every((w) => {
    if (w.name.toLowerCase() !== 'media') return false;
    const q = P.canonicalPrelude(w.prelude, 'media');
    return /max-width/.test(q) && !/hover|pointer|prefers-|forced-colors|print/.test(q);
  });
}

/** Builds var(--a, var(--b, … <literal>)). */
export function buildChain(names, literal) {
  return names.reduceRight((inner, name) => `var(--${name}, ${inner})`, literal);
}

/**
 * The chain names for one asset rule:
 *   top level                  → var…, token…
 *   a "media" map entry        → that entry's var / token (a missing one takes the default below)
 *   a narrowing (max-width) query → media_var (default <var>-m then <var>, §6.3),
 *                                 media_token (default <token>-m)
 *   any other query (hover, min-width only, prefers-*, forced-colors, @supports…)
 *                              → the top-level var / token, with a note
 */
function chainNames(entry, wrappers, notes) {
  if (!wrappers.length) return { vars: entry.vars, tokens: entry.tokens, kind: 'top' };
  const narrowing = isNarrowingQuery(wrappers);
  const def = narrowing ? { vars: entry.mediaVars, tokens: entry.mediaTokens } : { vars: entry.vars, tokens: entry.tokens };
  const m = lookupMedia(entry, wrappers);
  if (m) return { vars: m.vars ?? def.vars, tokens: m.tokens ?? def.tokens, kind: 'media-map' };
  if (!narrowing && (def.vars.length || def.tokens.length)) {
    notes.push(`${entry.where}: ${entry.selector} { ${entry.property} } inside "${P.wrapperLabel(wrappers)}" (not a max-width query) reads the top-level chain ${[...def.vars, ...def.tokens].map((n) => `--${n}`).join(' → ')}; set "media" for this query if the control should not drive it there (e.g. { "var": [], "token": [] } for none)`);
  }
  return { ...def, kind: narrowing ? 'narrowing' : 'other' };
}

function templateFor(entry, wrappers) {
  const t = entry.template;
  if (!t) return undefined;
  if (t.all !== undefined) return t.all;
  for (const k of wrappers.length ? wrapperKeys(wrappers) : ['']) {
    if (t.byKey.has(k)) { t.used.add(k); return t.byKey.get(k); }
  }
  return undefined;
}

/**
 * Fills a template: $1…$n = the original value's space-separated components
 * (outside parentheses), $0 = the whole original value, $$ = "$".
 * @returns {{ value: string, missing: number|null, parts: number }}
 */
export function applyTemplate(template, original) {
  const parts = P.valueComponents(original);
  let missing = null;
  const value = template.replace(/\$(\$|\d+)/g, (m, n) => {
    if (n === '$') return '$';
    const i = Number(n);
    if (i === 0) return original;
    if (i > parts.length) { if (missing === null) missing = i; return m; }
    return parts[i - 1];
  });
  return { value, missing, parts: parts.length };
}

function chainFor(entry, wrappers, original, notes, errors, at) {
  const tpl = templateFor(entry, wrappers);
  if (tpl !== undefined) {
    const r = applyTemplate(tpl, original);
    if (r.missing !== null) {
      errors.push(`${entry.where}: template "${tpl}" uses $${r.missing}, but "${entry.property}: ${original}" (${at}) has ${r.parts} component(s)`);
      return { value: original, literal: original, designed: null, vars: [], tokens: [] };
    }
    // the template must render today's value when its variables are unset
    const rendered = P.stripForeignVars(r.value, P.customPropsIn(original));
    if (rendered.unresolved.length) {
      errors.push(`${entry.where}: template for ${entry.selector} { ${entry.property} } (${at}) gives "${r.value}": var(${rendered.unresolved[0]}) has no fallback, so today's "${original}" is lost when it is unset`);
    } else if (P.normalizeValue(rendered.value) !== P.normalizeValue(original)) {
      errors.push(`${entry.where}: template for ${entry.selector} { ${entry.property} } (${at}) gives "${r.value}", which renders "${P.normalizeValue(rendered.value)}" with its variables unset, not today's "${original}"`);
    }
    return { value: r.value, literal: original, designed: null, vars: [], tokens: [] };
  }
  const { vars, tokens } = chainNames(entry, wrappers, notes);
  if (entry.template && !vars.length && !tokens.length && !entry.verbatim) {
    notes.push(`${entry.where}: ${entry.selector} { ${entry.property} } (${at}) — the template has no entry for this rule and the binding has no var/token, so it is re-declared verbatim`);
  }
  let literal = original;
  let designed = null;
  const dv = designedValueFor(entry, wrappers);
  if (dv !== undefined && P.normalizeValue(dv) !== P.normalizeValue(original)) {
    literal = dv;
    designed = original;
  }
  return { value: buildChain([...vars, ...tokens], literal), literal, designed, vars, tokens };
}

function notFound(entry, decls, index, sourcesLabel) {
  let msg = `${entry.where}: no rule in ${sourcesLabel} declares "${entry.property}" for the selector "${entry.selector}"`;
  const related = decls.filter((d) => P.propsRelated(d.decl.prop, entry.prop));
  if (related.length) {
    msg += `; it sets it only through ${[...new Set(related.map((d) => d.decl.property))].join(', ')} — bind that property instead (or re-declare by hand)`;
  } else if (decls.length) {
    msg += ` (that selector declares: ${[...new Set(decls.map((d) => d.decl.prop))].join(', ')})`;
  } else {
    const similar = [];
    for (const [key, list] of index) {
      if (key === entry.selKey || !key.includes(entry.selKey)) continue;
      if (list.some(({ rule }) => rule.declarations.some((d) => d.prop === entry.prop))) similar.push(list[0].rule.members[list[0].memberIndex].text);
    }
    msg += similar.length
      ? `; the selector text matches exactly only; selectors containing it that declare ${entry.property}: ${similar.slice(0, 6).join(' | ')}`
      : ' (the selector does not occur in the asset CSS — copy it exactly as written there)';
  }
  return msg;
}

/**
 * Runs the extraction.
 * @param {{root?: string, cssFiles?: string[], entries: object[], bindingsLabel?: string}} opts
 * @returns {{ files: Map<string, {text: string, emissions: object[]}>, errors: string[], warnings: string[], sources: object[] }}
 */
export function extractBindings({ root = DEFAULT_ROOT, cssFiles, entries, bindingsLabel = 'bindings', varsFile }) {
  const asset = P.loadAssetCss(root, cssFiles && cssFiles.length ? cssFiles : P.defaultAssetFiles(root));
  const sourcesLabel = asset.sources.map((s) => s.file).join(' + ');
  const index = P.indexBySelector(asset.rules);
  const errors = [];
  const warnings = asset.warnings.map((w) => `${w.source}:${w.line}: ${w.message}`);

  // duplicates: the same (selector, property) twice, in one file or two
  const seen = new Map();
  const unique = [];
  for (const e of entries) {
    const k = `${e.selKey}\u0000${e.prop}`;
    const prev = seen.get(k);
    if (prev) {
      errors.push(prev.file === e.file
        ? `${e.where}: duplicate binding of ${e.selector} { ${e.property} } (already in ${prev.where})`
        : `${e.where}: ${e.selector} { ${e.property} } is bound in two files: ${prev.file} (${prev.where}) and ${e.file}`);
      continue;
    }
    seen.set(k, e);
    unique.push(e);
  }

  // group by owner file + selector
  const groups = new Map();
  for (const e of unique) {
    const k = `${e.file}\u0000${e.selKey}`;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { file: e.file, selKey: e.selKey, selector: e.selector, entries: [] }));
    g.entries.push(e);
  }

  const specCache = new Map();
  const spec = (text) => {
    let s = specCache.get(text);
    if (!s) specCache.set(text, (s = P.specificity(text)));
    return s;
  };

  // pass 1: per (file, selector) the bound properties and their closure
  const analysed = [];
  const closureBySelector = new Map(); // selKey → [{ file, longhands, props, selector }]
  for (const g of groups.values()) {
    const decls = P.declarationsFor(index, g.selKey);
    const live = [];
    for (const e of g.entries) {
      if (decls.some((d) => d.decl.prop === e.prop)) live.push(e);
      else errors.push(notFound(e, decls, index, sourcesLabel));
    }
    if (!live.length) continue;

    // every property of this selector that shares a longhand with a bound one
    const bound = new Map(live.map((e) => [e.prop, e]));
    const closure = new Set(bound.keys());
    for (let grew = true; grew; ) {
      grew = false;
      for (const d of decls) {
        if (closure.has(d.decl.prop)) continue;
        if ([...closure].some((p) => P.propsRelated(p, d.decl.prop))) { closure.add(d.decl.prop); grew = true; }
      }
    }
    for (const p of [...closure].filter((x) => !bound.has(x))) {
      const via = [...closure].filter((q) => q !== p && P.propsRelated(p, q));
      warnings.push(`${g.file}: ${g.selector} — ${p} is re-declared verbatim too (it shares longhands with ${via.join(', ')}), so that the cascade between them stays as it is today`);
    }
    // a bound property that one context of this selector sets only through a
    // related property re-declared verbatim (padding-top bound, but the top
    // level writes "padding: …"): the control does not reach that context
    const contexts = new Map(); // wrapper key → { label, decls: Map(prop → last decl) }
    for (const d of decls) {
      if (!closure.has(d.decl.prop)) continue;
      const k = P.wrapperKey(d.rule.wrappers);
      let c = contexts.get(k);
      if (!c) contexts.set(k, (c = { label: P.wrapperLabel(d.rule.wrappers), decls: new Map() }));
      c.decls.set(d.decl.prop, d);
    }
    const carries = (p) => bound.has(p) && !bound.get(p).verbatim;
    for (const e of live) {
      if (e.verbatim) continue;
      for (const c of contexts.values()) {
        if (c.decls.has(e.prop)) continue;
        const via = [...c.decls.values()].filter((d) => P.propsRelated(d.decl.prop, e.prop) && !carries(d.decl.prop));
        if (!via.length) continue;
        const props = [...new Set(via.map((d) => d.decl.property))].join(', ');
        warnings.push(`${e.where}: ${g.selector} { ${e.property} } — ${c.label ? `inside "${c.label}"` : 'at top level'} this selector sets ${e.property} only through ${via.map((d) => `"${d.decl.property}: ${d.decl.value}" (${d.rule.source}:${d.decl.line})`).join(', ')}, which is re-declared verbatim, so the control does not reach it there. To carry it, bind ${props} too with a "template" holding the partial chain (e.g. "var(--x, $1) $2 var(--y, $3)"; check-bindings verifies it), or accept that it stays fixed there`);
      }
    }
    const longhands = new Set();
    for (const p of closure) for (const l of P.longhandsOf(p)) longhands.add(l);
    let list = closureBySelector.get(g.selKey);
    if (!list) closureBySelector.set(g.selKey, (list = []));
    list.push({ file: g.file, longhands, props: closure, selector: g.selector });
    analysed.push({ g, decls, bound, closure });
  }

  // pass 2: emissions and cascade-order warnings
  const emissionsByFile = new Map();
  const tokenUses = new Map(); // token name → Set of "file selector { property } (query)"
  const tokenEmissions = [];   // { tokens, literal, use } per bound emission (shared-token check)
  for (const { g, decls, bound, closure } of analysed) {
    let emissions = emissionsByFile.get(g.file);
    if (!emissions) emissionsByFile.set(g.file, (emissions = []));
    let firstOrder = Infinity;
    const notes = [];
    for (const d of decls) {
      if (!closure.has(d.decl.prop)) continue;
      firstOrder = Math.min(firstOrder, d.rule.order);
      const e = bound.get(d.decl.prop);
      const use = `${g.selector} { ${d.decl.property} }${d.rule.wrappers.length ? ` in ${P.wrapperLabel(d.rule.wrappers)}` : ''}`;
      const at = `${d.rule.source}:${d.decl.line}${d.rule.wrappers.length ? `, ${P.wrapperLabel(d.rule.wrappers)}` : ', top level'}`;
      const out = e ? chainFor(e, d.rule.wrappers, d.decl.value, notes, errors, at) : { value: d.decl.value, literal: d.decl.value, designed: null, tokens: [] };
      for (const t of out.tokens) {
        if (!tokenUses.has(t)) tokenUses.set(t, new Set());
        tokenUses.get(t).add(use);
      }
      if (out.tokens.length) tokenEmissions.push({ tokens: out.tokens, literal: out.literal, use: `${g.file} ${use}` });
      if (d.rule.declarations.filter((x) => x.prop === d.decl.prop).length > 1 && e) {
        notes.push(`${e.where}: ${g.selector} declares ${d.decl.property} more than once in one rule (${d.rule.source}:${d.rule.line}); all are re-declared, and with var() the last one always applies`);
      }
      const vendor = d.rule.members.filter((m, i) => i !== d.memberIndex && P.hasVendorPseudo(m.text) && !P.hasVendorPseudo(g.selector));
      if (vendor.length) {
        notes.push(`${g.file}: ${g.selector} — its asset rule (${d.rule.source}:${d.rule.line}) also lists ${vendor.map((m) => `"${m.text}"`).join(', ')}; an engine that does not know that pseudo drops the whole asset rule, but the re-declared rule (without it) applies there — check that engine, or bind the whole list`);
      }
      emissions.push({
        file: g.file,
        rule: d.rule,
        order: d.rule.order,
        declIndex: d.declIndex,
        memberIndex: d.memberIndex,
        member: d.rule.members[d.memberIndex].text,
        property: d.decl.property,
        value: out.value,
        designed: out.designed,
        important: d.decl.important,
        bound: !!e,
        where: e ? e.where : null,
        source: `${d.rule.source}:${d.decl.line}`,
      });
    }
    warnings.push(...new Set(notes));

    // cascade order: a later asset rule of equal specificity that sets one of
    // these properties on an element this selector may also match wins today;
    // once re-declared in a bundle (after the asset CSS) this selector wins.
    const mySpec = spec(g.selector);
    for (const rule of asset.rules) {
      if (rule.order <= firstOrder || rule.nested || rule.inKeyframes) continue;
      for (const m of rule.members) {
        if (m.key === g.selKey) continue;
        if (P.compareSpecificity(spec(m.text), mySpec) !== 0) continue;
        if (!P.mayTargetSameElement(m.text, g.selector)) continue;
        const hits = rule.declarations.filter((d) => [...closure].some((p) => P.propsRelated(p, d.prop)));
        if (!hits.length) continue;
        // re-declared in the same bundle for those properties: source order is kept there
        const same = (closureBySelector.get(m.key) || []).find((x) => x.file === g.file);
        if (same && hits.every((d) => [...same.props].some((p) => P.propsRelated(p, d.prop)))) continue;
        const elsewhere = (closureBySelector.get(m.key) || []).filter((x) => x.file !== g.file).map((x) => x.file);
        const hitProps = [...new Set(hits.map((d) => d.property))].join(', ');
        warnings.push(`${g.file}: cascade order — ${rule.source}:${rule.line} "${m.text}"${rule.wrappers.length ? ` (${P.wrapperLabel(rule.wrappers)})` : ''} sets ${hitProps} with the same specificity after "${g.selector}"; today it wins where both match, after the re-declaration "${g.selector}" would.${elsewhere.length ? ` It is bound in ${elsewhere.join(', ')}, and the order between two files' bundles is not guaranteed: move both bindings into one file.` : ` Bind "${m.text}" for ${hitProps} in ${g.file} too (with "var": [], "token": [] it is re-declared verbatim, which only keeps today's order).`} check-bindings fails on this unless run with --lenient.`);
      }
    }
  }

  for (const [selKey, list] of closureBySelector) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (list[i].file === list[j].file) continue;
        const shared = [...list[i].longhands].filter((l) => list[j].longhands.has(l));
        if (shared.length) errors.push(`${list[i].selector}: ${shared.join(', ')} would be re-declared by two files (${list[i].file} and ${list[j].file}); one owner per selector/property`);
      }
    }
    void selKey;
  }

  const mediaMaps = new Map();
  for (const e of unique) if (e.media.size && !mediaMaps.has(e.where)) mediaMaps.set(e.where, e.media);
  for (const [where, media] of mediaMaps) {
    for (const [, v] of media) if (!v.used) warnings.push(`${where}: media["${v.label}"] matched no rule of this binding`);
  }
  const templates = new Map();
  for (const e of unique) if (e.template && e.template.byKey && !templates.has(e.where)) templates.set(e.where, e.template);
  for (const [where, t] of templates) {
    for (const k of t.byKey.keys()) if (!t.used.has(k)) warnings.push(`${where}: template["${t.labels.get(k)}"] matched no rule of this binding`);
  }

  // css-variables: which token names it assigns, and where (:root or only in
  // scheme / other blocks)
  const vars = varsFile === null ? null : path.resolve(root, varsFile || path.join('snippets', 'css-variables.liquid'));
  const tokens = { file: vars ? P.toPosix(path.relative(root, vars)) : null, checked: false, missing: [], shared: [] };
  const emitted = vars && fs.existsSync(vars) ? P.liquidCustomProps(fs.readFileSync(vars, 'utf8')).names : null;
  /** 'root' (assigned on :root: active at defaults), 'scheme' (assigned only
   *  outside :root, e.g. a role token in [data-color-scheme] blocks) or
   *  'unknown' (not assigned, or no css-variables file). */
  const tokenKind = (t) => {
    if (!emitted) return 'unknown';
    const name = `--${t}`;
    const hits = emitted.filter((x) => (x.pattern ? x.pattern.test(name) : x.name === name));
    if (!hits.length) return 'unknown';
    return hits.some((x) => x.root) ? 'root' : 'scheme';
  };

  // tokens the chains read that css-variables does not emit (yet): the chain
  // then falls back to the literal there (no visual change, but no global control)
  if (emitted && tokenUses.size) {
    tokens.checked = true;
    for (const [t, uses] of [...tokenUses].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (tokenKind(t) !== 'unknown') continue;
      const name = `--${t}`;
      tokens.missing.push(name);
      const list = [...uses];
      warnings.push(`token ${name} is not assigned in ${tokens.file}: ${list.slice(0, 3).join('; ')}${list.length > 3 ? `; +${list.length - 3} more` : ''} fall back to the literal (no visual change, but the global setting does not reach ${list.length > 1 ? 'them' : 'it'}) — check the name, or set "media_token" / "media" (a narrowing query reads <token>-m by default)`);
    }
  }

  // shared tokens: one token that renders at defaults (on :root, or not emitted
  // yet) read by rules whose today-values differ. css-variables gives it ONE
  // value, so once it is emitted every rule but one changes (e.g. --t-x-size-m
  // read in both "(max-width: 989px)" and "(min-width: 750px) and (max-width:
  // 989.98px)"). Scheme-only role tokens are skipped: they apply only where a
  // merchant picks a scheme, and then a common value is the point.
  const drivers = new Map(); // token → Map(normalised literal → [{ literal, use }])
  for (const u of tokenEmissions) {
    const t = u.tokens.find((x) => tokenKind(x) !== 'scheme');
    if (!t) continue;
    if (!drivers.has(t)) drivers.set(t, new Map());
    const byValue = drivers.get(t);
    const k = P.normalizeValue(u.literal);
    if (!byValue.has(k)) byValue.set(k, []);
    byValue.get(k).push(u);
  }
  for (const [t, byValue] of [...drivers].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (byValue.size < 2) continue;
    const kind = tokenKind(t);
    const list = [...byValue.values()].map((uses) => `"${uses[0].literal}" at ${uses.map((u) => u.use).join(', ')}`);
    tokens.shared.push({ token: `--${t}`, kind, values: [...byValue.keys()] });
    warnings.push(`shared token --${t} drives rules whose values differ today: ${list.join('; ')}. ${kind === 'root' ? 'css-variables assigns it on :root, so they' : 'Once css-variables assigns it on :root they'} all render its one value and all but one change — give the variant its own token ("media": { "<query>": { "token": "--…" } } or "media_token") or none ("token": [] for that query). check-bindings fails on this unless run with --lenient`);
  }

  const labelsByFile = new Map();
  for (const e of unique) {
    if (!labelsByFile.has(e.file)) labelsByFile.set(e.file, new Set());
    labelsByFile.get(e.file).add(e.label || bindingsLabel);
  }
  const files = new Map();
  for (const file of [...emissionsByFile.keys()].sort()) {
    const emissions = emissionsByFile.get(file);
    const from = [...(labelsByFile.get(file) || [bindingsLabel])].join(', ');
    const header = `/* Generated by scripts/css/extract-bindings.mjs from ${from}: do not edit by hand, change the bindings file and re-run. */`;
    files.set(file, { text: `${header}\n${renderEmissions(emissions)}`, emissions });
  }
  return { files, errors, warnings: [...new Set(warnings)], sources: asset.sources, tokens };
}

/* --------------------------------------------------------------------------
   Rendering
   -------------------------------------------------------------------------- */

/** Rules in asset source order; within one asset rule, members with identical
 *  declarations share one selector list (members keep their original order). */
export function renderEmissions(emissions) {
  const byRule = new Map();
  for (const em of emissions) {
    let r = byRule.get(em.order);
    if (!r) byRule.set(em.order, (r = { rule: em.rule, members: new Map() }));
    let list = r.members.get(em.memberIndex);
    if (!list) r.members.set(em.memberIndex, (list = []));
    if (!list.some((x) => x.declIndex === em.declIndex)) list.push(em);
  }
  const outRules = [];
  for (const [, { rule, members }] of [...byRule].sort((a, b) => a[0] - b[0])) {
    const bySignature = new Map();
    for (const [memberIndex, list] of [...members].sort((a, b) => a[0] - b[0])) {
      list.sort((a, b) => a.declIndex - b.declIndex);
      const sig = list.map((x) => `${x.declIndex}|${x.property}|${x.value}|${x.important}|${x.designed}`).join('\n');
      let g = bySignature.get(sig);
      if (!g) bySignature.set(sig, (g = { selectors: [], decls: list }));
      g.selectors.push(rule.members[memberIndex].text);
    }
    for (const g of bySignature.values()) outRules.push({ wrappers: rule.wrappers, key: P.wrapperKey(rule.wrappers), ...g });
  }

  const lines = [];
  for (let i = 0; i < outRules.length; ) {
    let j = i;
    while (j < outRules.length && outRules[j].key === outRules[i].key) j++;
    if (lines.length) lines.push('');
    const wrappers = outRules[i].wrappers;
    let indent = '';
    for (const w of wrappers) { lines.push(`${indent}@${w.name} ${w.prelude} {`); indent += '  '; }
    outRules.slice(i, j).forEach((r, k) => {
      if (k) lines.push('');
      r.selectors.forEach((s, n) => lines.push(`${indent}${s}${n < r.selectors.length - 1 ? ',' : ' {'}`));
      for (const d of r.decls) {
        const imp = d.important ? ' !important' : '';
        const note = d.designed !== null ? ` /* designed (was: ${d.designed}) */` : '';
        lines.push(`${indent}  ${d.property}: ${d.value}${imp}${note};`);
      }
      lines.push(`${indent}}`);
    });
    for (let d = wrappers.length; d > 0; d--) { indent = indent.slice(2); lines.push(`${indent}}`); }
    i = j;
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

/* --------------------------------------------------------------------------
   Generated regions inside {% stylesheet %} (--write / --check)
   -------------------------------------------------------------------------- */

/** { found, content } of the marked region inside a file's {% stylesheet %}. */
export function readRegion(liquidText) {
  const text = P.normalizeNewlines(liquidText);
  for (const b of P.extractStylesheets(text)) {
    const s = text.indexOf(MARK_START, b.start);
    const e = text.indexOf(MARK_END, b.start);
    if (s >= 0 && s < b.end && e > s && e <= b.end) {
      return { found: true, start: s + MARK_START.length, end: e, content: text.slice(s + MARK_START.length, e) };
    }
  }
  return { found: false };
}

/** The file text with the region replaced (line endings of the file kept). */
export function writeRegion(liquidText, generated) {
  const crlf = /\r\n/.test(liquidText);
  const text = P.normalizeNewlines(liquidText);
  const r = readRegion(text);
  if (!r.found) return null;
  const out = `${text.slice(0, r.start)}\n${generated.replace(/\n+$/, '')}\n${text.slice(r.end)}`;
  return crlf ? out.replace(/\n/g, '\r\n') : out;
}

/* --------------------------------------------------------------------------
   CLI
   -------------------------------------------------------------------------- */

const USAGE = `Usage: node scripts/css/extract-bindings.mjs <bindings.json> [more bindings files…] [options]

Prints, per owning file, every asset rule that sets each bound property for
exactly the bound selector, re-declared with the var() chain. Several bindings
files are read together (duplicates across them are errors).

Options
  --out <dir>    write <dir>/<file>.css per owning file (e.g. <dir>/sections/header.liquid.css)
  --write        replace the region between ${MARK_START} and ${MARK_END}
                 inside each owning file's {% stylesheet %}
  --check        exit 1 if a file's region differs from what the bindings generate
  --root <dir>   theme root (default: the repository containing this script)
  --css <file>   asset stylesheet to read instead of assets/base.css [+ assets/base-pages.css];
                 repeatable, in cascade order
  --vars <file>  css-variables snippet used to warn about tokens it does not emit
                 (default snippets/css-variables.liquid); --no-vars skips that warning
  --quiet        do not print warnings
  -h, --help     this text

Exit: 0 ok, 1 binding errors or --check differences, 2 usage error.`;

function parseArgs(argv) {
  const opts = { css: [], positional: [] };
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
    else if (a === '--write') opts.write = true;
    else if (a === '--check') opts.check = true;
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--out' || a.startsWith('--out=')) opts.out = take('--out');
    else if (a === '--root' || a.startsWith('--root=')) opts.root = take('--root');
    else if (a === '--css' || a.startsWith('--css=')) opts.css.push(take('--css'));
    else if (a === '--vars' || a.startsWith('--vars=')) opts.vars = take('--vars');
    else if (a === '--no-vars') opts.vars = null;
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else opts.positional.push(a);
  }
  return opts;
}

export function main(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    io.stderr.write(`extract-bindings: ${err.message}\n\n${USAGE}\n`);
    return 2;
  }
  if (opts.help) { io.stdout.write(`${USAGE}\n`); return 0; }
  if (!opts.positional.length) { io.stderr.write(`extract-bindings: give a bindings file\n\n${USAGE}\n`); return 2; }
  if (opts.write && opts.check) { io.stderr.write('extract-bindings: --write and --check are exclusive\n'); return 2; }
  const root = path.resolve(opts.root || DEFAULT_ROOT);
  const entries = [];
  const formatErrors = [];
  const labels = [];
  for (const arg of opts.positional) {
    const bindingsPath = path.resolve(arg);
    if (!fs.existsSync(bindingsPath)) { io.stderr.write(`extract-bindings: ${arg} not found\n`); return 2; }
    const rel = path.relative(root, bindingsPath);
    const label = !rel.startsWith('..') && !path.isAbsolute(rel) ? P.toPosix(rel) : path.basename(bindingsPath);
    labels.push(label);
    const r = readBindingsFile(bindingsPath, label);
    entries.push(...r.entries);
    formatErrors.push(...r.errors);
  }
  const bindingsLabel = labels.join(', ');
  if (formatErrors.length) {
    for (const e of formatErrors) io.stderr.write(`error: ${e}\n`);
    return 1;
  }
  let result;
  try {
    // paths given on the command line are relative to the working directory
    result = extractBindings({
      root,
      cssFiles: opts.css.map((f) => path.resolve(f)),
      entries,
      bindingsLabel,
      varsFile: typeof opts.vars === 'string' ? path.resolve(opts.vars) : opts.vars,
    });
  } catch (err) {
    io.stderr.write(`extract-bindings: ${err.message}\n`);
    return 2;
  }
  if (!opts.quiet) for (const w of result.warnings) io.stderr.write(`warning: ${w}\n`);
  for (const e of result.errors) io.stderr.write(`error: ${e}\n`);
  if (result.errors.length) return 1;

  if (opts.write || opts.check) {
    let failed = false;
    const writes = [];
    for (const [file, { text }] of result.files) {
      const abs = path.join(root, file);
      if (!fs.existsSync(abs)) { io.stderr.write(`error: ${file}: file not found\n`); failed = true; continue; }
      const current = fs.readFileSync(abs, 'utf8');
      const region = readRegion(current);
      if (!region.found) { io.stderr.write(`error: ${file}: no ${MARK_START} … ${MARK_END} region inside its {% stylesheet %}\n`); failed = true; continue; }
      const same = region.content.trim() === text.trim();
      if (opts.check) {
        io.stdout.write(`${same ? 'up to date' : 'STALE'}: ${file}\n`);
        if (!same) failed = true;
      } else if (!same) {
        writes.push([abs, writeRegion(current, text), file]);
      } else {
        io.stdout.write(`unchanged: ${file}\n`);
      }
    }
    if (failed) return 1;
    for (const [abs, content, file] of writes) {
      fs.writeFileSync(abs, content);
      io.stdout.write(`written: ${file}\n`);
    }
    return 0;
  }

  if (opts.out) {
    const outDir = path.resolve(opts.out);
    for (const [file, { text }] of result.files) {
      const target = path.join(outDir, `${file}.css`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
      io.stdout.write(`${P.toPosix(path.relative(process.cwd(), target))}\n`);
    }
    return 0;
  }

  const many = result.files.size > 1;
  for (const [file, { text }] of result.files) {
    if (many) io.stdout.write(`/* ---- ${file} ---- */\n`);
    io.stdout.write(text);
    if (many) io.stdout.write('\n');
  }
  return 0;
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
