import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findNearestTypescript, generateMarkdownForModule } from '../src/index'

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
  expect(output).toContain('```ts\nexport declare function greet(name: string): string;\n```')
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
  expect(result.markdown).toContain('declare function parseValue(value: string): number;')
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
  expect(result.markdown).toContain('# dist/index.d.ts')
  expect(result.markdown).toContain('## `createMain`')
  expect(result.markdown).toContain('# dist/feature.d.ts')
  expect(result.markdown).toContain('## `FeatureOptions`')
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

  expect(indexOutput).toContain('# dist/index.d.ts')
  expect(indexOutput).toContain('## `createMain`')
  expect(extraOutput).toContain('# dist/features/extra.d.ts')
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
  expect(result.markdown).toContain('declare function parseValue(value: InternalInput): number;')
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
