// replace your fetchAdzuna with this hardened version
async function fetchAdzuna({ appId, apiKey, where, q, days, limit }) {
  if (!appId || !apiKey) {
    return { ok: false, source: 'adzuna', error: 'Missing ADZUNA_APP_ID or ADZUNA_API_KEY', jobs: [] };
  }

  // prefer city/state; use fallback if "Mercer County" was passed
  const primaryWhere = (where && /mercer/i.test(where)) ? 'Trenton, NJ' : (where || 'Trenton, NJ');
  const distanceMiles = 25; // widen the net a bit

  async function run(oneWhere) {
    const base = 'https://api.adzuna.com/v1/api/jobs/us/search/1';
    const params = new URLSearchParams();
    params.set('app_id', appId);
    params.set('app_key', apiKey);
    params.set('results_per_page', String(parseIntSafe(limit, 50)));
    params.set('where', oneWhere);
    params.set('distance', String(distanceMiles));
    if (q) params.set('what', q);
    if (days) params.set('max_days_old', String(parseIntSafe(days, 7)));

    const url = `${base}?${params.toString()}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { ok: false, source: 'adzuna', error: `HTTP ${resp.status}: ${text || 'Adzuna error'}`, jobs: [], url };
    }
    const data = await resp.json().catch(() => ({}));
    const results = Array.isArray(data.results) ? data.results : [];
    const mapped = results.map(r => normJob({
      title: r.title,
      description: r.description,
      company: r.company?.display_name,
      location: `${r.location?.area?.filter(Boolean).join(', ') || r.location?.display_name || ''}`,
      industry: r.category?.label,
      salary_min: r.salary_min ?? null,
      salary_max: r.salary_max ?? null,
      created: r.created ?? r.created_at,
      redirect_url: r.redirect_url
    }));
    return { ok: true, source: 'adzuna', jobs: mapped, url };
  }

  // try primary; if empty, try a wider fallback
  const first = await run(primaryWhere);
  if (first.ok && first.jobs.length > 0) return first;

  // fallback: drop "entry level" if it’s in q, and/or broaden to Princeton, NJ
  const fallbackWhere = /trenton/i.test(primaryWhere) ? 'Princeton, NJ' : 'Trenton, NJ';
  const cleanQ = (q && /entry level/i.test(q)) ? q.replace(/entry level/ig, '').trim() : q;

  const second = await run(fallbackWhere);
  if (second.ok && second.jobs.length > 0) return second;

  // final: if q was too narrow, try without q
  if (cleanQ !== q) {
    const third = await run(fallbackWhere);
    return third;
  }
  return first.ok ? first : second;
}
