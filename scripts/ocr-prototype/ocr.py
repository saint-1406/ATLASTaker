"""Prototype of the ATLAS scanner's native OCR pipeline (mirrors android/app/src/main/cpp/atlas_ocr.cpp).

Not part of the app: it checks the models, the pre/post processing and
the orientation logic on a desktop, since no Android device is at hand.
"""
import math
import sys
import time

import cv2
import ncnn
import numpy as np



class Ocr:
    def __init__(self, models, det_size=1280, threads=4):
        self.det = ncnn.Net()
        self.det.opt.num_threads = threads
        self.det.load_param(f'{models}/PP_OCRv5_mobile_det.ncnn.param')
        self.det.load_model(f'{models}/PP_OCRv5_mobile_det.ncnn.bin')
        self.rec = ncnn.Net()
        self.rec.opt.num_threads = threads
        self.rec.load_param(f'{models}/eslav_ppocrv5_rec.ncnn.param')
        self.rec.load_model(f'{models}/eslav_ppocrv5_rec.ncnn.bin')
        with open(f'{models}/ppocrv5_eslav_dict.txt', encoding='utf-8') as f:
            chars = [line.rstrip('\r\n') for line in f]
        self.chars = [c for c in chars if c != ''] + [' ']
        self.det_size = det_size

    # ---------- enhancement for dim or flat photos ----------
    @staticmethod
    def enhance(rgb):
        lum = (rgb[..., 0].astype(np.uint32) * 77 + rgb[..., 1].astype(np.uint32) * 150 + rgb[..., 2].astype(np.uint32) * 29) >> 8
        hist = np.bincount(lum.ravel(), minlength=256)
        cdf = np.cumsum(hist)
        n = cdf[-1]
        lo = int(np.searchsorted(cdf, n * 0.01))
        hi = int(np.searchsorted(cdf, n * 0.99))
        mean = float((hist * np.arange(256)).sum() / n)
        # paper that is white enough needs nothing; a dim or grey shot is stretched to black..white
        if hi >= 170 and mean >= 100:
            return rgb, False
        lo = int(np.searchsorted(cdf, n * 0.005))
        hi = max(int(np.searchsorted(cdf, n * 0.995)), lo + 24)
        span = hi - lo
        gamma = 0.75 if mean < 90 else 1.0
        lut = np.clip(((np.arange(256) - lo) / span), 0, 1) ** gamma * 255
        return lut.astype(np.uint8)[rgb], True

    # ---------- detection ----------
    def detect(self, rgb):
        h, w = rgb.shape[:2]
        scale = min(1.0, self.det_size / max(w, h))
        dw, dh = max(32, int(round(w * scale / 32)) * 32), max(32, int(round(h * scale / 32)) * 32)
        sx, sy = dw / w, dh / h
        mat = ncnn.Mat.from_pixels_resize(rgb, ncnn.Mat.PixelType.PIXEL_RGB2BGR, w, h, dw, dh)
        mat.substract_mean_normalize([0.485 * 255, 0.456 * 255, 0.406 * 255], [1 / 0.229 / 255, 1 / 0.224 / 255, 1 / 0.225 / 255])
        ex = self.det.create_extractor()
        ex.input('in0', mat)
        _, out = ex.extract('out0')
        prob = np.array(out).reshape(dh, dw)
        bitmap = (prob > 0.3).astype(np.uint8) * 255
        contours, _ = cv2.findContours(bitmap, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        boxes = []
        for c in contours[:1000]:
            if len(c) < 4:
                continue
            rr = cv2.minAreaRect(c)
            if min(rr[1]) < 3:
                continue
            # the box's mean probability, as DBNet's "fast" score
            x, y, bw, bh = cv2.boundingRect(c)
            mask = np.zeros((bh, bw), np.uint8)
            cv2.fillPoly(mask, [c - [x, y]], 1)
            score = float((prob[y:y + bh, x:x + bw] * mask).sum() / max(mask.sum(), 1))
            if score < 0.6:
                continue
            # unclip: grow by area * 1.5 / perimeter on every side (PaddleOCR's unclip_ratio)
            (cx, cy), (rw, rh), ang = rr
            d = rw * rh * 1.5 / (2 * (rw + rh))
            rw, rh = rw + 2 * d, rh + 2 * d
            if min(rw, rh) < 5:
                continue
            pts = cv2.boxPoints(((cx, cy), (rw, rh), ang))
            pts[:, 0] /= sx
            pts[:, 1] /= sy
            pts[:, 0] = np.clip(pts[:, 0], 0, w - 1)
            pts[:, 1] = np.clip(pts[:, 1], 0, h - 1)
            boxes.append((order(pts), score))
        return boxes

    # ---------- recognition ----------
    def crop(self, rgb, quad, flip=False):
        tl, tr, br, bl = quad
        bw = int(round(max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl))))
        bh = int(round(max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr))))
        if bw < 2 or bh < 2:
            return None
        if bh > bw * 1.5:  # a standing box: text written downwards (or a column of one letter)
            quad = np.array([tr, br, bl, tl], np.float32)
            bw, bh = bh, bw
        th = 48
        tw = max(16, min(int(round(bw * th / bh)), 3200))
        src = np.array(quad, np.float32)
        dst = np.array([[0, 0], [tw, 0], [tw, th], [0, th]], np.float32)
        if flip:
            dst = dst[[2, 3, 0, 1]]
        m = cv2.getPerspectiveTransform(src, dst)
        return cv2.warpPerspective(rgb, m, (tw, th), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)

    def read_line(self, img):
        mat = ncnn.Mat.from_pixels(img, ncnn.Mat.PixelType.PIXEL_RGB2BGR, img.shape[1], img.shape[0])
        mat.substract_mean_normalize([127.5] * 3, [1 / 127.5] * 3)
        ex = self.rec.create_extractor()
        ex.input('in0', mat)
        _, out = ex.extract('out0')
        probs = np.array(out)
        ids = probs.argmax(1)
        best = probs.max(1)
        text, scores, last = [], [], 0
        for i, k in enumerate(ids):
            if k != 0 and k != last:
                text.append(self.chars[k - 1] if k - 1 < len(self.chars) else '')
                scores.append(best[i])
            last = k
        return ''.join(text), float(np.mean(scores)) if scores else 0.0

    # ---------- orientation ----------
    def orientation(self, rgb, boxes):
        """0, 90, 180 or 270: how far the page must turn clockwise to stand upright."""
        if not boxes:
            return 0
        standing = lying = 0.0
        for quad, _ in boxes:
            bw = np.linalg.norm(quad[1] - quad[0])
            bh = np.linalg.norm(quad[3] - quad[0])
            if bh > bw * 1.5:
                standing += bh
            elif bw > bh * 1.5:
                lying += bw
        sideways = standing > lying * 1.2
        # 0 or 180 (90 or 270 for a sideways page): the reading that the recognizer is surer of
        probe = sorted(boxes, key=lambda b: -max(np.linalg.norm(b[0][1] - b[0][0]), np.linalg.norm(b[0][3] - b[0][0])))[:4]
        up = down = 0.0
        for quad, _ in probe:
            q = quad if not sideways else np.array([quad[1], quad[2], quad[3], quad[0]], np.float32)
            a = self.crop(rgb, q)
            if a is None:
                continue
            a = np.ascontiguousarray(a[:, :480])  # a few words are enough to tell up from down
            up += self.read_line(a)[1]
            down += self.read_line(np.ascontiguousarray(a[::-1, ::-1]))[1]
        flipped = down > up + 0.03 * len(probe)
        if sideways:
            return 90 if flipped else 270
        return 180 if flipped else 0

    def run(self, rgb, auto_rotate=True):
        t = {}
        t0 = time.perf_counter()
        rgb, enhanced = self.enhance(rgb)
        t['enhance'] = time.perf_counter() - t0
        t0 = time.perf_counter()
        boxes = self.detect(rgb)
        t['det'] = time.perf_counter() - t0
        rotation = 0
        if auto_rotate:
            t0 = time.perf_counter()
            rotation = self.orientation(rgb, boxes)
            if rotation:
                rgb = rotate(rgb, rotation)
                boxes = self.detect(rgb)
            t['orient'] = time.perf_counter() - t0
        t0 = time.perf_counter()
        items = []
        for quad, s in boxes:
            img = self.crop(rgb, quad)
            if img is None:
                continue
            text, score = self.read_line(img)
            if text.strip() and score >= 0.5:
                items.append({'box': quad.round(1).tolist(), 'text': text, 'score': round(score, 3)})
        t['rec'] = time.perf_counter() - t0
        return {'items': items, 'rotation': rotation, 'enhanced': enhanced, 'width': rgb.shape[1], 'height': rgb.shape[0], 'timings': t}


def rotate(rgb, deg):
    return cv2.rotate(rgb, {90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_COUNTERCLOCKWISE}[deg])


def order(pts):
    """tl, tr, br, bl of a box whose long side lies along the text."""
    pts = np.array(pts, np.float32)
    s = pts.sum(1)
    d = pts[:, 0] - pts[:, 1]
    return np.array([pts[s.argmin()], pts[d.argmax()], pts[s.argmax()], pts[d.argmin()]], np.float32)
