// Bundles feedback/capture.ts (plus @plannotator/web-highlighter) into a single
// self-contained IIFE and writes it to server/feedbackCaptureBundle.ts as a
// string constant.
//
// Why a COMMITTED generated module rather than a runtime file read: the server
// has to stay runtime-agnostic — server/surfacePage.ts runs inside a Durable
// Object, where there is no filesystem and no `node:fs`. And why not a CDN:
// the rich-surface CSP deliberately has no CDN and no `connect-src`, and
// widening it to load a highlighter would weaken the isolation the whole
// feature depends on. So the bundle ships as source.
//
// test/feedbackCapture.test.ts rebuilds it and asserts the committed file is
// byte-identical, so the artifact cannot drift from its sources.

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url);
export const BUNDLE_PATH = fileURLToPath(new URL("server/feedbackCaptureBundle.ts", root));
const ENTRY = fileURLToPath(new URL("feedback/capture.ts", root));

const HEADER = `// GENERATED FILE — do not edit.
//
// Built from feedback/capture.ts by scripts/buildFeedbackCapture.ts
// (\`npm run build:feedback-capture\`). A bare string export so it stays
// runtime-agnostic: no filesystem, no \`node:\` imports, safe on a Durable Object.
//
// This script is injected into a sandboxed surface document ONLY when it is
// served in feedback mode (\`?fb=1\`). See server/surfacePage.ts.

/* oxlint-disable */
export const FEEDBACK_CAPTURE_JS =`;

/** The exact text server/feedbackCaptureBundle.ts should contain. */
export async function buildFeedbackCaptureModule(): Promise<string> {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    minify: true,
    format: "iife",
    target: ["es2020"],
    platform: "browser",
    legalComments: "none",
    write: false,
  });
  const code = result.outputFiles[0]!.text.trim();
  // The bundle is injected between <script> tags, so no substring of it may
  // close that element early.
  const safe = code.replace(/<\/script/gi, String.raw`<\/script`);
  const source = `${HEADER}\n  ${JSON.stringify(safe)};\n`;
  // Run it through the repo formatter here rather than hoping the emitted text
  // already matches: `format:check` and the pre-commit hook both format this
  // file, and either one rewriting it would make the committed artifact look
  // stale on the very next run.
  return format(source);
}

function format(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sideshow-fb-"));
  const file = join(dir, "feedbackCaptureBundle.ts");
  try {
    writeFileSync(file, source);
    execFileSync(fileURLToPath(new URL("node_modules/.bin/oxfmt", root)), ["--write", file], {
      stdio: "ignore",
    });
    return readFileSync(file, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = await buildFeedbackCaptureModule();
  writeFileSync(BUNDLE_PATH, source);
  process.stdout.write(`feedback capture bundle: ${source.length} bytes of module source\n`);
}
