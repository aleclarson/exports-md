# Choose Output

> Keep API context focused by selecting symbols, following only useful local
> declarations, and choosing a stable section order.

## Select Exported Symbols

Put symbol names after `--` so they cannot be confused with input paths:

```bash
exports-md src/index.ts -- generateMarkdownForModule findNearestTypescript
```

The result includes the requested exports plus local declarations needed to
understand their signatures. If any requested name is not exported, the command
fails with `Export not found` instead of returning partial output.

Multiple inputs belong before the delimiter:

```bash
exports-md src/index.ts src/cache.ts -- generateMarkdownForModule
```

## Follow Local Declarations

Module output normally keeps imports and re-exports as reference lines. Follow
relative declarations when their API shape is more useful than the reference:

```bash
exports-md src/index.ts --followImports
exports-md src/index.ts --followReExports
exports-md src/index.ts --follow
```

`--follow` enables both behaviors. Non-relative package references and namespace
imports or re-exports remain reference lines.

## Organize Symbol Sections

Use sorting options independently or together:

```bash
exports-md src/index.ts --groupBySyntax --sortByName --reverseSymbols
```

The operations run in this order:

1. `--groupBySyntax` groups functions, classes, constants, other non-types, and
   types.
2. `--sortByName` sorts symbols within that structure, with lowercase names
   first and all-caps names last.
3. `--reverseSymbols` reverses the rendered sections after sorting.

## Move Property Documentation

Property TSDoc stays inside declaration code blocks by default. Move it into a
scannable `Properties` list below each declaration when prose is easier to read:

```bash
exports-md src/index.ts --propertyDocs list
```

Use `--propertyDocs inline` to request the default form explicitly.

## Send Markdown To Another Command

Pass an executable name to `--pipe` to feed the generated Markdown to its
standard input. For example, render it interactively with Glow:

```bash
exports-md src/index.ts --pipe glow
```

The child command inherits standard output and standard error, so its rendered
result appears in the current terminal. A missing command or nonzero exit status
causes `exports-md` to fail.

> [!NOTE]
> `--pipe` accepts one executable name and does not parse shell arguments. Use a
> wrapper executable when the downstream tool requires a fixed set of arguments.

`--pipe` and `--outDir` are mutually exclusive because one consumes a combined
Markdown stream while the other writes separate package-entry files.
