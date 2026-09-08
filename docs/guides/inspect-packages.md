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

A package directory is shorthand for its manifest:

```bash
pnpm exec exports-md .
pnpm exec exports-md packages/example
```

A package can expose several import paths, called entry points. This prints a
section for each supported entry point. See [package resolution](../reference/cli.md#package-resolution)
if an entry is missing or you need the exact selection rules.

Write each package entry to its own Markdown file when another tool needs a
directory tree:

```bash
pnpm exec exports-md package.json --outDir docs/api
```

After the command finishes, `docs/api` preserves the entry-point folder
structure relative to the entries' shared root.

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
