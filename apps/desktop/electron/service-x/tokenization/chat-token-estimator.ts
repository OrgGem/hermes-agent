import { resolveOpenAiEncoding } from './encoding-resolver'
import type { TokenCountCache } from './token-count-cache'
import type { OpenAiEncoding } from './tokenizer-contract'
import { TokenizerWorkerClient } from './tokenizer-worker-client'

const MAX_ANALYZED_BYTES = 4 * 1024 * 1024

interface TokenSegment {
  occurrences: number
  text: string
}

export interface TokenEstimate {
  cacheHits: number
  cacheMisses: number
  estimatedTextTokens: number
  exact: boolean
  model: string
  skipped: boolean
}

export interface TokenMeterOptions {
  cache: TokenCountCache
  worker?: TokenCounterWorker
}

export interface TokenCounterWorker {
  close(): Promise<void>
  count(text: string, encoding: OpenAiEncoding): Promise<number>
}

/**
 * Counts reusable textual portions of a Chat Completions request. It is an
 * estimate of the provider's input usage, not a replacement for upstream
 * `usage.prompt_tokens` because chat framing, tools and multimodal parts are
 * model/provider-specific.
 */
export class ServiceXTokenMeter {
  private readonly inFlight = new Map<string, Promise<number>>()
  private readonly worker: TokenCounterWorker

  constructor(private readonly options: TokenMeterOptions) {
    this.worker = options.worker ?? new TokenizerWorkerClient()
  }

  async observe(body: Record<string, any>, model: string): Promise<TokenEstimate> {
    const resolution = resolveOpenAiEncoding(model)

    const base: TokenEstimate = {
      cacheHits: 0,
      cacheMisses: 0,
      estimatedTextTokens: 0,
      exact: Boolean(resolution.encoding),
      model,
      skipped: false
    }

    if (!resolution.encoding) {
      return { ...base, skipped: true }
    }

    const segments = extractTokenSegments(body)
    let analyzedBytes = 0
    const unique = new Map<string, TokenSegment>()

    for (const segment of segments) {
      const bytes = Buffer.byteLength(segment.text, 'utf8')

      if (!segment.text || analyzedBytes + bytes > MAX_ANALYZED_BYTES) {
        base.skipped = true

        continue
      }

      analyzedBytes += bytes
      const key = `${resolution.encoding}\0${segment.text}`
      const existing = unique.get(key)

      if (existing) {
        existing.occurrences += 1
      } else {
        unique.set(key, { ...segment, occurrences: 1 })
      }
    }

    const counts = await Promise.all(
      [...unique.values()].map(async segment => {
        const cached = this.options.cache.get(segment.text, resolution.encoding as OpenAiEncoding)

        if (cached) {
          base.cacheHits += 1

          return cached.tokens * segment.occurrences
        }

        base.cacheMisses += 1
        const count = await this.count(segment.text, resolution.encoding as OpenAiEncoding)
        this.options.cache.set(segment.text, resolution.encoding as OpenAiEncoding, count)

        return count * segment.occurrences
      })
    )

    base.estimatedTextTokens = counts.reduce((total, count) => total + count, 0)

    return base
  }

  async close(): Promise<void> {
    await this.worker.close()
    this.options.cache.close()
  }

  private count(text: string, encoding: OpenAiEncoding): Promise<number> {
    const key = `${encoding}\0${text}`
    const existing = this.inFlight.get(key)

    if (existing) {
      return existing
    }

    const pending = this.worker.count(text, encoding).finally(() => {
      if (this.inFlight.get(key) === pending) {
        this.inFlight.delete(key)
      }
    })

    this.inFlight.set(key, pending)

    return pending
  }
}

function extractTokenSegments(body: Record<string, any>): TokenSegment[] {
  const segments: TokenSegment[] = []
  const messages = Array.isArray(body.messages) ? body.messages : []

  for (const message of messages) {
    if (typeof message?.content === 'string') {
      segments.push({ occurrences: 1, text: message.content })
    } else if (Array.isArray(message?.content)) {
      for (const part of message.content) {
        if (typeof part?.text === 'string') {
          segments.push({ occurrences: 1, text: part.text })
        }
      }
    }
  }

  // Tool definitions are stable across many turns and worth caching as one
  // deterministic segment. Their provider-specific framing is not included.
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    segments.push({ occurrences: 1, text: JSON.stringify(body.tools) })
  }

  return segments
}

export { extractTokenSegments, MAX_ANALYZED_BYTES }
