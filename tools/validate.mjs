#!/usr/bin/env node
// Validates widget packages and the registry against docs/WIDGET_SPEC.md.
//   node tools/validate.mjs package <dir>     one package (a folder containing manifest.json)
//   node tools/validate.mjs registry [file]   the registry (default: registry.json)
//   node tools/validate.mjs all               every package in widgets/ and examples/, plus registry.json
//
// JSON Schema (schema/*.json) checks structure. This file adds the rules a schema cannot express. The
// WidgetBoard installer must apply the same rules; tests/conformance/ holds shared test cases for that.
import { readFileSync, readdirSync, lstatSync, existsSync, mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { join, relative, extname, basename, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---- limits (the installer enforces the same numbers) ----
export const LIMITS = {
  maxFiles: 25,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 3 * 1024 * 1024,
  maxManifestBytes: 64 * 1024,
  extensions: [".json", ".js", ".css", ".svg", ".png", ".jpg", ".webp", ".woff2", ".md", ".txt"],
  reservedNamespaces: ["core", "wb", "widgetboard"], // never publishable
  exampleNamespace: "example", // allowed only for the reference widgets in examples/
};
const FILE_PATH = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/;

const load = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
const manifestSchema = load("schema/manifest.schema.json");
const registrySchema = load("schema/registry.schema.json");
ajv.addSchema(manifestSchema);
const checkManifest = ajv.compile(manifestSchema);
const checkRegistry = ajv.compile(registrySchema);
const settingChecks = Object.fromEntries(
  ["string", "text", "number", "boolean", "select", "combobox", "secret"].map((t) => [t, ajv.compile({ $ref: `${manifestSchema.$id}#/$defs/setting_${t}` })]),
);

const fmt = (e) => `${e.instancePath || "/"} ${e.message}${e.params?.additionalProperty ? ` ("${e.params.additionalProperty}")` : ""}`;
const optionValue = (o) => (typeof o === "string" ? o : o.value);
const cmpSemver = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };

/* ---------- manifest ---------- */

// Returns a list of problems (empty = valid). `expectedId` is the id implied by the package's folder.
export function validateManifest(m, { expectedId = null } = {}) {
  const problems = [];
  let errors = [];
  if (!checkManifest(m)) errors = checkManifest.errors;

  // A setting that matches none of the seven shapes gives a wall of oneOf noise; report against its own type instead.
  const settingErrors = errors.filter((e) => e.instancePath.startsWith("/settings/"));
  for (const e of errors.filter((e) => !settingErrors.includes(e))) problems.push(fmt(e));
  const reported = new Set();
  for (const e of settingErrors) {
    const key = e.instancePath.split("/")[2];
    if (reported.has(key)) continue;
    reported.add(key);
    const s = m.settings[key];
    const check = settingChecks[s?.type];
    if (!check) problems.push(`/settings/${key} has an unknown type "${s?.type}"`);
    else if (!check(s)) for (const se of check.errors) problems.push(`/settings/${key}${se.instancePath} ${se.message}${se.params?.additionalProperty ? ` ("${se.params.additionalProperty}")` : ""}`);
  }
  if (problems.length) return problems; // structure first: the checks below assume the right shape

  const [ns, name] = m.id.split(".");
  if (LIMITS.reservedNamespaces.includes(ns)) problems.push(`namespace "${ns}" is reserved`);
  if (expectedId && ns === LIMITS.exampleNamespace) problems.push(`namespace "${ns}" is only for the reference widgets in examples/`);
  if (expectedId && m.id !== expectedId) problems.push(`id "${m.id}" must match its folder (${expectedId})`);
  for (const a of m.aliases ?? []) if (a === name) problems.push(`alias "${a}" repeats the widget name`);

  // size: min <= default <= max, per axis
  const min = m.size.min ?? [1, 1];
  const max = m.size.max ?? [24, 24];
  for (const axis of [0, 1]) {
    const label = axis === 0 ? "columns" : "rows";
    if (min[axis] > m.size.default[axis]) problems.push(`size.min ${label} (${min[axis]}) is larger than size.default (${m.size.default[axis]})`);
    if (m.size.default[axis] > max[axis]) problems.push(`size.default ${label} (${m.size.default[axis]}) is larger than size.max (${max[axis]})`);
  }

  if (m.refresh?.min !== undefined && m.refresh.default < m.refresh.min) problems.push(`refresh.default (${m.refresh.default}) is below refresh.min (${m.refresh.min})`);

  for (const [key, s] of Object.entries(m.settings ?? {})) {
    const at = `settings.${key}`;
    if (s.type === "select" || s.type === "combobox") {
      const values = s.options.map(optionValue);
      if (new Set(values).size !== values.length) problems.push(`${at}.options has duplicate values`);
      if (s.default !== undefined && !values.includes(s.default) && !(s.type === "combobox" && s.allowCustom !== false)) problems.push(`${at}.default "${s.default}" is not one of the options`);
    }
    if (s.type === "number") {
      if (s.min !== undefined && s.max !== undefined && s.min > s.max) problems.push(`${at}.min is larger than max`);
      if (s.default !== undefined && ((s.min !== undefined && s.default < s.min) || (s.max !== undefined && s.default > s.max))) problems.push(`${at}.default is outside min..max`);
    }
    if ((s.type === "string" || s.type === "text") && s.default !== undefined && s.maxLength !== undefined && s.default.length > s.maxLength) problems.push(`${at}.default is longer than maxLength`);
  }

  if (m.elements) {
    const keys = m.elements.map((e) => e.key);
    if (new Set(keys).size !== keys.length) problems.push("elements has duplicate keys");
  }
  return problems;
}

/* ---------- package (a folder on disk) ---------- */

function listFiles(dir, base = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const st = lstatSync(full);
    const rel = relative(base, full).split("\\").join("/");
    if (st.isSymbolicLink()) out.push({ rel, symlink: true });
    else if (st.isDirectory()) listFiles(full, base, out);
    else out.push({ rel, size: st.size, full });
  }
  return out;
}

