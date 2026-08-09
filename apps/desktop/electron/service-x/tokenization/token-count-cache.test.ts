import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, test } from 'vitest'

import { TokenCountCache } from './token-count-cache'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

function makeCache(now = 1_000_000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-service-x-token-cache-'))
  tempDirs.push(dir)

  return {
    cache: new TokenCountCache({
      filePath: path.join(dir, 'cache.json'),
      hmacKey: 'profile-capability-key',
      now: () => now,
      ttlMs: 100
    }),
    filePath: path.join(dir, 'cache.json')
  }
}

test('token count cache persists counts without persisting source text', () => {
  const { cache, filePath } = makeCache()
  const text = 'private prompt content'

  assert.equal(cache.get(text, 'o200k_base'), null)
  assert.equal(cache.set(text, 'o200k_base', 4).tokens, 4)
  cache.flush()

  const persisted = fs.readFileSync(filePath, 'utf8')

  assert.equal(persisted.includes(text), false)
  assert.equal(
    new TokenCountCache({ filePath, hmacKey: 'profile-capability-key', now: () => 1_000_000 }).get(text, 'o200k_base')
      ?.tokens,
    4
  )
})

test('token count cache separates profile keys and expires entries', () => {
  const { cache } = makeCache()
  cache.set('same text', 'cl100k_base', 3)
  cache.flush()

  assert.equal(cache.get('same text', 'cl100k_base')?.tokens, 3)
  assert.equal(
    new TokenCountCache({
      filePath: path.join(tempDirs[0], 'other.json'),
      hmacKey: 'different-profile-key',
      now: () => 1_000_000
    }).get('same text', 'cl100k_base'),
    null
  )

  const expired = new TokenCountCache({
    filePath: path.join(tempDirs[0], 'expired.json'),
    hmacKey: 'expired-key',
    now: () => 1_000_000,
    ttlMs: 100
  })

  expired.set('old', 'o200k_base', 1)
  expired.flush()

  const later = new TokenCountCache({
    filePath: path.join(tempDirs[0], 'expired.json'),
    hmacKey: 'expired-key',
    now: () => 1_001_000,
    ttlMs: 100
  })

  assert.equal(later.get('old', 'o200k_base'), null)
})
