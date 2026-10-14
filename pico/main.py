"""Pico air monitor: MQ135 (raw ADC) + DHT22 (temperature, humidity) with an LCD.

Wiring: MQ135 AO -> GP26 (ADC0) through a 10k/20k divider (5 V -> 3.3 V),
DHT22 data -> GP16, ST7789 320x240 LCD on SPI1 (pins below).

After a warm-up the script takes READINGS_PER_RUN readings, one every 2 seconds,
shows them on the LCD, and prints each as a line `mq135_raw,temp_c,humidity` over
USB (temp/humidity are empty when the DHT22 read fails). It then prints DONE and
stops. scripts/serial_bridge.py runs this file and forwards the readings to the
dashboard API.
"""

import framebuf
import gc
import time
import dht
from machine import ADC, PWM, SPI, Pin

# Clear RAM before allocating framebuffer
gc.collect()

# --- Pin Configuration ---
DC_PIN = 8
CS_PIN = 9
SCK_PIN = 10
MOSI_PIN = 11
RST_PIN = 12
BL_PIN = 13
DHT_PIN = 16
MQ135_PIN = 26  # ADC0 pin connected to MQ135 voltage divider

WIDTH = 320
HEIGHT = 240

# --- Run settings ---
READINGS_PER_RUN = 30
READING_INTERVAL_MS = 2000
WARMUP_S = 10  # the MQ135 heater needs time to stabilise; longer is better
SAMPLES_PER_READING = 8  # ADC samples averaged into each reading
SAMPLE_DELAY_MS = 20


class PicoLCD20(framebuf.FrameBuffer):

    def __init__(self):
        self.width = WIDTH
        self.height = HEIGHT

        self.cs = Pin(CS_PIN, Pin.OUT)
        self.rst = Pin(RST_PIN, Pin.OUT)
        self.dc = Pin(DC_PIN, Pin.OUT)

        self.cs(1)
        self.dc(1)

        self.spi = SPI(
            1,
            20_000_000,
            polarity=0,
            phase=0,
            sck=Pin(SCK_PIN),
            mosi=Pin(MOSI_PIN),
            miso=None,
        )

        self.buffer = bytearray(self.height * self.width * 2)
        super().__init__(self.buffer, self.width, self.height, framebuf.RGB565)

        self.init_display()

    def write_cmd(self, cmd):
        self.cs(1)
        self.dc(0)
        self.cs(0)
        self.spi.write(bytearray([cmd]))
        self.cs(1)

    def write_data(self, buf):
        self.cs(1)
        self.dc(1)
        self.cs(0)
        self.spi.write(bytearray([buf]))
        self.cs(1)

    def init_display(self):
        self.rst(1)
        time.sleep_ms(10)
        self.rst(0)
        time.sleep_ms(10)
        self.rst(1)
        time.sleep_ms(10)

        self.write_cmd(0x36)
        self.write_data(0x70)

        self.write_cmd(0x3A)
        self.write_data(0x05)

        self.write_cmd(0xB2)
        for val in [0x0C, 0x0C, 0x00, 0x33, 0x33]:
            self.write_data(val)

        self.write_cmd(0xB7)
        self.write_data(0x35)
        self.write_cmd(0xBB)
        self.write_data(0x19)
        self.write_cmd(0xC0)
        self.write_data(0x2C)
        self.write_cmd(0xC2)
        self.write_data(0x01)
        self.write_cmd(0xC3)
        self.write_data(0x12)
        self.write_cmd(0xC4)
        self.write_data(0x20)
        self.write_cmd(0xC6)
        self.write_data(0x0F)
        self.write_cmd(0xD0)
        self.write_data(0xA4)
        self.write_data(0xA1)

        self.write_cmd(0x21)
        self.write_cmd(0x11)
        time.sleep_ms(120)
        self.write_cmd(0x29)

    def show(self):
        self.write_cmd(0x2A)
        self.write_data(0x00)
        self.write_data(0x00)
        self.write_data(0x01)
        self.write_data(0x3F)

        self.write_cmd(0x2B)
        self.write_data(0x00)
        self.write_data(0x00)
        self.write_data(0x00)
        self.write_data(0xEF)

        self.write_cmd(0x2C)

        self.cs(1)
        self.dc(1)
        self.cs(0)
        self.spi.write(self.buffer)
        self.cs(1)


