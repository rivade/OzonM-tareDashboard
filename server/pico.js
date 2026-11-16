const POLL_MS = 2000
const REQUEST_TIMEOUT_MS = 4000

export function createPicoService({ url, saveReading, loadCursor = async () => 0, fetchImpl = fetch, pollMs = POLL_MS }) {
  const base = new URL(url)
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('PICO_URL must be an HTTP(S) URL without credentials or query parameters.')
  }
  const baseUrl = base.toString().replace(/\/$/, '')
  let timer
  let stopped = true
  let busy = false
  let starting = false
  let cursor = 0
  let boot = null
  let lastSeen = 0
  let revision = 0
  let current = { connected: false, state: null, count: 0, total: 0, revision, error: 'Waiting for Pico.' }
  let lossWarning = null

  async function request(path, options = {}) {
    const response = await fetchImpl(baseUrl + path, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`Pico returned HTTP ${response.status}.`)
    return response.json()
  }

  function validate(data, since) {
    if (!data || data.protocol !== 1 || typeof data.boot !== 'string' || !/^[0-9a-f]{16}$/.test(data.boot) ||
        !Number.isSafeInteger(data.seen) || data.seen < 0 || !Number.isSafeInteger(data.first) ||
        data.first < 1 || data.first > data.seen + 1 || !Array.isArray(data.readings) ||
        !['idle', 'warmup', 'reading', 'done'].includes(data.state) ||
        !Number.isInteger(data.count) || !Number.isInteger(data.total) || data.total < 1 ||
        data.count < 0 || data.count > data.total) {
      throw new Error('Unexpected Pico response. Install the current Pico firmware.')
    }
    const start = Math.max(since + 1, data.first)
    if (data.readings.length !== Math.max(0, data.seen - start + 1)) {
      throw new Error('Incomplete Pico readings response.')
    }
  }

  async function poll() {
    if (stopped) return
    if (busy || starting) { timer = setTimeout(poll, pollMs); return }
    busy = true
    let gotPico = false
    try {
      let data = await request(`/readings?since=${cursor}`)
      validate(data, cursor)
      gotPico = true
      if (boot !== data.boot) {
        if (boot !== null && lastSeen > cursor) {
          lossWarning = `Pico restarted before readings ${cursor + 1} to ${lastSeen} could be saved. Restart the API to acknowledge.`
          console.error(lossWarning)
        }
        const newBoot = data.boot
        const recovered = await loadCursor(newBoot)
        if (!Number.isSafeInteger(recovered) || recovered < 0 || recovered > data.seen) {
          throw new Error('Invalid stored Pico cursor.')
        }
        cursor = recovered
        gotPico = false
        data = await request(`/readings?since=${cursor}`)
        validate(data, cursor)
        gotPico = true
        if (data.boot !== newBoot) throw new Error('Pico restarted during synchronization; retrying.')
      }
      boot = data.boot
      lastSeen = data.seen
      current = { connected: true, state: data.state, count: data.count, total: data.total, revision, error: lossWarning }
      if (data.first > cursor + 1) {
        lossWarning = `Pico discarded readings ${cursor + 1} to ${data.first - 1} before they could be saved. Restart the API to acknowledge.`
        console.error(lossWarning)
        cursor = data.first - 1
      }
      for (const reading of data.readings) {
        await saveReading(reading, `${boot}:${cursor + 1}`)
        cursor += 1
        current.revision = ++revision
      }
      current.error = lossWarning
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A storage error is distinct from losing contact with the Pico.
      if (gotPico) {
        current = { ...current, connected: true, error: `Could not synchronize Pico readings: ${message}` }
      } else {
        current = { ...current, connected: false, error: `Pico unavailable: ${message}` }
      }
      console.error(current.error)
    } finally {
      busy = false
      if (!stopped) timer = setTimeout(poll, pollMs)
    }
  }

  async function startReading() {
    if (starting) throw new Error('A start request is already in progress.')
    starting = true
    try {
      while (busy) await new Promise((resolve) => setTimeout(resolve, 50))
      if (!current.connected) throw new Error('Pico is not connected.')
      if (current.error) throw new Error(current.error)
      if (current.state === 'warmup' || current.state === 'reading') throw new Error('A reading is already in progress.')
      const result = await request('/start', { method: 'POST' })
      if (!result || result.started !== true) throw new Error('Invalid start response from Pico.')
      current = { ...current, state: 'warmup', count: 0 }
    } finally {
      starting = false
    }
  }

  return {
    start() { if (stopped) { stopped = false; void poll() } },
    stop() { stopped = true; clearTimeout(timer) },
    status() { return { ...current } },
    startReading,
  }
}
