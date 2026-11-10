import sys, cv2, glob, os, json
pages = sys.argv[1]
for path in glob.glob(f'{pages}/*photo*.png'):
    name = os.path.basename(path)[:-4]
    img = cv2.imread(path)
    h, w = img.shape[:2]
    k = 360 / max(w, h)
    small = cv2.resize(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), (round(w * k), round(h * k)), interpolation=cv2.INTER_AREA)
    small.tofile(f'{pages}/{name}.gray')
    json.dump({'w': small.shape[1], 'h': small.shape[0], 'k': k}, open(f'{pages}/{name}.gray.json', 'w'))
