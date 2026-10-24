#!/usr/bin/env python3
"""
Erzeugt build/icon.png und build/icon.ico ohne externe Bibliotheken.

Motiv: ein Umschlag auf dunklem Grund, links die drei Kontenfarben als Kante -
dasselbe Zeichen, das in der App die Konten auseinanderhaelt. Gezeichnet wird
vierfach vergroessert und danach heruntergerechnet; das ergibt die Glaettung.
"""

import struct
import zlib
from pathlib import Path

SIZE = 512
SS = 4  # Supersampling-Faktor
W = SIZE * SS

BG = (0x1B, 0x1F, 0x27)
FG = (0xF2, 0xF4, 0xF7)
SPINE = [(0x4F, 0x7C, 0xFF), (0xE0, 0x72, 0x3C), (0x3F, 0xA0, 0x6B)]


def rounded_rect(x, y, w, h, r):
    """Gibt eine Funktion zurueck, die sagt, ob ein Punkt innen liegt."""
    def inside(px, py):
        if not (x <= px <= x + w and y <= py <= y + h):
            return False
        cx = min(max(px, x + r), x + w - r)
        cy = min(max(py, y + r), y + h - r)
        dx, dy = px - cx, py - cy
        return dx * dx + dy * dy <= r * r
    return inside


def seg_distance(px, py, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    length = dx * dx + dy * dy
    if length == 0:
        t = 0.0
    else:
        t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / length))
    qx, qy = x1 + t * dx, y1 + t * dy
    return ((px - qx) ** 2 + (py - qy) ** 2) ** 0.5


def build():
    scale = W / 512.0
    s = lambda v: v * scale

    card = rounded_rect(s(36), s(36), s(440), s(440), s(96))
    # Umschlag
    ex, ey, ew, eh = s(150), s(178), s(230), s(156)
    body_outer = rounded_rect(ex, ey, ew, eh, s(16))
    stroke = s(15)
    inner = rounded_rect(ex + stroke, ey + stroke, ew - 2 * stroke, eh - 2 * stroke, s(8))
    # Klappe: zwei Striche von den oberen Ecken zur Mitte
    flap = [
        (ex + stroke, ey + stroke, ex + ew / 2, ey + eh * 0.52),
        (ex + ew - stroke, ey + stroke, ex + ew / 2, ey + eh * 0.52),
    ]
    flap_w = stroke * 0.85

    # Kontenkante links
    spine_x, spine_w = s(96), s(24)
    spine_top, spine_h = s(178), s(156)
    seg_h = spine_h / 3
    spine_shape = rounded_rect(spine_x, spine_top, spine_w, spine_h, s(12))

    rows = []
    for py in range(W):
        row = bytearray()
        for px in range(W):
            fx, fy = px + 0.5, py + 0.5
            if not card(fx, fy):
                row += b'\x00\x00\x00\x00'
                continue

            color = BG
            if spine_shape(fx, fy):
                index = min(2, int((fy - spine_top) / seg_h))
                color = SPINE[index]
            elif body_outer(fx, fy) and not inner(fx, fy):
                color = FG
            elif any(seg_distance(fx, fy, *seg) <= flap_w / 2 for seg in flap):
                color = FG

            row += bytes(color) + b'\xff'
        rows.append(row)
        if py % 256 == 0:
            print(f'{py}/{W}', flush=True)
    return rows


def downsample(rows, size):
    """Kastenfilter vom vergroesserten Puffer auf die Zielkantenlaenge."""
    factor = W // size
    out = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            r = g = b = a = 0
            for dy in range(factor):
                src = rows[y * factor + dy]
                for dx in range(factor):
                    i = (x * factor + dx) * 4
                    pa = src[i + 3]
                    r += src[i] * pa
                    g += src[i + 1] * pa
                    b += src[i + 2] * pa
                    a += pa
            n = factor * factor
            if a == 0:
                row += b'\x00\x00\x00\x00'
            else:
                row += bytes((r // a, g // a, b // a, a // n))
        out.append(bytes(row))
    return out


def png_bytes(rows, size):
    raw = b''.join(b'\x00' + row for row in rows)

    def chunk(tag, data):
        return (
            struct.pack('>I', len(data))
            + tag
            + data
            + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    return png


def write_ico(path, images):
    """
    ICO mit PNG-komprimierten Eintraegen. Das versteht Windows seit Vista und
    spart den umstaendlichen BMP-Weg mit separater Maske.
    """
    count = len(images)
    header = struct.pack('<HHH', 0, 1, count)
    offset = 6 + 16 * count
    entries, blobs = b'', b''
    for size, data in images:
        entries += struct.pack(
            '<BBBBHHII', size % 256, size % 256, 0, 0, 1, 32, len(data), offset
        )
        blobs += data
        offset += len(data)
    Path(path).write_bytes(header + entries + blobs)


if __name__ == '__main__':
    here = Path(__file__).parent
    rows = build()

    # 512 fuer electron-builder und Linux, die kleineren fuer die .ico -
    # Windows waehlt je nach Anzeigegroesse die passende aus.
    full = png_bytes(downsample(rows, SIZE), SIZE)
    (here / 'icon.png').write_bytes(full)

    images = [(s, png_bytes(downsample(rows, s), s)) for s in (16, 32, 48, 64, 128, 256)]
    write_ico(here / 'icon.ico', images)

    # Dasselbe Motiv fuer den Infobereich. Es landet in resources/, weil nur
    # dieses Verzeichnis mit in die fertige App wandert - build/ nicht.
    tray = here.parent / 'resources'
    tray.mkdir(exist_ok=True)
    (tray / 'tray.png').write_bytes(dict(images)[16])
    (tray / 'tray@2x.png').write_bytes(dict(images)[32])

    print('geschrieben: icon.png (512), icon.ico (16-256), resources/tray.png')
