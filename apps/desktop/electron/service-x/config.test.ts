import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, test } from 'vitest'

import { normalizeServiceXConfig, ServiceXConfigStore } from './config'
import { serviceXSupportsHermesConnection } from './contract'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

function validConfig() {
  return {
    clientId: 'hermes-desktop',
    issuerUrl: 'https://id.example.com/realms/hermes/',
    port: '47831',
    scopes: 'openid profile offline_access profile',
    upstreamBaseUrl: 'https://llm.example.com/v1/'
  }
}

test('Service X config normalizes stable URLs, scopes and port', () => {
  assert.deepEqual(normalizeServiceXConfig(validConfig()), {
    clientId: 'hermes-desktop',
    issuerUrl: 'https://id.example.com/realms/hermes',
    port: 47831,
    scopes: 'openid profile offline_access',
    upstreamBaseUrl: 'https://llm.example.com/v1'
  })
})

test('Service X accepts profiles without a model and preserves an older preferred model', () => {
  assert.equal(normalizeServiceXConfig(validConfig()).model, undefined)
  assert.equal(normalizeServiceXConfig({ ...validConfig(), model: ' legacy-chat ' }).model, 'legacy-chat')
})

test('Service X config rejects bearer-leaking transport and non-OIDC scopes', () => {
  assert.throws(
    () => normalizeServiceXConfig({ ...validConfig(), upstreamBaseUrl: 'http://llm.example.com/v1' }),
    /must use HTTPS/
  )
  assert.throws(() => normalizeServiceXConfig({ ...validConfig(), scopes: 'profile offline_access' }), /include openid/)
  assert.doesNotThrow(() =>
    normalizeServiceXConfig({ ...validConfig(), issuerUrl: 'http://127.0.0.1:8080/realms/dev' })
  )
})

test('Service X config storage remains isolated by Hermes profile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-service-x-config-'))

  tempDirs.push(dir)
  const alpha = new ServiceXConfigStore(dir, 'alpha')
  const beta = new ServiceXConfigStore(dir, 'beta')

  alpha.write(validConfig())
  beta.write({ ...validConfig(), clientId: 'beta-client' })

  assert.equal(alpha.read()?.clientId, 'hermes-desktop')
  assert.equal(beta.read()?.clientId, 'beta-client')
  assert.notEqual(alpha.configPath, beta.configPath)
})

test('Service X endpoint installs only into a backend sharing Desktop loopback', () => {
  assert.equal(serviceXSupportsHermesConnection({ mode: 'local', source: 'local' }), true)
  assert.equal(serviceXSupportsHermesConnection({ mode: 'ssh', source: 'ssh' }), false)
  assert.equal(serviceXSupportsHermesConnection({ mode: 'remote', source: 'settings' }), false)
})
