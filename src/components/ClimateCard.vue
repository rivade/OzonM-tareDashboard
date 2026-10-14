<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  label: string
  unit: string
  // One entry per sample slot; null where there is no reading.
  values: (number | null)[]
  color: string
}>()

const WIDTH = 300
const HEIGHT = 90
const PAD = 6

const measured = computed(() => props.values.filter((value): value is number => value !== null))
const average = computed(() =>
  measured.value.length
    ? measured.value.reduce((sum, value) => sum + value, 0) / measured.value.length
    : null,
)
const low = computed(() => (measured.value.length ? Math.min(...measured.value) : null))
const high = computed(() => (measured.value.length ? Math.max(...measured.value) : null))

const format = (value: number | null) => (value === null ? '—' : value.toFixed(1))

// Fit the line to the data; a flat series is drawn in the middle.
const scale = computed(() => {
  const min = low.value ?? 0
  const max = high.value ?? 0
  return { min, span: max - min || 1 }
})

const points = computed(() =>
  props.values.map((value, index) =>
    value === null
      ? null
      : {
          x: PAD + (index / Math.max(props.values.length - 1, 1)) * (WIDTH - PAD * 2),
          y:
            high.value === low.value
              ? HEIGHT / 2
              : HEIGHT - PAD - ((value - scale.value.min) / scale.value.span) * (HEIGHT - PAD * 2),
        },
  ),
)

// Break the line wherever a sample is missing.
const segments = computed(() => {
  const result: string[] = []
  let current: string[] = []
  for (const point of points.value) {
    if (point) {
      current.push(`${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    } else if (current.length) {
      result.push(current.join(' '))
      current = []
    }
  }
  if (current.length) result.push(current.join(' '))
  return result.filter((segment) => segment.includes(' '))
})
</script>

<template>
  <article class="climate-card">
    <div class="card-label">
      <span class="label-mark" :style="{ background: color }"></span> {{ label }}
    </div>
    <div class="metric-row">
      <span class="metric">{{ format(average) }}</span>
      <span class="metric-unit">{{ unit }}</span>
    </div>
    <p class="card-footnote">
      {{ measured.length ? `Average · low ${format(low)} · high ${format(high)}` : 'No readings in this record' }}
    </p>
    <svg
      class="climate-chart"
      :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
      preserveAspectRatio="none"
      role="img"
      :aria-label="`${label} over the window`"
    >
      <polyline
        v-for="segment in segments"
        :key="segment"
        :points="segment"
        fill="none"
        :stroke="color"
        stroke-width="2"
        stroke-linejoin="round"
        stroke-linecap="round"
        vector-effect="non-scaling-stroke"
      />
    </svg>
  </article>
</template>

<style scoped>
.climate-card {
  padding: 19px 21px 16px;
  border: 1px solid #e4e9e1;
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.83);
}

.climate-chart {
  display: block;
  width: 100%;
  height: 90px;
  margin-top: 12px;
  border-bottom: 1px solid #dfe6dd;
}
</style>