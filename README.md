# Air Quality Dashboard

A Vue dashboard and local API for viewing MQ135 air-quality readings plus DHT22
temperature and humidity, stored in MongoDB. A Raspberry Pi Pico W reads the
sensors; the API polls the Pico and stores the values.

MQ135 readings are stored as **raw 16-bit ADC values (0–65535)** and shown on the
dashboard as a sensor voltage:
`volts = raw / 65535 × 3.3 × 1.5` (the 1.5 undoes the 10k/20k divider). Bars and
cards are coloured by level: green (**Good**) below 1.2 V, yellow (**Moderate**)
from 1.2 V and red (**Poor / High Gas**) from 2.2 V. The thresholds are
`MODERATE_VOLTS` and `POOR_VOLTS` in `src/api/ozone.ts`.

This is a relative indicator, not ppm or a percentage: that needs calibration
against known gas concentrations, and an MQ135 responds to several gases (NH3,
NOx, benzene, CO2, …), not ozone alone.

## Configure the API

Copy `.env.example` to `.env` in the project root and fill in the MongoDB
connection details. For example:

```dotenv
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DATABASE=your_database
MONGODB_COLLECTION=your_collection
API_PORT=8001
API_HOST=127.0.0.1
API_TOKEN=a-long-random-secret
PICO_URL=http://192.168.4.1
```

- `API_HOST=127.0.0.1` keeps the API on this computer. The example file uses
  `0.0.0.0`, which exposes the API on network interfaces; change it to
  `127.0.0.1` when remote access is not needed.
- `API_TOKEN` protects the optional external `POST /api/readings` endpoint; the Pico does not need it.
- `PICO_URL` optionally changes the Pico address (default `http://192.168.4.1`).
- The development proxy targets `127.0.0.1:8001`. If `API_PORT` changes, update
  the proxy in `vite.config.ts` to match.

Each document is one 1-minute window of up to 30 readings, 2 seconds apart:

```javascript
{
  timestamp: <Date, first reading>,
  updatedAt: <Date>,
  values: [31200, 30890, /* ... up to 30 MQ135 ADC readings */],
  temperatures: [22.5, null, /* °C, null when the DHT22 read failed */],
  humidities: [45.1, null, /* % relative humidity, same */],
  picoIds: [/* optional Pico boot and sample identifiers */],
}
```

The API appends each upload to the open window. Once a window has 30 readings,
or more than 10 seconds pass without a saved reading, the next reading starts a
new window. A run can therefore span multiple windows if saving is delayed.
Samples not taken yet show as empty bars. `values` are whole numbers from 0 to
65535; temperatures are -40 to 80 and humidities 0 to 100 (the DHT22
ranges). Records saved before the DHT22 was added have no temperature or humidity
and show them as empty.

The `.env` file is ignored by Git. `.env.example` lists the required settings.

## Run locally

Install dependencies with `npm install`. Node.js `^22.18.0` or `>=24.12.0` is
required. Start the API and dashboard in **separate terminals**:

```sh
npm run live
```

```sh
npm run dev
```

`npm run live` starts the API (equivalent to `npm run api`); the API must connect
to MongoDB before it starts listening. Open the dashboard URL printed by Vite.
The dashboard only refreshes the latest record automatically; manually selected
older records stay selected.

Endpoints on `http://localhost:8001`:

- `GET /api/pico/status`: Pico connection, progress and upload errors
- `POST /api/pico/start`: start one sensor run
- `GET /api/ozone`: newest record (kept as the endpoint name)
- `GET /api/ozone/history`: newest 100 records (`?limit=` up to 500)
- `GET /api/ozone/<id>`: one record by its MongoDB id
- `POST /api/readings`: `{"value": 31200, "temperature": 22.5, "humidity": 45.1}` with an
  `Authorization: Bearer <API_TOKEN>` header; adds the reading to the current window.
  `temperature` and `humidity` are optional (or `null`)

During development Vite proxies `/api` to the API. The dashboard has a record
picker with Older/Newer buttons for browsing past windows.

## Pico sensor setup

The Pico W runs the sensor service and creates `Cutebot-Pico` Wi-Fi by default.
It does not host a web page or control the vehicle. Use a separate controller for
the vehicle. The dashboard API polls the Pico, stores its readings and sends start
commands; no separate Wi-Fi bridge is required.

1. Connect the DHT22 data to **GP16**, VCC to 3.3 V and GND to ground.
2. Connect the MQ135 AO to **GP26 (ADC0)** through a voltage divider: 10 kohm
   between AO and GP26, and 20 kohm between GP26 and GND. Connect VCC to a
   suitable 5 V supply and GND to ground. Do not feed a 5 V signal directly
   into a Pico GPIO. Confirm your particular MQ135 module's supply requirements.
3. With the Pico connected by USB and Thonny closed, upload the firmware once:

   ```powershell
   mpremote connect COM3 cp pico\main.py :main.py
   mpremote connect COM3 reset
   ```

   Use the actual Pico port instead of COM3. The Pico runs `main.py` on power-up.
   Install `mpremote` in your Python environment if needed (on Windows, run
   `py -m pip install mpremote`). After upload, the Pico can run from a suitable
   USB power source without being connected to the computer.
4. Connect the PC to `Cutebot-Pico` (password `password123`). Keep a separate
   internet connection for MongoDB Atlas; for example, use a second Wi-Fi
   adapter or USB tethering. Add the internet connection's public IP to Atlas
   Network Access. Managed school computers may restrict simultaneous networks.
5. Run `npm run live` and `npm run dev`, then open the Vite dashboard. The Pico
   panel shows its connection and progress; press **Start reading** there. It
   takes 30 samples approximately two seconds apart and updates the latest record.
   The firmware waits until at least 10 seconds after Pico startup before taking
   the first sample; an MQ135 can require a longer warm-up for stable readings.

Optionally copy `pico/config.example.py` to `pico/config.py` and set a 2.4 GHz
Wi-Fi network. Upload it using the actual Pico port, then reset the Pico:

```powershell
mpremote connect COM3 cp pico\config.py :config.py
mpremote connect COM3 reset
```

Set `PICO_URL` in the root `.env` to the Pico's address on that network and
restart the API. The network must allow the computer to reach the Pico, and the
address may change after reconnecting. If the Pico cannot join it, it falls back to `Cutebot-Pico` at `192.168.4.1`; adjust `PICO_URL` if
needed. No configuration file is needed for access-point mode. If an older
`config.py` is already saved on the Pico, its Wi-Fi settings still apply; update
it or back it up and remove it to return to access-point mode.

The Pico keeps the latest 100 readings only in RAM. The API retries failed
uploads while the Pico remains powered; resetting the Pico or losing more than
100 readings before collection can lose data. Upload failures and gaps are
shown on the dashboard; restart the API to acknowledge a reported gap after
reviewing it. The Pico sensor API has no authentication; use it only on a
trusted network. When using the default access point, change its default password
in `pico/main.py` before using it in an untrusted area.

## Build

```sh
npm run build
```

## Tests

```sh
node --test server/pico.test.js
python -m unittest discover -s tests -p test_pico_firmware.py
```

The Python test simulates the Pico hardware; it does not replace testing on the
physical Pico and sensors.
