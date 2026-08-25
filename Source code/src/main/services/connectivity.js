import http from 'http'
import https from 'https'
import { URL } from 'url'
import querystring from 'querystring'

// Node error codes that mean "the endpoint is reachable but TLS validation
// failed" — a corporate TLS-inspecting proxy is the common cause on managed
// machines. We surface these differently from a plain connect failure so the
// user doesn't read a live-but-untrusted endpoint as a dead one.
const TLS_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_UNTRUSTED'
])

function classifyError(err) {
  const code = err.code || ''
  if (TLS_ERROR_CODES.has(code) || /certificate/i.test(err.message || '')) {
    return {
      type: 'tls',
      message:
        'Certificate validation failed. The server was reached, but its ' +
        'TLS certificate could not be trusted — this is common behind a ' +
        'corporate TLS-inspecting proxy.'
    }
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { type: 'dns', message: 'Could not resolve the server hostname. Check the URL.' }
  }
  if (code === 'ECONNREFUSED') {
    return { type: 'connect', message: 'Connection refused. The server did not accept the connection.' }
  }
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
    return { type: 'timeout', message: 'The request timed out before the server responded.' }
  }
  return { type: 'connect', message: err.message || 'Could not connect to the server.' }
}

// A metadata document is a few kilobytes. Anything wildly beyond that is a
// misconfigured endpoint (or a hostile one), and buffering it would put it
// straight into main-process memory, so the read is abandoned at this point.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

// Redirects are routine on these endpoints — http -> https and trailing-slash
// normalization both show up in the wild — and not following them surfaced as a
// bogus "Metadata endpoint returned HTTP 301".
const MAX_REDIRECTS = 5
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308])

/**
 * Low-level request helper built on http/https so we can measure timing and
 * distinguish TLS failures from connect failures (global fetch hides both).
 *
 * `startedAt` is threaded through the redirect chain so the reported timing
 * covers the whole round trip the caller actually waited for, not just the last
 * hop.
 */
function request(
  targetUrl,
  { method = 'GET', timeoutMs = 10000, headers, body, redirectsLeft = MAX_REDIRECTS, startedAt } = {}
) {
  return new Promise((resolve, reject) => {
    let url
    try {
      url = new URL(targetUrl)
    } catch {
      reject(Object.assign(new Error('Invalid URL.'), { code: 'ERR_INVALID_URL' }))
      return
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      reject(Object.assign(new Error('Only http(s) URLs can be requested.'), { code: 'ERR_INVALID_URL' }))
      return
    }
    const lib = url.protocol === 'http:' ? http : https
    const started = startedAt || Date.now()
    const req = lib.request(
      url,
      {
        method,
        timeout: timeoutMs,
        headers: { 'User-Agent': 'MCP-Manager', ...(headers || {}) }
      },
      (res) => {
        if (REDIRECT_CODES.has(res.statusCode) && res.headers.location) {
          res.resume() // drain, so the socket can be reused/closed
          if (redirectsLeft <= 0) {
            reject(Object.assign(new Error('Too many redirects.'), { code: 'ERR_TOO_MANY_REDIRECTS' }))
            return
          }
          let next
          try {
            next = new URL(res.headers.location, url)
          } catch {
            reject(Object.assign(new Error('Redirected to an invalid URL.'), { code: 'ERR_INVALID_URL' }))
            return
          }
          // Never follow https -> http: these requests carry credentials in the
          // client-credentials case, and a downgrade is not something a
          // legitimate metadata endpoint asks for.
          if (url.protocol === 'https:' && next.protocol === 'http:') {
            reject(
              Object.assign(new Error('Refused to follow a redirect from https to http.'), {
                code: 'ERR_INSECURE_REDIRECT'
              })
            )
            return
          }
          // 303 (and, per browser practice, 301/302 after a POST) continues as
          // GET without the original body.
          const changesMethod = res.statusCode === 303 || (method === 'POST' && res.statusCode !== 307 && res.statusCode !== 308)
          const nextHeaders = { ...(headers || {}) }
          if (changesMethod) {
            delete nextHeaders['Content-Type']
            delete nextHeaders['Content-Length']
          }
          resolve(
            request(next.toString(), {
              method: changesMethod ? 'GET' : method,
              timeoutMs,
              headers: nextHeaders,
              body: changesMethod ? undefined : body,
              redirectsLeft: redirectsLeft - 1,
              startedAt: started
            })
          )
          return
        }

        const chunks = []
        let size = 0
        res.on('data', (c) => {
          size += c.length
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(
              Object.assign(new Error('The server sent an unexpectedly large response.'), {
                code: 'ERR_RESPONSE_TOO_LARGE'
              })
            )
            return
          }
          chunks.push(c)
        })
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            timeMs: Date.now() - started
          })
        })
      }
    )
    req.on('timeout', () => {
      req.destroy(Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' }))
    })
    req.on('error', (err) => reject(err))
    req.end(body)
  })
}

