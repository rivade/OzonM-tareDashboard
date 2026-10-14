# Air Quality Dashboard

A Vue dashboard and local API for viewing MQ135 air-quality readings plus DHT22
temperature and humidity, stored in MongoDB. A Raspberry Pi Pico reads the
sensors and uploads the values.

MQ135 readings are stored as **raw 16-bit ADC values (0–65535)** and shown on the
dashboard as a sensor voltage, converted the same way as on the Pico's LCD:
`volts = raw / 65535 × 3.3 × 1.5` (the 1.5 undoes the 10k/20k divider). Bars and
cards are coloured by level: green (**Good**) below 1.2 V, yellow (**Moderate**)
from 1.2 V and red (**Poor / High Gas**) from 2.2 V. The thresholds are
`MODERATE_VOLTS` and `POOR_VOLTS` in `src/api/ozone.ts`.

This is a relative indicator, not ppm or a percentage: that needs calibration
against known gas concentrations, and an MQ135 responds to several gases (NH3,
NOx, benzene, CO2, …), not ozone alone.

## Configure the API

Fill in the root `.env` file:

```dotenv
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DATABASE=your_database
MONGODB_COLLECTION=your_collection
API_PORT=8001
API_HOST=127.0.0.1
API_TOKEN=a-long-random-secret
```

- `API_HOST=127.0.0.1` keeps the API reachable from this computer only, which
  is all the USB bridge needs.
- `API_TOKEN` is the shared secret the Pico sends when uploading. Uploads are
  rejected without it. A random one is already generated in `.env`.

Each document is one 1-minute window of up to 30 readings, 2 seconds apart:

```javascript
{
  timestamp: <Date, first reading>,
  updatedAt: <Date>,
  values: [31200, 30890, /* ... up to 30 MQ135 ADC readings */],
  temperatures: [22.5, null, /* °C, null when the DHT22 read failed */],
  humidities: [45.1, null, /* % relative humidity, same */],
}
```

The API appends each upload to the open window. Once a window has 30 readings,
or more than 10 seconds pass without an upload, the next upload starts a new
window. Samples not taken yet show as empty bars. `values` are whole numbers
from 0 to 65535; temperatures are -40 to 80 and humidities 0 to 100 (the DHT22
ranges). Records saved before the DHT22 was added have no temperature or humidity
and show them as empty.

The `.env` file is ignored by Git. `.env.example` lists the required settings.

## Run locally

```sh
npm install
npm run api
npm run dev
```

Endpoints on `http://localhost:8001`:

- `GET /api/ozone`: newest record (kept as the endpoint name)
- `GET /api/ozone/history`: newest 100 records (`?limit=` up to 500)
- `GET /api/ozone/<id>`: one record by its MongoDB id
- `POST /api/readings`: `{"value": 31200, "temperature": 22.5, "humidity": 45.1}` with an
  `Authorization: Bearer <API_TOKEN>` header; adds the reading to the current window.
  `temperature` and `humidity` are optional (or `null`)

During development Vite proxies `/api` to the API. The dashboard has a record
picker with Older/Newer buttons for browsing past windows.

## Pico (MicroPython over USB)

The Pico is connected to the computer by USB. The bridge script
[`scripts/serial_bridge.py`](./scripts/serial_bridge.py) runs
[`pico/main.py`](./pico/main.py) on the Pico (via `mpremote`) and forwards each
reading (MQ135, temperature, humidity) to the API on `localhost`. Nothing is saved on the Pico and nothing runs
on power-up; no Wi-Fi is needed.

1. Wire the DHT22 data pin to **GP16** and the ST7789 320x240 LCD as in the pin
   constants at the top of `pico/main.py`. The LCD shows the live readings.
2. Wire the MQ135 `AO` pin to **GP26 (ADC0)**, `VCC` to 5 V (VBUS) and `GND` to
   ground. `AO` can reach 5 V, but the Pico ADC tolerates 3.3 V at most, so
   reduce it with a resistor divider (e.g. 10 kΩ + 20 kΩ). Because of this, the
   readings do not span the full 0–65535 range.
3. **Close Thonny** (only one program can use the serial port) and make sure
   `npm run api` is running.
4. Install the bridge dependencies once: `pip install pyserial mpremote`.
5. Run `py scripts\serial_bridge.py` (add a port such as `COM5` if the Pico is
   not detected automatically).

The Pico warms the sensor up for 2 minutes (the LCD shows a countdown), takes 30
readings 2 seconds apart, then stops and the bridge exits. Run the bridge again for another set.

## Build

```sh
npm run build
```
