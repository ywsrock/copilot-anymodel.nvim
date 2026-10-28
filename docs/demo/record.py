#!/usr/bin/env python3
"""Drives Neovim in a pseudo-terminal and writes an asciicast v2 recording.

    python3 docs/demo/record.py [out.cast]
    agg --font-size 16 out.cast docs/demo.gif
"""
import fcntl, json, os, pty, select, shutil, struct, sys, tempfile, termios, time

COLS, ROWS = 92, 26
HERE = os.path.dirname(os.path.abspath(__file__))
out_path = sys.argv[1] if len(sys.argv) > 1 else 'demo.cast'

work = tempfile.mkdtemp()
shutil.copy(os.path.join(HERE, 'shop.py'), os.path.join(work, 'shop.py'))

ESC, TAB, CR, CTRL_U = '\x1b', '\t', '\r', '\x15'
# (keys, seconds to wait afterwards); keys are typed one by one.
SCRIPT = [
    ('', 2.5),                                   # startup
    ('Go', 3.0),                                 # new line in the function body -> suggestion
    (TAB, 1.2),                                  # accept
    (CR + CR + CTRL_U + 'def most_expensive(items: list[Item]) -> Item:' + CR, 3.0),
    (TAB, 1.2),
    (ESC + ':Cop model' + CR, 2.5),              # every model of every provider
    ('2' + CR, 1.5),                             # Claude Sonnet 5.5
    ('Go' + CR + CTRL_U + 'def cheapest(', 3.5),
    (TAB, 1.2),
    (ESC, 1.5),
]

pid, fd = pty.fork()
if pid == 0:
    os.chdir(work)
    os.environ['TERM'] = 'xterm-256color'
    os.environ['COLORTERM'] = 'truecolor'
    os.execvp('nvim', ['nvim', '--clean', '-u', os.path.join(HERE, 'init.lua'), '+normal! G$', 'shop.py'])

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))
events, start = [], time.monotonic()


def pump(seconds):
    end = time.monotonic() + seconds
    while (left := end - time.monotonic()) > 0:
        ready, _, _ = select.select([fd], [], [], left)
        if ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return
            events.append([round(time.monotonic() - start, 3), 'o', data.decode('utf-8', 'replace')])


for keys, wait in SCRIPT:
    for ch in keys:
        os.write(fd, ch.encode())
        pump(0.06)
    pump(wait)

os.write(fd, (ESC + ':qa!' + CR).encode())
pump(0.5)
with open(out_path, 'w') as f:
    f.write(json.dumps({'version': 2, 'width': COLS, 'height': ROWS, 'env': {'TERM': 'xterm-256color'}}) + '\n')
    for e in events:
        f.write(json.dumps(e) + '\n')
print(f'{out_path}: {len(events)} events, {events[-1][0] if events else 0}s')
