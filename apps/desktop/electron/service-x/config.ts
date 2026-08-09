import fs from 'node:fs'
import path from 'node:path'

import {
  SERVICE_X_DEFAULT_PORT,
  SERVICE_X_DEFAULT_SCOPES,
  type ServiceXConfig,
  type ServiceXConfigInput
} from './contract'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

function normalizeUrl(raw: unknown, label: string): string {
  const value = String(raw ?? '').trim()

  if (!value) {
    throw new Error(`${label} is required.`)
  }

  let parsed: URL

  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} must be a valid absolute URL.`)
  }

  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not contain embedded credentials.`)
  }

  if (parsed.search || parsed.hash) {
    throw new Error(`${label} must not contain a query string or fragment.`)
  }

  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname))) {
    throw new Error(`${label} must use HTTPS (HTTP is allowed only for loopback development).`)
  }

  return parsed.toString().replace(/\/$/, '')
}

export function normalizeServiceXConfig(input: ServiceXConfigInput): ServiceXConfig {
  const clientId = String(input?.clientId ?? '').trim()
  const legacyModel = String(input?.model ?? '').trim()
  const rawScopes = String(input?.scopes ?? SERVICE_X_DEFAULT_SCOPES).trim()
  const scopes = Array.from(new Set(rawScopes.split(/\s+/).filter(Boolean))).join(' ')
  const port = input?.port === '' || input?.port == null ? SERVICE_X_DEFAULT_PORT : Number(input.port)

  if (!clientId) {
    throw new Error('OIDC client ID is required.')
  }

  if (clientId.length > 512) {
    throw new Error('OIDC client ID is too long.')
  }

  if (!scopes.split(' ').includes('openid')) {
    throw new Error('OIDC scopes must include openid.')
  }

  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('Local proxy port must be an integer between 1024 and 65535.')
  }

  return {
    clientId,
    issuerUrl: normalizeUrl(input?.issuerUrl, 'OIDC issuer URL'),
    ...(legacyModel ? { model: legacyModel } : {}),
    port,
    scopes,
    upstreamBaseUrl: normalizeUrl(input?.upstreamBaseUrl, 'Upstream LLM base URL')
  }
}

function atomicWrite(filePath: string, data: string | Buffer, mode?: number) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`

  fs.writeFileSync(tempPath, data, mode ? { mode } : undefined)
  fs.renameSync(tempPath, filePath)
}

export function serviceXScopeName(profile?: string | null): string {
  const value = String(profile ?? '').trim()

  return value && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value) ? `profile-${value}` : 'profile-default'
}

export class ServiceXConfigStore {
  readonly configPath: string

  constructor(rootDir: string, profile?: string | null) {
    this.configPath = path.join(rootDir, 'profiles', `${serviceXScopeName(profile)}.json`)
  }

  read(): ServiceXConfig | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.configPath, 'utf8'))

      return normalizeServiceXConfig(parsed)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return null
      }

      throw error
    }
  }

  write(input: ServiceXConfigInput): ServiceXConfig {
    const config = normalizeServiceXConfig(input)

    atomicWrite(this.configPath, `${JSON.stringify(config, null, 2)}\n`, 0o600)

    return config
  }
}

export { atomicWrite }
