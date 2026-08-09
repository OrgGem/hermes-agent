import crypto from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

import type {
  OidcDiscoveryDocument,
  ServiceXConfig,
  ServiceXIdentity,
  ServiceXLogger,
  ServiceXTokenSet
} from './contract'
import { ServiceXOidcError } from './token-manager'

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const TOKEN_TIMEOUT_MS = 20_000

const DONE_HTML =
  '<!doctype html><meta charset="utf-8"><title>Signed in</title>' +
  '<body style="font:15px system-ui;margin:3rem;text-align:center">' +
  '<h2>&#10003; Signed in to X Auth</h2>' +
  '<p>You can close this window and return to Hermes Desktop.</p>' +
  '<script>setTimeout(()=>window.close(),800)</script>'

function base64Url(raw: Buffer): string {
  return raw.toString('base64url')
}

export function oidcAuthorizationExtras(config: ServiceXConfig): Record<string, string> {
  const scopes = new Set(config.scopes.split(/\s+/).filter(Boolean))
  const extras: Record<string, string> = {}

  // NocoBase's IdP follows the OIDC offline_access requirement strictly: it
  // removes offline_access unless the user is explicitly asked to consent.
  if (scopes.has('offline_access')) {
    extras.prompt = 'consent'
  }

  // The NocoBase API resource server expects this exact issuer-derived
  // audience when the api scope is requested. Other providers may ignore the
  // optional parameter, while this keeps API access tokens usable for Service
  // X's configured upstream.
  if (scopes.has('api')) {
    extras.resource = `${config.issuerUrl.replace(/\/$/, '')}/`
  }

  return extras
}

export function createOidcPkce(): { challenge: string; verifier: string } {
  const verifier = base64Url(crypto.randomBytes(32))
  const challenge = base64Url(crypto.createHash('sha256').update(verifier, 'ascii').digest())

  return { challenge, verifier }
}

function endpointUrl(raw: unknown, field: string): string {
  let parsed: URL

  try {
    parsed = new URL(String(raw ?? ''))
  } catch {
    throw new Error(`OIDC discovery returned an invalid ${field}.`)
  }

  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(parsed.hostname)

  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error(`OIDC ${field} must use HTTPS (or loopback HTTP for development).`)
  }

  if (parsed.username || parsed.password) {
    throw new Error(`OIDC ${field} must not contain embedded credentials.`)
  }

  return parsed.toString()
}

async function responseBody(response: Response): Promise<any> {
  const text = await response.text()

  if (!text) {
    return {}
  }

  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`OIDC endpoint returned invalid JSON (HTTP ${response.status}).`)
  }
}

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export async function discoverOidc(
  config: ServiceXConfig,
  fetchImpl: typeof fetch = fetch
): Promise<OidcDiscoveryDocument> {
  const discoveryUrl = `${config.issuerUrl}/.well-known/openid-configuration`

  const response = await fetchWithTimeout(
    fetchImpl,
    discoveryUrl,
    { headers: { accept: 'application/json' } },
    TOKEN_TIMEOUT_MS
  )

  const body = await responseBody(response)

  if (!response.ok) {
    throw new Error(`OIDC discovery failed (HTTP ${response.status}).`)
  }

  const discoveredIssuer = String(body?.issuer ?? '').replace(/\/$/, '')

  if (discoveredIssuer !== config.issuerUrl) {
    throw new Error(`OIDC issuer mismatch: expected ${config.issuerUrl}, received ${discoveredIssuer || '(missing)'}.`)
  }

  return {
    authorizationEndpoint: endpointUrl(body.authorization_endpoint, 'authorization_endpoint'),
    endSessionEndpoint: body.end_session_endpoint
      ? endpointUrl(body.end_session_endpoint, 'end_session_endpoint')
      : undefined,
    issuer: discoveredIssuer,
    revocationEndpoint: body.revocation_endpoint
      ? endpointUrl(body.revocation_endpoint, 'revocation_endpoint')
      : undefined,
    tokenEndpoint: endpointUrl(body.token_endpoint, 'token_endpoint'),
    userinfoEndpoint: body.userinfo_endpoint ? endpointUrl(body.userinfo_endpoint, 'userinfo_endpoint') : undefined
  }
}