export function validatePackage(dir, { expectedId = null } = {}) {
  const problems = [];
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) return ["manifest.json is missing"];
  if (lstatSync(manifestPath).size > LIMITS.maxManifestBytes) return [`manifest.json is larger than ${LIMITS.maxManifestBytes} bytes`];
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); } catch (e) { return [`manifest.json is not valid JSON: ${e.message}`]; }
  problems.push(...validateManifest(manifest, { expectedId }));

  const files = listFiles(dir);
  if (files.length > LIMITS.maxFiles) problems.push(`package has ${files.length} files (max ${LIMITS.maxFiles})`);
  const seen = new Set();
  let total = 0;
  for (const f of files) {
    if (f.symlink) { problems.push(`${f.rel} is a symbolic link`); continue; }
    if (!FILE_PATH.test(f.rel)) problems.push(`${f.rel}: file names must be lower-case letters, digits, . _ - (no leading dot, no spaces)`);
    if (!LIMITS.extensions.includes(extname(f.rel))) problems.push(`${f.rel}: file type "${extname(f.rel) || "(none)"}" is not allowed`);
    if (f.size > LIMITS.maxFileBytes) problems.push(`${f.rel} is ${f.size} bytes (max ${LIMITS.maxFileBytes})`);
    if (f.size === 0) problems.push(`${f.rel} is empty`);
    if (seen.has(f.rel.toLowerCase())) problems.push(`${f.rel} collides with another file on case-insensitive file systems`);
    seen.add(f.rel.toLowerCase());
    total += f.size ?? 0;
  }
  if (total > LIMITS.maxTotalBytes) problems.push(`package is ${total} bytes (max ${LIMITS.maxTotalBytes})`);

  for (const field of ["entry", "styles"]) {
    if (typeof manifest[field] === "string" && !files.some((f) => f.rel === manifest[field])) problems.push(`${field} "${manifest[field]}" is not in the package`);
  }

  // Syntax check only. This catches broken uploads; it is NOT a security review and proves nothing about behaviour.
  const entry = files.find((f) => f.rel === manifest.entry);
  if (entry && !problems.some((p) => p.startsWith("entry"))) {
    const tmp = mkdtempSync(join(tmpdir(), "wbw-"));
    try {
      const copy = join(tmp, "entry.mjs");
      copyFileSync(entry.full, copy);
      const r = spawnSync(process.execPath, ["--check", copy], { encoding: "utf8" });
      if (r.status !== 0) problems.push(`entry ${manifest.entry} has a syntax error: ${r.stderr.split("\n").find((l) => l.includes("Error")) ?? "see node --check"}`);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
  return problems;
}

/* ---------- registry ---------- */

export function validateRegistry(reg) {
  if (!checkRegistry(reg)) return checkRegistry.errors.map(fmt);
  const problems = [];
  const ids = new Set();
  for (const w of reg.widgets) {
    if (ids.has(w.id)) problems.push(`${w.id}: listed twice`);
    ids.add(w.id);
    const versions = w.versions.map((v) => v.version);
    if (new Set(versions).size !== versions.length) problems.push(`${w.id}: duplicate versions`);
    const [ns, name] = w.id.split(".");
    const live = w.versions.filter((v) => !v.yanked).map((v) => v.version).sort(cmpSemver);
    if (!versions.includes(w.latest)) problems.push(`${w.id}: latest ${w.latest} is not in versions`);
    else if (live.length && w.latest !== live[live.length - 1]) problems.push(`${w.id}: latest ${w.latest} is not the newest non-yanked version (${live[live.length - 1]})`);
    if (w.versions.find((v) => v.version === w.latest)?.yanked) problems.push(`${w.id}: latest ${w.latest} is yanked`);
    for (const v of w.versions) {
      const at = `${w.id}@${v.version}`;
      if (v.path !== `widgets/${ns}/${name}`) problems.push(`${at}: path ${v.path} does not match the id`);
      if (!v.files.some((f) => f.path === "manifest.json")) problems.push(`${at}: files must include manifest.json`);
      const lower = v.files.map((f) => f.path.toLowerCase());
      if (new Set(lower).size !== lower.length) problems.push(`${at}: duplicate file paths`);
      if (v.files.reduce((n, f) => n + f.size, 0) > LIMITS.maxTotalBytes) problems.push(`${at}: package is larger than ${LIMITS.maxTotalBytes} bytes`);
    }
  }
  return problems;
}

/* ---------- CLI ---------- */

function report(label, problems) {
  if (!problems.length) { console.log(`\u2713 ${label}`); return 0; }
  console.log(`\u2717 ${label}`);
  for (const p of problems) console.log(`    - ${p}`);
  return 1;
}

function main() {
  const [cmd, arg] = process.argv.slice(2);
  let failed = 0;
  if (cmd === "package" && arg) {
    const dir = resolve(arg);
    const parts = relative(ROOT, dir).split("\\").join("/").split("/");
    const expectedId = parts[0] === "widgets" && parts.length === 3 ? `${parts[1]}.${parts[2]}` : null;
    failed += report(arg, validatePackage(dir, { expectedId }));
  } else if (cmd === "registry") {
    failed += report(arg ?? "registry.json", validateRegistry(JSON.parse(readFileSync(resolve(arg ?? join(ROOT, "registry.json")), "utf8"))));
  } else if (cmd === "all") {
    for (const base of ["widgets", "examples"]) {
      const dir = join(ROOT, base);
      if (!existsSync(dir)) continue;
      const pkgDirs = base === "widgets"
        ? readdirSync(dir).filter((n) => lstatSync(join(dir, n)).isDirectory()).flatMap((ns) => readdirSync(join(dir, ns)).map((n) => join(dir, ns, n)))
        : readdirSync(dir).map((n) => join(dir, n)).filter((p) => lstatSync(p).isDirectory());
      for (const p of pkgDirs) {
        const rel = relative(ROOT, p).split("\\").join("/");
        const parts = rel.split("/");
        failed += report(rel, validatePackage(p, { expectedId: base === "widgets" ? `${parts[1]}.${parts[2]}` : null }));
      }
    }
    failed += report("registry.json", validateRegistry(JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8"))));
  } else {
    console.log("Usage: node tools/validate.mjs package <dir> | registry [file] | all");
    process.exit(2);
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
