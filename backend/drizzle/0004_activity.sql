CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  machine_id INTEGER NOT NULL CHECK (machine_id BETWEEN 1 AND 4),
  type TEXT NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data))
);

CREATE INDEX events_at ON events (at);

CREATE TABLE samples (
  at INTEGER NOT NULL,
  machine_id INTEGER NOT NULL CHECK (machine_id BETWEEN 1 AND 4),
  utilization INTEGER,
  hbm INTEGER,
  busy INTEGER,
  PRIMARY KEY (at, machine_id)
);
