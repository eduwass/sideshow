import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CUSTOM_THEME_ID,
  CUSTOM_THEME_VERSION,
  type CustomThemePayload,
  customSyntaxName,
  customSyntaxThemes,
  customThemeToTheme,
  deserializeCustomTheme,
  isColor,
  parseCustomTheme,
  serializeCustomTheme,
} from "../server/customTheme.ts";
import { DEFAULT_THEME_ID, themeById, themeOptions } from "../server/themes.ts";

const accent = (bg: string) => ({ bg, text: "#112233", border: "rgba(1, 2, 3, 0.5)" });

// A minimal palette that satisfies every required key, parameterized by one
// colour so a test can prove which push produced a render.
const palette = (bg: string) => ({
  bg,
  panel: "#222222",
  surface: "#333333",
  text: "#ffffff",
  muted: "#cccccc",
  faint: "#999999",
  border: "#444444",
  border2: "#555555",
  hover: "rgba(255, 255, 255, 0.1)",
  info: accent("#001122"),
  success: accent("#002200"),
  warning: accent("#222200"),
  danger: accent("#220000"),
});

const payload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: CUSTOM_THEME_VERSION,
  label: "Monotheme",
  dark: { palette: palette("#000000") },
  ...over,
});

const ok = (raw: unknown): CustomThemePayload => {
  const result = parseCustomTheme(raw);
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  return (result as { ok: true; theme: CustomThemePayload }).theme;
};

const rejects = (raw: unknown, match: RegExp) => {
  const result = parseCustomTheme(raw);
  assert.equal(result.ok, false, "expected the payload to be rejected");
  assert.match((result as { ok: false; error: string }).error, match);
};

test("isColor accepts only hex and numeric rgb()/rgba()", () => {
  for (const good of ["#fff", "#ffff", "#a1b2c3", "#a1b2c3d4", "rgb(1,2,3)", "rgba(1, 2, 3, 0.25)"])
    assert.equal(isColor(good), true, good);
  for (const bad of [
    "red",
    "var(--bg)",
    "url(http://x/y)",
    "#12345",
    "#ggg",
    "rgb(1,2)",
    "rgba(1,2,3,2)",
    "#fff;background:url(x)",
    "expression(alert(1))",
    42,
    null,
    undefined,
    {},
  ])
    assert.equal(isColor(bad), false, String(bad));
});

test("the version is required and must match exactly", () => {
  rejects(payload({ version: undefined }), /unsupported version/);
  rejects(payload({ version: CUSTOM_THEME_VERSION + 1 }), /unsupported version/);
  rejects(payload({ version: String(CUSTOM_THEME_VERSION) }), /unsupported version/);
  assert.equal(ok(payload()).version, CUSTOM_THEME_VERSION);
});

test("a non-object payload is rejected rather than coerced", () => {
  for (const bad of [null, undefined, "theme", 7, [payload()]])
    rejects(bad, /must be a JSON object/);
});

test("the id, when present, must be the single custom id", () => {
  rejects(payload({ id: "github" }), /id must be/);
  assert.equal(ok(payload({ id: CUSTOM_THEME_ID })).id, CUSTOM_THEME_ID);
  // Absent is fine — the parser fills it in, so the stored payload is canonical.
  assert.equal(ok(payload()).id, CUSTOM_THEME_ID);
});

test("the label must be short, printable, non-empty text", () => {
  rejects(payload({ label: 12 }), /label must be a string/);
  rejects(payload({ label: "   " }), /printable/);
  rejects(payload({ label: "x".repeat(65) }), /printable/);
  rejects(payload({ label: "Mono\u0007theme" }), /printable/);
  assert.equal(ok(payload({ label: "  Monotheme  " })).label, "Monotheme");
});

test("at least one color scheme is required", () => {
  rejects(payload({ dark: undefined }), /at least one of light or dark/);
  rejects(payload({ dark: "dark" }), /must be an object/);
});

test("every palette colour is validated, and unknown keys never survive", () => {
  rejects(
    payload({ dark: { palette: palette("blue") } }),
    /dark\.palette\.bg is not a valid color/,
  );
  rejects(payload({ dark: { palette: "x" } }), /dark\.palette must be an object/);
  const missing = palette("#000000") as Record<string, unknown>;
  delete missing.hover;
  rejects(payload({ dark: { palette: missing } }), /dark\.palette\.hover/);
  rejects(
    payload({ dark: { palette: { ...palette("#000000"), info: "#fff" } } }),
    /dark\.palette\.info must be an object/,
  );
  rejects(
    payload({ dark: { palette: { ...palette("#000000"), danger: accent("nope") } } }),
    /dark\.palette\.danger\.bg is not a valid color/,
  );
  const parsed = ok(payload({ dark: { palette: { ...palette("#000000"), evil: "url(x)" } } }));
  assert.equal("evil" in (parsed.dark!.palette as unknown as Record<string, unknown>), false);
});

