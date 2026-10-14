export const MAX_ADC_VALUE = 65535

// Same conversion as the Pico's LCD: ADC pin voltage (3.3 V reference) scaled back
// up by 1.5 for the 10k/20k divider that brings the MQ135's 5 V output down.
export const SENSOR_MAX_VOLTS = 3.3 * 1.5
export const toVolts = (adc: number) => (adc / MAX_ADC_VALUE) * SENSOR_MAX_VOLTS

// Air-quality thresholds, as on the Pico's LCD.
export const MODERATE_VOLTS = 1.2
export const POOR_VOLTS = 2.2

export type AirLevel = 'good' | 'moderate' | 'poor'

export function airLevel(volts: number): AirLevel {
  if (volts < MODERATE_VOLTS) return 'good'
  if (volts < POOR_VOLTS) return 'moderate'
  return 'poor'
}

export const AIR_LEVEL_LABEL: Record<AirLevel, string> = {
  good: 'Good',
  moderate: 'Moderate',
  poor: 'Poor / High Gas',
}
export const SAMPLES_PER_WINDOW = 30
export const SAMPLE_INTERVAL_S = 2

// DHT22 operating ranges.
export const TEMPERATURE_RANGE = [-40, 80] as const
export const HUMIDITY_RANGE = [0, 100] as const

// value is null for samples that have not been taken yet. temperature and humidity
// are also null when the DHT22 had no reading (or the record predates it).
export interface SampleReading {
  sample: number
  value: number | null
  temperature: number | null
  humidity: number | null
}

function isNullableInRange(value: unknown, [min, max]: readonly [number, number]): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max)
}

export interface OzoneReadings {
  id: string
  timestamp: string
  samples: SampleReading[]
}

export interface OzoneRecordSummary {
  id: string
  timestamp: string
}

async function request(path: string): Promise<Response> {
  const response = await fetch(path)

  if (!response.ok) {
    let message = `API request failed (${response.status}).`
    try {
      const body: { error?: unknown } = await response.json()
      if (typeof body.error === 'string') message = body.error
    } catch {
      // Keep the HTTP status message when the server does not return JSON.
    }
    throw new Error(message)
  }

  return response
}

function isRecordSummary(record: unknown): record is OzoneRecordSummary {
  return (
    typeof record === 'object' &&
    record !== null &&
    'id' in record &&
    'timestamp' in record &&
    typeof record.id === 'string' &&
    typeof record.timestamp === 'string'
  )
}

export async function getReadingHistory(): Promise<OzoneRecordSummary[]> {
  const response = await request('/api/ozone/history')
  const data: { records?: unknown } = await response.json()

  if (!Array.isArray(data.records) || !data.records.every(isRecordSummary)) {
    throw new Error('The API returned data in an unexpected format.')
  }
  return data.records
}

export async function getOzoneReadings(id?: string): Promise<OzoneReadings> {
  const response = await request(id ? `/api/ozone/${encodeURIComponent(id)}` : '/api/ozone')
  const data: { id?: unknown; timestamp?: unknown; samples?: unknown } = await response.json()

  if (
    typeof data.id !== 'string' ||
    typeof data.timestamp !== 'string' ||
    !Array.isArray(data.samples)
  ) {
    throw new Error('The API returned data in an unexpected format.')
  }

  if (
    data.samples.length !== SAMPLES_PER_WINDOW ||
    !data.samples.every(
      (reading): reading is SampleReading =>
        typeof reading === 'object' &&
        reading !== null &&
        'sample' in reading &&
        'value' in reading &&
        'temperature' in reading &&
        'humidity' in reading &&
        isNullableInRange(reading.temperature, TEMPERATURE_RANGE) &&
        isNullableInRange(reading.humidity, HUMIDITY_RANGE) &&
        typeof reading.sample === 'number' &&
        Number.isInteger(reading.sample) &&
        reading.sample >= 1 &&
        reading.sample <= SAMPLES_PER_WINDOW &&
        (reading.value === null ||
          (typeof reading.value === 'number' &&
            Number.isInteger(reading.value) &&
            reading.value >= 0 &&
            reading.value <= MAX_ADC_VALUE)),
    )
  ) {
    throw new Error(`The API must return ${SAMPLES_PER_WINDOW} samples with values from 0 to ${MAX_ADC_VALUE}.`)
  }

  return { id: data.id, timestamp: data.timestamp, samples: data.samples }
}
