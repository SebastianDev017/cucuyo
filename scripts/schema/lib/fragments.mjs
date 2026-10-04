// scripts/schema/lib/fragments.mjs
//
// Expands manifests into schema JSON (EDITOR-ARCHITECTURE.md §7.1).
//
// A manifest settings array holds, in any order:
//   { "ref": "setting", …verbatim setting… }      raw setting, copied as is (minus "ref")
//   { "type": "…", … }                            same, without the marker
//   { "header": "Text" } / { "paragraph": "Text" } sidebar shorthands
//   { "ref": "<fragment>", …parameters… }          expanded from fragments/<fragment>.json
//   { "$each": …, "as": …, "do": [ … ] }           loop (templated)
//   { "$if": "<condition>", "then": …, "else": … } conditional (templated)
//
// A fragment is { "params": {…}, "lookup": {…}, "settings": [ template ] } where the
// template uses {{placeholders}} (no spaces inside the braces, so Liquid output such as
// "{{ section.settings.x }}" — always written with spaces — is never touched), the same
// $if/$each directives, nested fragment refs and "$setting" (reuse a raw setting of the
// same manifest array). README.md documents the format with worked examples.
//
// Node standard library only.

import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isPlainObject, clone, canonicalizeSchema } from './schema-io.mjs';

/** Liquid path of a setting in each visible_if scope. */
export const SCOPE_SETTINGS = { section: 'section.settings', block: 'block.settings', theme: 'settings' };

const RESERVED_FRAGMENTS = new Set(['setting']);
const CALL_KEYS = new Set(['ref', 'override', 'omit']);
const PARAM_SPEC_KEYS = new Set(['required', 'default', 'type', 'enum', 'description']);
const FRAGMENT_KEYS = new Set(['description', '$comment', 'params', 'lookup', 'settings']);
const MANIFEST_KEYS = new Set(['file', 'schema', 'kind', 'description', '$comment']);

export class FragmentError extends Error {
  constructor(reason, where) {
    super(where ? `${where}: ${reason}` : reason);
    this.name = 'FragmentError';
    this.reason = reason;
    this.where = where;
  }
}

// ----------------------------------------------------------------- loading

const RESERVED_NAMES = new Set(['scope_settings', 'kind']);

function normaliseParams(params, label) {
  const out = {};
  for (const [name, raw] of Object.entries(params)) {
    if (!/^[A-Za-z_]\w*$/.test(name)) throw new FragmentError(`invalid parameter name "${name}"`, label);
    if (RESERVED_NAMES.has(name)) throw new FragmentError(`"${name}" is set by the generator and cannot be a parameter`, label);
    const isSpec = isPlainObject(raw) && Object.keys(raw).length > 0 && Object.keys(raw).every((k) => PARAM_SPEC_KEYS.has(k));
    out[name] = isSpec ? { ...raw } : { default: raw };
  }
  return out;
}

function readFragment(dir, name) {
  const id = name.slice(0, -'.json'.length);
  const label = `fragments/${name}`;
  if (RESERVED_FRAGMENTS.has(id)) throw new FragmentError(`"${id}" is a reserved name ("ref": "setting" marks a raw setting)`, label);
  let json;
  try {
    json = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  } catch (err) {
    throw new FragmentError(`invalid JSON: ${err.message}`, label);
  }
  if (!isPlainObject(json)) throw new FragmentError('a fragment must be a JSON object', label);
  for (const key of Object.keys(json)) {
    if (!FRAGMENT_KEYS.has(key)) throw new FragmentError(`unknown key "${key}" (allowed: ${[...FRAGMENT_KEYS].join(', ')})`, label);
  }
  if (!Array.isArray(json.settings)) throw new FragmentError('"settings" (the template) must be an array', label);
  if (json.params !== undefined && !isPlainObject(json.params)) throw new FragmentError('"params" must be an object', label);
  if (json.lookup !== undefined && !isPlainObject(json.lookup)) throw new FragmentError('"lookup" must be an object', label);
  const params = normaliseParams(json.params ?? {}, label);
  for (const name of Object.keys(json.lookup ?? {})) {
    if (Object.hasOwn(params, name) || RESERVED_NAMES.has(name) || name === 'visible_if_scope') throw new FragmentError(`lookup "${name}" collides with a parameter or a generator name`, label);
  }
  return { id, file: label, description: json.description, params, lookup: json.lookup ?? {}, settings: json.settings };
}

