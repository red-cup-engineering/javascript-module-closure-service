import { parseJsonValue } from "@red-cup-engineering/json-services-section/parse-json-value";
import { resolveJsonPointer } from "@red-cup-engineering/json-services-section/resolve-json-pointer";
import { validateJsonSchema } from "@red-cup-engineering/json-schema-services-section/validation";
import moduleParameterizationSchema from "@red-cup-engineering/computer-content-engineering-services-section/module-parameterization-schema" with { type: "json" };
/**
 * The code a computation runs, as one identity: the modules its entries import, followed through
 * relative paths and workspace packages, each named by its package and path within it and digested
 * with its bytes. A dependency installed from a registry is named by its version and not entered.
 *
 * The identity is independent of where the tree sits, so a cache keyed by it survives a release
 * moving the same code to a new directory, and is invalidated by any change to code it reaches.
 * Static imports, re-exports and literal dynamic imports are followed; a computed `import()` is not.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isBuiltin, findPackageJSON, registerHooks, createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalJson } from "@red-cup-engineering/json-services-section";
import { parseJavaScript, walkJavaScript } from "@red-cup-engineering/javascript-parser-service";

const CONDITIONS = ["node", "import", "default"];

function packageOf(file) {
  const manifest = findPackageJSON(pathToFileURL(file));
  return { root: dirname(manifest), manifest: JSON.parse(readFileSync(manifest, "utf8")) };
}

function condition(target, sourceMode, privateTarget = false) {
  if (target === null || typeof target === "string") return target;
  if (privateTarget && typeof target !== "object") throw new TypeError("JavaScript programme cannot admit an invalid private-import target");
  if (Array.isArray(target)) {
    for (const value of target) {
      const chosen = condition(value, sourceMode, privateTarget);
      if (chosen != null) return chosen;
    }
    return null;
  }
  if (privateTarget && Object.keys(target).some(key => String(Number(key)) === key && Number(key) >= 0 && Number(key) < 2 ** 32 - 1)) throw new TypeError("JavaScript programme cannot admit numeric private-import condition keys");
  const conditions = sourceMode === undefined ? CONDITIONS : Object.keys(target).filter(name => ["node", sourceMode, "module-sync", "node-addons", "default"].includes(name));
  for (const name of conditions) if (name in target) {
    const chosen = condition(target[name], sourceMode, privateTarget);
    if (chosen !== undefined) return chosen;
  }
  return undefined;
}

function exported(manifest, subpath, sourceMode) {
  const { exports } = manifest;
  if (exports == null) return subpath === "." ? manifest.main ?? "index.js" : subpath;
  const map = typeof exports === "string" || Array.isArray(exports) || !Object.keys(exports).some((key) => key.startsWith("."))
    ? { ".": exports }
    : exports;
  return mappedTarget(map, subpath, sourceMode);
}

// Package imports are already a #key map; unlike exports they have no root shorthand.
function mappedTarget(map, subpath, sourceMode) {
  if (subpath in map) return condition(map[subpath], sourceMode) ?? null;
  for (const [pattern, target] of Object.entries(map)) {
    const star = pattern.indexOf("*");
    if (star < 0 || !subpath.startsWith(pattern.slice(0, star)) || !subpath.endsWith(pattern.slice(star + 1))) continue;
    const match = subpath.slice(star, subpath.length - (pattern.length - star - 1));
    return condition(target, sourceMode)?.replaceAll("*", match) ?? null;
  }
  return null;
}

// Node chooses the most-specific private pattern before interpreting its target.
// A null or condition-absent winning target never falls through to a broader key.
function privateImportedTarget(map, subpath, sourceMode = "import") {
  if (!subpath.includes("*") && Object.hasOwn(map, subpath)) return condition(map[subpath], sourceMode, true) ?? null;
  const patterns = Object.keys(map).filter(pattern => {
    const star = pattern.indexOf("*");
    return star >= 0 && star === pattern.lastIndexOf("*") && subpath.length >= pattern.length && subpath.startsWith(pattern.slice(0, star)) && subpath.endsWith(pattern.slice(star + 1));
  }).sort((left, right) => right.indexOf("*") - left.indexOf("*") || right.length - left.length);
  const pattern = patterns[0];
  if (pattern === undefined) return null;
  const star = pattern.indexOf("*"), match = subpath.slice(star, subpath.length - (pattern.length - star - 1));
  let segments;
  try { segments = match.split(/[\\/]/u).map(decodeURIComponent); }
  catch { throw new TypeError("JavaScript programme cannot admit malformed private-import pattern match"); }
  if (segments.some(part => [".", "..", "node_modules"].includes(part.toLowerCase()))) throw new TypeError("JavaScript programme cannot admit private-import traversal or installation pattern match");
  return condition(map[pattern], sourceMode, true)?.replaceAll("*", match) ?? null;
}

function packageDirectory(name, from) {
  for (let directory = dirname(from); ; directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", name);
    // Node's getPackageJSONURL selects the nearest package directory, even
    // when it has no manifest. Skipping it would admit a different supplier.
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    if (dirname(directory) === directory) return null;
  }
}

// Node 24's legacyMainResolve sequence applies only to the package root when
// exports is absent. Explicit subpaths and relative ESM imports stay exact.
function installedLegacyMain(root, main) {
  const candidates = typeof main === "string"
    ? ["", ".js", ".json", ".node", "/index.js", "/index.json", "/index.node"].map(suffix => resolve(root, (main || "./") + suffix)) : [];
  candidates.push(...["index.js", "index.json", "index.node"].map(path => join(root, path)));
  return candidates.find(file => existsSync(file) && statSync(file).isFile());
}

function resolveSpecifier(specifier, from, includeInstalled = false, sourceMode, sourcePackages) {
  if (isBuiltin(specifier)) return null;
  if (includeInstalled && sourceMode === "require") {
    try { return { file: createRequire(pathToFileURL(from)).resolve(specifier) }; }
    catch { return { external: `unresolved:${specifier}` }; }
  }
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    let file = resolve(dirname(from), specifier);
    if (!existsSync(file)) {
      // Source admission needs the exact target even before its native producer
      // emits it. Installed execution keeps its ordinary unresolved refusal.
      return sourcePackages === undefined
        ? { external: `unresolved:${relative(packageOf(from).root, file)}` }
        : { file };
    }
    if (includeInstalled && statSync(file).isDirectory()) return { external: `import-directory:${specifier}` };
    return { file: statSync(file).isDirectory() ? join(file, "index.js") : file };
  }
  if (specifier.startsWith("file:")) return { file: fileURLToPath(specifier) };
  if (specifier.startsWith("#")) {
    const { root, manifest } = packageOf(from);
    if (specifier === "#" || specifier.endsWith("/")) return { external: `invalid-private-import:${specifier}` };
    const target = privateImportedTarget(manifest.imports ?? {}, specifier, sourceMode);
    if (target === null) return { external: `unresolved:${specifier}` };
    if (target.startsWith(".")) {
      // A private relative target must stay in this package, just as Node requires.
      let segments;
      try { segments = target.slice(2).split(/[\\/]/u).map(decodeURIComponent); }
      catch { return { external: `invalid-import-target:${specifier}` }; }
      if (!target.startsWith("./") || /%2f|%5c/iu.test(target) || segments.some(part => [".", "..", "node_modules"].includes(part.toLowerCase())))
        return { external: `invalid-import-target:${specifier}` };
      const url = new URL(target, pathToFileURL(root + sep));
      // This reader identifies file bytes, not distinct query/fragment module instances.
      if (url.search || url.hash) return { external: `unsupported-import-url-identity:${specifier}` };
      return { file: fileURLToPath(url) };
    }
    if (target.startsWith("/") || target.startsWith("#") || target.includes("\\") || URL.canParse(target))
      return { external: `invalid-import-target:${specifier}` };
    const packageParts = target.split("/");
    const packageName = target.startsWith("@") ? packageParts.slice(0, 2).join("/") : packageParts[0];
    if (!packageName || packageName.includes("%") || target.startsWith("@") && (!packageParts[0].slice(1) || !packageParts[1]))
      return { external: `invalid-import-target:${specifier}` };
    if (isBuiltin(target)) return { builtin: `node:${target}` };
    return resolveSpecifier(target, join(root, "package.json"), includeInstalled, sourceMode, sourcePackages);
  }
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  // A package may import itself by its own name.
  const own = packageOf(from);
  const directory = own.manifest.name === name && own.manifest.exports != null ? own.root : sourcePackages === undefined ? packageDirectory(name, from) : sourcePackages.get(name)?.root ?? null;
  if (directory === null) return { external: `unresolved:${specifier}` };
  const root = realpathSync(directory);
  const manifestPath = join(root, "package.json");
  const manifest = sourcePackages?.get(name)?.manifest ?? (existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8")) : {});
  if (!includeInstalled && root.split(sep).includes("node_modules")) return { external: `${manifest.name}@${manifest.version}` };
  if (includeInstalled && manifest.exports == null && specifier === name) {
    const file = installedLegacyMain(root, manifest.main);
    return file === undefined ? { external: `unresolved:${specifier}` } : { file };
  }
  const target = exported(manifest, specifier === name ? "." : `./${specifier.slice(name.length + 1)}`, sourceMode);
  return target === null ? { external: `unexported:${specifier}` } : { file: resolve(root, target) };
}

/** Resolve an ESM interface against the admitted source packages, without installation.
 * The caller derives these packages from authenticated Git manifests; this
 * catalogue supplies locations, never substitute export declarations.
 */
