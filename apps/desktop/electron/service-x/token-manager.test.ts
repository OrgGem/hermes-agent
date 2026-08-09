import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { ServiceXConfig, ServiceXTokenSet } from './contract'
import { ServiceXAuthRequiredError, ServiceXOidcError, ServiceXTokenManager, tokenNeedsRefresh } from './token-manager'

const config: ServiceXConfig = {
  clientId: 'desktop',
  issuerUrl: 'https://id.example.com',
  model: 'model',
  port: 47831,
  scopes: 'openid offline_access',
  upstreamBaseUrl: 'https://llm.example.com/v1'
}

function tokens(patch: Partial<ServiceXTokenSet> = {}): ServiceXTokenSet {
  return {
    accessToken: 'access-old',
    expiresAt: 1_100,
    refreshToken: 'refresh-old',
    scope: 'openid offline_access',
    tokenType: 'Bearer',
    ...patch
  }
}

function fakeStore(initial: ServiceXTokenSet | null) {
  let current = initial

  return {
    clearTokens: async () => void (current = null),
    setTokens: async (next: ServiceXTokenSet) => void (current = next),
    tokens: () => current
  }
}

test('token refresh is single-flight for concurrent LLM requests', async () => {
  const store = fakeStore(tokens())
  let calls = 0
  let resolveRefresh!: (value: ServiceXTokenSet) => void

  const manager = new ServiceXTokenManager(config, store as any, {
    now: () => 1_050_000,
    refresh: async () => {
      calls += 1

      return new Promise(resolve => void (resolveRefresh = resolve))
    }
  })

  const first = manager.accessToken()
  const second = manager.accessToken()

  assert.equal(calls, 1)
  resolveRefresh(tokens({ accessToken: 'access-new', expiresAt: 2_000, refreshToken: 'refresh-rotated' }))
  assert.deepEqual(await Promise.all([first, second]), ['access-new', 'access-new'])
  assert.equal(store.tokens()?.refreshToken, 'refresh-rotated')
})

test('invalid_grant clears persisted tokens but transient refresh failures do not', async () => {
  const invalidStore = fakeStore(tokens())

  const invalid = new ServiceXTokenManager(config, invalidStore as any, {
    now: () => 1_050_000,
    refresh: async () => {
      throw new ServiceXOidcError('invalid grant', 'invalid_grant', 400)
    }
  })

  await assert.rejects(invalid.accessToken(), ServiceXAuthRequiredError)
  assert.equal(invalidStore.tokens(), null)

  const transientStore = fakeStore(tokens())

  const transient = new ServiceXTokenManager(config, transientStore as any, {
    now: () => 1_050_000,
    refresh: async () => {
      throw new Error('network unavailable')
    }
  })

  await assert.rejects(transient.accessToken(), /network unavailable/)
  assert.equal(transientStore.tokens()?.refreshToken, 'refresh-old')
})

test('refresh skew only refreshes expiring tokens', () => {
  assert.equal(tokenNeedsRefresh(tokens({ expiresAt: 1_100 }), 1_050), true)
  assert.equal(tokenNeedsRefresh(tokens({ expiresAt: 1_200 }), 1_050), false)
})
