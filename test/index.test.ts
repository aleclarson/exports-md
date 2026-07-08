import { execFile as execFileCallback } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { findNearestTypescript, generateMarkdownForModule } from '../src/index'

const execFile = promisify(execFileCallback)
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

test('writes markdown docs next to a TypeScript module', async () => {
  const project = await createProject()
  const inputFile = join(project, 'api.ts')

  await writeFile(
    inputFile,
    `
/**
 * Greets a user.
 *
 * @param name - The name to greet.
 * @returns A greeting message.
 */
export function greet(name: string) {
  return \`Hello, \${name}\`
}

/** Available output modes. */
export type OutputMode = 'short' | 'long'

const hidden = true
`,
  )

  const result = await generateMarkdownForModule(inputFile, { cwd: project })
  const output = result.markdown

  expect(result.fromCache).toBe(false)
  expect(existsSync(join(project, 'api.md'))).toBe(false)
  expect(output).toContain('# api.ts')
  expect(output).toContain('## `greet`')
  expect(output).toContain('Greets a user.')
  expect(output).toContain('- `name`: The name to greet.')
  expect(output).toContain('**Returns**')
  expect(output).toContain('A greeting message.')
  expect(output).toContain('```ts\nexport function greet(name: string): string;\n```')
  expect(output).toContain('Available output modes.')
  expect(output).not.toContain('\n Available output modes.')
  expect(output).toContain("export type OutputMode = 'short' | 'long';")
  expect(output).not.toContain('hidden')
})

test('reuses cached markdown for unchanged inputs', async () => {
  const project = await createProject()
  const inputFile = join(project, 'api.ts')
  await writeFile(inputFile, '/** The answer. */\nexport const answer = 42\n')

  await expect(generateMarkdownForModule(inputFile, { cwd: project })).resolves.toMatchObject({
    fromCache: false,
  })
  await expect(generateMarkdownForModule(inputFile, { cwd: project })).resolves.toMatchObject({
    fromCache: true,
    markdown: expect.stringContaining('The answer.'),
  })
})

test('uses the nearest tsconfig from the module parent directory', async () => {
  const project = await createProject()
  const packageDir = join(project, 'packages', 'demo')
  const inputFile = join(packageDir, 'api.ts')
  await mkdir(packageDir, { recursive: true })
  await writeFile(
    join(packageDir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          strict: false,
          types: [],
        },
      },
      null,
      2,
    ),
  )
  await writeFile(
    inputFile,
    `
/** Returns the input value. */
export function identity(value) {
  return value
}
`,
  )

  const result = await generateMarkdownForModule(inputFile, { cwd: project })

  expect(result.markdown).toContain('## `identity`')
  expect(result.markdown).toContain('export function identity(value: any): any;')
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

