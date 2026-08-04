---
title: CLI Reference
---

# Command Line

> Look up command syntax, defaults, side effects, conflicts, and failures for
> scripts or interactive use.

## Syntax

```text
exports-md [...input] [options] -- [...symbol]
```

At least one input is required. Inputs can be TypeScript modules, declaration
files, package manifests, or package directories. Put optional exported symbol
names after the `--` delimiter.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `--outDir <dir>`, `-o <dir>` | unset | Write separate package-entry Markdown files under `dir`. Only valid for one package input. |
| `--pipe <command>` | unset | Send generated Markdown to an executable's standard input. |
| `--follow`, `-f` | `false` | Follow relative imports and re-exports. |
| `--followImports`, `-i` | `false` | Follow relative imported declarations. |
| `--followReExports`, `-e` | `false` | Follow relative re-exported declarations. |
| `--github.repository <owner/repo>` | unset | Set the repository used by generated GitHub links. |
| `--github.searchLinks` | `false` | Append a GitHub code-search link to each symbol section. |
| `--propertyDocs <inline\|list>` | `inline` | Keep property TSDoc in code or move it below declarations. |
| `--groupBySyntax`, `-g` | `false` | Group same-module symbols by declaration category. |
| `--sortByName`, `-s` | `false` | Sort same-module symbols alphabetically. |
| `--reverseSymbols`, `-r` | `false` | Reverse rendered symbol sections after sorting. |
| `--help`, `-h` | — | Print command help. |

For callers not identified as agents, values from
`~/.config/exports-md.json` replace the defaults in this table. Explicit CLI
values take precedence. See [Human Defaults](../guides/human-defaults.md).

## Output Destinations

With neither `--outDir` nor `--pipe`, the command writes one Markdown stream to
standard output. Shell redirection can capture it:

```bash
exports-md src/index.ts > api.md
```

`--outDir` is limited to a single package input. `--pipe` works with module or
package output but cannot be combined with `--outDir`.

## Failure Cases

| Message or symptom | Cause | Next action |
| --- | --- | --- |
| `At least one input is required.` | No module, manifest, or directory was provided. | Add an input before any options or `--`. |
| `Module not found` | The resolved module path does not exist. | Check the working directory and input path. |
| `Could not find node_modules/typescript` | No TypeScript installation is reachable from the working directory. | Install TypeScript in the target workspace or run from the intended project. |
| TypeScript diagnostics | Declaration emit failed. | Fix the reported type or configuration errors before retrying. |
| `Export not found` | A requested symbol is not exported under that name. | Check the public export name or omit the symbol filter. |
| `--outDir is only supported...` | The output-directory mode was used with a module or multiple inputs. | Use one package input or redirect the combined stream. |
| `--pipe cannot be used with --outDir` | Both output modes were selected, including through human config. | Choose one output destination or override the configured value. |
| Child command exits nonzero | The executable passed to `--pipe` failed. | Run that executable directly and inspect its standard error. |

The command does not emit partial Markdown after a generation error.
