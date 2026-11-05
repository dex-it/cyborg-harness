# Настоящий ввод X11 через XTest для замера клавиш и перетаскивания (spike-iframe.mjs): sendInputEvent и CDP идут мимо пути ввода окна. Нужен python-xlib.
import sys
import time

from Xlib import X, XK, display
from Xlib.ext import xtest

d = display.Display()


def press(spec):
    names = [{'ctrl': 'Control_L', 'shift': 'Shift_L'}.get(p.lower(), p) for p in spec.split('+')]
    codes = [d.keysym_to_keycode(XK.string_to_keysym(n)) for n in names]
    for c in codes:
        xtest.fake_input(d, X.KeyPress, c)
    for c in reversed(codes):
        xtest.fake_input(d, X.KeyRelease, c)
    d.sync()
    time.sleep(0.1)


def move(x, y):
    xtest.fake_input(d, X.MotionNotify, x=x, y=y)
    d.sync()
    time.sleep(0.03)


if sys.argv[1] == 'drag':
    x1, y1, x2, y2 = map(int, sys.argv[2:6])
    move(x1, y1)
    time.sleep(0.2)
    xtest.fake_input(d, X.ButtonPress, 1)
    d.sync()
    time.sleep(0.2)
    for i in range(1, 41):
        move(x1 + (x2 - x1) * i // 40, y1 + (y2 - y1) * i // 40)
    time.sleep(0.3)
    move(x2 + 1, y2)
    time.sleep(0.3)
    xtest.fake_input(d, X.ButtonRelease, 1)
    d.sync()
    time.sleep(0.3)
elif sys.argv[1] == 'click':
    xtest.fake_input(d, X.MotionNotify, x=int(sys.argv[2]), y=int(sys.argv[3]))
    d.sync()
    time.sleep(0.1)
    xtest.fake_input(d, X.ButtonPress, 1)
    xtest.fake_input(d, X.ButtonRelease, 1)
    d.sync()
    time.sleep(0.2)
else:
    for spec in sys.argv[2:]:
        press(spec)