/**
 * Map(name → fragment) of every fragments/*.json (name = file name without .json).
 * A fragment that cannot be loaded is kept as { id, file, error }: using it is an
 * expansion error, and build.mjs reports it (as a warning under --only when unused).
 */
export function loadFragments(dir) {
  const fragments = new Map();
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return fragments;
  }
  for (const name of names) {
    const id = name.slice(0, -'.json'.length);
    try {
      fragments.set(id, readFragment(dir, name));
    } catch (err) {
      fragments.set(id, { id, file: `fragments/${name}`, error: err.reason ?? err.message });
    }
  }
  return fragments;
}

/**
 * Data reachable from $each / lookup "from": currently scripts/schema/styles.json
 * (written by T1.1), exposed as "styles". Accepts an array of records or { "styles": [ … ] }.
 */
export function loadData(stylesFile) {
  const data = {};
  if (!stylesFile || !fs.existsSync(stylesFile)) return data;
  let json;
  try {
    json = JSON.parse(fs.readFileSync(stylesFile, 'utf8'));
  } catch (err) {
    throw new FragmentError(`invalid JSON: ${err.message}`, 'styles.json');
  }
  const list = Array.isArray(json) ? json : Array.isArray(json?.styles) ? json.styles : null;
  if (!list) throw new FragmentError('expected an array of style records or an object with a "styles" array', 'styles.json');
  list.forEach((s, i) => {
    if (!isPlainObject(s) || typeof s.id !== 'string') throw new FragmentError(`styles[${i}] needs a string "id"`, 'styles.json');
  });
  data.styles = list;
  return data;
}

// ------------------------------------------------------------ placeholders

const PATH = '[A-Za-z_$][\\w$]*(?:\\.[\\w$]+)*';
const WHOLE_PLACEHOLDER = new RegExp(`^\\{\\{(${PATH})\\}\\}$`);
const ANY_PLACEHOLDER = new RegExp(`\\{\\{(${PATH})\\}\\}`, 'g');

function resolvePath(ctx, dotted, env, tpl) {
  const [root, ...rest] = dotted.split('.');
  if (!Object.hasOwn(ctx, root)) {
    throw new FragmentError(
      `unknown placeholder {{${dotted}}} at ${tpl}; known names: ${Object.keys(ctx).join(', ') || 'none'}` +
        ' (Liquid output inside a template must be written with spaces, e.g. "{{ section.settings.x }}")',
      env.where,
    );
  }
  let value = ctx[root];
  for (const seg of rest) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, seg)) {
      throw new FragmentError(`placeholder {{${dotted}}} at ${tpl}: "${seg}" not found`, env.where);
    }
    value = value[seg];
  }
  return value;
}

function substitute(str, ctx, env, tpl) {
  const whole = WHOLE_PLACEHOLDER.exec(str);
  if (whole) return clone(resolvePath(ctx, whole[1], env, tpl));
  if (!str.includes('{{')) return str;
  return str.replace(ANY_PLACEHOLDER, (m, dotted) => {
    const v = resolvePath(ctx, dotted, env, tpl);
    if (v === null || v === undefined) {
      throw new FragmentError(`placeholder {{${dotted}}} is empty and cannot be interpolated into "${str}" (${tpl})`, env.where);
    }
    if (typeof v === 'object') {
      throw new FragmentError(`placeholder {{${dotted}}} is a list/object and cannot be interpolated into "${str}" (${tpl})`, env.where);
    }
    return String(v);
  });
}

// --------------------------------------------------------------- conditions

const TRUTHY = (v) => v !== undefined && v !== null && v !== false && v !== '' && !(Array.isArray(v) && v.length === 0);

