"""Wi-Fi sensor service for the air quality dashboard.

MQ135 AO connects to GP26 via a 10k/20k divider; DHT22 data to GP16.
No vehicle control or web page is hosted by this firmware.
"""

import json
import network
import socket
import time
import urandom
import dht
from machine import ADC, Pin

try:
    import config
except ImportError:
    config = None

DHT_PIN = 16
MQ135_PIN = 26
MAX_STORED = 100
READINGS_PER_RUN = 30
READING_INTERVAL_MS = 2000
WARMUP_S = 10
SAMPLES_PER_READING = 8
SAMPLE_DELAY_MS = 20

led = Pin("LED", Pin.OUT)
dht_sensor = dht.DHT22(Pin(DHT_PIN, Pin.IN, Pin.PULL_UP))
mq135_adc = ADC(Pin(MQ135_PIN))
boot_ms = time.ticks_ms()
boot_id = "%08x%08x" % (urandom.getrandbits(30), urandom.getrandbits(30))


def read_mq135():
    # read_u16() returns 0-65535; average several samples to reduce noise
    total = 0
    for _ in range(SAMPLES_PER_READING):
        total += mq135_adc.read_u16()
        time.sleep_ms(SAMPLE_DELAY_MS)
    return total // SAMPLES_PER_READING


def read_dht():
    # Returns (temperature_c, humidity), or (None, None) when the read fails.
    try:
        dht_sensor.measure()
        return dht_sensor.temperature(), dht_sensor.humidity()
    except OSError:
        return None, None


def connect_wifi():
    # Returns True when joined to the configured network.
    if config is None or not getattr(config, "WIFI_SSID", ""):
        return False
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)
    wlan.connect(config.WIFI_SSID, config.WIFI_PASSWORD)
    for _ in range(30):
        if wlan.isconnected():
            print("Wi-Fi joined, open http://%s" % wlan.ifconfig()[0])
            return True
        led.toggle()
        time.sleep_ms(500)
    wlan.active(False)
    return False


def send_json(conn, body, status="200 OK"):
    conn.sendall(
        b"HTTP/1.1 " + status.encode() + b"\r\nContent-Type: application/json\r\n"
        b"Cache-Control: no-store\r\nContent-Length: "
        + str(len(body)).encode()
        + b"\r\nConnection: close\r\n\r\n"
        + body
    )


def close_after_client(conn):
    # Let the client close first: a connection the Pico closes itself lingers in
    # TIME_WAIT, and the small TCP table fills up after a few requests.
    try:
        conn.settimeout(0.3)
        conn.recv(1)
    except OSError:
        pass
    conn.close()



def main():
    if not connect_wifi():
        ap = network.WLAN(network.AP_IF)
        ap.config(essid="Cutebot-Pico", password="password123")
        ap.active(True)
        print("Access point Cutebot-Pico, http://192.168.4.1")
    led.on()

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("", 80))
    server.listen(2)
    server.settimeout(0.05)

    state = "idle"
    count = 0
    next_reading = 0
    seen = 0
    stored = []

    try:
        while True:
            conn = None
            try:
                conn, _ = server.accept()
                conn.settimeout(0.5)
                request = conn.recv(512).decode("utf-8")
                parts = request.split(" ", 2)
                method = parts[0] if len(parts) > 1 else ""
                target = parts[1] if len(parts) > 1 else ""
                path = target.split("?", 1)[0]

                if method == "GET" and path == "/readings":
                    since = 0
                    if "?" in target:
                        query = target.split("?", 1)[1]
                        for part in query.split("&"):
                            if part.startswith("since="):
                                since = int(part[6:])
                    if since < 0:
                        raise ValueError("since must be non-negative")
                    first = seen - len(stored) + 1
                    start = min(len(stored), max(0, since + 1 - first))
                    body = {"protocol": 1, "boot": boot_id, "seen": seen,
                            "first": first, "state": state, "count": count,
                            "total": READINGS_PER_RUN, "readings": stored[start:]}
                    send_json(conn, json.dumps(body).encode("utf-8"))
                elif method == "POST" and path == "/start":
                    if state in ("warmup", "reading"):
                        send_json(conn, b'{"error":"A reading is already in progress."}', "409 Conflict")
                    else:
                        state = "warmup"
                        count = 0
                        send_json(conn, b'{"started":true}')
                else:
                    send_json(conn, b'{"error":"Not found."}', "404 Not Found")
            except (ValueError, UnicodeError) as error:
                print("Invalid request:", error)
                if conn is not None:
                    send_json(conn, b'{"error":"Invalid request."}', "400 Bad Request")
            except OSError as error:
                if conn is not None:
                    print("Connection error:", error)
            finally:
                if conn is not None:
                    close_after_client(conn)

            if state == "warmup" and time.ticks_diff(time.ticks_ms(), boot_ms) >= WARMUP_S * 1000:
                state = "reading"
                next_reading = time.ticks_ms()
                print("Warm-up done, reading...")
            elif state == "reading" and time.ticks_diff(time.ticks_ms(), next_reading) >= 0:
                next_reading = time.ticks_add(time.ticks_ms(), READING_INTERVAL_MS)
                raw_adc = read_mq135()
                temp_c, humidity = read_dht()
                count += 1
                if temp_c is None:
                    print("%d,," % raw_adc)
                else:
                    print("%d,%.1f,%.1f" % (raw_adc, temp_c, humidity))
                seen += 1
                stored.append({"value": raw_adc, "temperature": temp_c, "humidity": humidity})
                del stored[:-MAX_STORED]
                if count >= READINGS_PER_RUN:
                    state = "done"
                    print("DONE")
    finally:
        server.close()
        led.off()


main()