# Select Exports And Format Output

> Select the exports you need or make the generated Markdown easier to scan.

The default output is enough to start. Use these options when you have a
specific reason to change it; they are independent choices. The examples assume
you have completed [Getting started](../getting-started.md).

## Select Exported Symbols

If you only need one function from a large module, request it by its exported
name. Put names after `--` to separate them from input paths:

```bash
pnpm exec exports-md shipping.ts -- shippingCost
```

The result includes the requested exports plus local declarations needed to
understand their signatures. If any requested name is not exported, the command
fails with `Export not found` instead of returning partial output.

Multiple inputs belong before the delimiter. Each input must export the requested
name; omit the filter if you want all exports from several files:

```bash
pnpm exec exports-md shipping.ts src/index.ts -- shippingCost
```

## Follow Local Declarations

A module can re-export a function: make a function defined in another file
available to its own callers. For example, with a helper in `src/shipping.ts`,
`src/index.ts` might contain:

```ts
export { shippingCost } from './shipping'
```

By default, the Markdown includes that reference line. To include the function's
signature and documentation instead, follow relative re-exports:

```bash
pnpm exec exports-md src/index.ts --followReExports
```

Similarly, `--followImports` includes declarations imported from relative files,
such as a type imported from `./types`. Use `--follow` when you need both.
Non-relative package references and namespace imports or re-exports remain
reference lines. Package inputs follow relative declarations by default.

## Organize Symbol Sections

If you are browsing a large result, group similar exports and sort their names
so you can find a function or type more easily:

```bash
pnpm exec exports-md src/index.ts --groupBySyntax --sortByName
```

You can use these options separately. See [section ordering](../reference/cli.md#section-ordering)
for category order, name sorting, and reversal rules.

## Move Property Documentation

Documentation comments on properties stay inside declaration code blocks by
default. Move them into a scannable `Properties` list below each declaration when prose is easier to read:

```bash
pnpm exec exports-md src/index.ts --propertyDocs list
```

For example, a comment above `name: string` moves out of the code block into
a `Properties` list, while `name: string` remains in the declaration. Use
`--propertyDocs inline` to request the default form explicitly.

## Send Markdown To Another Command

Pass an executable name to `--pipe` to feed the generated Markdown to its
standard input. For example, if you have the Glow Markdown viewer installed, render it in
the terminal:

```bash
pnpm exec exports-md src/index.ts --pipe glow
```

The child command inherits standard output and standard error, so its rendered
result appears in the current terminal. A missing command or nonzero exit status
causes `exports-md` to fail.

> [!NOTE]
> `--pipe` accepts one executable name and does not parse shell arguments. Use a
> wrapper executable when the downstream tool requires a fixed set of arguments.

`--pipe` and `--outDir` are mutually exclusive because one consumes a combined
Markdown stream while the other writes separate package-entry files.