function tokenSetFromBody(body: any, previous?: ServiceXTokenSet, now = Date.now()): ServiceXTokenSet {
  const accessToken = String(body?.access_token ?? '')

  if (!accessToken) {
    throw new Error('OIDC token response is missing access_token.')
  }

  const expiresIn = Number(body?.expires_in)

  return {
    accessToken,
    displayName: previous?.displayName,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Math.floor(now / 1000) + expiresIn : 0,
    refreshToken: String(body?.refresh_token ?? previous?.refreshToken ?? ''),
    scope: String(body?.scope ?? previous?.scope ?? ''),
    subject: previous?.subject,
    tokenType: String(body?.token_type ?? previous?.tokenType ?? 'Bearer')
  }
}

async function postTokenForm(
  fetchImpl: typeof fetch,
  endpoint: string,
  params: Record<string, string>,
  previous?: ServiceXTokenSet
): Promise<ServiceXTokenSet> {
  const response = await fetchWithTimeout(
    fetchImpl,
    endpoint,
    {
      body: new URLSearchParams(params),
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded'
      },
      method: 'POST'
    },
    TOKEN_TIMEOUT_MS
  )

  const body = await responseBody(response)

  if (!response.ok || body?.error) {
    const code = String(body?.error ?? '') || undefined
    const description = String(body?.error_description ?? '').trim()
    const message = description || code || `OIDC token request failed (HTTP ${response.status}).`

    throw new ServiceXOidcError(message, code, response.status)
  }

  return tokenSetFromBody(body, previous)
}