test('follows relative re-exports by default for package inputs', async () => {
  const project = await createProject()
  const packageJson = join(project, 'package.json')

  await mkdir(join(project, 'dist'), { recursive: true })
  await writeFile(
    join(project, 'dist', 'index.d.ts'),
    `
export { createMain } from './main'
`,
  )
  await writeFile(
    join(project, 'dist', 'main.d.ts'),
    `
/** Main API. */
export declare function createMain(): string
`,
  )
  await writeFile(
    packageJson,
    JSON.stringify(
      {
        name: 'foo',
        exports: './dist/index.js',
      },
      null,
      2,
    ),
  )

  const result = await generateMarkdownForModule(packageJson, { cwd: project })

  expect(result.markdown).toMatch(/^# foo$/m)
  expect(result.markdown).not.toContain("export { createMain } from './main';")
  expect(result.markdown).toContain('## `createMain`')
  expect(result.markdown).toContain('Main API.')
})

test('renders package exports from package.json input', async () => {
  const project = await createProject()
  const packageJson = join(project, 'package.json')

  await mkdir(join(project, 'dist'), { recursive: true })
  await writeFile(
    join(project, 'dist', 'index.d.ts'),
    `
/** Main API. */
export declare function createMain(): string
`,
  )
  await writeFile(
    join(project, 'dist', 'feature.d.ts'),
    `
/** Feature options. */
export interface FeatureOptions {
  enabled: boolean
}
`,
  )
  await writeFile(
    packageJson,
    JSON.stringify(
      {
        name: 'foo',
        exports: {
          '.': {
            types: './dist/index.d.ts',
            import: './dist/runtime.js',
          },
          './feature': './dist/feature.js',
        },
      },
      null,
      2,
    ),
  )

  const result = await generateMarkdownForModule(packageJson, { cwd: project })

  expect(result.inputFile).toBe(packageJson)
  expect(result.markdown).toMatch(/^# foo$/m)
  expect(result.markdown).toContain('## `createMain`')
  expect(result.markdown).toMatch(/^# foo\/feature$/m)
  expect(result.markdown).toContain('## `FeatureOptions`')
})

test('renders package property docs below declaration code blocks', async () => {
  const project = await createProject()
  const packageJson = join(project, 'package.json')

  await mkdir(join(project, 'dist'), { recursive: true })
  await writeFile(
    join(project, 'dist', 'index.d.ts'),
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
  await writeFile(
    packageJson,
    JSON.stringify(
      {
        name: 'foo',
        exports: './dist/index.js',
      },
      null,
      2,
    ),
  )

  const result = await generateMarkdownForModule(packageJson, { cwd: project })

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

test('prints package entry symbols in reverse order when requested', async () => {
  const project = await createProject()
  const packageJson = join(project, 'package.json')

  await mkdir(join(project, 'dist'), { recursive: true })
  await writeFile(
    join(project, 'dist', 'index.d.ts'),
    `
/** First API. */
export declare function first(): string

/** Second API. */
export declare function second(): string
`,
  )
  await writeFile(
    packageJson,
    JSON.stringify(
      {
        name: 'foo',
        exports: './dist/index.js',
      },
      null,
      2,
    ),
  )

  const result = await generateMarkdownForModule(packageJson, {
    cwd: project,
    reverseSymbols: true,
  })

  expect(result.markdown.indexOf('## `second`')).toBeLessThan(result.markdown.indexOf('## `first`'))
})

test('filters package input symbols across export entries', async () => {
  const project = await createProject()
  const packageJson = join(project, 'package.json')

  await mkdir(join(project, 'dist'), { recursive: true })
  await writeFile(
    join(project, 'dist', 'index.d.ts'),
    `
/** Main API. */
export declare function createMain(): string
`,
  )
  await writeFile(
    join(project, 'dist', 'feature.d.ts'),
    `
/** Feature API. */
export declare function createFeature(): string
`,
  )
  await writeFile(
    packageJson,
    JSON.stringify(
      {
        name: 'foo',
        exports: {
          '.': './dist/index.js',
          './feature': './dist/feature.js',
        },
      },
      null,
      2,
    ),
  )

  const result = await generateMarkdownForModule(packageJson, {
    cwd: project,
    symbols: ['createFeature'],
  })

  expect(result.markdown).not.toContain('# foo\n')
  expect(result.markdown).not.toContain('createMain')
  expect(result.markdown).toMatch(/^# foo\/feature$/m)
  expect(result.markdown).toContain('## `createFeature`')
})

test('prints selected symbols from multiple CLI inputs', async () => {
  const project = await createProject()
  const firstInput = join(project, 'first.ts')
  const secondInput = join(project, 'second.ts')

  await writeFile(
    firstInput,
    `
/** First API. */
export function first(): string {
  return 'first'
}
`,
  )
  await writeFile(
    secondInput,
    `
/** Second API. */
export function second(): string {
  return 'second'
}
`,
  )

  const { stdout } = await execFile(
    process.execPath,
    [
      '--experimental-strip-types',
      join(process.cwd(), 'src/index.ts'),
      firstInput,
      secondInput,
      '--',
      'first',
      'second',
    ],
    { cwd: project },
  )

  expect(stdout).toMatch(/^# first.ts$/m)
  expect(stdout).toContain('## `first`')
  expect(stdout).toMatch(/^# second.ts$/m)
  expect(stdout).toContain('## `second`')
  expect(stdout.indexOf('# first.ts')).toBeLessThan(stdout.indexOf('# second.ts'))
})

test('writes package markdown entries to an output directory', async () => {
  const project = await createProject()
  const packageJson = join(project, 'package.json')

  await mkdir(join(project, 'dist', 'features'), { recursive: true })
  await writeFile(
    join(project, 'dist', 'index.d.ts'),
    `
/** Main API. */
export declare function createMain(): string
`,
  )
  await writeFile(
    join(project, 'dist', 'features', 'extra.d.ts'),
    `
/** Extra API. */
export declare function createExtra(): string
`,
  )
  await writeFile(
    packageJson,
    JSON.stringify(
      {
        name: 'foo',
        exports: {
          '.': './dist/index.js',
          './extra': './dist/features/extra.mjs',
        },
      },
      null,
      2,
    ),
  )

  await generateMarkdownForModule(packageJson, {
    cwd: project,
    outDir: 'docs/api',
  })

  const indexOutput = await readFile(join(project, 'docs', 'api', 'index.md'), 'utf8')
  const extraOutput = await readFile(join(project, 'docs', 'api', 'features', 'extra.md'), 'utf8')

  expect(indexOutput).toMatch(/^# foo$/m)
  expect(indexOutput).toContain('## `createMain`')
  expect(extraOutput).toMatch(/^# foo\/extra$/m)
  expect(extraOutput).toContain('## `createExtra`')
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

test('follows relative imports to declarations when requested', async () => {
  const project = await createProject()
  const inputFile = join(project, 'api.ts')

  await writeFile(
    join(project, 'types.ts'),
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
  expect(result.markdown).toContain('## `Input`')
  expect(result.markdown).toContain('External input docs.')
  expect(result.markdown).toContain('interface Input')
  expect(result.markdown).not.toContain('export interface Input')
  expect(result.markdown).not.toContain('UnusedExternal')
})

test('uses public aliases for dependencies of followed imports', async () => {
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

  expect(result.markdown).toContain('## `JsonValue`')
  expect(result.markdown).not.toContain('## `j`')
  expect(result.markdown).toContain('## `JsonRecord`')
  expect(result.markdown).not.toContain('## `A`')
  expect(result.markdown).toContain('type JsonRecord = Record<string, JsonValue>')
  expect(result.markdown).not.toContain('export type JsonRecord')
  expect(result.markdown).not.toContain('Record<string, j>')
})

test('follows relative imports by default for package inputs', async () => {
  const project = await createProject()
  const packageJson = join(project, 'package.json')

  await mkdir(join(project, 'dist'), { recursive: true })
  await writeFile(
    join(project, 'dist', 'types.d.ts'),
    `
/** Package input docs. */
export interface PackageInput {
  value: string
}
`,
  )
  await writeFile(
    join(project, 'dist', 'index.d.ts'),
    `
import type { PackageInput } from './types'

/** Creates a package input. */
export declare function createPackageInput(input: PackageInput): PackageInput
`,
  )
  await writeFile(
    packageJson,
    JSON.stringify(
      {
        name: 'foo',
        exports: './dist/index.js',
      },
      null,
      2,
    ),
  )

  const result = await generateMarkdownForModule(packageJson, { cwd: project })

  expect(result.markdown).not.toContain("import type { PackageInput } from './types';")
  expect(result.markdown).toContain('## `createPackageInput`')
  expect(result.markdown).toContain('## `PackageInput`')
  expect(result.markdown).toContain('Package input docs.')
  expect(result.markdown).not.toContain('export interface PackageInput')
})

test('fails clearly when a requested export is missing', async () => {
  const project = await createProject()
  const inputFile = join(project, 'api.ts')
  await writeFile(inputFile, '/** The answer. */\nexport const answer = 42\n')

  await expect(
    generateMarkdownForModule(inputFile, {
      cwd: project,
      symbols: ['missing'],
    }),
  ).rejects.toThrow('Export not found: missing')
})

test('uses TypeScript from the nearest node_modules under the current working directory', async () => {
  const project = await createProject()
  const nested = join(project, 'packages', 'demo')
  const inputFile = join(project, 'api.ts')
  await mkdir(nested, { recursive: true })
  await writeFile(inputFile, '/** The answer. */\nexport const answer = 42\n')

  expect(findNearestTypescript(nested)).toBe(join(project, 'node_modules', 'typescript'))
  await expect(generateMarkdownForModule(inputFile, { cwd: nested })).resolves.toMatchObject({
    inputFile,
  })
})

async function createProject() {
  const project = await mkdtemp(join(tmpdir(), 'exports-md-'))
  tempDirs.push(project)

  await mkdir(join(project, 'node_modules'), { recursive: true })
  const localTypescript = join(process.cwd(), 'node_modules', 'typescript')
  if (!existsSync(localTypescript)) {
    throw new Error('Run pnpm install before running these tests.')
  }

  await symlink(localTypescript, join(project, 'node_modules', 'typescript'), 'dir')
  await writeFile(
    join(project, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          lib: ['esnext'],
          module: 'esnext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'esnext',
          types: [],
        },
        include: ['*.ts'],
      },
      null,
      2,
    ),
  )

  return project
}
