import { PAGE } from './assets.mjs';

const MACHINE_HOSTS = ['195.121.29.13', '195.121.32.16', '195.121.1.17', '195.121.3.19'];
const MACHINES = MACHINE_HOSTS.map((host, i) => ({
  id: i + 1,
  name: host,
  model: 'Ascend 950DT',
  cards: Array.from({ length: 8 }, (_, card) => card),
}));
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const MAX_DURATION = DAY;
const STALE_AFTER = 90_000;
const SAMPLE_RETENTION = 7 * DAY;
const EVENT_RETENTION = 30 * DAY;
const USAGE_SLOT = 30 * MINUTE;
const RESERVATION_JSON = "json_object('team', team, 'name', name, 'cards', json(cards), 'endsAt', ends_at)";
const MACHINE_METRICS = ['cpu', 'memory', 'disk'];
const TOKEN = /^[a-f0-9]{64}$/;
const security = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

function reply(value, status = 200) {
  return Response.json(value, { status, headers: { ...security, 'cache-control': 'no-store' } });
}

function page(value) {
  // The page carries its own hash-based CSP meta tag; the default header policy would block its inline assets.
  const { 'content-security-policy': _, ...headers } = security;
  return new Response(value, {
    headers: { ...headers, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
  });
}

class ValidationError extends Error {}

async function readBody(request, limit = 16384) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new ValidationError('请求格式无效');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new ValidationError('请求内容为空');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let body = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ValidationError('请求内容过长');
      }
      body += decoder.decode(value, { stream: true });
    }
    const parsed = JSON.parse(body + decoder.decode());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError('请求内容无效');
  } finally {
    reader.releaseLock();
  }
}

function validPercent(value) {
  return typeof value === 'number' && value >= 0 && value <= 100 ? Math.round(value * 10) / 10 : null;
}

function count(value, max = 1_000_000) {
  return Number.isInteger(value) && value >= 0 && value <= max ? value : null;
}

