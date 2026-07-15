/**
 * Venice AI Web Adapter
 * Implements Venice.ai web interface API protocol (outerface.venice.ai)
 * Translates OpenAI-compatible requests to Venice's internal format
 */

import axios, { AxiosResponse } from 'axios'
import { Readable, PassThrough } from 'stream'
import { Account, Provider } from '../../store/types'
import type { ChatCompletionRequest, ForwardResult, VeniceStreamEvent } from '../types'
import { isJWTExpired, refreshVeniceJWT, invalidateCache } from '../../providers/venice-refresh'
import { storeManager } from '../../store/store'

const VENICE_API_BASE = 'https://outerface.venice.ai/api'
const VENICE_CHAT_ENDPOINT = `${VENICE_API_BASE}/inference/chat`

// Browser fingerprint profiles for Venice
interface BrowserProfile {
  'User-Agent': string
  'Sec-Ch-Ua': string
  'Sec-Ch-Ua-Platform': string
  'Accept-Language': string
}

const BROWSER_PROFILES: BrowserProfile[] = [
  // Linux Chrome
  {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    'Sec-Ch-Ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
    'Sec-Ch-Ua-Platform': '"Linux"',
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  },
  // macOS Chrome
  {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    'Sec-Ch-Ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
    'Sec-Ch-Ua-Platform': '"macOS"',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  // Windows Chrome
  {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    'Sec-Ch-Ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Accept-Language': 'en-US,en;q=0.9',
  },
]

interface VeniceCredentials {
  jwt: string
  cookies: string
  distinctId: string
  locale: string
  middlefaceVersion: string
  version: string
}

function parseVeniceCredentials(credentials: Record<string, string>): VeniceCredentials {
  // Support both single-field and multi-field credential formats
  const jwt = credentials.jwt || credentials.token || credentials.authorization || ''
  const cookies = credentials.cookies || credentials.cookie || ''
  const distinctId = credentials.distinctId || credentials['x-venice-distinct-id'] || ''
  const locale = credentials.locale || credentials['x-venice-locale'] || 'en'
  const middlefaceVersion = credentials.middlefaceVersion || credentials['x-venice-middleface-version'] || '0.1.890'
  const version = credentials.version || credentials['x-venice-version'] || 'interface@20260715.003824+7020d35'

  return { jwt, cookies, distinctId, locale, middlefaceVersion, version }
}

function buildCookieHeader(cookies: string): string {
  return cookies
}

function generateRequestId(): string {
  // Venice uses format like "XGzEx8f" or "1HKhUSd" - 7-8 alphanumeric chars
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

function extractUserIdFromJWT(jwt: string): string {
  try {
    const payload = jwt.split('.')[1]
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString())
    return decoded.sub || `user_${Date.now()}`
  } catch {
    return `user_${Date.now()}`
  }
}

function extractSessionIdFromJWT(jwt: string): string {
  try {
    const payload = jwt.split('.')[1]
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString())
    return decoded.sid || `sess_${Date.now()}`
  } catch {
    return `sess_${Date.now()}`
  }
}

function messagesToVenicePrompt(messages: ChatCompletionRequest['messages']): { prompt: Array<{ role: string; content: string }>; systemPrompt: string } {
  let systemPrompt = ''
  const prompt: Array<{ role: string; content: string }> = []

  for (const msg of messages) {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
    
    if (msg.role === 'system') {
      systemPrompt = content
    } else if (msg.role === 'user' || msg.role === 'assistant') {
      prompt.push({ role: msg.role, content })
    }
  }

  return { prompt, systemPrompt }
}

