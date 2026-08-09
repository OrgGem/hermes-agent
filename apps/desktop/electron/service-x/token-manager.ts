import type { ServiceXConfig, ServiceXTokenSet } from './contract'
import type { ServiceXTokenStore } from './token-store'

const REFRESH_SKEW_SECONDS = 90

export class ServiceXAuthRequiredError extends Error {
  readonly code = 'service-x-auth-required'
}

export class ServiceXOidcError extends Error {
  constructor(
    message: string,
    readonly oidcCode?: string,
    readonly status?: number
  ) {
    super(message)
  }
}

export interface ServiceXTokenManagerDeps {
  now?: () => number
  refresh: (config: ServiceXConfig, refreshToken: string, previous: ServiceXTokenSet) => Promise<ServiceXTokenSet>
}

function tokenNeedsRefresh(tokens: ServiceXTokenSet, nowSeconds: number): boolean {
  return Number.isFinite(tokens.expiresAt) && tokens.expiresAt > 0
    ? nowSeconds >= tokens.expiresAt - REFRESH_SKEW_SECONDS
    : false
}

export class ServiceXTokenManager {
  private current: ServiceXTokenSet | null
  private refreshPromise: Promise<string> | null = null
  private readonly now: () => number

  constructor(
    private readonly config: ServiceXConfig,
    private readonly store: ServiceXTokenStore,
    private readonly deps: ServiceXTokenManagerDeps
  ) {
    this.current = store.tokens()
    this.now = deps.now ?? (() => Date.now())
  }

  tokens(): ServiceXTokenSet | null {
    return this.current
  }

  signedIn(): boolean {
    const tokens = this.current

    if (!tokens) {
      return false
    }

    return Boolean(tokens.refreshToken || !tokenNeedsRefresh(tokens, this.now() / 1000))
  }

  async set(tokens: ServiceXTokenSet): Promise<void> {
    this.current = tokens
    await this.store.setTokens(tokens)
  }

  async clear(): Promise<void> {
    this.current = null
    await this.store.clearTokens()
  }

  async accessToken(forceRefresh = false): Promise<string> {
    const tokens = this.current

    if (!tokens) {
      throw new ServiceXAuthRequiredError('Sign in to X Auth before using the local LLM proxy.')
    }

    if (!forceRefresh && tokens.accessToken && !tokenNeedsRefresh(tokens, this.now() / 1000)) {
      return tokens.accessToken
    }

    if (!tokens.refreshToken) {
      if (!forceRefresh && tokens.accessToken && tokens.expiresAt <= 0) {
        return tokens.accessToken
      }

      await this.clear()
      throw new ServiceXAuthRequiredError('The X Auth session expired. Sign in again.')
    }

    if (!this.refreshPromise) {
      this.refreshPromise = this.refresh(tokens).finally(() => {
        this.refreshPromise = null
      })
    }

    return this.refreshPromise
  }

  private async refresh(previous: ServiceXTokenSet): Promise<string> {
    try {
      const next = await this.deps.refresh(this.config, previous.refreshToken, previous)

      await this.set(next)

      return next.accessToken
    } catch (error) {
      if (error instanceof ServiceXOidcError && error.oidcCode === 'invalid_grant') {
        await this.clear()
        throw new ServiceXAuthRequiredError('The X Auth refresh session is no longer valid. Sign in again.')
      }

      throw error
    }
  }
}

export { REFRESH_SKEW_SECONDS, tokenNeedsRefresh }