function tokenMatches(actual, expected) {
  if (!TOKEN.test(actual ?? '') || !TOKEN.test(expected ?? '')) return false;
  let difference = 0;
  for (let i = 0; i < 64; i++) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

async function managementHash(request) {
  const token = request.headers.get('x-board-key');
  if (!TOKEN.test(token ?? '')) return null;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

function sanitizedSnapshot(body, machine) {
  if (body.cards !== null && !Array.isArray(body.cards)) {
    throw new ValidationError('NPU 指标格式无效');
  }
  const cards = body.cards?.slice(0, 64) ?? [];
  const metrics = Object.fromEntries(MACHINE_METRICS.map(key => [key, validPercent(body[key])]));
  return {
    ...metrics,
    cards: machine.cards.map(id => {
      const card = cards.find(item => item?.id === id);
      if (!card) return null;
      const hbmTotal = count(card.hbmTotal);
      const hbmUsed = count(card.hbmUsed);
      return {
        id,
        health: ['ok', 'warning'].includes(card.health) ? card.health : null,
        utilization: validPercent(card.utilization),
        hbmUsed: hbmUsed !== null && hbmTotal && hbmUsed <= hbmTotal ? hbmUsed : null,
        hbmTotal: hbmTotal || null,
        temperature: Number.isInteger(card.temperature) && card.temperature >= -40 && card.temperature <= 160 ? card.temperature : null,
        processes: count(card.processes, 10000),
      };
    }).filter(Boolean),
  };
}

async function ingest(request, env, id) {
  const machine = MACHINES.find(item => item.id === id);
  if (!machine) return reply({ error: '接口不存在' }, 404);
  const token = request.headers.get('authorization')?.match(/^Bearer +([a-f0-9]{64})$/)?.[1];
  if (!tokenMatches(token, env['COLLECTOR_TOKEN_' + id])) return reply({ error: '上报凭据无效' }, 401);
  const body = await readBody(request);
  const snapshot = sanitizedSnapshot(body, machine);
  const now = Date.now();
  const sampledAt = body.sampledAt ?? now;
  if (!Number.isSafeInteger(sampledAt) || sampledAt < now - STALE_AFTER || sampledAt > now + 10_000) {
    throw new ValidationError('采样时间无效');
  }
  const previous = await previousSnapshots(env);
  await env.DB.batch([
    ...snapshotStatements(env, id, Math.min(now, sampledAt), snapshot, previous.get(id)),
    ...pruneStatements(env, now),
  ]);
  return new Response(null, { status: 204 });
}

async function previousSnapshots(env) {
  const { results } = await env.DB.prepare('SELECT machine_id, received_at, sample FROM snapshots').all();
  return new Map(results.map(row => [row.machine_id, row]));
}

const busyCards = snapshot => snapshot.cards.filter(card => card.processes > 0).map(card => card.id);

// Events only land if this snapshot is newer than the stored one, so concurrent or replayed uploads cannot log twice.
function snapshotEvent(env, id, collectedAt, at, type, data) {
  return env.DB.prepare(
    'INSERT INTO events (at, machine_id, type, data) SELECT ?, ?, ?, ? ' +
    'WHERE NOT EXISTS (SELECT 1 FROM snapshots WHERE machine_id = ? AND received_at >= ?)'
  ).bind(at, id, type, JSON.stringify(data), id, collectedAt);
}

function snapshotStatements(env, id, collectedAt, snapshot, previous) {
  const statements = [];
  if (previous && collectedAt > previous.received_at) {
    if (collectedAt - previous.received_at >= STALE_AFTER) {
      statements.push(
        snapshotEvent(env, id, collectedAt, previous.received_at + STALE_AFTER, 'offline', {}),
        snapshotEvent(env, id, collectedAt, collectedAt, 'online', {}),
      );
    }
    const before = busyCards(JSON.parse(previous.sample));
    const after = busyCards(snapshot);
    const started = after.filter(card => !before.includes(card));
    const stopped = before.filter(card => !after.includes(card));
    if (started.length) statements.push(snapshotEvent(env, id, collectedAt, collectedAt, 'job-start', { cards: started }));
    if (stopped.length) statements.push(snapshotEvent(env, id, collectedAt, collectedAt, 'job-stop', { cards: stopped }));
  }
  const utilization = snapshot.cards.map(card => card.utilization).filter(value => value != null);
  const memory = snapshot.cards.filter(card => card.hbmUsed != null && card.hbmTotal);
  const capacity = memory.reduce((total, card) => total + card.hbmTotal, 0);
  statements.push(
    env.DB.prepare(
      'INSERT INTO samples (at, machine_id, utilization, hbm, busy) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(at, machine_id) DO UPDATE SET utilization=excluded.utilization, hbm=excluded.hbm, busy=excluded.busy'
    ).bind(
      Math.floor(collectedAt / MINUTE) * MINUTE, id,
      utilization.length ? Math.round(utilization.reduce((a, b) => a + b, 0) / utilization.length) : null,
      capacity ? Math.round(100 * memory.reduce((total, card) => total + card.hbmUsed, 0) / capacity) : null,
      snapshot.cards.length ? busyCards(snapshot).length : null,
    ),
    env.DB.prepare(
      'INSERT INTO snapshots (machine_id, received_at, sample) VALUES (?, ?, ?) ' +
      'ON CONFLICT(machine_id) DO UPDATE SET received_at=excluded.received_at, sample=excluded.sample ' +
      'WHERE excluded.received_at > snapshots.received_at'
    ).bind(id, collectedAt, JSON.stringify(snapshot)),
  );
  return statements;
}

function pruneStatements(env, now) {
  return [
    env.DB.prepare('DELETE FROM samples WHERE at < ?').bind(now - SAMPLE_RETENTION),
    env.DB.prepare('DELETE FROM events WHERE at < ?').bind(now - EVENT_RETENTION),
  ];
}

const bytesFromHex = hex => Uint8Array.from(hex.match(/../g), byte => Number.parseInt(byte, 16));

async function verifyReading(env, record, now, previous) {
  if (!record || typeof record !== 'object') return null;
  const { machine: id, timestamp, sample, signature } = record;
  const machine = MACHINES.find(item => item.id === id);
  const secret = env['RELAY_TOKEN_' + id];
  if (!machine || !TOKEN.test(secret ?? '') || !TOKEN.test(signature ?? '') ||
      !Number.isSafeInteger(timestamp) || timestamp < now - STALE_AFTER || timestamp > now + 10_000 ||
      typeof sample !== 'string' || sample.length > 16_384) return null;
  const key = await crypto.subtle.importKey('raw', bytesFromHex(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const message = new TextEncoder().encode(timestamp + '\n' + sample);
  if (!await crypto.subtle.verify('HMAC', key, bytesFromHex(signature), message)) return null;
  try {
    return snapshotStatements(env, id, timestamp, sanitizedSnapshot(JSON.parse(sample), machine), previous.get(id));
  } catch {
    return null;
  }
}

async function refreshRelay(env, now) {
  if (!env.COLLECTOR_RELAY_URL) return;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(env.COLLECTOR_RELAY_URL, {
      signal: controller.signal,
      redirect: 'manual',
    });
    if (!response.ok) {
      console.warn('Telemetry relay responded with HTTP', response.status);
      return;
    }
    const { records } = await readBody(response, 85_000);
    if (!Array.isArray(records) || records.length > MACHINES.length) return;
    const previous = await previousSnapshots(env);
    const readings = (await Promise.all(records.map(record => verifyReading(env, record, now, previous)))).filter(Boolean);
    if (readings.length) await env.DB.batch([...readings.flat(), ...pruneStatements(env, now)]);
  } catch (error) {
    const message = String(error.message || '').replaceAll(env.COLLECTOR_RELAY_URL, '[relay]').slice(0, 160);
    console.warn('Telemetry relay unavailable', error.name, message);
  } finally {
    clearTimeout(deadline);
  }
}

function expireStatements(env, now) {
  return [
    env.DB.prepare(
      `INSERT INTO events (at, machine_id, type, data) SELECT ends_at, machine_id, 'expire', ${RESERVATION_JSON} FROM reservations WHERE ends_at <= ?`
    ).bind(now),
    env.DB.prepare('DELETE FROM reservations WHERE ends_at <= ?').bind(now),
  ];
}

async function board(env, now) {
  await refreshRelay(env, now);
  const [, , snapshots, active] = await env.DB.batch([
    ...expireStatements(env, now),
    env.DB.prepare('SELECT machine_id, received_at, sample FROM snapshots'),
    env.DB.prepare('SELECT id, machine_id, team, cards, ends_at, name FROM reservations WHERE ends_at > ? ORDER BY ends_at').bind(now),
  ]);
  return reply({
    now,
    machines: MACHINES.map(machine => {
      const snapshot = snapshots.results.find(item => item.machine_id === machine.id);
      return {
        ...machine,
        receivedAt: snapshot?.received_at ?? null,
        status: !snapshot ? 'pending' : now - snapshot.received_at >= STALE_AFTER ? 'stale' : 'online',
        metrics: snapshot ? JSON.parse(snapshot.sample) : null,
        reservations: active.results.filter(item => item.machine_id === machine.id).map(item => ({
          id: item.id, team: item.team, cards: JSON.parse(item.cards), endsAt: item.ends_at,
          name: item.name,
        })),
      };
    }),
  });
}

async function activity(env, now) {
  const [, , events] = await env.DB.batch([
    ...expireStatements(env, now),
    env.DB.prepare('SELECT id, at, machine_id, type, data FROM events ORDER BY at DESC, id DESC LIMIT 200'),
  ]);
  return reply({
    now,
    events: events.results.map(row => ({ id: row.id, at: row.at, machine: row.machine_id, type: row.type, data: JSON.parse(row.data) })),
  });
}

// The page passes its local midnight so slots line up with the viewer's day.
async function usage(env, now, params) {
  const from = Number(params.get('from'));
  const to = Number(params.get('to'));
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to <= from || to - from > DAY + 60 * MINUTE ||
      from < now - SAMPLE_RETENTION - DAY || from > now) {
    throw new ValidationError('统计时间范围无效');
  }
  const [cells, summary, peak, counts] = await env.DB.batch([
    env.DB.prepare(
      'SELECT CAST((at - ?) / ? AS INTEGER) AS slot, machine_id, ROUND(AVG(utilization)) AS utilization, ' +
      'ROUND(AVG(hbm)) AS hbm, ROUND(AVG(busy), 1) AS busy FROM samples WHERE at >= ? AND at < ? ' +
      'GROUP BY slot, machine_id ORDER BY slot, machine_id'
    ).bind(from, USAGE_SLOT, from, to),
    env.DB.prepare(
      'SELECT AVG(utilization) AS utilization, COUNT(DISTINCT at) AS minutes, ' +
      '(SELECT AVG(total) FROM (SELECT SUM(busy) AS total FROM samples WHERE at >= ? AND at < ? GROUP BY at)) AS busy ' +
      'FROM samples WHERE at >= ? AND at < ?'
    ).bind(from, to, from, to),
    env.DB.prepare(
      'SELECT at, SUM(busy) AS busy FROM samples WHERE at >= ? AND at < ? GROUP BY at ORDER BY busy DESC, at DESC LIMIT 1'
    ).bind(from, to),
    env.DB.prepare(
      "SELECT type, json_extract(data, '$.team') AS team, COUNT(*) AS count FROM events " +
      "WHERE at >= ? AND at < ? AND type IN ('reserve', 'extend', 'release', 'expire') GROUP BY type, team"
    ).bind(from, to),
  ]);
  const totals = summary.results[0] ?? {};
  return reply({
    from, to, slot: USAGE_SLOT,
    cells: cells.results.map(row => [row.slot, row.machine_id, row.utilization, row.hbm, row.busy]),
    summary: {
      utilization: totals.utilization == null ? null : Math.round(totals.utilization),
      busy: totals.busy == null ? null : Math.round(totals.busy * 10) / 10,
      minutes: totals.minutes ?? 0,
      peak: peak.results[0] ? { at: peak.results[0].at, busy: peak.results[0].busy } : null,
    },
    counts: counts.results,
  });
}

function expiry(value, now) {
  if (!Number.isSafeInteger(value) || value < now + 60_000 || value > now + MAX_DURATION) {
    throw new ValidationError('结束时间须在当前时间 1 分钟后、24 小时内');
  }
  return value;
}

async function reserve(request, env, now) {
  const key = await managementHash(request);
  if (!key) return reply({ error: '请从看板提交登记' }, 400);
  const input = await readBody(request, 2048);
  const machine = MACHINES.find(item => item.id === input.machineId);
  if (!machine) throw new ValidationError('请选择机器');
  const team = typeof input.team === 'string' ? input.team.normalize('NFKC').trim().replace(/[ ]+/g, ' ') : '';
  if (!team || [...team].length > 32 || !/^[\p{L}\p{N}][\p{L}\p{N}\p{M} _().·&+—-]*$/u.test(team)) {
    throw new ValidationError('请输入有效的团队名称（1 至 32 字）');
  }
  const submitted = input.name ?? input.employee;
  const name = typeof submitted === 'string' ? submitted.normalize('NFKC').trim().replace(/[ ]+/g, ' ') : '';
  if (!name || [...name].length > 32 || !/^[\p{L}\p{N}][\p{L}\p{N}\p{M} ·.'_-]*$/u.test(name)) {
    throw new ValidationError('请输入有效的姓名（1 至 32 字）');
  }
  const cards = input.cards === 'all' ? machine.cards : input.cards;
  if (!Array.isArray(cards) || !cards.length || cards.length > machine.cards.length ||
      new Set(cards).size !== cards.length || cards.some(card => !machine.cards.includes(card))) {
    throw new ValidationError('请选择要占用的 NPU 卡');
  }
  const id = crypto.randomUUID();
  const endsAt = expiry(input.endsAt, now);
  const selection = JSON.stringify([...cards].sort((a, b) => a - b));
  // The overlap check and insert execute as one SQLite statement, including under concurrent requests.
  const [, , result] = await env.DB.batch([
    ...expireStatements(env, now),
    env.DB.prepare(`
      INSERT INTO reservations (id, machine_id, team, cards, key_hash, ends_at, name)
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM reservations AS r, json_each(r.cards) AS existing, json_each(?) AS incoming
        WHERE r.machine_id = ? AND r.ends_at > ? AND existing.value = incoming.value
      )`).bind(id, machine.id, team, selection, key, endsAt, name, selection, machine.id, now),
    env.DB.prepare(
      `INSERT INTO events (at, machine_id, type, data) SELECT ?, machine_id, 'reserve', ${RESERVATION_JSON} FROM reservations WHERE id = ?`
    ).bind(now, id),
  ]);
  if (!result.meta.changes) return reply({ error: '所选 NPU 已被登记，请重新选择' }, 409);
  return reply({ id, endsAt }, 201);
}

async function manage(request, env, now, id) {
  const key = await managementHash(request);
  if (!key) return reply({ error: '无法管理该登记' }, 403);
  let result;
  if (request.method === 'DELETE') {
    [, result] = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO events (at, machine_id, type, data) SELECT ?, machine_id, 'release', ${RESERVATION_JSON} ` +
        'FROM reservations WHERE id = ? AND key_hash = ? AND ends_at > ?'
      ).bind(now, id, key, now),
      env.DB.prepare('DELETE FROM reservations WHERE id = ? AND key_hash = ? AND ends_at > ?').bind(id, key, now),
    ]);
  } else {
    const input = await readBody(request, 1024);
    const endsAt = expiry(input.endsAt, now);
    [result] = await env.DB.batch([
      env.DB.prepare(
        'UPDATE reservations SET ends_at = ? WHERE id = ? AND key_hash = ? AND ends_at > ? AND ends_at < ?'
      ).bind(endsAt, id, key, now, endsAt),
      env.DB.prepare(
        `INSERT INTO events (at, machine_id, type, data) SELECT ?, machine_id, 'extend', ${RESERVATION_JSON} ` +
        'FROM reservations WHERE id = ? AND key_hash = ? AND ends_at = ? AND changes() > 0'
      ).bind(now, id, key, endsAt),
    ]);
  }
  if (!result.meta.changes) return reply({ error: '无法更新该登记，续期需晚于原结束时间' }, 409);
  return new Response(null, { status: 204 });
}

const crossOriginPaths = /^\/api\/(?:board|activity|usage|reservations(?:\/[0-9a-f-]{36})?)$/;

function pagesCors(request, response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', request.headers.get('origin'));
  headers.append('Vary', 'Origin');
  if (request.method === 'OPTIONS') {
    headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Board-Key');
    headers.set('Access-Control-Max-Age', '600');
  }
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const origin = request.headers.get('origin');
    const pagesRequest = Boolean(origin && origin === env.PAGES_ORIGIN && crossOriginPaths.test(pathname));
    if (request.method === 'OPTIONS' && pagesRequest) {
      return pagesCors(request, new Response(null, { status: 204 }));
    }
    const response = await handleRequest(request, env, pagesRequest);
    return pagesRequest ? pagesCors(request, response) : response;
  },
};

async function handleRequest(request, env, pagesRequest) {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;
  const now = Date.now();
  try {
    if (method === 'GET' || method === 'HEAD') {
      if (pathname === '/') return page(method === 'HEAD' ? null : PAGE);
      if (pathname === '/api/board' && method === 'GET') return await board(env, now);
      if (pathname === '/api/activity' && method === 'GET') return await activity(env, now);
      if (pathname === '/api/usage' && method === 'GET') return await usage(env, now, url.searchParams);
    }
    const source = pathname.match(/^\/api\/ingest\/([1-4])$/);
    if (source && method === 'POST') return await ingest(request, env, Number(source[1]));
    const origin = request.headers.get('origin');
    const sameHost = !origin || origin === url.origin || pagesRequest;
    if (pathname.startsWith('/api/reservations') && !sameHost) return reply({ error: '请求来源无效' }, 403);
    if (pathname === '/api/reservations' && method === 'POST') return await reserve(request, env, now);
    const management = pathname.match(/^\/api\/reservations\/([0-9a-f-]{36})$/);
    if (management && ['PATCH', 'DELETE'].includes(method)) return await manage(request, env, now, management[1]);
    return reply({ error: '页面不存在' }, 404);
  } catch (error) {
    if (error instanceof ValidationError) return reply({ error: error.message }, 400);
    console.error('Board request failed', method, pathname, error.name);
    return reply({ error: '看板服务暂时不可用，请稍后重试' }, 500);
  }
}
