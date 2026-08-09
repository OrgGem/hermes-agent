import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, test } from 'vitest'

import { ServiceXTokenStore } from './token-store'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

const fakeSecureStorage = {
  decryptString: (encrypted: Buffer) => Buffer.from(encrypted.toString('utf8').slice(4), 'base64').toString('utf8'),
  encryptString: (plainText: string) => Buffer.from(`enc:${Buffer.from(plainText).toString('base64')}`),
  isEncryptionAvailable: () => true
}

test('Service X stores distinct capability keys and OIDC tokens only in encrypted form', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-service-x-secrets-'))

  tempDirs.push(dir)
  const store = new ServiceXTokenStore(dir, 'alpha', fakeSecureStorage)
  const keys = await store.keys()

  assert.match(keys.llmKey, /^sx_/)
  assert.match(keys.mcpKey, /^sx_/)
  assert.notEqual(keys.llmKey, keys.mcpKey)

  await store.setTokens({
    accessToken: 'access-secret',
    expiresAt: 42,
    refreshToken: 'refresh-secret',
    scope: 'openid',
    tokenType: 'Bearer'
  })

  const encrypted = fs.readFileSync(store.secretPath, 'utf8')

  assert.equal(encrypted.includes('access-secret'), false)
  assert.equal(encrypted.includes('refresh-secret'), false)
  assert.equal(store.tokens()?.accessToken, 'access-secret')
})

test('Service X refuses plaintext fallback when OS secure storage is unavailable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-service-x-no-keychain-'))

  tempDirs.push(dir)

  const store = new ServiceXTokenStore(dir, null, {
    ...fakeSecureStorage,
    isEncryptionAvailable: () => false
  })

  await assert.rejects(store.keys(), /Secure OS credential storage is unavailable/)
})
