# javascript-module-closure-service

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

The code a computation runs, as one identity: capture a JavaScript module closure, digest and admit it, and execute a program from it.

## Capture supplied source instances

`captureModuleClosure(entry, { resolve })` and
`javascriptProgram(module, exportName, { resolve })` accept the existing module
resolution port, called synchronously as `(specifier, importerFile, mode)`.
Omitting it keeps `javascriptInstalledResolver()` and ordinary installed
import/require selection. A resolver returns a source file, a builtin alias, or
an explicit unresolved reason; the original capture still reads, hashes and
closes every reached byte. Resolver callbacks and labels do not establish
source custody, execution authority, or permission for builtin effects.

`javascriptSourceResolver(packages)` selects source without installation. Each
catalogue entry is `{ root, manifest, bindings? }`; `manifest` must equal the
actual package manifest, and optional `bindings` maps dependency names to
other catalogue roots. The importer is its real package scope. For example:

```js
const resolve = javascriptSourceResolver([
  { root: applicationRoot, manifest: applicationManifest,
    bindings: { library: selectedLibraryRoot } },
  { root: selectedLibraryRoot, manifest: selectedLibraryManifest },
  { root: otherLibraryRoot, manifest: otherLibraryManifest },
]);
const programme = javascriptProgram(entry, "run", { resolve });
```

A unique-name catalogue still needs no bindings and retains its original location
lookup contract, including a genuine importer manifest outside that catalogue.
Implicit lookup does not interpret dependency declaration strings or authenticate
a native selection. Importer-bound catalogues require their actual importer
roots. When an importer supplies a
`bindings` map, that map is closed: an absent name never borrows a global
unique-name instance. Repeated names require an
explicit importer binding: neither a matching version nor catalogue order
selects a package instance. Two real roots with the same name/version remain
distinct module lifetimes and dependency contexts. Self references and private
`#imports` use that importer's actual manifest. Source export conditions use
Node import conditions in authored order and the most-specific export pattern.

This bounded source resolver supports import requests only. A require request
explicitly refuses; it never borrows import conditions or installed fallback.
For explicit bindings, literal exact dependency declarations must equal the
selected manifest's
version across every field that declares that edge; conflicting dependency,
optional, peer or development declarations conservatively refuse rather than
claiming native dependency-field precedence. Ranges and local/workspace forms
are outside the explicit-binding contract and
refuse rather than invoking a new semver solver; this does not narrow the legacy
implicit location lookup. The caller must bind actual native lock selections and authenticate source before capture;
manifest matching alone proves neither. The catalogue is not a package manager
and does not claim the full declared dependency graph has been installed.

Duplicate roots, ambiguous names, wrong-name/version bindings, unlisted binding
roots,
changed manifests encountered during resolution, package path/symlink escapes,
directory imports and unsupported query/fragment module identities refuse, including direct capture
entry URLs. Missing generated paths inside their actual package remain resolvable for source planning; capture
still requires the exact bytes to exist. The entry file itself is independently
selected by the capture caller: a leaf entry makes no resolver call. Catalogue
checks do not authenticate that entry or certify an unchanged whole source tree.
Source-file edits change the captured address rather than being blessed by a catalogue label. Native builtin imports
remain explicit effects in the closure, not a promise of effect confinement.

Captured modules may re-export a body and call
`javascriptProgram(import.meta.url, "bodyExport")`: admitted context is reused
instead of recapturing a query-bearing URL. No parent/specifier API, loader,
import rewriting, artificial installation tree or alternative admission route
is needed. Tool-source editions and captured dependency editions remain
separate: a newer capture tool must not silently substitute its own source
for an older selected runtime dependency under the same package version.

## Addressed execution from within a captured closure

The existing executor can itself occur in captured source. Previously its
`import(moduleUrl(...))` was rejected solely because it had an admitted parent,
even when both executor and target belonged to the same admitted closure.

The original loader now also admits an exact canonical addressed URL for an
already-admitted member of that **same parent closure**. Ordinary specifiers
still use the importing module's recorded import map. Unknown closures/keys,
different closures (even if globally admitted), alternate origins, extra query
parameters and fragments do not acquire an addressed re-entry path. Exact
canonical URLs retain the existing module identity and lifetime.

This deliberately permits intra-closure addressed execution: the closure is a
closed source graph, **not per-module security confinement**. It does not grant
caller or environmental effect authority. Typed Operation admission and actual
consumer receiving remain separate obligations. A captured older executor need
not be rewritten or substituted; same-module re-export plus admitted
`javascriptProgram(import.meta.url, "bodyExport")` retains its existing route.
