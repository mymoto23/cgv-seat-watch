// CGV empty-seat watcher — GitHub Actions edition
// Polls the seat-map API every 60s for MINUTES minutes, alerts via ntfy.sh on new seats.
// State is stored in a ntfy topic so runs hand off to each other (no repo commits needed).
const { chromium } = require('playwright');

const ALERT_TOPIC = process.env.NTFY_TOPIC;
const STATE_TOPIC = process.env.NTFY_STATE_TOPIC;
if (!ALERT_TOPIC || !STATE_TOPIC) { console.error('NTFY_TOPIC / NTFY_STATE_TOPIC env vars required'); process.exit(1); }

const TARGETS = [
  { sseq: '3', label: '오디세이 IMAX 8/29(토) 14:30' },
  { sseq: '4', label: '오디세이 IMAX 8/29(토) 18:00' },
];
const RUN_MS = Number(process.env.MINUTES || 9) * 60 * 1000;
const DEADLINE = Date.now() + RUN_MS;
const CUTOFF = Date.parse('2026-08-29T09:00:00Z'); // 18:00 KST show start
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readBaseline() {
  try {
    const r = await fetch(`https://ntfy.sh/${STATE_TOPIC}/json?poll=1`);
    const lines = (await r.text()).trim().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const m = JSON.parse(lines[i]);
        if (m.event === 'message') {
          const b = JSON.parse(m.message);
          if (b && Array.isArray(b['3']) && Array.isArray(b['4'])) return b;
        }
      } catch {}
    }
  } catch {}
  return null;
}
const publishState = (b) => fetch(`https://ntfy.sh/${STATE_TOPIC}`, { method: 'POST', body: JSON.stringify(b) }).catch(() => {});
const alert = (title, message) => fetch('https://ntfy.sh', {
  method: 'POST',
  body: JSON.stringify({ topic: ALERT_TOPIC, title, message, priority: 5, tags: ['tada'] }),
}).catch(() => {});

async function warnDown(reason) {
  // one 'watcher down' push, throttled: skip if we already warned in the last 3h
  try {
    const r = await fetch(`https://ntfy.sh/${ALERT_TOPIC}/json?poll=1&since=3h`);
    if ((await r.text()).includes('WATCHER DOWN')) return;
  } catch {}
  await alert('⚠️ WATCHER DOWN', `CGV 좌석 감시가 실패했습니다: ${reason}\n로그: https://github.com/mymoto23/cgv-seat-watch/actions`);
}

async function boot() {
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
  const ctx = await browser.newContext({
    locale: 'ko-KR', timezoneId: 'Asia/Seoul', viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  });
  const page = await ctx.newPage();
  await page.goto('https://cgv.co.kr', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  const html = await page.content();
  if (html.includes('비정상적으로')) { console.log('CLOUDFLARE_BLOCKED'); await warnDown('Cloudflare가 GitHub IP를 차단'); await browser.close(); process.exit(2); }
  return { browser, page };
}

async function fetchSeats(page, sseq) {
  const u = `https://cgv.co.kr/api/v1/booking/searchIfSeatData?coCd=A420&siteNo=0013&scnYmd=20260829&scnsNo=018&scnSseq=${sseq}`;
  const r = await page.evaluate(async (u) => {
    const res = await fetch(u, { credentials: 'include' });
    const text = await res.text();
    try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, raw: text.slice(0, 120) }; }
  }, u);
  if (!r.json || r.json.statusCode !== 0 || !r.json.data?.items?.length) throw new Error(`bad response ${r.status} ${r.raw || ''}`);
  return r.json.data.items.flatMap((it) => it.seats || []).filter((s) => s.seatSaleYn === 'Y').map((s) => `${s.seatRowNm}${s.seatNo}`).sort();
}

(async () => {
  if (Date.now() > CUTOFF) { console.log('past cutoff — show has started; disable the workflow'); return; }
  let baseline = await readBaseline();
  let session = await boot();
  let alerts = 0, checks = 0, errStreak = 0;
  while (Date.now() < DEADLINE && Date.now() < CUTOFF) {
    for (const t of TARGETS) {
      try {
        const avail = await fetchSeats(session.page, t.sseq);
        checks++; errStreak = 0;
        const base = baseline ? (baseline[t.sseq] || []) : null;
        if (base !== null) {
          const fresh = avail.filter((s) => !base.includes(s));
          if (fresh.length) {
            alerts++;
            await alert(`CGV new seat! ${t.sseq === '3' ? '14:30' : '18:00'}`,
              `${t.label}\n새 좌석: ${fresh.join(', ')}\n현재 ${avail.length}석: ${avail.join(', ')}\n예매: https://cgv.co.kr/cnm/movieBook`);
          }
        }
        if (!baseline) baseline = {};
        if (JSON.stringify(baseline[t.sseq] || null) !== JSON.stringify(avail)) {
          baseline[t.sseq] = avail;
          await publishState(baseline);
        }
        console.log(new Date().toISOString(), t.label, `${avail.length}: ${avail.join(',')}`);
      } catch (e) {
        console.log('ERR', t.label, e.message.slice(0, 120));
        errStreak++;
        try { await session.browser.close(); } catch {}
        if (errStreak > 5) { console.log('too many consecutive errors, giving up'); await warnDown('연속 오류 (API 응답 이상)'); process.exit(3); }
        session = await boot();
      }
    }
    await sleep(60000);
  }
  try { await session.browser.close(); } catch {}
  console.log(`SUMMARY checks=${checks} alerts=${alerts}`);
})();
