// scripts/schema/lib/validate.mjs
//
// The generator's validators (EDITOR-ARCHITECTURE.md §7.3). Every issue is
//   { level: 'error'|'warning', rule, file, path, message, origin? }
// where `path` points into the generated schema (e.g. "blocks[0].settings[4].default")
// and `origin` (when known) is the manifest entry / fragment template it came from.
//
// Rules (README.md lists them with their sources):
//   json · name-length · range · select-default · visible-if · unique-ids · header-group ·
//   presets · theme-blocks · private-blocks · richtext · soft-limits            (§7.3)
//   setting-shape · block-target · static-blocks · schema-keys · color-palette ·
//   color-default                                         (theme check / platform extras)
//
// validateSettingValue() and checkRichtext() are exported for the template-compat
// check (check-templates.mjs, T3.2). Node standard library only.

import { isPlainObject, findStaticBlockCalls } from './schema-io.mjs';

// Attributes per setting type, from Shopify's theme JSON schemas (theme-liquid-docs
// setting.json, as used by theme check's ValidSchema: additionalProperties false).
const T = (required, optional) => ({ required: new Set(required), allowed: new Set([...required, ...optional]) });
const INPUT = ['type', 'id', 'label'];
export const SETTING_TYPES = {
  header: T(['type', 'content'], ['info', 'visible_if']),
  paragraph: T(['type', 'content'], ['visible_if']),
  article: T(INPUT, ['default', 'info']),
  article_list: T(INPUT, ['default', 'info', 'limit']),
  blog: T(INPUT, ['default', 'info']),
  checkbox: T(INPUT, ['default', 'info', 'visible_if']),
  collection: T(INPUT, ['default', 'info']),
  collection_list: T(INPUT, ['default', 'info', 'limit']),
  color: T(INPUT, ['default', 'info', 'alpha', 'placeholder', 'visible_if']),
  color_background: T(INPUT, ['default', 'info', 'visible_if']),
  color_palette: T(['type', 'id', 'default'], []),
  color_scheme: T(INPUT, ['default', 'info', 'visible_if']),
  color_scheme_group: T(['type', 'id', 'definition', 'role'], ['info']),
  font_picker: T([...INPUT, 'default'], ['info', 'visible_if']),
  html: T(INPUT, ['default', 'info', 'placeholder', 'visible_if']),
  image_picker: T(INPUT, ['default', 'info', 'visible_if']),
  inline_richtext: T(INPUT, ['default', 'info', 'visible_if']),
  link_list: T(INPUT, ['default', 'info', 'visible_if']),
  liquid: T(INPUT, ['default', 'info', 'visible_if']),
  metaobject: T([...INPUT, 'metaobject_type'], ['default', 'info']),
  metaobject_list: T([...INPUT, 'metaobject_type'], ['default', 'info', 'limit']),
  number: T(INPUT, ['default', 'info', 'placeholder', 'visible_if', 'min', 'max', 'icon', 'options']),
  page: T(INPUT, ['default', 'info']),
  product: T(INPUT, ['default', 'info']),
  product_list: T(INPUT, ['default', 'info', 'limit']),
  radio: T([...INPUT, 'options'], ['default', 'info', 'visible_if']),
  range: T([...INPUT, 'min', 'max', 'default'], ['step', 'unit', 'info', 'visible_if']),
  richtext: T(INPUT, ['default', 'info', 'visible_if']),
  select: T([...INPUT, 'options'], ['default', 'info', 'visible_if']),
  text: T(INPUT, ['default', 'info', 'placeholder', 'visible_if']),
  text_alignment: T(INPUT, ['default', 'info', 'visible_if']),
  textarea: T(INPUT, ['default', 'info', 'placeholder', 'visible_if']),
  url: T(INPUT, ['default', 'info', 'visible_if']),
  video: T(INPUT, ['default', 'info', 'visible_if']),
  video_url: T([...INPUT, 'accept'], ['default', 'info', 'placeholder', 'visible_if']),
};

const SECTION_KEYS = new Set(['name', 'tag', 'class', 'limit', 'max_blocks', 'settings', 'blocks', 'presets', 'default', 'locales', 'enabled_on', 'disabled_on']);
const BLOCK_KEYS = new Set(['name', 'settings', 'blocks', 'presets', 'tag', 'class']);
const SECTION_TAGS = ['article', 'aside', 'div', 'footer', 'header', 'section'];
const STRING_DEFAULT_TYPES = new Set(['text', 'textarea', 'html', 'liquid', 'url', 'richtext', 'inline_richtext', 'select', 'radio', 'color', 'color_background', 'color_scheme', 'text_alignment', 'video_url', 'font_picker', 'link_list', 'image_picker', 'video']);
const VI_KEYWORDS = new Set(['and', 'or', 'contains', 'true', 'false', 'nil', 'null', 'blank', 'empty']);
// Setting icons are Shopify's stable snake_case icon ids (e.g. "layout_columns_2").
const ICON_ID = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const EPS = 1e-9;

export const NAME_LIMIT = 25;
export const SOFT_SETTINGS_PER_FILE = 120;
export const SOFT_FILE_BYTES = 200 * 1024;
export const RANGE_MIN_STEPS = 3;
export const RANGE_MAX_VALUES = 101;

class Reporter {
  constructor(file, origins) {
    this.file = file;
    this.origins = origins;
    this.issues = [];
  }

  add(level, rule, path, message, node) {
    const issue = { level, rule, file: this.file, path, message };
    const origin = node && this.origins ? this.origins.get(node) : undefined;
    if (origin) issue.origin = origin;
    this.issues.push(issue);
  }

  error(rule, path, message, node) {
    this.add('error', rule, path, message, node);
  }

  warn(rule, path, message, node) {
    this.add('warning', rule, path, message, node);
  }
}

