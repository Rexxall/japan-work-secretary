"""Japan Work Secretary README demo: add a Friday evening shift to a 27-hour week and see the 28-hour warning.

    python3 demo_jws.py <frames dir> <light|dark> <out.gif>
"""
import os
import json, sys
from pathlib import Path
from PIL import Image
sys.path.insert(0, os.environ.get('README_KIT', str(Path(__file__).parent)))  # folder with the shared make_demo.py
from make_demo import Film, smooth, ACCENT, RED, SCALE

def load(d):
    d = Path(d)
    boxes = {k: [v * SCALE for v in b] for k, b in json.loads((d / 'boxes.json').read_text()).items()}
    shots = {}
    for f in sorted(d.glob('*.png')):
        shots.setdefault(f.stem.split('-', 1)[1], []).append(Image.open(f).convert('RGB'))
    return boxes, shots

def centre(b):
    return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)

def main(frames, mode, out):
    boxes, shots = load(frames)
    start, modal, s18, e20 = shots['start'][0], shots['modal'][0], shots['start18'][0], shots['end20'][0]
    film = Film(mode, start.size)
    side = film.cam(1248, 110, start.width - 1248)
    dialog = film.around([760, 320, 1780, 1240], 1500)
    add, st, en = centre(boxes['add']), centre(boxes['start']), centre(boxes['end'])
    enter = (start.width - 300, 1300)

    film.add(start, side, 900)
    film.add(start, side, 1200, ring=boxes['peak'], ring_color=ACCENT[mode])
    for k in range(1, 11):
        film.add(start, side, 35, cursor=film.mix(enter, add, smooth(k / 10)))
    for k in range(4):
        film.add(start, side, 45, cursor=add, ripple=(*add, k / 3))
    for k in range(1, 11):
        film.add(modal, film.mix(side, dialog, smooth(k / 10)), 45, cursor=add)
    film.add(modal, dialog, 600, cursor=add)
    for k in range(1, 9):
        film.add(modal, dialog, 35, cursor=film.mix(add, st, smooth(k / 8)))
    for k in range(3):
        film.add(modal, dialog, 45, cursor=st, ripple=(*st, k / 2))
    film.add(s18, dialog, 500, cursor=st)
    for k in range(1, 9):
        film.add(s18, dialog, 35, cursor=film.mix(st, en, smooth(k / 8)))
    for k in range(3):
        film.add(s18, dialog, 45, cursor=en, ripple=(*en, k / 2))
    film.add(e20, dialog, 600, cursor=en)
    for k in range(3):
        film.add(e20, dialog, 150, cursor=en, ring=boxes['warn'], ring_color=RED[mode] if k % 2 == 0 else ACCENT[mode])
    film.add(e20, dialog, 2000, cursor=en, ring=boxes['warn'], ring_color=RED[mode])
    for k in range(1, 9):
        film.add(e20, film.mix(dialog, film.full, smooth(k / 8)), 55)
    film.add(e20, film.full, 2200)
    film.save(out)

if __name__ == '__main__':
    main(*sys.argv[1:4])
