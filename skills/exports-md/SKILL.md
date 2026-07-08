---
name: exports-md
description: Use when a task needs the exported API surface of a TypeScript module or package export map without reading implementation details. Produces agent-friendly Markdown for signatures, exported types, TSDoc, local declaration dependencies, import references, and external re-export statements.
---

# exports-md

Use `exports-md` to get Markdown documentation for a TypeScript module's exported API, or every declaration entry point in a package export map, from declaration emit instead of source implementation.

## Core Contract

Run from the project context whose nearest `node_modules/typescript` should be used:

```sh
exports-md path/to/module.ts
```

The command writes Markdown to stdout. Redirect it only when the user wants an artifact:

```sh
exports-md path/to/module.ts > path/to/module.md
```

Query specific exported symbols with positional names after the module path:

```sh
exports-md path/to/module.ts ExportA ExportB
```

Symbol queries include the requested exports plus local declaration dependencies needed to understand them. Symbol queries are for module inputs, not `package.json` inputs. Imported symbols are represented by their import line unless `--followImports` is used. Module re-exports are represented by their `export ... from` line unless `--followReExports` is used. `--followReExports` also expands bundled patterns that import aliased names from a relative chunk and export those names through a local export list. When following is enabled, only relative imports or re-exports are expanded, while non-relative package references remain reference lines.

Follow relative imported declarations when imported API shape is more useful than import reference lines:

```sh
exports-md path/to/module.ts --followImports
```

Print rendered symbol sections in reverse order when a consumer benefits from bottom-up or newest-last API context:

```sh
exports-md path/to/module.ts --reverseSymbols
```

Print same-module exports by category when a consumer benefits from functions before classes, constants, remaining non-types, and types:

```sh
exports-md path/to/module.ts --sortExports
```

Print same-module exports alphabetically when a consumer benefits from stable symbol names. Lowercase symbols come first, and all-caps symbols come last:

```sh
exports-md path/to/module.ts --sortSymbols
```

Combine sorting options when useful. Reverse order is applied after entity-type and alphabetical sorting:

```sh
exports-md path/to/module.ts --sortExports --sortSymbols --reverseSymbols
```

Render every declaration entry point from a package export map:

```sh
exports-md package.json
```

Package output uses H1 headings based on the package name and export subpath, such as `foo` for `.` and `foo/bar` for `./bar`.

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
- TypeScript diagnostics mean declaration emit failed; fix or report the compile issue rather than treating partial output as authoritative.
- `Export not found` means the requested symbol is not exported by that module under that name.
- Package export-map entries need `types` targets or string `.js`/`.mjs` targets that can be rewritten to `.d.ts`.