const onStep = (delta, step) => {
  const q = delta / step;
  return Math.abs(q - Math.round(q)) < EPS;
};
const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6))));
const short = (s, n = 40) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n - 1)}…` : s);
const idSet = (list) => new Set((Array.isArray(list) ? list : []).filter((s) => isPlainObject(s) && typeof s.id === 'string').map((s) => s.id));
const settingMap = (list) => new Map((Array.isArray(list) ? list : []).filter((s) => isPlainObject(s) && typeof s.id === 'string').map((s) => [s.id, s]));
const who = (s) => (typeof s.id === 'string' ? `"${s.id}"` : s.type === 'header' || s.type === 'paragraph' ? `${s.type} "${short(s.content)}"` : `(${s.type ?? 'setting'})`);

// ------------------------------------------------------------- richtext

/**
 * Shopify richtext: only <p> and <ul> may be top-level elements (a default or a
 * stored value without them can make the whole template fail). Returns null when
 * valid, otherwise the reason.
 */
export function checkRichtext(html) {
  if (typeof html !== 'string') return 'not a string';
  if (!html.trim()) return null;
  const VOID = new Set(['br', 'img', 'hr', 'wbr', 'input', 'meta', 'link', 'source']);
  const re = /<!--[\s\S]*?-->|<\/?([A-Za-z][A-Za-z0-9-]*)\b[^>]*?(\/?)>|[^<]+|</g;
  let depth = 0;
  for (const m of html.matchAll(re)) {
    const token = m[0];
    if (token.startsWith('<!--')) continue;
    if (!m[1]) {
      if (depth === 0 && token.trim()) return `text "${short(token.trim(), 30)}" sits outside <p>/<ul>`;
      continue;
    }
    const name = m[1].toLowerCase();
    const closing = token.startsWith('</');
    const selfClosing = m[2] === '/' || VOID.has(name);
    if (closing) {
      depth -= 1;
      if (depth < 0) return `unbalanced </${name}>`;
      continue;
    }
    if (depth === 0 && !['p', 'ul'].includes(name)) return `top-level <${name}> (only <p> and <ul> are allowed at the top level)`;
    if (!selfClosing) depth += 1;
  }
  return depth === 0 ? null : 'an element is not closed';
}

// ------------------------------------------------------------ visible_if

function splitLookup(word) {
  const segs = [];
  for (const m of word.matchAll(/([A-Za-z_][\w-]*)|\[(?:'([^']*)'|"([^"]*)"|(\d+))\]/g)) segs.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
  return segs;
}

/** Parses a visible_if value: { error } or { lookups: [[root, …segments]] }. */
export function analyseVisibleIf(expr) {
  if (typeof expr !== 'string') return { error: 'visible_if must be a string' };
  const m = /^\s*\{\{([\s\S]*?)\}\}\s*$/.exec(expr);
  if (!m || !m[1].trim()) return { error: 'visible_if must take the form "{{ <expression> }}"' };
  if (/\{\{|\}\}|\{%|%\}/.test(m[1])) return { error: 'visible_if must hold exactly one {{ <expression> }}' };
  const lookups = [];
  const re = /'[^']*'|"[^"]*"|-?\d+(?:\.\d+)?(?![\w.])|([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*|\[(?:'[^']*'|"[^"]*"|\d+)\])*)|==|!=|<>|>=|<=|>|<|(\S)/g;
  for (const t of m[1].matchAll(re)) {
    if (t[1]) {
      if (!VI_KEYWORDS.has(t[1])) lookups.push(splitLookup(t[1]));
    } else if (t[2]) {
      return { error: t[2] === '(' || t[2] === ')' ? 'Liquid conditions do not support parentheses' : `unexpected "${t[2]}" in visible_if` };
    }
  }
  return { lookups };
}

function checkLookup(segs, ctx) {
  const [root, ...rest] = segs;
  const text = segs.join('.');
  if (root === 'section') {
    if (ctx.scope === 'theme') return `can't refer to "section" in config/settings_schema.json`;
    if (ctx.isThemeBlockFile) return null;
    if (rest[0] !== 'settings' || rest.length !== 2) return `"${text}" must be section.settings.<id>`;
    return ctx.sectionIds?.has(rest[1]) ? null : `"section.settings.${rest[1]}" is not a setting of this section`;
  }
  if (root === 'block') {
    if (ctx.scope !== 'block') return `can't refer to "block" from ${ctx.scope === 'theme' ? 'theme settings' : 'section settings'}`;
    if (rest[0] !== 'settings' || rest.length !== 2) return `"${text}" must be block.settings.<id>`;
    return ctx.ownIds.has(rest[1]) ? null : `"block.settings.${rest[1]}" is not a setting of this block`;
  }
  if (root === 'settings') {
    if (rest.length !== 1) return `"${text}" must be settings.<id>`;
    if (ctx.globalIds && !ctx.globalIds.has(rest[0])) return `"settings.${rest[0]}" is not a theme setting (config/settings_schema.json)`;
    return null;
  }
  return `unknown variable "${text}" (use section.settings.<id>, block.settings.<id> or settings.<id>)`;
}

// ------------------------------------------------------------- values

/**
 * Whether `value` is valid for `setting` (preset values here; template values in T3.2's
 * check-templates.mjs). Returns null when valid, otherwise the reason.
 */
export function validateSettingValue(setting, value) {
  const type = setting?.type;
  switch (type) {
    case 'checkbox':
      return typeof value === 'boolean' ? null : `checkbox value must be true or false (got ${JSON.stringify(value)})`;
    case 'number':
      if (value === null || value === '') return null;
      if (typeof value !== 'number' || !Number.isFinite(value)) return `number value must be a number (got ${JSON.stringify(value)})`;
      if (typeof setting.min === 'number' && value < setting.min - EPS) return `value ${value} is below the minimum ${setting.min}`;
      if (typeof setting.max === 'number' && value > setting.max + EPS) return `value ${value} is above the maximum ${setting.max}`;
      return null;
    case 'range': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `range value must be a number, not ${JSON.stringify(value)}`;
      const step = setting.step ?? 1;
      if (typeof setting.min === 'number' && typeof setting.max === 'number') {
        if (value < setting.min - EPS || value > setting.max + EPS) return `value ${value} is outside ${setting.min}–${setting.max}`;
        if (typeof step === 'number' && step > 0 && !onStep(value - setting.min, step)) return `value ${value} is not on a step of ${step} from ${setting.min}`;
      }
      return null;
    }
    case 'select':
    case 'radio': {
      if (typeof value !== 'string') return `${type} value must be a string (got ${JSON.stringify(value)})`;
      const values = (Array.isArray(setting.options) ? setting.options : []).map((o) => o?.value);
      return values.includes(value) ? null : `"${value}" is not one of the options (${values.join(', ')})`;
    }
    case 'text_alignment':
      return ['left', 'center', 'right'].includes(value) ? null : `text_alignment value must be left, center or right (got ${JSON.stringify(value)})`;
    case 'richtext': {
      if (typeof value !== 'string') return `richtext value must be a string (got ${JSON.stringify(value)})`;
      if (/^\s*\{\{[\s\S]*\}\}\s*$/.test(value)) return null;
      const why = checkRichtext(value);
      return why ? `richtext must use only <p> or <ul> as top-level elements: ${why}` : null;
    }
    case 'product_list':
    case 'collection_list':
    case 'article_list':
    case 'metaobject_list':
      return Array.isArray(value) || typeof value === 'string' ? null : `${type} value must be a list (got ${JSON.stringify(value)})`;
    default:
      if (type && SETTING_TYPES[type] && type !== 'header' && type !== 'paragraph') {
        return typeof value === 'string' ? null : `${type} value must be a string (got ${JSON.stringify(value)})`;
      }
      return null;
  }
}

