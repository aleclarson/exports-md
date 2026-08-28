---
name: exports-md
description: Use when a task needs the exported API surface of a TypeScript module or package export map without reading implementation details. Produces agent-friendly Markdown for signatures, exported types, TSDoc, local declaration dependencies, import references, and external re-export statements.
---

# exports-md

Use `exports-md` to get Markdown documentation for a TypeScript module's exported API, every declaration entry point in a package export map, or a published npm package, from declaration emit instead of source implementation.

## Core Contract

Run from the project context whose nearest `node_modules/typescript` should be used:

```sh
exports-md path/to/module.ts
```

Inspect published npm packages without installing them into the current
project:

```sh
exports-md package@1.2.3 @scope/adapter@1.2.3 --follow
```

Local files and directories take precedence. A missing package-like input is
fetched with npm into a temporary directory, and the temporary package is
removed after rendering. Package dependencies are not installed, and `npm`
must be available on `PATH`.

The command writes Markdown to stdout. Redirect it only when the user wants an artifact:

```sh
exports-md path/to/module.ts > path/to/module.md
```

Query specific exported symbols after the `--` delimiter. Everything before
`--` is an input path, and everything after it is a symbol filter. The
delimiter is required even when there is only one input:

```sh
exports-md path/to/module.ts -- ExportA ExportB
```

Symbol queries include the requested exports plus local declaration dependencies needed to understand them. They work for module inputs and package inputs, with package results checked across their declaration entry points. Imported symbols are represented by their import line unless `--followImports` is used. Module re-exports are represented by their `export ... from` line unless `--followReExports` is used. `--followReExports` also expands bundled patterns that import aliased names from a relative chunk and export those names through a local export list. When following is enabled, only relative imports or re-exports are expanded, while non-relative package references remain reference lines.

Follow relative imported declarations when imported API shape is more useful than import reference lines:

```sh
exports-md path/to/module.ts --followImports
```

Print rendered symbol sections in reverse order when a consumer benefits from bottom-up or newest-last API context:

```sh
exports-md path/to/module.ts --reverseSymbols
```

Print same-module exports by category when a consumer benefits from functions before classes, constants, remaining non-types, and types. Each category is rendered as an H2 group, and each symbol in a group is rendered as an H3:

```sh
exports-md path/to/module.ts --groupBySyntax
```

Print same-module exports alphabetically when a consumer benefits from stable symbol names. Lowercase symbols come first, and all-caps symbols come last:

```sh
exports-md path/to/module.ts --sortByName
```

Combine sorting options when useful. Reverse order is applied after entity-type and alphabetical sorting:

```sh
exports-md path/to/module.ts --groupBySyntax --sortByName --reverseSymbols
```

Render every declaration entry point from a package export map:

```sh
exports-md package.json
```

Package output uses H1 headings based on the package name and export subpath, such as `foo` for `.` and `foo/bar` for `./bar`. Wildcard export targets are expanded against package files and use concrete export subpaths.

Package manifests may be local paths or fetched npm package specs. Fetched
packages use their published files and export metadata, including a top-level
`types` or `typings` field for the root declaration when no export-map `types`
condition exists. `--follow` expands only relative files within the fetched
package; it never installs or recursively fetches package dependencies.

Package inputs follow relative imports and re-exports to their declarations by default. For module inputs, opt in when imported or re-exported declarations are more useful than the reference statements:

```sh
exports-md path/to/module.ts --followImports
exports-md path/to/module.ts --followReExports
```

Write package entry docs to a directory when an artifact tree is useful:

```sh
exports-md package.json --outDir docs/api
```

## Standards

- Prefer `exports-md` before reading implementation when the task is about public API shape, exported types, function signatures, or TSDoc-derived documentation.
- Treat the output as API context, not behavioral proof. Read source or tests when implementation behavior, side effects, runtime control flow, or invariants matter.
- Keep output in conversation context when possible. Write a file only when the user asks for one or when another tool needs a path.
- Use symbol queries for focused work to avoid loading unrelated API surface.
- If output is stale or surprising, rerun the command from the intended project root. The tool caches rendered Markdown by input path, source content, tsconfig content, requested symbols, heading, package version, and renderer version. Output that follows imports or re-exports is not cached.

## Failure Modes

If the command fails, inspect the error before falling back:

- Missing local TypeScript install means the target project needs `node_modules/typescript` reachable from the working directory.
- Missing npm or an unresolved package spec means the remote package could not be fetched; check npm availability, registry access, and the package name/version.
- TypeScript diagnostics mean declaration emit failed; fix or report the compile issue rather than treating partial output as authoritative.
- `Export not found` means the requested symbol is not exported by that module under that name.
- Package export-map entries need declaration targets, top-level `types`/`typings` for the root, or string `.js`/`.mjs`/`.cjs` targets that can be rewritten to declarations.
