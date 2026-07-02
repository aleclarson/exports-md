# exports-md

`exports-md` is a small command line tool for inspecting the exported API surface of a TypeScript module. It compiles a target module to declaration output with the target project's local TypeScript install, then renders the exported declarations, external re-export statements, and TSDoc comments as Markdown.

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

Write the Markdown to a file with normal shell redirection:

```sh
exports-md src/index.ts generateMarkdownForModule > src/index.md
```

## How it works

`exports-md` resolves the nearest `node_modules/typescript` from the current working directory, so declaration emit uses the TypeScript version installed by the target project.

The tool emits declarations in memory, parses the resulting `.d.ts`, and renders Markdown sections from exported declarations and their leading TSDoc comments. When a symbol query is provided, the output includes requested exports plus local declaration dependencies needed to understand their signatures.

Imported symbols and external re-exports are not expanded recursively. If a rendered declaration references an imported name, the relevant import line is included in the Markdown output. If the module re-exports from another module, the relevant `export ... from` line is included instead.

Rendered Markdown is cached in the system temp directory using the input path, source content, tsconfig content, requested symbols, package version, and renderer version.
