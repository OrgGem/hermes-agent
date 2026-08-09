import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import { test } from 'vitest'

import type { ServiceXConfig } from './contract'
import { createOidcPkce, discoverOidc, oidcAuthorizationExtras, tokenSetFromBody } from './oidc'

const config: ServiceXConfig = {
  clientId: 'hermes-desktop',
  issuerUrl: 'https://id.example.com/realms/hermes',
  model: 'model',
  port: 47831,
  scopes: 'openid profile offline_access',
  upstreamBaseUrl: 'https://llm.example.com/v1'
}

test('OIDC discovery pins the configured issuer and validates endpoints', async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        authorization_endpoint: `${config.issuerUrl}/protocol/openid-connect/auth`,
        issuer: config.issuerUrl,
        revocation_endpoint: `${config.issuerUrl}/protocol/openid-connect/revoke`,
        token_endpoint: `${config.issuerUrl}/protocol/openid-connect/token`,
        userinfo_endpoint: `${config.issuerUrl}/protocol/openid-connect/userinfo`
      }),
      { headers: { 'content-type': 'application/json' }, status: 200 }
    )

  const discovery = await discoverOidc(config, fetchImpl as typeof fetch)

  assert.equal(discovery.issuer, config.issuerUrl)
  assert.match(discovery.authorizationEndpoint, /openid-connect\/auth/)

  await assert.rejects(
    discoverOidc(
      config,
      (async () =>
        new Response(
          JSON.stringify({
            authorization_endpoint: 'https://attacker.example.com/auth',
            issuer: 'https://attacker.example.com',
            token_endpoint: 'https://attacker.example.com/token'
          }),
          { status: 200 }
        )) as typeof fetch
    ),
    /issuer mismatch/
  )
})

test('PKCE uses S256 and token parsing preserves a rotating refresh token fallback', () => {
  const pair = createOidcPkce()
  const expected = crypto.createHash('sha256').update(pair.verifier, 'ascii').digest('base64url')

  assert.equal(pair.challenge, expected)
  assert.ok(pair.verifier.length >= 43)

  const next = tokenSetFromBody(
    { access_token: 'new-access', expires_in: 300, token_type: 'Bearer' },
    {
      accessToken: 'old-access',
      displayName: 'Alice',
      expiresAt: 1,
      refreshToken: 'rotating-refresh',
      scope: 'openid',
      subject: 'user-1',
      tokenType: 'Bearer'
    },
    1_000
  )

  assert.equal(next.refreshToken, 'rotating-refresh')
  assert.equal(next.displayName, 'Alice')
  assert.equal(next.expiresAt, 301)
})

test('OIDC authorization asks for consent and the NocoBase API resource when those scopes are enabled', () => {
  assert.deepEqual(oidcAuthorizationExtras({ ...config, issuerUrl: 'http://localhost/api', scopes: 'openid offline_access api' }), {
    prompt: 'consent',
    resource: 'http://localhost/api/'
  })
  assert.deepEqual(oidcAuthorizationExtras({ ...config, scopes: 'openid profile' }), {})
})
