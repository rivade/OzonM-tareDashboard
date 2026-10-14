<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  getOzoneReadings,
  getReadingHistory,
  type OzoneReadings,
  type OzoneRecordSummary,
  AIR_LEVEL_LABEL,
  MODERATE_VOLTS,
  POOR_VOLTS,
  SENSOR_MAX_VOLTS,
  airLevel,
  toVolts,
  SAMPLES_PER_WINDOW,
  SAMPLE_INTERVAL_S,
} from './api/ozone'
import ClimateCard from './components/ClimateCard.vue'

const readings = ref<OzoneReadings | null>(null)
const history = ref<OzoneRecordSummary[]>([])
const selectedId = ref('')
const loading = ref(true)
const errorMessage = ref('')
const refreshedAt = ref<Date | null>(null)

const measured = computed(() =>
  (readings.value?.samples ?? []).flatMap((reading) =>
    reading.value === null ? [] : [{ sample: reading.sample, value: toVolts(reading.value) }],
  ),
)

const temperatures = computed(() => (readings.value?.samples ?? []).map((reading) => reading.temperature))
const humidities = computed(() => (readings.value?.samples ?? []).map((reading) => reading.humidity))

const average = computed(() => {
  if (!measured.value.length) return null
  const total = measured.value.reduce((sum, reading) => sum + reading.value, 0)
  return total / measured.value.length
})

const peak = computed(() => {
  if (!measured.value.length) return null
  return measured.value.reduce((highest, reading) =>
    reading.value > highest.value ? reading : highest,
  )
})

const formatValue = (volts: number) => volts.toFixed(2)
const barHeight = (volts: number) => `${(volts / SENSOR_MAX_VOLTS) * 100}%`
const topPercent = (volts: number) => `${(1 - volts / SENSOR_MAX_VOLTS) * 100}%`

const timestampLabel = computed(() => {
  if (!readings.value) return ''
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(readings.value.timestamp))
})

const selectedIndex = computed(() =>
  history.value.findIndex((record) => record.id === selectedId.value),
)
const isLatest = computed(() => selectedIndex.value === 0)
const hasOlder = computed(
  () => selectedIndex.value >= 0 && selectedIndex.value < history.value.length - 1,
)

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const formatTimestamp = (timestamp: string) => dateFormat.format(new Date(timestamp))

const refreshedLabel = computed(() => {
  if (!refreshedAt.value) return ''
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(refreshedAt.value)
})

async function loadReading(id?: string) {
  loading.value = true
  errorMessage.value = ''

  try {
    readings.value = await getOzoneReadings(id)
    selectedId.value = readings.value.id
    refreshedAt.value = new Date()
  } catch (error) {
    errorMessage.value =
      error instanceof Error ? error.message : 'Could not load sensor readings.'
  } finally {
    loading.value = false
  }
}

async function refreshReadings() {
  try {
    history.value = await getReadingHistory()
  } catch (error) {
    errorMessage.value =
      error instanceof Error ? error.message : 'Could not load reading history.'
    return
  }
  await loadReading(history.value[0]?.id)
}

function selectRecord(index: number) {
  const record = history.value[index]
  if (record) void loadReading(record.id)
}

onMounted(() => {
  void refreshReadings()
})

</script>