function tokenize(cond, env, tpl) {
  const tokens = [];
  const re = /\s*(?:(\|\||&&|==|!=|!|\(|\))|'([^']*)'|"([^"]*)"|(-?\d+(?:\.\d+)?)(?![\w.])|([A-Za-z_$][\w$]*(?:\.[\w$]+)*))/y;
  let i = 0;
  while (i < cond.length) {
    if (/^\s*$/.test(cond.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(cond);
    if (!m) throw new FragmentError(`cannot parse condition "${cond}" at "${cond.slice(i).trim()}" (${tpl})`, env.where);
    i = re.lastIndex;
    if (m[1]) tokens.push({ t: m[1], raw: m[1] });
    else if (m[2] !== undefined || m[3] !== undefined) tokens.push({ t: 'lit', v: m[2] ?? m[3], raw: m[0].trim() });
    else if (m[4] !== undefined) tokens.push({ t: 'lit', v: Number(m[4]), raw: m[4] });
    else if (m[5] === 'has') tokens.push({ t: 'has', raw: 'has' });
    else if (m[5] === 'true' || m[5] === 'false') tokens.push({ t: 'lit', v: m[5] === 'true', raw: m[5] });
    else if (m[5] === 'null') tokens.push({ t: 'lit', v: null, raw: 'null' });
    else tokens.push({ t: 'path', v: m[5], raw: m[5] });
  }
  return tokens;
}

/**
 * Condition grammar: name | 'string' | number | true | false | null, combined with
 * ==, !=, has (list contains / object has key / substring), !, &&, || and parentheses.
 * A name must be a parameter or loop variable of the fragment; a missing nested key is
 * undefined. Falsy: undefined, null, false, "" and []. (0 is truthy.)
 */
export function evalCondition(cond, ctx, env = { where: '' }, tpl = 'condition') {
  if (typeof cond === 'boolean') return cond;
  if (typeof cond !== 'string' || !cond.trim()) throw new FragmentError(`$if needs a condition string (${tpl})`, env.where);
  const tokens = tokenize(cond, env, tpl);
  let pos = 0;
  const fail = (msg) => {
    throw new FragmentError(`condition "${cond}": ${msg} (${tpl})`, env.where);
  };
  const peek = () => tokens[pos];
  const term = () => {
    const tk = tokens[pos++];
    if (!tk) fail('unexpected end');
    if (tk.t === '(') {
      const v = or();
      if (tokens[pos++]?.t !== ')') fail('missing ")"');
      return v;
    }
    if (tk.t === 'lit') return tk.v;
    if (tk.t === 'path') {
      const [root, ...rest] = tk.v.split('.');
      if (!Object.hasOwn(ctx, root)) fail(`unknown name "${root}" (declare it in "params")`);
      let v = ctx[root];
      for (const seg of rest) v = v !== null && typeof v === 'object' ? v[seg] : undefined;
      return v;
    }
    return fail(`unexpected "${tk.raw}"`);
  };
  const cmp = () => {
    const left = term();
    const op = peek()?.t;
    if (op === '==' || op === '!=' || op === 'has') {
      pos += 1;
      const right = term();
      if (op === 'has') {
        if (Array.isArray(left)) return left.some((x) => isDeepStrictEqual(x, right));
        if (typeof left === 'string') return left.includes(String(right));
        if (isPlainObject(left)) return Object.hasOwn(left, String(right));
        return false;
      }
      const eq = left === right || (left == null && right == null);
      return op === '==' ? eq : !eq;
    }
    return left;
  };
  const not = () => {
    if (peek()?.t === '!') {
      pos += 1;
      return !TRUTHY(not());
    }
    return cmp();
  };
  const and = () => {
    let v = not();
    while (peek()?.t === '&&') {
      pos += 1;
      const r = not();
      v = TRUTHY(v) && TRUTHY(r);
    }
    return v;
  };
  const or = () => {
    let v = and();
    while (peek()?.t === '||') {
      pos += 1;
      const r = and();
      v = TRUTHY(v) || TRUTHY(r);
    }
    return v;
  };
  const result = or();
  if (pos !== tokens.length) fail(`unexpected "${tokens[pos].raw}"`);
  return TRUTHY(result);
}

// ------------------------------------------------------------- evaluation

function checkDirectiveKeys(node, allowed, env, tpl) {
  for (const key of Object.keys(node)) {
    if (!allowed.includes(key)) throw new FragmentError(`unexpected key "${key}" next to ${allowed[0]} (allowed: ${allowed.join(', ')}) at ${tpl}`, env.where);
  }
}

function listSource(src, ctx, env, tpl) {
  if (Array.isArray(src)) return src;
  if (typeof src !== 'string') throw new FragmentError(`$each / lookup "from" must name a list (${tpl})`, env.where);
  const [root, ...rest] = src.split('.');
  let value;
  if (Object.hasOwn(ctx, root)) {
    value = ctx[root];
    for (const seg of rest) value = value !== null && typeof value === 'object' ? value[seg] : undefined;
  } else if (Object.hasOwn(env.data, root) && rest.length === 0 && !root.startsWith('$')) {
    value = env.data[root];
  } else {
    const loadError = env.data.$errors?.[root];
    if (loadError) throw new FragmentError(`"${src}" is unavailable (${tpl}): ${loadError}`, env.where);
    const data = Object.keys(env.data).filter((k) => !k.startsWith('$'));
    throw new FragmentError(
      `unknown list "${src}" (${tpl}): not a parameter; data available: ${data.length ? data.join(', ') : 'none (scripts/schema/styles.json is missing)'}`,
      env.where,
    );
  }
  if (!Array.isArray(value)) throw new FragmentError(`"${src}" is not a list (${tpl})`, env.where);
  return value;
}

function eachItems(node, ctx, env, tpl) {
  let items = listSource(node.$each, ctx, env, `${tpl}.$each`);
  if (node.where !== undefined) {
    if (!isPlainObject(node.where)) throw new FragmentError(`"where" must be an object of field → value (${tpl})`, env.where);
    const where = evalValue(node.where, ctx, env, `${tpl}.where`);
    items = items.filter((item) =>
      Object.entries(where).every(([field, want]) => {
        const have = isPlainObject(item) ? item[field] : undefined;
        return Array.isArray(want) ? want.some((w) => isDeepStrictEqual(w, have)) : isDeepStrictEqual(want, have);
      }),
    );
  }
  return items;
}

function loopVar(node, env, tpl) {
  const as = node.as ?? 'item';
  if (typeof as !== 'string' || !/^[A-Za-z_]\w*$/.test(as)) throw new FragmentError(`"as" must be a name (${tpl})`, env.where);
  return as;
}

/**
 * Evaluates a template value: placeholders in strings (and object keys), $if / $each,
 * recursively. Object properties evaluating to null/undefined are dropped (optional
 * parameters) unless keepNull is set.
 */
function evalValue(node, ctx, env, tpl, keepNull = false) {
  if (typeof node === 'string') return substitute(node, ctx, env, tpl);
  if (Array.isArray(node)) {
    const out = [];
    node.forEach((el, i) => {
      const t = `${tpl}[${i}]`;
      if (isPlainObject(el) && Object.hasOwn(el, '$if')) {
        checkDirectiveKeys(el, ['$if', 'then', 'else'], env, t);
        const branch = evalCondition(el.$if, ctx, env, t) ? el.then : el.else;
        if (branch === undefined) return;
        const v = evalValue(branch, ctx, env, t, keepNull);
        if (Array.isArray(branch)) out.push(...v);
        else out.push(v);
      } else if (isPlainObject(el) && Object.hasOwn(el, '$each')) {
        out.push(...evalValue(el, ctx, env, t, keepNull));
      } else {
        out.push(evalValue(el, ctx, env, t, keepNull));
      }
    });
    return out;
  }
  if (isPlainObject(node)) {
    if (Object.hasOwn(node, '$if')) {
      checkDirectiveKeys(node, ['$if', 'then', 'else'], env, tpl);
      const branch = evalCondition(node.$if, ctx, env, tpl) ? node.then : node.else;
      return branch === undefined ? undefined : evalValue(branch, ctx, env, tpl, keepNull);
    }
    if (Object.hasOwn(node, '$each')) {
      checkDirectiveKeys(node, ['$each', 'as', 'where', 'do'], env, tpl);
      const as = loopVar(node, env, tpl);
      const out = [];
      eachItems(node, ctx, env, tpl).forEach((item, idx) => {
        const v = evalValue(node.do, { ...ctx, [as]: item, [`${as}_index`]: idx }, env, `${tpl}.do`, keepNull);
        if (Array.isArray(node.do)) out.push(...v);
        else if (v !== undefined) out.push(v);
      });
      return out;
    }
    if (Object.hasOwn(node, '$setting') || typeof node.ref === 'string') {
      throw new FragmentError(`"$setting" and "ref" are settings entries; they cannot appear inside a value (${tpl})`, env.where);
    }
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      const k = substitute(key, ctx, env, `${tpl} key`);
      if (typeof k !== 'string') throw new FragmentError(`object key placeholder must produce text (${tpl})`, env.where);
      const v = evalValue(value, ctx, env, `${tpl}.${key}`, keepNull);
      if (v === undefined || (v === null && !keepNull)) continue;
      out[k] = v;
    }
    return out;
  }
  return node;
}

