import { type OpenAiEncoding, TOKENIZER_REVISION } from './tokenizer-contract'
import { Tiktoken } from './vendor/js-tiktoken/lite.js'
import cl100kBase from './vendor/js-tiktoken/ranks/cl100k_base.js'
import o200kBase from './vendor/js-tiktoken/ranks/o200k_base.js'

export type { OpenAiEncoding } from './tokenizer-contract'

let o200kTokenizer: Tiktoken | undefined
let cl100kTokenizer: Tiktoken | undefined

export function tokenizerRevision(): string {
  return TOKENIZER_REVISION
}

export function tokenizeOrdinary(text: string, encoding: OpenAiEncoding): number[] {
  const tokenizer = getTokenizer(encoding)

  // ccc-main uses tiktoken-rs::encode_ordinary(), which treats special-token
  // spellings as ordinary text. Passing empty allow/disallow lists preserves
  // that behavior instead of interpreting <|endoftext|> as a control token.
  return tokenizer.encode(text, [], [])
}

export function countTokens(text: string, encoding: OpenAiEncoding): number {
  return tokenizeOrdinary(text, encoding).length
}

function getTokenizer(encoding: OpenAiEncoding): Tiktoken {
  if (encoding === 'o200k_base') {
    o200kTokenizer ??= new Tiktoken(o200kBase)

    return o200kTokenizer
  }

  cl100kTokenizer ??= new Tiktoken(cl100kBase)

  return cl100kTokenizer
}
