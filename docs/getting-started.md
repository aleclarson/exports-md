# Getting Started

> Turn one TypeScript function into Markdown you can read, save, or share with
> a coding agent.

## Install

From a TypeScript project, install the command:

```bash
pnpm add -D exports-md
```

You need Node.js `^22.18.0` or `>=24.2.0` and TypeScript installed in the
project or a parent workspace. If TypeScript is not installed, run
`pnpm add -D typescript` too. Run the commands below from that project directory.

## Try One File

Suppose you want to know how to call a function without reading its body.
Create a file named `greet.ts` with this content:

```ts
/** Build a greeting for a display name. */
export function greet(name: string): string {
  return `Hello, ${name}!`
}
```

Print its exported function as Markdown:

```bash
pnpm exec exports-md greet.ts
```

The terminal output is:

    # greet.ts

    ## `greet`

    Build a greeting for a display name.

    ```ts
    export function greet(name: string): string;
    ```


The output keeps the documentation comment, parameter type, and return type.
It leaves out the function body. You can see how to call `greet`, but the output
alone does not tell you which greeting text it returns.

Seeing this output confirms the command is working. Now replace `greet.ts`
with a file from your project, such as `src/index.ts`.

## Save The Result

The command prints to the terminal by default. To save Markdown for another
reader or tool, redirect it to a file:

```bash
pnpm exec exports-md greet.ts > greet-api.md
```

This writes `greet-api.md`, replacing that file if it already exists. You can
read it in a Markdown viewer or supply it as API context to a coding agent.

## Go Further When Needed

- [Inspect packages](guides/inspect-packages.md) to read a local or published
  package across its supported import paths.
- [Choose output](guides/select-output.md) if you only need certain exports
  or want to change the presentation.

For option lookup, use the [CLI reference](reference/cli.md).
