// Reads .zip archives — EPUB, DOCX and zipped FB2 are all zips. The central directory says where each
// file sits; stored files are sliced out, deflated ones go through the browser's DecompressionStream.

const LIMIT = 256 * 1024 * 1024; // no single file inside a book unpacks bigger than this (zip bombs)

const u16 = (b, at) => b[at] | (b[at + 1] << 8);
const u32 = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

export const isZip = (bytes) => bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;

function endOfDirectory(bytes) {
  const stop = Math.max(0, bytes.length - 22 - 65535);
  for (let at = bytes.length - 22; at >= stop; at--) {
    if (u32(bytes, at) === 0x06054b50) return at;
  }
  throw new Error('zip: no central directory');
}

async function inflate(data) {
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > LIMIT) {
      await reader.cancel();
      throw new Error('zip: a file inside is too big');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** { names, has(name), read(name) → Uint8Array, text(name) → string }; names are case-sensitive paths. */
export function openZip(bytes) {
  const end = endOfDirectory(bytes);
  const count = u16(bytes, end + 10);
  let at = u32(bytes, end + 16);
  if (at === 0xffffffff) throw new Error('zip: ZIP64 archives are not supported');
  const decoder = new TextDecoder('utf-8');
  const entries = new Map();
  for (let i = 0; i < count && u32(bytes, at) === 0x02014b50; i++) {
    const nameLength = u16(bytes, at + 28);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    entries.set(name, {
      method: u16(bytes, at + 10),
      compressed: u32(bytes, at + 20),
      offset: u32(bytes, at + 42),
    });
    at += 46 + nameLength + u16(bytes, at + 30) + u16(bytes, at + 32);
  }
  const lower = new Map([...entries.keys()].map((name) => [name.toLowerCase(), name]));
  const resolve = (name) => (entries.has(name) ? name : lower.get(String(name).toLowerCase()));

  async function read(name) {
    const entry = entries.get(resolve(name));
    if (!entry) throw new Error(`zip: no ${name}`);
    const local = entry.offset;
    if (u32(bytes, local) !== 0x04034b50) throw new Error(`zip: ${name} is damaged`);
    const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
    const data = bytes.subarray(start, start + entry.compressed);
    if (entry.method === 0) return data;
    if (entry.method === 8) return inflate(data);
    throw new Error(`zip: ${name} is packed in an unknown way (${entry.method})`);
  }

  return {
    names: [...entries.keys()],
    has: (name) => resolve(name) !== undefined,
    read,
    text: async (name) => new TextDecoder('utf-8').decode(await read(name)),
  };
}

/** "OEBPS/text/ch1.xhtml" + "../images/a%20b.png" → "OEBPS/images/a b.png" (no "#fragment"). */
export function joinPath(base, href) {
  let target = String(href ?? '').split('#')[0];
  try {
    target = decodeURIComponent(target);
  } catch {
    // keep it as it is
  }
  const parts = target.startsWith('/') ? [] : base.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}
