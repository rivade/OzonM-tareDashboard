<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { getPicoStatus, startPicoReading, type PicoStatus } from '../api/pico'

const emit = defineEmits<{ readingsChanged: [] }>()
const status = ref<PicoStatus | null>(null)
const error = ref('')
const actionError = ref('')
const starting = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
let stopped = false
let previousCount: number | null = null
let previousState: string | null = null
let previousRevision: number | null = null

const busy = computed(() => status.value?.state === 'warmup' || status.value?.state === 'reading')
const label = computed(() => {
  if (!status.value) return error.value ? 'API unavailable' : 'Checking connection...'
  if (!status.value.connected) return 'Pico disconnected'
  if (status.value.state === 'warmup') return 'Warming up sensor...'
  if (status.value.state === 'reading') return `Reading ${status.value.count} / ${status.value.total}`
  if (status.value.state === 'done') return `Finished: ${status.value.count} / ${status.value.total} readings`
  return 'Pico connected - Ready to read'
})

async function poll() {
  try {
    const next = await getPicoStatus()
    if (previousCount !== null && (next.count !== previousCount || next.revision !== previousRevision || (next.state === 'done' && previousState !== 'done'))) {
      emit('readingsChanged')
    }
    previousRevision = next.revision
    previousCount = next.count
    previousState = next.state
    status.value = next
    error.value = next.error ?? ''
  } catch (reason) {
    status.value = null
    error.value = reason instanceof Error ? reason.message : 'Could not reach the API.'
  } finally {
    if (!stopped) timer = setTimeout(poll, 2500)
  }
}

async function start() {
  starting.value = true
  actionError.value = ''
  try {
    await startPicoReading()
    if (status.value) status.value = { ...status.value, state: 'warmup', count: 0 }
  } catch (reason) {
    actionError.value = reason instanceof Error ? reason.message : 'Could not start reading.'
  } finally {
    starting.value = false
  }
}

onMounted(() => { void poll() })
onUnmounted(() => { stopped = true; clearTimeout(timer) })
</script>

<template>
  <section class="pico-control" aria-label="Pico sensor control">
    <div>
      <div class="pico-status" role="status">
        <span class="dot" :class="{ online: status?.connected }" aria-hidden="true"></span>
        {{ label }}
      </div>
      <p v-if="error || actionError" class="pico-error" role="alert">{{ actionError || error }}</p>
      <p v-else class="pico-hint">{{ busy ? 'Readings will appear automatically.' : 'Take 30 readings over approximately one minute.' }}</p>
    </div>
    <button type="button" :disabled="!status?.connected || !!status.error || busy || starting" @click="start">
      {{ starting ? 'Starting...' : busy ? 'Reading in progress' : 'Start reading' }}
    </button>
  </section>
</template>

<style scoped>
.pico-control { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 20px; margin-bottom: 20px; border: 1px solid #d9e2d7; border-radius: 10px; background: #fff; }
.pico-status { display: flex; align-items: center; gap: 9px; color: #365d40; font-weight: 700; font-size: 14px; }
.dot { width: 9px; height: 9px; flex: none; border-radius: 50%; background: #a4aaa5; }
.dot.online { background: #4b9b62; box-shadow: 0 0 0 3px #e0efe1; }
.pico-hint, .pico-error { margin: 8px 0 0 18px; font-size: 12px; color: #728076; }
.pico-error { color: #a63f35; }
button { min-height: 40px; padding: 0 16px; border: 0; border-radius: 7px; color: white; background: #33764c; font-weight: 600; cursor: pointer; white-space: nowrap; }
button:disabled { background: #a8b7aa; cursor: not-allowed; }
@media (max-width: 600px) { .pico-control { align-items: stretch; flex-direction: column; } }
</style>
