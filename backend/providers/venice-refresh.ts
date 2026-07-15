/**
 * Venice AI JWT Refresh Module
 * 
 * Shared by both checker.ts (validation) and adapters/venice.ts (chat).
 * Clerk JWTs expire in ~60 seconds, so the adapter must refresh before
 * every request. This module provides a reusable refresh function with
 * in-memory caching and mutex to prevent concurrent refresh storms.
 */

import axios, { AxiosError } from 'axios'

const CHECK_TIMEOUT = 30000

interface RefreshCache {
  jwt: string
  expiresAt: number  // unix timestamp in ms
}

// In-memory cache: accountId -> { jwt, expiresAt }
const refreshCache = new Map<string, RefreshCache>()

// Mutex: accountId -> promise (prevents concurrent refreshes for same account)
const refreshMutex = new Map<string, Promise<string | null>>()

/**
 * Check if a JWT is expired or will expire within bufferSeconds.
 */
export function isJWTExpired(jwt: string, bufferSeconds = 10): boolean {
  try {
    const parts = jwt.split('.')
    if (parts.length !== 3) return true
    let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padding = payload.length % 4
    if (padding > 0) payload += '='.repeat(4 - padding)
    const parsed = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
    if (!parsed.exp) return true
    const now = Math.floor(Date.now() / 1000)
    return parsed.exp < now + bufferSeconds
  } catch {
    return true
  }
}

/**
 * Get cached JWT for an account if still valid.
 */
export function getCachedJWT(accountId: string): string | null {
  const cached = refreshCache.get(accountId)
  if (!cached) return null
  if (Date.now() >= cached.expiresAt) {
    refreshCache.delete(accountId)
    return null
  }
  return cached.jwt
}

/**
 * Cache a JWT for an account.
 */
export function cacheJWT(accountId: string, jwt: string): void {
  try {
    const parts = jwt.split('.')
    if (parts.length !== 3) return
    let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padding = payload.length % 4
    if (padding > 0) payload += '='.repeat(4 - padding)
    const parsed = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
    // Cache until 10 seconds before expiry
    const expiresAt = (parsed.exp - 10) * 1000
    refreshCache.set(accountId, { jwt, expiresAt })
  } catch {
    // Can't parse, don't cache
  }
}

/**
 * Invalidate cache for an account (e.g., after Clerk returns 401).
 */
export function invalidateCache(accountId: string): void {
  refreshCache.delete(accountId)
}

/**
 * Refresh a Venice JWT via the Clerk token endpoint.
 * 
 * POST https://clerk.venice.ai/v1/client/sessions/{sid}/tokens
 * Body: organization_id=&token={expired_jwt}
 * Response: { "object": "token", "jwt": "<fresh_jwt>" }
 * 
 * Uses mutex per accountId to prevent concurrent refresh storms.
 */
export async function refreshVeniceJWT(
  accountId: string,
  expiredJwt: string,
  cookies: string,
): Promise<string | null> {
  // Check cache first
  const cached = getCachedJWT(accountId)
  if (cached) return cached

  // If another refresh is already in progress for this account, wait for it
  const existing = refreshMutex.get(accountId)
  if (existing) {
    return existing
  }

  // Start new refresh
  const refreshPromise = doRefresh(accountId, expiredJwt, cookies)
  refreshMutex.set(accountId, refreshPromise)

  try {
    const result = await refreshPromise
    return result
  } finally {
    refreshMutex.delete(accountId)
  }
}

async function doRefresh(
  accountId: string,
  expiredJwt: string,
  cookies: string,
): Promise<string | null> {
  const log = (msg: string, ...args: any[]) => console.log(`[Venice-Refresh] ${msg}`, ...args)
  const logError = (msg: string, ...args: any[]) => console.error(`[Venice-Refresh] ${msg}`, ...args)

  try {
    // 1. Extract session_id (sid) from the JWT
    let sessionId = ''
    try {
      const parts = expiredJwt.split('.')
      if (parts.length !== 3) {
        logError('Cannot refresh: JWT has', parts.length, 'parts instead of 3')
        return null
      }
      let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
      const padding = payload.length % 4
      if (padding > 0) payload += '='.repeat(4 - padding)
      const parsed = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
      sessionId = parsed.sid || ''
      log('Extracted session ID:', sessionId || '(empty)')
    } catch (e) {
      logError('Failed to parse JWT:', (e as Error).message)
      return null
    }

    if (!sessionId) {
      logError('No session ID (sid) found in JWT. Cannot refresh.')
      return null
    }

    // 2. Call Clerk token refresh endpoint
    const refreshUrl = `https://clerk.venice.ai/v1/client/sessions/${sessionId}/tokens?__clerk_api_version=2026-05-12&_clerk_js_version=6.25.3`
    log('POST', refreshUrl)

    const response = await axios.post(
      refreshUrl,
      `organization_id=&token=${encodeURIComponent(expiredJwt)}`,
      {
        headers: {
          'accept': '*/*',
          'cache-control': 'no-cache',
          'content-type': 'application/x-www-form-urlencoded',
          'pragma': 'no-cache',
          'cookie': cookies,
          'origin': 'https://venice.ai',
          'referer': 'https://venice.ai/',
          'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Linux"',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-site',
          'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
        },
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      }
    )

    log('Refresh HTTP status:', response.status)

    if (response.status !== 200) {
      logError('❌ Clerk refresh failed HTTP', response.status, JSON.stringify(response.data).slice(0, 200))
      return null
    }

    // 3. Extract new JWT from response
    const data = response.data
    let newJwt: string | null = null

    if (data && typeof data === 'object' && typeof data.jwt === 'string') {
      newJwt = data.jwt
    }

    if (!newJwt || newJwt.split('.').length !== 3) {
      logError('Could not extract JWT from response:', JSON.stringify(data).slice(0, 300))
      return null
    }

    // 4. Verify the new JWT is valid
    try {
      const parts = newJwt.split('.')
      let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
      const padding = payload.length % 4
      if (padding > 0) payload += '='.repeat(4 - padding)
      const parsed = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
      const now = Math.floor(Date.now() / 1000)
      if (parsed.exp && parsed.exp < now) {
        logError('❌ Refreshed JWT is ALSO expired!')
        return null
      }
      log('✅ New JWT valid. User:', parsed.sub, '| Expires:', new Date(parsed.exp * 1000).toISOString())
    } catch {
      log('Could not parse new JWT payload (will still use it)')
    }

    // 5. Cache the new JWT
    cacheJWT(accountId, newJwt)
    log('✅ JWT refreshed, cached for account:', accountId, '| length:', newJwt.length)
    return newJwt
  } catch (error) {
    logError('❌ Refresh exception:', error instanceof Error ? error.message : error)
    if (error instanceof AxiosError && error.response) {
      logError('Response:', error.response.status, JSON.stringify(error.response.data).slice(0, 200))
    }
    return null
  }
}
