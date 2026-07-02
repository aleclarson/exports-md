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

Symbol queries include the requested exports plus local declaration dependencies needed to understand them. Symbol queries are for module inputs, not `package.json` inputs. Imported symbols are represented by their import line only, and external re-exports are represented by their `export ... from` line only; do not expect `exports-md` to recursively expand imported or re-exported modules.

Render every declaration entry point from a package export map:

```sh
exports-md package.json
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
- If output is stale or surprising, rerun the command from the intended project root. The tool caches rendered Markdown by input path, source content, tsconfig content, requested symbols, heading, package version, and renderer version.

## Failure Modes

If the command fails, inspect the error before falling back:

- Missing local TypeScript install means the target project needs `node_modules/typescript` reachable from the working directory.
- TypeScript diagnostics mean declaration emit failed; fix or report the compile issue rather than treating partial output as authoritative.
- `Export not found` means the requested symbol is not exported by that module under that name.
- Package export-map entries need `types` targets or string `.js`/`.mjs` targets that can be rewritten to `.d.ts`.
