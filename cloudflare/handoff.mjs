import { timingSafeEqual } from 'node:crypto';

// Shared transcription progress for one YouTube video, so another PC resumes where the previous one stopped.
// The desktop authenticates with its publication key, the standby laptop with the laptop key.
export async function handoffRequest(request, env) {
  const key = request.headers.get('X-JC-Handoff-Key') ?? '';
  if (!/^[a-f0-9]{64}$/.test(key) || ![env.JC_SYNC_SECRET, env.JC_LAPTOP_SECRET].some(secret =>
    typeof secret === 'string' && secret.length === 64 && timingSafeEqual(Buffer.from(key), Buffer.from(secret))))
    return new Response(null, { status: 403 });
  const url = new URL(request.url), video = url.searchParams.get('video');
  if (!/^[A-Za-z0-9_-]{11}$/.test(video ?? '')) return new Response(null, { status: 400 });
  const db = env.DB;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS handoff_progress(video TEXT PRIMARY KEY, video_ms REAL NOT NULL, document TEXT NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS handoff_rows(video TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, document TEXT NOT NULL, PRIMARY KEY(video,id))')
  ]);
  const reply = value => Response.json(value, { headers: { 'Cache-Control': 'no-store' } });
  if (request.method === 'GET') {
    const progress = await db.prepare('SELECT document FROM handoff_progress WHERE video=?').bind(video).first();
    const after = url.searchParams.get('after') ?? '';
    const rows = await db.prepare('SELECT id,document FROM handoff_rows WHERE video=? AND id>? ORDER BY id LIMIT 200').bind(video, after).all();
    return reply({ checkpoint: progress ? JSON.parse(progress.document) : null,
      rows: rows.results.map(row => JSON.parse(row.document)), next: rows.results.length === 200 ? rows.results.at(-1).id : null });
  }
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  const text = await request.text();
  if (text.length > 2_000_000) return new Response(null, { status: 413 });
  let data;
  try { data = JSON.parse(text); } catch { return new Response(null, { status: 400 }); }
  if (data.type === 'rows') {
    if (!Array.isArray(data.rows) || data.rows.length > 100 || data.rows.some(row =>
      !row.segment || !row.session || row.segment.session_id !== row.session.session_id ||
      typeof row.segment.segment_id !== 'string' || row.segment.segment_id.length > 80 ||
      !Number.isInteger(row.segment.version) || !/^[a-f0-9]{64}$/.test(row.broadcast_id ?? '')))
      return new Response(null, { status: 400 });
    if (data.rows.length) await db.batch(data.rows.map(row => db.prepare(
      'INSERT INTO handoff_rows VALUES(?,?,?,?) ON CONFLICT(video,id) DO UPDATE SET version=excluded.version,document=excluded.document WHERE excluded.version>=handoff_rows.version')
      .bind(video, row.segment.segment_id, row.segment.version, JSON.stringify(row))));
    return reply({ ok: true });
  }
  if (data.type !== 'checkpoint' || data.video_id !== video || !Number.isFinite(data.video_ms) ||
    data.video_ms < 0 || data.video_ms > 86_400_000 || !/^[a-f0-9]{64}$/.test(data.broadcast_id ?? ''))
    return new Response(null, { status: 400 });
  const checkpoint = { video_id: video, video_ms: data.video_ms, broadcast_id: data.broadcast_id,
    processor: data.processor, updated_ms: Date.now(), clock: 'youtube-source-pts-v1' };
  // A stale writer cannot move the shared position backwards.
  await db.prepare('INSERT INTO handoff_progress VALUES(?,?,?) ON CONFLICT(video) DO UPDATE SET video_ms=excluded.video_ms,document=excluded.document WHERE excluded.video_ms>=handoff_progress.video_ms')
    .bind(video, checkpoint.video_ms, JSON.stringify(checkpoint)).run();
  return reply({ ok: true, checkpoint });
}
