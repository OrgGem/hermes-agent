import { parentPort } from 'node:worker_threads'

import { countTokens, type OpenAiEncoding } from './tokenizer'

interface TokenizeRequest {
  encoding: OpenAiEncoding
  id: number
  text: string
}

interface TokenizeResponse {
  count?: number
  error?: string
  id: number
}

if (!parentPort) {
  throw new Error('Service X tokenizer worker requires a parent port.')
}

parentPort.on('message', (request: TokenizeRequest) => {
  let response: TokenizeResponse

  try {
    response = { count: countTokens(request.text, request.encoding), id: request.id }
  } catch (error) {
    response = {
      error: error instanceof Error ? error.message : String(error),
      id: request.id
    }
  }

  parentPort?.postMessage(response)
})
