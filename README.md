# exports-md

`exports-md` is a small command line tool for inspecting the exported API surface of a TypeScript module or package export map. It compiles a target module to declaration output with the target project's local TypeScript install, then renders the exported declarations, external re-export statements, and TSDoc comments as Markdown.

It is designed for agent-readable API context: enough exported shape to work with a module without loading implementation details.

## Install

Install the CLI in a project:

```sh
pnpm add exports-md
```

Install the companion skill that teaches agents when and how to use `exports-md`:

```sh
npx skills add aleclarson/exports-md/skills
```

## Usage

Print documentation for every exported symbol in a module:

```sh
exports-md src/index.ts
```

Query one or more exported symbols:

```sh
exports-md src/index.ts generateMarkdownForModule findNearestTypescript
```

Print symbol sections in reverse order:

```sh
exports-md src/index.ts --reverseSymbols
```

Write the Markdown to a file with normal shell redirection:

```sh
exports-md src/index.ts generateMarkdownForModule > src/index.md
```

Print documentation for every declaration entry point in a package export map:

```sh
exports-md package.json
```

Package inputs follow relative re-exports to their declarations by default. For a module input, enable the same behavior explicitly:

```sh
exports-md src/index.ts --followReExports
```

Write package entry point docs to an output directory:

```sh
exports-md package.json --outDir docs/api
```

## How it works

`exports-md` resolves the nearest `node_modules/typescript` from the current working directory, so declaration emit uses the TypeScript version installed by the target project.

The tool emits declarations in memory, parses the resulting `.d.ts`, and renders Markdown sections from exported declarations and their leading TSDoc comments. When a symbol query is provided, the output includes requested exports plus local declaration dependencies needed to understand their signatures. With `--reverseSymbols`, rendered symbol sections are printed in reverse order while heading and reference import/re-export blocks stay in place.

When the input is `package.json`, the tool reads the `exports` field and renders each declaration entry point with a separate H1 based on the package name and export subpath, such as `foo` for `.` and `foo/bar` for `./bar`. Export-map entries with `types` targets use those targets. Entries without `types` targets use string `.js` or `.mjs` targets rewritten to `.d.ts`. With `--outDir`, each entry point is written as a `.md` file under the output directory, preserving the entry point folder structure relative to their shared common root.

Imported symbols are not expanded recursively. If a rendered declaration references an imported name, the relevant import line is included in the Markdown output. Module inputs include re-export `export ... from` lines by default. With `--followReExports`, or for package inputs by default, relative re-exports are followed to their declarations; non-relative re-exports are still rendered as reference lines.

Rendered Markdown is cached in the system temp directory using the input path, source content, tsconfig content, requested symbols, heading, package version, and renderer version. Output that follows re-exports is not cached, because it depends on additional declaration files.