function mapOpenAIModelToVenice(model: string): string {
  // Map common model names to Venice internal modelIds
  const modelMap: Record<string, string> = {
    'venice-uncensored': 'e2ee-llama-3.3-70b',
    'dolphin-2.9.2-qwen2-72b': 'e2ee-dolphin-2.9.2-qwen2-72b',
    'deepseek-r1': 'e2ee-deepseek-r1',
    'mistral-small-24b': 'e2ee-mistral-small-24b',
    'e2ee-llama-3.3-70b': 'e2ee-llama-3.3-70b',
    'e2ee-llama-3.1-405b': 'e2ee-llama-3.1-405b',
    'e2ee-qwen3.6-72b': 'e2ee-qwen3.6-72b',
    'e2ee-qwen3.6-35b-a3b': 'e2ee-qwen3.6-35b-a3b',
    'e2ee-qwen3-30b-a3b-p': 'e2ee-qwen3-30b-a3b-p',
    'e2ee-qwen3-vl-30b-a3b-p': 'e2ee-qwen3-vl-30b-a3b-p',
    'e2ee-glm-5-1': 'e2ee-glm-5-1',
    'e2ee-glm-5-2-p': 'e2ee-glm-5-2-p',
    'e2ee-qwen3-6-35b-a3b': 'e2ee-qwen3-6-35b-a3b',
    'e2ee-qwen3-6-27b': 'e2ee-qwen3-6-27b',
    'e2ee-gemma-4-31b': 'e2ee-gemma-4-31b',
    'e2ee-deepseek-v4-flash': 'e2ee-deepseek-v4-flash',
  }

  return modelMap[model] || model
}

