# Getting Started

> Generate Markdown from one TypeScript function and check what it tells you.

## Install

You need Node.js `^22.18.0` or `>=24.2.0`, pnpm available in your terminal,
and a project with TypeScript installed locally or in a parent workspace. Run
the commands below from that project directory. If TypeScript is missing, run
`pnpm add -D typescript` before continuing.

For `.tsrx` source files, also install `@tsrx/typescript-plugin` and the
TSRX compiler configured by the project. `exports-md` uses the workspace's
`tsrx-tsc` wrapper to emit declarations before rendering them.

Install the command as a development dependency:

```bash
pnpm add -D exports-md
```

## Try One File

Suppose you need to check what units a shipping helper expects and returns.
Create a file named `shipping.ts` with this content:

```ts
/** Calculate shipping in cents. Orders at or above 5000 cents ship free. */
export function shippingCost(subtotalCents: number): number {
  return subtotalCents >= 5000 ? 0 : 500
}
```

Print its exported function as Markdown:

```bash
pnpm exec exports-md shipping.ts
```

The terminal output is:

    # shipping.ts

    ## `shippingCost`

    Calculate shipping in cents. Orders at or above 5000 cents ship free.

    ```ts
    export function shippingCost(subtotalCents: number): number;
    ```

The signature shows the argument and return types; the existing comment supplies
the units and free-shipping threshold. The output does not reveal the charge
below that threshold or verify that the implementation follows its comment.

Seeing this output confirms the command works. This small example demonstrates
the format; to judge its usefulness, replace `shipping.ts` in the command with a
file from your project, such as `src/index.ts`. Check whether its signatures and
comments answer your question without needing to read the implementation.

## Save The Result

The command prints to the terminal by default. To save Markdown for another
reader or tool, redirect it to a file:

```bash
pnpm exec exports-md shipping.ts > shipping-api.md
```

This writes `shipping-api.md`, replacing that file if it already exists. You can
read it in a Markdown viewer or supply it as API context to a coding agent.

## Go Further When Needed

- [Inspect packages](guides/inspect-packages.md) to read a local or published
  package across its supported import paths.
- [Select exports and format output](guides/select-output.md) if you only need certain exports
  or want to change the presentation.

For option lookup, use the [CLI reference](reference/cli.md).