// --------------------------------------------------------------- raw pool

class RawPool {
  constructor(entries) {
    this.byId = new Map();
    entries.forEach((entry, index) => {
      if (isRawEntry(entry) && typeof entry.id === 'string' && !this.byId.has(entry.id)) {
        this.byId.set(entry.id, { entry, index, takenBy: null });
      }
    });
  }

  take(id, where) {
    const rec = this.byId.get(id);
    if (!rec) return null;
    if (rec.takenBy) throw new FragmentError(`raw setting "${id}" is reused twice (first by ${rec.takenBy})`, where);
    rec.takenBy = where;
    const setting = clone(rec.entry);
    delete setting.ref;
    return setting;
  }

  isTakenIndex(index) {
    for (const rec of this.byId.values()) if (rec.index === index) return Boolean(rec.takenBy);
    return false;
  }
}

function isRawEntry(entry) {
  return isPlainObject(entry) && (entry.ref === 'setting' || (entry.ref === undefined && typeof entry.type === 'string'));
}

function recordOrigin(env, setting, tpl) {
  if (env.origins && isPlainObject(setting) && !env.origins.has(setting)) {
    env.origins.set(setting, `${env.manifestFile} ${env.where}${tpl ? ` @ ${tpl}` : ''}`);
  }
}

function pullRaw(node, ctx, env, tpl) {
  const allowedExtra = ['$setting', '$fallback', '$append_options'];
  for (const key of Object.keys(node)) {
    if (key.startsWith('$') && !allowedExtra.includes(key)) throw new FragmentError(`unknown directive "${key}" next to $setting (${tpl})`, env.where);
  }
  const id = substitute(String(node.$setting), ctx, env, `${tpl}.$setting`);
  if (typeof id !== 'string' || !id) throw new FragmentError(`$setting must name a setting id (${tpl})`, env.where);
  let setting = env.pool ? env.pool.take(id, `${env.where} @ ${tpl}`) : null;
  const pulled = Boolean(setting);
  if (!setting) {
    if (!Object.hasOwn(node, '$fallback')) {
      throw new FragmentError(
        `$setting "${id}": this settings array has no raw entry with that id ({"ref": "setting", "id": "${id}", …}) and no $fallback was given (${tpl})`,
        env.where,
      );
    }
    setting = evalValue(node.$fallback, ctx, env, `${tpl}.$fallback`);
    if (!isPlainObject(setting)) throw new FragmentError(`$fallback must be a setting object (${tpl})`, env.where);
  }
  if (node.$append_options !== undefined) {
    const extra = evalValue(node.$append_options, ctx, env, `${tpl}.$append_options`);
    if (!Array.isArray(extra)) throw new FragmentError(`$append_options must be a list of options (${tpl})`, env.where);
    if (!Array.isArray(setting.options)) throw new FragmentError(`$append_options: setting "${id}" has no options list (${tpl})`, env.where);
    for (const opt of extra) {
      if (!setting.options.some((o) => isPlainObject(o) && isPlainObject(opt) && o.value === opt.value)) setting.options.push(opt);
    }
  }
  for (const [key, raw] of Object.entries(node)) {
    if (key.startsWith('$')) continue;
    const value = evalValue(raw, ctx, env, `${tpl}.${key}`, true);
    if (value === null) delete setting[key];
    else if (value !== undefined) setting[key] = value;
  }
  recordOrigin(env, setting, tpl);
  return { setting, pulledId: pulled ? id : undefined };
}

