# exports-md

> Get a TypeScript module's exported functions, types, and documentation comments
> together as Markdown.

When you encounter an unfamiliar TypeScript module, you may need to answer a
narrow question: what can I import, what arguments does it accept, and what does
it return? Exported signatures and existing documentation comments may be
enough; you may not need to inspect the implementation.

`exports-md` collects those signatures and comments into Markdown you can read,
save, or share. It describes the **public API**: the functions, classes, values,
and types the module exports for other code to use.

Each export gets a heading and a declaration: a description of a function or
type without its implementation. Existing TSDoc comments (documentation comments
written above declarations) supply the explanations. The tool does not write
missing documentation or verify that comments match the implementation.

## Is This Useful For You?

Consider it when you want a Markdown view of a module's exports, a shareable
API excerpt, or type and documentation context for a coding agent. You can
inspect your own files or published npm packages.

If your editor's type hints or the package's documentation already answer your
question, you may not need another tool. TypeScript declaration files (`.d.ts`)
also describe APIs directly; this tool arranges declarations and comments into
Markdown sections and lets you select particular exports.

For runtime behavior, side effects, or why something fails, read source and
tests. Signatures tell you what arguments and results are typed as, but do not
prove what the implementation does.

## Where To Start

[Try one file](getting-started.md) for prerequisites, a command, and its actual
Markdown output. Then try a file from your project to judge whether this view
answers your question.

After trying it:

- [Inspect packages](guides/inspect-packages.md) for local or published packages.
- [Select exports and format output](guides/select-output.md) to select exports or adjust formatting.
- Use the [CLI reference](reference/cli.md) for exact options and troubleshooting.

[Personal defaults](guides/human-defaults.md) are optional settings for repeated
interactive use. The generated
[JavaScript API reference](reference/exports-md.md) is for callers integrating
the library into their own code.