export function javascriptSourceResolver(packages) {
  const owners = new Map();
  for (const item of packages) {
    if (!item.manifest?.name || owners.has(item.manifest.name)) throw new TypeError("source interfaces require unique named package owners");
    const root = realpathSync(item.root);
    if (JSON.stringify(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))) !== JSON.stringify(item.manifest)) throw new TypeError("source catalogue differs from actual package manifest");
    owners.set(item.manifest.name, { root, manifest: item.manifest });
  }
  return (specifier, from) => resolveSpecifier(specifier, from, false, "import", owners);
}

/** Resolve installed source without importing or evaluating its programme.
 * Capture and compilation share the same package scope and export selection. */
export function javascriptInstalledResolver() {
  return (specifier, from, mode = "import") => {
    if (!["import", "require"].includes(mode)) throw new TypeError("installed module mode must be import or require");
    return resolveSpecifier(specifier, from, true, mode);
  };
}

function importsOf(file, text, strict = false) {
  if (!/\.[cm]?js$/u.test(file)) return [];
  let program;
  // Source the parser refuses is still digested; it is a leaf of the graph.
  try { program = parseJavaScript(text, { sourceType: "module" }); } catch (error) { if (strict) throw new SyntaxError(`Cannot admit JavaScript source ${file}: ${error.message}`); return []; }
  const specifiers = [];
  walkJavaScript(program, (node) => {
    if (strict && node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "require" && node.arguments?.[0]?.type === "Literal" && typeof node.arguments[0].value === "string") specifiers.push({specifier: node.arguments[0].value, mode: "require"});
    if (node.type === "ImportDeclaration" || ((node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") && node.source)
      || (node.type === "ImportExpression" && node.source?.type === "Literal")) {
      if (typeof node.source.value === "string") specifiers.push(strict ? {specifier: node.source.value, mode: "import"} : node.source.value);
    }
  });
  return specifiers;
}

/**
 * The digest of the module graph reached from `entries` (paths or file URLs), with the number of
 * modules it covers and the registry packages it stops at.
 */
export function moduleClosureDigest(entries) {
  const pending = entries.map((entry) => realpathSync(entry instanceof URL || String(entry).startsWith("file:") ? fileURLToPath(entry) : entry));
  const modules = new Map();
  const external = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    if (modules.has(file)) continue;
    const bytes = readFileSync(file);
    const { root, manifest } = packageOf(file);
    modules.set(file, `${manifest.name ?? relative(dirname(root), root)}/${relative(root, file).split(sep).join("/")}\0${createHash("sha256").update(bytes).digest("hex")}`);
    for (const specifier of importsOf(file, bytes.toString("utf8"))) {
      const resolved = resolveSpecifier(specifier, file);
      if (resolved?.external) external.add(resolved.external);
      else if (resolved?.file) pending.push(realpathSync(resolved.file));
    }
  }
  const hash = createHash("sha256");
  for (const line of [...modules.values()].sort()) hash.update(`${line}\n`);
  for (const name of [...external].sort()) hash.update(`${name}\n`);
  return { digest: hash.digest("hex"), modules: modules.size, external: [...external].sort() };
}

// Unlike the cache digest above, a programme closure carries every reached byte,
// including installed libraries. Its imports are closed; Node builtins are explicit
// environmental effects, not source hidden behind a library version or a verb.
const programmeStateKey = Symbol.for("561.javascript.programme.loader.v1");
const programmeState = globalThis[programmeStateKey] ??= { closures: new Map(), moduleUrls: new Map(), hook: null };
const programmeParameter = "__561_programme";
const moduleParameter = "__561_module";
const byteAddress = (bytes) => `ni:///sha-256;${createHash("sha256").update(bytes).digest("base64url")}`;
const freezeProgramme = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeProgramme(child);
    Object.freeze(value);
  }
  return value;
};
function sourceContext(url) {
  if (!url?.startsWith("file:")) return null;
  const value = new URL(url), known = programmeState.moduleUrls.get(value.href);
  const closure = known?.closure ?? value.searchParams.get(programmeParameter);
  if (!closure) return null;
  const admitted = programmeState.closures.get(closure);
  const key = known?.key ?? value.searchParams.get(moduleParameter);
  if (!admitted || !Object.hasOwn(admitted.body.modules, key)) throw new TypeError("Unadmitted JavaScript programme module");
  return { closure, key, admitted };
}
function moduleUrl(closure, key, admitted) {
  if (admitted.body.modules[key].format === "commonjs") {
    const url = pathToFileURL(resolve("/.561-programmes", closure.slice(closure.lastIndexOf(";") + 1), key)).href;
    programmeState.moduleUrls.set(url, { closure, key });
    return url;
  }
  const url = new URL(admitted.origins[key]);
  url.searchParams.set(programmeParameter, closure);
  url.searchParams.set(moduleParameter, key);
  return url.href;
}
function installProgrammeLoader() {
  if (programmeState.hook) return;
  programmeState.hook = registerHooks({
    resolve(specifier, context, next) {
      const parent = sourceContext(context.parentURL);
      if (!parent) {
        const entry = sourceContext(specifier);
        return entry ? { url: specifier, format: entry.admitted.body.modules[entry.key].format, shortCircuit: true } : next(specifier, context);
      }
      const imports = parent.admitted.body.modules[parent.key].imports;
      const target = context.conditions?.includes("require") ? imports[`require:${specifier}`] ?? imports[specifier] : imports[specifier];
      if (!target) throw new TypeError(`JavaScript programme has no admitted import ${JSON.stringify(specifier)} from ${parent.key}`);
      if (target.startsWith("node:")) return next(target, context);
      return { url: moduleUrl(parent.closure, target, parent.admitted), format: parent.admitted.body.modules[target].format, shortCircuit: true };
    },
    load(url, context, next) {
      const selected = sourceContext(url);
      if (!selected) return next(url, context);
      const module = selected.admitted.body.modules[selected.key];
      const source = Buffer.from(module.source, "base64");
      if (byteAddress(source) !== module.content) throw new TypeError("JavaScript programme source address mismatch");
      return { format: module.format, source, shortCircuit: true };
    },
  });
}