// ------------------------------------------------------------- settings

function checkShape(s, p, r, ctx) {
  const name = who(s);
  if (typeof s.type !== 'string' || !s.type) {
    r.error('setting-shape', `${p}.type`, `${name}: every setting needs a "type"`, s);
    return false;
  }
  const spec = SETTING_TYPES[s.type];
  if (!spec) {
    r.warn('setting-shape', `${p}.type`, `${name}: unknown setting type "${s.type}" (theme check's ValidSchema rejects types missing from Shopify's schema)`, s);
    return false;
  }
  for (const key of spec.required) if (!Object.hasOwn(s, key)) r.error('setting-shape', p, `${name}: a ${s.type} setting needs "${key}"`, s);
  for (const key of Object.keys(s)) {
    if (spec.allowed.has(key)) continue;
    let why = '';
    if (key === 'visible_if') why = ` (${s.type} settings do not support conditional display)`;
    else if (key === 'ref' || key.startsWith('$')) why = ' (a generator directive was left in the output)';
    r.error('setting-shape', `${p}.${key}`, `${name}: "${key}" is not an attribute of a ${s.type} setting${why}`, s);
  }
  if (Object.hasOwn(s, 'id') && (typeof s.id !== 'string' || !s.id)) r.error('setting-shape', `${p}.id`, `${name}: "id" must be a non-empty string`, s);
  else if (typeof s.id === 'string' && !/^[A-Za-z0-9_-]+$/.test(s.id)) r.warn('setting-shape', `${p}.id`, `${name}: ids should use letters, digits, "_" or "-"`, s);
  for (const key of ['label', 'info', 'placeholder', 'unit']) {
    if (Object.hasOwn(s, key) && typeof s[key] !== 'string') r.error('setting-shape', `${p}.${key}`, `${name}: "${key}" must be text`, s);
  }
  if (typeof s.label === 'string' && !s.label.trim()) r.error('setting-shape', `${p}.label`, `${name}: "label" must not be empty`, s);
  if (Object.hasOwn(s, 'content') && (typeof s.content !== 'string' || !s.content.trim())) r.error('setting-shape', `${p}.content`, `${name}: "content" must be non-empty text`, s);
  if (Object.hasOwn(s, 'default')) {
    const d = s.default;
    if (s.type === 'checkbox' && typeof d !== 'boolean') r.error('setting-shape', `${p}.default`, `${name}: a checkbox default must be true or false (got ${JSON.stringify(d)})`, s);
    if (s.type === 'number' && typeof d !== 'number') r.error('setting-shape', `${p}.default`, `${name}: a number default must be a number (got ${JSON.stringify(d)})`, s);
    if (STRING_DEFAULT_TYPES.has(s.type) && typeof d !== 'string') r.error('setting-shape', `${p}.default`, `${name}: a ${s.type} default must be a string (got ${JSON.stringify(d)})`, s);
    if (s.type === 'text_alignment' && typeof d === 'string' && !['left', 'center', 'right'].includes(d)) r.error('setting-shape', `${p}.default`, `${name}: text_alignment default must be left, center or right`, s);
  }
  if (ctx.scope !== 'theme' && s.type === 'color_palette') r.error('color-palette', p, `${name}: color_palette is only allowed in config/settings_schema.json`, s);
  return true;
}

function checkRange(s, p, r) {
  const name = who(s);
  let numeric = true;
  for (const key of ['min', 'max', 'step', 'default']) {
    if (!Object.hasOwn(s, key)) continue;
    if (typeof s[key] !== 'number' || !Number.isFinite(s[key])) {
      r.error('range', `${p}.${key}`, `${name}: ${key} must be a number, not ${JSON.stringify(s[key])} (Shopify rejects string values)`, s);
      numeric = false;
    }
  }
  if (!numeric || typeof s.min !== 'number' || typeof s.max !== 'number') return;
  const step = s.step ?? 1;
  if (!(step > 0)) {
    r.error('range', `${p}.step`, `${name}: step must be greater than 0 (got ${step})`, s);
    return;
  }
  if (typeof s.step === 'number' && !onStep(s.step, 0.1)) r.error('range', `${p}.step`, `${name}: step ${s.step} must be a multiple of 0.1`, s);
  if (!(s.min < s.max)) {
    r.error('range', p, `${name}: min (${s.min}) must be less than max (${s.max})`, s);
    return;
  }
  if (typeof s.default === 'number') {
    if (s.default < s.min || s.default > s.max) r.error('range', `${p}.default`, `${name}: default ${s.default} is outside ${s.min}–${s.max}`, s);
    else if (!onStep(s.default - s.min, step)) {
      r.error('range', `${p}.default`, `${name}: default ${s.default} is not on a step: (default − min) = ${fmt(s.default - s.min)} is not a multiple of step ${step}`, s);
    }
  }
  // Shopify's upload limits ("at least 3 steps", "at most 101 steps") count a range's
  // selectable values, (max − min) / step + 1: 2–4 by 1 (3 values) shipped in production
  // (related-products, retired in T0.2); read the same way, 0–100 by 1 (101 values) is the maximum.
  const values = Math.floor((s.max - s.min) / step + EPS) + 1;
  if (values < RANGE_MIN_STEPS) {
    r.error('range', p, `${name}: ${s.min}–${s.max} by ${step} gives only ${values} value(s); a range needs at least ${RANGE_MIN_STEPS} steps`, s);
  }
  if (values > RANGE_MAX_VALUES) {
    r.error('range', p, `${name}: ${s.min}–${s.max} by ${step} gives ${values} values; Shopify rejects more than ${RANGE_MAX_VALUES} ("Range settings must have at most 101 steps")`, s);
  }
  if (!onStep(s.max - s.min, step)) r.warn('range', p, `${name}: max − min (${fmt(s.max - s.min)}) is not a multiple of step ${step}; the slider cannot reach ${s.max}`, s);
}

