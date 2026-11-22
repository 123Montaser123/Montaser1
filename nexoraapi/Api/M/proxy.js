/* Nexora Standalone Edge Proxy — Vercel Edge Function (place at api/proxy.js + vercel.json) */
export const config = {
  runtime: 'edge'
};

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, Content-Type, Accept, Origin',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges'
      }
    });
  }

  const reqUrl = new URL(request.url);
  const routeHint = reqUrl.searchParams.get('__route') || '';
  const target = reqUrl.searchParams.get('url') || '';
  const ref = reqUrl.searchParams.get('ref') || '';
  const segDirect = reqUrl.searchParams.get('segDirect') === '1';

  if (
    !target &&
    (routeHint === 'health' || reqUrl.pathname === '/health' || reqUrl.pathname === '/' || reqUrl.pathname === '/api/proxy')
  ) {
    return new Response(JSON.stringify({ ok: true, edge: 'vercel-edge', railwayFree: true }), {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
    });
  }

  if (!target || !/^https?:\/\//i.test(target)) {
    return new Response(JSON.stringify({ error: 'invalid_url' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
    });
  }

  const headers = new Headers({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': '*/*'
  });
  if (ref) headers.set('Referer', ref);
  const range = request.headers.get('Range');
  if (range) headers.set('Range', range);

  let up = await fetch(target, { headers, redirect: 'follow' });
  if (up.status === 403 && ref) {
    try {
      headers.set('Referer', new URL(ref).origin + '/');
      up = await fetch(target, { headers, redirect: 'follow' });
    } catch {}
  }
  if (up.status === 403) {
    headers.delete('Referer');
    up = await fetch(target, { headers, redirect: 'follow' });
  }

  const ct = (up.headers.get('content-type') || '').toLowerCase();
  const isHls =
    routeHint === 'hls' ||
    reqUrl.pathname.endsWith('/hls') ||
    ct.includes('mpegurl') ||
    /\.m3u8(\?|$)/i.test(target);

  if (up.ok && isHls) {
    const body = await up.text();
    if (body.includes('#EXTM3U')) {
      const workerOrigin = reqUrl.origin;
      const directApiMode = !routeHint && reqUrl.pathname.startsWith('/api/proxy');
      const buildChildUrl = (ep, abs) => {
        const base = directApiMode
          ? `${workerOrigin}/api/proxy?__route=${ep}&url=`
          : `${workerOrigin}/${ep}?url=`;
        return `${base}${encodeURIComponent(abs)}&ref=${encodeURIComponent(ref)}${segDirect ? '&segDirect=1' : ''}`;
      };

      const rewritten = body.split(/\r?\n/).map((line, i, arr) => {
        const t = line.trim();
        if (!t) return line;
        if (t.startsWith('#')) {
          return line.replace(/URI="([^"]+)"/gi, (_m, u) => {
            try {
              const abs = new URL(u, up.url || target).toString();
              const isPl = /\.m3u8(\?|$)/i.test(abs);
              if (!isPl && segDirect) return `URI="${abs}"`;
              return `URI="${buildChildUrl(isPl ? 'hls' : 'segment', abs)}"`;
            } catch {
              return `URI="${u}"`;
            }
          });
        }
        try {
          const abs = new URL(t, up.url || target).toString();
          const isPl = /\.m3u8(\?|$)/i.test(abs) || (i > 0 && arr[i - 1].includes('#EXT-X-STREAM-INF'));
          if (!isPl && segDirect) return abs;
          return buildChildUrl(isPl ? 'hls' : 'segment', abs);
        } catch {
          return line;
        }
      }).join('\n');

      return new Response(rewritten, {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store'
        }
      });
    }
  }

  const outHeaders = new Headers(up.headers);
  outHeaders.set('Access-Control-Allow-Origin', '*');
  outHeaders.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  return new Response(up.body, { status: up.status, headers: outHeaders });
}