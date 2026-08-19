// The custom-theme contract: how an EXTERNAL theme engine (monotheme) pushes a
// palette into a private workspace without a rebuild.
//
// Runtime-agnostic (no node imports) — it is imported by server/app.ts, which
// the Worker bundles, and by the viewer, which applies the same palette to the
// chrome. Two rules shape everything below:
//
//   1. NOTHING from the payload is interpolated into CSS until it has passed
//      `isColor`. The palette becomes `--var: value` declarations inside a
//      sandboxed document; an unvalidated value is a CSS injection sink, so the
//      parser rebuilds a fresh object out of known keys and rejects the payload
//      outright on the first value it cannot recognize. Unknown keys are
//      dropped, never passed through.
//   2. The payload is VERSIONED. A workspace can be older or newer than the
//      pusher; a mismatched `version` is refused with a clear error instead of
//      being partially understood.
//
// A custom theme's CONTENT changes while its id stays "custom", so every
// accepted payload also gets a monotonic `revision`. Everything keyed by theme
// (the /s/:id render cache, the surface iframe URLs) keys on the revision too —
// see `CustomThemeRecord` and the /s/:id route.
import {
  type Accent,
  DEFAULT_THEME_ID,
  type Mode,
  type Palette,
  type Theme,
  themeById,
} from "./themes.ts";

// Bump when the payload shape changes incompatibly. A pusher sends the version
// it was written against; a workspace accepts only the one it implements.
export const CUSTOM_THEME_VERSION = 1;

// One custom theme per workspace, under a fixed id: the workspace is one
// person's, and the point is "whatever my machine's theme currently is", not a
// library of them. The id is what `/api/theme` persists and what the viewer
// passes as `?theme=` on every surface frame.
export const CUSTOM_THEME_ID = "custom";
export const CUSTOM_THEME_SETTING = "customTheme";

const MAX_LABEL_LENGTH = 64;
const MAX_TOKEN_RULES = 2000;
const MAX_SYNTAX_COLORS = 800;
const MAX_SCOPES_PER_RULE = 64;
const MAX_SCOPE_LENGTH = 200;

// A shiki/TextMate token rule, narrowed to the fields we render with.
export interface CustomTokenRule {
  scope?: string[];
  settings: { foreground?: string; background?: string; fontStyle?: string };
}

// A syntax (shiki) theme, carried as DATA rather than as the name of a theme the
// server happens to bundle — a machine-local theme is not in shiki's bundle, so
// naming one could only ever approximate it.
export interface CustomSyntaxTheme {
  type: Mode;
  bg?: string;
  fg?: string;
  colors?: Record<string, string>;
  tokenColors: CustomTokenRule[];
}

// One color scheme's worth of theme: the semantic palette the chrome and the
// html-surface `--color-*` tokens derive from, plus optional syntax data.
export interface CustomThemeScheme {
  palette: Palette;
  syntax?: CustomSyntaxTheme;
}

// The wire payload. `light`/`dark` are both optional but at least one is
// required: a machine theme is usually one scheme, and the workspace mirrors it
// into the other rather than half-theming itself (see `schemeOr`).
export interface CustomThemePayload {
  version: number;
  id?: string;
  label: string;
  light?: CustomThemeScheme;
  dark?: CustomThemeScheme;
}

// What the workspace persists: the validated payload plus the revision that
// distinguishes this content from the previous content under the same id.
export interface CustomThemeRecord {
  revision: number;
  payload: CustomThemePayload;
}

export type ParseResult = { ok: true; theme: CustomThemePayload } | { ok: false; error: string };

// --- validation primitives -------------------------------------------------

// The only color syntaxes the registry itself uses: hex (3/4/6/8 digits) and
// numeric rgb()/rgba(). Deliberately narrow — anything that can carry a URL, a
// `var()` reference, or a `;` must never reach a stylesheet.
const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RGB = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d{1,4})\s*)?\)$/;

export function isColor(value: unknown): value is string {
  return typeof value === "string" && (HEX.test(value) || RGB.test(value));
}

// TextMate font styles, as shiki accepts them: a space-separated subset.
const FONT_STYLES = new Set(["italic", "bold", "underline", "strikethrough", "normal", ""]);

function isFontStyle(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    value.split(/\s+/).every((part) => FONT_STYLES.has(part))
  );
}

