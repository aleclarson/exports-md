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
`types` targets use those declarations; string `.js` or `.mjs` targets are
rewritten to `.d.ts`. Non-code entries such as `./package.json` are skipped.

Write each package entry to its own Markdown file when another tool needs a
directory tree:

```bash
exports-md package.json --outDir docs/api
```

After the command finishes, `docs/api` preserves the entry-point folder
structure relative to the entries' shared root.

## Next Steps

Read [Choose Output](guides/select-output.md) to focus or reorganize the result.
Use [Human Defaults](guides/human-defaults.md) when interactive invocations
should consistently use the same options.