// -------------------------------------------------------- fragment calls

function typeMatches(value, type) {
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => (t === 'array' ? Array.isArray(value) : t === 'object' ? isPlainObject(value) : typeof value === t));
}

function resolveParams(frag, call, env) {
  const params = {};
  for (const [name, spec] of Object.entries(frag.params)) if (Object.hasOwn(spec, 'default')) params[name] = clone(spec.default);
  for (const [name, value] of Object.entries(call)) {
    if (CALL_KEYS.has(name)) continue;
    if (!Object.hasOwn(frag.params, name) && name !== 'visible_if_scope' && !/^alias_\w+$/.test(name)) {
      throw new FragmentError(
        `fragment "${frag.id}" has no parameter "${name}" (parameters: ${Object.keys(frag.params).join(', ') || 'none'}; alias_* and visible_if_scope are always accepted)`,
        env.where,
      );
    }
    params[name] = clone(value);
  }
  for (const [name, spec] of Object.entries(frag.params)) {
    const value = params[name];
    if (spec.required && (value === undefined || value === null)) throw new FragmentError(`fragment "${frag.id}" needs parameter "${name}"`, env.where);
    if (value === undefined || value === null) continue;
    if (spec.type && !typeMatches(value, spec.type)) throw new FragmentError(`parameter "${name}" of "${frag.id}" must be ${spec.type} (got ${JSON.stringify(value)})`, env.where);
    if (Array.isArray(spec.enum) && !spec.enum.some((e) => isDeepStrictEqual(e, value))) {
      throw new FragmentError(`parameter "${name}" of "${frag.id}" must be one of ${JSON.stringify(spec.enum)} (got ${JSON.stringify(value)})`, env.where);
    }
  }
  return params;
}

