// 极简 HTTP 工具

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export async function readJson(req, limit) {
  const type = req.headers['content-type'] || '';
  if (!type.includes('application/json')) {
    throw new HttpError(415, '需要 application/json 请求体');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, '请求体过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON 解析失败');
  }
}

export async function readRaw(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, '音频文件过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** 简单路径模式：/api/projects/:id/segments -> {params, route} */
export function compileRoutes(routes) {
  return routes.map(([method, pattern, handler]) => {
    const names = [];
    const re = new RegExp(
      '^' +
        pattern.replace(/:[^/]+/g, (m) => {
          names.push(m.slice(1));
          return '([^/]+)';
        }) +
        '$',
    );
    return { method, re, names, handler };
  });
}
