// scripts/css/lib/css-parse.mjs
//
// Tolerant CSS tokenizer/parser and the helpers shared by the two CSS binding
// tools (extract-bindings.mjs, check-bindings.mjs). Node standard library only.
//
// Understood: comments, strings (with escapes), unquoted url(…) (which may hold
// ';' or ')'-free data URIs), selector lists split on top-level commas (commas
// inside :is()/:not()/[…] or strings do not split), declarations with
// !important, conditional group at-rules (@media, @supports, @container,
// @layer, @scope, @document, @starting-style) nested to any depth, @keyframes
// and @font-face style blocks (parsed and set aside: never matched), statement
// at-rules (@import …;). CSS nesting inside a style rule is parsed so that the
// block is skipped correctly; such rules are flagged `nested` and reported.
// CRLF / CR line endings are normalised to LF first; line numbers are 1-based
// and refer to the original file.

import fs from 'node:fs';
import path from 'node:path';

/* --------------------------------------------------------------------------
   Text basics
   -------------------------------------------------------------------------- */

export function normalizeNewlines(text) {
  return String(text).replace(/\r\n?/g, '\n');
}

export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function toPosix(p) {
  return String(p).split(path.sep).join('/');
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineAt(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

export function lineNumberAt(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/* --------------------------------------------------------------------------
   Low-level scanning (work on any string)
   -------------------------------------------------------------------------- */

const WS = /\s/;

export function isIdentChar(c) {
  return c !== undefined && /[A-Za-z0-9_\-\u0080-\uFFFF]/.test(c);
}

/** { end, closed } for the string that starts at s[i] (a quote). A string
 *  that meets a newline ends there unclosed (CSS Syntax "bad string"). */
export function scanString(s, i) {
  const q = s[i];
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') { j += 2; continue; }
    if (c === q) return { end: j + 1, closed: true };
    if (c === '\n') return { end: j, closed: false };
    j++;
  }
  return { end: s.length, closed: false };
}

/** Index just after the string that starts at s[i] (a quote). */
export function endOfString(s, i) {
  return scanString(s, i).end;
}

/** Index just after the comment that starts at s[i] ('/*'). */
export function endOfComment(s, i) {
  const j = s.indexOf('*/', i + 2);
  return j < 0 ? s.length : j + 2;
}

/** True when s[i..] is an unquoted url( token (its content is raw text). */
export function isUnquotedUrlAt(s, i) {
  const c = s[i];
  if (c !== 'u' && c !== 'U') return false;
  if (s.slice(i, i + 4).toLowerCase() !== 'url(') return false;
  if (i > 0 && (isIdentChar(s[i - 1]) || s[i - 1] === '\\')) return false;
  let j = i + 4;
  while (j < s.length && WS.test(s[j])) j++;
  return s[j] !== '"' && s[j] !== "'";
}

/** Index just after the ')' that closes the unquoted url( at s[i]. */
export function endOfUrl(s, i) {
  let j = i + 4;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') { j += 2; continue; }
    if (c === ')') return j + 1;
    j++;
  }
  return s.length;
}

/** Index of the bracket closing the one at s[i] ('(' '[' or '{'), or s.length. */
export function matchBracket(s, i) {
  let depth = 0;
  let j = i;
  while (j < s.length) {
    const c = s[j];
    if (c === '"' || c === "'") { j = endOfString(s, j); continue; }
    if (c === '/' && s[j + 1] === '*') { j = endOfComment(s, j); continue; }
    if (c === '\\') { j += 2; continue; }
    if (j > i && isUnquotedUrlAt(s, j)) { j = endOfUrl(s, j); continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return j;
    }
    j++;
  }
  return s.length;
}

/** Removes comments outside strings. A comment becomes `replacement`
 *  ('' in selectors, where a comment joins tokens; ' ' in values). */
export function stripComments(s, replacement = '') {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") { const j = endOfString(s, i); out += s.slice(i, j); i = j; continue; }
    if (c === '\\') { out += s.slice(i, i + 2); i += 2; continue; }
    if (c === '/' && s[i + 1] === '*') { i = endOfComment(s, i); out += replacement; continue; }
    out += c;
    i++;
  }
  return out;
}

/** The text of every comment outside strings (without the delimiters). */
export function collectComments(s) {
  const found = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") { i = endOfString(s, i); continue; }
    if (c === '\\') { i += 2; continue; }
    if (c === '/' && s[i + 1] === '*') {
      const j = endOfComment(s, i);
      found.push(s.slice(i + 2, s.slice(j - 2, j) === '*/' ? j - 2 : j).trim());
      i = j;
      continue;
    }
    i++;
  }
  return found;
}

/** Collapses every whitespace run outside strings into one space. */
export function collapseWhitespace(s) {
  let out = '';
  let pending = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (WS.test(c)) { pending = true; i++; continue; }
    if (pending) { out += ' '; pending = false; }
    if (c === '"' || c === "'") { const j = endOfString(s, i); out += s.slice(i, j); i = j; continue; }
    if (c === '\\') { out += s.slice(i, i + 2); i += 2; continue; }
    out += c;
    i++;
  }
  if (pending) out += ' ';
  return out;
}

/** Splits on `sep` at nesting depth 0 (outside (), [], {}, strings, comments). */
export function splitTopLevel(s, sep = ',') {
  const parts = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") { i = endOfString(s, i); continue; }
    if (c === '/' && s[i + 1] === '*') { i = endOfComment(s, i); continue; }
    if (c === '\\') { i += 2; continue; }
    if (isUnquotedUrlAt(s, i)) { i = endOfUrl(s, i); continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    else if (c === sep && depth === 0) { parts.push(s.slice(start, i)); start = i + 1; }
    i++;
  }
  parts.push(s.slice(start));
  return parts;
}

