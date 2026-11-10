"""Runs the prototype on every page from gen.py: character error rate, orientation found, time.

python evaluate.py <models> <pages> [det_size] — also writes <pages>/<name>.ocr.json for the JS tests.
"""
import glob
import json
import os
import sys

import cv2

sys.path.insert(0, os.path.dirname(__file__))
from ocr import Ocr  # noqa: E402

models, pages = sys.argv[1], sys.argv[2]
det_size = int(sys.argv[3]) if len(sys.argv) > 3 else 1280
ocr = Ocr(models, det_size=det_size)


def lev(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


norm = lambda s: ' '.join(s.split())
total_e = total_n = 0
for path in sorted(glob.glob(f'{pages}/*.png')):
    name = os.path.basename(path)[:-4]
    if name.endswith('photo') or name.endswith('photo-dim'):
        continue  # these need the page cut out first (the JS edge detector + warp): see flatten.py
    rgb = cv2.cvtColor(cv2.imread(path), cv2.COLOR_BGR2RGB)
    res = ocr.run(rgb)
    with open(f'{pages}/{name}.ocr.json', 'w', encoding='utf-8') as f:
        json.dump(res, f, ensure_ascii=False, default=float)
    items = sorted(res['items'], key=lambda it: (round(it['box'][0][1] / 30), it['box'][0][0]))
    got = norm(' '.join(it['text'] for it in items))
    truth = norm(open(f'{pages}/{name}.txt', encoding='utf-8').read())
    e = lev(got, truth)
    total_e += e
    total_n += len(truth)
    t = res['timings']
    print(f"{name:16} rot={res['rotation']:3} enh={int(res['enhanced'])} lines={len(items):3} CER={e / len(truth):6.2%}  "
          + ' '.join(f'{k}={v * 1000:.0f}ms' for k, v in t.items()))
print(f'overall CER {total_e / total_n:.2%} (det_size {det_size})')
