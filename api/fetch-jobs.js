// /api/fetch-jobs.js
// Unified jobs feed for the TASK dashboard.
// - CORS + OPTIONS
// - Supabase is optional
// - Adzuna search is hardened (city fallback, distance, "entry level" cleanup)
// - Clear diagnostics returned to the client

// Vercel Node runtimes (>=18) already have fetch, so no node-fetch import needed.

// ---------- helpers ----------
function okJson(res, obj, status = 200) {
  res.status(status).json(obj);
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function parseIntSafe(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function daysAgoISO(days) {
  const d = new Date();
  d.setDate(d.getDate() - (Number.isFinite(days) ? days : 7));
  return d.toISOString();
}

// Normalize records to the front-end shape
function normJob(j) {
  return {
    title: j.title || 'Untitled',
    description: j.description || '',
    company: j.company || j.company_name || 'Unknown Company',
    location: j.location || j.city || j.place || '',
    industry: j.industry || j.category || null,
    salary_min:
      typeof j.salary_min === 'number'
        ? j.salary_min
        : typeof j.salary_min === 'string'
        ? Number(j.salary_min)
        : null,
    salary_max:
      typeof j.salary_max === 'number'
        ? j.salary_max
        : typeof j.salary_max === 'string'
        ? Number(j.salary_max)
        : null,
    created: j.created || j.created_at || j.date || new Date().toISOString(),
    redirect_url: j.redirect_url || j.url || j.apply_url || null,
  };
}

// ---------- Supabase (optional) ----------
async function fetchSupabase({ url, anonKey, where, q, days, limit }) {
  if (!url || !anonKey) {
    return {
      ok: false,
      source: 'supabase',
      error: 'Missing SUPABASE_URL or SUPABASE_ANON_KEY',
      jobs: [],
    };
  }

  const endpoint = `${url.replace(/\/+$/, '')}/rest/v1/jobs`;
  const sinceISO = daysAgoISO(days);

  const params = new URLSearchParams();
  params.set(
    'select',
    'title,description,company,location,industry,salary_min,salary_max,created,redirect_url,approved'
  );
  params.set('approved', 'eq.true');
  params.set('created', `gte.${sinceISO}`);
  if (q)
    params.set(
      'or',
      `(title.ilike.*${q}*,description.ilike.*${q}*,company.ilike.*${q}*)`
    );
  if (where) params.set('location', `ilike.*${where}*`);
  params.set('order', 'created.desc');
  params.set('limit', String(parseIntSafe(limit, 100)));

  const urlFull = `${endpoint}?${params.toString()}`;
  const resp = await fetch(urlFull, {
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    return {
      ok: false,
      source: 'supabase',
      error: `HTTP ${resp.status}: ${text || 'Supabase error'}`,
      jobs: [],
      url: urlFull,
    };
  }

  const rows = await resp.json().catch(() => []);
  return { ok: true, source: 'supabase', jobs: rows.map(normJob), url: urlFull };
}

// ---------- Adzuna (primary) ----------
async function fetchAdzuna({ appId, apiKey, where, q, days, limit }) {
  if (!appId || !apiKey) {
    return {
      ok: false,
      source: 'adzuna',
      error: 'Missing ADZUNA_APP_ID or ADZUNA_API_KEY',
      jobs: [],
    };
  }

  // Prefer a concrete city for Adzuna; county names are spotty.
  const primaryWhere =
    where && /mercer/i.test(where) ? 'Trenton, NJ' : (where || 'Trenton, NJ');

  // Widen the net slightly.
  const distanceMiles = 25;

  // Remove "entry level" from query to avoid suppressing matches.
  const cleanQ =
    q && /entry\s*level/i.test(q) ? q.replace(/entry\s*level/gi, '').trim() : q;

  async function run(oneWhere, oneQ) {
    const base = `https://api.adzuna.com/v1/api/jobs/us/search/1`;
    const params = new URLSearchParams();
    params.set('app_id', appId);
    params.set('app_key', apiKey);
    params.set('results_per_page', String(parseIntSafe(limit, 50)));
    params.set('where', oneWhere);
    params.set('distance', String(distanceMiles));
    if (oneQ) params.set('what', oneQ);
    if (days) params.set('max_days_old', String(parseIntSafe(days, 7)));

    const url = `${base}?${params.toString()}`;
    const resp = await fetch(url);

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return {
        ok: false,
        source: 'adzuna',
        error: `HTTP ${resp.status}: ${text || 'Adzuna error'}`,
        jobs: [],
        url,
      };
    }

    const data = await resp.json().catch(() => ({}));
    const results = Array.isArray(data.results) ? data.results : [];
    const mapped = results.map(r =>
      normJob({
        title: r.title,
        description: r.description,
        company: r.company?.display_name,
        location:
          `${r.location?.area?.filter(Boolean).join(', ')}` ||
          r.location?.display_name ||
          '',
        industry: r.category?.label,
        salary_min: r.salary_min ?? null,
        salary_max: r.salary_max ?? null,
        created: r.created ?? r.created_at,
        redirect_url: r.redirect_url,
      })
    );

    return { ok: true, source: 'adzuna', jobs: mapped, url };
  }

  // Try a few sensible permutations:
  const attempts = [
    [primaryWhere, q],
    [primaryWhere, cleanQ],
    [/trenton/i.test(primaryWhere) ? 'Princeton, NJ' : 'Trenton, NJ', cleanQ],
    [/trenton/i.test(primaryWhere) ? 'Princeton, NJ' : 'Trenton, NJ', ''],
  ];

  let last = null;
  for (const [w, qq] of attempts) {
    const r = await run(w, qq);
    last = r;
    if (r.ok && r.jobs.length > 0) return r;
  }
  return last || { ok: false, source: 'adzuna', error: 'Unknown error', jobs: [] };
}

// ---------- handler ----------
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return okJson(res, { error: 'Method Not Allowed' }, 405);

  const t0 = Date.now();

  try {
    const urlObj = new URL(req.url, 'http://localhost');
    const q = (urlObj.searchParams.get('q') || '').trim();
    const where = (urlObj.searchParams.get('where') || '').trim();
    const days = parseIntSafe(urlObj.searchParams.get('days'), 7);
    const limit = parseIntSafe(urlObj.searchParams.get('limit'), 100);

    // ENV
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_ANON =
      process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID;
    const ADZUNA_API_KEY = process.env.ADZUNA_API_KEY;

    // Fetch in parallel; tolerate failure of one source
    const [sb, adz] = await Promise.allSettled([
      fetchSupabase({
        url: SUPABASE_URL,
        anonKey: SUPABASE_ANON,
        where,
        q,
        days,
        limit,
      }),
      fetchAdzuna({
        appId: ADZUNA_APP_ID,
        apiKey: ADZUNA_API_KEY,
        where,
        q,
        days,
        limit: Math.min(limit, 50),
      }),
    ]);

    const supabaseRes =
      sb.status === 'fulfilled'
        ? sb.value
        : {
            ok: false,
            source: 'supabase',
            error: sb.reason?.message || 'Supabase fetch failed',
            jobs: [],
          };

    const adzunaRes =
      adz.status === 'fulfilled'
        ? adz.value
        : {
            ok: false,
            source: 'adzuna',
            error: adz.reason?.message || 'Adzuna fetch failed',
            jobs: [],
          };

    // Helpful server logs (visible in Vercel logs)
    console.log('fetch-jobs diagnostics:', {
      adzuna: { ok: adzunaRes.ok, count: adzunaRes.jobs?.length, url: adzunaRes.url, error: adzunaRes.error },
      supabase: { ok: supabaseRes.ok, count: supabaseRes.jobs?.length, url: supabaseRes.url, error: supabaseRes.error },
      q,
      where,
    });

    // Merge + de-dupe by title|company|location
    const merged = [...(supabaseRes.jobs || []), ...(adzunaRes.jobs || [])];
    const seen = new Set();
    const deduped = merged.filter(j => {
      const key = [j.title, j.company, j.location]
        .map(s => (s || '').toLowerCase())
        .join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const finalJobs = deduped.slice(0, limit);

    const sources = {
      supabase: {
        ok: !!supabaseRes.ok,
        count: supabaseRes.jobs?.length || 0,
        error: supabaseRes.ok ? null : supabaseRes.error,
        url: supabaseRes.url || null,
      },
      adzuna: {
        ok: !!adzunaRes.ok,
        count: adzunaRes.jobs?.length || 0,
        error: adzunaRes.ok ? null : adzunaRes.error,
        url: adzunaRes.url || null,
      },
    };

    return okJson(
      res,
      { ok: true, ms: Date.now() - t0, sources, jobs: finalJobs },
      200
    );
  } catch (err) {
    console.error('fetch-jobs fatal:', err);
    return okJson(
      res,
      {
        ok: false,
        message: 'Failed to fetch jobs from backend services.',
        detail: String(err?.message || err),
        jobs: [],
        sources: {},
      },
      200
    );
  }
};
