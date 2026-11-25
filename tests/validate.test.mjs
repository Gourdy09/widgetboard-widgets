import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, rmSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { validateManifest, validatePackage, validateRegistry, LIMITS } from "../tools/validate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const example = JSON.parse(readFileSync(join(ROOT, "examples/hello-clock/manifest.json"), "utf8"));
const clone = (m) => structuredClone(m);
const mut = (fn) => { const m = clone(example); fn(m); return m; };

/* ---------- manifest cases: [name, manifest, expected problem substring | null] ---------- */
const cases = [
  ["the reference widget is valid", example, null],
  ["minimal manifest is valid", { schema_version: 1, id: "alice.tiny", name: "Tiny", version: "0.1.0", description: "d", author: "alice", license: "MIT", category: "other", requires: { api: 1 }, entry: "w.js", size: { default: [1, 1] } }, null],
  ["secret + network permission is valid", mut((m) => {
    m.id = "alice.weather"; delete m.settings; delete m.aliases;
    m.settings = { apiKey: { type: "secret", label: "API key", required: true }, city: { type: "string", label: "City", default: "Pittsburgh" } };
    m.permissions = { network: ["api.openweathermap.org"] };
  }), null],
  ["combobox with a custom default is valid", mut((m) => { m.settings = { sym: { type: "combobox", label: "Symbol", options: ["AAPL", "MSFT"], default: "TSLA" } }; }), null],
  ["custom elements are valid", mut((m) => { m.elements = [{ key: "price", label: "Price" }, { key: "chart", label: "Chart" }]; }), null],
  ["legacy alias is valid", mut((m) => { m.aliases = ["ticker"]; }), null],
  ["github-style namespace with digits and hyphens is valid", mut((m) => { m.id = "gourdy-09.hello-clock"; }), null],

  ["unknown top-level field", mut((m) => { m.runtime = "module"; }), "additional"],
  ["missing id", mut((m) => { delete m.id; }), "id"],
  ["id: upper case", mut((m) => { m.id = "Alice.Clock"; }), "pattern"],
  ["id: no namespace", mut((m) => { m.id = "clock"; }), "pattern"],
  ["id: path characters", mut((m) => { m.id = "../x.y"; }), "pattern"],
  ["id: reserved namespace core", mut((m) => { m.id = "core.clock"; }), "reserved"],
  ["id: reserved namespace wb", mut((m) => { m.id = "wb.clock"; }), "reserved"],
  ["version: two parts", mut((m) => { m.version = "1.0"; }), "pattern"],
  ["version: v prefix", mut((m) => { m.version = "v1.0.0"; }), "pattern"],
  ["version: pre-release", mut((m) => { m.version = "1.0.0-beta"; }), "pattern"],
  ["version: leading zero", mut((m) => { m.version = "01.0.0"; }), "pattern"],
  ["license missing", mut((m) => { delete m.license; }), "license"],
  ["category not in list", mut((m) => { m.category = "weird"; }), "allowed values"],
  ["homepage not https", mut((m) => { m.homepage = "http://example.com"; }), "pattern"],
  ["requires.api missing", mut((m) => { m.requires = {}; }), "api"],
  ["requires.api zero", mut((m) => { m.requires.api = 0; }), ">= 1"],
  ["entry: parent directory", mut((m) => { m.entry = "../widget.js"; }), "pattern"],
  ["entry: absolute path", mut((m) => { m.entry = "/etc/widget.js"; }), "pattern"],
  ["entry: not a .js file", mut((m) => { m.entry = "widget.ts"; }), "pattern"],
  ["entry: upper case", mut((m) => { m.entry = "Widget.js"; }), "pattern"],
  ["entry: backslash", mut((m) => { m.entry = "a\\b.js"; }), "pattern"],
  ["entry: empty path segment", mut((m) => { m.entry = "a//b.js"; }), "pattern"],
  ["entry: URL", mut((m) => { m.entry = "https://evil.example/x.js"; }), "pattern"],
  ["styles: not css", mut((m) => { m.styles = "widget.js"; }), "pattern"],
  ["size.default zero", mut((m) => { m.size.default = [0, 1]; }), ">= 1"],
  ["size.default too big", mut((m) => { m.size.default = [25, 1]; }), "<= 24"],
  ["size.default fractional", mut((m) => { m.size.default = [1.5, 1]; }), "integer"],
  ["size.default one number", mut((m) => { m.size.default = [1]; }), "fewer than 2"],
  ["size.min above default", mut((m) => { m.size.min = [3, 1]; }), "larger than size.default"],
  ["size.default above max", mut((m) => { m.size.max = [1, 1]; }), "larger than size.max"],
  ["refresh below 1 second", mut((m) => { m.refresh = { default: 500 }; }), ">= 1000"],
  ["refresh default below min", mut((m) => { m.refresh = { default: 2000, min: 5000 }; }), "below refresh.min"],
  ["setting key not camelCase", mut((m) => { m.settings = { "Bad-Key": { type: "string", label: "x" } }; }), "pattern"],
  ["setting: unknown type", mut((m) => { m.settings = { c: { type: "colour", label: "x" } }; }), "unknown type"],
  ["setting: select without options", mut((m) => { m.settings = { s: { type: "select", label: "x" } }; }), "options"],
  ["setting: select default not an option", mut((m) => { m.settings = { s: { type: "select", label: "x", options: ["a", "b"], default: "c" } }; }), "not one of the options"],
  ["setting: duplicate option values", mut((m) => { m.settings = { s: { type: "select", label: "x", options: ["a", "a"] } }; }), "duplicate"],
  ["setting: secret with a default", mut((m) => { m.settings = { k: { type: "secret", label: "x", default: "hunter2" } }; }), "default"],
  ["setting: number min above max", mut((m) => { m.settings = { n: { type: "number", label: "x", min: 5, max: 1 } }; }), "min is larger"],
  ["setting: number default out of range", mut((m) => { m.settings = { n: { type: "number", label: "x", min: 1, max: 5, default: 9 } }; }), "outside"],
  ["setting: default longer than maxLength", mut((m) => { m.settings = { s: { type: "string", label: "x", maxLength: 3, default: "abcd" } }; }), "longer than maxLength"],
  ["setting: label missing", mut((m) => { m.settings = { s: { type: "string" } }; }), "label"],
  ["setting: extra field", mut((m) => { m.settings = { s: { type: "string", label: "x", pattern: ".*" } }; }), "pattern"],
  ["more than 20 settings", mut((m) => { m.settings = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`s${i}`, { type: "boolean", label: "x" }])); }), "more than 20"],
  ["permission: IP address", mut((m) => { m.permissions = { network: ["192.168.1.10"] }; }), "pattern"],
  ["permission: localhost", mut((m) => { m.permissions = { network: ["localhost"] }; }), "pattern"],
  ["permission: wildcard", mut((m) => { m.permissions = { network: ["*.example.com"] }; }), "pattern"],
  ["permission: port", mut((m) => { m.permissions = { network: ["example.com:8080"] }; }), "pattern"],
  ["permission: URL instead of host", mut((m) => { m.permissions = { network: ["https://example.com"] }; }), "pattern"],
  ["permission: upper case host", mut((m) => { m.permissions = { network: ["Example.com"] }; }), "pattern"],
  ["permission: unknown capability", mut((m) => { m.permissions = { filesystem: true }; }), "additional"],
  ["elements: duplicate keys", mut((m) => { m.elements = [{ key: "a", label: "A" }, { key: "a", label: "B" }]; }), "duplicate keys"],
  ["elements: bad key", mut((m) => { m.elements = [{ key: "A-1", label: "A" }]; }), "pattern"],
  ["alias repeats the name", mut((m) => { m.aliases = ["hello-clock"]; }), "repeats"],
  ["alias with a dot", mut((m) => { m.aliases = ["a.b"]; }), "pattern"],
  ["schema_version 2", mut((m) => { m.schema_version = 2; }), "constant"],
];

