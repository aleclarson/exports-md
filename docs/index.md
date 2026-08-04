# exports-md

> Inspect the public API of a TypeScript module or package as compact Markdown
> without loading its implementation.

`exports-md` compiles a target with the nearest installed TypeScript version and
renders exported declarations, TSDoc, and relevant import or re-export context.
The result is designed for agents and people who need API shape rather than
implementation details.

```bash
exports-md src/index.ts
```

The command prints Markdown to standard output. It does not create a file unless
you use shell redirection, choose `--outDir` for a package, or pipe the result to
another command.

## Choose A Workflow

- [Get started](getting-started.md) with installation, module inspection, and
  package inspection.
- [Choose what to include](guides/select-output.md) when you need particular
  symbols, followed declarations, sorting, or property documentation.
- [Set human defaults](guides/human-defaults.md) without changing deterministic
  behavior for agent callers.
- Use the [command-line reference](reference/cli.md) to look up every argument,
  option, conflict, and failure mode.
- Browse the generated API reference for the package's JavaScript exports.

## What The Output Proves

The generated Markdown describes the emitted public declaration surface. It is
useful for signatures, exported types, TSDoc, and package entry points.

> [!IMPORTANT]
> Declaration output does not prove runtime behavior, side effects, or internal
> invariants. Read source and tests when those details affect a decision.

## Requirements

The target project must use Node.js `^22.18.0` or `>=24.2.0` and have TypeScript
installed in a reachable `node_modules` directory. `exports-md` deliberately
uses the target project's nearest TypeScript installation.
