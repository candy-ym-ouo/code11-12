// API 封装：令牌存 localStorage；二进制音频单独走 fetch
const TOKEN_KEY = 'proofdesk.token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}
export function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export async function api(method, path, body) {
  const headers = { 'x-auth-token': getToken() };
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers, body: payload });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `请求失败 (${res.status})`, data.details);
  return data;
}

export async function uploadAudio(projectId, blob, duration) {
  const res = await fetch(`/api/projects/${projectId}/audio`, {
    method: 'POST',
    headers: {
      'x-auth-token': getToken(),
      'content-type': blob.type || 'audio/mpeg',
      ...(duration ? { 'x-audio-duration': String(duration) } : {}),
    },
    body: blob,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || '音频上传失败');
  return data;
}

export function mediaUrl(projectId) {
  return `/api/projects/${projectId}/media?token=${encodeURIComponent(getToken())}`;
}

export async function downloadText(path, fallbackName) {
  const res = await fetch(path, { headers: { 'x-auth-token': getToken() } });
  if (!res.ok) throw new ApiError(res.status, '导出失败');
  const cd = res.headers.get('content-disposition') || '';
  const m = cd.match(/filename\*=UTF-8''(.+)$/);
  const name = m ? decodeURIComponent(m[1]) : fallbackName;
  const text = await res.text();
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
