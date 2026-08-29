import { execFile as execFileCallback } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { findNearestTypescript, generateMarkdownForModule } from '../src/index'
import { createProject, humanCliEnv, tempDirs } from './helpers'

const execFile = promisify(execFileCallback)

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