/** [head, rest] split at the first top-level `sep`; rest is null when absent. */
export function splitFirstTopLevel(s, sep = ',') {
  const parts = splitTopLevel(s, sep);
  if (parts.length === 1) return [parts[0], null];
  return [parts[0], s.slice(parts[0].length + 1)];
}

/* --------------------------------------------------------------------------
   Parser
   -------------------------------------------------------------------------- */

// Conditional group rules: their content is a list of rules, and the at-rule
// becomes a "wrapper" of every rule inside it.
const GROUP_AT_RULES = new Set(['media', 'supports', 'container', 'layer', 'scope', 'document', 'starting-style']);
// At-rules whose block is a declaration list (set aside, never matched).
const DECLARATION_AT_RULES = new Set([
  'font-face', 'page', 'property', 'counter-style', 'font-palette-values', 'viewport', 'view-transition', 'position-try',
]);

const PROPERTY_NAME = /^-?[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * Parses a stylesheet.
 * @param {string} input   CSS text (CRLF allowed)
 * @param {{source?: string, lineOffset?: number}} [opts]
 *        source: label used in rules and warnings; lineOffset: added to every
 *        line number (CSS embedded in another file).
 * @returns {{rules: object[], atRules: object[], warnings: object[]}}
 *   rules: style rules in source order:
 *     { type:'style', source, line, selector, members:[{text,key}], wrappers:[{name,prelude,line}],
 *       declarations:[{property, prop, value, important, comments, line}], nested, parent, inKeyframes }
 *   Rules inside @keyframes are not in `rules` (they are not selectors).
 */
export function parseCss(input, opts = {}) {
  const source = opts.source ?? '<css>';
  const lineOffset = opts.lineOffset ?? 0;
  const text = normalizeNewlines(stripBom(String(input)));
  const n = text.length;
  const starts = lineStarts(text);
  const line = (offset) => lineAt(starts, offset) + lineOffset;
  const rules = [];
  const atRules = [];
  const warnings = [];
  const warn = (offset, message, severity = 'error') => warnings.push({ source, line: line(offset), message, severity });

  function skipComment(i) {
    const j = text.indexOf('*/', i + 2);
    if (j < 0) { warn(i, 'unterminated comment'); return n; }
    return j + 2;
  }

  function skipString(i) {
    const { end, closed } = scanString(text, i);
    if (!closed) warn(i, 'unterminated string');
    return end;
  }

  function skipWs(i) {
    while (i < n) {
      const c = text[i];
      if (WS.test(c)) { i++; continue; }
      if (c === '/' && text[i + 1] === '*') { i = skipComment(i); continue; }
      if (text.startsWith('<!--', i)) { i += 4; continue; }
      if (text.startsWith('-->', i)) { i += 3; continue; }
      break;
    }
    return i;
  }

  // Scans from i to the first character of `stops` found outside strings,
  // comments, url(), () and []. With braces = true, {} nest as well (values).
  function scan(i, stops, braces = false) {
    let depth = 0;
    let bdepth = 0;
    while (i < n) {
      const c = text[i];
      if (c === '/' && text[i + 1] === '*') { i = skipComment(i); continue; }
      if (c === '"' || c === "'") { i = skipString(i); continue; }
      if (c === '\\') { i += 2; continue; }
      if (isUnquotedUrlAt(text, i)) { i = endOfUrl(text, i); continue; }
      if (depth === 0 && bdepth === 0 && stops.includes(c)) return i;
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') { if (depth > 0) depth--; }
      else if (braces && c === '{') bdepth++;
      else if (braces && c === '}') {
        if (bdepth > 0) bdepth--;
        else if (stops.includes('}')) return i;
      }
      i++;
    }
    return n;
  }

  function skipBlock(i) {
    // i is just after '{': returns the index of the matching '}' (or n)
    let depth = 1;
    while (i < n) {
      const c = text[i];
      if (c === '/' && text[i + 1] === '*') { i = skipComment(i); continue; }
      if (c === '"' || c === "'") { i = skipString(i); continue; }
      if (c === '\\') { i += 2; continue; }
      if (isUnquotedUrlAt(text, i)) { i = endOfUrl(text, i); continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return i; }
      i++;
    }
    return n;
  }

  function cleanSelector(raw) {
    return collapseWhitespace(stripComments(raw, '')).trim();
  }

  function cleanValue(raw) {
    return collapseWhitespace(stripComments(raw, ' ')).trim();
  }

  function hasTopLevelBlock(raw) {
    let depth = 0;
    let i = 0;
    while (i < raw.length) {
      const c = raw[i];
      if (c === '"' || c === "'") { i = endOfString(raw, i); continue; }
      if (c === '/' && raw[i + 1] === '*') { i = endOfComment(raw, i); continue; }
      if (c === '\\') { i += 2; continue; }
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
      else if (c === '{' && depth === 0) return true;
      i++;
    }
    return false;
  }

  function makeMembers(selector) {
    return splitTopLevel(selector, ',')
      .map((m) => m.trim())
      .filter(Boolean)
      .map((m) => ({ text: prettySelector(m), key: canonicalSelector(m) }));
  }

  function parseList(i, wrappers, ctx) {
    for (;;) {
      i = skipWs(i);
      if (i >= n) return n;
      const c = text[i];
      if (c === '}') return i;
      if (c === ';') { i++; continue; }
      if (c === '@') i = parseAtRule(i, wrappers, ctx);
      else i = parseQualifiedRule(i, wrappers, ctx);
    }
  }

  function parseAtRule(i, wrappers, ctx) {
    const start = i;
    let j = i + 1;
    while (j < n && isIdentChar(text[j])) j++;
    const name = text.slice(i + 1, j);
    const lname = name.toLowerCase();
    const base = lname.replace(/^-(webkit|moz|ms|o)-/, '');
    const k = scan(j, '{;}');
    const prelude = cleanValue(text.slice(j, k));
    if (k >= n || text[k] === ';') {
      atRules.push({ type: 'statement', name, prelude, source, line: line(start), wrappers });
      if (k >= n && !prelude) warn(start, `@${name}: unexpected end of input`);
      return k >= n ? n : k + 1;
    }
    if (text[k] === '}') {
      warn(start, `@${name} ${prelude}: no block before '}'`);
      return k;
    }
    const blockStart = k + 1;
    if (GROUP_AT_RULES.has(base)) {
      const wrapper = { name, prelude, line: line(start) };
      const end = parseList(blockStart, [...wrappers, wrapper], ctx);
      if (end >= n) { warn(start, `unterminated @${name} ${prelude} block`); return n; }
      return end + 1;
    }
    if (base === 'keyframes') {
      const end = parseList(blockStart, [...wrappers, { name, prelude, line: line(start) }], { ...ctx, keyframes: true });
      atRules.push({ type: 'keyframes', name, prelude, source, line: line(start), wrappers });
      if (end >= n) { warn(start, `unterminated @${name} block`); return n; }
      return end + 1;
    }
    if (DECLARATION_AT_RULES.has(base)) {
      const declarations = [];
      const end = parseDeclarations(blockStart, declarations, null, wrappers, ctx);
      atRules.push({ type: 'declarations', name, prelude, declarations, source, line: line(start), wrappers });
      if (end >= n) { warn(start, `unterminated @${name} block`); return n; }
      return end + 1;
    }
    warn(start, `@${name}: unknown at-rule, block skipped`, 'warning');
    const end = skipBlock(blockStart);
    atRules.push({ type: 'unknown', name, prelude, source, line: line(start), wrappers });
    if (end >= n) { warn(start, `unterminated @${name} block`); return n; }
    return end + 1;
  }

  function parseQualifiedRule(i, wrappers, ctx, parent = null) {
    const start = i;
    const k = scan(i, '{;}');
    if (k >= n) {
      const rest = text.slice(i).trim();
      if (rest) warn(start, `unexpected end of input after "${shorten(rest)}"`);
      return n;
    }
    if (text[k] !== '{') {
      warn(start, `ignored text without a block: "${shorten(text.slice(i, k))}"`);
      return text[k] === ';' ? k + 1 : k;
    }
    const selector = cleanSelector(text.slice(i, k));
    const rule = {
      type: 'style',
      source,
      line: line(start),
      selector,
      members: makeMembers(selector),
      wrappers,
      declarations: [],
      nested: !!parent,
      parent: parent ? parent.selector : null,
      inKeyframes: !!ctx.keyframes,
    };
    if (!ctx.keyframes) rules.push(rule);
    if (parent) warn(start, `nested rule "${shorten(selector)}" inside "${shorten(parent.selector)}": CSS nesting is not supported by the binding tools (rule ignored)`, 'warning');
    const end = parseDeclarations(k + 1, rule.declarations, rule, wrappers, ctx);
    if (end >= n) { warn(start, `unterminated rule "${shorten(selector)}"`); return n; }
    return end + 1;
  }

  // Parses declarations from i (just after '{') to the matching '}'; returns
  // the index of that '}' (or n).
  function parseDeclarations(i, out, rule, wrappers, ctx) {
    for (;;) {
      i = skipWs(i);
      if (i >= n) return n;
      const c = text[i];
      if (c === '}') return i;
      if (c === ';') { i++; continue; }
      if (c === '@') {
        // a nested at-rule inside a style rule (CSS nesting): skip it whole
        const k = scan(i, '{;}');
        if (k < n && text[k] === '{') {
          warn(i, 'nested at-rule inside a style rule: not supported by the binding tools (skipped)', 'warning');
          const end = skipBlock(k + 1);
          i = end >= n ? n : end + 1;
        } else {
          warn(i, 'at-rule inside a declaration block ignored', 'warning');
          i = k < n && text[k] === ';' ? k + 1 : k;
        }
        continue;
      }
      const colon = scan(i, ':;{}');
      if (colon >= n) { warn(i, 'unexpected end of input in a declaration block'); return n; }
      const stop = text[colon];
      if (stop === '{') { i = parseQualifiedRule(i, wrappers, ctx, rule || { selector: '?' }); continue; }
      if (stop === ';' || stop === '}') {
        warn(i, `invalid declaration "${shorten(text.slice(i, colon))}" (no ':')`);
        i = stop === ';' ? colon + 1 : colon;
        continue;
      }
      const property = stripComments(text.slice(i, colon), '').trim();
      const custom = property.startsWith('--');
      const valueEnd = scan(colon + 1, ';}', true);
      const rawValue = text.slice(colon + 1, valueEnd);
      if (!custom && (!PROPERTY_NAME.test(property) || hasTopLevelBlock(rawValue))) {
        // "a:hover { … }" or similar: a nested rule, not a declaration
        const k = scan(i, '{;}');
        if (k < n && text[k] === '{') { i = parseQualifiedRule(i, wrappers, ctx, rule || { selector: '?' }); continue; }
        warn(i, `invalid declaration "${shorten(text.slice(i, k))}"`);
        i = k < n && text[k] === ';' ? k + 1 : k;
        continue;
      }
      let value = cleanValue(rawValue);
      let important = false;
      const imp = /!\s*important\s*$/i.exec(value);
      if (imp) { important = true; value = value.slice(0, imp.index).trim(); }
      out.push({
        property,
        prop: custom ? property : property.toLowerCase(),
        value,
        important,
        comments: collectComments(rawValue),
        line: line(i),
      });
      i = valueEnd < n && text[valueEnd] === ';' ? valueEnd + 1 : valueEnd;
    }
  }

  let i = parseList(0, [], {});
  while (i < n) {
    warn(i, "unmatched '}'");
    i = parseList(i + 1, [], {});
  }
  return { rules, atRules, warnings };
}

function shorten(s, max = 60) {
  const t = collapseWhitespace(String(s)).trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/* --------------------------------------------------------------------------
   Selectors, wrappers, values
   -------------------------------------------------------------------------- */

/**
 * Matching key of one complex selector: comments removed, whitespace
 * collapsed, no spaces around > + ~ , or inside ( ) [ ] edges, attribute
 * values quoted with double quotes. Two selectors with equal keys are the
 * same text for the binding tools (no semantic matching beyond that).
 */
export function canonicalSelector(sel) {
  const s = collapseWhitespace(stripComments(String(sel), '')).trim();
  let out = '';
  let bracket = 0;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") { const j = endOfString(s, i); out += s.slice(i, j); i = j; continue; }
    if (c === '\\') { out += s.slice(i, i + 2); i += 2; continue; }
    if (c === ' ') {
      const prev = out[out.length - 1];
      const next = s[i + 1];
      if (bracket > 0 || prev === undefined || '>+~,(['.includes(prev) || next === undefined || '>+~,)]'.includes(next)) { i++; continue; }
      out += ' ';
      i++;
      continue;
    }
    if (c === '[') bracket++;
    else if (c === ']') bracket = Math.max(0, bracket - 1);
    out += c;
    i++;
  }
  return out.replace(
    /\[([A-Za-z0-9_\-|*]+)([~|^$*]?=)(?:'([^'"\\]*)'|"([^'"\\]*)"|([A-Za-z0-9_\-]+))([iIsS])?\]/g,
    (m, name, op, v1, v2, v3, flag) => `[${name}${op}"${v1 ?? v2 ?? v3}"${flag ? flag.toLowerCase() : ''}]`,
  );
}

/** Selector text for output: comments removed, whitespace collapsed, and
 *  tidy parentheses ("(a, b)"); combinator spacing is kept as written. */
export function prettySelector(sel) {
  const s = collapseWhitespace(stripComments(String(sel), '')).trim();
  let out = '';
  let depth = 0;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") { const j = endOfString(s, i); out += s.slice(i, j); i = j; continue; }
    if (c === '\\') { out += s.slice(i, i + 2); i += 2; continue; }
    if (c === '(') { depth++; out += c; i++; while (s[i] === ' ') i++; continue; }
    if (c === ')') { depth = Math.max(0, depth - 1); out = out.replace(/ +$/, '') + c; i++; continue; }
    if (c === ',' && depth > 0) { out = out.replace(/ +$/, '') + ', '; i++; while (s[i] === ' ') i++; continue; }
    out += c;
    i++;
  }
  return out;
}

/** Comparison key of an at-rule prelude (case and spacing insensitive for @media). */
export function canonicalPrelude(prelude, name = 'media') {
  let s = collapseWhitespace(stripComments(String(prelude), ' ')).trim();
  if (String(name).toLowerCase() === 'media') s = s.toLowerCase();
  return s
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s*:\s*/g, ':')
    .replace(/\s*,\s*/g, ',');
}

/** Comparison key of a wrapper chain ('' = top level). */
export function wrapperKey(wrappers) {
  return (wrappers || []).map((w) => `@${w.name.toLowerCase()} ${canonicalPrelude(w.prelude, w.name)}`).join(' >> ');
}

/** Human label of a wrapper chain ('' = top level). */
export function wrapperLabel(wrappers) {
  return (wrappers || []).map((w) => `@${w.name} ${w.prelude}`).join(' { ');
}

/** Value comparison key: comments removed, whitespace collapsed, no spaces
 *  inside ( ) edges, ", " between arguments. Case is kept. */
export function normalizeValue(v) {
  const s = collapseWhitespace(stripComments(String(v), ' ')).trim();
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") { const j = endOfString(s, i); out += s.slice(i, j); i = j; continue; }
    if (c === '\\') { out += s.slice(i, i + 2); i += 2; continue; }
    if (c === '(') { out += c; i++; while (s[i] === ' ') i++; continue; }
    if (c === ')') { out = out.replace(/ +$/, '') + c; i++; continue; }
    if (c === ',') { out = out.replace(/ +$/, '') + ', '; i++; while (s[i] === ' ') i++; continue; }
    out += c;
    i++;
  }
  return out.trim();
}

/** { name, fallback } when the whole value is one var() call, else null.
 *  fallback is null when absent ('' for an empty fallback "var(--x,)"). */
export function parseVarCall(v) {
  const s = String(v).trim();
  if (!/^var\(/i.test(s)) return null;
  const close = matchBracket(s, 3);
  if (close !== s.length - 1) return null;
  const inner = s.slice(4, close);
  const [head, rest] = splitFirstTopLevel(inner, ',');
  return { name: head.trim(), fallback: rest === null ? null : rest.trim() };
}

/** The var() chain of a value: { vars: [outer … inner], innermost } where
 *  innermost is the first fallback that is not a lone var() (null when the
 *  innermost var() has no fallback). */
export function varChain(v) {
  const vars = [];
  let cur = String(v).trim();
  for (;;) {
    const call = parseVarCall(cur);
    if (!call) return { vars, innermost: cur };
    vars.push(call.name);
    if (call.fallback === null) return { vars, innermost: null };
    cur = call.fallback;
  }
}

/** Custom property names referenced through var() in a value. */
export function customPropsIn(v) {
  const names = new Set();
  for (const m of String(v).matchAll(/var\(\s*(--[A-Za-z0-9_\-\u0080-\uFFFF]+)/gi)) names.add(m[1]);
  return names;
}

/**
 * Removes every binding layer: each var(--x, F) whose --x is not in `keep`
 * is replaced by F (recursively). var(--x) without a fallback and not in
 * `keep` cannot be removed and is listed in `unresolved`.
 * With keep = the custom properties the asset value itself uses, the result
 * is what the bundle value renders when no binding variable is set; it must
 * equal the asset value (this generalises "innermost fallback", and also
 * covers asset values that are var() expressions and partial bindings such
 * as calc(var(--x, 1.9em) * 0.5265)).
 */
export function stripForeignVars(value, keep = new Set()) {
  const unresolved = [];
  const walk = (s) => {
    let out = '';
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '"' || c === "'") { const j = endOfString(s, i); out += s.slice(i, j); i = j; continue; }
      if (c === '/' && s[i + 1] === '*') { i = endOfComment(s, i); out += ' '; continue; }
      if (c === '\\') { out += s.slice(i, i + 2); i += 2; continue; }
      if ((c === 'v' || c === 'V') && /^var\(/i.test(s.slice(i, i + 4)) && !isIdentChar(s[i - 1])) {
        const close = matchBracket(s, i + 3);
        const inner = s.slice(i + 4, close);
        const [head, rest] = splitFirstTopLevel(inner, ',');
        const name = head.trim();
        if (!keep.has(name)) {
          if (rest === null) { unresolved.push(name); out += s.slice(i, close + 1); }
          else out += walk(rest).trim();
        } else {
          out += rest === null ? `var(${name})` : `var(${name}, ${walk(rest).trim()})`;
        }
        i = close + 1;
        continue;
      }
      out += c;
      i++;
    }
    return out;
  };
  return { value: walk(String(value)), unresolved };
}

/* --------------------------------------------------------------------------
   Specificity and the subject compound (for cascade-order warnings)
   -------------------------------------------------------------------------- */

function skipIdent(s, i) {
  while (i < s.length) {
    if (s[i] === '\\') { i += 2; continue; }
    if (!isIdentChar(s[i])) break;
    i++;
  }
  return i;
}

function maxSpecificity(list) {
  let best = [0, 0, 0];
  for (const sel of list) {
    const sp = specificity(sel);
    if (compareSpecificity(sp, best) > 0) best = sp;
  }
  return best;
}

/** Specificity [ids, classes/attributes/pseudo-classes, types/pseudo-elements]
 *  of one complex selector (Selectors Level 4 rules for :is/:not/:has/:where). */
export function specificity(selector) {
  const s = canonicalSelector(selector);
  let a = 0;
  let b = 0;
  let c = 0;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"' || ch === "'") { i = endOfString(s, i); continue; }
    if (ch === '\\') { i += 2; continue; }
    if (ch === '#') { a++; i = skipIdent(s, i + 1); continue; }
    if (ch === '.') { b++; i = skipIdent(s, i + 1); continue; }
    if (ch === '[') { b++; i = matchBracket(s, i) + 1; continue; }
    if (ch === ':') {
      if (s[i + 1] === ':') {
        c++;
        let j = skipIdent(s, i + 2);
        if (s[j] === '(') j = matchBracket(s, j) + 1;
        i = j;
        continue;
      }
      const j = skipIdent(s, i + 1);
      const name = s.slice(i + 1, j).toLowerCase();
      if (['before', 'after', 'first-line', 'first-letter'].includes(name)) { c++; i = j; continue; }
      if (s[j] === '(') {
        const close = matchBracket(s, j);
        const arg = s.slice(j + 1, close);
        if (name === 'where') {
          // zero
        } else if (['is', 'not', 'has', 'matches', '-webkit-any', '-moz-any'].includes(name)) {
          const m = maxSpecificity(splitTopLevel(arg, ','));
          a += m[0]; b += m[1]; c += m[2];
        } else if (name === 'nth-child' || name === 'nth-last-child') {
          b++;
          const of = /\sof\s(.+)$/i.exec(arg);
          if (of) { const m = maxSpecificity(splitTopLevel(of[1], ',')); a += m[0]; b += m[1]; c += m[2]; }
        } else {
          b++;
        }
        i = close + 1;
        continue;
      }
      b++;
      i = j;
      continue;
    }
    if (ch === '*') { i++; continue; }
    if (isIdentChar(ch) && !/[0-9]/.test(ch)) {
      const j = skipIdent(s, i);
      if (s[j] === '|') { i = j + 1; continue; } // namespace prefix
      c++;
      i = j;
      continue;
    }
    i++;
  }
  return [a, b, c];
}

export function compareSpecificity(x, y) {
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** Splits a selector into its compounds (combinators dropped). */
export function compounds(selector) {
  const s = canonicalSelector(selector);
  const parts = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"' || ch === "'") { i = endOfString(s, i); continue; }
    if (ch === '\\') { i += 2; continue; }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === ' ' || ch === '>' || ch === '+' || ch === '~')) {
      if (i > start) parts.push(s.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  if (s.length > start) parts.push(s.slice(start));
  return parts;
}

/** Classes, ids, attribute names and type of the subject (last) compound,
 *  ignoring what sits inside pseudo-class arguments. */
export function subjectFeatures(selector) {
  const list = compounds(selector);
  const comp = list[list.length - 1] || '';
  const f = { classes: new Set(), ids: new Set(), attrs: new Set(), type: null };
  let i = 0;
  while (i < comp.length) {
    const ch = comp[i];
    if (ch === '"' || ch === "'") { i = endOfString(comp, i); continue; }
    if (ch === '\\') { i += 2; continue; }
    if (ch === '.' || ch === '#') {
      const j = skipIdent(comp, i + 1);
      (ch === '.' ? f.classes : f.ids).add(comp.slice(i + 1, j));
      i = j;
      continue;
    }
    if (ch === '[') {
      const close = matchBracket(comp, i);
      const m = /^\[\s*([A-Za-z0-9_\-|*]+)/.exec(comp.slice(i, close + 1));
      if (m) f.attrs.add(m[1]);
      i = close + 1;
      continue;
    }
    if (ch === ':') {
      let j = skipIdent(comp, comp[i + 1] === ':' ? i + 2 : i + 1);
      if (comp[j] === '(') j = matchBracket(comp, j) + 1;
      i = j;
      continue;
    }
    if (i === 0 && isIdentChar(ch)) { const j = skipIdent(comp, i); f.type = comp.slice(i, j).toLowerCase(); i = j; continue; }
    i++;
  }
  return f;
}

/** True when two class names are the same or one is a BEM modifier of the
 *  other ("site-header__link" / "site-header__link--sub"): elements carry both. */
function classesRelated(x, y) {
  return x === y || x.startsWith(`${y}--`) || y.startsWith(`${x}--`);
}

/** True when the two selectors' subject compounds share a class (or a BEM
 *  modifier of it), id, attribute name or type: they might style the same
 *  element. A heuristic for warnings, never for pass/fail decisions. */
export function mayTargetSameElement(selA, selB) {
  const a = subjectFeatures(selA);
  const b = subjectFeatures(selB);
  for (const x of a.classes) for (const y of b.classes) if (classesRelated(x, y)) return true;
  for (const x of a.ids) if (b.ids.has(x)) return true;
  for (const x of a.attrs) if (b.attrs.has(x)) return true;
  if (a.type && b.type && a.type === b.type && !a.classes.size && !b.classes.size) return true;
  return false;
}

/** True when the selector's subject is the root element and its specificity
 *  is at least :root's (0,1,0): ':root', 'html:root', 'html.js', ':root.x'… */
export function isRootSelector(selector) {
  const list = compounds(selector);
  if (list.length !== 1) return false;
  const comp = list[0];
  if (/:root\b/i.test(comp)) return true;
  if (/^html(?![A-Za-z0-9_-])/i.test(comp)) {
    const sp = specificity(comp);
    return sp[0] > 0 || sp[1] > 0;
  }
  return false;
}

/* --------------------------------------------------------------------------
   Shorthand / longhand relations (horizontal-tb, ltr for logical properties)
   -------------------------------------------------------------------------- */

const SIDES = ['top', 'right', 'bottom', 'left'];
const box = (p, suffix = '') => SIDES.map((s) => `${p}-${s}${suffix}`);
const BORDER_LONGHANDS = [...box('border', '-width'), ...box('border', '-style'), ...box('border', '-color')];
const BORDER_IMAGE = ['border-image-source', 'border-image-slice', 'border-image-width', 'border-image-outset', 'border-image-repeat'];
const FONT_VARIANT = [
  'font-variant-caps', 'font-variant-ligatures', 'font-variant-numeric', 'font-variant-east-asian',
  'font-variant-alternates', 'font-variant-position', 'font-variant-emoji',
];

const SHORTHANDS = (() => {
  const t = {};
  for (const p of ['margin', 'padding', 'scroll-margin', 'scroll-padding']) {
    t[p] = box(p);
    t[`${p}-block`] = [`${p}-top`, `${p}-bottom`];
    t[`${p}-inline`] = [`${p}-left`, `${p}-right`];
    t[`${p}-block-start`] = [`${p}-top`];
    t[`${p}-block-end`] = [`${p}-bottom`];
    t[`${p}-inline-start`] = [`${p}-left`];
    t[`${p}-inline-end`] = [`${p}-right`];
  }
  t.inset = [...SIDES];
  t['inset-block'] = ['top', 'bottom'];
  t['inset-inline'] = ['left', 'right'];
  t['inset-block-start'] = ['top'];
  t['inset-block-end'] = ['bottom'];
  t['inset-inline-start'] = ['left'];
  t['inset-inline-end'] = ['right'];
  t.border = [...BORDER_LONGHANDS, ...BORDER_IMAGE];
  t['border-width'] = box('border', '-width');
  t['border-style'] = box('border', '-style');
  t['border-color'] = box('border', '-color');
  for (const s of SIDES) t[`border-${s}`] = [`border-${s}-width`, `border-${s}-style`, `border-${s}-color`];
  const logical = { 'block-start': ['top'], 'block-end': ['bottom'], 'inline-start': ['left'], 'inline-end': ['right'], block: ['top', 'bottom'], inline: ['left', 'right'] };
  for (const [k, sides] of Object.entries(logical)) {
    t[`border-${k}`] = sides.flatMap((s) => [`border-${s}-width`, `border-${s}-style`, `border-${s}-color`]);
    for (const part of ['width', 'style', 'color']) t[`border-${k}-${part}`] = sides.map((s) => `border-${s}-${part}`);
  }
  t['border-radius'] = ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'];
  t['border-start-start-radius'] = ['border-top-left-radius'];
  t['border-start-end-radius'] = ['border-top-right-radius'];
  t['border-end-start-radius'] = ['border-bottom-left-radius'];
  t['border-end-end-radius'] = ['border-bottom-right-radius'];
  t['border-image'] = BORDER_IMAGE;
  t.outline = ['outline-width', 'outline-style', 'outline-color'];
  t.background = [
    'background-color', 'background-image', 'background-position-x', 'background-position-y', 'background-size',
    'background-repeat', 'background-attachment', 'background-origin', 'background-clip',
  ];
  t['background-position'] = ['background-position-x', 'background-position-y'];
  t.font = [
    'font-style', ...FONT_VARIANT, 'font-weight', 'font-stretch', 'font-size', 'line-height', 'font-family',
    'font-size-adjust', 'font-kerning', 'font-language-override', 'font-optical-sizing',
  ];
  t['font-variant'] = FONT_VARIANT;
  t['font-width'] = ['font-stretch'];
  t['font-synthesis'] = ['font-synthesis-weight', 'font-synthesis-style', 'font-synthesis-small-caps', 'font-synthesis-position'];
  t['text-decoration'] = ['text-decoration-line', 'text-decoration-style', 'text-decoration-color', 'text-decoration-thickness'];
  t['text-emphasis'] = ['text-emphasis-style', 'text-emphasis-color'];
  t['list-style'] = ['list-style-type', 'list-style-position', 'list-style-image'];
  t.flex = ['flex-grow', 'flex-shrink', 'flex-basis'];
  t['flex-flow'] = ['flex-direction', 'flex-wrap'];
  t.gap = ['row-gap', 'column-gap'];
  t['grid-gap'] = ['row-gap', 'column-gap'];
  t['grid-row-gap'] = ['row-gap'];
  t['grid-column-gap'] = ['column-gap'];
  t.grid = ['grid-template-rows', 'grid-template-columns', 'grid-template-areas', 'grid-auto-rows', 'grid-auto-columns', 'grid-auto-flow'];
  t['grid-template'] = ['grid-template-rows', 'grid-template-columns', 'grid-template-areas'];
  t['grid-area'] = ['grid-row-start', 'grid-column-start', 'grid-row-end', 'grid-column-end'];
  t['grid-row'] = ['grid-row-start', 'grid-row-end'];
  t['grid-column'] = ['grid-column-start', 'grid-column-end'];
  t['place-items'] = ['align-items', 'justify-items'];
  t['place-content'] = ['align-content', 'justify-content'];
  t['place-self'] = ['align-self', 'justify-self'];
  t.overflow = ['overflow-x', 'overflow-y'];
  t['overflow-block'] = ['overflow-y'];
  t['overflow-inline'] = ['overflow-x'];
  t['overscroll-behavior'] = ['overscroll-behavior-x', 'overscroll-behavior-y'];
  t.transition = ['transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay', 'transition-behavior'];
  t.animation = [
    'animation-name', 'animation-duration', 'animation-timing-function', 'animation-delay', 'animation-iteration-count',
    'animation-direction', 'animation-fill-mode', 'animation-play-state', 'animation-timeline',
  ];
  t.columns = ['column-width', 'column-count'];
  t['column-rule'] = ['column-rule-width', 'column-rule-style', 'column-rule-color'];
  t.mask = ['mask-image', 'mask-mode', 'mask-position-x', 'mask-position-y', 'mask-size', 'mask-repeat', 'mask-origin', 'mask-clip', 'mask-composite'];
  t['mask-position'] = ['mask-position-x', 'mask-position-y'];
  t.container = ['container-name', 'container-type'];
  t['white-space'] = ['white-space-collapse', 'text-wrap-mode'];
  t['text-wrap'] = ['text-wrap-mode', 'text-wrap-style'];
  t.offset = ['offset-position', 'offset-path', 'offset-distance', 'offset-rotate', 'offset-anchor'];
  t['contain-intrinsic-size'] = ['contain-intrinsic-width', 'contain-intrinsic-height'];
  t['block-size'] = ['height'];
  t['inline-size'] = ['width'];
  t['min-block-size'] = ['min-height'];
  t['min-inline-size'] = ['min-width'];
  t['max-block-size'] = ['max-height'];
  t['max-inline-size'] = ['max-width'];
  t['word-wrap'] = ['overflow-wrap'];
  t['page-break-before'] = ['break-before'];
  t['page-break-after'] = ['break-after'];
  t['page-break-inside'] = ['break-inside'];
  return t;
})();

/** The longhands a property sets (vendor prefixes dropped, logical mapped to
 *  physical). Custom properties are only themselves; `all` is {'*'}. */
export function longhandsOf(property) {
  const p = String(property);
  if (p.startsWith('--')) return new Set([p]);
  const base = p.toLowerCase().replace(/^-(webkit|moz|ms|o)-/, '');
  if (base === 'all') return new Set(['*']);
  const out = new Set();
  const visit = (q) => {
    const sub = SHORTHANDS[q];
    if (!sub) { out.add(q); return; }
    for (const x of sub) visit(x);
  };
  visit(base);
  return out;
}

/** True when the two properties set at least one common longhand. */
export function propsRelated(p, q) {
  if (p === q) return true;
  if (String(p).startsWith('--') || String(q).startsWith('--')) return false;
  const a = longhandsOf(p);
  const b = longhandsOf(q);
  const exempt = (s) => s.has('direction') || s.has('unicode-bidi');
  if (a.has('*')) return !exempt(b);
  if (b.has('*')) return !exempt(a);
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/* --------------------------------------------------------------------------
   Liquid: {% stylesheet %} blocks
   -------------------------------------------------------------------------- */

const RAW_LIQUID_BLOCKS = ['comment', 'doc', 'raw', 'schema', 'javascript'];

/** Blanks (spaces, newlines kept) Liquid regions whose content is not
 *  rendered markup: {% comment %}, {% doc %}, {% raw %}, {% schema %},
 *  {% javascript %} blocks and inline {% # … %} comments. */
export function blankLiquidRegions(text) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  let out = '';
  let i = 0;
  const open = /\{%-?\s*(#|[A-Za-z_]+)/g;
  for (;;) {
    open.lastIndex = i;
    const m = open.exec(text);
    if (!m) { out += text.slice(i); break; }
    out += text.slice(i, m.index);
    const tagEnd = text.indexOf('%}', m.index + 2);
    if (tagEnd < 0) { out += text.slice(m.index); break; }
    const name = m[1].toLowerCase();
    if (name === '#') {
      out += blank(text.slice(m.index, tagEnd + 2));
      i = tagEnd + 2;
      continue;
    }
    if (RAW_LIQUID_BLOCKS.includes(name)) {
      const close = new RegExp(`\\{%-?\\s*end${name}\\s*-?%\\}`, 'g');
      close.lastIndex = tagEnd + 2;
      const e = close.exec(text);
      const end = e ? e.index + e[0].length : text.length;
      out += blank(text.slice(m.index, end));
      i = end;
      continue;
    }
    out += text.slice(m.index, tagEnd + 2);
    i = tagEnd + 2;
  }
  return out;
}

/** Every {% stylesheet %} block of a Liquid file:
 *  [{ css, line (file line where the CSS text starts), closed }]. */
export function extractStylesheets(liquid) {
  const text = normalizeNewlines(stripBom(String(liquid)));
  const blanked = blankLiquidRegions(text);
  const openRe = /\{%-?\s*stylesheet\s*-?%\}/g;
  const blocks = [];
  let m;
  while ((m = openRe.exec(blanked))) {
    const start = m.index + m[0].length;
    const closeRe = /\{%-?\s*endstylesheet\s*-?%\}/g;
    closeRe.lastIndex = start;
    const e = closeRe.exec(blanked);
    const end = e ? e.index : text.length;
    blocks.push({ css: text.slice(start, end), line: lineNumberAt(text, start), closed: !!e, start, end });
    openRe.lastIndex = e ? e.index + e[0].length : text.length;
  }
  return blocks;
}

/* --------------------------------------------------------------------------
   Asset CSS
   -------------------------------------------------------------------------- */

/** assets/base.css, plus assets/base-pages.css when it exists (cascade order). */
export function defaultAssetFiles(root) {
  const files = ['assets/base.css'];
  if (fs.existsSync(path.join(root, 'assets', 'base-pages.css'))) files.push('assets/base-pages.css');
  return files;
}

function labelFor(root, file) {
  const abs = path.resolve(root, file);
  const rel = path.relative(root, abs);
  return !rel.startsWith('..') && !path.isAbsolute(rel) ? toPosix(rel) : toPosix(file);
}

/**
 * Reads and parses the asset stylesheets in cascade order (concatenation).
 * Each rule gets `order`, its index in the concatenated sequence.
 */
export function loadAssetCss(root, files = defaultAssetFiles(root)) {
  const sources = [];
  const rules = [];
  const atRules = [];
  const warnings = [];
  let order = 0;
  for (const file of files) {
    const abs = path.resolve(root, file);
    const raw = fs.readFileSync(abs, 'utf8');
    const label = labelFor(root, file);
    const parsed = parseCss(raw, { source: label });
    for (const r of parsed.rules) { r.order = order++; rules.push(r); }
    atRules.push(...parsed.atRules);
    warnings.push(...parsed.warnings);
    sources.push({
      file: label,
      bytes: Buffer.byteLength(raw),
      lines: normalizeNewlines(raw).split('\n').length - (raw.endsWith('\n') ? 1 : 0),
      crlf: /\r\n/.test(raw),
      rules: parsed.rules.length,
    });
  }
  return { sources, rules, atRules, warnings };
}

/** Map canonical selector → [{ rule, memberIndex }] in source order (nested rules excluded). */
export function indexBySelector(rules) {
  const map = new Map();
  for (const rule of rules) {
    if (rule.nested || rule.inKeyframes) continue;
    rule.members.forEach((m, memberIndex) => {
      let list = map.get(m.key);
      if (!list) map.set(m.key, (list = []));
      list.push({ rule, memberIndex });
    });
  }
  return map;
}

/** Every declaration made for one selector (by canonical key), in source
 *  order: [{ rule, decl, declIndex, memberIndex }]. */
export function declarationsFor(index, key) {
  const out = [];
  for (const { rule, memberIndex } of index.get(key) || []) {
    rule.declarations.forEach((decl, declIndex) => out.push({ rule, decl, declIndex, memberIndex }));
  }
  return out;
}
