import assert from 'node:assert/strict'
import http from 'node:http'

import { afterEach, test } from 'vitest'

import type { ServiceXConfig } from './contract'
import { ServiceXLlmProxy } from './llm-proxy'
import { ServiceXAuthRequiredError } from './token-manager'

const servers: http.Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      server =>
        new Promise<void>(resolve => {
          if (!server.listening) {
            resolve()

            return
          }

          server.close(() => resolve())
        })
    )
  )
})

async function listen(server: http.Server): Promise<number> {
  servers.push(server)

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  return (server.address() as any).port
}

const config = (port: number, upstreamPort: number): ServiceXConfig => ({
  clientId: 'desktop',
  issuerUrl: 'https://id.example.com',
  port,
  scopes: 'openid',
  upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`
})

test('local proxy authenticates, exposes upstream models and forwards a selected advertised model', async () => {
  const receivedAuth: string[] = []
  let receivedBody: any = null
  let meterClosed = false
  let observedBody: any = null
  let observedModel = ''

  const upstream = http.createServer((request, response) => {
    receivedAuth.push(String(request.headers.authorization ?? ''))

    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'fast-chat' }, { id: 'reasoning-chat' }, { id: 'fast-chat' }] }))

      return
    }

    const chunks: Buffer[] = []

    request.on('data', chunk => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
    })
  })

  const upstreamPort = await listen(upstream)

  const proxyPort = await (async () => {
    const probe = http.createServer()
    const port = await listen(probe)
    await new Promise<void>(resolve => probe.close(() => resolve()))
    servers.splice(servers.indexOf(probe), 1)

    return port
  })()

  const proxy = new ServiceXLlmProxy({
    capabilityKey: 'local-capability',
    config: config(proxyPort, upstreamPort),
    tokenMeter: {
      close: async () => {
        meterClosed = true
      },
      observe: async (body, model) => {
        observedBody = body
        observedModel = model

        return {} as any
      }
    },
    tokenManager: { accessToken: async () => 'oidc-access' } as any
  })

  await proxy.start()

  try {
    const unauthorized = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`)

    assert.equal(unauthorized.status, 401)

    const catalog = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`, {
      headers: { authorization: 'Bearer local-capability' }
    })

    const catalogBody = await catalog.json()

    assert.equal(catalog.status, 200)
    assert.deepEqual(
      catalogBody.data.map((model: any) => model.id),
      ['fast-chat', 'reasoning-chat']
    )

    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hello' }],
        model: 'reasoning-chat',
        prompt_cache_key: 'caller-owned-key',
        temperature: 0.25
      }),
      headers: { authorization: 'Bearer local-capability', 'content-type': 'application/json' },
      method: 'POST'
    })

    assert.equal(response.status, 200)
    assert.deepEqual(receivedAuth, ['Bearer oidc-access', 'Bearer oidc-access'])
    assert.equal(receivedBody.model, 'reasoning-chat')
    assert.equal(receivedBody.prompt_cache_key, 'caller-owned-key')
    assert.equal(receivedBody.temperature, 0.25)
    assert.equal(observedModel, 'reasoning-chat')
    assert.deepEqual(observedBody.messages, [{ role: 'user', content: 'hello' }])
  } finally {
    await proxy.stop()
  }

  assert.equal(meterClosed, true)
})

test('a pre-stream 401 refreshes once and retries with the rotated access token', async () => {
  const seen: string[] = []

  const upstream = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'default-chat' }] }))

      return
    }

    seen.push(String(request.headers.authorization ?? ''))

    if (seen.length === 1) {
      response.writeHead(401)
      response.end()

      return
    }

    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{}')
  })

  const upstreamPort = await listen(upstream)

  const proxyPort = await (async () => {
    const probe = http.createServer()
    const port = await listen(probe)
    await new Promise<void>(resolve => probe.close(() => resolve()))
    servers.splice(servers.indexOf(probe), 1)

    return port
  })()

  let refresh = false

  const proxy = new ServiceXLlmProxy({
    capabilityKey: 'local-capability',
    config: config(proxyPort, upstreamPort),
    tokenManager: {
      accessToken: async (force: boolean) => {
        if (force) {
          refresh = true
        }

        return refresh ? 'oidc-access-new' : 'oidc-access-old'
      }
    } as any
  })

  await proxy.start()

  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      body: '{}',
      headers: { authorization: 'Bearer local-capability', 'content-type': 'application/json' },
      method: 'POST'
    })

    assert.equal(response.status, 200)
    assert.deepEqual(seen, ['Bearer oidc-access-old', 'Bearer oidc-access-new'])
  } finally {
    await proxy.stop()
  }
})

test('local proxy rejects a model that is not advertised by the upstream provider', async () => {
  let chatRequests = 0

  const upstream = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'allowed-chat' }] }))

      return
    }

    chatRequests += 1
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{}')
  })

  const upstreamPort = await listen(upstream)
  const probe = http.createServer()
  const proxyPort = await listen(probe)

  await new Promise<void>(resolve => probe.close(() => resolve()))
  servers.splice(servers.indexOf(probe), 1)

  const proxy = new ServiceXLlmProxy({
    capabilityKey: 'local-capability',
    config: config(proxyPort, upstreamPort),
    tokenManager: { accessToken: async () => 'oidc-access' } as any
  })

  await proxy.start()

  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      body: JSON.stringify({ messages: [], model: 'blocked-chat' }),
      headers: { authorization: 'Bearer local-capability', 'content-type': 'application/json' },
      method: 'POST'
    })

    assert.equal(response.status, 400)
    assert.match(await response.text(), /not advertised/)
    assert.equal(chatRequests, 0)
  } finally {
    await proxy.stop()
  }
})

test('a cached model catalog never bypasses the current OIDC sign-in state', async () => {
  const upstream = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'allowed-chat' }] }))
  })

  const upstreamPort = await listen(upstream)
  const probe = http.createServer()
  const proxyPort = await listen(probe)

  await new Promise<void>(resolve => probe.close(() => resolve()))
  servers.splice(servers.indexOf(probe), 1)

  let signedIn = true

  const proxy = new ServiceXLlmProxy({
    capabilityKey: 'local-capability',
    config: config(proxyPort, upstreamPort),
    tokenManager: {
      accessToken: async () => {
        if (!signedIn) {
          throw new ServiceXAuthRequiredError('Sign in again.')
        }

        return 'oidc-access'
      }
    } as any
  })

  await proxy.start()

  try {
    const first = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`, {
      headers: { authorization: 'Bearer local-capability' }
    })

    assert.equal(first.status, 200)
    signedIn = false

    const afterLogout = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`, {
      headers: { authorization: 'Bearer local-capability' }
    })

    assert.equal(afterLogout.status, 401)
  } finally {
    await proxy.stop()
  }
})