// shiki `colors` keys are dotted identifiers (editor.background, …). Constrain
// them so a key cannot smuggle markup into a generated theme object.
const COLOR_KEY = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/;
const SCOPE = /^[A-Za-z0-9 ._\-,:#()[\]|*+^$?]+$/;
// Anything the terminal would treat as a control character, plus DEL. Written as
// a codepoint scan rather than a regex: a control-character character class is
// exactly what `no-control-regex` exists to catch, and the intent is clearer.
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ACCENT_KEYS = ["bg", "text", "border"] as const;
const PALETTE_COLOR_KEYS = [
  "bg",
  "panel",
  "surface",
  "text",
  "muted",
  "faint",
  "border",
  "border2",
  "hover",
] as const;
const PALETTE_ACCENT_KEYS = ["info", "success", "warning", "danger"] as const;

class Invalid extends Error {}

function fail(message: string): never {
  throw new Invalid(message);
}

function parseAccent(raw: unknown, where: string): Accent {
  if (!isRecord(raw)) fail(`${where} must be an object`);
  const out = {} as Accent;
  for (const key of ACCENT_KEYS) {
    const value = raw[key];
    if (!isColor(value)) fail(`${where}.${key} is not a valid color`);
    out[key] = value;
  }
  return out;
}

// Rebuild the palette key by key. The result shares no object identity with the
// input, so an unexpected extra key cannot survive into CSS.
export function parsePalette(raw: unknown, where: string): Palette {
  if (!isRecord(raw)) fail(`${where} must be an object`);
  const out = {} as Palette;
  for (const key of PALETTE_COLOR_KEYS) {
    const value = raw[key];
    if (!isColor(value)) fail(`${where}.${key} is not a valid color`);
    out[key] = value;
  }
  for (const key of PALETTE_ACCENT_KEYS) out[key] = parseAccent(raw[key], `${where}.${key}`);
  return out;
}

function parseScopes(raw: unknown, where: string): string[] | undefined {
  if (raw == null) return undefined;
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length > MAX_SCOPES_PER_RULE) fail(`${where} has too many scopes`);
  const out: string[] = [];
  for (const scope of list) {
    if (typeof scope !== "string" || scope.length > MAX_SCOPE_LENGTH || !SCOPE.test(scope)) {
      fail(`${where} contains an invalid scope`);
    }
    out.push(scope);
  }
  return out;
}

function parseSyntax(raw: unknown, mode: Mode, where: string): CustomSyntaxTheme | undefined {
  if (raw == null) return undefined;
  if (!isRecord(raw)) fail(`${where} must be an object`);
  const syntax: CustomSyntaxTheme = { type: mode, tokenColors: [] };
  if (raw.bg != null) {
    if (!isColor(raw.bg)) fail(`${where}.bg is not a valid color`);
    syntax.bg = raw.bg;
  }
  if (raw.fg != null) {
    if (!isColor(raw.fg)) fail(`${where}.fg is not a valid color`);
    syntax.fg = raw.fg;
  }
  if (raw.colors != null) {
    if (!isRecord(raw.colors)) fail(`${where}.colors must be an object`);
    const entries = Object.entries(raw.colors);
    if (entries.length > MAX_SYNTAX_COLORS) fail(`${where}.colors has too many entries`);
    const colors: Record<string, string> = {};
    for (const [key, value] of entries) {
      if (!COLOR_KEY.test(key)) fail(`${where}.colors has an invalid key`);
      if (!isColor(value)) fail(`${where}.colors.${key} is not a valid color`);
      colors[key] = value;
    }
    syntax.colors = colors;
  }
  const rules = raw.tokenColors;
  if (rules != null) {
    if (!Array.isArray(rules)) fail(`${where}.tokenColors must be an array`);
    if (rules.length > MAX_TOKEN_RULES) fail(`${where}.tokenColors has too many rules`);
    syntax.tokenColors = rules.map((rule, i) => {
      const at = `${where}.tokenColors[${i}]`;
      if (!isRecord(rule)) fail(`${at} must be an object`);
      if (!isRecord(rule.settings)) fail(`${at}.settings must be an object`);
      const settings: CustomTokenRule["settings"] = {};
      if (rule.settings.foreground != null) {
        if (!isColor(rule.settings.foreground)) fail(`${at}.settings.foreground is not a color`);
        settings.foreground = rule.settings.foreground;
      }
      if (rule.settings.background != null) {
        if (!isColor(rule.settings.background)) fail(`${at}.settings.background is not a color`);
        settings.background = rule.settings.background;
      }
      if (rule.settings.fontStyle != null) {
        if (!isFontStyle(rule.settings.fontStyle)) fail(`${at}.settings.fontStyle is invalid`);
        settings.fontStyle = rule.settings.fontStyle;
      }
      const scope = parseScopes(rule.scope, at);
      return scope ? { scope, settings } : { settings };
    });
  }
  return syntax;
}

