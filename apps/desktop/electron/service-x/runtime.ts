import path from 'node:path'

import { ServiceXConfigStore, serviceXScopeName } from './config'
import type {
  ServiceXConfig,
  ServiceXConfigInput,
  ServiceXHermesEndpoint,
  ServiceXLogger,
  ServiceXStatus
} from './contract'
import { ServiceXLlmProxy } from './llm-proxy'
import { ServiceXOidcClient, type ServiceXOidcClientDeps } from './oidc'
import { ServiceXAuthRequiredError, ServiceXTokenManager } from './token-manager'
import { type ServiceXSecureStorage, ServiceXTokenStore } from './token-store'
import { ServiceXTokenMeter } from './tokenization/chat-token-estimator'
import { TokenCountCache } from './tokenization/token-count-cache'

export interface ServiceXRuntimeOptions {
  fetch?: typeof fetch
  logger?: ServiceXLogger
  openExternal: (url: string) => Promise<void>
  rootDir: string
  secureStorage: ServiceXSecureStorage
}

export class ServiceXRuntime {
  private config: ServiceXConfig | null = null
  private configStore: ServiceXConfigStore | null = null
  private initializedScope: string | null = null
  private loginPromise: Promise<ServiceXStatus> | null = null
  private oidc: ServiceXOidcClient | null = null
  private profile: string | null = null
  private proxy: ServiceXLlmProxy | null = null
  private serviceError: string | undefined
  private tokenManager: ServiceXTokenManager | null = null
  private tokenStore: ServiceXTokenStore | null = null
  private readonly logger: ServiceXLogger

  constructor(private readonly options: ServiceXRuntimeOptions) {
    this.logger = options.logger ?? (() => undefined)
  }

  async selectScope(profile?: string | null): Promise<ServiceXStatus> {
    const normalizedProfile = String(profile ?? '').trim() || null
    const scope = serviceXScopeName(normalizedProfile)

    if (this.initializedScope === scope) {
      return this.status()
    }

    await this.stopProxy()
    this.initializedScope = scope
    this.profile = normalizedProfile
    this.configStore = new ServiceXConfigStore(this.options.rootDir, normalizedProfile)
    this.tokenStore = new ServiceXTokenStore(this.options.rootDir, normalizedProfile, this.options.secureStorage)
    this.config = null
    this.oidc = null
    this.tokenManager = null
    this.serviceError = undefined

    try {
      this.config = this.configStore.read()

      if (this.config) {
        await this.startConfiguredRuntime()
      }
    } catch (error) {
      this.serviceError = error instanceof Error ? error.message : String(error)
      this.logger(`[service-x] could not initialize ${scope}: ${this.serviceError}`)
    }

    return this.status()
  }

  async saveConfig(input: ServiceXConfigInput): Promise<ServiceXStatus> {
    if (!this.configStore || !this.tokenStore) {
      throw new Error('Service X profile scope is not initialized.')
    }

    const previous = this.config
    const next = this.configStore.write(input)

    const identityChanged = Boolean(
      previous && (previous.issuerUrl !== next.issuerUrl || previous.clientId !== next.clientId)
    )

    if (identityChanged) {
      if (this.tokenManager) {
        await this.tokenManager.clear()
      } else {
        await this.tokenStore.clearTokens()
      }
    }

    await this.stopProxy()
    this.config = next
    this.oidc = null
    this.tokenManager = null
    this.serviceError = undefined

    try {
      await this.startConfiguredRuntime()
    } catch (error) {
      this.serviceError = error instanceof Error ? error.message : String(error)
      this.logger(`[service-x] configuration saved but runtime could not start: ${this.serviceError}`)
    }

    return this.status()
  }

  login(): Promise<ServiceXStatus> {
    if (this.loginPromise) {
      return this.loginPromise
    }

    if (!this.oidc || !this.tokenManager) {
      return Promise.reject(new Error('Configure Service X before signing in.'))
    }

    this.loginPromise = this.oidc
      .login()
      .then(async tokens => {
        await this.tokenManager?.set(tokens)
        this.proxy?.clearModelCache()
        this.serviceError = undefined

        return this.status()
      })
      .finally(() => {
        this.loginPromise = null
      })

    return this.loginPromise
  }

  async logout(): Promise<ServiceXStatus> {
    const tokens = this.tokenManager?.tokens() ?? null

    await this.oidc?.revoke(tokens)
    await this.tokenManager?.clear()
    this.proxy?.clearModelCache()

    return this.status()
  }

  async hermesEndpoint(): Promise<ServiceXHermesEndpoint> {
    if (!this.config || !this.proxy || !this.tokenManager || !this.tokenStore) {
      throw new Error('Service X proxy is not ready.')
    }

    const { llmKey } = await this.tokenStore.keys()
    const models = await this.proxy.models()
    const legacyModel = this.config.model?.trim()
    const model = legacyModel && models.includes(legacyModel) ? legacyModel : models[0]

    if (!model) {
      throw new Error('The upstream LLM provider did not advertise any models.')
    }

    return {
      apiKey: llmKey,
      baseUrl: `http://127.0.0.1:${this.config.port}/v1`,
      id: 'service-x',
      model,
      models,
      name: 'Service X (X Auth)'
    }
  }

  status(): ServiceXStatus {
    const tokens = this.tokenManager?.tokens() ?? null

    return {
      baseUrl: this.config && this.proxy ? `http://127.0.0.1:${this.config.port}/v1` : undefined,
      config: this.config,
      configured: Boolean(this.config),
      displayName: tokens?.displayName,
      error: this.serviceError,
      expiresAt: tokens?.expiresAt || undefined,
      issuer: this.config?.issuerUrl,
      profile: this.profile || 'default',
      serviceReady: Boolean(this.proxy),
      signedIn: this.tokenManager?.signedIn() ?? false,
      subject: tokens?.subject
    }
  }

  async stop(): Promise<void> {
    await this.stopProxy()
  }

  private createOidc(config: ServiceXConfig): ServiceXOidcClient {
    const deps: ServiceXOidcClientDeps = {
      fetch: this.options.fetch,
      logger: this.logger,
      openExternal: this.options.openExternal
    }

    return new ServiceXOidcClient(config, deps)
  }

  private async startConfiguredRuntime() {
    if (!this.config || !this.tokenStore) {
      return
    }

    this.oidc = this.createOidc(this.config)
    this.tokenManager = new ServiceXTokenManager(this.config, this.tokenStore, {
      refresh: (config, refreshToken, previous) => {
        if (!this.oidc || config !== this.config) {
          throw new ServiceXAuthRequiredError('The Service X authentication scope changed. Sign in again.')
        }

        return this.oidc.refresh(refreshToken, previous)
      }
    })

    const { llmKey } = await this.tokenStore.keys()

    const cachePath = path.join(
      this.options.rootDir,
      'profiles',
      `${serviceXScopeName(this.profile)}-token-count-cache.json`
    )

    const tokenMeter = new ServiceXTokenMeter({
      cache: new TokenCountCache({ filePath: cachePath, hmacKey: llmKey })
    })

    const proxy = new ServiceXLlmProxy({
      capabilityKey: llmKey,
      config: this.config,
      logger: this.logger,
      tokenMeter,
      tokenManager: this.tokenManager
    })

    await proxy.start()
    this.proxy = proxy
  }

  private async stopProxy() {
    const proxy = this.proxy

    this.proxy = null

    if (proxy) {
      await proxy.stop()
    }
  }
}