/** Capture imports as data without trusting the ESM cache. Distinct package installations
 * retain their dependency context and module lifetime, even when source bytes coincide. */
export function captureModuleClosure(entry) {
  const start = realpathSync(entry instanceof URL || String(entry).startsWith("file:") ? fileURLToPath(entry) : entry);
  const modules = Object.create(null), origins = Object.create(null), paths = new Map(), packages = new Map(), pending = [start];
  function keyOf(file) {
    if (paths.has(file)) return paths.get(file);
    const { root, manifest } = packageOf(file);
    const packageName = `${manifest.name}@${manifest.version}`;
    const instances = packages.get(packageName) ?? new Map();
    if (!packages.has(packageName)) packages.set(packageName, instances);
    if (!instances.has(root)) instances.set(root, instances.size);
    const instance = instances.get(root);
    const key = `${packageName}${instance === 0 ? "" : `~${instance}`}/${relative(root, file).split(sep).join("/")}`;
    paths.set(file, key);
    return key;
  }
  while (pending.length) {
    const file = pending.pop(), key = keyOf(file);
    const bytes = readFileSync(file), content = byteAddress(bytes);
    if (Object.hasOwn(modules, key)) {
      if (modules[key].content !== content) throw new TypeError(`Different JavaScript sources share package coordinate ${key}`);
      continue;
    }
    const { manifest } = packageOf(file);
    const format = file.endsWith(".json") ? "json" : file.endsWith(".cjs") || file.endsWith(".js") && manifest.type !== "module" ? "commonjs" : "module";
    const imports = Object.create(null);
    modules[key] = { content, format, source: bytes.toString("base64"), imports };
    origins[key] = pathToFileURL(file).href;
    for (const {specifier, mode} of importsOf(file, bytes.toString("utf8"), true)) {
      const requestKey = mode === "require" ? `require:${specifier}` : specifier;
      if (isBuiltin(specifier)) {
        imports[requestKey] = specifier.startsWith("node:") ? specifier : `node:${specifier}`;
        continue;
      }
      const target = resolveSpecifier(specifier, file, true, mode);
      if (target?.builtin) { imports[requestKey] = target.builtin; continue; }
      if (!target?.file) throw new TypeError(`JavaScript programme cannot admit ${specifier} from ${key}: ${target?.external ?? "missing source"}`);
      const resolved = realpathSync(target.file);
      imports[requestKey] = keyOf(resolved);
      pending.push(resolved);
    }
  }
  // Convert the null-prototype capture maps to the ordinary JSON carrier.
  // The receiver performs canonical admission and retains the programme graph.
  const body = JSON.parse(JSON.stringify({ kind: "javascript.module-closure.v1", entry: keyOf(start), modules }));
  const id = byteAddress(Buffer.from(canonicalJson(body)));
  admitModuleClosure(id, body, origins);
  return Object.freeze({ id, body: moduleClosureMaterial(id) });
}