<template>
  <main class="dashboard">
    <header class="topbar">
      <a class="brand" href="#" aria-label="Air quality dashboard home">
        <span class="brand-mark" aria-hidden="true">AQ</span>
        <span>FIELD NOTES <span class="brand-divider">/</span> AIR QUALITY</span>
      </a>
      <div class="connection">
        <span class="connection-dot" :class="{ 'is-online': readings && !errorMessage }"></span>
        {{ errorMessage ? 'Needs attention' : readings ? 'Connected' : 'Connecting' }}
      </div>
    </header>

    <section class="intro" aria-labelledby="page-title">
      <p class="eyebrow">MONITORING OVERVIEW <span>·</span> {{ SAMPLES_PER_WINDOW }} SAMPLES · EVERY {{ SAMPLE_INTERVAL_S }} SECONDS</p>
      <div class="intro-row">
        <div>
          <h1 id="page-title">Air quality</h1>
          <p class="intro-copy">MQ135 sensor readings for the selected 1-minute window.</p>
        </div>
        <button class="refresh-button" type="button" :disabled="loading" @click="refreshReadings">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M16 8a6.2 6.2 0 0 0-10.6-3L4 6.5M4 3v3.5h3.5M4 12a6.2 6.2 0 0 0 10.6 3L16 13.5M16 17v-3.5h-3.5" />
          </svg>
          {{ loading ? 'Loading…' : 'Refresh data' }}
        </button>
      </div>
    </section>

    <section v-if="history.length" class="history-bar" aria-label="Choose a reading">
      <button
        type="button"
        class="history-step"
        :disabled="loading || !hasOlder"
        aria-label="Older reading"
        @click="selectRecord(selectedIndex + 1)"
      >
        ‹ Older
      </button>
      <label class="history-select">
        <span class="card-label">RECORD</span>
        <select
          :value="selectedId"
          :disabled="loading"
          @change="loadReading(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="(record, index) in history" :key="record.id" :value="record.id">
            {{ formatTimestamp(record.timestamp) }}{{ index === 0 ? ' (latest)' : '' }}
          </option>
        </select>
      </label>
      <button
        type="button"
        class="history-step"
        :disabled="loading || selectedIndex <= 0"
        aria-label="Newer reading"
        @click="selectRecord(selectedIndex - 1)"
      >
        Newer ›
      </button>
    </section>

    <section class="summary-grid" aria-label="Sensor summary">
      <article class="summary-card current-card">
        <div class="card-label"><span class="label-mark"></span> WINDOW AVERAGE</div>
        <div class="metric-row">
          <span class="metric" :class="average === null ? '' : 'level-' + airLevel(average)">{{ average === null ? '—' : formatValue(average) }}</span>
          <span class="metric-unit">V</span>
        </div>
        <p class="card-footnote">
          {{ average === null ? '' : AIR_LEVEL_LABEL[airLevel(average)] + ' · ' }}{{ measured.length }} of {{ SAMPLES_PER_WINDOW }} samples taken
        </p>
      </article>

      <article class="summary-card peak-card">
        <div class="card-label"><span class="label-mark"></span> HIGHEST READING</div>
        <div class="metric-row">
          <span class="metric" :class="peak ? 'level-' + airLevel(peak.value) : ''">{{ peak ? formatValue(peak.value) : '—' }}</span>
          <span class="metric-unit">V</span>
        </div>
        <p class="card-footnote">
          {{ peak ? `Sample ${peak.sample} · ${(peak.sample - 1) * SAMPLE_INTERVAL_S} s into window` : 'No reading available' }}
        </p>
      </article>

      <article class="summary-card updated-card">
        <div class="card-label"><span class="label-mark"></span> {{ isLatest ? 'LATEST RECORD' : 'OLDER RECORD' }}</div>
        <div class="updated-date">{{ timestampLabel || '—' }}</div>
        <p class="card-footnote">
          {{ refreshedLabel ? `Fetched at ${refreshedLabel}` : 'Waiting for data' }}
        </p>
      </article>
    </section>

    <section v-if="readings" class="climate-grid" aria-label="Temperature and humidity">
      <ClimateCard label="TEMPERATURE" unit="°C" :values="temperatures" color="#d9772f" />
      <ClimateCard label="HUMIDITY" unit="%" :values="humidities" color="#3f8fc4" />
    </section>

    <section class="chart-card" aria-labelledby="chart-title">
      <div class="chart-heading">
        <div>
          <p class="eyebrow">READINGS OVER TIME</p>
          <h2 id="chart-title">Air quality (MQ135)</h2>
        </div>
        <div class="chart-unit">SENSOR VOLTAGE <span>(0–{{ SENSOR_MAX_VOLTS.toFixed(2) }} V)</span></div>
      </div>

      <div v-if="errorMessage" class="chart-message error-message" role="alert">
        <span class="message-icon" aria-hidden="true">!</span>
        <div>
          <strong>Unable to load readings</strong>
          <p>{{ errorMessage }}</p>
        </div>
      </div>
      <div v-else-if="loading && !readings" class="chart-message" role="status">
        Loading sensor readings…
      </div>
      <div v-else-if="readings" class="chart-area">
        <div class="chart-grid" aria-hidden="true">
          <span class="axis-label axis-top">{{ SENSOR_MAX_VOLTS.toFixed(2) }}</span>
          <span class="axis-label" :style="{ top: topPercent(POOR_VOLTS) }">{{ POOR_VOLTS }}</span>
          <span class="axis-label" :style="{ top: topPercent(MODERATE_VOLTS) }">{{ MODERATE_VOLTS }}</span>
          <span class="axis-label axis-bottom">0</span>
          <div class="grid-line line-top"></div>
          <div class="grid-line line-poor" :style="{ top: topPercent(POOR_VOLTS) }"></div>
          <div class="grid-line line-moderate" :style="{ top: topPercent(MODERATE_VOLTS) }"></div>
          <div class="grid-line line-bottom"></div>
        </div>
        <div
          class="bars"
          role="img"
          :aria-label="peak ? `Sensor readings for ${SAMPLES_PER_WINDOW} samples. Average ${formatValue(average ?? 0)} V; highest ${formatValue(peak.value)} V at sample ${peak.sample}.` : 'No sensor readings recorded yet.'"
        >
          <div v-for="reading in readings.samples" :key="reading.sample" class="bar-column">
            <div class="bar-value">{{ reading.value === null ? '' : formatValue(toVolts(reading.value)) }}</div>
            <div class="bar-track">
              <div
                v-if="reading.value !== null"
                class="bar"
                :class="'level-' + airLevel(toVolts(reading.value))"
                :style="{ height: barHeight(toVolts(reading.value)) }"
              ></div>
            </div>
            <span class="hour-label">{{ reading.sample }}</span>
          </div>
        </div>
        <div class="chart-legend">
          <span class="legend-swatch level-good"></span>
          <span>Good (&lt; {{ MODERATE_VOLTS }} V)</span>
          <span class="legend-swatch level-moderate"></span>
          <span>Moderate ({{ MODERATE_VOLTS }}–{{ POOR_VOLTS }} V)</span>
          <span class="legend-swatch level-poor"></span>
          <span>Poor / High Gas (≥ {{ POOR_VOLTS }} V)</span>
          <span class="legend-note">Sample 1 = start of window; one sample every {{ SAMPLE_INTERVAL_S }} s · missing samples stay empty</span>
        </div>
      </div>
      <div v-else class="chart-message">No sensor record is available yet.</div>
    </section>

    <footer class="page-footer">
      <span>AIR QUALITY DASHBOARD</span>
      <span>MQ135 sensor voltage with an air-quality level; not calibrated to ppm.</span>
    </footer>
  </main>