for (const [name, manifest, expected] of cases) {
  test(`manifest: ${name}`, () => {
    const problems = validateManifest(manifest);
    if (expected === null) assert.deepEqual(problems, []);
    else assert.ok(problems.some((p) => p.includes(expected)), `expected a problem containing "${expected}", got:\n${problems.join("\n") || "(none)"}`);
  });
}

test("manifest: the id must match the folder it lives in", () => {
  assert.deepEqual(validateManifest(example, { expectedId: "example.hello-clock" }).filter((p) => p.includes("match its folder")), []);
  assert.ok(validateManifest(mut((m) => { m.id = "alice.clock"; }), { expectedId: "bob.clock" }).some((p) => p.includes("match its folder")));
});
test("manifest: the example namespace is not publishable", () => {
  assert.ok(validateManifest(example, { expectedId: "example.hello-clock" }).some((p) => p.includes("only for the reference widgets")));
});

// Shared with the Go installer: the same vectors must give the same accept/reject answers there.
test("conformance vectors are up to date", () => {
  const file = join(ROOT, "tests/conformance/manifests.json");
  const generated = cases.map(([name, manifest, expected]) => ({ name, valid: expected === null, manifest }));
  if (process.env.WRITE_CONFORMANCE) writeFileSync(file, JSON.stringify(generated, null, 2) + "\n");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), generated, "run: WRITE_CONFORMANCE=1 npm test");
});

