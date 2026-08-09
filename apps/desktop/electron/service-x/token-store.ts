import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { atomicWrite, serviceXScopeName } from './config'
import type { ServiceXCapabilityKeys, ServiceXSecrets, ServiceXTokenSet } from './contract'

export interface ServiceXSecureStorage {
  decryptString: (encrypted: Buffer) => string
  encryptString: (plainText: string) => Buffer
  isEncryptionAvailable: () => boolean
}

function capabilityKey(): string {
  return `sx_${crypto.randomBytes(32).toString('base64url')}`
}

function emptySecrets(): ServiceXSecrets {
  return {
    llmKey: capabilityKey(),
    mcpKey: capabilityKey(),
    version: 1
  }
}

function parseSecrets(raw: string): ServiceXSecrets {
  const parsed = JSON.parse(raw) as Partial<ServiceXSecrets>

  if (parsed.version !== 1 || !parsed.llmKey || !parsed.mcpKey) {
    throw new Error('Service X secure state is malformed.')
  }

  return parsed as ServiceXSecrets
}

export class ServiceXTokenStore {
  readonly secretPath: string
  private mutation: Promise<void> = Promise.resolve()

  constructor(
    rootDir: string,
    profile: string | null | undefined,
    private readonly secureStorage: ServiceXSecureStorage
  ) {
    this.secretPath = path.join(rootDir, 'secrets', `${serviceXScopeName(profile)}.bin`)
  }

  private assertSecureStorage() {
    let available = false

    try {
      available = Boolean(this.secureStorage.isEncryptionAvailable())
    } catch {
      available = false
    }

    if (!available) {
      throw new Error(
        'Secure OS credential storage is unavailable. Service X will not save OIDC tokens or local capability keys.'
      )
    }
  }

  private readNow(): ServiceXSecrets | null {
    try {
      this.assertSecureStorage()
      const encrypted = fs.readFileSync(this.secretPath)

      return parseSecrets(this.secureStorage.decryptString(encrypted))
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return null
      }

      throw error
    }
  }

  private writeNow(secrets: ServiceXSecrets) {
    this.assertSecureStorage()
    const encrypted = this.secureStorage.encryptString(JSON.stringify(secrets))

    atomicWrite(this.secretPath, encrypted, 0o600)
  }

  private async update(mutator: (current: ServiceXSecrets) => ServiceXSecrets): Promise<ServiceXSecrets> {
    let result: ServiceXSecrets | null = null

    this.mutation = this.mutation
      .catch(() => undefined)
      .then(() => {
        const current = this.readNow() ?? emptySecrets()

        result = mutator(current)
        this.writeNow(result)
      })

    await this.mutation

    return result as ServiceXSecrets
  }

  async keys(): Promise<ServiceXCapabilityKeys> {
    const secrets = this.readNow() ?? (await this.update(current => current))

    return { llmKey: secrets.llmKey, mcpKey: secrets.mcpKey }
  }

  tokens(): ServiceXTokenSet | null {
    return this.readNow()?.tokens ?? null
  }

  async setTokens(tokens: ServiceXTokenSet): Promise<void> {
    await this.update(current => ({ ...current, tokens }))
  }

  async clearTokens(): Promise<void> {
    if (!fs.existsSync(this.secretPath)) {
      return
    }

    await this.update(current => {
      const { tokens: _tokens, ...rest } = current

      return rest
    })
  }
}
