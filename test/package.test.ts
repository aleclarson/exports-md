import { execFile as execFileCallback } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { generateMarkdownForModule } from '../src/index'
import { createProject, humanCliEnv, installTsrxCompiler, tempDirs } from './helpers'

const execFile = promisify(execFileCallback)

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
test('renders TypeScript package entries that re-export TSRX modules', async () => {
  const project = await createProject()
  const packageDir = join(project, 'packages', 'ui')
  const sourceDir = join(packageDir, 'src')
  await mkdir(sourceDir, { recursive: true })
  await installTsrxCompiler(project)
  await writeFile(
    join(sourceDir, 'index.web.ts'),
    `export { Button } from './button.web'\n`,
  )
  await writeFile(
    join(sourceDir, 'button.web.tsrx'),
    `/** Public button API. */\nexport function Button() { return <button /> }\n`,
  )
  await writeFile(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: '@example/ui', exports: './src/index.web.ts' }),
  )

  const result = await generateMarkdownForModule(join(packageDir, 'package.json'), {
    cwd: project,
  })

  expect(result.markdown).toContain('## `Button`')
  expect(result.markdown).toContain('Public button API.')
  expect(result.markdown).toContain('export declare function Button(): string;')
  expect(result.markdown).not.toContain('<button />')
})

test('renders a TSRX package entry point', async () => {
  const project = await createProject()
  const packageDir = join(project, 'packages', 'widgets')
  await mkdir(join(packageDir, 'src'), { recursive: true })
  await installTsrxCompiler(project)
  await writeFile(
    join(packageDir, 'src', 'index.tsrx'),
    `/** Widget configuration. */\nexport interface WidgetOptions { enabled: boolean }\n`,
  )
  await writeFile(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: '@example/widgets', exports: './src/index.tsrx' }),
  )

  const result = await generateMarkdownForModule(join(packageDir, 'package.json'), {
    cwd: project,
  })

  expect(result.markdown).toContain('## `WidgetOptions`')
  expect(result.markdown).toContain('Widget configuration.')
  expect(result.markdown).not.toContain('enabled: boolean }')
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
          './package.json': './package.json',
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
  expect(result.markdown).not.toContain('# foo/package.json')
})