/** Admit transported source material. Host origin paths are bindings, never code identity. */
export function admitModuleClosure(id, material, originBindings = {}) {
  const body = freezeProgramme(JSON.parse(canonicalJson(material)));
  if (byteAddress(Buffer.from(canonicalJson(body))) !== id || body.kind !== "javascript.module-closure.v1"
    || !Object.hasOwn(body.modules ?? {}, body.entry)) throw new TypeError("JavaScript programme closure address mismatch");
  const origins = Object.create(null);
  for (const [key, module] of Object.entries(body.modules)) {
    if (!key || key.startsWith("/") || key.split("/").some(segment => segment === "." || segment === ".." || segment === "")) throw new TypeError("Invalid JavaScript programme package coordinate");
    if (!["module", "commonjs", "json"].includes(module.format) || byteAddress(Buffer.from(module.source, "base64")) !== module.content)
      throw new TypeError("JavaScript programme source address mismatch");
    for (const target of Object.values(module.imports)) {
      if (!Object.hasOwn(body.modules, target) && !(target.startsWith("node:") && isBuiltin(target)))
        throw new TypeError("JavaScript programme import leaves its admitted closure");
    }
    origins[key] = originBindings[key] ?? pathToFileURL(resolve("/.561-programmes", id.slice(id.lastIndexOf(";") + 1), key)).href;
  }
  if (!programmeState.closures.has(id)) programmeState.closures.set(id, Object.freeze({ body, origins: Object.freeze(origins) }));
  installProgrammeLoader();
  return id;
}