</template>

<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600;700&family=Manrope:wght@400;500;600;700;800&display=swap');

:root {
  font-family: 'DM Sans', sans-serif;
  color: #182720;
  background: #f4f6f1;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  font-optical-sizing: auto;
}

* {
  box-sizing: border-box;
}

body {
  min-width: 360px;
  min-height: 100vh;
  margin: 0;
  background:
    radial-gradient(ellipse at 8% 0%, rgba(213, 229, 209, 0.48), transparent 36rem),
    #f4f6f1;
}

button {
  font: inherit;
}

.dashboard {
  width: min(1160px, calc(100% - 64px));
  margin: 0 auto;
  padding: 32px 0 28px;
}

.topbar,
.brand,
.connection,
.intro-row,
.refresh-button,
.card-label,
.metric-row,
.chart-heading,
.chart-legend,
.page-footer {
  display: flex;
  align-items: center;
}

.topbar,
.intro-row,
.chart-heading,
.page-footer {
  justify-content: space-between;
}

.topbar {
  height: 42px;
  padding-bottom: 24px;
  border-bottom: 1px solid #e1e8de;
}

.brand {
  gap: 11px;
  color: #627168;
  font-family: 'DM Mono', monospace;
  font-size: 10px;
  letter-spacing: 0.1em;
}

.brand-mark {
  display: grid;
  width: 31px;
  height: 31px;
  place-items: center;
  border: 1px solid #a8c8ad;
  border-radius: 10px;
  color: #33764c;
  font-family: 'Manrope', sans-serif;
  font-size: 14px;
  font-weight: 800;
  letter-spacing: -0.08em;
}

.brand-divider {
  padding: 0 5px;
  color: #a6b4a8;
}

.connection {
  gap: 8px;
  color: #728076;
  font-size: 12px;
}

.connection-dot,
.label-mark,
.legend-swatch {
  display: inline-block;
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #c5ccc4;
}

.connection-dot.is-online {
  background: #4b9b62;
  box-shadow: 0 0 0 3px #e0efe1;
}

.intro {
  padding: 47px 0 26px;
}

.eyebrow,
.card-label,
.chart-unit,
.page-footer > :first-child {
  font-family: 'DM Mono', monospace;
  font-size: 10px;
  letter-spacing: 0.12em;
}

.eyebrow {
  margin: 0 0 12px;
  color: #78877b;
}

.eyebrow span {
  padding: 0 5px;
  color: #a9b6aa;
}

h1,
h2,
p {
  margin-top: 0;
}