export class VeniceAdapter {
  private provider: Provider
  private account: Account
  private credentials: VeniceCredentials
  private browserProfile: BrowserProfile
  private userId: string
  private sessionId: string

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
    this.credentials = parseVeniceCredentials(account.credentials)
    this.browserProfile = BROWSER_PROFILES[Math.floor(Math.random() * BROWSER_PROFILES.length)]
    this.userId = extractUserIdFromJWT(this.credentials.jwt)
    this.sessionId = extractSessionIdFromJWT(this.credentials.jwt)
  }

  private getHeaders(): Record<string, string> {
    const timestamp = Date.now()
    
    return {
      'accept': 'text/event-stream',
      'accept-language': this.browserProfile['Accept-Language'],
      'authorization': `Bearer ${this.credentials.jwt}`,
      'cache-control': 'no-cache',
      'content-type': 'application/json',
      'origin': 'https://venice.ai',
      'pragma': 'no-cache',
      'referer': 'https://venice.ai/',
      'sec-ch-ua': this.browserProfile['Sec-Ch-Ua'],
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': this.browserProfile['Sec-Ch-Ua-Platform'],
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-site',
      'user-agent': this.browserProfile['User-Agent'],
      'x-venice-distinct-id': this.credentials.distinctId,
      'x-venice-locale': this.credentials.locale,
      'x-venice-middleface-version': this.credentials.middlefaceVersion,
      'x-venice-request-timestamp-ms': String(timestamp),
      'x-venice-version': this.credentials.version,
      'cookie': buildCookieHeader(this.credentials.cookies),
    }
  }

  private buildVeniceRequest(request: ChatCompletionRequest): any {
    const { prompt, systemPrompt } = messagesToVenicePrompt(request.messages)
    const modelId = mapOpenAIModelToVenice(request.model)
    const requestId = generateRequestId()

    // Determine if reasoning is requested
    const reasoning = request.reasoning_effort ? true : false

    return {
      clientProcessingTime: 2,
      conversationType: 'text',
      enableLargeContextChat: true,
      enableStructuredSystemPrompt: true,
      includeVeniceSystemPrompt: true,
      isCharacter: false,
      modelId,
      prompt,
      reasoning,
      requestId,
      simpleMode: false,
      systemPrompt,
      temperature: request.temperature ?? 0.6,
      topP: request.top_p ?? 0.95,
      userId: this.userId,
      webEnabled: true,
      webScrapeEnabled: false,
      xSearchEnabled: false,
    }
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{ response: AxiosResponse; stream: Readable }> {
    const veniceRequest = this.buildVeniceRequest(request)
    const accountId = this.account.id

    // ═══════════════════════════════════════════════════════════════
    // PRE-REQUEST JWT REFRESH
    // Clerk JWTs expire in ~60 seconds. Check if expired or about
    // to expire (<10s), and refresh before sending to Venice.
    // ═══════════════════════════════════════════════════════════════
    if (isJWTExpired(this.credentials.jwt, 10)) {
      console.log('[Venice-Adapter] JWT expired or expiring soon, refreshing...')
      const newJwt = await refreshVeniceJWT(accountId, this.credentials.jwt, this.credentials.cookies)
      
      if (newJwt) {
        // Update in-memory credentials
        this.credentials.jwt = newJwt
        this.userId = extractUserIdFromJWT(newJwt)
        this.sessionId = extractSessionIdFromJWT(newJwt)
        
        // Persist to store so future requests also get fresh JWT
        const updatedCredentials = { ...this.account.credentials, jwt: newJwt }
        storeManager.updateAccount(accountId, { credentials: updatedCredentials })
        
        console.log('[Venice-Adapter] ✅ JWT refreshed before chat request, new exp:', (() => {
          try {
            const parts = newJwt.split('.')
            let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
            const padding = payload.length % 4
            if (padding > 0) payload += '='.repeat(4 - padding)
            const parsed = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
            return parsed.exp ? new Date(parsed.exp * 1000).toISOString() : 'unknown'
          } catch { return 'unknown' }
        })())
      } else {
        console.error('[Venice-Adapter] ❌ JWT refresh failed! Chat will fail with 401.')
        // Invalidate cache so next request doesn't reuse bad cache
        invalidateCache(accountId)
      }
    }

    // Log request details
    let jwtPreview = this.credentials.jwt.slice(0, 50) + '...'
    console.log('[Venice-Adapter] Request:', {
      modelId: veniceRequest.modelId,
      promptLength: veniceRequest.prompt.length,
      temperature: veniceRequest.temperature,
      jwtPreview,
      cookiesLength: this.credentials.cookies.length,
    })

    const passThrough = new PassThrough()
    let response: AxiosResponse | null = null

    try {
      const axiosResponse = await axios.post(VENICE_CHAT_ENDPOINT, veniceRequest, {
        headers: this.getHeaders(),
        responseType: 'stream',
        timeout: 120000,
        validateStatus: () => true,
      })

      response = axiosResponse

      console.log('[Venice-Adapter] Response HTTP status:', axiosResponse.status)
      console.log('[Venice-Adapter] Response content-type:', axiosResponse.headers['content-type'])

      if (axiosResponse.status >= 400) {
        let errorBody = ''
        for await (const chunk of axiosResponse.data) {
          errorBody += chunk.toString()
        }
        console.error(`[Venice-Adapter] Error response body:`, errorBody.slice(0, 500))
        throw new Error(`Venice API error ${axiosResponse.status}: ${errorBody}`)
      }

      // Note: Venice sometimes incorrectly returns Content-Type: text/html 
      // even when correctly streaming NDJSON data. We cannot rely on the content-type header.
      const contentType = axiosResponse.headers['content-type'] || ''
      if (contentType.includes('text/html') && axiosResponse.status >= 400) {
        throw new Error(`Venice returned HTML error page. Content-Type: ${contentType}`)
      }

      // Pipe the Venice SSE stream through our handler
      axiosResponse.data.pipe(passThrough)

    } catch (error) {
      if (axios.isAxiosError(error) && error.response) {
        let errorBody = ''
        for await (const chunk of error.response.data) {
          errorBody += chunk.toString()
        }
        console.error(`[Venice-Adapter] Catch error body:`, errorBody.slice(0, 500))
        throw new Error(`Venice API error ${error.response.status}: ${errorBody}`)
      }
      throw error
    }

    return { response: response!, stream: passThrough }
  }

  static isVeniceProvider(provider: Provider): boolean {
    return provider.id === 'venice' || provider.apiEndpoint.includes('venice.ai')
  }

  static clearSessionCache(accountId: string): void {
    // No persistent session cache for Venice
  }
}

/**
 * Venice Stream Handler
 * Parses Venice's SSE format (kind: meta/content) and converts to OpenAI SSE format
 */