/* ---------- packages on disk ---------- */

function pkg(fn) {
  const dir = mkdtempSync(join(tmpdir(), "wbw-pkg-"));
  cpSync(join(ROOT, "examples/hello-clock"), dir, { recursive: true });
  fn?.(dir);
  return dir;
}
const check = (fn, opts) => { const d = pkg(fn); try { return validatePackage(d, opts); } finally { rmSync(d, { recursive: true, force: true }); } };
const w = (dir, name, body = "x") => writeFileSync(join(dir, name), body);

test("package: the reference widget is valid", () => assert.deepEqual(check(), []));
test("package: missing manifest", () => assert.deepEqual(check((d) => rmSync(join(d, "manifest.json"))), ["manifest.json is missing"]));
test("package: manifest is not JSON", () => assert.match(check((d) => w(d, "manifest.json", "{nope"))[0], /not valid JSON/));
test("package: entry file missing", () => assert.ok(check((d) => rmSync(join(d, "widget.js"))).some((p) => p.includes('entry "widget.js" is not in the package'))));
test("package: styles file missing", () => assert.ok(check((d) => rmSync(join(d, "widget.css"))).some((p) => p.includes("styles"))));
test("package: syntax error in the entry", () => assert.ok(check((d) => w(d, "widget.js", "export default {{")).some((p) => p.includes("syntax error"))));
test("package: upper-case file name", () => assert.ok(check((d) => w(d, "Extra.js")).some((p) => p.includes("Extra.js"))));
test("package: hidden file", () => assert.ok(check((d) => w(d, ".env", "SECRET=1")).some((p) => p.includes(".env"))));
test("package: file name with a space", () => assert.ok(check((d) => w(d, "a b.js")).some((p) => p.includes("a b.js"))));
test("package: disallowed file type", () => assert.ok(check((d) => w(d, "run.exe")).some((p) => p.includes("not allowed"))));
test("package: html is not allowed", () => assert.ok(check((d) => w(d, "page.html", "<script>")).some((p) => p.includes("not allowed"))));
test("package: empty file", () => assert.ok(check((d) => w(d, "empty.txt", "")).some((p) => p.includes("is empty"))));
test("package: file over the size limit", () => assert.ok(check((d) => w(d, "big.json", "a".repeat(LIMITS.maxFileBytes + 1))).some((p) => p.includes("big.json is"))));
test("package: total over the size limit", () => assert.ok(check((d) => { for (let i = 0; i < 4; i++) w(d, `d${i}.json`, "a".repeat(LIMITS.maxFileBytes - 10)); }).some((p) => p.includes("package is"))));
test("package: too many files", () => assert.ok(check((d) => { for (let i = 0; i < 25; i++) w(d, `f${i}.txt`); }).some((p) => p.includes("max 25"))));
test("package: symbolic link", () => assert.ok(check((d) => symlinkSync("/etc/passwd", join(d, "link.txt"))).some((p) => p.includes("symbolic link"))));
test("package: file in a hidden folder", () => assert.ok(check((d) => { mkdirSync(join(d, ".git")); w(d, ".git/config", "[core]"); }).some((p) => p.includes(".git"))));
test("package: id must match the folder", () => assert.ok(check(undefined, { expectedId: "alice.other" }).some((p) => p.includes("match its folder"))));