h1,
h2,
.metric,
.updated-date {
  font-family: 'Manrope', sans-serif;
}

h1 {
  margin-bottom: 5px;
  font-size: clamp(30px, 4vw, 38px);
  font-weight: 700;
  letter-spacing: -0.055em;
}

.intro-copy {
  margin-bottom: 0;
  color: #7b887e;
  font-size: 14px;
}

.refresh-button {
  gap: 9px;
  min-height: 40px;
  padding: 0 15px;
  border: 1px solid #d9e2d7;
  border-radius: 7px;
  background: #fff;
  color: #365d40;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  transition: background 150ms ease, border-color 150ms ease;
}

.refresh-button:hover:not(:disabled) {
  border-color: #9cbea0;
  background: #f9fcf8;
}

.refresh-button:disabled {
  cursor: wait;
  opacity: 0.68;
}

.refresh-button svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.5;
}

.history-bar {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  margin-bottom: 13px;
}

.history-select {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  color: #78867a;
}

.history-select select,
.history-step {
  min-height: 40px;
  border: 1px solid #d9e2d7;
  border-radius: 7px;
  background: #fff;
  color: #365d40;
  font-size: 13px;
}

.history-select select {
  width: 100%;
  padding: 0 12px;
}

.history-step {
  padding: 0 14px;
  cursor: pointer;
  font-weight: 600;
  white-space: nowrap;
}

.history-step:hover:not(:disabled) {
  border-color: #9cbea0;
}

.history-step:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.summary-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1.18fr;
  gap: 13px;
}

.climate-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 13px;
  margin-top: 13px;
}

.summary-card {
  min-height: 142px;
  padding: 19px 21px 16px;
  border: 1px solid #e4e9e1;
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.83);
}

.current-card {
  background: #eef5eb;
  border-color: #dfe9dc;
}

.card-label {
  gap: 8px;
  color: #78867a;
  font-size: 9px;
}

.current-card .label-mark {
  background: #58a16b;
}

.peak-card .label-mark {
  background: #d39c49;
}

.updated-card .label-mark {
  background: #93a79a;
}

.metric-row {
  gap: 5px;
  margin: 11px 0 4px;
}

.metric {
  font-size: 38px;
  font-weight: 600;
  letter-spacing: -0.065em;
  line-height: 1;
}

.metric-unit {
  align-self: flex-end;
  padding-bottom: 4px;
  color: #87958a;
  font-family: 'DM Mono', monospace;
  font-size: 13px;
}

.card-footnote {
  margin-bottom: 0;
  color: #879288;
  font-size: 11px;
}