/** A callable export of exact admitted bytes; no callback or verb selects its implementation. */
export function javascriptProgram(module, exportName) {
  if (typeof exportName !== "string" || !exportName) throw new TypeError("JavaScript programme requires a callable export name");
  const context = sourceContext(String(module));
  const closure = context ? { id: context.closure, body: context.admitted.body } : captureModuleClosure(module);
  return Object.freeze({ kind: "jsnode", closure: closure.id, module: context?.key ?? closure.body.entry, export: exportName });
}
export function moduleClosureMaterial(id) {
  const admitted = programmeState.closures.get(id);
  if (!admitted) throw new TypeError("Unadmitted JavaScript programme closure");
  return admitted.body;
}
export async function executeJavascriptProgram(programme, input, arguments_, context) {
  const admitted = programmeState.closures.get(programme.closure);
  if (programme.kind !== "jsnode" || !admitted || !Object.hasOwn(admitted.body.modules, programme.module))
    throw new TypeError("Unadmitted JavaScript programme");
  const module = await import(moduleUrl(programme.closure, programme.module, admitted));
  const callable = module[programme.export];
  if (typeof callable !== "function") throw new TypeError("JavaScript programme export is not callable");
  return callable(input, arguments_, context);
}

/** Exact canonical bytes for native NI publication. */
export function moduleClosureBytes(id) {
  const bytes = Buffer.from(canonicalJson(moduleClosureMaterial(id)));
  if (byteAddress(bytes) !== id) throw new TypeError("JavaScript programme closure address mismatch");
  return bytes;
}

