// Local dev server that mimics Vercel: static files from public/ (clean URLs),
// /api/* routed to the serverless handlers, and the same security headers.
// Usage: node tools/dev-server.mjs [port]
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const vercel = JSON.parse(await readFile(join(root, 'vercel.json'), 'utf8'));
const globalHeaders = vercel.headers.find((h) => h.source === '/(.*)').headers;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.png': 'image/png', '.mp4': 'video/mp4', '.webm': 'video/webm', '.json': 'application/json' };
const port = Number(process.argv[2]) || 3000;

async function file(p) { try { const s = await stat(p); return s.isFile() ? p : null; } catch { return null; } }

http.createServer(async (req, res) => {
  for (const h of globalHeaders) res.setHeader(h.key, h.value);
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      const mod = await import(pathToFileURL(join(root, `${url.pathname}.js`)).href);
      return mod.default(req, res);
    }
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    const base = join(root, 'public', rel);
    const p = (await file(base)) || (await file(`${base}.html`)) || (await file(join(base, 'index.html')));
    if (!p) { res.statusCode = 404; return res.end('Not found'); }
    const data = await readFile(p);
    res.setHeader('Content-Type', TYPES[extname(p)] || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    const range = req.headers.range;
    if (range) {
      const [s, e] = range.replace('bytes=', '').split('-').map((x) => (x === '' ? NaN : Number(x)));
      const end = Number.isFinite(e) ? Math.min(e, data.length - 1) : data.length - 1;
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${s}-${end}/${data.length}`);
      return res.end(data.subarray(s, end + 1));
    }
    res.end(data);
  } catch (e) {
    console.error(e); res.statusCode = 500; res.end('Server error');
  }
}).listen(port, () => console.log(`http://localhost:${port}`));
