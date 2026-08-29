#!/usr/bin/env node
import {
  binary,
  boolean,
  command,
  flag,
  oneOf,
  option,
  optional,
  run,
  string,
  type Type,
} from '@alloc/cmd-ts'
import { determineAgent } from '@vercel/detect-agent'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { generateMarkdownForInputs } from './api.ts'
import { isRecord } from './files.ts'
import type { GitHubOptions, PropertyDocMode } from './types.ts'

const propertyDocModes = ['inline', 'list'] as const satisfies readonly PropertyDocMode[]

interface CliNode {
  raw: string
  type: string
}

interface CliParseContext {
  nodes: CliNode[]
  visitedNodes: Set<CliNode>
}

interface CliInputsAndSymbols {
  inputs: string[]
  symbols: string[]
}

interface CliConfig {
  follow?: boolean
  followImports?: boolean
  followReExports?: boolean
  github?: GitHubOptions
  groupBySyntax?: boolean
  outDir?: string
  pipe?: string
  propertyDocs?: PropertyDocMode
  reverseSymbols?: boolean
  sortByName?: boolean
}

let cliConfigPromise: Promise<CliConfig> | undefined

function getCliConfig() {
  return (cliConfigPromise ??= loadCliConfig())
}

function withCliConfigDefault<From, To>(
  type: Type<From, To>,
  getDefault: (config: CliConfig) => To,
): Type<From, To> {
  const { defaultValue: _, onMissing: __, ...requiredType } = type
  return {
    ...requiredType,
    onMissing: async () => getDefault(await getCliConfig()),
  }
}

