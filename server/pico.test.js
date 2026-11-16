import test from 'node:test'
import assert from 'node:assert/strict'
import { createPicoService } from './pico.js'

const waitFor = async (condition) => {
  const deadline = Date.now() + 1500
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function fakePico() {
  let boot = '0000000000000001'
  let state = 'idle'
  let samples = []
  let online = true
  let invalid = false
  const fetchImpl = async (url, options) => {
    if (!online) throw new Error('offline')
    const parsed = new URL(url)
    if (parsed.pathname === '/start') {
      if (state === 'reading' || state === 'warmup') return new Response('{}', { status: 409 })
      state = 'reading'
      return Response.json({ started: true })
    }
    if (invalid) return Response.json({ invalid: true })
    const since = Number(parsed.searchParams.get('since'))
    return Response.json({ protocol: 1, boot, seen: samples.length, first: 1, state,
      count: samples.length, total: 30, readings: samples.slice(since) })
  }
  return { fetchImpl, add(value) { samples.push({ value, temperature: 20, humidity: 50 }) },
    reset() { boot = '0000000000000002'; samples = []; state = 'idle' },
    setOnline(value) { online = value }, setInvalid(value) { invalid = value } }
}

test('connection, start, automatic upload, retries and reboot', async (t) => {
  const pico = fakePico()
  const saved = new Map()
  let failures = 1
  const service = createPicoService({ url: 'http://pico', fetchImpl: pico.fetchImpl, pollMs: 20,
    saveReading: async (reading, id) => {
      if (failures-- > 0) throw new Error('database unavailable')
      saved.set(id, reading)
    } })
  t.after(() => service.stop())
  await assert.rejects(service.startReading(), /not connected/)
  service.start()
  await waitFor(() => service.status().connected)
  await service.startReading()
  await assert.rejects(service.startReading(), /already in progress/)
  pico.add(100)
  await waitFor(() => service.status().error?.includes('database unavailable'))
  assert.equal(service.status().connected, true)
  await waitFor(() => saved.has('0000000000000001:1'))
  assert.equal(service.status().revision, 1)
  pico.setOnline(false)
  await waitFor(() => !service.status().connected)
  pico.reset()
  pico.add(200)
  pico.setOnline(true)
  await waitFor(() => saved.has('0000000000000002:1'))
  assert.equal(saved.get('0000000000000002:1').value, 200)
  assert.equal(service.status().connected, true)
})

test('rejects incompatible firmware and exposes disconnect', async (t) => {
  const pico = fakePico()
  pico.setInvalid(true)
  const service = createPicoService({ url: 'http://pico', fetchImpl: pico.fetchImpl, pollMs: 20, saveReading: async () => {} })
  t.after(() => service.stop())
  service.start()
  await waitFor(() => service.status().error?.includes('firmware'))
  assert.equal(service.status().connected, false)
  pico.setInvalid(false)
  await waitFor(() => service.status().connected)
})


test('resumes saved cursor without replaying on API restart', async (t) => {
  const pico = fakePico()
  pico.add(100)
  pico.add(200)
  const saved = []
  const service = createPicoService({ url: 'http://pico', fetchImpl: pico.fetchImpl, pollMs: 20,
    loadCursor: async () => 1, saveReading: async (_reading, id) => { saved.push(id) } })
  t.after(() => service.stop())
  service.start()
  await waitFor(() => saved.length === 1)
  assert.deepEqual(saved, ['0000000000000001:2'])
  assert.equal(service.status().error, null)
})


test('reports readings lost when the Pico buffer overflows', async (t) => {
  const fetchImpl = async () => Response.json({ protocol: 1, boot: '0000000000000001', seen: 3, first: 3,
    state: 'done', count: 3, total: 30, readings: [{ value: 300, temperature: null, humidity: null }] })
  const saved = []
  const service = createPicoService({ url: 'http://pico', fetchImpl, pollMs: 10000,
    saveReading: async (_reading, id) => saved.push(id) })
  t.after(() => service.stop())
  service.start()
  await waitFor(() => saved.length === 1)
  assert.match(service.status().error, /discarded readings 1 to 2/)
  assert.deepEqual(saved, ['0000000000000001:3'])
  await assert.rejects(service.startReading(), /discarded readings/)
})
