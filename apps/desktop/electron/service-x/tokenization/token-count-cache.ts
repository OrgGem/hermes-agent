import crypto from 'node:crypto'
import fs from 'node:fs'

import { atomicWrite } from '../config'

import { type OpenAiEncoding, TOKENIZER_REVISION } from './tokenizer-contract'

const CACHE_VERSION = 1
const DEFAULT_MAX_ENTRIES = 10_000
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000
const FLUSH_DELAY_MS = 750

interface PersistedEntry {
  bytes: number
  encoding: OpenAiEncoding
  key: string
  lastAccess: number
  tokens: number
}

interface PersistedCache {
  entries: PersistedEntry[]
  tokenizerRevision: string
  version: number
}

export interface TokenCountCacheOptions {
  filePath: string
  hmacKey: string
  maxEntries?: number
  maxFileBytes?: number
  now?: () => number
  ttlMs?: number
}

export interface TokenCountCacheLookup {
  bytes: number
  key: string
  tokens: number
}

export class TokenCountCache {
  private readonly entries = new Map<string, PersistedEntry>()
  private dirty = false
  private flushTimer: NodeJS.Timeout | undefined
  private readonly maxEntries: number
  private readonly maxFileBytes: number
  private readonly now: () => number
  private readonly ttlMs: number

  constructor(private readonly options: TokenCountCacheOptions) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.load()
  }

  get(text: string, encoding: OpenAiEncoding): TokenCountCacheLookup | null {
    const key = this.cacheKey(text, encoding)
    const entry = this.entries.get(key)

    if (!entry) {
      return null
    }

    if (this.isExpired(entry)) {
      this.entries.delete(key)
      this.markDirty()

      return null
    }

    entry.lastAccess = this.now()
    this.markDirty()

    return { bytes: entry.bytes, key, tokens: entry.tokens }
  }

  set(text: string, encoding: OpenAiEncoding, tokens: number): TokenCountCacheLookup {
    const bytes = Buffer.byteLength(text, 'utf8')
    const key = this.cacheKey(text, encoding)

    this.entries.set(key, {
      bytes,
      encoding,
      key,
      lastAccess: this.now(),
      tokens
    })
    this.prune()
    this.markDirty()

    return { bytes, key, tokens }
  }

  size(): number {
    return this.entries.size
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }

    if (!this.dirty) {
      return
    }

    this.prune()
    atomicWrite(this.options.filePath, `${JSON.stringify(this.snapshot(), null, 2)}\n`, 0o600)
    this.dirty = false
  }

  close(): void {
    try {
      this.flush()
    } catch {
      // Cache persistence is never authoritative for proxy lifecycle.
    }
  }

  private cacheKey(text: string, encoding: OpenAiEncoding): string {
    const hmac = crypto.createHmac('sha256', this.options.hmacKey)

    hmac.update(`${CACHE_VERSION}\0${TOKENIZER_REVISION}\0${encoding}\0`, 'utf8')
    hmac.update(text, 'utf8')

    return hmac.digest('hex')
  }

  private isExpired(entry: PersistedEntry): boolean {
    return this.now() - entry.lastAccess > this.ttlMs
  }

  private load(): void {
    let parsed: PersistedCache

    try {
      parsed = JSON.parse(fs.readFileSync(this.options.filePath, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        // Corrupt or partially-written cache state is non-authoritative. The
        // proxy must remain usable and can rebuild counts on demand.
        this.dirty = true
      }

      return
    }

    if (
      parsed?.version !== CACHE_VERSION ||
      parsed?.tokenizerRevision !== TOKENIZER_REVISION ||
      !Array.isArray(parsed?.entries)
    ) {
      this.dirty = true

      return
    }

    for (const entry of parsed.entries) {
      if (
        entry &&
        typeof entry.key === 'string' &&
        (entry.encoding === 'o200k_base' || entry.encoding === 'cl100k_base') &&
        Number.isSafeInteger(entry.tokens) &&
        entry.tokens >= 0 &&
        Number.isSafeInteger(entry.bytes) &&
        entry.bytes >= 0 &&
        Number.isFinite(entry.lastAccess) &&
        !this.isExpired(entry)
      ) {
        this.entries.set(entry.key, entry)
      }
    }

    this.prune()
  }

  private markDirty(): void {
    this.dirty = true

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined

        try {
          this.flush()
        } catch {
          // Cache persistence is best-effort. A later write or shutdown flush
          // can retry; LLM proxying must not fail because metrics could not be saved.
        }
      }, FLUSH_DELAY_MS)
      this.flushTimer.unref()
    }
  }

  private prune(): void {
    for (const [key, entry] of this.entries) {
      if (this.isExpired(entry)) {
        this.entries.delete(key)
        this.dirty = true
      }
    }

    if (this.entries.size > this.maxEntries) {
      const oldest = [...this.entries.values()].sort((left, right) => left.lastAccess - right.lastAccess)

      for (const entry of oldest.slice(0, this.entries.size - this.maxEntries)) {
        this.entries.delete(entry.key)
        this.dirty = true
      }
    }

    let serialized = JSON.stringify(this.snapshot())

    if (Buffer.byteLength(serialized, 'utf8') <= this.maxFileBytes) {
      return
    }

    const oldest = [...this.entries.values()].sort((left, right) => left.lastAccess - right.lastAccess)

    for (const entry of oldest) {
      this.entries.delete(entry.key)
      this.dirty = true
      serialized = JSON.stringify(this.snapshot())

      if (Buffer.byteLength(serialized, 'utf8') <= this.maxFileBytes) {
        break
      }
    }
  }

  private snapshot(): PersistedCache {
    return {
      entries: [...this.entries.values()],
      tokenizerRevision: TOKENIZER_REVISION,
      version: CACHE_VERSION
    }
  }
}

export { CACHE_VERSION, DEFAULT_MAX_ENTRIES, DEFAULT_MAX_FILE_BYTES, DEFAULT_TTL_MS }
