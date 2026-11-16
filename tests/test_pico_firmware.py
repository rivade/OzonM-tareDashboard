import json
import pathlib
import socket
import sys
import threading
import time
import types
import unittest
import urllib.error
import urllib.request


class PicoFirmwareTest(unittest.TestCase):
    def test_sensor_endpoints_and_reading_run(self):
        ready = threading.Event()
        address = []
        real_socket = socket.socket

        class ServerSocket:
            def __init__(self, *args):
                self.sock = real_socket(*args)

            def bind(self, _address):
                self.sock.bind(("127.0.0.1", 0))
                address.append(self.sock.getsockname()[1])

            def listen(self, count):
                self.sock.listen(count)
                ready.set()

            def __getattr__(self, name):
                return getattr(self.sock, name)

        class Pin:
            OUT = 1
            IN = 0
            PULL_UP = 2

            def __init__(self, *args):
                pass

            def on(self):
                pass

            def off(self):
                pass

        class ADC:
            def __init__(self, pin):
                pass

            def read_u16(self):
                return 12000

        class DHT:
            def __init__(self, pin):
                pass

            def measure(self):
                pass

            def temperature(self):
                return 21.5

            def humidity(self):
                return 40.0

        class WLAN:
            def config(self, **kwargs):
                pass

            def active(self, value):
                pass

        fake_socket = types.ModuleType("socket")
        fake_socket.socket = ServerSocket
        for name in ("AF_INET", "SOCK_STREAM", "SOL_SOCKET", "SO_REUSEADDR"):
            setattr(fake_socket, name, getattr(socket, name))
        modules = {
            "socket": fake_socket,
            "network": types.SimpleNamespace(AP_IF=1, WLAN=lambda _: WLAN()),
            "machine": types.SimpleNamespace(ADC=ADC, Pin=Pin),
            "dht": types.SimpleNamespace(DHT22=DHT),
            "urandom": types.SimpleNamespace(getrandbits=lambda n: 123),
        }
        old_modules = {name: sys.modules.get(name) for name in modules}
        sys.modules.update(modules)
        time.ticks_ms = lambda: int(time.monotonic() * 1000)
        time.ticks_diff = lambda a, b: a - b
        time.ticks_add = lambda a, b: a + b
        time.sleep_ms = lambda ms: time.sleep(ms / 1000)
        try:
            source = pathlib.Path("pico/main.py").read_text(encoding="utf-8")
            namespace = {"__name__": "pico_test"}
            exec(compile(source.rsplit("\nmain()", 1)[0], "pico/main.py", "exec"), namespace)
            namespace.update(WARMUP_S=0, READING_INTERVAL_MS=20, SAMPLE_DELAY_MS=0)
            threading.Thread(target=namespace["main"], daemon=True).start()
            self.assertTrue(ready.wait(2))
            base = f"http://127.0.0.1:{address[0]}"

            def get(path):
                with urllib.request.urlopen(base + path, timeout=2) as response:
                    return json.load(response)

            def start():
                with urllib.request.urlopen(urllib.request.Request(base + "/start", method="POST"), timeout=2) as response:
                    return json.load(response)

            initial = get("/readings?since=0")
            self.assertEqual((initial["protocol"], initial["state"], initial["seen"]), (1, "idle", 0))
            self.assertEqual(start(), {"started": True})
            with self.assertRaises(urllib.error.HTTPError) as conflict:
                start()
            self.assertEqual(conflict.exception.code, 409)
            conflict.exception.close()
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                result = get("/readings?since=0")
                if result["state"] == "done":
                    break
                time.sleep(0.03)
            self.assertEqual(result["seen"], 30)
            self.assertEqual(len(result["readings"]), 30)
            self.assertEqual(result["readings"][0], {"value": 12000, "temperature": 21.5, "humidity": 40.0})
            self.assertEqual(len(get("/readings?since=29")["readings"]), 1)
            with self.assertRaises(urllib.error.HTTPError) as missing:
                get("/")
            self.assertEqual(missing.exception.code, 404)
            missing.exception.close()
        finally:
            for name, old in old_modules.items():
                if old is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = old


if __name__ == "__main__":
    unittest.main()
