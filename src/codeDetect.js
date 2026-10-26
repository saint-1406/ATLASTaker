// Decides whether pasted text is code and guesses its language, so a paste can become a fenced block.
// Deliberately conservative: prose, lists and single lines are left alone.

const SIGNS = {
  typescript: [
    /:\s*(string|number|boolean|void|any|unknown|never)\b/,
    /\binterface\s+\w+\s*\{/,
    /\btype\s+\w+\s*=/,
    /\bas\s+const\b/,
    /\b(public|private|protected|readonly)\s+\w+\s*[:(]/,
    /<\w+(\[\])?>\s*\(/,
  ],
  javascript: [
    /\b(const|let|var)\s+[\w{[]/,
    /=>/,
    /\bfunction\s*\w*\s*\(/,
    /\bconsole\.\w+\(/,
    /\b(import|export)\s+.*\bfrom\s+['"]/,
    /\brequire\(['"]/,
    /;\s*$/m,
    /\bawait\b|\basync\s+(function|\()/,
    /\b(document|window)\.\w+/,
  ],
  python: [
    /^\s*def \w+\(.*\)\s*(->\s*[\w[\], ]+)?:\s*$/m,
    /^\s*(from [\w.]+ )?import [\w., ]+$/m,
    /^\s*class \w+(\(.*\))?:\s*$/m,
    /\bself\b/,
    /^\s*(if|elif|for|while|with|try|except)\b.*:\s*$/m,
    /\bprint\(/,
    /\b(None|True|False)\b/,
    /^\s*@\w+/m,
  ],
  powershell: [
    /\$\w+\s*=/,
    /\b(Get|Set|New|Remove|Invoke|Write|Import|Start|Stop|Add|Test)-[A-Z]\w+/,
    /\|\s*(Where|Select|ForEach|Sort)-Object/,
    /\s-(eq|ne|lt|gt|le|ge|like|match|contains)\s/,
    /\[(string|int|bool|array|hashtable)\]/i,
    /\$_\b|\$PSScriptRoot|\$env:/,
  ],
  bash: [
    /^\s*(sudo|apt(-get)?|yum|brew|cd|ls|echo|export|chmod|chown|grep|curl|wget|git|npm|npx|pip|docker|kubectl)\s/m,
    /\$\{\w+\}|\$\(/,
    /\|\s*(grep|awk|sed|xargs|sort|head|tail|wc)\b/,
    /^\s*(fi|done|esac)\s*$/m,
    /\s&&\s|\s\|\|\s/,
    /^\s*(if|for|while)\s.*;\s*(then|do)\s*$/m,
  ],
  sql: [
    /\bSELECT\b[\s\S]+?\bFROM\b/i,
    /\bINSERT\s+INTO\b/i,
    /\bUPDATE\s+\w+\s+SET\b/i,
    /\bCREATE\s+(TABLE|INDEX|VIEW)\b/i,
    /\bWHERE\b.+(=|<|>|\bLIKE\b|\bIN\b)/i,
    /\b(LEFT|INNER|RIGHT)?\s*JOIN\b.+\bON\b/i,
    /\b(GROUP|ORDER)\s+BY\b/i,
  ],
  css: [
    /^[^{}\n]+\{\s*$/m,
    /^\s*[\w-]+\s*:\s*[^;]+;\s*$/m,
    /@media|@import|@keyframes|@font-face/,
    /#[0-9a-f]{3,8}\b/i,
    /\b\d+(px|rem|em|vh|vw)\b/,
  ],
  html: [
    /<\/?(div|span|p|a|ul|ol|li|html|head|body|section|button|input|script|style|table|tr|td)\b[^>]*>/i,
    /<!doctype html>/i,
    /\b(class|href|src|id)="/,
  ],
  csharp: [
    /\busing\s+System/,
    /\bnamespace\s+[\w.]+/,
    /\bpublic\s+(static\s+)?(class|void|async|int|string|bool)\b/,
    /\bConsole\.Write/,
    /\bvar\s+\w+\s*=\s*new\b/,
    /\b(string|int|bool)\s+\w+\s*=/,
  ],
  java: [
    /\bpublic\s+class\b/,
    /\bSystem\.out\.print/,
    /\bpublic\s+static\s+void\s+main/,
    /\bimport\s+java\./,
    /@Override/,
  ],
  go: [
    /^package\s+\w+/m,
    /\bfunc\s+(\(\w+ \*?\w+\)\s*)?\w+\(/,
    /:=/,
    /\bfmt\.\w+\(/,
    /\berr\s*!=\s*nil\b/,
  ],
  rust: [
    /\bfn\s+\w+\s*(<.*>)?\(/,
    /\blet\s+mut\b/,
    /\bimpl\b/,
    /\b(println|vec|format)!\(/,
    /\bpub\s+(fn|struct|enum)\b/,
    /\w::\w/,
  ],
  cpp: [
    /^#include\s*[<"]/m,
    /\bstd::/,
    /\bint\s+main\s*\(/,
    /\bcout\s*<</,
  ],
  php: [
    /<\?php/,
    /\$\w+->\w+/,
    /\bfunction\s+\w+\s*\(\$/,
  ],
};

const CODE_CHARS = /[{}()[\];=<>$:#|&*/\\"'`@]/g;
const YAML_LINE_RE = /^\s*(-\s+)?[\w.-]+:(\s|$)|^\s*-\s+\S/;

function isJson(text) {
  if (text.length > 2_000_000) return false;
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object';
  } catch {
    return false;
  }
}

export function detectLanguage(text) {
  return guess(text).lang;
}

/** { lang, score }: score counts the distinct signs found; certain markers (JSON, shebangs) score Infinity. */
function guess(text) {
  const trimmed = text.trim();
  const sure = (lang) => ({ lang, score: Infinity });
  if (!trimmed) return { lang: null, score: 0 };
  if (/^[[{]/.test(trimmed) && isJson(trimmed)) return sure('json');
  if (/^<\?xml/.test(trimmed)) return sure('xml');
  if (/^<\?php/.test(trimmed)) return sure('php');
  if (/^#!.*\b(ba|z)?sh\b/.test(trimmed)) return sure('bash');
  if (/^#!.*\bpython/.test(trimmed)) return sure('python');
  if (/^#!.*\bnode\b/.test(trimmed)) return sure('javascript');

  const sample = trimmed.slice(0, 6000);
  const scores = {};
  for (const [lang, patterns] of Object.entries(SIGNS)) {
    scores[lang] = patterns.reduce((n, re) => n + (re.test(sample) ? 1 : 0), 0);
  }
  if (scores.typescript > 0 && scores.javascript > 0) scores.typescript += scores.javascript;

  let best = null;
  let bestScore = 1;
  for (const [lang, score] of Object.entries(scores)) {
    if (score > bestScore) { best = lang; bestScore = score; }
  }
  if (best) return { lang: best, score: bestScore };

  // YAML needs nesting (a bare "key:" parent or indented keys); a flat "- Buy: milk" list is just a list.
  const lines = sample.split('\n').filter((l) => l.trim());
  const yamlShaped = lines.filter((l) => YAML_LINE_RE.test(l)).length / lines.length >= 0.8;
  const nested = /^[\w.-]+:\s*$/m.test(sample) || /^\s{2,}[\w.-]+:\s/m.test(sample);
  if (lines.length >= 2 && yamlShaped && nested) return { lang: 'yaml', score: 3 };
  return { lang: null, score: 0 };
}

/** null — paste as is; { lang } — wrap in a fenced block (lang may be '' when only the shape says "code"). */
export function classifyPaste(raw) {
  const text = raw.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  if (!text.includes('\n')) return null;
  if (/^\s*(```|~~~)/m.test(text)) return null;

  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return null;

  const proseLines = lines.filter((l) => /[.!?…]["»”)]?\s*$/.test(l.trim()) && l.trim().split(/\s+/).length > 6).length;
  if (proseLines / lines.length > 0.4) return null;

  const symbols = (text.match(CODE_CHARS) ?? []).length / text.length;
  const indented = lines.filter((l) => /^(\t| {2,})\S/.test(l)).length / lines.length;

  // keyword-heavy languages (SQL, YAML) carry few symbols, so three distinct signs are enough on their own
  const { lang, score } = guess(text);
  if (lang && (symbols >= 0.03 || indented >= 0.2 || score >= 3)) return { lang };
  if (!lang && symbols >= 0.08 && indented >= 0.25) return { lang: '' };
  return null;
}
