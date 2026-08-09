import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, test } from 'vitest'

import { ServiceXTokenMeter } from './chat-token-estimator'
import { TokenCountCache } from './token-count-cache'
import { countTokens } from './tokenizer'
import type { OpenAiEncoding } from './tokenizer-contract'

const tempDirs: string[] = []

class FakeTokenizerWorker {
  count(text: string, encoding: OpenAiEncoding): Promise<number> {
    return Promise.resolve(countTokens(text, encoding))
  }

  async close(): Promise<void> {}
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

test('token meter caches stable message and tool segments without mutating body', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-service-x-token-meter-'))
  tempDirs.push(dir)

  const cache = new TokenCountCache({ filePath: path.join(dir, 'cache.json'), hmacKey: 'key' })

  const meter = new ServiceXTokenMeter({
    cache,
    worker: new FakeTokenizerWorker()
  })

  const body = {
    messages: [
      { content: 'stable system instruction', role: 'system' },
      { content: [{ text: 'hello', type: 'text' }], role: 'user' },
      { content: 'hello', role: 'assistant' }
    ],
    tools: [{ function: { name: 'search' }, type: 'function' }]
  }

  const before = JSON.stringify(body)

  const first = await meter.observe(body, 'gpt-4o-mini')
  const second = await meter.observe(body, 'gpt-4o-mini')

  assert.equal(first.exact, true)
  assert.equal(first.cacheMisses, 3)
  assert.equal(second.cacheHits, 3)
  assert.equal(first.estimatedTextTokens, second.estimatedTextTokens)
  assert.equal(JSON.stringify(body), before)

  await meter.close()
})

test('token meter skips unknown model families instead of mislabeling counts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-service-x-token-meter-'))
  tempDirs.push(dir)

  const meter = new ServiceXTokenMeter({
    cache: new TokenCountCache({ filePath: path.join(dir, 'cache.json'), hmacKey: 'key' }),
    worker: new FakeTokenizerWorker()
  })

  const result = await meter.observe({ messages: [{ content: 'hello' }] }, 'provider/custom-model')

  assert.equal(result.skipped, true)
  assert.equal(result.estimatedTextTokens, 0)
  await meter.close()
})
