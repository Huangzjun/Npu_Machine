import { PAGE } from './assets.mjs';

const MACHINE_HOSTS = ['195.121.29.13', '195.121.32.16', '195.121.1.17', '195.121.3.19'];
const MACHINES = MACHINE_HOSTS.map((host, i) => ({
  id: i + 1,
  name: host,
  model: 'Ascend 950DT',
  cards: Array.from({ length: 8 }, (_, card) => card),
}));
const MAX_DURATION = 24 * 60 * 60 * 1000;
const STALE_AFTER = 90_000;
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
  await snapshotStatement(env, id, Math.min(now, sampledAt), snapshot).run();
  return new Response(null, { status: 204 });
}

function snapshotStatement(env, id, collectedAt, snapshot) {
  return env.DB.prepare(
    'INSERT INTO snapshots (machine_id, received_at, sample) VALUES (?, ?, ?) ' +
    'ON CONFLICT(machine_id) DO UPDATE SET received_at=excluded.received_at, sample=excluded.sample ' +
    'WHERE excluded.received_at > snapshots.received_at'
  ).bind(id, collectedAt, JSON.stringify(snapshot));
}

const bytesFromHex = hex => Uint8Array.from(hex.match(/../g), byte => Number.parseInt(byte, 16));

async function verifyReading(env, record, now) {
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
    return snapshotStatement(env, id, timestamp, sanitizedSnapshot(JSON.parse(sample), machine));
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
    const readings = (await Promise.all(records.map(record => verifyReading(env, record, now)))).filter(Boolean);
    if (readings.length) await env.DB.batch(readings);
  } catch (error) {
    const message = String(error.message || '').replaceAll(env.COLLECTOR_RELAY_URL, '[relay]').slice(0, 160);
    console.warn('Telemetry relay unavailable', error.name, message);
  } finally {
    clearTimeout(deadline);
  }
}

async function board(env, now) {
  await refreshRelay(env, now);
  const [snapshots, active] = await env.DB.batch([
    env.DB.prepare('SELECT machine_id, received_at, sample FROM snapshots'),
    env.DB.prepare('SELECT id, machine_id, team, cards, ends_at, employee, employee_suffix FROM reservations WHERE ends_at > ? ORDER BY ends_at').bind(now),
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
          employee: item.employee, employeeSuffix: item.employee_suffix,
        })),
      };
    }),
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
  const employee = typeof input.employee === 'string' ? input.employee.normalize('NFKC').trim() : '';
  if (!/^[a-z0-9][a-z0-9._-]{1,31}$/i.test(employee)) {
    throw new ValidationError('请输入有效工号（2 至 32 位字母、数字或 . _ -）');
  }
  const employeeSuffix = employee.slice(-Math.min(4, employee.length - 1));
  const cards = input.cards === 'all' ? machine.cards : input.cards;
  if (!Array.isArray(cards) || !cards.length || cards.length > machine.cards.length ||
      new Set(cards).size !== cards.length || cards.some(card => !machine.cards.includes(card))) {
    throw new ValidationError('请选择要占用的 NPU 卡');
  }
  const id = crypto.randomUUID();
  const endsAt = expiry(input.endsAt, now);
  const selection = JSON.stringify([...cards].sort((a, b) => a - b));
  // The overlap check and insert execute as one SQLite statement, including under concurrent requests.
  const [, result] = await env.DB.batch([
    env.DB.prepare('DELETE FROM reservations WHERE ends_at <= ?').bind(now),
    env.DB.prepare(`
      INSERT INTO reservations (id, machine_id, team, cards, key_hash, ends_at, employee, employee_suffix)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM reservations AS r, json_each(r.cards) AS existing, json_each(?) AS incoming
        WHERE r.machine_id = ? AND r.ends_at > ? AND existing.value = incoming.value
      )`).bind(id, machine.id, team, selection, key, endsAt, employee, employeeSuffix, selection, machine.id, now),
  ]);
  if (!result.meta.changes) return reply({ error: '所选 NPU 已被登记，请重新选择' }, 409);
  return reply({ id, endsAt }, 201);
}

async function manage(request, env, now, id) {
  const key = await managementHash(request);
  if (!key) return reply({ error: '无法管理该登记' }, 403);
  let result;
  if (request.method === 'DELETE') {
    result = await env.DB.prepare('DELETE FROM reservations WHERE id = ? AND key_hash = ? AND ends_at > ?')
      .bind(id, key, now).run();
  } else {
    const input = await readBody(request, 1024);
    const endsAt = expiry(input.endsAt, now);
    result = await env.DB.prepare(
      'UPDATE reservations SET ends_at = ? WHERE id = ? AND key_hash = ? AND ends_at > ? AND ends_at < ?'
    ).bind(endsAt, id, key, now, endsAt).run();
  }
  if (!result.meta.changes) return reply({ error: '无法更新该登记，续期需晚于原结束时间' }, 409);
  return new Response(null, { status: 204 });
}

const crossOriginPaths = /^\/api\/(?:board|reservations(?:\/[0-9a-f-]{36})?)$/;

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
