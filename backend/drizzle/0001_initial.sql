CREATE TABLE snapshots (
  machine_id INTEGER PRIMARY KEY CHECK (machine_id BETWEEN 1 AND 4),
  received_at INTEGER NOT NULL,
  sample TEXT NOT NULL CHECK (json_valid(sample))
);

CREATE TABLE reservations (
  id TEXT PRIMARY KEY,
  machine_id INTEGER NOT NULL CHECK (machine_id BETWEEN 1 AND 4),
  team TEXT NOT NULL,
  cards TEXT NOT NULL CHECK (json_valid(cards)),
  key_hash TEXT NOT NULL,
  ends_at INTEGER NOT NULL
);

CREATE INDEX reservations_expiry ON reservations (ends_at);
CREATE INDEX reservations_machine_expiry ON reservations (machine_id, ends_at);
