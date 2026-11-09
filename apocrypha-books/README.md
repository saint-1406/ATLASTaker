# ATLAS Apocrypha — collection

Books in the public domain for the ATLAS Notetaker app (the Apocrypha tab). The app reads `catalog.json`
and downloads the files from here; each download is checked against the SHA-256 in the list.

- `books/` — the books, exactly as they were published (not changed in any way)
- `covers/` — their cover pictures, taken from the books themselves
- `catalog.json` — title, author, language, size, SHA-256, source and rights of each book

15 of the 15 books come from [Project Gutenberg](https://www.gutenberg.org). They are distributed free of charge, unchanged, with the Project Gutenberg License inside each file. They are in the public domain in the USA; check the copyright laws of your country before using them.

This folder is made by `scripts/books-catalog.mjs` (`node scripts/books-catalog.mjs <folder with books> apocrypha-books`).