def color565(r, g, b):
    c = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)
    return ((c & 0xFF) << 8) | ((c >> 8) & 0xFF)


# PWM Backlight
pwm = PWM(Pin(BL_PIN))
pwm.freq(1000)
pwm.duty_u16(45000)

# Display & Sensor Setup
lcd = PicoLCD20()
dht_sensor = dht.DHT22(Pin(DHT_PIN, Pin.IN, Pin.PULL_UP))
mq135_adc = ADC(Pin(MQ135_PIN))

# Palette
BLACK = color565(0, 0, 0)
WHITE = color565(255, 255, 255)
BLUE = color565(0, 100, 220)
CYAN = color565(0, 220, 255)
GREEN = color565(0, 255, 64)
YELLOW = color565(255, 220, 0)
RED = color565(255, 50, 50)
DARK_GRAY = color565(25, 25, 25)


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


def draw_screen(raw_adc, temp_c, humidity, footer):
    lcd.fill(BLACK)

    # Header Bar
    lcd.rect(0, 0, 320, 30, BLUE, True)
    lcd.text("PICO AIR & TEMP MONITOR", 65, 10, WHITE)

    # Categorize Air Quality Level
    v_pin = (raw_adc / 65535) * 3.3
    v_sensor = v_pin * 1.5  # Accounts for 10k/20k divider (5V -> 3.3V)
    if v_sensor < 1.2:
        air_status = "Good"
        air_color = GREEN
    elif v_sensor < 2.2:
        air_status = "Moderate"
        air_color = YELLOW
    else:
        air_status = "Poor / High Gas"
        air_color = RED

    # Temperature Box
    lcd.rect(10, 36, 300, 48, DARK_GRAY, True)
    lcd.text("TEMPERATURE", 20, 42, CYAN)
    # Humidity Box
    lcd.rect(10, 90, 300, 48, DARK_GRAY, True)
    lcd.text("HUMIDITY", 20, 96, CYAN)
    if temp_c is None:
        lcd.text("Sensor Error", 30, 62, RED)
        lcd.text("Sensor Error", 30, 116, RED)
    else:
        temp_f = (temp_c * 9 / 5) + 32
        lcd.text(f"{temp_c:.1f} C  /  {temp_f:.1f} F", 30, 62, GREEN)
        lcd.text(f"{humidity:.1f} %", 30, 116, GREEN)

    # Air Quality Box (MQ135)
    lcd.rect(10, 144, 300, 48, DARK_GRAY, True)
    lcd.text("AIR QUALITY (MQ135)", 20, 150, CYAN)
    lcd.text(f"{v_sensor:.2f}V - {air_status}", 30, 170, air_color)

    lcd.text(footer, 10, 218, WHITE)
    lcd.show()


def show_message(text):
    lcd.fill(BLACK)
    lcd.rect(0, 0, 320, 30, BLUE, True)
    lcd.text("PICO AIR & TEMP MONITOR", 65, 10, WHITE)
    lcd.text(text, 10, 110, WHITE)
    lcd.show()


def main():
    print("Warming up sensor for %d s..." % WARMUP_S)
    for left in range(WARMUP_S, 0, -1):
        if left % 5 == 0:
            show_message("Warming up sensor: %d s" % left)
        time.sleep(1)

    for number in range(1, READINGS_PER_RUN + 1):
        started = time.ticks_ms()

        raw_adc = read_mq135()
        temp_c, humidity = read_dht()
        if temp_c is None:
            print("%d,," % raw_adc)
        else:
            print("%d,%.1f,%.1f" % (raw_adc, temp_c, humidity))
        draw_screen(raw_adc, temp_c, humidity, "Reading %d/%d" % (number, READINGS_PER_RUN))

        # Keep a steady cadence regardless of how long the reading took.
        elapsed = time.ticks_diff(time.ticks_ms(), started)
        time.sleep_ms(max(0, READING_INTERVAL_MS - elapsed))

    show_message("Done - %d readings sent" % READINGS_PER_RUN)
    print("DONE")


try:
    main()
except KeyboardInterrupt:
    lcd.fill(BLACK)
    lcd.show()
    pwm.duty_u16(0)