async function loadCliConfig(): Promise<CliConfig> {
  if ((await determineAgent()).isAgent) return {}

  const configFile = join(homedir(), '.config', 'exports-md.json')
  let source: string

  try {
    source = await readFile(configFile, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }

  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new Error(`Invalid JSON in ${configFile}: ${(error as Error).message}`)
  }

  if (!isRecord(value)) {
    throw new Error(`Invalid config in ${configFile}: expected a JSON object.`)
  }

  const allowedKeys = new Set([
    'follow',
    'followImports',
    'followReExports',
    'github',
    'groupBySyntax',
    'outDir',
    'pipe',
    'propertyDocs',
    'reverseSymbols',
    'sortByName',
  ])
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Invalid config in ${configFile}: unknown option ${JSON.stringify(key)}.`)
    }
  }

  assertOptionalBooleanOptions(value, configFile, [
    'follow',
    'followImports',
    'followReExports',
    'groupBySyntax',
    'reverseSymbols',
    'sortByName',
  ])
  if (value.outDir !== undefined && typeof value.outDir !== 'string') {
    throw new Error(`Invalid config in ${configFile}: "outDir" must be a string.`)
  }
  if (value.pipe !== undefined && typeof value.pipe !== 'string') {
    throw new Error(`Invalid config in ${configFile}: "pipe" must be a string.`)
  }
  if (
    value.propertyDocs !== undefined &&
    !propertyDocModes.includes(value.propertyDocs as PropertyDocMode)
  ) {
    throw new Error(`Invalid config in ${configFile}: "propertyDocs" must be "inline" or "list".`)
  }
  if (value.github !== undefined) {
    if (!isRecord(value.github)) {
      throw new Error(`Invalid config in ${configFile}: "github" must be an object.`)
    }
    for (const key of Object.keys(value.github)) {
      if (key !== 'repository' && key !== 'searchLinks') {
        throw new Error(`Invalid config in ${configFile}: unknown "github.${key}" option.`)
      }
    }
    if (value.github.repository !== undefined && typeof value.github.repository !== 'string') {
      throw new Error(`Invalid config in ${configFile}: "github.repository" must be a string.`)
    }
    assertOptionalBooleanOptions(value.github, configFile, ['searchLinks'], 'github.')
  }

  return value as CliConfig
}

function assertOptionalBooleanOptions(
  value: Record<string, unknown>,
  configFile: string,
  keys: readonly string[],
  prefix = '',
) {
  for (const key of keys) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') {
      throw new Error(
        `Invalid config in ${configFile}: ${JSON.stringify(`${prefix}${key}`)} must be a boolean.`,
      )
    }
  }
}

function cliInputsAndSymbols() {
  return {
    helpTopics() {
      return [
        {
          category: 'arguments',
          defaults: [],
          description: 'Inputs to document, followed by optional export symbols after --.',
          usage: '[...input] -- [...symbol]',
        },
      ]
    },
    register() {},
    async parse(context: CliParseContext) {
      const values: string[] = []

      for (const node of context.nodes) {
        if (context.visitedNodes.has(node)) {
          continue
        }

        if (node.type === 'forcePositional') {
          values.push('--')
          context.visitedNodes.add(node)
          continue
        }

        if (node.type === 'positionalArgument') {
          values.push(node.raw)
          context.visitedNodes.add(node)
        }
      }

      try {
        return {
          _tag: 'ok' as const,
          value: splitCliInputsAndSymbols(values),
        }
      } catch (error) {
        return {
          _tag: 'error' as const,
          error: {
            errors: [
              {
                message: error instanceof Error ? error.message : String(error),
                nodes: [],
              },
            ],
          },
        }
      }
    },
  }
}

function splitCliInputsAndSymbols(values: readonly string[]): CliInputsAndSymbols {
  const delimiterIndex = values.indexOf('--')
  const inputs = delimiterIndex === -1 ? [...values] : values.slice(0, delimiterIndex)
  const symbols = delimiterIndex === -1 ? [] : values.slice(delimiterIndex + 1)

  if (inputs.length === 0) {
    throw new Error('At least one input is required.')
  }

  return {
    inputs,
    symbols,
  }
}

async function pipeMarkdown(command: string, markdown: string) {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, [], { stdio: ['pipe', 'inherit', 'inherit'] })

    child.once('error', reject)
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') reject(error)
    })
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolvePromise()
      } else {
        reject(
          new Error(
            signal
              ? `${command} terminated with signal ${signal}.`
              : `${command} exited with status ${code}.`,
          ),
        )
      }
    })
    child.stdin.end(markdown)
  })
}

const app = command({
  name: 'exports-md',
  description: 'Print Markdown docs for TypeScript module or package exports.',
  args: {
    outDir: option({
      type: withCliConfigDefault(optional(string), (config) => config.outDir),
      long: 'outDir',
      short: 'o',
      description: 'Write package entry Markdown files to this directory.',
    }),
    pipe: option({
      type: withCliConfigDefault(optional(string), (config) => config.pipe),
      long: 'pipe',
      description: 'Pipe generated Markdown to this CLI command.',
    }),
    follow: flag({
      type: withCliConfigDefault(boolean, (config) => config.follow ?? false),
      long: 'follow',
      short: 'f',
      description: 'Render relative imported and re-exported declarations.',
    }),
    followImports: flag({
      type: withCliConfigDefault(boolean, (config) => config.followImports ?? false),
      long: 'followImports',
      short: 'i',
      description: 'Render relative imported declarations instead of only printing import lines.',
    }),
    followReExports: flag({
      type: withCliConfigDefault(boolean, (config) => config.followReExports ?? false),
      long: 'followReExports',
      short: 'e',
      description:
        'Render relative re-exported declarations instead of only printing export-from lines.',
    }),
    githubRepository: option({
      type: withCliConfigDefault(optional(string), (config) => config.github?.repository),
      long: 'github.repository',
      description: 'GitHub repository to use for generated links, formatted as owner/repo.',
    }),
    githubSearchLinks: flag({
      type: withCliConfigDefault(boolean, (config) => config.github?.searchLinks ?? false),
      long: 'github.searchLinks',
      description: 'Append a GitHub code search link to each symbol section.',
    }),
    reverseSymbols: flag({
      type: withCliConfigDefault(boolean, (config) => config.reverseSymbols ?? false),
      long: 'reverseSymbols',
      short: 'r',
      description: 'Print rendered symbol sections in reverse order.',
    }),
    groupBySyntax: flag({
      type: withCliConfigDefault(boolean, (config) => config.groupBySyntax ?? false),
      long: 'groupBySyntax',
      short: 'g',
      description:
        'Group same-module exports by syntax category: functions, classes, constants, other non-types, then types.',
    }),
    sortByName: flag({
      type: withCliConfigDefault(boolean, (config) => config.sortByName ?? false),
      long: 'sortByName',
      short: 's',
      description:
        'Sort same-module exports by name, with lowercase symbols first and all-caps symbols last.',
    }),
    propertyDocs: option({
      type: withCliConfigDefault(
        optional(oneOf(propertyDocModes)),
        (config) => config.propertyDocs,
      ),
      long: 'propertyDocs',
      description: 'Render property TSDoc comments inline or as a list below declaration code.',
    }),
    query: cliInputsAndSymbols(),
  },
  async handler({
    follow,
    followImports,
    followReExports,
    githubRepository,
    githubSearchLinks,
    outDir,
    pipe,
    propertyDocs,
    query,
    reverseSymbols,
    groupBySyntax,
    sortByName,
  }) {
    if (outDir && pipe) {
      throw new Error('--pipe cannot be used with --outDir.')
    }

    const result = await generateMarkdownForInputs(query.inputs, {
      followImports: follow || followImports || undefined,
      followReExports: follow || followReExports || undefined,
      github: {
        repository: githubRepository,
        searchLinks: githubSearchLinks,
      },
      outDir,
      propertyDocs,
      reverseSymbols,
      groupBySyntax,
      sortByName,
      symbols: query.symbols,
    })
    if (pipe) {
      await pipeMarkdown(pipe, result.markdown)
    } else if (!outDir) {
      process.stdout.write(result.markdown)
    }
  },
})

if (import.meta.main) {
  await run(binary(app), process.argv)
}
