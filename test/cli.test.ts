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
test('renders property docs as a list from the CLI when requested', async () => {
  const project = await createProject()
  const inputFile = join(project, 'api.d.ts')

  await writeFile(
    inputFile,
    `
/** Feature options. */
export interface FeatureOptions {
  /** Enables the feature. */
  enabled: boolean
}
`,
  )

  const { stdout } = await execFile(
    process.execPath,
    [
      '--experimental-strip-types',
      join(process.cwd(), 'src/cli.ts'),
      inputFile,
      '--propertyDocs',
      'list',
    ],
    { cwd: project },
  )

  expect(stdout).toContain('```ts\nexport interface FeatureOptions {\n  enabled: boolean')
  expect(stdout).not.toContain('/** Enables the feature. */')
  expect(stdout).toContain(
    ['**Properties**', '', '- `enabled`', '  Enables the feature.'].join('\n'),
  )
})

test('uses human CLI defaults from ~/.config/exports-md.json', async () => {
  const project = await createProject()
  const home = await createProject()
  const inputFile = join(project, 'api.d.ts')

  await mkdir(join(home, '.config'), { recursive: true })
  await writeFile(
    join(home, '.config', 'exports-md.json'),
    JSON.stringify({ propertyDocs: 'list' }),
  )
  await writeFile(
    inputFile,
    `
export interface FeatureOptions {
  /** Enables the feature. */
  enabled: boolean
}
`,
  )

  const { stdout } = await execFile(
    process.execPath,
    ['--experimental-strip-types', join(process.cwd(), 'src/cli.ts'), inputFile],
    { cwd: project, env: humanCliEnv(home) },
  )

  expect(stdout).not.toContain('/** Enables the feature. */')
  expect(stdout).toContain('**Properties**')
})

test('ignores ~/.config/exports-md.json for agent callers', async () => {
  const project = await createProject()
  const home = await createProject()
  const inputFile = join(project, 'api.d.ts')

  await mkdir(join(home, '.config'), { recursive: true })
  await writeFile(
    join(home, '.config', 'exports-md.json'),
    JSON.stringify({ propertyDocs: 'list' }),
  )
  await writeFile(
    inputFile,
    `
export interface FeatureOptions {
  /** Enables the feature. */
  enabled: boolean
}
`,
  )

  const { stdout } = await execFile(
    process.execPath,
    ['--experimental-strip-types', join(process.cwd(), 'src/cli.ts'), inputFile],
    { cwd: project, env: { ...humanCliEnv(home), AI_AGENT: 'test-agent' } },
  )

  expect(stdout).toContain('/** Enables the feature. */')
  expect(stdout).not.toContain('**Properties**')
})

test('pipes generated Markdown to another CLI command', async () => {
  const project = await createProject()
  const inputFile = join(project, 'api.d.ts')
  const pipeCommand = join(project, 'uppercase-markdown')

  await writeFile(inputFile, 'export declare const answer: 42\n')
  await writeFile(pipeCommand, '#!/bin/sh\ntr "[:lower:]" "[:upper:]"\n')
  await chmod(pipeCommand, 0o755)

  const { stdout } = await execFile(
    process.execPath,
    [
      '--experimental-strip-types',
      join(process.cwd(), 'src/cli.ts'),
      inputFile,
      '--pipe',
      pipeCommand,
    ],
    { cwd: project },
  )

  expect(stdout).toContain('# API.D.TS')
  expect(stdout).toContain('EXPORT CONST ANSWER: 42')
  expect(stdout).not.toContain('# api.d.ts')
})

test('groups same-module exports from the CLI when requested', async () => {
  const project = await createProject()
  const inputFile = join(project, 'api.ts')

  await writeFile(
    inputFile,
    `
export type Config = {
  name: string
}

export function createConfig(): Config {
  return { name: 'default' }
}
`,
  )

  const { stdout } = await execFile(
    process.execPath,
    ['--experimental-strip-types', join(process.cwd(), 'src/cli.ts'), inputFile, '-g'],
    { cwd: project },
  )

  expect(stdout.indexOf('### `createConfig`')).toBeLessThan(stdout.indexOf('### `Config`'))
})

test('sorts same-module symbols alphabetically from the CLI when requested', async () => {
  const project = await createProject()
  const inputFile = join(project, 'api.ts')

  await writeFile(
    inputFile,
    `
export const zebra = true
export const apple = true
`,
  )

  const { stdout } = await execFile(
    process.execPath,
    ['--experimental-strip-types', join(process.cwd(), 'src/cli.ts'), inputFile, '-s'],
    { cwd: project },
  )

  expect(stdout.indexOf('## `apple`')).toBeLessThan(stdout.indexOf('## `zebra`'))
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
      join(process.cwd(), 'src/cli.ts'),
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

test('prints GitHub search links from CLI options', async () => {
  const project = await createProject()
  const inputFile = join(project, 'api.ts')

  await writeFile(
    inputFile,
    `
/** Parses input. */
export function parse(input: string) {
  return input
}
`,
  )

  const { stdout } = await execFile(
    process.execPath,
    [
      '--experimental-strip-types',
      join(process.cwd(), 'src/cli.ts'),
      inputFile,
      '--github.repository',
      'aleclarson/leylines',
      '--github.searchLinks',
    ],
    { cwd: project },
  )

  expect(stdout).toContain(
    '[<sup>🔍 **parse** on GitHub</sup>](https://github.com/search?q=repo%3Aaleclarson/leylines%20parse&type=code)',
  )
})