test("syntax theme data is validated field by field", () => {
  const syntax = (over: Record<string, unknown>) =>
    payload({ dark: { palette: palette("#000000"), syntax: over } });
  rejects(syntax("x" as never), /dark\.syntax must be an object/);
  rejects(syntax({ bg: "chartreuse" }), /dark\.syntax\.bg is not a valid color/);
  rejects(syntax({ fg: "chartreuse" }), /dark\.syntax\.fg is not a valid color/);
  rejects(syntax({ colors: [] }), /dark\.syntax\.colors must be an object/);
  rejects(syntax({ colors: { "editor background": "#fff" } }), /colors has an invalid key/);
  rejects(syntax({ colors: { "editor.background": "wat" } }), /colors\.editor\.background/);
  rejects(
    syntax({ colors: Object.fromEntries([...Array(801)].map((_, i) => [`k${i}`, "#fff"])) }),
    /colors has too many entries/,
  );
  rejects(syntax({ tokenColors: {} }), /tokenColors must be an array/);
  rejects(
    syntax({ tokenColors: [...Array(2001)].map(() => ({ settings: {} })) }),
    /too many rules/,
  );
  rejects(syntax({ tokenColors: ["keyword"] }), /tokenColors\[0\] must be an object/);
  rejects(syntax({ tokenColors: [{}] }), /tokenColors\[0\]\.settings must be an object/);
  rejects(
    syntax({ tokenColors: [{ settings: { foreground: "hotpink" } }] }),
    /settings\.foreground is not a color/,
  );
  rejects(
    syntax({ tokenColors: [{ settings: { background: "hotpink" } }] }),
    /settings\.background is not a color/,
  );
  rejects(
    syntax({ tokenColors: [{ settings: { fontStyle: "blink" } }] }),
    /settings\.fontStyle is invalid/,
  );
  rejects(
    syntax({ tokenColors: [{ scope: "key<word>", settings: {} }] }),
    /contains an invalid scope/,
  );
  rejects(syntax({ tokenColors: [{ scope: [7], settings: {} }] }), /contains an invalid scope/);
  rejects(
    syntax({ tokenColors: [{ scope: "x".repeat(201), settings: {} }] }),
    /contains an invalid scope/,
  );
  rejects(
    syntax({ tokenColors: [{ scope: [...Array(65)].map(() => "a"), settings: {} }] }),
    /has too many scopes/,
  );

  const good = ok(
    syntax({
      bg: "#101010",
      fg: "#f0f0f0",
      colors: { "editor.selectionBackground": "#202020" },
      tokenColors: [
        { scope: "keyword", settings: { foreground: "#ff0000", fontStyle: "bold italic" } },
        { settings: {} },
      ],
    }),
  );
  assert.equal(good.dark!.syntax!.type, "dark");
  assert.deepEqual(good.dark!.syntax!.tokenColors[0].scope, ["keyword"]);
  assert.equal(good.dark!.syntax!.tokenColors[1].scope, undefined);
});

test("a payload carrying one scheme themes both, keeping its own syntax names", () => {
  const record = { revision: 3, payload: ok(payload({ dark: { palette: palette("#0a0a0a") } })) };
  const theme = customThemeToTheme(record);
  assert.equal(theme.id, CUSTOM_THEME_ID);
  assert.equal(theme.label, "Monotheme");
  assert.equal(theme.light.bg, "#0a0a0a");
  assert.equal(theme.dark.bg, "#0a0a0a");
  // No syntax data was pushed, so both schemes fall back to bundled shiki names.
  const fallback = themeById(DEFAULT_THEME_ID);
  assert.deepEqual(theme.shiki, fallback.shiki);
});

test("syntax data produces revision-scoped shiki names on both schemes", () => {
  const record = {
    revision: 7,
    payload: ok(
      payload({
        light: { palette: palette("#ffffff"), syntax: { tokenColors: [] } },
        dark: { palette: palette("#000000"), syntax: { bg: "#010101", fg: "#fefefe" } },
      }),
    ),
  };
  const theme = customThemeToTheme(record);
  assert.equal(theme.shiki.light, customSyntaxName(7, "light"));
  assert.equal(theme.shiki.dark, customSyntaxName(7, "dark"));
  assert.equal(theme.light.bg, "#ffffff");
  assert.equal(theme.dark.bg, "#000000");

  const loaded = customSyntaxThemes(record);
  assert.deepEqual(
    loaded.map((t) => t.name),
    [customSyntaxName(7, "light"), customSyntaxName(7, "dark")],
  );
  const darkColors = loaded[1].theme.colors as Record<string, string>;
  assert.equal(darkColors["editor.background"], "#010101");
  assert.equal(darkColors["editor.foreground"], "#fefefe");
  assert.equal(loaded[1].theme.type, "dark");
  // A scheme mirrored from the other one reuses that scheme's loaded name, so a
  // one-scheme push never names a theme nothing ever loads.
  const single = {
    revision: 9,
    payload: ok(payload({ dark: { palette: palette("#000000"), syntax: {} } })),
  };
  assert.equal(customThemeToTheme(single).shiki.light, customSyntaxName(9, "dark"));
  assert.equal(customSyntaxThemes(single).length, 1);
});

test("the record survives a round trip and a corrupt one degrades to nothing", () => {
  const record = { revision: 2, payload: ok(payload()) };
  assert.deepEqual(deserializeCustomTheme(serializeCustomTheme(record)), record);
  for (const bad of [
    null,
    undefined,
    "",
    "{not json",
    "[]",
    JSON.stringify({ payload: record.payload }),
    JSON.stringify({ revision: 1, payload: { version: 99 } }),
  ])
    assert.equal(deserializeCustomTheme(bad), null, String(bad));
});

test("the registry resolves a custom theme only under its own id", () => {
  const custom = customThemeToTheme({ revision: 1, payload: ok(payload()) });
  assert.equal(themeById(CUSTOM_THEME_ID, custom).label, "Monotheme");
  assert.equal(themeById("github", custom).id, "github");
  // Without the record in hand the id is unknown, so the default still wins —
  // this is why nothing is held in module state.
  assert.equal(themeById(CUSTOM_THEME_ID).id, DEFAULT_THEME_ID);
  assert.equal(
    themeOptions().some((t) => t.id === CUSTOM_THEME_ID),
    false,
  );
  assert.equal(themeOptions(custom).at(-1)?.id, CUSTOM_THEME_ID);
  assert.equal(
    themeOptions(null).some((t) => t.id === CUSTOM_THEME_ID),
    false,
  );
});
