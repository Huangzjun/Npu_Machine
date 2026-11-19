import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import worker from '../dist/server/index.js';

const schema = readFileSync(new URL('../drizzle/0001_initial.sql', import.meta.url), 'utf8');
const owner = 'a'.repeat(64);
const outsider = 'b'.repeat(64);
const collector = 'c'.repeat(64);

function database() {
  const connection = new DatabaseSync(':memory:');
  connection.exec(schema);
  connection.exec(readFileSync(new URL('../drizzle/0002_employee_suffix.sql', import.meta.url), 'utf8'));
  connection.exec(readFileSync(new URL('../drizzle/0003_employee.sql', import.meta.url), 'utf8'));
  return {
    connection,
    prepare(sql) {
      const statement = connection.prepare(sql);
      function bound(parameters) {
        return {
          execute() {
            if (sql.trimStart().startsWith('SELECT')) return { results: statement.all(...parameters) };
            return { meta: statement.run(...parameters) };
          },
          async run() { return this.execute(); },
        };
      }
      return { ...bound([]), bind: (...parameters) => bound(parameters) };
    },
    async batch(statements) {
      connection.exec('BEGIN');
      try {
        const result = statements.map(statement => statement.execute());
        connection.exec('COMMIT');
        return result;
      } catch (error) {
        connection.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function app(extra = {}) {
  const db = database();
  async function call(path, method = 'GET', payload, headers = {}) {
    return worker.fetch(new Request('https://board.example' + path, {
      method, headers: { ...(payload && { 'content-type': 'application/json' }), ...headers },
      body: payload ? JSON.stringify(payload) : undefined,
    }), { DB: db, COLLECTOR_TOKEN_1: collector, ...extra });
  }
  const reserve = (team, cards, key = owner, machineId = 1) => call('/api/reservations', 'POST',
    { machineId, team, cards, employee: 'EMP00123', endsAt: Date.now() + 3_600_000 }, { 'x-board-key': key });
  return { db, call, reserve };
}

test('anonymous board lists four hosts and never includes private metrics fields', async () => {
  const { call } = app();
  assert.equal((await call('/')).status, 200);
  const body = { cpu: 68, memory: 21, disk: 31, hostname: 'private.host', cards: [
    { id: 0, utilization: 0, hbmUsed: 4800, hbmTotal: 98304, processes: 2, processName: 'private' },
  ] };
  assert.equal((await call('/api/ingest/1', 'POST', body)).status, 401);
  assert.equal((await call('/api/ingest/2', 'POST', body, { authorization: 'Bearer ' + collector })).status, 401);
  assert.equal((await call('/api/ingest/1', 'POST', body, { authorization: 'Bearer ' + collector })).status, 204);
  const response = await call('/api/board');
  const text = await response.text();
  assert.doesNotMatch(text, /private|token|hash/i);
  const { machines } = JSON.parse(text);
  assert.equal(machines.length, 4);
  assert.equal(machines[0].status, 'online');
  assert.equal(machines[0].metrics.cards[0].processes, 2);
  assert.equal(machines[0].metrics.cards[0].utilization, 0);
});

test('exclusive reservations support free-form team, multiple cards and whole-machine conflicts', async () => {
  const { call, reserve } = app();
  const concurrent = await Promise.all([reserve('多模态组', [0, 1]), reserve('另一个队', [1], outsider)]);
  assert.deepEqual(concurrent.map(response => response.status).sort(), [201, 409]);
  assert.equal((await reserve('整机组', 'all', outsider)).status, 409);
  assert.equal((await reserve('整机组', 'all', outsider, 2)).status, 201);
  assert.equal((await reserve('另一组', [6], owner, 2)).status, 409);
  assert.equal((await reserve('其他组', [7])).status, 201);
  assert.equal((await reserve('超出编号', [8])).status, 400);
  const json = await (await call('/api/board')).json();
  assert.equal(json.machines[0].reservations.length, 2);
  assert.equal(json.machines[1].reservations[0].cards.length, 8);
  assert.equal(json.machines[1].reservations[0].employee, 'EMP00123');
  assert.equal(json.machines[1].reservations[0].employeeSuffix, '0123');
});

test('only the original browser can extend or release, and expired reservations free cards', async () => {
  const { call, reserve, db } = app();
  const { id } = await (await reserve('A 团队', [2])).json();
  const path = '/api/reservations/' + id;
  const next = { endsAt: Date.now() + 7_200_000 };
  assert.equal((await call(path, 'DELETE', null, { 'x-board-key': outsider })).status, 409);
  assert.equal((await call(path, 'PATCH', next, { 'x-board-key': owner })).status, 204);
  assert.equal((await call(path, 'PATCH', next, { 'x-board-key': owner })).status, 409);
  assert.equal((await call(path, 'DELETE', null, { 'x-board-key': owner })).status, 204);
  const second = await (await reserve('B 团队', [2])).json();
  db.connection.prepare('UPDATE reservations SET ends_at = ? WHERE id = ?').run(Date.now() - 1, second.id);
  assert.deepEqual((await (await call('/api/board')).json()).machines[0].reservations, []);
  assert.equal((await reserve('C 团队', [2])).status, 201);
});

test('a stale machine is distinct from a machine awaiting its first sample', async () => {
  const { db, call } = app();
  db.connection.prepare('INSERT INTO snapshots VALUES (1, ?, ?)').run(Date.now() - 91_000, '{"cards":[]}');
  assert.deepEqual((await (await call('/api/board')).json()).machines.map(machine => machine.status),
    ['stale', 'pending', 'pending', 'pending']);
});


test('relay snapshots require a valid machine signature and fresh timestamp', async t => {
  const timestamp = Date.now() - 1000;
  const sample = JSON.stringify({ cpu: 42, cards: [{ id: 0, processes: 2 }] });
  const signature = createHmac('sha256', Buffer.from(collector, 'hex')).update(timestamp + '\n' + sample).digest('hex');
  const { call } = app({
    COLLECTOR_RELAY_URL: 'https://relay.example/v1/metrics',
    RELAY_TOKEN_1: collector,
    RELAY_TOKEN_2: outsider,
    RELAY_TOKEN_3: collector,
  });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ records: [
    { machine: 1, timestamp, sample, signature },
    { machine: 2, timestamp, sample, signature },
    { machine: 3, timestamp: timestamp - 100_000, sample, signature },
  ] }));
  const { machines } = await (await call('/api/board')).json();
  assert.equal(machines[0].status, 'online');
  assert.equal(machines[0].metrics.cards[0].processes, 2);
  assert.equal(machines[1].status, 'pending');
  assert.equal(machines[2].status, 'pending');
});

test('GitHub Pages can use board and reservation APIs without exposing ingest cross origin', async () => {
  const origin = 'https://huangzjun.github.io';
  const { call } = app({ PAGES_ORIGIN: origin });
  const preflight = await call('/api/reservations', 'OPTIONS', null, { origin });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  const result = await call('/api/reservations', 'POST', {
    machineId: 1, team: 'Pages 测试', employee: 'test003', cards: [0], endsAt: Date.now() + 120_000,
  }, { origin, 'x-board-key': owner });
  assert.equal(result.status, 201);
  assert.equal(result.headers.get('access-control-allow-origin'), origin);
  assert.equal((await call('/api/ingest/1', 'OPTIONS', null, { origin })).headers.get('access-control-allow-origin'), null);
  assert.equal((await call('/api/reservations', 'POST', {}, { origin: 'https://other.github.io' })).status, 403);
});
