import axios, { AxiosError } from 'axios'
import { getBuiltinProvider } from './builtin'
import type { Provider, ProviderCheckResult, Account } from '../shared/types'
import type { BuiltinProviderConfig } from '../store/types'
import * as refreshVeniceModule from './venice-refresh'

const CHECK_TIMEOUT = 15000

export interface TokenCheckResult {
  valid: boolean
  error?: string
  userInfo?: {
    name?: string
    email?: string
    quota?: number
    used?: number
  }
  /** If the token was auto-refreshed during validation, the new JWT */
  refreshedJwt?: string
}

export class ProviderChecker {
  static async checkProviderStatus(provider: Provider): Promise<ProviderCheckResult> {
    const startTime = Date.now()
    
    try {
      const builtinConfig = provider.type === 'builtin' 
        ? getBuiltinProvider(provider.id) 
        : null
      
      if (builtinConfig) {
        return await this.checkBuiltinProvider(builtinConfig)
      }
      
      return await this.checkCustomProvider(provider)
    } catch (error) {
      return {
        providerId: provider.id,
        status: 'offline',
        latency: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  private static async checkBuiltinProvider(config: BuiltinProviderConfig): Promise<ProviderCheckResult> {
    const startTime = Date.now()
    
    try {
      const checkUrl = `${config.apiEndpoint.replace('/api', '')}${config.tokenCheckEndpoint || '/health'}`
      
      const response = await axios({
        method: 'GET',
        url: checkUrl,
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      })
      
      const latency = Date.now() - startTime
      
      if (response.status >= 200 && response.status < 500) {
        return {
          providerId: config.id,
          status: 'online',
          latency,
        }
      }
      
      return {
        providerId: config.id,
        status: 'offline',
        latency,
        error: `HTTP ${response.status}`,
      }
    } catch (error) {
      return {
        providerId: config.id,
        status: 'offline',
        latency: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Connection failed',
      }
    }
  }

  private static async checkCustomProvider(provider: Provider): Promise<ProviderCheckResult> {
    const startTime = Date.now()
    
    try {
      const response = await axios({
        method: 'GET',
        url: `${provider.apiEndpoint}/models`,
        headers: provider.headers,
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      })
      
      const latency = Date.now() - startTime
      
      if (response.status >= 200 && response.status < 500) {
        return {
          providerId: provider.id,
          status: 'online',
          latency,
        }
      }
      
      return {
        providerId: provider.id,
        status: 'offline',
        latency,
        error: `HTTP ${response.status}`,
      }
    } catch (error) {
      return {
        providerId: provider.id,
        status: 'offline',
        latency: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Connection failed',
      }
    }
  }

  static async checkAccountToken(
    provider: Provider,
    account: Account
  ): Promise<TokenCheckResult> {
    const builtinConfig = provider.type === 'builtin' 
      ? getBuiltinProvider(provider.id) 
      : null
    
    if (!builtinConfig) {
      return this.checkCustomAccountToken(provider, account)
    }
    
    switch (provider.id) {
      case 'deepseek':
        return this.checkDeepSeekToken(account.credentials.token)
      case 'glm':
        return this.checkGLMToken(account.credentials.refresh_token)
      case 'kimi':
        return this.checkKimiToken(account.credentials.token)
      case 'minimax':
        return this.checkMiniMaxToken(account.credentials)
      case 'qwen':
        return this.checkQwenToken(account.credentials.ticket)
      case 'qwen-ai':
        return this.checkQwenAiToken(account.credentials.token)
      case 'zai':
        return this.checkZaiToken(account.credentials.token || account.credentials.accessToken || account.credentials.jwt || account.credentials.ticket)
      case 'perplexity':
        return this.checkPerplexityToken(account.credentials.sessionToken || account.credentials.token)
      case 'mimo':
        return this.checkMimoToken(
          account.credentials.service_token,
          account.credentials.user_id,
          account.credentials.ph_token
        )
      case 'venice':
        return this.checkVeniceToken(account.credentials)
      default:
        if (!builtinConfig.tokenCheckEndpoint) {
          return { valid: true }
        }
        return this.checkGenericToken(builtinConfig, account)
    }
  }

  /**
   * Validate Venice AI token/session
   * First checks JWT expiry locally, then hits /api/app/models to verify the session works.
   */
  /**
   * Refresh Venice JWT by delegating to the shared refresh module.
   */
  private static async refreshVeniceJWT(
    expiredJwt: string,
    cookies: string,
  ): Promise<string | null> {
    return refreshVeniceModule.refreshVeniceJWT('checker', expiredJwt, cookies)
  }

  /**
   * Validate Venice AI token/session.
   * First checks JWT expiry locally. If expired, it tries to refresh via the
   * Clerk token endpoint, then hits /api/inference/rate-limits to verify the
   * session works.
   */
  private static async checkVeniceToken(credentials: Record<string, string>): Promise<TokenCheckResult> {
    const log = (msg: string, ...args: any[]) => console.log(`[Venice-Validate] ${msg}`, ...args)
    const logError = (msg: string, ...args: any[]) => console.error(`[Venice-Validate] ${msg}`, ...args)

    try {
      let jwt = credentials.jwt || credentials.token || ''
      const cookies = credentials.cookies || credentials.cookie || ''
      const distinctId = credentials.distinctId || credentials['x-venice-distinct-id'] || ''
      const locale = credentials.locale || credentials['x-venice-locale'] || 'en'
      const middlefaceVersion = credentials.middlefaceVersion || credentials['x-venice-middleface-version'] || '0.1.890'
      const version = credentials.version || credentials['x-venice-version'] || 'interface@20260715.003824+7020d35'

      log('=== Starting Venice token validation ===')
      log('Credential keys:', Object.keys(credentials))
      log('JWT length:', jwt.length, '| JWT preview:', jwt.slice(0, 50) + '...')
      log('Cookies length:', cookies.length, '| Cookies preview:', cookies.slice(0, 80) + '...')
      log('distinctId:', distinctId || '(empty)')
      log('locale:', locale, '| middlefaceVersion:', middlefaceVersion, '| version:', version)

      if (!jwt) {
        logError('No JWT found in credentials. Available keys:', Object.keys(credentials))
        return { valid: false, error: 'JWT Token is required' }
      }
      if (!cookies) {
        logError('No cookies found in credentials. Available keys:', Object.keys(credentials))
        return { valid: false, error: 'Session cookies are required' }
      }

      // 1. Local JWT expiry check — if expired, try refresh before failing
      let jwtPayload: Record<string, any> = {}
      let jwtExpired = false
      try {
        const parts = jwt.split('.')
        if (parts.length !== 3) {
          logError('JWT has', parts.length, 'parts instead of 3')
          return { valid: false, error: 'Invalid JWT format' }
        }
        let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
        const padding = payload.length % 4
        if (padding > 0) payload += '='.repeat(4 - padding)
        jwtPayload = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
        
        const now = Math.floor(Date.now() / 1000)
        log('JWT payload parsed. sub:', jwtPayload.sub, '| exp:', jwtPayload.exp, '| now:', now)
        log('JWT expires:', jwtPayload.exp ? new Date(jwtPayload.exp * 1000).toISOString() : 'unknown')
        
        if (jwtPayload.exp && jwtPayload.exp < now) {
          jwtExpired = true
          log('⚠️ JWT EXPIRED! Exp:', new Date(jwtPayload.exp * 1000).toISOString(), 'Now:', new Date(now * 1000).toISOString())
          log('JWT expired, attempting Clerk token refresh...')
        } else {
          log('JWT expiry check PASSED')
        }
      } catch (e) {
        log('JWT parse failed (non-critical, will try API):', (e as Error).message)
      }

      // If JWT expired, try to refresh it via Clerk token endpoint
      let refreshedJwt: string | null = null
      if (jwtExpired) {
        refreshedJwt = await this.refreshVeniceJWT(jwt, cookies)
        if (refreshedJwt) {
          jwt = refreshedJwt
          // Re-parse the new JWT to get updated payload
          try {
            const parts = jwt.split('.')
            let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
            const padding = payload.length % 4
            if (padding > 0) payload += '='.repeat(4 - padding)
            jwtPayload = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
            log('Using refreshed JWT. New exp:', jwtPayload.exp ? new Date(jwtPayload.exp * 1000).toISOString() : 'unknown')
          } catch {
            // Use existing jwtPayload
          }
        } else {
          logError('❌ JWT refresh failed. Cannot validate with expired token.')
          return { valid: false, error: 'JWT token has expired and refresh failed. Please re-capture your Venice session.' }
        }
      }

      // 2. Verify by hitting the rate-limits endpoint (most reliable)
      const requestTimestamp = Date.now()
      const requestHeaders: Record<string, string> = {
        'accept': 'application/json, text/plain, */*',
        'authorization': `Bearer ${jwt}`,
        'cookie': cookies,
        'cache-control': 'no-cache',
        'pragma': 'no-cache',
        'origin': 'https://venice.ai',
        'referer': 'https://venice.ai/',
        'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Linux"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-site',
        'x-venice-distinct-id': distinctId,
        'x-venice-locale': locale,
        'x-venice-middleface-version': middlefaceVersion,
        'x-venice-request-timestamp-ms': String(requestTimestamp),
        'x-venice-version': version,
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
      }

      log('Calling GET https://outerface.venice.ai/api/inference/rate-limits')

      const response = await axios.get(
        'https://outerface.venice.ai/api/inference/rate-limits',
        {
          headers: requestHeaders,
          timeout: CHECK_TIMEOUT,
          validateStatus: () => true,
        }
      )

      const elapsed = Date.now() - requestTimestamp
      log('Response received in', elapsed, 'ms')
      log('HTTP Status:', response.status)
      log('Response data:', JSON.stringify(response.data).slice(0, 500))

      if (response.status === 200 && response.data && typeof response.data.chat !== 'undefined') {
        const username = jwtPayload.sub || 'Venice User'
        log('✅ Validation PASSED for user:', username)
        return {
          valid: true,
          userInfo: {
            name: username,
            email: jwtPayload.sub || username,
          },
          // Propagate the refreshed JWT so it can be persisted
          ...(refreshedJwt ? { refreshedJwt } : {}),
        }
      }

      if (response.status === 401 || response.status === 403) {
        logError('❌ Authentication failed (HTTP', response.status, ')')
        return { valid: false, error: 'Authentication failed: JWT or cookies may be expired' }
      }

      logError('❌ Validation failed. Status:', response.status)
      logError('Response body:', JSON.stringify(response.data).slice(0, 300))
      return { 
        valid: false, 
        error: `API validation failed (HTTP ${response.status}): ${typeof response.data === 'string' ? response.data.slice(0, 100) : JSON.stringify(response.data).slice(0, 100)}` 
      }
    } catch (error) {
      logError('❌ Exception during validation:', error instanceof Error ? error.message : error)
      if (error instanceof AxiosError) {
        logError('Axios error details:', error.code, error.message)
        if (error.response) {
          logError('Response status:', error.response.status)
          logError('Response data:', JSON.stringify(error.response.data).slice(0, 300))
        }
        if (error.config) {
          logError('Request URL:', error.config.url)
          logError('Request headers:', JSON.stringify(error.config.headers, (k, v) => k === 'cookie' ? v.slice(0, 50) + '...' : k === 'authorization' ? 'Bearer ***' : v, 2))
        }
      }
      return {
        valid: false,
        error: error instanceof AxiosError ? error.message : 'Connection failed',
      }
    }
  }

  private static checkMimoToken(
    serviceToken: string,
    userId: string,
    phToken: string
  ): TokenCheckResult {
    if (!serviceToken || !userId || !phToken) {
      return { valid: false, error: 'Missing required credentials: service_token, user_id, ph_token' }
    }

    return {
      valid: true,
      userInfo: {
        name: 'Mimo User',
      },
    }
  }

  private static async checkDeepSeekToken(token: string): Promise<TokenCheckResult> {
    try {
      console.log('[DeepSeek] Validating Token (length:', token.length, ')')
      
      const response = await axios.get(
        'https://chat.deepseek.com/api/v0/users/current',
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Accept': '*/*',
            'Origin': 'https://chat.deepseek.com',
            'Referer': 'https://chat.deepseek.com/',
          },
          timeout: CHECK_TIMEOUT,
          validateStatus: () => true,
        }
      )
      
      console.log('[DeepSeek] Response status:', response.status)
      console.log('[DeepSeek] Response data:', JSON.stringify(response.data, null, 2))
      
      // Response format: { code: 0, data: { biz_data: { ... } } }
      if (response.status === 200 && response.data?.code === 0 && response.data?.data?.biz_data) {
        const bizData = response.data.data.biz_data
        return {
          valid: true,
          userInfo: {
            name: bizData.id_profile?.name,
            email: bizData.email,
          },
        }
      }
      
      if (response.status === 401 || response.data?.code === 40003 || response.data?.data?.biz_code === 40003) {
        return { valid: false, error: 'Token expired or invalid' }
      }
      
      return { valid: false, error: `Validation failed: ${response.data?.msg || response.data?.message || JSON.stringify(response.data)}` }
    } catch (error) {
      console.error('[DeepSeek] Validation error:', error)
      return {
        valid: false,
        error: error instanceof AxiosError 
          ? error.message 
          : 'Connection failed',
      }
    }
  }

  private static async checkGLMToken(refreshToken: string): Promise<TokenCheckResult> {
    try {
      console.log('[GLM] Validating Token (length:', refreshToken.length, ')')
      
      const sign = await this.generateGLMSignV2()
      
      const response = await axios.post(
        'https://chatglm.cn/chatglm/user-api/user/refresh',
        {},
        {
          headers: {
            'Accept': 'text/event-stream',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
            'App-Name': 'chatglm',
            'Cache-Control': 'no-cache',
            'Content-Type': 'application/json',
            'Origin': 'https://chatglm.cn',
            'Pragma': 'no-cache',
            'Priority': 'u=1, i',
            'Sec-Ch-Ua': '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"Windows"',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'X-App-Fr': 'browser_extension',
            'X-App-Platform': 'pc',
            'X-App-Version': '0.0.1',
            'X-Device-Brand': '',
            'X-Device-Model': '',
            'X-Exp-Groups': 'na_android_config:exp:NA,na_4o_config:exp:4o_A,tts_config:exp:tts_config_a,na_glm4plus_config:exp:open,mainchat_server_app:exp:A,mobile_history_daycheck:exp:a,desktop_toolbar:exp:A,chat_drawing_server:exp:A,drawing_server_cogview:exp:cogview4,app_welcome_v2:exp:A,chat_drawing_streamv2:exp:A,mainchat_rm_fc:exp:add,mainchat_dr:exp:open,chat_auto_entrance:exp:A,drawing_server_hi_dream:control:A,homepage_square:exp:close,assistant_recommend_prompt:exp:3,app_home_regular_user:exp:A,memory_common:exp:enable,mainchat_moe:exp:300,assistant_greet_user:exp:greet_user,app_welcome_personalize:exp:A,assistant_model_exp_group:exp:glm4.5,ai_wallet:exp:ai_wallet_enable',
            'X-Lang': 'zh',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
            Authorization: `Bearer ${refreshToken}`,
            'X-Device-Id': this.generateUUID().replace(/-/g, ''),
            'X-Nonce': sign.nonce,
            'X-Request-Id': this.generateUUID().replace(/-/g, ''),
            'X-Sign': sign.sign,
            'X-Timestamp': `${sign.timestamp}`,
          },
          timeout: CHECK_TIMEOUT,
          validateStatus: () => true,
        }
      )
      
      console.log('[GLM] Response status:', response.status)
      console.log('[GLM] Response data:', JSON.stringify(response.data, null, 2))
      
      if (response.status === 200 && response.data?.result?.access_token) {
        return {
          valid: true,
          userInfo: {
            name: response.data.result.user?.name,
          },
        }
      }
      
      if (response.status === 401 || response.data?.status === 40001) {
        return { valid: false, error: 'Token expired or invalid' }
      }
      
      return { valid: false, error: `Validation failed: ${response.data?.message || response.data?.msg || JSON.stringify(response.data)}` }
    } catch (error) {
      console.error('[GLM] Validation error:', error)
      return {
        valid: false,
        error: error instanceof AxiosError 
          ? error.message 
          : 'Connection failed',
      }
    }
  }
  
  private static async generateGLMSignV2(): Promise<{ timestamp: string; nonce: string; sign: string }> {
    const crypto = await import('crypto')
    const secret = '8a1317a7468aa3ad86e997d08f3f31cb'
    
    // GLM timestamp algorithm
    const now = Date.now()
    const timestampStr = now.toString()
    const len = timestampStr.length
    const digits = timestampStr.split('').map(d => parseInt(d))
    const sum = digits.reduce((a, b) => a + b, 0) - digits[len - 2]
    const checkDigit = sum % 10
    const timestamp = timestampStr.substring(0, len - 2) + checkDigit + timestampStr.substring(len - 1)
    
    // Random UUID (no separators)
    const nonce = this.generateUUID().replace(/-/g, '')
    
    // Signature
    const sign = crypto.createHash('md5').update(`${timestamp}-${nonce}-${secret}`).digest('hex')
    
    return { timestamp, nonce, sign }
  }

  private static async checkKimiToken(token: string): Promise<TokenCheckResult> {
    try {
      console.log('[Kimi] Validating Token (length:', token.length, ')')
      
      const response = await axios.post(
        'https://www.kimi.com/apiv2/kimi.gateway.order.v1.SubscriptionService/GetSubscription',
        {},
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'Accept': '*/*',
            'Origin': 'https://www.kimi.com',
            'Referer': 'https://www.kimi.com/',
          },
          timeout: CHECK_TIMEOUT,
          validateStatus: () => true,
        }
      )
      
      console.log('[Kimi] Response status:', response.status)
      console.log('[Kimi] Response data:', JSON.stringify(response.data, null, 2))
      
      if (response.status === 200 && response.data?.subscription) {
        return {
          valid: true,
          userInfo: {
            name: response.data.subscription.userName,
          },
        }
      }
      
      return { valid: false, error: 'Token expired or invalid' }
    } catch (error) {
      console.error('[Kimi] Validation error:', error)
      return {
        valid: false,
        error: error instanceof AxiosError 
          ? error.message 
          : 'Connection failed',
      }
    }
  }

  private static async checkMiniMaxToken(
    credentials: Record<string, string>,
  ): Promise<TokenCheckResult> {
    try {
      const { resolveMiniMaxCredentials } = await import('../shared/minimaxCredentials')
      const resolved = resolveMiniMaxCredentials(credentials)
      if (resolved.error) {
        return { valid: false, error: resolved.error }
      }

      const { jwtToken, realUserID } = resolved
      
      const crypto = await import('crypto')
      
      const uuid = realUserID
      const unix = Date.now().toString()
      const timestamp = Math.floor(Date.now() / 1000)
      const dataJson = JSON.stringify({ uuid })
      
      const signature = crypto.createHash('md5').update(`${timestamp}${jwtToken}${dataJson}`).digest('hex')
      
      const queryParams = new URLSearchParams({
        device_platform: 'web',
        biz_id: '3',
        app_id: '3001',
        version_code: '22201',
        uuid: uuid,
        user_id: realUserID,
      }).toString()
      
      const fullUri = `/v1/api/user/device/register?${queryParams}`
      const yy = crypto.createHash('md5').update(`${encodeURIComponent(fullUri)}_${dataJson}${crypto.createHash('md5').update(unix).digest('hex')}ooui`).digest('hex')
      
      const response = await axios.post(
        `https://agent.minimaxi.com${fullUri}`,
        { uuid },
        {
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Cache-Control': 'no-cache',
            'Content-Type': 'application/json',
            'Origin': 'https://agent.minimaxi.com',
            'Pragma': 'no-cache',
            'Referer': 'https://agent.minimaxi.com/',
            'Sec-Ch-Ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"macOS"',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
            'token': jwtToken,
            'x-timestamp': String(timestamp),
            'x-signature': signature,
            'yy': yy,
          },
          timeout: CHECK_TIMEOUT,
          validateStatus: () => true,
        }
      )
      
      if (response.status === 200 && response.data?.data?.deviceIDStr) {
        const userInfo = response.data.data.userInfo
        return {
          valid: true,
          userInfo: {
            name: userInfo?.name || userInfo?.nickname,
            email: userInfo?.email,
          },
        }
      }
      
      if (response.data?.statusInfo?.code === 1001) {
        return { valid: false, error: 'Token expired or invalid' }
      }
      
      return { valid: false, error: `Validation failed: ${response.data?.statusInfo?.message || 'Unknown error'}` }
    } catch (error) {
      console.error('[MiniMax] Validation error:', error)
      return {
        valid: false,
        error: error instanceof AxiosError 
          ? error.message 
          : 'Connection failed',
      }
    }
  }

