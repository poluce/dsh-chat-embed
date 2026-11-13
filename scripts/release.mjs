/**
 * One-command release for dsh-chat-embed.
 *
 *   node scripts/release.mjs 0.6.7 --summary "一句话说明这次改了什么"
 *   node scripts/release.mjs 0.6.7 --summary "..." --notes dist/notes.md
 *   node scripts/release.mjs 0.6.7 --summary "..." --dry-run
 *   node scripts/release.mjs 0.6.7 --summary "..." --stop-after gate
 *
 * It performs the release docs/publishing.md documents, in that order:
 *
 *   1. bump       package.json / client.js BUILD / README 历史 / 两份文档
 *   2. gate       npm run check
 *   3. commit     普通提交
 *   4. push       master，触发 CI
 *   5. ci         等这次推送的 CI 跑完，红了就停
 *   6. publish    触发 publish.yml，由 OIDC 在 CI 里发布（不可逆，因此排在 tag 之前）
 *      tag        tag + 推送（CI 再校验一次 tag == version）
 *      release    打包 + gh release create
 *
 * Every phase first checks what is already true on disk / on npm / on GitHub, so
 * a run that died in the middle resumes by re-running the same command: a
 * published version is not published twice, an existing tag is not re-created,
 * an existing release is not duplicated.
 *
 * The package has no dependencies; this script uses Node built-ins only.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PKG = 'dsh-chat-embed'
const REPO = 'poluce/dsh-chat-embed'
const TAGGED_PHASES = ['bump', 'gate', 'commit', 'push', 'ci', 'publish', 'tag', 'release']

const CI_TIMEOUT_MS = 15 * 60 * 1000
const CI_POLL_MS = 10 * 1000
const IS_WINDOWS = process.platform === 'win32'

// ---------------------------------------------------------------- utilities

/** @param {string} message */
const say = (message) => console.log(message)

/** @param {string} message */
const step = (message) => console.log('\n=== ' + message + ' ===')

/** @param {string} message @returns {never} */
function die(message) {
  console.error('\n失败: ' + message)
  process.exit(1)
}

/** @param {number} ms @returns {Promise<void>} */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Run a command with inherited stdio so npm/git/gh print their own output.
 *
 * Windows resolves npm through npm.cmd, which needs a shell. The other tools are
 * executables and run without one, so a path containing spaces is never
 * re-parsed by a shell.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ allowFailure?: boolean }} [options]
 * @returns {number} exit code
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: IS_WINDOWS && (command === 'npm' || command === 'npx'),
  })
  if (result.error !== undefined && result.error !== null) {
    if (options.allowFailure === true) return 1
    die(command + ' 无法执行: ' + result.error.message)
  }
  const code = result.status ?? 1
  if (code !== 0 && options.allowFailure !== true) die(command + ' ' + args.join(' ') + ' 退出码 ' + code)
  return code
}

/**
 * Run a command and capture trimmed stdout.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ allowFailure?: boolean }} [options]
 * @returns {string}
 */
function capture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: IS_WINDOWS && (command === 'npm' || command === 'npx'),
  })
  if (result.status !== 0) {
    if (options.allowFailure === true) return ''
    die(command + ' ' + args.join(' ') + ' 失败: ' + String(result.stderr ?? '').split('\n')[0])
  }
  return String(result.stdout ?? '').trim()
}

/** @param {string} file @returns {string} */
const read = (file) => readFileSync(join(ROOT, file), 'utf8')

/** @param {string} file @param {string} content */
const write = (file, content) => writeFileSync(join(ROOT, file), content)

/**
 * Edit a file in place.
 *
 * The tree mixes conventions — README.md and client.js are CRLF, docs/ and
 * package.json are LF — so every edit normalises to LF, runs the transform and
 * restores whatever the file used. A transform that changes nothing returns
 * false and leaves the file untouched, which is what makes bump re-runnable.
 *
 * @param {string} file
 * @param {(text: string) => string} transform
 * @returns {boolean} whether anything changed
 */
function edit(file, transform) {
  const raw = read(file)
  const crlf = raw.includes('\r\n')
  const before = crlf ? raw.split('\r\n').join('\n') : raw
  const after = transform(before)
  if (after === before) return false
  write(file, crlf ? after.split('\n').join('\r\n') : after)
  return true
}

// ---------------------------------------------------------------- arguments

