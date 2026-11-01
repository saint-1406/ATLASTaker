// fontkit, which lets pdf-lib put a font into a PDF, bundled apart (dist/fontkit.js): it is large and
// needed only when rewritten lines are written into a file (pdfedit.js loads it then).

import fontkit from '@pdf-lib/fontkit';

window.AtlasFontkit = fontkit;
