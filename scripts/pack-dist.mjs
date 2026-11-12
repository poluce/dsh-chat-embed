#!/usr/bin/env node
/**
 * pack-dist.mjs — produce the distributable tarball under `dist/`.
 *
 * Used for the "no npm account" route: upload the tarball to a GitHub Release
 * (or hand it over) and let users install it with
 * `dsh plugin --profile desktop add <file>.tgz`.
 */

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
mkdirSync(dist, { recursive: true })

const result = spawnSync('npm', ['pack', '--pack-destination', dist], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
process.exit(result.status === null ? 1 : result.status)
