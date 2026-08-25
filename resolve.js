// Resolve human-friendly targets.json entries into CGV schedule codes.
// Runs inside an already-booted Playwright page (needed to pass Cloudflare).
//
// targets.json entry: { movie, site, date: "YYYYMMDD", times?: [...], screen? }
//   movie/site: substring match against CGV's movie & theater names
//   times entries: "HH:MM" (exact) or "HH:MM-HH:MM" (inclusive start-time range);
//                  omit times entirely to watch ALL showings that day.
//                  CGV writes post-midnight shows as 25:00/26:00 under the previous date.
//   screen (optional): substring match against screen name / format (e.g. "IMAX", "4DX")
//
// Returns [{ siteNo, scnYmd, scnsNo, scnSseq, label, startEpoch, key }]

async function apiGet(page, url) {
  const r = await page.evaluate(async (u) => {
    const res = await fetch(u, { credentials: 'include' });
    const text = await res.text();
    try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, raw: text.slice(0, 120) }; }
  }, url);
  if (!r.json || r.json.statusCode !== 0) throw new Error(`API ${r.status} for ${url.slice(0, 100)}: ${r.raw || r.json?.statusMessage}`);
  return r.json.data;
}

// deep-scan any JSON for objects carrying the given pair of keys
function collect(node, keys, out) {
  if (Array.isArray(node)) { node.forEach((n) => collect(n, keys, out)); return out; }
  if (node && typeof node === 'object') {
    if (keys.every((k) => typeof node[k] === 'string')) out.push(node);
    Object.values(node).forEach((v) => collect(v, keys, out));
  }
  return out;
}

async function resolveTargets(page, config) {
  const movies = collect(await apiGet(page, 'https://cgv.co.kr/api/v1/booking/searchAtktTopPostrList?coCd=A420&movNm=&div=&attrCd='), ['movNo', 'movNm'], []);
  const sites = collect(await apiGet(page, 'https://cgv.co.kr/api/v1/content/site/searchAllRegionAndSite?coCd=A420'), ['siteNo', 'siteNm'], []);

  const resolved = [];
  for (const t of config) {
    const movie = movies.find((m) => m.movNm.includes(t.movie));
    if (!movie) { console.log(`SKIP "${t.movie}": movie not found. Booking now: ${[...new Set(movies.map((m) => m.movNm))].slice(0, 15).join(', ')}`); continue; }
    const site = sites.find((s) => s.siteNm.includes(t.site));
    if (!site) { console.log(`SKIP "${t.site}": theater not found`); continue; }

    const sch = await apiGet(page,
      `https://cgv.co.kr/api/v1/booking/searchSchByMov?coCd=A420&siteNo=${site.siteNo}&scnYmd=${t.date}&movNo=${movie.movNo}&rtctlScopCd=08`);
    const shows = Array.isArray(sch) ? sch : [];
    const specs = t.times && t.times.length ? t.times : ['00:00-27:00']; // no times = all showings
    for (const spec of specs) {
      const range = spec.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
      const toNum = (hhmm) => parseInt(hhmm.replace(':', ''), 10);
      let matches = range
        ? shows.filter((s) => parseInt(s.scnsrtTm, 10) >= toNum(range[1]) && parseInt(s.scnsrtTm, 10) <= toNum(range[2]))
        : shows.filter((s) => s.scnsrtTm === spec.replace(':', ''));
      if (t.screen) matches = matches.filter((s) => `${s.scnsNm} ${s.movkndDsplNm}`.toLowerCase().includes(t.screen.toLowerCase()));
      if (!matches.length) {
        console.log(`SKIP ${t.movie} ${t.date} ${spec}${t.screen ? ` (${t.screen})` : ''}: no showing. Times that day: ${shows.map((s) => `${s.scnsrtTm}(${s.scnsNm})`).join(', ') || 'none'}`);
        continue;
      }
      for (const s of matches) {
        const d = t.date, hhmm = `${s.scnsrtTm.slice(0, 2)}:${s.scnsrtTm.slice(2)}`;
        const startEpoch = Date.parse(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00+09:00`) + parseInt(s.scnsrtTm.slice(0, 2), 10) * 3600e3 + parseInt(s.scnsrtTm.slice(2), 10) * 60e3;
        resolved.push({
          siteNo: site.siteNo, scnYmd: t.date, scnsNo: s.scnsNo, scnSseq: s.scnSseq,
          label: `${movie.movNm} ${s.scnsNm} ${Number(d.slice(4, 6))}/${Number(d.slice(6, 8))} ${hhmm}`,
          startEpoch,
          key: `${site.siteNo}-${t.date}-${s.scnsNo}-${s.scnSseq}`,
        });
      }
    }
  }
  // dedupe (a show can match both an exact time and an overlapping range)
  const seen = new Set();
  return resolved.filter((r) => !seen.has(r.key) && seen.add(r.key));
}

module.exports = { resolveTargets };
