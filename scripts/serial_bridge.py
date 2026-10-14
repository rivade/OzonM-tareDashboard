"""Run pico/main.py on the Pico over USB and forward its readings to the local API.

Usage:  py scripts/serial_bridge.py [COM_PORT]

The script is run from the computer with mpremote, so nothing is saved on the
Pico and nothing runs on power-up. Without an argument the Pico is found
automatically.
"""

import shutil
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

from serial.tools import list_ports

MAX_ADC_VALUE = 65535
PICO_USB_VENDOR_ID = 0x2E8A  # Raspberry Pi
PICO_SCRIPT = Path(__file__).resolve().parent.parent / "pico" / "main.py"


def load_env(path):
    if not path.exists():
        raise SystemExit(f"Missing {path}. Copy .env.example to .env and fill it in.")
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


def find_port():
    pico_ports = [p.device for p in list_ports.comports() if p.vid == PICO_USB_VENDOR_ID]
    if len(pico_ports) == 1:
        return pico_ports[0]
    available = ", ".join(p.device for p in list_ports.comports()) or "none"
    raise SystemExit(
        f"Could not pick the Pico automatically (found {len(pico_ports)}). "
        f"Pass the port, e.g. COM5. Available ports: {available}"
    )


def find_mpremote():
    # Use the mpremote executable rather than `python -m mpremote`: debuggers
    # rewrite child Python command lines, which breaks `-m`.
    scripts = Path(sys.executable).parent
    for candidate in (scripts / "mpremote.exe", scripts / "mpremote"):
        if candidate.exists():
            return str(candidate)
    found = shutil.which("mpremote")
    if found:
        return found
    raise SystemExit(
        f'mpremote not found. Install it with:  "{sys.executable}" -m pip install mpremote'
    )


def parse_reading(line):
    # The Pico prints "mq135_raw,temp_c,humidity" (the last two empty when the
    # DHT22 read failed). Anything else is a status message: returns None.
    parts = line.split(",")
    if len(parts) != 3 or not parts[0].isdigit() or int(parts[0]) > MAX_ADC_VALUE:
        return None
    try:
        temperature = float(parts[1]) if parts[1] else None
        humidity = float(parts[2]) if parts[2] else None
    except ValueError:
        return None
    return {"value": int(parts[0]), "temperature": temperature, "humidity": humidity}


def post_reading(url, token, reading):
    request = urllib.request.Request(
        url,
        data=json.dumps(reading).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)


def main():
    load_env(Path(__file__).resolve().parent.parent / ".env")
    token = os.environ.get("API_TOKEN")
    if not token:
        raise SystemExit("Set API_TOKEN in .env first.")
    url = f"http://127.0.0.1:{os.environ.get('API_PORT', '8001')}/api/readings"

    port = sys.argv[1] if len(sys.argv) > 1 else find_port()
    command = [find_mpremote(), "connect", port, "run", str(PICO_SCRIPT)]
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="ignore",
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )

    print(f"Running {PICO_SCRIPT.name} on {port}, posting to {url}. Press Ctrl+C to stop.")
    try:
        for raw_line in process.stdout:
            line = raw_line.strip()
            if not line:
                continue
            if line == "DONE":
                print("Pico finished its 30 readings. Done.")
                break
            reading = parse_reading(line)
            if reading is None:
                print("Pico:", line)
                continue

            try:
                result = post_reading(url, token, reading)
                print(f"Posted {line} (sample {result['sample']} of {result['of']})")
            except urllib.error.HTTPError as error:
                print(f"API rejected {line}: HTTP {error.code} {error.read().decode()}")
            except OSError as error:
                print(f"Could not reach the API ({error}). Is `npm run api` running?")
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        process.terminate()
        process.wait()


if __name__ == "__main__":
    main()