function runLookup(name, spec, ctx, env, frag) {
  if (!isPlainObject(spec) || spec.from === undefined) throw new FragmentError(`lookup "${name}" needs { "from", "key", "value" }`, frag.file);
  const list = listSource(spec.from, ctx, env, `${frag.file} lookup.${name}`);
  const key = spec.key ?? 'id';
  const want = evalValue(spec.value, ctx, env, `${frag.file} lookup.${name}.value`);
  const hit = list.find((rec) => isPlainObject(rec) && isDeepStrictEqual(rec[key], want));
  if (hit) return clone(hit);
  if (spec.optional) return null;
  throw new FragmentError(`lookup "${name}" (${frag.file}): no record in "${spec.from}" with ${key} = ${JSON.stringify(want)}`, env.where);
}

/** Rewrites setting references inside a visible_if expression after an alias rename. */
export function renameInVisibleIf(expr, renames) {
  return expr.replace(/\b((?:section|block)\.settings|settings)\.([A-Za-z0-9_-]+)/g, (m, scope, id) =>
    renames.has(id) ? `${scope}.${renames.get(id)}` : m,
  );
}

function applyAliases(items, params, env) {
  const renames = new Map();
  for (const [name, value] of Object.entries(params)) {
    const m = /^alias_(\w+)$/.exec(name);
    if (!m || value === null || value === undefined || value === false) continue;
    if (typeof value !== 'string' || !value) throw new FragmentError(`${name} must be a setting id`, env.where);
    const from = typeof params.prefix === 'string' && params.prefix ? `${params.prefix}_${m[1]}` : m[1];
    if (from !== value) renames.set(from, value);
  }
  if (!renames.size) return;
  for (const item of items) {
    const s = item.setting;
    if (item.pulledId === undefined && typeof s.id === 'string' && renames.has(s.id)) s.id = renames.get(s.id);
    if (typeof s.visible_if === 'string') s.visible_if = renameInVisibleIf(s.visible_if, renames);
  }
}

function applyOverrides(items, call, env) {
  if (call.override !== undefined) {
    if (!isPlainObject(call.override)) throw new FragmentError('"override" must map generated setting ids to attribute patches', env.where);
    for (const [id, patch] of Object.entries(call.override)) {
      const item = items.find((it) => it.setting.id === id);
      if (!item) throw new FragmentError(`override: no generated setting "${id}" (generated: ${items.map((it) => it.setting.id).filter(Boolean).join(', ')})`, env.where);
      if (!isPlainObject(patch)) throw new FragmentError(`override.${id} must be an object`, env.where);
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete item.setting[key];
        else item.setting[key] = clone(value);
      }
    }
  }
  if (call.omit !== undefined) {
    if (!Array.isArray(call.omit)) throw new FragmentError('"omit" must be a list of generated setting ids', env.where);
    for (const id of call.omit) {
      const index = items.findIndex((it) => it.setting.id === id);
      if (index < 0) throw new FragmentError(`omit: no generated setting "${id}"`, env.where);
      if (items[index].pulledId !== undefined) throw new FragmentError(`omit: "${id}" is a kept (raw) setting; stored ids are never dropped this way`, env.where);
      items.splice(index, 1);
    }
  }
}

function expandCall(callNode, env, ctx, templated) {
  let call = callNode;
  if (templated) {
    call = {};
    for (const [key, value] of Object.entries(callNode)) {
      call[key] = key === 'ref' ? value : evalValue(value, ctx, env, `ref "${callNode.ref}".${key}`, key === 'override');
    }
  }
  const name = call.ref;
  const frag = env.fragments.get(name);
  if (!frag) throw new FragmentError(`unknown fragment "${name}" (available: ${[...env.fragments.keys()].join(', ') || 'none'})`, env.where);
  if (frag.error) throw new FragmentError(`fragment "${name}" cannot be used: ${frag.file}: ${frag.error}`, env.where);
  if (env.stack.includes(name)) throw new FragmentError(`fragment cycle: ${[...env.stack, name].join(' > ')}`, env.where);
  const params = resolveParams(frag, call, env);
  const scope = params.visible_if_scope ?? ctx.visible_if_scope ?? env.scope;
  if (!Object.hasOwn(SCOPE_SETTINGS, scope)) throw new FragmentError(`visible_if_scope must be section, block or theme (got ${JSON.stringify(scope)})`, env.where);
  params.visible_if_scope = scope;
  const fctx = { ...params, scope_settings: SCOPE_SETTINGS[scope], kind: env.kind };
  const fenv = { ...env, stack: [...env.stack, name], where: `${env.where} > ref "${name}"` };
  for (const [lname, spec] of Object.entries(frag.lookup)) fctx[lname] = runLookup(lname, spec, fctx, fenv, frag);
  const items = evalSettingsList(frag.settings, fctx, fenv, `${frag.file} settings`);
  applyAliases(items, params, fenv);
  applyOverrides(items, call, fenv);
  return items;
}