test('expands wildcard package exports into concrete declaration entry points', async () => {
  const project = await createProject()
  const packageJson = join(project, 'package.json')

  await mkdir(join(project, 'dist', 'features', 'nested'), { recursive: true })
  await writeFile(
    join(project, 'dist', 'index.d.ts'),
    '/** Main API. */\nexport declare function createMain(): string\n',
  )
  await writeFile(
    join(project, 'dist', 'features', 'extra.d.ts'),
    '/** Extra API. */\nexport declare function createExtra(): string\n',
  )
  await writeFile(
    join(project, 'dist', 'features', 'nested', 'deep.d.ts'),
    '/** Deep API. */\nexport declare function createDeep(): string\n',
  )
  await writeFile(
    packageJson,
    JSON.stringify(
      {
        name: 'foo',
        exports: {
          '.': {
            types: './dist/index.d.ts',
            default: './dist/index.js',
          },
          './*': {
            types: './dist/*.d.ts',
            default: './dist/*.js',
          },
        },
      },
      null,
      2,
    ),
  )

  const result = await generateMarkdownForModule(packageJson, { cwd: project })

  expect(result.markdown).toMatch(/^# foo$/m)
  expect(result.markdown).toMatch(/^# foo\/index$/m)
  expect(result.markdown).toMatch(/^# foo\/features\/extra$/m)
  expect(result.markdown).toMatch(/^# foo\/features\/nested\/deep$/m)
  expect(result.markdown).toContain('## `createExtra`')
  expect(result.markdown).toContain('## `createDeep`')
  expect(result.markdown).not.toContain('*')
})

test('renders package exports from a directory input', async () => {
  const project = await createProject()
  const packageRoot = join(project, 'packages', 'foo')
  const packageJson = join(packageRoot, 'package.json')

  await mkdir(join(packageRoot, 'dist'), { recursive: true })
  await writeFile(
    join(packageRoot, 'dist', 'index.d.ts'),
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

  const { stdout } = await execFile(
    process.execPath,
    ['--experimental-strip-types', join(process.cwd(), 'src/cli.ts'), packageRoot],
    { cwd: project },
  )

  expect(stdout).toMatch(/^# foo$/m)
  expect(stdout).toContain('## `createMain`')
})

test('renders npm package specs without installing them', async () => {
  const project = await createProject()
  const fixture = join(project, 'fixture')
  const archiveDir = join(project, 'archive')

  await mkdir(join(fixture, 'dist'), { recursive: true })
  await writeFile(join(fixture, 'dist', 'index.d.mts'), "export { createThing } from './api.mjs'\n")
  await writeFile(
    join(fixture, 'dist', 'api.d.mts'),
    '/** Creates a thing. */\nexport declare function createThing(): string\n',
  )
  await writeFile(
    join(fixture, 'package.json'),
    JSON.stringify(
      {
        name: 'fixture-package',
        version: '1.0.0',
        type: 'module',
        types: './dist/index.d.mts',
        exports: {
          '.': './dist/index.mjs',
        },
      },
      null,
      2,
    ),
  )
  await mkdir(archiveDir)

  const { stdout: archiveName } = await execFile(
    'npm',
    ['pack', '--silent', '--ignore-scripts', '--pack-destination', archiveDir],
    { cwd: fixture },
  )
  const archiveFile = join(archiveDir, archiveName.trim())
  const npmBin = join(project, 'npm-bin')
  const npmShimScript = join(npmBin, 'npm-shim.cjs')
  const npmShim = join(npmBin, process.platform === 'win32' ? 'npm.cmd' : 'npm')
  await mkdir(npmBin)
  await writeFile(
    npmShimScript,
    `
const { copyFileSync } = require('node:fs')
const { basename, join } = require('node:path')

const destinationIndex = process.argv.indexOf('--pack-destination')
const archive = process.env.EXPORTS_MD_TEST_ARCHIVE
if (destinationIndex === -1 || !archive) process.exit(1)

const output = basename(archive)
copyFileSync(archive, join(process.argv[destinationIndex + 1], output))
process.stdout.write(output + '\\n')
`,
  )
  if (process.platform === 'win32') {
    await writeFile(npmShim, `@echo off\r\n"${process.execPath}" "${npmShimScript}" %*\r\n`)
  } else {
    await writeFile(npmShim, `#!/bin/sh\nexec "${process.execPath}" "${npmShimScript}" "$@"\n`)
    await chmod(npmShim, 0o755)
  }

  const { stdout } = await execFile(
    process.execPath,
    [
      '--experimental-strip-types',
      join(process.cwd(), 'src/cli.ts'),
      'fixture-package@1.0.0',
      '--follow',
    ],
    {
      cwd: project,
      env: {
        ...process.env,
        EXPORTS_MD_TEST_ARCHIVE: archiveFile,
        PATH: `${npmBin}${delimiter}${process.env.PATH ?? ''}`,
      },
    },
  )

  expect(stdout).toMatch(/^# fixture-package$/m)
  expect(stdout).toContain('## `createThing`')
  expect(stdout).toContain('Creates a thing.')
  expect(stdout).not.toContain("export { createThing } from './api.mjs';")
  expect(existsSync(join(project, 'node_modules', 'fixture-package'))).toBe(false)
  expect(existsSync(join(project, 'package-lock.json'))).toBe(false)
})

test('fails clearly when a directory input has no package manifest', async () => {
  const project = await createProject()
  const packageRoot = join(project, 'packages', 'foo')
  await mkdir(packageRoot, { recursive: true })

  await expect(generateMarkdownForModule(packageRoot, { cwd: project })).rejects.toThrow(
    `Package manifest not found in directory: ${join(packageRoot, 'package.json')}`,
  )
})

test('keeps package property docs inline by default', async () => {
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

  expect(result.markdown).toContain(
    '```ts\nexport interface FeatureOptions {\n  /** Enables the feature. */\n  enabled: boolean',
  )
  expect(result.markdown).not.toContain('**Properties**')
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
  expect(result.markdown).not.toContain('## `PackageInput`')
  expect(result.markdown).not.toContain('Package input docs.')
  expect(result.markdown).not.toContain('export interface PackageInput')
  expect(result.warnings).toEqual([
    'Imported symbol "PackageInput" from "./types" is referenced by the public API of dist/index.d.ts but is not exported; it was omitted from the rendered Markdown.',
  ])
})
