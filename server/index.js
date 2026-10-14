import 'dotenv/config'
import { createServer } from 'node:http'
import { MongoClient, ObjectId } from 'mongodb'

const { MONGODB_URI, MONGODB_DATABASE, MONGODB_COLLECTION, API_TOKEN } = process.env
const port = Number(process.env.API_PORT ?? 8001)
const host = process.env.API_HOST || '127.0.0.1'
const maxAdcValue = 65535
const samplesPerWindow = 30
// DHT22 operating ranges.
const temperatureRange = [-40, 80]
const humidityRange = [0, 100]
// A window is closed once a gap this long passes between readings (5 x the 2 s interval).
const windowGapMs = 10_000
const timestampField = 'timestamp'

if (!MONGODB_URI || !MONGODB_DATABASE || !MONGODB_COLLECTION) {
  throw new Error(
    'Set MONGODB_URI, MONGODB_DATABASE, and MONGODB_COLLECTION in the root .env file.',
  )
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('API_PORT must be a valid port number.')
}

const client = new MongoClient(MONGODB_URI)

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(payload))
}

function isAdcValue(value) {
  return Number.isInteger(value) && value >= 0 && value <= maxAdcValue
}

function isInRange(value, [min, max]) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

// Optional readings (DHT22) may be missing: null means no value for that sample.
function isOptionalInRange(value, range) {
  return value === null || value === undefined || isInRange(value, range)
}

function parseOptionalSeries(stored, name, range) {
  if (stored === undefined) return []
  if (!Array.isArray(stored) || stored.length > samplesPerWindow || !stored.every((value) => value === null || isInRange(value, range))) {
    throw new Error(`A record's "${name}" must hold up to ${samplesPerWindow} numbers from ${range[0]} to ${range[1]} (or null).`)
  }
  return stored
}

// Samples that have not been taken yet are returned as null. Records saved
// before the DHT22 was added have no temperatures/humidities, so those are null.
function parseSamples(document) {
  const stored = document.values
  if (!Array.isArray(stored) || stored.length > samplesPerWindow || !stored.every(isAdcValue)) {
    throw new Error(`A record's "values" must hold up to ${samplesPerWindow} whole numbers from 0 to ${maxAdcValue}.`)
  }
  const temperatures = parseOptionalSeries(document.temperatures, 'temperatures', temperatureRange)
  const humidities = parseOptionalSeries(document.humidities, 'humidities', humidityRange)

  return Array.from({ length: samplesPerWindow }, (_, index) => ({
    sample: index + 1,
    value: stored[index] ?? null,
    temperature: temperatures[index] ?? null,
    humidity: humidities[index] ?? null,
  }))
}
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
      if (body.length > 1024) {
        reject(new Error('Request body is too large.'))
        request.destroy()
      }
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(body))
      } catch {
        reject(new Error('Request body must be valid JSON.'))
      }
    })
    request.on('error', reject)
  })
}

async function start() {
  await client.connect()
  const collection = client.db(MONGODB_DATABASE).collection(MONGODB_COLLECTION)

  function toReading(document) {
    const timestamp = document[timestampField]
    if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
      throw new Error(`Each MongoDB document must have a valid Date in "${timestampField}".`)
    }
    return { id: String(document._id), timestamp: timestamp.toISOString(), samples: parseSamples(document) }
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')

    try {
      if (request.method === 'POST' && url.pathname === '/api/readings') {
        if (!API_TOKEN) {
          sendJson(response, 503, { error: 'Set API_TOKEN in .env to accept sensor readings.' })
          return
        }
        if (request.headers.authorization !== `Bearer ${API_TOKEN}`) {
          sendJson(response, 401, { error: 'Invalid or missing token.' })
          return
        }

        let value, temperature, humidity
        try {
          ;({ value, temperature = null, humidity = null } = await readJsonBody(request))
        } catch (error) {
          sendJson(response, 400, { error: error.message })
          return
        }
        if (!isAdcValue(value)) {
          sendJson(response, 400, { error: `value must be a whole number from 0 to ${maxAdcValue}.` })
          return
        }

        if (!isOptionalInRange(temperature, temperatureRange) || !isOptionalInRange(humidity, humidityRange)) {
          sendJson(response, 400, {
            error: `temperature must be null or a number from ${temperatureRange[0]} to ${temperatureRange[1]}, and humidity null or a number from ${humidityRange[0]} to ${humidityRange[1]}.`
          })
          return
        }
        temperature ??= null
        humidity ??= null

        // Append to the open window if it is not full and still receiving readings;
        // otherwise start a new window.
        const now = new Date()
        const window = await collection.findOneAndUpdate(
          {
            values: { $type: 'array' },
            [`values.${samplesPerWindow - 1}`]: { $exists: false },
            updatedAt: { $gte: new Date(now.getTime() - windowGapMs) },
          },
          { $push: { values: value, temperatures: temperature, humidities: humidity }, $set: { updatedAt: now } },
          { sort: { [timestampField]: -1 }, returnDocument: 'after' },
        )
        if (!window) {
          await collection.insertOne({
            [timestampField]: now,
            updatedAt: now,
            values: [value],
            temperatures: [temperature],
            humidities: [humidity],
          })
        }
        sendJson(response, 200, { sample: window ? window.values.length : 1, of: samplesPerWindow, value, temperature, humidity })
        return
      }

      if (request.method !== 'GET') {
        sendJson(response, 404, { error: 'Route not found.' })
        return
      }

      if (url.pathname === '/api/ozone/history') {
        const requested = Number(url.searchParams.get('limit') ?? 100)
        const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 500) : 100
        const documents = await collection
          .find({ [timestampField]: { $type: 'date' }, values: { $type: 'array' } }, { projection: { [timestampField]: 1 } })
          .sort({ [timestampField]: -1 })
          .limit(limit)
          .toArray()
        sendJson(response, 200, {
          records: documents.map((document) => ({
            id: String(document._id),
            timestamp: document[timestampField].toISOString(),
          })),
        })
        return
      }

      if (url.pathname === '/api/ozone') {
        const document = await collection.findOne({ values: { $type: 'array' } }, { sort: { [timestampField]: -1 } })
        if (!document) {
          sendJson(response, 404, { error: 'No ozone records were found.' })
          return
        }
        sendJson(response, 200, toReading(document))
        return
      }

      const match = url.pathname.match(/^\/api\/ozone\/([0-9a-fA-F]{24})$/)
      if (match) {
        const document = await collection.findOne({ _id: new ObjectId(match[1]) })
        if (!document) {
          sendJson(response, 404, { error: 'That ozone record was not found.' })
          return
        }
        sendJson(response, 200, toReading(document))
        return
      }

      sendJson(response, 404, { error: 'Route not found.' })
    } catch (error) {
      console.error('Failed to read ozone data:', error)
      const message = error instanceof Error ? error.message : 'Unexpected database error.'
      if (response.headersSent) return
      sendJson(response, 500, { error: message })
    }
  })
  server.on('error', (error) => {
    console.error('API server error:', error)
    void client.close()
    process.exitCode = 1
  })

  server.listen(port, host, () => {
    console.log(`Sensor API listening on ${host}:${port}`)
  })

  const shutdown = async () => {
    server.close()
    await client.close()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

start().catch(async (error) => {
  console.error('Could not start the ozone API:', error)
  await client.close()
  process.exitCode = 1
})