function shorthand(node, ctx, env, tpl) {
  const kind = Object.hasOwn(node, 'header') ? 'header' : 'paragraph';
  const { [kind]: content, ...rest } = node;
  const setting = ctx ? evalValue({ type: kind, content, ...rest }, ctx, env, tpl) : { type: kind, content, ...clone(rest) };
  recordOrigin(env, setting, ctx ? tpl : '');
  return { setting };
}

function evalSettingsList(list, ctx, env, tpl) {
  const nodes = Array.isArray(list) ? list : [list];
  const out = [];
  nodes.forEach((node, i) => out.push(...evalSettingsEntry(node, ctx, env, `${tpl}[${i}]`)));
  return out;
}

function evalSettingsEntry(node, ctx, env, tpl) {
  if (!isPlainObject(node)) throw new FragmentError(`settings template entries must be objects (${tpl})`, env.where);
  if (Object.hasOwn(node, '$if')) {
    checkDirectiveKeys(node, ['$if', 'then', 'else'], env, tpl);
    const yes = evalCondition(node.$if, ctx, env, tpl);
    const branch = yes ? node.then : node.else;
    return branch === undefined ? [] : evalSettingsList(branch, ctx, env, `${tpl}.${yes ? 'then' : 'else'}`);
  }
  if (Object.hasOwn(node, '$each')) {
    checkDirectiveKeys(node, ['$each', 'as', 'where', 'do'], env, tpl);
    const as = loopVar(node, env, tpl);
    const out = [];
    eachItems(node, ctx, env, tpl).forEach((item, idx) => {
      out.push(...evalSettingsList(node.do, { ...ctx, [as]: item, [`${as}_index`]: idx }, env, `${tpl}.do`));
    });
    return out;
  }
  if (Object.hasOwn(node, '$setting')) return [pullRaw(node, ctx, env, tpl)];
  if (typeof node.ref === 'string' && node.ref !== 'setting') return expandCall(node, env, ctx, true);
  if (!Object.hasOwn(node, 'type') && (Object.hasOwn(node, 'header') || Object.hasOwn(node, 'paragraph'))) return [shorthand(node, ctx, env, tpl)];
  const template = { ...node };
  delete template.ref;
  const setting = evalValue(template, ctx, env, tpl);
  recordOrigin(env, setting, tpl);
  return [{ setting }];
}

// ----------------------------------------------------------- manifests

/**
 * Expands one manifest settings array. Raw entries reused by a fragment's "$setting"
 * leave their original position (they move into the fragment's group).
 * env: { fragments, data, origins, kind, manifestFile, scope, where }
 */
export function expandSettingsArray(entries, env) {
  if (!Array.isArray(entries)) throw new FragmentError('"settings" must be an array', env.where);
  const pool = new RawPool(entries);
  const base = { fragments: new Map(), data: {}, origins: null, manifestFile: 'manifest', stack: [], ...env, pool };
  const ctx = { visible_if_scope: env.scope, scope_settings: SCOPE_SETTINGS[env.scope], kind: env.kind };
  const pieces = entries.map((entry, index) => {
    const where = `${env.where}[${index}]`;
    const local = { ...base, where };
    if (!isPlainObject(entry)) throw new FragmentError('each settings entry must be an object', where);
    if (isRawEntry(entry)) {
      const setting = clone(entry);
      delete setting.ref;
      recordOrigin(local, setting, '');
      return [{ setting, rawIndex: index }];
    }
    if (typeof entry.ref === 'string') return expandCall(entry, local, ctx, false);
    if (Object.hasOwn(entry, 'header') || Object.hasOwn(entry, 'paragraph')) return [shorthand(entry, null, local, '')];
    if (Object.hasOwn(entry, '$each') || Object.hasOwn(entry, '$if')) return evalSettingsEntry(entry, ctx, local, 'manifest');
    throw new FragmentError('unrecognised settings entry: expected "ref", "type", "header", "paragraph", "$each" or "$if"', where);
  });
  const out = [];
  for (const piece of pieces) {
    for (const item of piece) {
      if (item.rawIndex !== undefined && pool.isTakenIndex(item.rawIndex)) continue;
      out.push(item.setting);
    }
  }
  return out;
}