/* ---------- registry ---------- */

const sha = "a".repeat(64);
const version = (over = {}) => ({
  version: "1.0.0", requires: { api: 1 }, commit: "b".repeat(40), path: "widgets/alice/clock",
  files: [{ path: "manifest.json", sha256: sha, size: 500 }, { path: "widget.js", sha256: sha, size: 900 }], published: "2026-01-05", ...over,
});
const entry = (over = {}) => ({ id: "alice.clock", name: "Clock", description: "d", author: "alice", category: "time", latest: "1.0.0", versions: [version()], ...over });
const reg = (...widgets) => ({ schema_version: 1, name: "t", description: "t", repo: "Gourdy09/widgetboard-widgets", widgets });
const rcases = [
  ["empty registry is valid", reg(), null],
  ["one widget is valid", reg(entry()), null],
  ["two versions, latest is newest", reg(entry({ latest: "1.1.0", versions: [version(), version({ version: "1.1.0" })] })), null],
  ["yanked old version is fine", reg(entry({ latest: "1.1.0", versions: [version({ yanked: true }), version({ version: "1.1.0" })] })), null],
  ["commit is a branch name", reg(entry({ versions: [version({ commit: "main" })] })), "pattern"],
  ["commit is abbreviated", reg(entry({ versions: [version({ commit: "abc1234" })] })), "pattern"],
  ["sha256 wrong length", reg(entry({ versions: [version({ files: [{ path: "manifest.json", sha256: "abc", size: 5 }] })] })), "pattern"],
  ["file path escapes", reg(entry({ versions: [version({ files: [{ path: "../x.js", sha256: sha, size: 5 }] })] })), "pattern"],
  ["file over 1 MiB", reg(entry({ versions: [version({ files: [{ path: "manifest.json", sha256: sha, size: 1048577 }] })] })), "<= 1048576"],
  ["manifest.json not listed", reg(entry({ versions: [version({ files: [{ path: "widget.js", sha256: sha, size: 5 }] })] })), "must include manifest.json"],
  ["path does not match id", reg(entry({ versions: [version({ path: "widgets/bob/clock" })] })), "does not match the id"],
  ["path outside widgets/", reg(entry({ versions: [version({ path: "../../etc" })] })), "pattern"],
  ["latest not in versions", reg(entry({ latest: "9.9.9" })), "not in versions"],
  ["latest is not the newest", reg(entry({ latest: "1.0.0", versions: [version(), version({ version: "1.1.0" })] })), "not the newest"],
  ["latest is yanked", reg(entry({ versions: [version({ yanked: true })] })), "yanked"],
  ["same widget listed twice", reg(entry(), entry()), "listed twice"],
  ["duplicate versions", reg(entry({ versions: [version(), version()] })), "duplicate versions"],
  ["no versions", reg(entry({ versions: [] })), "fewer than 1"],
  ["repo is a URL", { ...reg(), repo: "https://github.com/x/y" }, "pattern"],
  ["unknown field", { ...reg(), extra: 1 }, "additional"],
];
for (const [name, r, expected] of rcases) {
  test(`registry: ${name}`, () => {
    const problems = validateRegistry(r);
    if (expected === null) assert.deepEqual(problems, []);
    else assert.ok(problems.some((p) => p.includes(expected)), `expected "${expected}", got:\n${problems.join("\n") || "(none)"}`);
  });
}
test("registry: the committed registry.json is valid", () => assert.deepEqual(validateRegistry(JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8"))), []));