function moduleParameterizationShape(value, definition) {
  const schema = { ...moduleParameterizationSchema, $ref: "#/$defs/" + definition };
  delete schema.oneOf;
  const judgment = validateJsonSchema(value, schema);
  if (!judgment.valid) throw new TypeError("Invalid module parameterization " + definition + ": " + JSON.stringify(judgment.issues));
  return value;
}

function freezeModuleParameterData(value, depth = 0) {
  if (depth > 64) throw new RangeError("Module parameterization data exceeds depth 64");
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeModuleParameterData(child, depth + 1);
    Object.freeze(value);
  }
  return value;
}

function bindModuleParameterValue(value, parameters, depth = 0) {
  if (depth > 64) throw new RangeError("Module parameterization data exceeds depth 64");
  if (value === null || typeof value !== "object") return value;
  if (!Array.isArray(value) && Object.hasOwn(value, "$parameter")) {
    if (Object.keys(value).length !== 1 || typeof value.$parameter !== "string"
      || !Object.hasOwn(parameters, value.$parameter))
      throw new TypeError("Module parameterization has an undeclared parameter");
    return bindModuleParameterValue(parameters[value.$parameter], Object.create(null), depth + 1);
  }
  return Array.isArray(value)
    ? value.map(item => bindModuleParameterValue(item, parameters, depth + 1))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bindModuleParameterValue(item, parameters, depth + 1)]));
}

/** Admit declaration grammar without reading data or importing any programme. */
export function admitModuleParameterizationSources(sources) {
  if (!Array.isArray(sources) || sources.length > 200)
    throw new TypeError("Module parameterization requires at most 200 declared sources");
  for (const source of sources) {
    const judgment = validateJsonSchema(source, moduleParameterizationSchema);
    if (!judgment.valid) throw new TypeError("Invalid module parameterization source declaration");
  }
  return sources;
}