/** Checks the manifest envelope; returns a list of problems (strings). */
export function manifestProblems(manifest) {
  if (!isPlainObject(manifest)) return ['a manifest must be a JSON object { "file", "schema" }'];
  const problems = [];
  for (const key of Object.keys(manifest)) if (!MANIFEST_KEYS.has(key)) problems.push(`unknown key "${key}" (allowed: ${[...MANIFEST_KEYS].join(', ')})`);
  if (manifest.schema === undefined) problems.push('missing "schema"');
  if (manifest.kind !== undefined && !['section', 'block', 'theme'].includes(manifest.kind)) problems.push('"kind" must be section, block or theme');
  return problems;
}

/**
 * Expands a manifest into the schema it generates.
 * opts: { kind: 'section'|'block'|'theme', manifestFile, fragments: Map, data, origins: WeakMap }
 * Section/block → schema object in canonical key order; theme → settings_schema array.
 */
export function expandManifest(manifest, opts) {
  const env = {
    fragments: opts.fragments ?? new Map(),
    data: opts.data ?? {},
    origins: opts.origins ?? null,
    kind: opts.kind,
    manifestFile: opts.manifestFile ?? 'manifest',
    stack: [],
  };
  if (opts.kind === 'theme') {
    if (!Array.isArray(manifest.schema)) throw new FragmentError('a theme-settings manifest needs "schema": [ theme_info, { "name", "settings" }, … ]', env.manifestFile);
    return manifest.schema.map((panel, i) => {
      if (!isPlainObject(panel)) throw new FragmentError('each panel must be an object', `schema[${i}]`);
      if (panel.settings === undefined) return clone(panel);
      const out = clone(panel);
      out.settings = expandSettingsArray(panel.settings, { ...env, scope: 'theme', where: `schema[${i}].settings` });
      return out;
    });
  }
  if (!['section', 'block'].includes(opts.kind)) throw new FragmentError(`unknown manifest kind ${JSON.stringify(opts.kind)}`, env.manifestFile);
  if (!isPlainObject(manifest.schema)) throw new FragmentError('"schema" must be the schema object', env.manifestFile);
  const schema = clone(manifest.schema);
  if (manifest.schema.settings !== undefined) {
    schema.settings = expandSettingsArray(manifest.schema.settings, { ...env, scope: opts.kind === 'block' ? 'block' : 'section', where: 'schema.settings' });
  }
  if (Array.isArray(manifest.schema.blocks)) {
    schema.blocks = manifest.schema.blocks.map((block, i) => {
      if (!isPlainObject(block) || block.settings === undefined) return clone(block);
      const out = clone(block);
      out.settings = expandSettingsArray(block.settings, { ...env, scope: 'block', where: `schema.blocks[${i}].settings` });
      return out;
    });
  }
  return canonicalizeSchema(schema);
}

/**
 * The inverse used by import.mjs: a schema whose every setting becomes
 * { "ref": "setting", …verbatim… }. Expanding the result gives back the input.
 */
export function manifestSchemaFrom(schema, kind) {
  const raw = (list, where) =>
    list.map((s, i) => {
      if (!isPlainObject(s)) return clone(s);
      if (Object.hasOwn(s, 'ref')) throw new FragmentError('a setting already has a "ref" key; it cannot be imported verbatim', `${where}[${i}]`);
      return { ref: 'setting', ...clone(s) };
    });
  if (kind === 'theme') {
    if (!Array.isArray(schema)) throw new FragmentError('config/settings_schema.json must be an array');
    return schema.map((panel, i) => (isPlainObject(panel) && Array.isArray(panel.settings) ? { ...clone(panel), settings: raw(panel.settings, `[${i}].settings`) } : clone(panel)));
  }
  if (!isPlainObject(schema)) throw new FragmentError('the {% schema %} body must be an object');
  const out = canonicalizeSchema(clone(schema));
  if (Array.isArray(out.settings)) out.settings = raw(out.settings, 'settings');
  if (Array.isArray(out.blocks)) {
    out.blocks = out.blocks.map((b, i) => (isPlainObject(b) && Array.isArray(b.settings) ? { ...b, settings: raw(b.settings, `blocks[${i}].settings`) } : b));
  }
  return out;
}
