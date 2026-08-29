import { execFile as execFileCallback } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { generateMarkdownForModule } from '../src/index'
import { createProject, humanCliEnv, tempDirs } from './helpers'

const execFile = promisify(execFileCallback)

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
test('renders declaration code between TSDoc summary and tag sections', async () => {
  const project = await createProject()
  const inputFile = join(project, 'api.ts')

  await writeFile(
    inputFile,
    `
/**
 * Formats a user name.
 *
 * Preserves internal whitespace.
 *
 * @remarks Used in generated UI labels.
 * @param name - Raw display name.
 * @returns The formatted display name.
 * @example
 * formatName(' Ada ')
 */
export function formatName(name: string) {
  return name.trim()
}
`,
  )

  const result = await generateMarkdownForModule(inputFile, { cwd: project })

  expect(result.markdown).toContain(
    [
      'Formats a user name.',
      '',
      'Preserves internal whitespace.',
      '',
      '```ts',
      'export function formatName(name: string): string;',
      '```',
      '',
      '**Remarks**',
      '',
      'Used in generated UI labels.',
      '',
      '**Parameters**',
      '',
      '- `name`: Raw display name.',
      '',
      '**Returns**',
      '',
      'The formatted display name.',
      '',
      '**Examples**',
      '',
      "formatName(' Ada ')",
    ].join('\n'),
  )
})

