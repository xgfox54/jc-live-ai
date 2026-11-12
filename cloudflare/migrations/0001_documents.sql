CREATE TABLE documents (
  path TEXT PRIMARY KEY NOT NULL,
  etag TEXT NOT NULL,
  body BLOB NOT NULL,
  updated_ms INTEGER NOT NULL,
  CHECK(length(body) <= 1900000)
);
