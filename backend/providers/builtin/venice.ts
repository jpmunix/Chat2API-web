/**
 * Venice AI Web Provider Configuration
 * Uses Venice web interface via outerface.venice.ai API
 */

import { BuiltinProviderConfig, CredentialField } from '../../store/types'

const credentialFields: CredentialField[] = [
  {
    name: 'jwt',
    label: 'JWT Token (Authorization Bearer)',
    type: 'password',
    required: true,
    placeholder: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9... (from Authorization header)',
    helpText: 'Copy from browser DevTools → Network → outerface.venice.ai → Request Headers → Authorization'
  },
  {
    name: 'cookies',
    label: 'Session Cookies',
    type: 'textarea',
    required: true,
    placeholder: 'venice-locale=es; __Secure-next-auth.session-token=...; etc.',
    helpText: 'Copy ALL cookies from browser DevTools → Application → Cookies → venice.ai (or outerface.venice.ai)'
  },
  {
    name: 'distinctId',
    label: 'x-venice-distinct-id',
    type: 'text',
    required: true,
    placeholder: '7c9a7207-f35b-4f71-a30a-1f13ca798957',
    helpText: 'Copy from browser DevTools → Network → outerface.venice.ai → Request Headers → x-venice-distinct-id'
  },
  {
    name: 'locale',
    label: 'x-venice-locale',
    type: 'text',
    required: false,
    placeholder: 'es',
    helpText: 'Your locale (es, en, etc.) - from x-venice-locale header'
  },
  {
    name: 'middlefaceVersion',
    label: 'x-venice-middleface-version',
    type: 'text',
    required: false,
    placeholder: '0.1.890',
    helpText: 'From x-venice-middleface-version header (check in DevTools)'
  },
  {
    name: 'version',
    label: 'x-venice-version',
    type: 'text',
    required: false,
    placeholder: 'interface@20260715.003824+7020d35',
    helpText: 'From x-venice-version header (check in DevTools)'
  },
]

export const veniceProvider: BuiltinProviderConfig = {
  id: 'venice',
  name: 'Venice AI (Web)',
  type: 'builtin',
  authType: 'cookie',
  apiEndpoint: 'https://outerface.venice.ai/api',
  chatPath: '/inference/chat',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'Origin': 'https://venice.ai',
    'Referer': 'https://venice.ai/',
  },
  enabled: true,
  description: 'Venice AI via web interface ($18/mo unlimited). Requires JWT + cookies from browser session.',
  supportedModels: [
    'GLM 5.2',
    'DeepSeek V4 Flash',
    'Qwen3.6 35B A3B Uncensored',
    'GPT OSS 120B',
  ],
  modelMappings: {
    'GLM 5.2': 'e2ee-glm-5-2-p',
    'DeepSeek V4 Flash': 'deepseek-v4-flash',
    'Qwen3.6 35B A3B Uncensored': 'e2ee-qwen3-6-35b-a3b-uncensored-p',
    'GPT OSS 120B': 'e2ee-gpt-oss-120b-p',
  },
  credentialFields,
  tokenCheckEndpoint: '/auth/status',
  tokenCheckMethod: 'GET',
}

export default veniceProvider