async function readIdentity(
  fetchImpl: typeof fetch,
  discovery: OidcDiscoveryDocument,
  accessToken: string
): Promise<ServiceXIdentity> {
  if (!discovery.userinfoEndpoint) {
    return {}
  }

  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      discovery.userinfoEndpoint,
      { headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` } },
      TOKEN_TIMEOUT_MS
    )

    const body = await responseBody(response)

    if (!response.ok) {
      return {}
    }

    return {
      displayName: String(body?.name ?? body?.preferred_username ?? body?.email ?? '').trim() || undefined,
      subject: String(body?.sub ?? '').trim() || undefined
    }
  } catch {
    return {}
  }
}

export interface ServiceXOidcClientDeps {
  createServer?: typeof http.createServer
  fetch?: typeof fetch
  logger?: ServiceXLogger
  openExternal: (url: string) => Promise<void>
  timeoutMs?: number
}

export class ServiceXOidcClient {
  private discoveryPromise: Promise<OidcDiscoveryDocument> | null = null
  private readonly fetchImpl: typeof fetch
  private readonly logger: ServiceXLogger

  constructor(
    private readonly config: ServiceXConfig,
    private readonly deps: ServiceXOidcClientDeps
  ) {
    this.fetchImpl = deps.fetch ?? fetch
    this.logger = deps.logger ?? (() => undefined)
  }

  discovery(): Promise<OidcDiscoveryDocument> {
    if (!this.discoveryPromise) {
      this.discoveryPromise = discoverOidc(this.config, this.fetchImpl).catch(error => {
        this.discoveryPromise = null
        throw error
      })
    }

    return this.discoveryPromise
  }

  async login(): Promise<ServiceXTokenSet> {
    const discovery = await this.discovery()
    const createServer = this.deps.createServer ?? http.createServer
    const timeoutMs = this.deps.timeoutMs ?? LOGIN_TIMEOUT_MS
    const { challenge, verifier } = createOidcPkce()
    const state = base64Url(crypto.randomBytes(24))
    const nonce = base64Url(crypto.randomBytes(24))

    return new Promise<ServiceXTokenSet>((resolve, reject) => {
      let settled = false
      let timer: NodeJS.Timeout | null = null

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer)
        }

        try {
          server.close()
        } catch {
          void 0
        }
      }

      const fail = (error: unknown) => {
        if (settled) {
          return
        }

        settled = true
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      }

      const finish = (produce: () => Promise<ServiceXTokenSet>) => {
        if (settled) {
          return
        }

        settled = true
        produce()
          .then(tokens => {
            cleanup()
            resolve(tokens)
          })
          .catch(error => {
            cleanup()
            reject(error instanceof Error ? error : new Error(String(error)))
          })
      }

      const server = createServer((request, response) => {
        const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')

        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
          'content-type': 'text/html; charset=utf-8'
        })
        response.end(DONE_HTML)

        if (settled || requestUrl.pathname !== '/callback') {
          return
        }

        const error = requestUrl.searchParams.get('error')
        const returnedState = requestUrl.searchParams.get('state') ?? ''
        const code = requestUrl.searchParams.get('code') ?? ''

        if (error) {
          fail(new ServiceXOidcError(requestUrl.searchParams.get('error_description') || error, error))

          return
        }

        if (!state || returnedState !== state) {
          fail(new Error('OIDC callback state mismatch (possible CSRF).'))

          return
        }

        if (!code) {
          fail(new Error('OIDC callback is missing the authorization code.'))

          return
        }

        finish(async () => {
          const tokens = await postTokenForm(this.fetchImpl, discovery.tokenEndpoint, {
            client_id: this.config.clientId,
            code,
            code_verifier: verifier,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri
          })

          const identity = await readIdentity(this.fetchImpl, discovery, tokens.accessToken)

          return { ...tokens, ...identity }
        })
      })

      let redirectUri = ''

      server.on('error', fail)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address() as AddressInfo | null

        if (!address || typeof address === 'string') {
          fail(new Error('Failed to bind the OIDC loopback callback listener.'))

          return
        }

        redirectUri = `http://127.0.0.1:${address.port}/callback`
        const authorizeUrl = new URL(discovery.authorizationEndpoint)

        const authorizeParams = {
          client_id: this.config.clientId,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          nonce,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: this.config.scopes,
          state
        }

        Object.assign(authorizeParams, oidcAuthorizationExtras(this.config))

        for (const [name, value] of Object.entries(authorizeParams)) {
          authorizeUrl.searchParams.set(name, value)
        }

        timer = setTimeout(
          () => fail(new Error('X Auth sign-in timed out. Try again from Provider Accounts.')),
          timeoutMs
        )
        this.logger(`[service-x] OIDC callback listening on 127.0.0.1:${address.port}`)
        this.deps.openExternal(authorizeUrl.toString()).catch(fail)
      })
    })
  }

  async refresh(refreshToken: string, previous: ServiceXTokenSet): Promise<ServiceXTokenSet> {
    const discovery = await this.discovery()

    return postTokenForm(
      this.fetchImpl,
      discovery.tokenEndpoint,
      {
        client_id: this.config.clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      },
      previous
    )
  }

  async revoke(tokens: ServiceXTokenSet | null): Promise<void> {
    if (!tokens) {
      return
    }

    const discovery = await this.discovery().catch(() => null)

    if (!discovery?.revocationEndpoint) {
      return
    }

    const token = tokens.refreshToken || tokens.accessToken

    if (!token) {
      return
    }

    await fetchWithTimeout(
      this.fetchImpl,
      discovery.revocationEndpoint,
      {
        body: new URLSearchParams({
          client_id: this.config.clientId,
          token,
          token_type_hint: tokens.refreshToken ? 'refresh_token' : 'access_token'
        }),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        method: 'POST'
      },
      TOKEN_TIMEOUT_MS
    ).catch(() => undefined)
  }
}

export { LOGIN_TIMEOUT_MS, TOKEN_TIMEOUT_MS, tokenSetFromBody }