/** number settings: optional min/max/options (at most one decimal digit; default and options within the bounds). */
function checkNumber(s, p, r) {
  const name = who(s);
  for (const key of ['min', 'max', 'default']) {
    if (!Object.hasOwn(s, key) || typeof s[key] !== 'number') continue;
    if (!onStep(s[key], 0.1)) r.error('range', `${p}.${key}`, `${name}: ${key} ${s[key]} has more than one decimal digit`, s);
  }
  for (const key of ['min', 'max']) {
    if (Object.hasOwn(s, key) && (typeof s[key] !== 'number' || !Number.isFinite(s[key]))) r.error('range', `${p}.${key}`, `${name}: ${key} must be a number, not ${JSON.stringify(s[key])}`, s);
  }
  const min = typeof s.min === 'number' ? s.min : -Infinity;
  const max = typeof s.max === 'number' ? s.max : Infinity;
  if (min >= max) r.error('range', p, `${name}: min (${s.min}) must be less than max (${s.max})`, s);
  const inBounds = (v) => v >= min - EPS && v <= max + EPS;
  if (typeof s.default === 'number' && !inBounds(s.default)) r.error('range', `${p}.default`, `${name}: default ${s.default} is outside ${fmt(min)}–${fmt(max)}`, s);
  if (Object.hasOwn(s, 'icon') && (typeof s.icon !== 'string' || !ICON_ID.test(s.icon))) {
    r.error('setting-shape', `${p}.icon`, `${name}: icon must be one of Shopify's snake_case icon ids such as "layout_columns_2" (got ${JSON.stringify(s.icon)})`, s);
  }
  if (!Object.hasOwn(s, 'options')) return;
  if (!Array.isArray(s.options)) {
    r.error('select-default', `${p}.options`, `${name}: "options" must be a list`, s);
    return;
  }
  s.options.forEach((o, j) => {
    const q = `${p}.options[${j}]`;
    if (!isPlainObject(o) || typeof o.value !== 'number') {
      r.error('select-default', q, `${name}: each number option needs a numeric "value"`, s);
      return;
    }
    const extra = Object.keys(o).filter((k) => !['value', 'label', 'icon'].includes(k));
    if (extra.length) r.error('select-default', q, `${name}: unknown option attribute(s) ${extra.join(', ')}`, s);
    if (!inBounds(o.value)) r.error('select-default', `${q}.value`, `${name}: option value ${o.value} is outside ${fmt(min)}–${fmt(max)}`, s);
  });
}

function checkSelect(s, p, r) {
  const name = who(s);
  if (!Array.isArray(s.options) || s.options.length === 0) {
    r.error('select-default', `${p}.options`, `${name}: a ${s.type} needs a non-empty "options" list`, s);
    return;
  }
  const values = [];
  const allowed = s.type === 'select' ? ['value', 'label', 'group', 'icon'] : ['value', 'label'];
  s.options.forEach((o, j) => {
    const q = `${p}.options[${j}]`;
    if (!isPlainObject(o) || typeof o.value !== 'string' || typeof o.label !== 'string') {
      r.error('select-default', q, `${name}: each option needs a string "value" and "label"`, s);
      return;
    }
    const extra = Object.keys(o).filter((k) => !allowed.includes(k));
    if (extra.includes('icon')) r.error('select-default', `${q}.icon`, `${name}: radio options can't carry an icon (use a select for options with icons)`, s);
    const unknown = extra.filter((k) => k !== 'icon');
    if (unknown.length) r.error('select-default', q, `${name}: unknown option attribute(s) ${unknown.join(', ')}`, s);
    if (Object.hasOwn(o, 'icon') && s.type === 'select' && (typeof o.icon !== 'string' || !ICON_ID.test(o.icon))) {
      r.error('select-default', `${q}.icon`, `${name}: an option icon must be one of Shopify's snake_case icon ids such as "layout_columns_2" (got ${JSON.stringify(o.icon)})`, s);
    }
    if (Object.hasOwn(o, 'group') && typeof o.group !== 'string') r.error('select-default', `${q}.group`, `${name}: an option group must be text`, s);
    if (values.includes(o.value)) r.error('select-default', q, `${name}: duplicate option value "${o.value}"`, s);
    values.push(o.value);
  });
  if (Object.hasOwn(s, 'default') && !values.includes(s.default)) {
    r.error('select-default', `${p}.default`, `${name}: default ${JSON.stringify(s.default)} is not one of the options (${values.join(', ')})`, s);
  }
}

