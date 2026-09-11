# Inspect Packages

> Read the types and documentation a package exposes to its users, across its
> supported import paths.

Start with [Getting started](../getting-started.md) to install the command and
see an example of its output. These workflows also need a reachable TypeScript
installation; published packages require `npm` on `PATH`.

## Inspect A Package

To inspect a local package, run from its project directory. Pass its
`package.json`, which lists the import paths available to consumers:

```bash
pnpm exec exports-md package.json
```

A package can expose several import paths, called entry points. For example,
`foo` and `foo/extra` let callers import different parts of one package. The
output gives each supported entry point its own heading, such as `# foo/extra`,
followed by sections for its exported functions and types.

See [package resolution](../reference/cli.md#package-resolution) if an entry is
missing or you need the exact selection rules.

### Save Separate Entry Files

To browse or share each entry as a separate document:

```bash
pnpm exec exports-md package.json --outDir docs/api
```

Output paths follow the target files' folder structure relative to their shared
root. They can differ from the import paths. For example:

| Import path | Declaration file           | Generated file               |
| ----------- | -------------------------- | ---------------------------- |
| `foo`       | `dist/index.d.ts`          | `docs/api/index.md`          |
| `foo/extra` | `dist/features/extra.d.ts` | `docs/api/features/extra.md` |

In this example, open `docs/api/features/extra.md` and check for the heading
`# foo/extra` and its exports.

### Use A Directory Path

A package directory is shorthand for its `package.json`:

```bash
pnpm exec exports-md .
pnpm exec exports-md packages/example
```

## Inspect A Published Package

Use an npm package name with an optional version, tag, or version range when
the package is not installed in the current project:

```bash
pnpm exec exports-md qubu@0.4.2
```

`exports-md` fetches each package tarball with npm, extracts it temporarily,
and removes the temporary files after rendering. It does not add packages,
dependencies, or lockfiles to the current project.

Package inspection includes declarations from relative files within the package;
imports from other packages remain references. The current project still needs
a reachable `node_modules/typescript` installation.
