/**
 * Host half of dsh-bili-ghost.
 *
 * Bilibili's ranking endpoints refuse cross-origin browser calls and expect a
 * browser-ish UA/Referer, so the page can never fetch them directly. This half
 * owns a same-origin route (`/__bili-ghost/feed`) that:
 *   - only answers same-origin, trusted browser requests,
 *   - reads the weekly must-watch series and the 入站必看 collection (the
 *     editor-picked quality lists) plus the newest 鬼畜 (zone 119) uploads,
 *   - puts curated picks first, fills the rest with today's 鬼畜 ranked by
 *     engagement, and caches the result.
 */

import { createHash } from 'node:crypto';

const ROUTE = '/__bili-ghost/feed';
const ZONE = 119;
const MAX_PAGES = 5;
const PAGE_SIZE = 20;
const CACHE_TTL_MS = 5 * 60 * 1000;
// After a failed refresh, stop hammering the upstream on every reopen.
const FAILURE_TTL_MS = 30 * 1000;
const FETCH_TIMEOUT_MS = 15000;
const MIN_DURATION_SEC = 15;
const MAX_DURATION_SEC = 1500;
const MAX_VIDEOS = 20;
const MAX_WEEKLY = 10;
const MAX_PRECIOUS = 6;
const WEEKLY_URL = 'https://api.bilibili.com/x/web-interface/popular/series/one';
const SERIES_LIST_URL = 'https://api.bilibili.com/x/web-interface/popular/series/list';
const PRECIOUS_URL = 'https://api.bilibili.com/x/web-interface/popular/precious';
const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';
const WBI_TTL_MS = 6 * 60 * 60 * 1000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Bilibili's wbi signature table, see the community reverse-engineering notes.
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
  28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
  54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

const BILI_HEADERS = {
  'user-agent': USER_AGENT,
  referer: 'https://www.bilibili.com/',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  accept: 'application/json, text/plain, */*',
};

export const inject = ['webServer', 'connection'];

