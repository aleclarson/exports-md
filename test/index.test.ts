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
  const output = await readFile(join(project, 'api.md'), 'utf8')

  expect(result.outputFile).toBe(join(project, 'api.md'))
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

test('uses TypeScript from the nearest node_modules under the current working directory', async () => {
  const project = await createProject()
  const nested = join(project, 'packages', 'demo')
  const inputFile = join(project, 'api.ts')
  await mkdir(nested, { recursive: true })
  await writeFile(inputFile, '/** The answer. */\nexport const answer = 42\n')

  expect(findNearestTypescript(nested)).toBe(join(project, 'node_modules', 'typescript'))
  await expect(generateMarkdownForModule(inputFile, { cwd: nested })).resolves.toMatchObject({
    outputFile: join(project, 'api.md'),
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
