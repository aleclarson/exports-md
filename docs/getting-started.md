# Getting Started

> Install the command, inspect one public API, and verify the Markdown before
> choosing more detailed output controls.

## Install

Add `exports-md` to the TypeScript project whose API you want to inspect:

```bash
pnpm add exports-md
```

The target project also needs its own TypeScript installation. The command walks
upward from the current working directory and uses the nearest
`node_modules/typescript`.

## Inspect A Module

Run the command from the target project and pass a TypeScript source or
declaration file:

```bash
exports-md src/index.ts
```

The Markdown is written to standard output. A successful result starts with a
heading for the input and contains a section for each exported symbol.

Write that result to a file only when you need an artifact:

```bash
exports-md src/index.ts > src/index.md
```

## Inspect A Package

Pass a package manifest to render every supported entry in its `exports` map:

```bash
exports-md package.json
```

A package directory is shorthand for its manifest:

```bash
exports-md .
exports-md packages/example
```

Package inputs follow relative imports and re-exports by default. Entries with
`types` targets use those declarations; string `.js`, `.mjs`, or `.cjs` targets
are rewritten to the matching declaration extension. A top-level `types` or
`typings` field supplies the root declaration when the export map has no
`types` condition. Wildcard targets are expanded against package files and
rendered with their concrete export subpaths. Non-code entries such as
`./package.json` are skipped.

Write each package entry to its own Markdown file when another tool needs a
directory tree:

```bash
exports-md package.json --outDir docs/api
```

After the command finishes, `docs/api` preserves the entry-point folder
structure relative to the entries' shared root.

## Inspect A Published Package

Use an npm package name with an optional version, tag, or version range when
the package is not installed in the current project:

```bash
exports-md qubu@0.4.2 @qubu/adapter-libsql@0.4.2 --follow
```

`exports-md` fetches each package tarball with npm, extracts it temporarily,
and removes the temporary files after rendering. It does not add packages,
dependencies, or lockfiles to the current project. `--follow` expands relative
declarations inside the fetched package; imports from other packages remain
reference lines. The current project still needs a reachable
`node_modules/typescript` installation.

## Next Steps

Read [Choose Output](guides/select-output.md) to focus or reorganize the result.
Use [Human Defaults](guides/human-defaults.md) when interactive invocations
should consistently use the same options.
