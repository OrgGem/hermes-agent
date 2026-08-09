import crypto from 'node:crypto'
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import https from 'node:https'
import type { Socket } from 'node:net'

import type { ServiceXConfig, ServiceXLogger } from './contract'
import { ServiceXAuthRequiredError, type ServiceXTokenManager } from './token-manager'
import type { ServiceXTokenMeter } from './tokenization/chat-token-estimator'

const BODY_LIMIT_BYTES = 16 * 1024 * 1024
const MAX_CONCURRENT_REQUESTS = 4
const MAX_QUEUED_REQUESTS = 32
const MODEL_CATALOG_CACHE_MS = 60_000
const MODEL_CATALOG_LIMIT_BYTES = 4 * 1024 * 1024
const UPSTREAM_HEADER_TIMEOUT_MS = 120_000

const BLOCKED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])

class ServiceXBusyError extends Error {}

class ServiceXInvalidRequestError extends Error {}

class BoundedGate {
  private active = 0
  private readonly queue: Array<(release: () => void) => void> = []

  constructor(
    private readonly concurrency: number,
    private readonly maxQueue: number
  ) {}

  acquire(): Promise<() => void> {
    if (this.active < this.concurrency) {
      this.active += 1

      return Promise.resolve(this.releaseOnce())
    }

    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(new ServiceXBusyError('Service X request queue is full.'))
    }

    return new Promise(resolve => this.queue.push(resolve))
  }

  private releaseOnce(): () => void {
    let released = false

    return () => {
      if (released) {
        return
      }

      released = true
      const next = this.queue.shift()

      if (next) {
        next(this.releaseOnce())
      } else {
        this.active -= 1
      }
    }
  }
}

function bearerToken(headers: IncomingHttpHeaders): string {
  const authorization = Array.isArray(headers.authorization) ? headers.authorization[0] : headers.authorization
  const match = /^Bearer\s+(.+)$/i.exec(String(authorization ?? ''))

  return match?.[1]?.trim() ?? ''
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)

  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b)
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  if (response.headersSent || response.destroyed) {
    return
  }

  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff'
  })
  response.end(JSON.stringify(body))
}

function sendError(response: ServerResponse, status: number, message: string, code: string) {
  sendJson(response, status, { error: { code, message, type: 'service_x_error' } })
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)

    size += buffer.length

    if (size > BODY_LIMIT_BYTES) {
      throw new Error(`Request body exceeds the ${BODY_LIMIT_BYTES} byte limit.`)
    }

    chunks.push(buffer)
  }

  return Buffer.concat(chunks)
}

function parseJsonObject(raw: Buffer): Record<string, any> {
  let parsed: any

  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new Error('Request body must be valid JSON.')
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Request body must be a JSON object.')
  }

  return parsed
}

function chatBody(parsed: Record<string, any>, model: string): Buffer {
  return Buffer.from(JSON.stringify({ ...parsed, model }))
}

function parseModelIds(raw: Buffer): string[] {
  let payload: any

  try {
    payload = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new Error('Upstream LLM /models returned invalid JSON.')
  }

  const data = Array.isArray(payload) ? payload : payload?.data

  if (!Array.isArray(data)) {
    throw new Error('Upstream LLM /models response did not contain a data list.')
  }

  const seen = new Set<string>()
  const models: string[] = []

  for (const item of data) {
    const id = typeof item === 'string' ? item.trim() : String(item?.id ?? '').trim()

    if (id && !seen.has(id)) {
      seen.add(id)
      models.push(id)
    }
  }

  if (!models.length) {
    throw new Error('Upstream LLM provider returned an empty model list.')
  }

  return models
}

function responseHeaders(headers: IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const result: http.OutgoingHttpHeaders = {}

  for (const [name, value] of Object.entries(headers)) {
    if (!BLOCKED_RESPONSE_HEADERS.has(name.toLowerCase()) && value !== undefined) {
      result[name] = value
    }
  }

  return result
}

interface UpstreamAttempt {
  request: http.ClientRequest
  response: IncomingMessage
}

function openUpstream(
  url: string,
  body: Buffer,
  accessToken: string,
  clientRequest: IncomingMessage
): Promise<UpstreamAttempt> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const transport = parsed.protocol === 'https:' ? https : http

    const upstreamRequest = transport.request(
      parsed,
      {
        headers: {
          accept: String(clientRequest.headers.accept ?? 'application/json'),
          authorization: `Bearer ${accessToken}`,
          'content-length': String(body.length),
          'content-type': 'application/json',
          'user-agent': 'Hermes-Desktop-Service-X/1'
        },
        method: 'POST'
      },
      upstreamResponse => {
        // The timeout guards time-to-headers only. A valid streaming response
        // may be quiet for longer, so do not turn a slow token stream into a
        // transport failure after headers have arrived.
        upstreamRequest.setTimeout(0)
        resolve({ request: upstreamRequest, response: upstreamResponse })
      }
    )

    upstreamRequest.once('error', reject)
    upstreamRequest.setTimeout(UPSTREAM_HEADER_TIMEOUT_MS, () => {
      upstreamRequest.destroy(new Error('Upstream LLM request timed out before response headers.'))
    })
    clientRequest.once('aborted', () => upstreamRequest.destroy())
    upstreamRequest.end(body)
  })
}

