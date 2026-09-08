# Personal Defaults

> Save preferred output settings so you do not need to repeat them on each command.

This is optional. Start here once you find yourself reusing the same options.
These settings apply to human callers; detected coding agents use built-in
defaults instead.

Create `~/.config/exports-md.json` when you want long CLI options to have
persistent defaults:

```json
{
  "propertyDocs": "list",
  "sortByName": true
}
```

Explicit command-line values override the file. For example, this keeps
property comments inline even when the config selects `list`:

```bash
pnpm exec exports-md src/index.ts --propertyDocs inline
```

## Available Settings

| Field                | Type               | Default  | Effect                                              |
| -------------------- | ------------------ | -------- | --------------------------------------------------- |
| `outDir`             | string             | unset    | Writes package entry files under this directory.    |
| `pipe`               | string             | unset    | Sends Markdown to this executable's standard input. |
| `github.repository`  | string             | unset    | Repository (`owner/repo`) used for GitHub links.    |
| `github.searchLinks` | boolean            | `false`  | Adds a GitHub code-search link to each symbol.      |
| `follow`             | boolean            | `false`  | Follows relative imports and re-exports.            |
| `followImports`      | boolean            | `false`  | Follows relative imported declarations.             |
| `followReExports`    | boolean            | `false`  | Follows relative re-exported declarations.          |
| `groupBySyntax`      | boolean            | `false`  | Groups symbols by declaration category.             |
| `propertyDocs`       | `inline` or `list` | `inline` | Chooses where property TSDoc is rendered.           |
| `reverseSymbols`     | boolean            | `false`  | Reverses rendered symbol sections.                  |
| `sortByName`         | boolean            | `false`  | Sorts same-module symbols by name.                  |

For GitHub settings, nest the fields under `github`, for example
`"github": { "repository": "owner/repo", "searchLinks": true }`.
The `pipe` setting requires the named executable to be installed. Avoid combining
`pipe` and `outDir`; they select incompatible output destinations.

Package inputs follow relative declarations by default even though the follow
flags default to `false`; see [package resolution](../reference/cli.md#package-resolution).

Unknown fields, invalid JSON, and values of the wrong type fail with the config
path and a description of the invalid value. This prevents misspelled defaults
from being silently ignored.

## When A Coding Agent Runs The Command

Before reading the file, `exports-md` calls `@vercel/detect-agent`. When that
package identifies an agent or automated development environment, the config is
not read and built-in defaults apply.

This means the same machine can support presentation-oriented human defaults
such as `"pipe": "glow"` while an agent continues to receive plain Markdown on
standard output.

If a coding agent unexpectedly receives your personal formatting, check whether
`@vercel/detect-agent` recognizes that environment. An unrecognized caller gets
the personal config too; terminal interactivity alone does not determine this.