function parseScheme(raw: unknown, mode: Mode): CustomThemeScheme | undefined {
  if (raw == null) return undefined;
  if (!isRecord(raw)) fail(`${mode} must be an object`);
  const scheme: CustomThemeScheme = { palette: parsePalette(raw.palette, `${mode}.palette`) };
  const syntax = parseSyntax(raw.syntax, mode, `${mode}.syntax`);
  if (syntax) scheme.syntax = syntax;
  return scheme;
}

// The one entry point. Returns a NEW payload built only from recognized,
// validated fields — never the caller's object — or a human-readable reason.
export function parseCustomTheme(raw: unknown): ParseResult {
  try {
    if (!isRecord(raw)) fail("payload must be a JSON object");
    if (raw.version !== CUSTOM_THEME_VERSION) {
      fail(`unsupported version (expected ${CUSTOM_THEME_VERSION})`);
    }
    if (raw.id != null && raw.id !== CUSTOM_THEME_ID) fail(`id must be "${CUSTOM_THEME_ID}"`);
    if (typeof raw.label !== "string") fail("label must be a string");
    // Control characters would survive into the theme picker's option text.
    const label = raw.label.trim();
    if (!label || label.length > MAX_LABEL_LENGTH || hasControlChar(label)) {
      fail("label must be 1-64 printable characters");
    }
    const light = parseScheme(raw.light, "light");
    const dark = parseScheme(raw.dark, "dark");
    if (!light && !dark) fail("at least one of light or dark is required");
    const theme: CustomThemePayload = { version: CUSTOM_THEME_VERSION, id: CUSTOM_THEME_ID, label };
    if (light) theme.light = light;
    if (dark) theme.dark = dark;
    return { ok: true, theme };
  } catch (err) {
    if (err instanceof Invalid) return { ok: false, error: err.message };
    throw err;
  }
}

// --- conversion into the theme registry ------------------------------------

// A syntax theme is loaded into the shiki singleton under a name; the REVISION
// is part of that name so new content can never be highlighted with the theme
// object a previous push loaded. See richRender's applyCustomSyntax.
export function customSyntaxName(revision: number, mode: Mode): string {
  return `sideshow-custom-${revision}-${mode}`;
}

// A payload that carries only one scheme themes BOTH schemes from it: a machine
// theme is a single choice, and a workspace that went half-default would look
// broken the moment the OS flipped.
function schemeOr(
  payload: CustomThemePayload,
  mode: Mode,
): { scheme: CustomThemeScheme; from: Mode } {
  const own = payload[mode];
  if (own) return { scheme: own, from: mode };
  const other: Mode = mode === "light" ? "dark" : "light";
  return { scheme: payload[other]!, from: other };
}

// Project the payload onto the `Theme` shape the rest of the app already knows,
// so every consumer (viewerVars, tokenThemeCss, richRender) works unchanged.
export function customThemeToTheme(record: CustomThemeRecord): Theme {
  const fallback = themeById(DEFAULT_THEME_ID);
  const light = schemeOr(record.payload, "light");
  const dark = schemeOr(record.payload, "dark");
  const shikiFor = (resolved: { scheme: CustomThemeScheme; from: Mode }, mode: Mode) =>
    resolved.scheme.syntax
      ? customSyntaxName(record.revision, resolved.from)
      : fallback.shiki[mode];
  return {
    id: CUSTOM_THEME_ID,
    label: record.payload.label,
    shiki: { light: shikiFor(light, "light"), dark: shikiFor(dark, "dark") },
    light: light.scheme.palette,
    dark: dark.scheme.palette,
  };
}

// The syntax themes this record wants loaded, in shiki's registration shape.
export function customSyntaxThemes(
  record: CustomThemeRecord,
): { name: string; theme: Record<string, unknown> }[] {
  const out: { name: string; theme: Record<string, unknown> }[] = [];
  for (const mode of ["light", "dark"] as const) {
    const syntax = record.payload[mode]?.syntax;
    if (!syntax) continue;
    const name = customSyntaxName(record.revision, mode);
    const colors = { ...syntax.colors };
    if (syntax.bg) colors["editor.background"] = syntax.bg;
    if (syntax.fg) colors["editor.foreground"] = syntax.fg;
    out.push({
      name,
      theme: { name, type: syntax.type, colors, tokenColors: syntax.tokenColors },
    });
  }
  return out;
}

// --- persistence -----------------------------------------------------------

export function serializeCustomTheme(record: CustomThemeRecord): string {
  return JSON.stringify(record);
}

// Settings are opaque strings; a corrupt or older-shaped value must degrade to
// "no custom theme", never crash a page render.
export function deserializeCustomTheme(raw: string | null | undefined): CustomThemeRecord | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.revision !== "number") return null;
  const result = parseCustomTheme(parsed.payload);
  if (!result.ok) return null;
  return { revision: parsed.revision, payload: result.theme };
}
