"""Synthetic test pages for the scanner: Russian, English, mixed; rotated, dim, photographed in perspective.

Writes <out>/<name>.png (the picture), <name>.txt (the truth, a paragraph per line) and, for the
photographed ones, <name>.quad.json (where the page's corners are, for the edge detector's test).
"""
import json
import os
import random
import sys

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
FONTS = 'C:/Windows/Fonts/'

RU = [
    'Сканер документов работает без сети: модели распознавания лежат внутри приложения, поэтому текст не покидает телефон.',
    'Съешь же ещё этих мягких французских булок, да выпей чаю. Широкая электрификация южных губерний даст мощный толчок подъёму сельского хозяйства.',
    'В 2026 году отчёт № 17 был подписан 14 марта; сумма составила 12 500 ₽, а срок — до 1 апреля.',
]
EN = [
    'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.',
    'Offline recognition keeps every page on the device: nothing is uploaded, and the scanner works in airplane mode.',
    'Invoice #4521 dated 03/14/2026 totals $1,250.00, payable within 30 days.',
]
MIXED = [
    'Версия ATLAS Notetaker 0.18.1 поддерживает формат PDF и EPUB, а также Markdown.',
    'Встреча с командой Android: обсудить API для OCR, ncnn и модели PaddleOCR v5.',
    'Пароль от Wi-Fi в офисе: смотрите README.md в репозитории на GitHub.',
]


def wrap(draw, text, font, width):
    words, lines, cur = text.split(), [], ''
    for w in words:
        test = (cur + ' ' + w).strip()
        if draw.textlength(test, font=font) <= width:
            cur = test
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def page(paragraphs, font='arial.ttf', size=34, w=1654, h=2339, margin=140, title=None):
    img = Image.new('RGB', (w, h), (250, 249, 245))
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(FONTS + font, size)
    y = margin
    if title:
        tf = ImageFont.truetype(FONTS + font.replace('.ttf', 'bd.ttf') if os.path.exists(FONTS + font.replace('.ttf', 'bd.ttf')) else FONTS + font, int(size * 1.5))
        d.text((margin, y), title, font=tf, fill=(20, 20, 20))
        y += int(size * 3)
    for p in paragraphs:
        for line in wrap(d, p, f, w - 2 * margin):
            d.text((margin, y), line, font=f, fill=(25, 25, 30))
            y += int(size * 1.45)
        y += int(size * 0.9)
    truth = ([title] if title else []) + paragraphs
    return np.array(img), truth


def photo(rgb, seed, dim=False):
    """The page on a table, shot at an angle: returns the photo and the page corners in it."""
    rnd = random.Random(seed)
    h, w = rgb.shape[:2]
    W, H = 3000, 4000
    bg = np.full((H, W, 3), (70, 62, 55), np.uint8)
    noise = np.random.default_rng(seed).integers(0, 25, (H, W, 1), dtype=np.uint8)
    bg = cv2.add(bg, np.repeat(noise, 3, 2))
    j = lambda: rnd.uniform(-180, 180)
    dst = np.array([[380 + j(), 420 + j()], [2620 + j(), 380 + j()], [2700 + j(), 3600 + j()], [300 + j(), 3550 + j()]], np.float32)
    m = cv2.getPerspectiveTransform(np.array([[0, 0], [w, 0], [w, h], [0, h]], np.float32), dst)
    warped = cv2.warpPerspective(rgb, m, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_TRANSPARENT, dst=bg.copy())
    # light falls off across the sheet
    yy, xx = np.mgrid[0:H, 0:W]
    shade = 1 - 0.25 * (xx / W) - 0.15 * (yy / H)
    out = (warped * shade[..., None]).clip(0, 255)
    if dim:
        out = out * 0.32 + np.random.default_rng(seed + 1).normal(0, 6, out.shape)
    out = cv2.GaussianBlur(out.clip(0, 255).astype(np.uint8), (3, 3), 0.8)
    return out, dst


def dimmed(rgb, seed):
    out = rgb.astype(np.float32) * 0.3 + 8 + np.random.default_rng(seed).normal(0, 5, rgb.shape)
    return out.clip(0, 255).astype(np.uint8)


def save(name, rgb, truth, quad=None):
    cv2.imwrite(f'{OUT}/{name}.png', cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
    with open(f'{OUT}/{name}.txt', 'w', encoding='utf-8') as f:
        f.write('\n'.join(truth))
    if quad is not None:
        with open(f'{OUT}/{name}.quad.json', 'w') as f:
            json.dump({'width': rgb.shape[1], 'height': rgb.shape[0], 'quad': quad.round(1).tolist()}, f)


ru, ru_t = page(RU, title='Отчёт о сканировании')
en, en_t = page(EN, font='times.ttf', size=38, title='Scanning report')
mx, mx_t = page(MIXED, font='calibri.ttf', size=36, title='Заметки: OCR и Android')
save('ru-flat', ru, ru_t)
save('en-flat', en, en_t)
save('mixed-flat', mx, mx_t)
save('ru-rot90', cv2.rotate(ru, cv2.ROTATE_90_CLOCKWISE), ru_t)
save('en-rot180', cv2.rotate(en, cv2.ROTATE_180), en_t)
save('mixed-rot270', cv2.rotate(mx, cv2.ROTATE_90_COUNTERCLOCKWISE), mx_t)
save('ru-dim', dimmed(ru, 3), ru_t)
save('en-dim', dimmed(en, 4), en_t)
p, q = photo(ru, 5)
save('ru-photo', p, ru_t, q)
p, q = photo(mx, 6, dim=True)
save('mixed-photo-dim', p, mx_t, q)
# two columns
col_l, _ = page(RU[:2], w=800, margin=60, size=30)
col_r, _ = page(EN[:2], w=800, margin=60, size=30)
two = np.full((2339, 1654, 3), 250, np.uint8)
two[:, :800] = col_l
two[:, 854:1654] = col_r
save('columns', two, RU[:2] + EN[:2])
# a multi-page document: three pages
for i, (img, tr) in enumerate([(ru, ru_t), (en, en_t), (mx, mx_t)]):
    save(f'multi-{i + 1}', img, tr)
print('ok')