.updated-date {
  overflow: hidden;
  margin: 18px 0 10px;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.03em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chart-card {
  margin-top: 15px;
  padding: 24px 25px 19px;
  border: 1px solid #e4e9e1;
  border-radius: 9px;
  background: #fff;
}

.chart-heading {
  align-items: flex-end;
  padding-bottom: 18px;
}

.chart-heading .eyebrow {
  margin-bottom: 6px;
  font-size: 9px;
}

h2 {
  margin-bottom: 0;
  font-size: 19px;
  font-weight: 700;
  letter-spacing: -0.04em;
}

.chart-unit {
  padding-bottom: 3px;
  color: #809084;
  font-size: 9px;
}

.chart-unit span {
  color: #aeb8ae;
}

.chart-area {
  position: relative;
  height: 304px;
  padding: 15px 8px 0 45px;
}

.chart-grid {
  position: absolute;
  inset: 15px 8px 39px 45px;
  pointer-events: none;
}

.axis-label {
  position: absolute;
  left: -41px;
  color: #99a49a;
  font-family: 'DM Mono', monospace;
  font-size: 9px;
  transform: translateY(-50%);
}

.axis-top {
  top: 0;
}


.axis-bottom {
  top: 100%;
}

.grid-line {
  position: absolute;
  right: 0;
  left: 0;
  border-top: 1px dashed #e9ede7;
}

.line-top {
  top: 0;
}

.line-poor {
  border-color: #e3b3ab;
}

.line-moderate {
  border-color: #ead9a0;
}

.line-bottom {
  top: 100%;
  border-top-style: solid;
  border-color: #dfe6dd;
}

.bars {
  position: relative;
  z-index: 1;
  display: grid;
  height: 250px;
  grid-template-columns: repeat(30, minmax(0, 1fr));
  gap: clamp(3px, 1.15vw, 12px);
}

.bar-column {
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: center;
}

.bar-value {
  height: 16px;
  overflow: visible;
  color: #6c7b6f;
  font-family: 'DM Mono', monospace;
  font-size: 8px;
  line-height: 12px;
  opacity: 0;
  transition: opacity 150ms ease;
  white-space: nowrap;
}

.bar-column:hover .bar-value {
  opacity: 1;
}

.bar-track {
  display: flex;
  width: 100%;
  height: 234px;
  flex: 1;
  align-items: flex-end;
  justify-content: center;
}

.bar {
  width: min(100%, 20px);
  min-height: 3px;
  border-radius: 3px 3px 1px 1px;
  background: linear-gradient(180deg, #67a878 0%, #45895b 100%);
  box-shadow: 0 2px 4px rgba(50, 107, 67, 0.1);
  transition: filter 150ms ease;
}

.bar.level-moderate {
  background: linear-gradient(180deg, #ecc95a 0%, #d3a72a 100%);
}

.bar.level-poor {
  background: linear-gradient(180deg, #e8806f 0%, #c8473a 100%);
}

.bar-column:hover .bar {
  filter: brightness(1.1);
}

.metric.level-good {
  color: #2f7d4a;
}

.metric.level-moderate {
  color: #a37d0f;
}

.metric.level-poor {
  color: #b83c30;
}

.hour-label {
  height: 19px;
  padding-top: 8px;
  color: #879388;
  font-family: 'DM Mono', monospace;
  font-size: 8px;
  line-height: 1;
}

.chart-legend {
  gap: 8px;
  padding-top: 14px;
  color: #7f8c82;
  font-size: 10px;
}

.legend-swatch {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  background: #57996a;
}

.legend-swatch.level-moderate {
  background: #d3a72a;
}

.legend-swatch.level-poor {
  background: #c8473a;
}

.legend-swatch + span {
  margin-right: 8px;
}

.legend-note {
  margin-left: auto;
  color: #9ba69c;
  font-size: 9px;
}

.chart-message {
  display: flex;
  min-height: 250px;
  align-items: center;
  justify-content: center;
  color: #7d897f;
  font-size: 13px;
}

.error-message {
  gap: 12px;
  justify-content: flex-start;
  padding: 20px;
  border-radius: 7px;
  background: #fcf4f1;
  color: #9b5142;
}

.error-message p {
  margin: 4px 0 0;
  font-size: 12px;
}

.message-icon {
  display: grid;
  width: 24px;
  height: 24px;
  flex: none;
  place-items: center;
  border: 1px solid #e9c8bf;
  border-radius: 50%;
  font-family: 'DM Mono', monospace;
  font-size: 13px;
}

.page-footer {
  padding-top: 17px;
  color: #929e94;
  font-size: 10px;
}

.page-footer > :first-child {
  color: #829084;
  font-size: 9px;
}

@media (max-width: 700px) {
  .dashboard {
    width: min(100% - 36px, 560px);
    padding-top: 22px;
  }

  .intro {
    padding-top: 36px;
  }

  .summary-grid {
    grid-template-columns: 1fr 1fr;
  }

  .climate-grid {
    grid-template-columns: 1fr;
  }

  .updated-card {
    grid-column: 1 / -1;
    min-height: 112px;
  }

  .updated-date {
    margin: 13px 0 6px;
  }

  .chart-card {
    padding: 19px 14px 15px;
  }

  .chart-area {
    height: 270px;
    padding-right: 2px;
    padding-left: 37px;
  }

  .chart-grid {
    right: 2px;
    left: 37px;
  }

  .bars {
    height: 216px;
    gap: clamp(2px, 0.65vw, 5px);
  }

  .bar-track {
    height: 200px;
  }

  .bar-value {
    font-size: 7px;
  }

  .hour-label {
    font-size: 7px;
  }
}

@media (max-width: 430px) {
  .dashboard {
    width: calc(100% - 28px);
  }

  .brand {
    gap: 7px;
    font-size: 8px;
  }

  .brand-divider {
    padding: 0 2px;
  }

  .connection {
    font-size: 10px;
  }

  .intro-row {
    align-items: flex-end;
    gap: 12px;
  }

  .intro-copy {
    max-width: 210px;
    font-size: 12px;
  }

  .refresh-button {
    gap: 6px;
    min-height: 36px;
    padding: 0 9px;
    font-size: 10px;
    white-space: nowrap;
  }

  .summary-card {
    padding: 16px 14px 14px;
  }

  .card-label {
    gap: 6px;
    font-size: 8px;
  }

  .metric {
    font-size: 34px;
  }
}
</style>
