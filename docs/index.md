# exports-md

> Get a TypeScript module's exported functions, types, and documentation comments
> together as Markdown.

When you need to use an unfamiliar module, you may only need to know what you
can import, which arguments a function accepts, and what it returns. Reading
its implementation can mean working through details that do not answer those
questions.

`exports-md` extracts that information into a document you can read, save, or
pass to a coding agent. It describes the **public API**: the functions, classes,
values, and types the module exports for other code to use.

For example, a function with a body becomes a declaration with its documentation:

```ts
/** Build a greeting for a display name. */
export function greet(name: string): string
```

The generated Markdown gives each export a heading and includes any existing
TSDoc comments (documentation comments written above declarations). It does not
write missing explanations for you.

[Try the complete example](getting-started.md) to see the source, command, and
actual Markdown output.

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

Start with [Getting started](getting-started.md) for installation and one
complete example. You will need a supported Node.js version and a project with
TypeScript installed; the guide lists the requirements.

After trying it:

- [Inspect packages](guides/inspect-packages.md) for local or published packages.
- [Choose output](guides/select-output.md) to select exports or adjust formatting.
- Use the [CLI reference](reference/cli.md) for exact options and troubleshooting.

[Personal defaults](guides/human-defaults.md) are optional settings for repeated
interactive use. The generated API reference documents the JavaScript exports
for callers integrating the library into their own code.