  private static async checkQwenToken(ticket: string): Promise<TokenCheckResult> {
    try {
      const response = await axios.post(
        'https://chat2-api.qianwen.com/api/v2/session/page/list',
        {},
        {
          headers: {
            Cookie: `tongyi_sso_ticket=${ticket}`,
            'Content-Type': 'application/json',
            'Accept': '*/*',
            'Origin': 'https://www.qianwen.com',
            'Referer': 'https://www.qianwen.com/',
            'X-Platform': 'pc_tongyi',
            'X-DeviceId': '5b68c267-cd8e-fd0e-148a-18345bc9a104',
          },
          params: {
            biz_id: 'ai_qwen',
            chat_client: 'h5',
            device: 'pc',
            fr: 'pc',
            pr: 'qwen',
            ut: '5b68c267-cd8e-fd0e-148a-18345bc9a104',
          },
          timeout: CHECK_TIMEOUT,
          validateStatus: () => true,
        }
      )
      
      if (response.status === 200 && response.data?.success) {
        return {
          valid: true,
        }
      }
      
      if (!response.data?.success) {
        return { valid: false, error: 'SSO ticket expired or invalid' }
      }
      
      return { valid: false, error: `Validation failed: ${response.data?.errorMsg || 'Unknown error'}` }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof AxiosError 
          ? error.message 
          : 'Connection failed',
      }
    }
  }

  private static async checkQwenAiToken(token: string): Promise<TokenCheckResult> {
    try {
      const response = await axios.get(
        'https://chat.qwen.ai/api/v2/user',
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            source: 'web',
          },
          timeout: CHECK_TIMEOUT,
          validateStatus: () => true,
        }
      )

      if (response.status === 200 && response.data?.data) {
        return {
          valid: true,
          userInfo: {
            name: response.data.data.name || response.data.data.email,
            email: response.data.data.email,
          },
        }
      }

      if (response.status === 401) {
        return { valid: false, error: 'Token expired or invalid' }
      }

      return { valid: false, error: `Validation failed: HTTP ${response.status}` }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof AxiosError
          ? error.message
          : 'Connection failed',
      }
    }
  }

  private static checkZaiToken(token: string): TokenCheckResult {
    if (!token) {
      return { valid: false, error: 'Token cannot be empty' }
    }

    if (!token.startsWith('eyJ') || token.split('.').length !== 3) {
      return { valid: false, error: 'Token is invalid, please use the JWT token from chat.z.ai cookies or localStorage' }
    }

    try {
      const parts = token.split('.')
      let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
      const padding = payload.length % 4
      if (padding > 0) {
        payload += '='.repeat(4 - padding)
      }
      const data = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))

      if (typeof data.email === 'string' && data.email.includes('@guest.com')) {
        return { valid: false, error: 'Guest account not allowed, please login with a real Z.ai account' }
      }

      const userId = data.id || data.user_id || data.uid || data.sub
      if (!userId) {
        return { valid: false, error: 'Token payload does not contain a user id' }
      }

      return {
        valid: true,
        userInfo: {
          name: data.name || data.email || userId,
          email: data.email,
        },
      }
    } catch {
      return { valid: false, error: 'Invalid JWT token' }
    }
  }

  private static checkPerplexityToken(sessionToken: string): TokenCheckResult {
    if (!sessionToken) {
      return { valid: false, error: 'Session token is required' }
    }

    if (sessionToken.length < 100) {
      return { valid: false, error: 'Session token appears to be invalid (too short)' }
    }

    return {
      valid: true,
      userInfo: {
        name: 'Perplexity User',
      },
    }
  }

  private static async checkGenericToken(
    config: BuiltinProviderConfig,
    account: Account
  ): Promise<TokenCheckResult> {
    try {
      const headers: Record<string, string> = {
        ...config.headers,
      }
      
      const credentials = account.credentials
      if (credentials.token) {
        headers['Authorization'] = `Bearer ${credentials.token}`
      } else if (credentials.apiKey) {
        headers['Authorization'] = `Bearer ${credentials.apiKey}`
      }
      
      const response = await axios({
        method: config.tokenCheckMethod || 'GET',
        url: `${config.apiEndpoint.replace('/api', '')}${config.tokenCheckEndpoint}`,
        headers,
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      })
      
      if (response.status >= 200 && response.status < 300) {
        return { valid: true }
      }
      
      if (response.status === 401) {
        return { valid: false, error: 'Authentication failed, please check credentials' }
      }
      
      return { valid: false, error: `Validation failed: HTTP ${response.status}` }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof AxiosError 
          ? error.message 
          : 'Connection failed',
      }
    }
  }

  private static async checkCustomAccountToken(
    provider: Provider,
    account: Account
  ): Promise<TokenCheckResult> {
    try {
      const headers: Record<string, string> = {
        ...provider.headers,
      }
      
      const credentials = account.credentials
      if (credentials.token) {
        headers['Authorization'] = `Bearer ${credentials.token}`
      } else if (credentials.apiKey) {
        headers['Authorization'] = `Bearer ${credentials.apiKey}`
      }
      
      const response = await axios({
        method: 'GET',
        url: `${provider.apiEndpoint}/models`,
        headers,
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      })
      
      if (response.status >= 200 && response.status < 300) {
        return { valid: true }
      }
      
      if (response.status === 401) {
        return { valid: false, error: 'Authentication failed, please check credentials' }
      }
      
      return { valid: false, error: `Validation failed: HTTP ${response.status}` }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof AxiosError 
          ? error.message 
          : 'Connection failed',
      }
    }
  }

  private static generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0
      const v = c === 'x' ? r : (r & 0x3) | 0x8
      return v.toString(16)
    })
  }

  private static async generateGLMSign(timestamp: string, nonce: string): Promise<string> {
    const crypto = await import('crypto')
    const secret = '8a1317a7468aa3ad86e997d08f3f31cb'
    return crypto.createHash('md5').update(`${timestamp}-${nonce}-${secret}`).digest('hex')
  }

  static async fetchProviderModels(
    providerId: string
  ): Promise<{
    supportedModels: string[]
    modelMappings: Record<string, string>
  }> {
    const builtinConfig = getBuiltinProvider(providerId)
    
    if (!builtinConfig) {
      throw new Error(`Provider ${providerId} not found`)
    }

    if (!builtinConfig.modelsApiEndpoint) {
      throw new Error(`Provider ${providerId} does not support dynamic model fetching`)
    }

    try {
      const headers: Record<string, string> = {
        ...(builtinConfig.modelsApiHeaders || builtinConfig.headers),
      }

      const response = await axios.get(builtinConfig.modelsApiEndpoint, {
        headers,
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      })

      if (response.status !== 200) {
        throw new Error(`Failed to fetch models: HTTP ${response.status}`)
      }

      const models = response.data.data || []
      const supportedModels: string[] = []
      const modelMappings: Record<string, string> = {}

      for (const model of models) {
        if (model.name && model.id) {
          supportedModels.push(model.name)
          modelMappings[model.name] = model.id
        }
      }

      return { supportedModels, modelMappings }
    } catch (error) {
      console.error(`[ProviderChecker] Failed to fetch models for ${providerId}:`, error)
      throw error
    }
  }
}

export default ProviderChecker
