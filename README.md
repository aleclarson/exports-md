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
exports-md src/index.ts -- generateMarkdownForModule findNearestTypescript
```

Print documentation for multiple inputs:

```sh
exports-md src/index.ts src/feature.ts
```

Print symbol sections in reverse order:

```sh
exports-md src/index.ts -r
```

Render property TSDoc comments below declaration code blocks as a `**Properties**` list:

```sh
exports-md src/index.ts --property-docs list
```

Write the Markdown to a file with normal shell redirection:

```sh
exports-md src/index.ts -- generateMarkdownForModule > src/index.md
```

Print documentation for every declaration entry point in a package export map:

```sh
exports-md package.json
```

Package inputs follow relative imports and re-exports to their declarations by default. For a module input, enable either behavior explicitly:

```sh
exports-md src/index.ts -f
exports-md src/index.ts -i
exports-md src/index.ts -e
```

Write package entry point docs to an output directory:

```sh
exports-md package.json -o docs/api
```

## How it works

`exports-md` resolves the nearest `node_modules/typescript` from the current working directory, so declaration emit uses the TypeScript version installed by the target project.

The tool emits declarations in memory, parses the resulting `.d.ts`, and renders Markdown sections from exported declarations and their leading TSDoc comments. Property TSDoc comments stay inside declaration code blocks by default. With `--property-docs list`, property comments are removed from interface and object type code blocks and rendered below the block as a `**Properties**` list. When a symbol query is provided, the output includes requested exports plus local declaration dependencies needed to understand their signatures. With `--reverseSymbols`, rendered symbol sections are printed in reverse order while heading and reference import/re-export blocks stay in place.

When the input is `package.json`, the tool reads the `exports` field and renders each declaration entry point with a separate H1 based on the package name and export subpath, such as `foo` for `.` and `foo/bar` for `./bar`. Export-map entries with `types` targets use those targets. Entries without `types` targets use string `.js` or `.mjs` targets rewritten to `.d.ts`. With `--outDir`, each entry point is written as a `.md` file under the output directory, preserving the entry point folder structure relative to their shared common root.

Module inputs include import and re-export reference lines by default. With `--follow`, relative imports and re-exports are followed to their declarations. With `--followImports`, or for package inputs by default, relative imports referenced by rendered declarations are followed to their declarations. With `--followReExports`, or for package inputs by default, relative re-exports are followed to their declarations, including bundled patterns that import aliased names from a relative chunk and export those names through a local export list. Non-relative package imports, non-relative package re-exports, and namespace imports/re-exports are still rendered as reference lines.

Rendered Markdown is cached in the system temp directory using the input path, source content, tsconfig content, requested symbols, heading, package version, and renderer version. Output that follows imports or re-exports is not cached, because it depends on additional declaration files.