export function apply(ctx) {
  let cache = { at: 0, payload: null };
  let inflight = null;
  let failure = { at: 0 };
  let wbi = { at: 0, key: '' };

  const pageUrl = (page) =>
    `https://api.bilibili.com/x/web-interface/newlist?rid=${ZONE}&type=0&pn=${page}&ps=${PAGE_SIZE}`;

  async function fetchJson(url, signal) {
    const response = await fetch(url, {
      headers: BILI_HEADERS,
      signal,
      redirect: 'follow',
    });
    if (!response.ok) throw new Error(`bilibili HTTP ${response.status}`);
    return response.json();
  }

  function wbiSign(params, key) {
    const wts = Math.floor(Date.now() / 1000);
    const entries = Object.entries({ ...params, wts }).sort(([a], [b]) => (a < b ? -1 : 1));
    const query = entries
      .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
      .join('&');
    const digest = createHash('md5').update(query + key).digest('hex');
    return `${query}&w_rid=${digest}`;
  }

  async function wbiKey(signal) {
    if (wbi.key && Date.now() - wbi.at < WBI_TTL_MS) return wbi.key;
    const nav = await fetchJson(NAV_URL, signal);
    const img = nav && nav.data && nav.data.wbi_img;
    if (!img || !img.img_url || !img.sub_url) throw new Error('bilibili wbi keys unavailable');
    const baseName = (url) => url.slice(url.lastIndexOf('/') + 1).split('.')[0];
    const raw = baseName(img.img_url) + baseName(img.sub_url);
    const key = MIXIN_KEY_ENC_TAB.slice(0, 32)
      .map((index) => raw[index])
      .join('');
    wbi = { at: Date.now(), key };
    return key;
  }

  async function fetchWeekly(signal) {
    const list = await fetchJson(SERIES_LIST_URL, signal);
    const issues = list && list.data && list.data.list;
    if (!Array.isArray(issues) || issues.length === 0) {
      throw new Error('bilibili weekly series unavailable');
    }
    const latest = issues[0];
    // series/one is wbi-protected: unsigned calls answer code -352. Bilibili
    // rotates the nav keys daily, so a stale cached key can fail before its
    // TTL expires; refresh the key and retry once in that case.
    let body = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const key = await wbiKey(signal);
        body = await fetchJson(`${WEEKLY_URL}?${wbiSign({ number: latest.number }, key)}`, signal);
      } catch (error) {
        wbi = { at: 0, key: '' };
        if (attempt === 1) throw error;
        continue;
      }
      if (body && body.code === -352) {
        wbi = { at: 0, key: '' };
        if (attempt === 0) continue;
      }
      break;
    }
    if (!body || body.code !== 0) {
      throw new Error(`bilibili weekly code ${body && body.code}`);
    }
    const items = (body.data && body.data.list) || [];
    return {
      number: latest.number,
      name: latest.name,
      items: Array.isArray(items) ? items : [],
    };
  }

  async function fetchPrecious(signal) {
    const body = await fetchJson(PRECIOUS_URL, signal);
    if (!body || body.code !== 0) {
      throw new Error(`bilibili precious code ${body && body.code}`);
    }
    const items = (body.data && body.data.list) || [];
    return Array.isArray(items) ? items : [];
  }

  async function fetchPage(page, signal) {
    const body = await fetchJson(pageUrl(page), signal);
    if (!body || body.code !== 0) {
      const code = body && body.code;
      const message = body && body.message;
      throw new Error(`bilibili code ${code}${message ? `: ${message}` : ''}`);
    }
    const archives = body.data && body.data.archives;
    return Array.isArray(archives) ? archives : [];
  }

  function scoreOf(stat) {
    const n = (value) => (Number.isFinite(value) ? value : 0);
    return (
      n(stat.view) +
      n(stat.like) * 4 +
      n(stat.coin) * 6 +
      n(stat.favorite) * 6 +
      n(stat.danmaku) +
      n(stat.reply) +
      n(stat.share) * 3
    );
  }

  function startOfToday(now) {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }

  function toVideo(raw, dayStart) {
    const stat = raw.stat || {};
    const stats = {
      view: Number(stat.view) || 0,
      like: Number(stat.like) || 0,
      coin: Number(stat.coin) || 0,
      favorite: Number(stat.favorite) || 0,
      danmaku: Number(stat.danmaku) || 0,
      reply: Number(stat.reply) || 0,
      share: Number(stat.share) || 0,
    };
    return {
      bvid: raw.bvid,
      title: typeof raw.title === 'string' ? raw.title : '',
      author: (raw.owner && raw.owner.name) || '',
      tname: typeof raw.tname === 'string' ? raw.tname : '',
      cover: raw.pic ? (raw.pic.startsWith('http') ? raw.pic : `https:${raw.pic}`) : '',
      url: `https://www.bilibili.com/video/${raw.bvid}`,
      duration: Number(raw.duration) || 0,
      pubdate: Number(raw.pubdate) || 0,
      stats,
      score: scoreOf(stats),
      today: (Number(raw.pubdate) || 0) * 1000 >= dayStart,
    };
  }

  function buildFeed(sources, now) {
    const dayStart = startOfToday(now);
    const seen = new Set();

    // `seen` is shared across sources, so a clip that appears both in the
    // weekly list and among today's uploads keeps only its curated copy.
    const pick = (items, source) => {
      const kept = [];
      for (const raw of items) {
        if (!raw || typeof raw.bvid !== 'string' || seen.has(raw.bvid)) continue;
        const duration = Number(raw.duration) || 0;
        if (duration < MIN_DURATION_SEC || duration > MAX_DURATION_SEC) continue;
        seen.add(raw.bvid);
        kept.push({ ...toVideo(raw, dayStart), source });
      }
      return kept;
    };

    const ghostFirst = (videos) => {
      const isGhost = (video) => /鬼畜|搞笑/.test(video.tname || '');
      // Array#sort is stable, so the editor's order survives inside each group.
      return [...videos].sort((a, b) => Number(isGhost(b)) - Number(isGhost(a)));
    };

    const weekly = ghostFirst(pick(sources.weekly, 'weekly')).slice(0, MAX_WEEKLY);
    const precious = ghostFirst(pick(sources.precious, 'precious')).slice(0, MAX_PRECIOUS);
    const archives = pick(sources.archives, 'today');
    const today = archives
      .filter((video) => video.today)
      .sort((a, b) => b.score - a.score || b.pubdate - a.pubdate);

    // Right after midnight, today's uploads have no engagement yet and the
    // list can be dominated by zero-view uploads. Keep only clips that have
    // picked up at least some traction when there are enough of them.
    const withTraction = today.filter((video) => video.stats.view >= 10);
    const todayPool = withTraction.length >= 5 ? withTraction : today;

    const chosen = [];
    const add = (video) => {
      if (chosen.length >= MAX_VIDEOS) return;
      if (chosen.some((existing) => existing.bvid === video.bvid)) return;
      chosen.push(video);
    };

    for (const video of [...weekly, ...precious]) add(video);
    for (const video of todayPool) add(video);
    if (chosen.length < MAX_VIDEOS) {
      const newest = [...archives].sort((a, b) => b.pubdate - a.pubdate);
      for (const video of newest) add(video);
    }

    const scope = weekly.length + precious.length > 0 ? 'curated' : todayPool.length > 0 ? 'today' : 'latest';

    return {
      generatedAt: now,
      dayStart,
      scope,
      filtered: withTraction.length >= 5,
      weekly: sources.weeklyIssue && sources.weeklyIssue.number
        ? { number: sources.weeklyIssue.number, name: sources.weeklyIssue.name || '' }
        : null,
      count: chosen.length,
      videos: chosen,
    };
  }

  async function buildFeedFromBilibili() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();

    try {
      const tasks = [
        fetchWeekly(controller.signal),
        fetchPrecious(controller.signal),
        ...Array.from({ length: MAX_PAGES }, (_, index) => fetchPage(index + 1, controller.signal)),
      ];
      const results = await Promise.allSettled(tasks);

      const weeklyResult = results[0].status === 'fulfilled' ? results[0].value : null;
      const preciousResult = results[1].status === 'fulfilled' ? results[1].value : [];
      const archives = [];
      let firstError = null;
      for (const result of results.slice(2)) {
        if (result.status === 'fulfilled') archives.push(...result.value);
        else if (!firstError) firstError = result.reason;
      }
      if (
        archives.length === 0 &&
        (!weeklyResult || weeklyResult.items.length === 0) &&
        preciousResult.length === 0
      ) {
        throw firstError instanceof Error ? firstError : new Error('bilibili returned no videos');
      }

      return buildFeed(
        {
          weekly: weeklyResult ? weeklyResult.items : [],
          weeklyIssue: weeklyResult,
          precious: preciousResult,
          archives,
        },
        Date.now(),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const payload = await buildFeedFromBilibili();
        cache = { at: Date.now(), payload };
        failure = { at: 0 };
        return payload;
      } catch (error) {
        failure = { at: Date.now() };
        throw error;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  function sendJson(res, status, payload) {
    if (res.writableEnded) return;
    const body = JSON.stringify(payload);
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-length', Buffer.byteLength(body));
    res.end(res.req && res.req.method === 'HEAD' ? undefined : body);
  }

  async function handle(req, res) {
    let rejection;
    try {
      rejection = ctx.connection.requestRejection(req);
    } catch {
      rejection = 403;
    }
    if (rejection) {
      sendJson(res, rejection, { error: 'forbidden' });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }

    const fresh = cache.payload && Date.now() - cache.at < CACHE_TTL_MS;
    if (fresh) {
      sendJson(res, 200, cache.payload);
      return;
    }

    // Reopen right after a failed refresh: serve what we have instead of
    // hitting a broken upstream again.
    if (Date.now() - failure.at < FAILURE_TTL_MS) {
      if (cache.payload) sendJson(res, 200, { ...cache.payload, stale: true });
      else sendJson(res, 502, { error: 'upstream_unavailable' });
      return;
    }

    try {
      const payload = await refresh();
      sendJson(res, 200, payload);
    } catch (error) {
      if (cache.payload) {
        sendJson(res, 200, { ...cache.payload, stale: true });
        return;
      }
      // The raw upstream text is developer-facing and possibly localized by
      // Bilibili itself, so the client translates a stable code instead.
      if (error) console.warn('[bili-ghost] feed refresh failed:', error);
      sendJson(res, 502, { error: 'upstream_unavailable' });
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE, handler: handle }),
    'bili-ghost: Bilibili feed proxy',
  );
}