/** @param {string[]} argv */
function parseArgs(argv) {
  const options = {
    version: undefined,
    summary: undefined,
    notes: undefined,
    dryRun: false,
    stopAfter: 'release',
    help: false,
  }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--summary') options.summary = argv[++i]
    else if (arg === '--notes') options.notes = argv[++i]
    else if (arg === '--stop-after') options.stopAfter = argv[++i]
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg.startsWith('--')) die('未知参数: ' + arg)
    else positional.push(arg)
  }
  options.version = positional[0]
  return options
}

function usage() {
  console.log(
    [
      'release.mjs — 一条命令完成发版',
      '',
      '用法:',
      '  node scripts/release.mjs <版本> --summary "一句话" [--notes <文件>] [--dry-run]',
      '  node scripts/release.mjs <版本> --summary "一句话" --stop-after gate',
      '',
      '选项:',
      '  --summary <文本>      必填。写进 README 版本历史表与提交信息正文',
      '  --notes <文件>        GitHub Release 的说明文件；不填则用 --summary 生成',
      '  --dry-run             只打印将要做什么，不改文件、不推送、不发布',
      '  --stop-after <阶段>   ' + TAGGED_PHASES.join(' | '),
      '',
      '阶段按顺序执行，每一步先检查现状：已发布的版本不会再发、已存在的 tag 不会重建、',
      '已存在的 release 不会重复创建。中途失败后重跑同一条命令即可续做。',
    ].join('\n'),
  )
}

// ---------------------------------------------------------------- phases

/**
 * Rewrite every place the version appears.
 *
 * All of these stay hand-authored files; the script only keeps them in sync so a
 * release cannot forget one.
 *
 * @param {string} version
 * @param {string} summary
 */
function bump(version, summary) {
  const previous = JSON.parse(read('package.json')).version

  if (previous === version) {
    say('  package.json           已是 ' + version)
  } else if (edit('package.json', (text) => text.replace(/"version":\s*"[^"]+"/, '"version": "' + version + '"'))) {
    say('  package.json           ' + previous + ' -> ' + version)
  }

  if (!/const BUILD = '[^']+'/.test(read('client.js'))) die('client.js 里找不到 const BUILD')
  if (edit('client.js', (text) => text.replace(/const BUILD = '[^']+'/, "const BUILD = '" + version + "'"))) {
    say('  client.js BUILD         -> ' + version)
  } else {
    say('  client.js BUILD         已是 ' + version)
  }

  // README 的版本历史表：在表头后插一行，已有则不动。
  let inserted = false
  edit('README.md', (text) => {
    if (text.includes('| `' + version + '` |')) return text
    const head = '## 版本历史\n\n| 版本 | 变化 |\n| --- | --- |\n'
    if (!text.includes(head)) die('README.md 里找不到版本历史表头')
    inserted = true
    return text.replace(head, head + '| `' + version + '` | ' + summary + ' |\n')
  })
  say(inserted ? '  README 版本历史         加了一行' : '  README 版本历史         已有 ' + version + ' 这一行')

  if (edit('docs/architecture.md', (text) => text.replace(/当前实现：\*\*v[\d.]+/, '当前实现：**v' + version))) {
    say('  docs/architecture.md    -> v' + version)
  }

  if (
    edit('docs/publishing.md', (text) =>
      text
        .replace(/`dsh-chat-embed-[\d.]+\.tgz`/g, '`dsh-chat-embed-' + version + '.tgz`')
        .replace(new RegExp('`' + PKG + '@[\\d.]+`', 'g'), '`' + PKG + '@' + version + '`')
        .replace(/已发布 `[\d.]+`/g, '已发布 `' + version + '`'),
    )
  ) {
    say('  docs/publishing.md      -> ' + version)
  }
}

/**
 * Build this release's commit message.
 *
 * History is ordinary now, so each commit describes only its own release instead
 * of repeating a project description — that is what the long first commit is for.
 *
 * @param {string} version
 * @param {string} summary
 * @returns {string}
 */
function commitMessage(version, summary) {
  return 'dsh-chat-embed ' + version + ': ' + summary
}

/**
 * The CI run for one ref.
 *
 * `--branch` matters: a tag and the branch it was cut from share a commit, so
 * filtering by commit alone would return the earlier branch run and let a red
 * tag run pass unnoticed.
 *
 * @param {string} ref
 * @returns {{ status: string, conclusion: string, url: string } | undefined}
 */
function runForRef(ref, workflow) {
  const sha = capture('git', ['rev-parse', 'HEAD'], { allowFailure: true })
  const raw = capture(
    'gh',
    ['run', 'list', '--repo', REPO, '--workflow', workflow, '--branch', ref, '--commit', sha, '--limit', '1', '--json', 'status,conclusion,url'],
    { allowFailure: true },
  )
  if (raw === '') return undefined
  const parsed = JSON.parse(raw)
  return parsed[0]
}

/**
 * Wait until the CI run covering `ref` finishes.
 *
 * @param {string} ref
 * @returns {Promise<void>}
 */
async function waitForCi(ref) {
  const deadline = Date.now() + CI_TIMEOUT_MS
  while (Date.now() < deadline) {
    const run = runForRef(ref, 'ci.yml')
    if (run !== undefined && run.status === 'completed') {
      if (run.conclusion !== 'success') die(ref + ' 的 CI 结论是 ' + run.conclusion + '：' + run.url)
      say('  ' + ref + ' CI 通过  ' + run.url)
      return
    }
    await sleep(CI_POLL_MS)
  }
  die(ref + ' 的 CI 在 15 分钟内没有结束')
}

/**
 * Wait for the publish workflow dispatched for `sha`.
 *
 * The run does not exist the instant `gh workflow run` returns, so this polls
 * until a run for that commit appears and then until it finishes.
 *
 * @param {string} sha
 * @returns {Promise<void>}
 */
async function waitForPublishRun(sha) {
  const deadline = Date.now() + CI_TIMEOUT_MS
  while (Date.now() < deadline) {
    const raw = capture(
      'gh',
      ['run', 'list', '--repo', REPO, '--workflow', 'publish.yml', '--commit', sha, '--limit', '1', '--json', 'status,conclusion,url'],
      { allowFailure: true },
    )
    if (raw !== '') {
      const [entry] = JSON.parse(raw)
      if (entry !== undefined && entry.status === 'completed') {
        if (entry.conclusion !== 'success') die('publish.yml 失败（' + entry.conclusion + '）：' + entry.url)
        say('  publish.yml 成功  ' + entry.url)
        return
      }
    }
    await sleep(CI_POLL_MS)
  }
  die('publish.yml 在 15 分钟内没有结束')
}

/**
 * Whether the registry already carries this version.
 *
 * The version endpoint answers as soon as the publish is recorded; dist-tags lag
 * behind, so `npm view <pkg> version` would report the previous release and make
 * a finished publish look unfinished.
 *
 * @param {string} version
 * @returns {Promise<boolean>}
 */
async function publishedOnNpm(version) {
  try {
    const response = await fetch('https://registry.npmjs.org/' + PKG + '/' + version, {
      method: 'HEAD',
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    })
    return response.ok
  } catch (error) {
    void error
    return false
  }
}

/** @param {string} tag @returns {boolean} */
const tagExists = (tag) => capture('git', ['tag', '--list', tag], { allowFailure: true }) !== ''

/** @param {string} tag @returns {boolean} */
const releaseExists = (tag) => capture('gh', ['release', 'view', tag, '--repo', REPO], { allowFailure: true }) !== ''

/** @param {string} file @returns {string} */
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

/**
 * Compare two plain x.y.z versions.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} negative when a < b
 */
function compareVersions(a, b) {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i]
  }
  return 0
}

