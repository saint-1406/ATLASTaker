-- Apocrypha: the catalogue of books and documents ATLAS users share. The files themselves stay on
-- the Google Drive of whoever shared them; this is only the list. Applied by
-- `wrangler d1 execute apocrypha --remote --file schema.sql` (safe to run again).

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,               -- our own short id
  drive_id TEXT NOT NULL UNIQUE,     -- the file on its owner's Google Drive
  sha256 TEXT NOT NULL UNIQUE,       -- one copy of each file in the catalogue
  size INTEGER NOT NULL,
  format TEXT NOT NULL,              -- pdf, epub, fb2, docx, odt, rtf, cbz, txt, md, html
  title TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL DEFAULT 'und',  -- ru, en, … or und
  kind TEXT NOT NULL,                -- book, document, comic
  description TEXT NOT NULL DEFAULT '',
  cover TEXT,                        -- a small data: URL picture, or NULL
  owner TEXT NOT NULL,               -- the owner's Drive permissionId (no email is kept)
  created INTEGER NOT NULL,          -- ms since 1970
  downloads INTEGER NOT NULL DEFAULT 0,
  reports INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0, -- 1: hidden by the app's owner; 2: the file is gone from Drive
  search TEXT NOT NULL               -- title and author, lower case, ё as е: what the search looks through
);

CREATE INDEX IF NOT EXISTS files_new ON files (hidden, created DESC);
CREATE INDEX IF NOT EXISTS files_popular ON files (hidden, downloads DESC);
CREATE INDEX IF NOT EXISTS files_owner ON files (owner);
CREATE INDEX IF NOT EXISTS files_reports ON files (reports DESC);

CREATE TABLE IF NOT EXISTS reports (
  file_id TEXT NOT NULL,
  reporter TEXT NOT NULL,            -- a salted hash of the address it came from
  reason TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL,
  PRIMARY KEY (file_id, reporter)
);

-- how many requests of each kind an address made in each window (rate limits)
CREATE TABLE IF NOT EXISTS hits (
  key TEXT NOT NULL,
  window INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (key, window)
);
