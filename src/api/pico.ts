export interface PicoStatus {
  connected: boolean
  state: 'idle' | 'warmup' | 'reading' | 'done' | null
  count: number
  total: number
  revision: number
  error: string | null
}

function isPicoState(value: unknown): value is PicoStatus['state'] {
  return value === null || value === 'idle' || value === 'warmup' || value === 'reading' || value === 'done'
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init)
  let data: unknown
  try {
    data = await response.json()
  } catch {
    throw new Error(response.ok ? 'The API returned an invalid response.' : `API request failed (${response.status}).`)
  }
  if (!response.ok) {
    if (typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string') throw new Error(data.error)
    throw new Error(`API request failed (${response.status}).`)
  }
  return data
}

export async function getPicoStatus(): Promise<PicoStatus> {
  const data = await request('/api/pico/status')
  if (typeof data !== 'object' || data === null || !('connected' in data) || typeof data.connected !== 'boolean' ||
      !('state' in data) || !isPicoState(data.state) ||
      !('count' in data) || typeof data.count !== 'number' || !('total' in data) || typeof data.total !== 'number' ||
      !('revision' in data) || typeof data.revision !== 'number' ||
      !('error' in data) || (data.error !== null && typeof data.error !== 'string')) {
    throw new Error('The API returned an invalid Pico status.')
  }
  return { connected: data.connected, state: data.state, count: data.count, total: data.total, revision: data.revision, error: data.error }
}

export async function startPicoReading(): Promise<void> {
  await request('/api/pico/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
}