// ---------------------------------------------------------------- main

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    usage()
    return
  }

  const version = options.version ?? ''
  if (!/^\d+\.\d+\.\d+$/.test(version)) die('需要一个形如 0.6.7 的版本号')
  if (options.summary === undefined || options.summary.trim() === '') die('--summary 必填')
  const current = JSON.parse(read('package.json')).version
  const drift = compareVersions(version, current)
  if (drift < 0) die('不能回退版本：package.json 已是 ' + current)
  if (drift === 0) say('版本号已是 ' + version + '，按续做处理')

  if (options.notes !== undefined && !existsSync(join(ROOT, options.notes))) {
    die('--notes 指定的文件不存在: ' + options.notes)
  }

  const stopIndex = TAGGED_PHASES.indexOf(options.stopAfter)
  if (stopIndex === -1) die('--stop-after 只能是 ' + TAGGED_PHASES.join(' | '))
  const should = (phase) => TAGGED_PHASES.indexOf(phase) <= stopIndex

  const tag = 'v' + version
  const summary = options.summary.trim()
  const dry = options.dryRun === true

  say('dsh-chat-embed ' + current + ' -> ' + version + (dry ? '   [dry-run]' : ''))
  say('阶段上限: ' + options.stopAfter)

  const dirty = capture('git', ['status', '--porcelain'])
  if (dirty !== '') {
    say('\n这次提交会包含：')
    for (const line of dirty.split('\n')) say('  ' + line)
  }

  if (should('bump')) {
    step('1/6 bump  版本号与文档')
    if (dry) say('  [dry-run] 跳过改文件')
    else bump(version, summary)
  }

  if (should('gate')) {
    step('2/6 gate  npm run check')
    if (dry) say('  [dry-run] 跳过')
    else run('npm', ['run', 'check'])
  }

  if (should('commit')) {
    step('3/6 commit  提交')
    if (dry) {
      say('  [dry-run] 跳过')
    } else {
      run('git', ['add', '-A'])
      if (capture('git', ['status', '--porcelain']) === '') {
        // 续做：上一轮已经提交过，工作树干净。
        say('  工作树干净，没有需要提交的改动')
      } else {
        const messageFile = join(ROOT, '.git', 'RELEASE_MESSAGE_TMP')
        writeFileSync(messageFile, commitMessage(version, summary))
        run('git', ['commit', '-q', '-F', messageFile])
        rmSync(messageFile, { force: true })
        say('  提交 ' + capture('git', ['rev-parse', '--short', 'HEAD']))
      }
    }
  }

  if (should('push')) {
    step('4/6 push  推送 master')
    if (dry) say('  [dry-run] 跳过')
    else run('git', ['push', 'origin', 'master'])
  }

  if (should('ci')) {
    step('5/6 ci  等这次推送的 CI')
    if (dry) say('  [dry-run] 跳过')
    else await waitForCi('master')
  }

  if (should('publish')) {
    step('6/6 publish -> tag -> release')
    if (await publishedOnNpm(version)) {
      say('  npm 上已有 ' + version + '，跳过发布')
    } else if (dry) {
      say('  [dry-run] 将触发 publish.yml（OIDC）并等它成功')
    } else {
      // 发布走 publish.yml：凭证由 OIDC 现签，仓库和本机都不保存令牌。
      const sha = capture('git', ['rev-parse', 'HEAD'])
      run('gh', ['workflow', 'run', 'publish.yml', '--repo', REPO, '--ref', 'master', '-f', 'version=' + version])
      await waitForPublishRun(sha)
      say('  已发布；registry 异步处理，通常 2~4 分钟后才可下载')
    }
  }

  if (should('tag')) {
    let pushedTag = false
    if (tagExists(tag)) {
      const at = capture('git', ['rev-parse', '--short', tag], { allowFailure: true })
      const head = capture('git', ['rev-parse', '--short', 'HEAD'])
      say('  tag ' + tag + ' 已存在（指向 ' + at + '）' + (at === head ? '' : '，与当前 HEAD ' + head + ' 不同，跳过'))
    } else if (dry) {
      say('  [dry-run] 将创建并推送 ' + tag)
    } else {
      run('git', ['tag', tag])
      run('git', ['push', 'origin', 'refs/tags/' + tag])
      pushedTag = true
    }
    if (pushedTag && should('ci')) await waitForCi(tag)
  }

  if (should('release')) {
    if (releaseExists(tag)) {
      say('  release ' + tag + ' 已存在，跳过')
    } else if (dry) {
      say('  [dry-run] 将执行 npm run pack:dist 与 gh release create ' + tag)
    } else {
      run('npm', ['run', 'pack:dist'])
      const tarball = join('dist', PKG + '-' + version + '.tgz')
      if (!existsSync(join(ROOT, tarball))) die('打包后找不到 ' + tarball)
      const args = ['release', 'create', tag, tarball, '--repo', REPO, '--title', tag]
      if (options.notes === undefined) args.push('--notes', summary)
      else args.push('--notes-file', options.notes)
      run('gh', args)
    }
  }

  if (dry) {
    say('\n[dry-run] 没有改动任何东西；去掉 --dry-run 即可执行。')
    return
  }

  step('验证')
  say('  提交        ' + capture('git', ['rev-parse', '--short', 'HEAD']) + '（历史共 ' + capture('git', ['rev-list', '--count', 'HEAD']) + ' 个提交）')
  const visible = await publishedOnNpm(version)
  say('  npm 可见    ' + (visible ? '是' : '尚未——npm 异步处理，实测需 2~4 分钟，用 npm view ' + PKG + '@' + version + ' 确认'))
  const tarball = join(ROOT, 'dist', PKG + '-' + version + '.tgz')
  if (existsSync(tarball)) {
    say('  tarball     dist/' + PKG + '-' + version + '.tgz  sha256 ' + sha256(tarball))
  }
  if (releaseExists(tag)) {
    say('  release     https://github.com/' + REPO + '/releases/tag/' + tag)
  } else {
    say('  release     未创建（阶段上限为 ' + options.stopAfter + '）')
  }
  say('\n完成（阶段上限 ' + options.stopAfter + '）。')
}

await main()