function checkColorDefault(s, p, r, ctx) {
  if (typeof s.default !== 'string' || !s.default.includes('{{')) return;
  const name = who(s);
  const m = /^\{\{\s*settings\.([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\}\}$/.exec(s.default);
  if (!m) {
    r.error('color-default', `${p}.default`, `${name}: a dynamic colour default must be exactly "{{ settings.<palette id>.<key> }}" (only color_palette paths are supported)`, s);
    return;
  }
  if (ctx.palette === undefined) return;
  if (!ctx.palette || ctx.palette.id !== m[1]) {
    r.error('color-default', `${p}.default`, `${name}: "settings.${m[1]}" is not the theme's color_palette${ctx.palette ? ` (its id is "${ctx.palette.id}")` : ' (config/settings_schema.json defines none)'}`, s);
  } else if (!ctx.palette.keys.has(m[2])) {
    r.error('color-default', `${p}.default`, `${name}: the palette has no colour "${m[2]}" (keys: ${[...ctx.palette.keys].join(', ')})`, s);
  }
}

function checkPalette(s, p, r) {
  const name = who(s);
  const d = s.default;
  if (!isPlainObject(d)) {
    r.error('color-palette', `${p}.default`, `${name}: the default must be an object of colour names → hex values`, s);
    return;
  }
  const keys = Object.keys(d);
  if (keys.length < 1 || keys.length > 20) r.error('color-palette', `${p}.default`, `${name}: a palette holds 1–20 colours (found ${keys.length})`, s);
  else if (keys.length < 2) r.warn('color-palette', `${p}.default`, `${name}: Shopify documents palettes of 2–20 colours`, s);
  for (const key of keys) {
    if (!/^[A-Za-z]\w*$/.test(key)) r.error('color-palette', `${p}.default.${key}`, `${name}: palette names start with a letter and hold letters, digits and "_" ("${key}")`, s);
    if (typeof d[key] !== 'string' || !/^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(d[key])) {
      r.error('color-palette', `${p}.default.${key}`, `${name}: "${key}" must be a hex colour without alpha (got ${JSON.stringify(d[key])})`, s);
    }
  }
}

/**
 * ctx: { base, scope: 'section'|'block'|'theme', ownIds, sectionIds, globalIds, palette,
 *        isThemeBlockFile, skipUnique, reporter }
 */
function validateSettingsArray(list, ctx) {
  const r = ctx.reporter;
  if (list === undefined) return;
  if (!Array.isArray(list)) {
    r.error('setting-shape', ctx.base, '"settings" must be an array');
    return;
  }
  const firstAt = new Map();
  let lastHeader = -2;
  list.forEach((s, i) => {
    const p = `${ctx.base}[${i}]`;
    if (!isPlainObject(s)) {
      r.error('setting-shape', p, 'each setting must be an object');
      return;
    }
    const known = checkShape(s, p, r, ctx);
    if (!ctx.skipUnique && typeof s.id === 'string') {
      if (firstAt.has(s.id)) r.error('unique-ids', `${p}.id`, `duplicate id "${s.id}" (already used by ${ctx.base}[${firstAt.get(s.id)}])`, s);
      else firstAt.set(s.id, i);
    }
    if (s.type === 'header') {
      if (lastHeader === i - 1) r.error('header-group', p, `two headers in a row: header "${short(list[i - 1].content)}" has no settings under it`, s);
      lastHeader = i;
    }
    if (known) {
      if (s.type === 'range') checkRange(s, p, r);
      if (s.type === 'number') checkNumber(s, p, r);
      if (s.type === 'select' || s.type === 'radio') checkSelect(s, p, r);
      if (s.type === 'richtext' && typeof s.default === 'string') {
        const why = checkRichtext(s.default);
        if (why) r.error('richtext', `${p}.default`, `${who(s)}: a richtext default must use only <p> or <ul> as top-level elements: ${why}`, s);
      }
      if (s.type === 'inline_richtext' && typeof s.default === 'string' && /<\s*(p|ul|ol|div|h[1-6])\b/i.test(s.default)) {
        r.warn('richtext', `${p}.default`, `${who(s)}: inline_richtext is not wrapped in block elements such as <p>`, s);
      }
      if (s.type === 'color') checkColorDefault(s, p, r, ctx);
      if (s.type === 'color_palette') checkPalette(s, p, r);
    }
    if (Object.hasOwn(s, 'visible_if') && typeof s.visible_if === 'string') {
      const res = analyseVisibleIf(s.visible_if);
      if (res.error) r.error('visible-if', `${p}.visible_if`, `${who(s)}: ${res.error}`, s);
      else if (!res.lookups.length) r.warn('visible-if', `${p}.visible_if`, `${who(s)}: visible_if refers to no setting`, s);
      else {
        for (const segs of res.lookups) {
          const why = checkLookup(segs, ctx);
          if (why) r.error('visible-if', `${p}.visible_if`, `${who(s)}: ${why}`, s);
        }
      }
    } else if (Object.hasOwn(s, 'visible_if')) {
      r.error('visible-if', `${p}.visible_if`, `${who(s)}: visible_if must be a string`, s);
    }
  });
  const last = list[list.length - 1];
  if (isPlainObject(last) && last.type === 'header') {
    r.error('header-group', `${ctx.base}[${list.length - 1}]`, `header "${short(last.content)}" ends the list: an empty group`, last);
  }
}

// ---------------------------------------------------------------- names

function checkName(value, path, what, r, resolveT) {
  if (typeof value !== 'string' || !value.trim()) {
    r.error('name-length', path, `${what} must be non-empty text`);
    return;
  }
  let text = value;
  if (value.startsWith('t:')) {
    const resolved = resolveT ? resolveT(value.slice(2)) : undefined;
    if (typeof resolved !== 'string') return;
    text = resolved;
  }
  const length = [...text].length;
  if (length > NAME_LIMIT) r.error('name-length', path, `${what} "${text}" is ${length} characters; the limit is ${NAME_LIMIT}`);
}

// --------------------------------------------------------------- blocks

function blockEntryOf(model, type) {
  return model ? model.blocks.get(type) : undefined;
}

function containerOf(entry, model) {
  const blocks = Array.isArray(entry?.schema?.blocks) ? entry.schema.blocks : [];
  return {
    kind: 'block',
    file: entry.file,
    local: new Map(),
    refs: blocks.filter((b) => isPlainObject(b) && typeof b.type === 'string' && !Object.hasOwn(b, 'name') && !b.type.startsWith('@')).map((b) => b.type),
    wildcard: blocks.some((b) => isPlainObject(b) && b.type === '@theme'),
    staticCalls: entry.staticBlocks ?? findStaticBlockCalls(entry.source ?? ''),
    maxBlocks: undefined,
    model,
  };
}

function validateBlockList(schema, fctx) {
  const r = fctx.reporter;
  const out = { local: new Map(), refs: [], wildcard: false };
  if (schema.blocks === undefined) return out;
  if (!Array.isArray(schema.blocks)) {
    r.error('schema-keys', 'blocks', '"blocks" must be an array');
    return out;
  }
  schema.blocks.forEach((b, i) => {
    const p = `blocks[${i}]`;
    if (!isPlainObject(b) || typeof b.type !== 'string' || !b.type) {
      r.error('schema-keys', p, 'each block entry needs a "type"');
      return;
    }
    if (Object.hasOwn(b, 'name')) {
      if (fctx.kind === 'block') r.error('theme-blocks', p, `local block "${b.type}": theme blocks can't define local blocks (only sections can)`);
      if (out.local.has(b.type)) r.error('unique-ids', `${p}.type`, `duplicate block type "${b.type}"`);
      out.local.set(b.type, b);
      checkName(b.name, `${p}.name`, `block "${b.type}" name`, r, fctx.resolveT);
      for (const key of Object.keys(b)) if (!['type', 'name', 'limit', 'settings'].includes(key)) r.error('schema-keys', `${p}.${key}`, `"${key}" is not an attribute of a local block`);
      if (Object.hasOwn(b, 'limit') && (!Number.isInteger(b.limit) || b.limit < 1)) r.error('schema-keys', `${p}.limit`, `block "${b.type}": limit must be a positive integer`);
      validateSettingsArray(b.settings, {
        base: `${p}.settings`,
        scope: 'block',
        ownIds: idSet(b.settings),
        sectionIds: fctx.sectionIds,
        globalIds: fctx.globalIds,
        palette: fctx.palette,
        isThemeBlockFile: false,
        reporter: r,
      });
      return;
    }
    if (Object.keys(b).length > 1) {
      r.error('schema-keys', p, `block "${b.type}": a theme block entry holds only "type" (a local block definition needs a "name")`);
    }
    if (b.type === '@app') return;
    if (b.type === '@theme') {
      out.wildcard = true;
      return;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(b.type)) {
      r.error('block-target', `${p}.type`, `"${b.type}" is not a valid theme block type`);
      return;
    }
    if (out.refs.includes(b.type)) r.warn('unique-ids', `${p}.type`, `block type "${b.type}" is listed twice`);
    out.refs.push(b.type);
    if (!fctx.model) return;
    const entry = blockEntryOf(fctx.model, b.type);
    if (!entry) {
      r.error('block-target', `${p}.type`, `theme block 'blocks/${b.type}.liquid' does not exist`);
      return;
    }
    if (b.type.startsWith('_') && Array.isArray(entry.schema?.presets) && entry.schema.presets.length) {
      r.error(
        'private-blocks',
        `${p}.type`,
        `private block "${b.type}" defines presets (blocks/${b.type}.liquid) and is listed here, so it would appear in this ${fctx.kind}'s "Add block" picker; a statically rendered private block must define no presets`,
      );
    }
  });
  if (fctx.kind === 'section' && out.local.size && (out.refs.length || out.wildcard)) {
    r.error('theme-blocks', 'blocks', `a section can't mix local block definitions (${[...out.local.keys()].join(', ')}) with theme blocks (${[...(out.wildcard ? ['@theme'] : []), ...out.refs].join(', ')})`);
  }
  return out;
}

// -------------------------------------------------------------- presets

function checkPresetSettings(values, defs, path, owner, r) {
  if (values === undefined) return;
  if (!isPlainObject(values)) {
    r.error('presets', path, 'preset "settings" must be an object');
    return;
  }
  for (const [id, value] of Object.entries(values)) {
    const def = defs.get(id);
    if (!def) {
      r.error('presets', `${path}.${id}`, `"${id}" is not a setting of ${owner}`);
      continue;
    }
    const why = validateSettingValue(def, value);
    if (why) r.error(def.type === 'richtext' ? 'richtext' : 'presets', `${path}.${id}`, `"${id}": ${why}`);
  }
}

function checkPresetBlocks(node, path, container, r, depth) {
  if (node.blocks === undefined) {
    if (node.block_order !== undefined) r.error('presets', `${path}.block_order`, 'block_order needs "blocks" keyed by block id next to it');
    return;
  }
  let entries;
  if (Array.isArray(node.blocks)) {
    if (node.block_order !== undefined) r.error('presets', `${path}.block_order`, 'block_order is only for blocks keyed by id; with a "blocks" list the list order is the order');
    entries = node.blocks.map((block, j) => ({ block, id: isPlainObject(block) ? block.id : undefined, path: `${path}.blocks[${j}]`, form: 'array' }));
  } else if (isPlainObject(node.blocks)) {
    entries = Object.entries(node.blocks).map(([id, block]) => ({ block, id, path: `${path}.blocks.${id}`, form: 'hash' }));
    if (node.block_order !== undefined && !Array.isArray(node.block_order)) r.error('presets', `${path}.block_order`, 'block_order must be a list of block ids');
    const order = Array.isArray(node.block_order) ? node.block_order : [];
    for (const e of entries) {
      if (!isPlainObject(e.block)) continue;
      const listed = order.includes(e.id);
      if (e.block.static === true && listed) r.warn('presets', `${path}.block_order`, `static block "${e.id}" must not be listed in block_order`);
      if (e.block.static !== true && !listed) r.warn('presets', `${path}.block_order`, `block "${e.id}" is missing from block_order`);
    }
    for (const id of order) if (!Object.hasOwn(node.blocks, id)) r.error('presets', `${path}.block_order`, `block_order names "${id}", which is not among the blocks`);
  } else {
    r.error('presets', `${path}.blocks`, 'preset "blocks" must be a list or an object keyed by block id');
    return;
  }
  let dynamic = 0;
  const perType = new Map();
  for (const e of entries) {
    const b = e.block;
    if (!isPlainObject(b) || typeof b.type !== 'string' || !b.type) {
      r.error('presets', e.path, 'each preset block needs a "type"');
      continue;
    }
    const allowedKeys = e.form === 'array' ? ['type', 'name', 'settings', 'blocks', 'static', 'id'] : ['type', 'name', 'settings', 'blocks', 'static', 'block_order'];
    const extra = Object.keys(b).filter((k) => !allowedKeys.includes(k));
    if (extra.length) r.error('presets', e.path, `unknown preset block attribute(s): ${extra.join(', ')}`);
    const isStatic = b.static === true;
    if (Object.hasOwn(b, 'static') && typeof b.static !== 'boolean') r.error('presets', `${e.path}.static`, '"static" must be true or false');
    if (!isStatic) {
      dynamic += 1;
      perType.set(b.type, (perType.get(b.type) ?? 0) + 1);
    }
    if (container.local.size) {
      if (isStatic) r.error('presets', e.path, `static block "${b.type}": a section with local blocks can't hold static theme blocks`);
      const def = container.local.get(b.type);
      if (!def) {
        if (b.type !== '@app') r.error('presets', `${e.path}.type`, `block type "${b.type}" is not defined in this section's "blocks"`);
        continue;
      }
      checkPresetSettings(b.settings, settingMap(def.settings), `${e.path}.settings`, `block "${b.type}"`, r);
      if (b.blocks !== undefined) r.error('presets', `${e.path}.blocks`, `local block "${b.type}" can't hold nested blocks`);
      continue;
    }
    if (isStatic) {
      if (typeof e.id !== 'string' || !e.id) {
        r.error('presets', e.path, `static block "${b.type}" needs an "id" next to "static": true`);
      } else if (!container.staticCalls.some((c) => c.type === b.type && c.id === e.id)) {
        r.error('presets', e.path, `no {% content_for 'block', type: '${b.type}', id: '${e.id}' %} in ${container.file}: a static preset block must match a static block of the Liquid`);
      }
    } else {
      if (typeof e.id === 'string' && container.staticCalls.some((c) => c.type === b.type && c.id === e.id)) {
        r.error('presets', e.path, `"${e.id}" is rendered statically in ${container.file}; its preset entry needs "static": true`);
      }
      if (b.type.startsWith('_')) {
        if (!container.refs.includes(b.type)) {
          r.error('private-blocks', `${e.path}.type`, `private block "${b.type}" must be listed explicitly in "blocks" of ${container.file} (@theme never covers private blocks)`);
        }
      } else if (!container.wildcard && !container.refs.includes(b.type) && b.type !== '@app') {
        r.error('block-target', `${e.path}.type`, `block type "${b.type}" is not allowed in ${container.file} (not listed in its "blocks" and no @theme)`);
      }
    }
    if (!container.model) continue;
    const entry = blockEntryOf(container.model, b.type);
    if (!entry) {
      if (b.type !== '@app') r.error('block-target', `${e.path}.type`, `theme block 'blocks/${b.type}.liquid' does not exist`);
      continue;
    }
    if (!isPlainObject(entry.schema)) continue;
    checkPresetSettings(b.settings, settingMap(entry.schema.settings), `${e.path}.settings`, `blocks/${b.type}.liquid`, r);
    if (b.blocks !== undefined || b.block_order !== undefined) checkPresetBlocks(b, e.path, containerOf(entry, container.model), r, depth + 1);
  }
  if (depth === 0 && Number.isInteger(container.maxBlocks) && dynamic > container.maxBlocks) {
    r.error('presets', `${path}.blocks`, `${dynamic} blocks exceed max_blocks (${container.maxBlocks})`);
  }
  for (const [type, count] of perType) {
    const def = container.local.get(type);
    if (def && Number.isInteger(def.limit) && count > def.limit) r.error('presets', `${path}.blocks`, `${count} "${type}" blocks exceed its limit (${def.limit})`);
  }
}

function validatePresets(schema, container, settingDefs, r) {
  if (schema.presets === undefined) return;
  if (!Array.isArray(schema.presets)) {
    r.error('presets', 'presets', '"presets" must be a list');
    return;
  }
  const names = new Set();
  schema.presets.forEach((preset, i) => {
    const p = `presets[${i}]`;
    if (!isPlainObject(preset)) {
      r.error('presets', p, 'each preset must be an object');
      return;
    }
    if (typeof preset.name !== 'string' || !preset.name.trim()) r.error('presets', `${p}.name`, 'a preset needs a name');
    else if (names.has(preset.name)) r.warn('presets', `${p}.name`, `two presets are named "${preset.name}"`);
    else names.add(preset.name);
    for (const key of Object.keys(preset)) {
      if (!['name', 'category', 'settings', 'blocks', 'block_order'].includes(key)) r.error('presets', `${p}.${key}`, `"${key}" is not a preset attribute`);
    }
    checkPresetSettings(preset.settings, settingDefs, `${p}.settings`, `this ${container.kind}`, r);
    checkPresetBlocks(preset, p, container, r, 0);
  });
}

// ---------------------------------------------------------- entry points

/**
 * Validates one section or theme-block schema.
 * input: { file, kind: 'section'|'block', type?, schema, source?, model?, origins?,
 *          limits?: { excessive: { max, enabled, source } }, sizeBytes?, resolveT? }
 */
export function validateSchemaFile(input) {
  const { file, kind, schema, source = '', model = null, origins = null } = input;
  const r = new Reporter(file, origins);
  const type = input.type ?? String(file).split('/').pop().replace(/\.liquid(\.txt)?$/, '');
  if (!isPlainObject(schema)) {
    r.error('json', '', 'the {% schema %} body must be a JSON object');
    return r.issues;
  }
  const keys = kind === 'block' ? BLOCK_KEYS : SECTION_KEYS;
  for (const key of Object.keys(schema)) if (!keys.has(key)) r.error('schema-keys', key, `"${key}" is not a ${kind} schema attribute`);
  if (!Object.hasOwn(schema, 'name')) r.error('name-length', 'name', `the ${kind} schema needs a "name"`);
  else checkName(schema.name, 'name', `${kind} name`, r, input.resolveT);
  if (kind === 'section') {
    if (Object.hasOwn(schema, 'tag') && !SECTION_TAGS.includes(schema.tag)) r.error('schema-keys', 'tag', `tag must be one of ${SECTION_TAGS.join(', ')}`);
    if (Object.hasOwn(schema, 'limit') && ![1, 2].includes(schema.limit)) r.error('schema-keys', 'limit', 'limit must be 1 or 2');
    if (Object.hasOwn(schema, 'max_blocks') && (!Number.isInteger(schema.max_blocks) || schema.max_blocks < 1 || schema.max_blocks > 50)) {
      r.error('schema-keys', 'max_blocks', 'max_blocks must be an integer from 1 to 50');
    }
  }
  if (Object.hasOwn(schema, 'class') && typeof schema.class !== 'string') r.error('schema-keys', 'class', '"class" must be text');
  if (kind === 'block' && Object.hasOwn(schema, 'tag')) {
    // A theme block's tag is any element name up to 50 characters, or null (no wrapper element).
    if (schema.tag !== null && (typeof schema.tag !== 'string' || [...schema.tag].length > 50)) r.error('schema-keys', 'tag', 'a theme block "tag" must be text of at most 50 characters, or null');
  } else if (Object.hasOwn(schema, 'tag') && typeof schema.tag !== 'string') {
    r.error('schema-keys', 'tag', '"tag" must be text');
  }

  const staticCalls = findStaticBlockCalls(source);
  const sectionIds = idSet(schema.settings);
  const globalIds = model?.globalSettingIds ?? null;
  const palette = model ? model.palette ?? null : undefined;
  validateSettingsArray(schema.settings, {
    base: 'settings',
    scope: kind === 'block' ? 'block' : 'section',
    ownIds: sectionIds,
    sectionIds: kind === 'block' ? null : sectionIds,
    globalIds,
    palette,
    isThemeBlockFile: kind === 'block',
    reporter: r,
  });
  const blocks = validateBlockList(schema, { kind, reporter: r, model, sectionIds, globalIds, palette, resolveT: input.resolveT });

  const seenStatic = new Map();
  for (const call of staticCalls) {
    if (!call.type || !call.id) {
      r.warn('static-blocks', 'liquid', "{% content_for 'block' %} without a literal type and id");
      continue;
    }
    const prior = seenStatic.get(call.id);
    if (prior && prior !== call.type) r.error('static-blocks', 'liquid', `static block id "${call.id}" is used for two types (${prior}, ${call.type})`);
    seenStatic.set(call.id, call.type);
    if (model && !model.blocks.has(call.type)) r.error('block-target', 'liquid', `{% content_for 'block', type: '${call.type}' %}: blocks/${call.type}.liquid does not exist`);
  }
  if (kind === 'section' && blocks.local.size && staticCalls.length) {
    r.error('theme-blocks', 'blocks', `a section can't render static theme blocks (${staticCalls.map((c) => c.type).join(', ')}) and define local blocks (${[...blocks.local.keys()].join(', ')})`);
  }

  validatePresets(
    schema,
    { kind, file, local: blocks.local, refs: blocks.refs, wildcard: blocks.wildcard, staticCalls, maxBlocks: schema.max_blocks, model },
    settingMap(schema.settings),
    r,
  );

  if (kind === 'block' && type.startsWith('_') && Array.isArray(schema.presets) && schema.presets.length && model) {
    const listedBy = [];
    for (const entry of [...model.sections.values(), ...model.blocks.values()]) {
      if (entry.file === file || !Array.isArray(entry.schema?.blocks)) continue;
      if (entry.schema.blocks.some((b) => isPlainObject(b) && b.type === type && !Object.hasOwn(b, 'name'))) listedBy.push(entry.file);
    }
    if (listedBy.length) {
      r.error('private-blocks', 'presets', `private block "${type}" defines presets and is listed by ${listedBy.join(', ')}: it would appear in their "Add block" picker (a statically rendered private block must define no presets)`);
    }
  }

  const limits = input.limits ?? {};
  const excessive = limits.excessive ?? { max: 40, enabled: true, source: "theme check's default" };
  const topLevel = Array.isArray(schema.settings) ? schema.settings.filter((s) => isPlainObject(s) && Object.hasOwn(s, 'id')).length : 0;
  if (excessive.enabled && topLevel > excessive.max) {
    r.warn('soft-limits', 'settings', `${topLevel} top-level settings with an id: theme check's ExcessiveSettingsCount warns above ${excessive.max} (${excessive.source})`);
  }
  let total = topLevel;
  for (const b of blocks.local.values()) total += Array.isArray(b.settings) ? b.settings.filter((s) => isPlainObject(s) && Object.hasOwn(s, 'id')).length : 0;
  if (total > SOFT_SETTINGS_PER_FILE) r.warn('soft-limits', '', `${total} settings in this file (soft limit ${SOFT_SETTINGS_PER_FILE})`);
  if (typeof input.sizeBytes === 'number' && input.sizeBytes > SOFT_FILE_BYTES) {
    r.warn('soft-limits', '', `the file is ${Math.round(input.sizeBytes / 1024)} KB (soft limit ${SOFT_FILE_BYTES / 1024} KB; Shopify refuses Liquid files over 256 KB)`);
  }
  return r.issues;
}

const THEME_INFO_REQUIRED = ['name', 'theme_name', 'theme_author', 'theme_version', 'theme_documentation_url'];
const THEME_INFO_KEYS = new Set([...THEME_INFO_REQUIRED, 'theme_support_email', 'theme_support_url']);

/** Validates config/settings_schema.json (the generated array). input: { file, schema, origins? } */
export function validateThemeSettings(input) {
  const { file, schema, origins = null } = input;
  const r = new Reporter(file, origins);
  if (!Array.isArray(schema)) {
    r.error('json', '', 'config/settings_schema.json must be an array');
    return r.issues;
  }
  const globalIds = new Set();
  const firstAt = new Map();
  const palettes = [];
  schema.forEach((panel, i) => {
    if (!isPlainObject(panel) || !Array.isArray(panel.settings)) return;
    panel.settings.forEach((s, j) => {
      if (!isPlainObject(s)) return;
      if (typeof s.id === 'string') {
        const here = `[${i}].settings[${j}]`;
        if (firstAt.has(s.id)) r.error('unique-ids', `${here}.id`, `duplicate theme setting id "${s.id}" (already used by ${firstAt.get(s.id)})`, s);
        else firstAt.set(s.id, here);
        globalIds.add(s.id);
      }
      if (s.type === 'color_palette') palettes.push({ s, path: `[${i}].settings[${j}]` });
    });
  });
  if (palettes.length > 1) r.error('color-palette', palettes[1].path, 'only one color_palette setting is allowed per theme', palettes[1].s);
  const p0 = palettes[0]?.s;
  const palette = p0 && typeof p0.id === 'string' ? { id: p0.id, keys: new Set(isPlainObject(p0.default) ? Object.keys(p0.default) : []) } : null;
  const infos = schema.filter((panel) => isPlainObject(panel) && panel.name === 'theme_info');
  if (infos.length > 1) r.error('schema-keys', '', `only one theme_info object is allowed (found ${infos.length})`);
  else if (!infos.length) r.warn('schema-keys', '', 'no theme_info object (theme name, version and support links)');
  schema.forEach((panel, i) => {
    const p = `[${i}]`;
    if (!isPlainObject(panel)) {
      r.error('schema-keys', p, 'each entry must be an object');
      return;
    }
    if (panel.name === 'theme_info') {
      for (const key of THEME_INFO_REQUIRED) if (typeof panel[key] !== 'string') r.error('schema-keys', `${p}.${key}`, `theme_info needs "${key}"`);
      for (const key of Object.keys(panel)) if (!THEME_INFO_KEYS.has(key)) r.error('schema-keys', `${p}.${key}`, `"${key}" is not a theme_info attribute`);
      if (Object.hasOwn(panel, 'theme_support_email') === Object.hasOwn(panel, 'theme_support_url')) {
        r.error('schema-keys', p, 'theme_info needs exactly one of theme_support_url or theme_support_email');
      }
      return;
    }
    if (typeof panel.name !== 'string' || !panel.name.trim()) r.error('schema-keys', `${p}.name`, 'each settings panel needs a name');
    for (const key of Object.keys(panel)) if (!['name', 'settings'].includes(key)) r.error('schema-keys', `${p}.${key}`, `"${key}" is not a settings panel attribute`);
    validateSettingsArray(panel.settings ?? [], {
      base: `${p}.settings`,
      scope: 'theme',
      ownIds: globalIds,
      sectionIds: null,
      globalIds,
      palette,
      isThemeBlockFile: false,
      skipUnique: true,
      reporter: r,
    });
  });
  return r.issues;
}