/** Read and bind JSON source data only. The host imports its selected factories later.
 * Source custody never grants effect authority. One invocation snapshots all referenced
 * data before returning; it neither edits source nor opens a runtime programme.
 */
export async function readModuleParameterizations(sources, {
  moduleBasePath, sourceDocument, readFile = file => readFileSync(file),
} = {}) {
  admitModuleParameterizationSources(sources);
  const require = createRequire(moduleBasePath);
  const document = sourceDocument === undefined ? undefined
    : freezeModuleParameterData(structuredClone(sourceDocument));
  const records = new Map(), digests = new Map();
  let sourceBytes = 0;
  const readDataRef = async reference => {
    moduleParameterizationShape(reference, "dataRef");
    const file = require.resolve(reference.module);
    if (!file.endsWith(".json")) throw new TypeError("DataRef must resolve a package JSON data export");
    if (digests.has(file) && digests.get(file) !== reference.sha256)
      throw new TypeError("One module parameterization cannot select conflicting source digests");
    digests.set(file, reference.sha256);
    if (!records.has(file)) records.set(file, (async () => {
      const bytes = await readFile(file);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > 1024 * 1024)
        throw new TypeError("DataRef requires at most one MiB of exact JSON source bytes");
      sourceBytes += bytes.byteLength;
      if (sourceBytes > 8 * 1024 * 1024) throw new RangeError("Module parameterization source exceeds eight MiB");
      if (createHash("sha256").update(bytes).digest("hex") !== reference.sha256)
        throw new TypeError("DataRef source digest differs");
      return freezeModuleParameterData(parseJsonValue(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    })());
    const record = await records.get(file);
    if (record === null || typeof record !== "object" || Array.isArray(record)
      || (record.id ?? record.$id) !== reference.record)
      throw new TypeError("DataRef record identity differs");
    const value = reference.pointer === undefined ? record : resolveJsonPointer(record, reference.pointer);
    if (value === undefined) throw new TypeError("DataRef pointer is absent");
    return value;
  };
  const resolved = await Promise.all(sources.map(async entry => {
    if (!Object.hasOwn(entry, "dataRef"))
      return { ...entry, configuration: bindModuleParameterValue(structuredClone(entry.configuration ?? {}), Object.create(null)) };
    const descriptor = await readDataRef(entry.dataRef);
    moduleParameterizationShape(descriptor, "descriptor");
    const names = [...descriptor.parameters].sort(), supplied = Object.keys(entry.parameters).sort();
    if (JSON.stringify(names) !== JSON.stringify(supplied))
      throw new TypeError("Module parameterization must bind exactly its declared parameters");
    if (JSON.stringify(Object.keys(descriptor.parameterSchemas).sort()) !== JSON.stringify(names))
      throw new TypeError("Module parameterization requires one Data model for every parameter");
    const parameters = Object.create(null);
    await Promise.all(names.map(async name => {
      const reference = entry.parameters[name];
      if (Object.hasOwn(reference, "instancePointer")) {
        moduleParameterizationShape(reference, "instancePointer");
        if (document === undefined) throw new TypeError("Instance pointer requires the admitted source document");
        const value = resolveJsonPointer(document, reference.instancePointer);
        if (value === undefined) throw new TypeError("Module parameterization instance pointer is absent");
        parameters[name] = structuredClone(value);
      } else parameters[name] = await readDataRef(reference);
      if (descriptor.parameterSchemas?.[name] !== undefined) {
        const schema = await readDataRef(descriptor.parameterSchemas[name]);
        if (!validateJsonSchema(parameters[name], schema).valid)
          throw new TypeError("Module parameterization parameter is outside its declared Data model");
      }
    }));
    const configuration = bindModuleParameterValue(descriptor.configuration, parameters);
    if (configuration === null || typeof configuration !== "object" || Array.isArray(configuration))
      throw new TypeError("Module parameterization configuration must resolve to an object");
    return { module: descriptor.module, export: descriptor.export, configuration };
  }));
  return freezeModuleParameterData(resolved);
}
