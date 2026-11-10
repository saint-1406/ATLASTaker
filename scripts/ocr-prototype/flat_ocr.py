import sys, os, json, cv2, numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from ocr import Ocr
sys.stdout.reconfigure(encoding='utf-8')
def lev(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]
models, pages = sys.argv[1], sys.argv[2]
ocr = Ocr(models, det_size=960)
for name in ['ru-photo', 'mixed-photo-dim']:
    img = cv2.cvtColor(cv2.imread(f'{pages}/{name}.png'), cv2.COLOR_BGR2RGB)
    q = np.array(json.load(open(f'{pages}/{name}.found.json')), np.float32)
    w = int(max(np.linalg.norm(q[1]-q[0]), np.linalg.norm(q[2]-q[3]))); h = int(max(np.linalg.norm(q[3]-q[0]), np.linalg.norm(q[2]-q[1])))
    k = min(1, 2400 / max(w, h)); w, h = int(w*k), int(h*k)
    m = cv2.getPerspectiveTransform(q, np.array([[0,0],[w,0],[w,h],[0,h]], np.float32))
    flat = cv2.warpPerspective(img, m, (w, h), flags=cv2.INTER_LINEAR)
    cv2.imwrite(f'{pages}/{name}.flat.png', cv2.cvtColor(flat, cv2.COLOR_RGB2BGR))
    res = ocr.run(flat)
    json.dump(res, open(f'{pages}/{name}.ocr.json', 'w', encoding='utf-8'), ensure_ascii=False, default=float)
    items = sorted(res['items'], key=lambda it: (round(it['box'][0][1] / 30), it['box'][0][0]))
    got = ' '.join(' '.join(it['text'] for it in items).split())
    truth = ' '.join(open(f'{pages}/{name}.txt', encoding='utf-8').read().split())
    print(name, 'enhanced', res['enhanced'], 'CER', f'{lev(got, truth)/len(truth):.2%}', {k: round(v*1000) for k, v in res['timings'].items()})
    print('  ', got[:200])
