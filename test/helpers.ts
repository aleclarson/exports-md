import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const tempDirs: string[] = []

export function humanCliEnv(home: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home }
  for (const key of [
    'AI_AGENT',
    'ANTIGRAVITY_AGENT',
    'AUGMENT_AGENT',
    'CLAUDECODE',
    'CLAUDE_CODE',
    'CLAUDE_CODE_IS_COWORK',
    'CODEX_CI',
    'CODEX_SANDBOX',
    'CODEX_THREAD_ID',
    'COPILOT_ALLOW_ALL',
    'COPILOT_GITHUB_TOKEN',
    'COPILOT_MODEL',
    'CURSOR_AGENT',
    'CURSOR_EXTENSION_HOST_ROLE',
    'CURSOR_TRACE_ID',
    'GEMINI_CLI',
    'OPENCODE_CLIENT',
    'REPL_ID',
  ]) {
    delete env[key]
  }
  return env
}

export async function createProject() {
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

export async function installTsrxCompiler(project: string) {
  const compilerDir = join(project, 'node_modules', '@tsrx', 'typescript-plugin', 'dist')
  await mkdir(compilerDir, { recursive: true })
  await writeFile(
    join(compilerDir, 'tsc.js'),
    `
const fs = require('node:fs')
const path = require('node:path')
const configPath = process.argv[process.argv.indexOf('--project') + 1]
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
const outputDir = config.compilerOptions.outDir
const root = config.files[0]
const visited = new Set()
function emit(file) {
  if (visited.has(file)) return
  visited.add(file)
  const source = fs.readFileSync(file, 'utf8')
  for (const match of source.matchAll(/(?:export|import)\\s+[^;]*?from\\s+['\"]([^'\"]+)['\"]/g)) {
    const specifier = match[1]
    if (!specifier.startsWith('.')) continue
    const base = path.resolve(path.dirname(file), specifier)
    const target = [base, base + '.ts', base + '.tsrx', path.join(base, 'index.tsrx')]
      .find(candidate => fs.existsSync(candidate) && /\\.(ts|tsrx)$/.test(candidate))
    if (target) emit(target)
  }
  const exported = [...source.matchAll(/(\\/\\*\\*[\\s\\S]*?\\*\\/\\s*)?export\\s+(?:declare\\s+)?(function|const|type|interface)\\s+(\\w+)/g)]
  const declarations = exported.map(([, comment = '', kind, name]) => comment.trim() + (comment ? '\\n' : '') + (kind === 'function'
    ? 'export declare function ' + name + '(): string;'
    : kind === 'const'
      ? 'export declare const ' + name + ': string;'
      : 'export declare ' + kind + ' ' + name + ' {}'))
  const output = path.join(outputDir, path.basename(file).replace(/\\.(ts|tsrx)$/, '.d.ts'))
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, declarations.join('\\n') + '\\n')
}
emit(root)
`,
  )
}