test('preserves same-module export order by default', async () => {
  const project = await createProject()
  const inputFile = join(project, 'api.ts')

  await writeFile(
    inputFile,
    `
export interface User {
  name: string
}

export function createUser(): User {
  return { name: 'Ada' }
}
`,
  )

  const result = await generateMarkdownForModule(inputFile, { cwd: project })
  const headings = [...result.markdown.matchAll(/^## `([^`]+)`$/gm)].map((match) => match[1])

  expect(headings).toEqual(['User', 'createUser'])
})

test('orders same-module exports by declaration category when requested', async () => {
  const project = await createProject()
  const inputFile = join(project, 'api.ts')

  await writeFile(
    inputFile,
    `
export interface User {
  name: string
}

export const version = '1.0.0'

export class Client {}

export enum Status {
  Ready = 'ready',
}

export function createClient() {
  return new Client()
}

export type ClientOptions = {
  retry: boolean
}

export namespace metadata {
  export const stable = true
}
`,
  )

  const result = await generateMarkdownForModule(inputFile, { cwd: project, groupBySyntax: true })
  const groups = [...result.markdown.matchAll(/^## ([^\n]+)$/gm)].map((match) => match[1])
  const headings = [...result.markdown.matchAll(/^### `([^`]+)`$/gm)].map((match) => match[1])

  expect(groups).toEqual(['Functions', 'Classes', 'Constants', 'Other Exports', 'Types'])
  expect(headings).toEqual([
    'createClient',
    'Client',
    'version',
    'Status',
    'metadata',
    'User',
    'ClientOptions',
  ])
})

test('orders same-module exports alphabetically when requested', async () => {
  const project = await createProject()
  const inputFile = join(project, 'api.ts')

  await writeFile(
    inputFile,
    `
export const _API = true
export const Banana = true
export const apple = true
export const $URL = true
export const carrot = true
`,
  )

  const result = await generateMarkdownForModule(inputFile, { cwd: project, sortByName: true })
  const headings = [...result.markdown.matchAll(/^## `([^`]+)`$/gm)].map((match) => match[1])

  expect(headings).toEqual(['apple', 'carrot', 'Banana', '_API', '$URL'])
})

test('orders same-module exports by category before symbol name when both sorts are requested', async () => {
  const project = await createProject()
  const inputFile = join(project, 'api.ts')

  await writeFile(
    inputFile,
    `
export type BetaOptions = {
  enabled: boolean
}

export const _API = true

export class ZetaClient {}

export function makeClient() {
  return new AlphaClient()
}

export const apple = true

export class AlphaClient {}

export function buildClient() {
  return new ZetaClient()
}
`,
  )

  const result = await generateMarkdownForModule(inputFile, {
    cwd: project,
    groupBySyntax: true,
    sortByName: true,
  })
  const groups = [...result.markdown.matchAll(/^## ([^\n]+)$/gm)].map((match) => match[1])
  const headings = [...result.markdown.matchAll(/^### `([^`]+)`$/gm)].map((match) => match[1])

  expect(groups).toEqual(['Functions', 'Classes', 'Constants', 'Types'])
  expect(headings).toEqual([
    'buildClient',
    'makeClient',
    'AlphaClient',
    'ZetaClient',
    'apple',
    '_API',
    'BetaOptions',
  ])
})

test('reverses sorted same-module exports after category and symbol sorting', async () => {
  const project = await createProject()
  const inputFile = join(project, 'api.ts')

  await writeFile(
    inputFile,
    `
export type BetaOptions = {
  enabled: boolean
}

export const API = true

export class ZetaClient {}

export function makeClient() {
  return new AlphaClient()
}

export const apple = true

export class AlphaClient {}

export function buildClient() {
  return new ZetaClient()
}
`,
  )

  const result = await generateMarkdownForModule(inputFile, {
    cwd: project,
    reverseSymbols: true,
    groupBySyntax: true,
    sortByName: true,
  })
  const groups = [...result.markdown.matchAll(/^## ([^\n]+)$/gm)].map((match) => match[1])
  const headings = [...result.markdown.matchAll(/^### `([^`]+)`$/gm)].map((match) => match[1])

  expect(groups).toEqual(['Types', 'Constants', 'Classes', 'Functions'])
  expect(headings).toEqual([
    'BetaOptions',
    'API',
    'apple',
    'ZetaClient',
    'AlphaClient',
    'makeClient',
    'buildClient',
  ])
})

test('documents symbols exported through an export list', async () => {
  const project = await createProject()
  const inputFile = join(project, 'api.ts')

  await writeFile(
    inputFile,
    `
/**
 * Parses a raw value.
 *
 * @param value - Raw input.
 */
function parseValue(value: string): number {
  return Number(value)
}

export { parseValue as parse }
`,
  )

  const result = await generateMarkdownForModule(inputFile, { cwd: project })

  expect(result.markdown).toContain('## `parse`')
  expect(result.markdown).toContain('- `value`: Raw input.')
  expect(result.markdown).toContain('export function parse(value: string): number;')
})

test('prints symbol sections in reverse order when requested', async () => {
  const project = await createProject()
  const inputFile = join(project, 'api.ts')

  await writeFile(
    inputFile,
    `
/** First docs. */
export interface First {
  value: string
}

/** Second docs. */
export function second(input: First) {
  return input.value
}

/** Third docs. */
export const third = true
`,
  )

  const result = await generateMarkdownForModule(inputFile, {
    cwd: project,
    reverseSymbols: true,
  })

  expect(result.markdown.indexOf('## `third`')).toBeLessThan(result.markdown.indexOf('## `second`'))
  expect(result.markdown.indexOf('## `second`')).toBeLessThan(result.markdown.indexOf('## `First`'))
})

test('appends GitHub search links to symbol sections when requested', async () => {
  const project = await createProject()
  const inputFile = join(project, 'api.ts')

  await writeFile(
    inputFile,
    `
/** Available log levels. */
export type LogLevel = 'debug' | 'info'
`,
  )

  const result = await generateMarkdownForModule(inputFile, {
    cwd: project,
    github: {
      repository: 'aleclarson/leylines',
      searchLinks: true,
    },
  })

  expect(result.markdown).toContain(
    '[<sup>🔍 **LogLevel** on GitHub</sup>](https://github.com/search?q=repo%3Aaleclarson/leylines%20LogLevel&type=code)',
  )
})

test('requires a GitHub repository when search links are enabled', async () => {
  const project = await createProject()
  const inputFile = join(project, 'api.ts')
  await writeFile(inputFile, '/** The answer. */\nexport const answer = 42\n')

  await expect(
    generateMarkdownForModule(inputFile, {
      cwd: project,
      github: {
        searchLinks: true,
      },
    }),
  ).rejects.toThrow('github.repository is required when github.searchLinks is enabled.')
})

test('rewrites aliased type declarations without dropping type constraints', async () => {
  const project = await createProject()
  const inputFile = join(project, 'api.ts')

  await writeFile(
    inputFile,
    `
/** Constrains boxed values. */
interface Constraint {
  value: string
}

/** Boxed value. */
type InternalBox<T extends Constraint> = {
  value: T
}

export { InternalBox as Box }
`,
  )

  const result = await generateMarkdownForModule(inputFile, { cwd: project })

  expect(result.markdown).toContain('## `Constraint`')
  expect(result.markdown).toContain('interface Constraint')
  expect(result.markdown).not.toContain('export interface Constraint')
  expect(result.markdown).toContain('## `Box`')
  expect(result.markdown).toContain('export type Box<T extends Constraint>')
  expect(result.markdown).not.toContain('InternalBox')
})

test('rewrites default export aliases as export default declarations', async () => {
  const project = await createProject()
  const inputFile = join(project, 'api.ts')

  await writeFile(
    inputFile,
    `
/** Creates the default value. */
function createDefault(): string {
  return 'default'
}

export { createDefault as default }
`,
  )

  const result = await generateMarkdownForModule(inputFile, { cwd: project })

  expect(result.markdown).toContain('## `default`')
  expect(result.markdown).toContain('Creates the default value.')
  expect(result.markdown).toContain('export default function createDefault(): string;')
  expect(result.markdown).not.toContain('declare function createDefault')
})

test('groups overloaded declarations into one exported section', async () => {
  const project = await createProject()
  const inputFile = join(project, 'api.ts')

  await writeFile(
    inputFile,
    `
interface ReadableSigma<TState extends object> {
  value: TState
}

interface PersistenceHandle {
  stop(): void
}

type PickPersistOptions<TState extends object, TKey extends keyof TState> = {
  keys: TKey[]
}

type PersistOptions<TState extends object, TStored> = {
  serialize(state: TState): TStored
}

/**
 * Persists future committed state changes for one sigma instance.
 */
export function persist<TState extends object, TKey extends keyof TState>(
  instance: ReadableSigma<TState>,
  options: PickPersistOptions<TState, TKey>,
): PersistenceHandle
export function persist<TState extends object, TStored = TState>(
  instance: ReadableSigma<TState>,
  options: PersistOptions<TState, TStored>,
): PersistenceHandle
export function persist(_instance: ReadableSigma<object>, _options: object): PersistenceHandle {
  return { stop() {} }
}
`,
  )

  const result = await generateMarkdownForModule(inputFile, { cwd: project })

  expect(result.markdown.match(/## `persist`/g)).toHaveLength(1)
  expect(result.markdown).toContain(
    'Persists future committed state changes for one sigma instance.',
  )
  expect(result.markdown.match(/export function persist/g)).toHaveLength(2)
})

test('includes external re-export declarations', async () => {
  const project = await createProject()
  const inputFile = join(project, 'api.ts')

  await writeFile(join(project, 'types.ts'), 'export interface ExternalInput { value: string }\n')
  await writeFile(join(project, 'factory.ts'), 'export function makeThing() { return "thing" }\n')
  await writeFile(join(project, 'wildcard.ts'), 'export interface Wildcarded { ok: true }\n')
  await writeFile(
    inputFile,
    `
export type { ExternalInput as Input } from './types'
export { makeThing } from './factory'
export * from './wildcard'
`,
  )

  const result = await generateMarkdownForModule(inputFile, { cwd: project })

  expect(result.markdown).toContain("export type { ExternalInput as Input } from './types';")
  expect(result.markdown).toContain("export { makeThing } from './factory';")
  expect(result.markdown).toContain("export * from './wildcard';")
})

test('follows relative re-exports to declarations when requested', async () => {
  const project = await createProject()
  const inputFile = join(project, 'api.ts')

  await writeFile(
    join(project, 'types.ts'),
    `
/** External input docs. */
export interface ExternalInput {
  value: string
}
`,
  )
  await writeFile(
    join(project, 'factory.ts'),
    `
/** Factory docs. */
export function makeThing(input: string) {
  return input
}
`,
  )
  await writeFile(
    join(project, 'namespace.ts'),
    `
/** Namespaced value docs. */
export const namespaced = true
`,
  )
  await writeFile(
    inputFile,
    `
export type { ExternalInput as Input } from './types'
export { makeThing } from './factory'
export * as namespace from './namespace'
`,
  )

  const result = await generateMarkdownForModule(inputFile, {
    cwd: project,
    followReExports: true,
  })

  expect(result.markdown).not.toContain("export type { ExternalInput as Input } from './types';")
  expect(result.markdown).toContain('## `Input`')
  expect(result.markdown).toContain('External input docs.')
  expect(result.markdown).toContain('export interface Input')
  expect(result.markdown).toContain('## `makeThing`')
  expect(result.markdown).toContain('Factory docs.')
  expect(result.markdown).toContain('export function makeThing(input: string): string;')
  expect(result.markdown).toContain("export * as namespace from './namespace';")
  expect(result.markdown).not.toContain('Namespaced value docs.')
})

test('keeps external imports above symbols with every sorting option', async () => {
  const project = await createProject()
  const inputFile = join(project, 'index.d.ts')

  await writeFile(
    join(project, 'feature.d.ts'),
    `
import type { ExternalInput } from 'external-package'

export interface Feature {
  input: ExternalInput
}
`,
  )
  await writeFile(inputFile, "export type { Feature } from './feature'\n")

  for (const groupBySyntax of [false, true]) {
    for (const sortByName of [false, true]) {
      for (const reverseSymbols of [false, true]) {
        const result = await generateMarkdownForModule(inputFile, {
          cwd: project,
          followReExports: true,
          groupBySyntax,
          sortByName,
          reverseSymbols,
        })
        const importIndex = result.markdown.indexOf('external-package')
        const symbolIndex = result.markdown.indexOf(
          groupBySyntax ? '### `Feature`' : '## `Feature`',
        )

        expect(importIndex).toBeGreaterThan(-1)
        expect(importIndex).toBeLessThan(symbolIndex)
      }
    }
  }
})

test('follows imported aliases exported through a local export list when requested', async () => {
  const project = await createProject()
  const inputFile = join(project, 'index.d.mts')

  await writeFile(
    join(project, 'schema-BCZugTrh.d.mts'),
    `
/** JSON record docs. */
export interface A {
  value: string
}

/** Parse patch docs. */
export declare function C(input: A): A

/** Generic parse docs. */
export declare function D<A>(input: A): A

/** Hidden schema docs. */
export interface Hidden {
  value: string
}
`,
  )
  await writeFile(
    inputFile,
    `
import { A as JsonRecord, C as parsePatch, D as parseGeneric, Hidden as hidden } from "./schema-BCZugTrh.mjs";
export { type JsonRecord, parseGeneric, parsePatch };
`,
  )

  const result = await generateMarkdownForModule(inputFile, {
    cwd: project,
    followReExports: true,
    symbols: ['parseGeneric', 'parsePatch'],
  })

  expect(result.markdown).not.toContain('import { A as JsonRecord')
  expect(result.markdown).toContain('## `JsonRecord`')
  expect(result.markdown).not.toContain('## `A`')
  expect(result.markdown).toContain('JSON record docs.')
  expect(result.markdown).toContain('export interface JsonRecord')
  expect(result.markdown).toContain('## `parsePatch`')
  expect(result.markdown).toContain('Parse patch docs.')
  expect(result.markdown).toContain('export function parsePatch(input: JsonRecord): JsonRecord')
  expect(result.markdown).toContain('## `parseGeneric`')
  expect(result.markdown).toContain('export function parseGeneric<A>(input: A): A')
  expect(result.markdown).not.toContain('export function parseGeneric<JsonRecord>')
  expect(result.markdown).not.toContain('Hidden schema docs.')
})

test('mixes followed imported re-exports into grouped syntax sections', async () => {
  const project = await createProject()
  const inputFile = join(project, 'index.d.mts')

  await writeFile(
    join(project, 'schema.d.mts'),
    `
/** JSON record docs. */
export interface A {
  value: string
}

/** Parse patch docs. */
export declare function C(input: A): A
`,
  )
  await writeFile(
    inputFile,
    `
import { A as JsonRecord, C as parsePatch } from "./schema.mjs";

/** Local options docs. */
export interface LocalOptions {
  enabled: boolean
}

/** Local factory docs. */
export declare function createLocal(options: LocalOptions): JsonRecord

export { type JsonRecord, parsePatch };
`,
  )

  const result = await generateMarkdownForModule(inputFile, {
    cwd: project,
    followImports: true,
    followReExports: true,
    groupBySyntax: true,
  })
  const groups = [...result.markdown.matchAll(/^## ([^\n]+)$/gm)].map((match) => match[1])
  const headings = [...result.markdown.matchAll(/^### `([^`]+)`$/gm)].map((match) => match[1])

  expect(groups).toEqual(['Functions', 'Types'])
  expect(headings).toEqual(['createLocal', 'parsePatch', 'LocalOptions', 'JsonRecord'])
  expect(result.warnings).toEqual([])
})

test('sorts merged grouped followed re-exports by symbol name', async () => {
  const project = await createProject()
  const inputFile = join(project, 'index.d.mts')

  await writeFile(
    join(project, 'schema.d.mts'),
    `
/** Alpha record docs. */
export interface A {
  value: string
}

/** Build patch docs. */
export declare function B(input: A): A
`,
  )
  await writeFile(
    inputFile,
    `
import { A as AlphaRecord, B as buildPatch } from "./schema.mjs";

/** Zed options docs. */
export interface ZedOptions {
  enabled: boolean
}

/** Zed factory docs. */
export declare function zedFactory(options: ZedOptions): AlphaRecord

export { type AlphaRecord, buildPatch };
`,
  )

  const result = await generateMarkdownForModule(inputFile, {
    cwd: project,
    followReExports: true,
    groupBySyntax: true,
    sortByName: true,
  })
  const groups = [...result.markdown.matchAll(/^## ([^\n]+)$/gm)].map((match) => match[1])
  const headings = [...result.markdown.matchAll(/^### `([^`]+)`$/gm)].map((match) => match[1])

  expect(groups).toEqual(['Functions', 'Types'])
  expect(headings).toEqual(['buildPatch', 'zedFactory', 'AlphaRecord', 'ZedOptions'])
})

test('uses public aliases for dependencies exported as minified chunk names', async () => {
  const project = await createProject()
  const inputFile = join(project, 'index.d.mts')

  await writeFile(
    join(project, 'schema-BCZugTrh.d.mts'),
    `
/** JSON value docs. */
type JsonValue = string | number | JsonValue[] | {
  [key: string]: JsonValue
}

/** JSON record docs. */
type JsonRecord = Record<string, JsonValue>

/** Parse patch docs. */
declare function parsePatch(input: JsonRecord): JsonRecord

export { JsonRecord as A, parsePatch as C, JsonValue as j }
`,
  )
  await writeFile(
    inputFile,
    `
import { A as JsonRecord, C as parsePatch, j as JsonValue } from "./schema-BCZugTrh.mjs";
export { type JsonRecord, type JsonValue, parsePatch };
`,
  )

  const result = await generateMarkdownForModule(inputFile, {
    cwd: project,
    followReExports: true,
    symbols: ['parsePatch'],
  })

  expect(result.markdown).toContain('## `JsonValue`')
  expect(result.markdown).not.toContain('## `j`')
  expect(result.markdown).toContain('## `JsonRecord`')
  expect(result.markdown).not.toContain('## `A`')
  expect(result.markdown).toContain('## `parsePatch`')
  expect(result.markdown).toContain('export function parsePatch(input: JsonRecord): JsonRecord')
  expect(result.markdown).not.toContain('Record<string, j>')
})

test('filters explicit external re-export declarations by requested symbol', async () => {
  const project = await createProject()
  const inputFile = join(project, 'api.ts')

  await writeFile(join(project, 'types.ts'), 'export interface ExternalInput { value: string }\n')
  await writeFile(join(project, 'factory.ts'), 'export function makeThing() { return "thing" }\n')
  await writeFile(
    inputFile,
    `
export type { ExternalInput as Input } from './types'
export { makeThing } from './factory'
`,
  )

  const result = await generateMarkdownForModule(inputFile, {
    cwd: project,
    symbols: ['makeThing'],
  })

  expect(result.markdown).toContain("export { makeThing } from './factory';")
  expect(result.markdown).not.toContain('ExternalInput')
})

test('renders property docs below declaration code blocks when requested', async () => {
  const project = await createProject()
  const inputFile = join(project, 'api.d.ts')

  await writeFile(
    inputFile,
    `
/** Feature options. */
export interface FeatureOptions {
  /** Enables the feature. */
  enabled: boolean
  nested: {
    /**
     * Nested value docs.
     *
     * @remarks Keep this visible outside the code block.
     */
    value: string
  }
}
`,
  )

  const result = await generateMarkdownForModule(inputFile, {
    cwd: project,
    propertyDocs: 'list',
  })

  expect(result.markdown).toContain('```ts\nexport interface FeatureOptions {\n  enabled: boolean')
  expect(result.markdown).not.toContain('/** Enables the feature. */')
  expect(result.markdown).not.toContain('Nested value docs.\n     *')
  expect(result.markdown).toContain(
    [
      '**Properties**',
      '',
      '- `enabled`',
      '  Enables the feature.',
      '',
      '- `value`',
      '  Nested value docs.',
      '  ',
      '  **Remarks**',
      '  ',
      '  Keep this visible outside the code block.',
    ].join('\n'),
  )
})

test('includes non-exported local declarations required by requested exports', async () => {
  const project = await createProject()
  const inputFile = join(project, 'api.ts')

  await writeFile(
    inputFile,
    `
/** Internal input shape. */
interface InternalInput {
  value: string
}

/** Parses a raw value. */
function parseValue(value: InternalInput): number {
  return Number(value.value)
}

export { parseValue as parse }
`,
  )

  const result = await generateMarkdownForModule(inputFile, {
    cwd: project,
    symbols: ['parse'],
  })

  expect(result.markdown).toContain('## `InternalInput`')
  expect(result.markdown).toContain('Internal input shape.')
  expect(result.markdown).toContain('## `parse`')
  expect(result.markdown).toContain('export function parse(value: InternalInput): number;')
})

test('filters requested symbols and includes local dependencies plus import lines', async () => {
  const project = await createProject()
  const inputFile = join(project, 'api.ts')
  const typesFile = join(project, 'types.ts')

  await writeFile(typesFile, 'export interface ExternalInput { value: string }\n')
  await writeFile(
    inputFile,
    `
import type { ExternalInput } from './types'

/** Internal options. */
export interface Options {
  value: string
}

/** Creates an options value. */
export function createOptions(input: ExternalInput): Options {
  return { value: input.value }
}

/** Not requested. */
export function unused(): string {
  return 'unused'
}
`,
  )

  const result = await generateMarkdownForModule(inputFile, {
    cwd: project,
    symbols: ['createOptions'],
  })

  expect(result.markdown).toContain("import type { ExternalInput } from './types';")
  expect(result.markdown).toContain('## `Options`')
  expect(result.markdown).toContain('Internal options.')
  expect(result.markdown).toContain('## `createOptions`')
  expect(result.markdown).toContain('ExternalInput')
  expect(result.markdown).not.toContain('unused')
})

test('omits import-only declaration symbols when following imports', async () => {
  const project = await createProject()
  const inputFile = join(project, 'api.ts')

  await writeFile(
    join(project, 'types.d.ts'),
    `
/** External input docs. */
export interface ExternalInput {
  value: string
}

/** Unused external docs. */
export interface UnusedExternal {
  value: string
}
`,
  )
  await writeFile(
    inputFile,
    `
import type { ExternalInput as Input } from './types'

/** Creates an input value. */
export function createInput(input: Input): Input {
  return input
}
`,
  )

  const result = await generateMarkdownForModule(inputFile, {
    cwd: project,
    followImports: true,
    symbols: ['createInput'],
  })

  expect(result.markdown).not.toContain("import type { ExternalInput as Input } from './types';")
  expect(result.markdown).toContain('## `createInput`')
  expect(result.markdown).not.toContain('## `Input`')
  expect(result.markdown).not.toContain('External input docs.')
  expect(result.markdown).not.toContain('UnusedExternal')
  expect(result.warnings).toEqual([
    'Imported symbol "Input" from "./types" is referenced by the public API of api.ts but is not exported; it was omitted from the rendered Markdown.',
  ])
})

test('does not follow imports that resolve into node_modules', async () => {
  const project = await createProject()
  const inputFile = join(project, 'api.ts')

  await writeFile(
    join(project, 'node_modules', 'external.d.ts'),
    `
/** External input docs. */
export interface ExternalInput {
  value: string
}
`,
  )
  await writeFile(
    inputFile,
    `
import type { ExternalInput } from './node_modules/external'

/** Creates an input value. */
export function createInput(input: ExternalInput): ExternalInput {
  return input
}
`,
  )

  const result = await generateMarkdownForModule(inputFile, {
    cwd: project,
    followImports: true,
    symbols: ['createInput'],
  })

  expect(result.markdown).toContain("import type { ExternalInput } from './node_modules/external';")
  expect(result.markdown).toContain('## `createInput`')
  expect(result.markdown).not.toContain('## `ExternalInput`')
  expect(result.markdown).not.toContain('External input docs.')
  expect(result.warnings).toEqual([])
})

test('warns about import-only declaration aliases when following imports', async () => {
  const project = await createProject()
  const inputFile = join(project, 'api.d.mts')

  await writeFile(
    join(project, 'schema-BCZugTrh.d.mts'),
    `
/** JSON value docs. */
type JsonValue = string | number | JsonValue[] | {
  [key: string]: JsonValue
}

/** JSON record docs. */
type JsonRecord = Record<string, JsonValue>

export { JsonRecord as A, JsonValue as j }
`,
  )
  await writeFile(
    inputFile,
    `
import { A as JsonRecord } from "./schema-BCZugTrh.mjs";

/** Stores a record. */
export declare function storeRecord(input: JsonRecord): JsonRecord
`,
  )

  const result = await generateMarkdownForModule(inputFile, {
    cwd: project,
    followImports: true,
    symbols: ['storeRecord'],
  })

  expect(result.markdown).not.toContain('## `JsonValue`')
  expect(result.markdown).not.toContain('## `j`')
  expect(result.markdown).not.toContain('## `JsonRecord`')
  expect(result.markdown).not.toContain('## `A`')
  expect(result.markdown).not.toContain('type JsonRecord = Record<string, JsonValue>')
  expect(result.markdown).not.toContain('export type JsonRecord')
  expect(result.warnings).toEqual([
    'Imported symbol "JsonRecord" from "./schema-BCZugTrh.mjs" is referenced by the public API of api.d.mts but is not exported; it was omitted from the rendered Markdown.',
  ])
})
