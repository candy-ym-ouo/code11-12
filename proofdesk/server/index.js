// 校对台 HTTP 入口：API + 静态资源 + 音频 Range 分发
import { createServer } from 'node:http';
import { stat, readFile, createReadStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { Store } from './store.js';
import { buildRoutes } from './routes.js';
import { compileRoutes, HttpError, sendJson } from './http-util.js';
import {
  DATA_DIR,
  DB_FILE,
  MAX_JSON_BYTES,
  MEDIA_DIR,
  PORT,
  ROOT,
} from './config.js';

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  // 只允许 web/ 与 shared/ 下的文件
  const url = new URL(req.url, 'http://localhost');
  let rel;
  if (pathname === '/' || pathname === '') rel = '/web/index.html';
  else if (pathname.startsWith('/shared/')) rel = pathname;
  else rel = '/web' + (pathname.startsWith('/') ? pathname : '/' + pathname);

  const filePath = normalize(join(ROOT, rel));
  const allowed = [normalize(join(ROOT, 'web')), normalize(join(ROOT, 'shared'))];
  if (!allowed.some((base) => filePath.startsWith(base + '/')) && !allowed.includes(filePath)) {
    sendJson(res, 403, { error: '禁止访问' });
    return;
  }

  stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      // SPA 回退
      if (!pathname.startsWith('/shared/') && !extname(pathname)) {
        readFile(join(ROOT, 'web/index.html'), (e2, html) => {
          if (e2) return sendJson(res, 404, { error: 'not found' });
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(html);
        });
        return;
      }
      return sendJson(res, 404, { error: '文件不存在' });
    }
    const type = STATIC_TYPES[extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'content-length': st.size,
      'cache-control': 'no-cache',
    });
    createReadStream(filePath).pipe(res);
  });
}

function serveMedia(req, res, project, store) {
  if (!project.audio) {
    sendJson(res, 404, { error: '项目未上传音频' });
    return;
  }
  const filePath = join(MEDIA_DIR, project.audio.filename);
  stat(filePath, (err, st) => {
    if (err) return sendJson(res, 404, { error: '音频文件丢失' });
    const type = project.audio.contentType;
    const range = req.headers.range;
    if (range) {
      const m = range.match(/bytes=(\d*)-(\d*)/);
      if (m) {
        const total = st.size;
        let start = m[1] === '' ? null : Number(m[1]);
        let end = m[2] === '' ? null : Number(m[2]);
        if (start === null) {
          start = Math.max(0, total - (end || 0));
          end = total - 1;
        } else if (end === null || end >= total) {
          end = total - 1;
        }
        if (start > end || start >= total) {
          res.writeHead(416, { 'content-range': `bytes */${total}` });
          return res.end();
        }
        res.writeHead(206, {
          'content-type': type,
          'accept-ranges': 'bytes',
          'content-range': `bytes ${start}-${end}/${total}`,
          'content-length': end - start + 1,
          'cache-control': 'private, max-age=3600',
        });
        return createReadStream(filePath, { start, end }).pipe(res);
      }
    }
    res.writeHead(200, {
      'content-type': type,
      'content-length': st.size,
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=3600',
    });
    createReadStream(filePath).pipe(res);
  });
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(MEDIA_DIR, { recursive: true });
  const store = await new Store(DB_FILE).load();
  const routes = compileRoutes(buildRoutes(store));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    try {
      // 媒体：/api/projects/:id/media
      const mediaMatch = pathname.match(/^\/api\/projects\/([^/]+)\/media$/);
      if (mediaMatch && req.method === 'GET') {
        const token = (req.headers['x-auth-token'] || url.searchParams.get('token') || '');
        const project = store.data.projects.find((p) => p.id === mediaMatch[1]);
        const user = store.data.users.find((u) => u.token === token);
        if (!project || !user || !project.members.some((m) => m.userId === user.id)) {
          return sendJson(res, 403, { error: '无权访问该音频' });
        }
        return serveMedia(req, res, project, store);
      }

      if (pathname.startsWith('/api/')) {
        const ctx = {
          req,
          res,
          token: req.headers['x-auth-token'] || '',
          query: url.searchParams,
          params: {},
        };
        for (const route of routes) {
          if (route.method !== req.method) continue;
          const m = pathname.match(route.re);
          if (!m) continue;
          route.names.forEach((n, i) => (ctx.params[n] = decodeURIComponent(m[i + 1])));
          const result = await route.handler(ctx);
          if (result?.contentType === 'text/plain') {
            res.writeHead(200, {
              'content-type': `${result.contentType}; charset=utf-8`,
              'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
            });
            return res.end(result.body);
          }
          if (!res.writableEnded) return sendJson(res, 200, result ?? { ok: true });
        }
        return sendJson(res, 404, { error: `接口不存在: ${req.method} ${pathname}` });
      }

      if (req.method === 'GET') return serveStatic(req, res, pathname);
      sendJson(res, 405, { error: 'method not allowed' });
    } catch (err) {
      if (err instanceof HttpError) {
        return sendJson(res, err.status, { error: err.message, details: err.details });
      }
      console.error('[server]', err);
      sendJson(res, 500, { error: '服务器内部错误' });
    }
  });

  server.listen(PORT, () => {
    console.log(`✓ 口述听写稿校对台已启动: http://localhost:${PORT}`);
    console.log(`  数据目录: ${DATA_DIR}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