export class VeniceStreamHandler {
  private buffer = ''
  private isFirstChunk = true
  private completionId: string = ''
  private modelId: string = ''
  private hasSentReasoning = false

  constructor(private model: string) {
    this.completionId = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  }

  /**
   * Process a chunk of Venice NDJSON or SSE data and yield OpenAI-compatible chunks
   */
  processChunk(chunk: string): Array<{ type: 'content' | 'reasoning' | 'done' | 'error'; data?: any }> {
    this.buffer += chunk
    const results: Array<{ type: 'content' | 'reasoning' | 'done' | 'error'; data?: any }> = []

    // Split by newline (NDJSON separator)
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() || '' // Keep the last incomplete line in the buffer

    for (const line of lines) {
      const trimmedLine = line.trim()
      if (!trimmedLine) continue

      let eventData = trimmedLine

      // Support fallback if they switch to proper SSE format later
      if (trimmedLine.startsWith('data: ')) {
        eventData = trimmedLine.slice(6).trim()
      }
      
      // Ignore standard SSE comments or event type lines
      if (eventData === '[DONE]' || trimmedLine.startsWith('event: ') || trimmedLine.startsWith(':')) {
        continue
      }

      try {
        const parsed = JSON.parse(eventData)
        // Log the raw JSON that Venice gives us to see tool calls and content
        console.log(`[Venice-Stream] Event (${parsed.kind}):`, JSON.stringify(parsed).slice(0, 300))
        
        const processed = this.processVeniceEvent(parsed)
        if (processed) {
          results.push(...processed)
        }
      } catch (e) {
        // Not JSON, ignore or log if it looks like an error
        if (eventData.includes('<html')) {
          console.error('[Venice] Stream contains HTML error page!', eventData.slice(0, 100))
        }
      }
    }

    return results
  }

  private processVeniceEvent(event: VeniceStreamEvent): Array<{ type: 'content' | 'reasoning' | 'done' | 'error'; data?: any }> {
    const results: Array<{ type: 'content' | 'reasoning' | 'done' | 'error'; data?: any }> = []

    switch (event.kind) {
      case 'meta':
        if (event.servingModelId) {
          this.modelId = event.servingModelId
        }
        if (event.completion_id) {
          this.completionId = event.completion_id
        }
        break

      case 'content':
        if (event.reasoning_content) {
          // Reasoning token
          if (!this.hasSentReasoning) {
            // Send reasoning start marker if needed
            this.hasSentReasoning = true
          }
          results.push({
            type: 'reasoning',
            data: {
              id: this.completionId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: this.model,
              choices: [{
                index: 0,
                delta: {
                  reasoning_content: event.reasoning_content,
                },
                finish_reason: null,
              }],
            },
          })
        } else if (event.content) {
          // Regular content token
          results.push({
            type: 'content',
            data: {
              id: this.completionId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: this.model,
              choices: [{
                index: 0,
                delta: {
                  content: event.content,
                },
                finish_reason: null,
              }],
            },
          })
        }
        break

      default:
        console.warn('[Venice] Unknown event kind:', event.kind)
    }

    return results
  }

  /**
   * Process any remaining buffer and send final chunk
   */
  finalize(): Array<{ type: 'content' | 'reasoning' | 'done' | 'error'; data?: any }> {
    const results: Array<{ type: 'content' | 'reasoning' | 'done' | 'error'; data?: any }> = []

    // Process any remaining buffer
    if (this.buffer.trim()) {
      const lines = this.buffer.split('\n')
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(line.slice(6))
            const processed = this.processVeniceEvent(parsed)
            if (processed) {
              results.push(...processed)
            }
          } catch {}
        }
      }
    }

    // Send final done chunk
    results.push({
      type: 'done',
      data: {
        id: this.completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: this.model,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: 'stop',
        }],
      },
    })

    return results
  }
}

export const veniceAdapter = {
  VeniceAdapter,
  VeniceStreamHandler,
}
