---
title: CLI Reference
---

# CLI Reference

> Look up command syntax, defaults, side effects, conflicts, and failures for
> scripts or interactive use.

Examples assume the command is on `PATH`. With a project-local installation,
use `pnpm exec exports-md` as shown in [Getting started](../getting-started.md).

## Syntax

```text
exports-md [...input] [options] -- [...symbol]
```

At least one input is required. Inputs can be TypeScript modules, declaration
files, package manifests, package directories, or npm registry package specs.
Existing local paths are used first; a missing package-like input is fetched
with npm. Put optional exported symbol names after the `--` delimiter.

For example, inspect several published packages without installing them into
the current project:

```bash
exports-md qubu@0.4.2 @qubu/adapter-libsql@0.4.2 @qubu/better-auth@0.4.2 --follow
```

Remote inputs require `npm` on `PATH`. They are unpacked in a temporary
directory, and their dependencies are not installed. `--follow` follows only
relative declarations inside each fetched package; non-relative package
imports remain reference lines.

## Package Resolution

A package entry point is an import path exposed to consumers. The `exports` map
in `package.json` describes those paths and their target files.

Package inputs follow relative imports and re-exports by default. Entries with
`types` targets use those declarations; string `.js`, `.mjs`, or `.cjs` targets
are rewritten to the matching declaration extension.

For the root entry, a top-level `types` or `typings` field takes precedence over
inferred JavaScript declaration targets when the root export has neither a
`types` condition nor an explicit declaration or TypeScript source target.
For example, `"exports": "./api.d.ts"` uses `api.d.ts` even if top-level `types`
names another file. Without an `exports` field, `types` or `typings` supplies
the root entry.

Wildcard targets are expanded against package files and rendered with their
concrete export subpaths. Non-code entries such as `./package.json` are skipped.

The command uses the nearest `node_modules/typescript` found by walking upward
from the current working directory. Published packages require `npm` on `PATH`;
their tarballs are extracted temporarily and removed after rendering.

For `.tsrx` source entry points or local imports, install
`@tsrx/typescript-plugin` and the target compiler selected by the project's
`tsrx.compiler` configuration. `exports-md` invokes `tsrx-tsc` with a temporary
declaration output directory. When `target` is omitted, declaration emit uses
ES2022; an explicit target or `lib` remains in effect.

## Options

| Option                             | Default  | Description                                                                                |
| ---------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `--outDir <dir>`, `-o <dir>`       | unset    | Write separate package-entry Markdown files under `dir`. Only valid for one package input. |
| `--pipe <command>`                 | unset    | Send generated Markdown to an executable's standard input.                                 |
| `--follow`, `-f`                   | `false`  | Follow relative imports and re-exports.                                                    |
| `--followImports`, `-i`            | `false`  | Follow relative imported declarations.                                                     |
| `--followReExports`, `-e`          | `false`  | Follow relative re-exported declarations.                                                  |
| `--github.repository <owner/repo>` | unset    | Set the repository used by generated GitHub links.                                         |
| `--github.searchLinks`             | `false`  | Append a GitHub code-search link to each symbol section.                                   |
| `--propertyDocs <inline\|list>`    | `inline` | Keep property TSDoc in code or move it below declarations.                                 |
| `--groupBySyntax`, `-g`            | `false`  | Group same-module symbols by declaration category.                                         |
| `--sortByName`, `-s`               | `false`  | Sort same-module symbols alphabetically.                                                   |
| `--reverseSymbols`, `-r`           | `false`  | Reverse rendered symbol sections after sorting.                                            |
| `--help`, `-h`                     | —        | Print command help.                                                                        |

For callers not identified as agents, values from
`~/.config/exports-md.json` replace the defaults in this table. Explicit CLI
values take precedence. See [Personal Defaults](../guides/human-defaults.md).

## Section Ordering

The ordering options apply in this order:

1. `--groupBySyntax` groups functions, classes, constants, other non-types, and
   types.
2. `--sortByName` sorts symbols within that structure, with lowercase names
   first and all-caps names last.
3. `--reverseSymbols` reverses the rendered symbol sections after sorting.

## Output Destinations

With neither `--outDir` nor `--pipe`, the command writes one Markdown stream to
standard output. Shell redirection can capture it:

```bash
exports-md src/index.ts > api.md
```

`--outDir` is limited to a single package input. `--pipe` works with module or
package output but cannot be combined with `--outDir`.

## Failure Cases

| Message or symptom                             | Cause                                                                             | Next action                                                                                |
| ---------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `At least one input is required.`              | No module, manifest, or directory was provided.                                   | Add an input before any options or `--`.                                                   |
| `Module not found`                             | The resolved module path does not exist.                                          | Check the working directory and input path.                                                |
| `Could not fetch npm package`                  | npm could not resolve or download a registry package spec, or npm is unavailable. | Check the package spec, registry access, and that `npm` is on `PATH`.                      |
| `Fetched npm package ... has no package.json.` | The downloaded archive is not a package archive.                                  | Verify the package source and version.                                                     |
| `Could not find node_modules/typescript`       | No TypeScript installation is reachable from the working directory.               | Install TypeScript in the target workspace or run from the intended project.               |
| TypeScript diagnostics                         | Declaration emit failed.                                                          | Fix the reported type or configuration errors before retrying.                             |
| `Export not found`                             | A requested symbol is not exported under that name.                               | Check the public export name or omit the symbol filter.                                    |
| `--outDir is only supported...`                | The output-directory mode was used with a module or multiple inputs.              | Use one package input or redirect the combined stream.                                     |
| `--pipe cannot be used with --outDir`          | Both output modes were selected, including through human config.                  | Choose one output destination; remove a conflicting personal default from the config file. |
| Child command exits nonzero                    | The executable passed to `--pipe` failed.                                         | Run that executable directly and inspect its standard error.                               |

The command does not emit partial Markdown after a generation error.