/**
 * Step 4 — Reachability. Confirms the server responds at all. Any HTTP status
 * counts as "reachable"; only a transport/TLS failure is a failure here.
 */
export async function checkReachability(serverUrl) {
  try {
    const res = await request(serverUrl, { method: 'GET' })
    return {
      ok: true,
      status: res.statusCode,
      timeMs: res.timeMs,
      message: `Server responded in ${res.timeMs} ms`
    }
  } catch (err) {
    const info = classifyError(err)
    return { ok: false, errorType: info.type, message: info.message }
  }
}

export function metadataUrlFor(serverUrl) {
  const trimmed = serverUrl.replace(/\/+$/, '')
  return `${trimmed}/.well-known/openid-configuration`
}

/**
 * Step 4 — Metadata discovery + scope discovery. Fetches the OpenID/OAuth
 * metadata document, validates it as JSON with the expected OAuth fields, and
 * extracts scopes_supported.
 */
export async function discoverMetadata(serverUrl) {
  const metadataUrl = metadataUrlFor(serverUrl)
  let res
  try {
    res = await request(metadataUrl, { method: 'GET' })
  } catch (err) {
    const info = classifyError(err)
    return { ok: false, metadataUrl, errorType: info.type, message: info.message }
  }

  if (res.statusCode < 200 || res.statusCode >= 300) {
    return {
      ok: false,
      metadataUrl,
      errorType: 'http',
      message: `Metadata endpoint returned HTTP ${res.statusCode}.`
    }
  }

  let doc
  try {
    doc = JSON.parse(res.body)
  } catch {
    return {
      ok: false,
      metadataUrl,
      errorType: 'parse',
      message: 'Metadata endpoint did not return valid JSON.'
    }
  }

  const hasOAuthFields =
    doc && (doc.issuer || doc.authorization_endpoint || doc.token_endpoint)
  if (!hasOAuthFields) {
    return {
      ok: false,
      metadataUrl,
      errorType: 'shape',
      message: 'Metadata JSON is missing the expected OAuth fields.'
    }
  }

  const scopes = Array.isArray(doc.scopes_supported) ? doc.scopes_supported : []
  return {
    ok: true,
    metadataUrl,
    scopes,
    scopesAdvertised: Array.isArray(doc.scopes_supported),
    tokenEndpoint: typeof doc.token_endpoint === 'string' ? doc.token_endpoint : null,
    message: 'openid-configuration found'
  }
}

/**
 * Best-effort, non-blocking check of a client ID/secret pair against the
 * server's token endpoint, using the client_credentials grant. This is purely
 * exploratory: many OAuth servers don't enable client_credentials for a
 * confidential client that's meant for the authorization_code flow, so most
 * outcomes here are inconclusive rather than a real pass/fail. Only a
 * definitive `invalid_client`/`unauthorized_client` response is treated as
 * proof the credentials are wrong — everything else (success,
 * unsupported_grant_type, invalid_scope, network failure) is reported as
 * 'inconclusive' so the caller doesn't show a false error. Real confirmation
 * still only happens when the wizard's authorization step actually signs in.
 */
export async function tryClientCredentials(tokenEndpoint, clientId, clientSecret) {
  if (!tokenEndpoint) return { result: 'inconclusive' }
  const body = querystring.stringify({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret
  })
  try {
    const res = await request(tokenEndpoint, {
      method: 'POST',
      timeoutMs: 8000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      },
      body
    })
    if (res.statusCode >= 200 && res.statusCode < 300) {
      return { result: 'verified' }
    }
    let error
    try {
      error = JSON.parse(res.body).error
    } catch {
      error = null
    }
    if (error === 'invalid_client' || error === 'unauthorized_client') {
      return { result: 'rejected', error }
    }
    return { result: 'inconclusive', error }
  } catch {
    return { result: 'inconclusive' }
  }
}
