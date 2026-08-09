export const SERVICE_X_DEFAULT_PORT = 47831
export const SERVICE_X_DEFAULT_SCOPES = 'openid profile offline_access'

export interface ServiceXConfigInput {
  clientId?: string
  issuerUrl?: string
  model?: string
  port?: number | string
  scopes?: string
  upstreamBaseUrl?: string
}

export interface ServiceXConfig {
  clientId: string
  issuerUrl: string
  /** Legacy preferred model retained when reading older profile configs. */
  model?: string
  port: number
  scopes: string
  upstreamBaseUrl: string
}

export interface ServiceXIdentity {
  displayName?: string
  subject?: string
}

export interface ServiceXTokenSet extends ServiceXIdentity {
  accessToken: string
  expiresAt: number
  refreshToken: string
  scope: string
  tokenType: string
}

export interface ServiceXCapabilityKeys {
  llmKey: string
  mcpKey: string
}

export interface ServiceXSecrets extends ServiceXCapabilityKeys {
  tokens?: ServiceXTokenSet
  version: 1
}

export interface ServiceXStatus {
  baseUrl?: string
  config: ServiceXConfig | null
  configured: boolean
  displayName?: string
  error?: string
  expiresAt?: number
  issuer?: string
  profile: string
  serviceReady: boolean
  signedIn: boolean
  subject?: string
}

export interface ServiceXHermesEndpoint {
  apiKey: string
  baseUrl: string
  id: 'service-x'
  model: string
  models: string[]
  name: string
}

export interface OidcDiscoveryDocument {
  authorizationEndpoint: string
  endSessionEndpoint?: string
  issuer: string
  revocationEndpoint?: string
  tokenEndpoint: string
  userinfoEndpoint?: string
}

export interface ServiceXLogger {
  (line: string): void
}

export function serviceXSupportsHermesConnection(connection: { mode?: unknown; source?: unknown } | null): boolean {
  // The backend process itself must share Desktop's loopback namespace. SSH,
  // cloud, and URL-mode agents would interpret 127.0.0.1 on another machine.
  return connection?.source === 'local' && connection?.mode === 'local'
}
