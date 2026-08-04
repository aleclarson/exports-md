# Human Defaults

> Keep interactive output convenient without allowing personal preferences to
> change the deterministic context produced for detected agents.

Create `~/.config/exports-md.json` when you want long CLI options to have
persistent defaults:

```json
{
  "follow": true,
  "propertyDocs": "list",
  "pipe": "glow",
  "sortByName": true
}
```

Explicit command-line values override the file. For example, this keeps
property comments inline even when the config selects `list`:

```bash
exports-md src/index.ts --propertyDocs inline
```

## Fields

| Field | Type | Default | Effect |
| --- | --- | --- | --- |
| `outDir` | string | unset | Writes package entry files under this directory. |
| `pipe` | string | unset | Sends Markdown to this executable's standard input. |
| `follow` | boolean | `false` | Follows relative imports and re-exports. |
| `followImports` | boolean | `false` | Follows relative imported declarations. |
| `followReExports` | boolean | `false` | Follows relative re-exported declarations. |
| `groupBySyntax` | boolean | `false` | Groups symbols by declaration category. |
| `propertyDocs` | `inline` or `list` | `inline` | Chooses where property TSDoc is rendered. |
| `reverseSymbols` | boolean | `false` | Reverses rendered symbol sections. |
| `sortByName` | boolean | `false` | Sorts same-module symbols by name. |

Unknown fields, invalid JSON, and values of the wrong type fail with the config
path and a description of the invalid value. This prevents misspelled defaults
from being silently ignored.

## Agent Boundary

Before reading the file, `exports-md` calls `@vercel/detect-agent`. When that
package identifies an agent or automated development environment, the config is
not read and built-in defaults apply.

This means the same machine can support presentation-oriented human defaults
such as `"pipe": "glow"` while an agent continues to receive plain Markdown on
standard output.

> [!IMPORTANT]
> Detection is the boundary. If the detector returns a non-agent result, the
> personal config applies; `exports-md` does not infer intent from terminal
> interactivity on its own.