function openModelCatalog(url: string, accessToken: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const transport = parsed.protocol === 'https:' ? https : http

    const request = transport.request(
      parsed,
      {
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${accessToken}`,
          'user-agent': 'Hermes-Desktop-Service-X/1'
        },
        method: 'GET'
      },
      response => {
        request.setTimeout(0)
        resolve(response)
      }
    )

    request.once('error', reject)
    request.setTimeout(20_000, () => {
      request.destroy(new Error('Upstream LLM model discovery timed out.'))
    })
    request.end()
  })
}

async function readResponseBody(response: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length

    if (size > MODEL_CATALOG_LIMIT_BYTES) {
      response.destroy()
      throw new Error('Upstream LLM model list exceeds the response size limit.')
    }

    chunks.push(buffer)
  }

  return Buffer.concat(chunks)
}

function pipeUpstream(upstream: IncomingMessage, response: ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    response.writeHead(upstream.statusCode ?? 502, responseHeaders(upstream.headers))
    upstream.once('error', reject)
    upstream.once('end', resolve)
    response.once('close', resolve)
    upstream.pipe(response)
  })
}

export interface ServiceXLlmProxyOptions {
  capabilityKey: string
  config: ServiceXConfig
  logger?: ServiceXLogger
  tokenMeter?: Pick<ServiceXTokenMeter, 'close' | 'observe'>
  tokenManager: ServiceXTokenManager
}

export class ServiceXLlmProxy {
  private readonly gate = new BoundedGate(MAX_CONCURRENT_REQUESTS, MAX_QUEUED_REQUESTS)
  private readonly logger: ServiceXLogger
  private readonly server: http.Server
  private readonly sockets = new Set<Socket>()
  private modelCatalogExpiresAt = 0
  private modelCatalogGeneration = 0
  private modelCatalogPromise: Promise<string[]> | null = null
  private cachedModels: string[] = []
  private started = false

  constructor(private readonly options: ServiceXLlmProxyOptions) {
    this.logger = options.logger ?? (() => undefined)
    this.server = http.createServer((request, response) => void this.handle(request, response))
    this.server.on('connection', socket => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    })
  }

  async start(): Promise<void> {
    if (this.started) {
      return
    }

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off('listening', onListening)
        reject(error)
      }

      const onListening = () => {
        this.server.off('error', onError)
        resolve()
      }

      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.server.listen(this.options.config.port, '127.0.0.1')
    })
    this.started = true
    this.logger(`[service-x] LLM proxy listening on http://127.0.0.1:${this.options.config.port}/v1`)
  }

  async stop(): Promise<void> {
    if (!this.started) {
      await this.options.tokenMeter?.close()

      return
    }

    this.started = false

    for (const socket of this.sockets) {
      socket.destroy()
    }

    await new Promise<void>(resolve => this.server.close(() => resolve()))
    await this.options.tokenMeter?.close()
  }

  async models(force = false): Promise<string[]> {
    const accessToken = await this.options.tokenManager.accessToken()

    if (!force && this.cachedModels.length > 0 && Date.now() < this.modelCatalogExpiresAt) {
      return [...this.cachedModels]
    }

    if (this.modelCatalogPromise) {
      return [...(await this.modelCatalogPromise)]
    }

    const generation = this.modelCatalogGeneration

    const promise = this.fetchModels(accessToken)
      .then(models => {
        if (generation === this.modelCatalogGeneration) {
          this.cachedModels = models
          this.modelCatalogExpiresAt = Date.now() + MODEL_CATALOG_CACHE_MS
        }

        return models
      })
      .finally(() => {
        if (this.modelCatalogPromise === promise) {
          this.modelCatalogPromise = null
        }
      })

    this.modelCatalogPromise = promise

    return [...(await promise)]
  }

  clearModelCache() {
    this.cachedModels = []
    this.modelCatalogExpiresAt = 0
    this.modelCatalogGeneration += 1
    this.modelCatalogPromise = null
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    if (request.headers.origin || request.headers['sec-fetch-site']) {
      sendError(response, 403, 'Browser-origin requests are not accepted.', 'browser_origin_rejected')

      return
    }

    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')

    if (request.method === 'GET' && requestUrl.pathname === '/healthz') {
      sendJson(response, 200, { ok: true, service: 'service-x' })

      return
    }

    if (!secureEqual(bearerToken(request.headers), this.options.capabilityKey)) {
      sendError(response, 401, 'Invalid Service X capability key.', 'invalid_api_key')

      return
    }

    if (request.method === 'GET' && requestUrl.pathname === '/v1/models') {
      try {
        const models = await this.models()
        sendJson(response, 200, {
          data: models.map(id => ({ created: 0, id, object: 'model', owned_by: 'service-x' })),
          object: 'list'
        })
      } catch (error) {
        this.handleError(response, error)
      }

      return
    }

    if (request.method !== 'POST' || requestUrl.pathname !== '/v1/chat/completions') {
      sendError(response, 404, 'Service X route not found.', 'not_found')

      return
    }

    let release: (() => void) | null = null

    try {
      // Acquire before reading the body so a burst cannot allocate an
      // unbounded number of 16 MiB buffers while waiting for a proxy slot.
      release = await this.gate.acquire()
      const rawBody = await readRequestBody(request)
      const parsedBody = parseJsonObject(rawBody)
      const requestedModel = parsedBody.model

      if (requestedModel !== undefined && typeof requestedModel !== 'string') {
        throw new ServiceXInvalidRequestError('Request model must be a string.')
      }

      const model = await this.resolveModel(String(requestedModel ?? '').trim())
      const body = chatBody(parsedBody, model)

      // Token metering is deliberately observational: it never mutates or
      // delays the request sent upstream, and failures cannot break LLM proxying.
      void this.options.tokenMeter?.observe(parsedBody, model).catch(error => {
        this.logger(`[service-x] token metering skipped: ${error instanceof Error ? error.message : String(error)}`)
      })

      await this.forwardChat(request, response, body)
    } catch (error) {
      this.handleError(response, error)
    } finally {
      release?.()
    }
  }

  private async forwardChat(clientRequest: IncomingMessage, response: ServerResponse, body: Buffer) {
    const url = `${this.options.config.upstreamBaseUrl}/chat/completions`
    let accessToken = await this.options.tokenManager.accessToken()

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const upstream = await openUpstream(url, body, accessToken, clientRequest)

      if (upstream.response.statusCode === 401 && attempt === 0) {
        // No downstream bytes were written, so this request is still safe to
        // retry. Destroy rather than drain a hostile/buggy endless 401 body.
        upstream.response.destroy()
        accessToken = await this.options.tokenManager.accessToken(true)

        continue
      }

      await pipeUpstream(upstream.response, response)

      return
    }
  }

  private async fetchModels(initialAccessToken: string): Promise<string[]> {
    let accessToken = initialAccessToken
    const url = `${this.options.config.upstreamBaseUrl}/models`

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const upstream = await openModelCatalog(url, accessToken)

      if (upstream.statusCode === 401 && attempt === 0) {
        upstream.destroy()
        accessToken = await this.options.tokenManager.accessToken(true)

        continue
      }

      const raw = await readResponseBody(upstream)

      if ((upstream.statusCode ?? 502) < 200 || (upstream.statusCode ?? 502) >= 300) {
        throw new Error(`Upstream LLM model discovery failed (HTTP ${upstream.statusCode ?? 502}).`)
      }

      return parseModelIds(raw)
    }

    throw new Error('Upstream LLM model discovery failed after refreshing the access token.')
  }

  private async resolveModel(requestedModel: string): Promise<string> {
    let models = await this.models()

    if (requestedModel && !models.includes(requestedModel)) {
      models = await this.models(true)
    }

    if (requestedModel) {
      if (!models.includes(requestedModel)) {
        throw new ServiceXInvalidRequestError(`Model "${requestedModel}" is not advertised by the upstream provider.`)
      }

      return requestedModel
    }

    const legacyModel = this.options.config.model?.trim()

    return (legacyModel && models.includes(legacyModel) ? legacyModel : models[0]) as string
  }

  private handleError(response: ServerResponse, error: unknown) {
    if (response.headersSent || response.destroyed) {
      this.logger(
        `[service-x] upstream stream ended with error: ${error instanceof Error ? error.message : String(error)}`
      )
      response.destroy()

      return
    }

    if (error instanceof ServiceXAuthRequiredError) {
      sendError(response, 401, error.message, error.code)

      return
    }

    if (error instanceof ServiceXBusyError) {
      response.setHeader('retry-after', '1')
      sendError(response, 429, error.message, 'queue_full')

      return
    }

    if (error instanceof ServiceXInvalidRequestError) {
      sendError(response, 400, error.message, 'invalid_request')

      return
    }

    const message = error instanceof Error ? error.message : 'Service X proxy request failed.'
    const isClientError = /body|JSON object|valid JSON/i.test(message)

    sendError(response, isClientError ? 400 : 502, message, isClientError ? 'invalid_request' : 'upstream_error')
  }
}

export { BODY_LIMIT_BYTES, BoundedGate, MAX_CONCURRENT_REQUESTS, MAX_QUEUED_REQUESTS, secureEqual }
