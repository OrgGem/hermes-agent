# Service X (Desktop-only)

Service X is intentionally isolated in this directory. Its only integration
points outside the folder are the typed preload IPC bridge, the Provider
Accounts row, and the lifecycle/IPC registrations in `electron/main.ts`.
Hermes Python, CLI, gateway, and `apps/shared` are unchanged.

## Runtime contract

- OIDC public client using Authorization Code + PKCE (`S256`).
- System-browser login with an ephemeral `127.0.0.1` callback.
- OIDC discovery pinned to the configured issuer.
- Access/rotating refresh tokens encrypted by Electron `safeStorage`.
- Refresh is single-flight and occurs 90 seconds before expiry.
- Local OpenAI-compatible endpoint:
  - `GET /healthz`
  - `GET /v1/models`
  - `POST /v1/chat/completions`
- Model IDs are discovered from the upstream provider's authenticated
  `GET /models` endpoint. The user does not configure a model name in Desktop;
  Hermes receives the full catalog and selects from it. A model value retained
  in an older Service X profile is treated only as a preferred default when it
  still exists in the live catalog.
- The listener binds only `127.0.0.1`; browser-origin requests are rejected.
- A separate random capability key protects the LLM routes. The OIDC access
  token is never exposed to the renderer and the capability key moves directly
  from Electron main to the local Hermes backend when the user selects
  **Use with Hermes**.
- State is scoped to the active Hermes profile under Electron `userData`.
- Known OpenAI model families are measured with a vendored `o200k_base` or
  `cl100k_base` tokenizer in a worker thread. Service X caches token counts by
  profile-scoped HMAC(content), encoding and tokenizer revision; it does not
  persist prompt text or raw token IDs.
- Local token counts are an estimate of textual input. They are not provider
  billing usage and do not create OpenAI Prompt Caching; upstream
  `usage.prompt_tokens` remains authoritative.

The Hermes custom endpoint can only be installed into a local backend. A remote
agent cannot reach the Desktop machine's loopback listener.

## Tokenization boundary

The tokenizer is intentionally isolated under `tokenization/vendor/` and the
worker is emitted as `dist/service-x-tokenizer-worker.mjs` during the Desktop
bundle. Unknown provider model IDs are skipped rather than silently labeled as
OpenAI-exact. Token metering is observational and never mutates or delays the
request forwarded to the upstream provider.

## Keycloak client

Create a public OIDC client (client authentication disabled), enable the
standard authorization-code flow, and allow loopback redirect URIs such as:

```text
http://127.0.0.1:*/callback
```

The exact wildcard syntax depends on the Keycloak version and realm policy.
Use scopes `openid profile offline_access` so Service X can rotate access
tokens without requiring a browser login each hour.

## MCP boundary

An independent MCP capability key is generated and stored now, but no empty
MCP server or generic plugin ABI is exposed. Add the `/mcp` transport here only
with the first concrete tool, then register it through Desktop's existing MCP
configuration API.
