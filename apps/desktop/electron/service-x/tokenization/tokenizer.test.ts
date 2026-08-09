import assert from 'node:assert/strict'

import { test } from 'vitest'

import { resolveOpenAiEncoding } from './encoding-resolver'
import { countTokens, tokenizeOrdinary } from './tokenizer'

test('OpenAI tokenizer counts ordinary text in both supported vocabularies', () => {
  assert.equal(countTokens('hello world', 'o200k_base'), 2)
  assert.equal(countTokens('hello world', 'cl100k_base'), 2)
  assert.equal(countTokens('Xin chào Việt Nam', 'cl100k_base'), 9)
})

test('ordinary encoding does not interpret special-token spellings', () => {
  const ids = tokenizeOrdinary('<|endoftext|>', 'cl100k_base')

  assert.equal(ids.length, 7)
  assert.notEqual(ids[0], 100257)
})

test('model resolver is conservative for OpenAI-compatible providers', () => {
  assert.deepEqual(resolveOpenAiEncoding('gpt-4o-mini'), {
    encoding: 'o200k_base',
    exact: true,
    reason: 'known o200k_base model family'
  })
  assert.equal(resolveOpenAiEncoding('openai/gpt-4-turbo').encoding, 'cl100k_base')
  assert.equal(resolveOpenAiEncoding('anthropic/claude-sonnet').encoding, undefined)
})
