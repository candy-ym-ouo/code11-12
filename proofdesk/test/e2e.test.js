// 端到端流程测试：起服务 -> 建项目/加人/分段 -> 多端修订 ->
// 冲突拦截定稿 -> 人工确认 -> 定稿落库 -> 重开
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';

let server;
let base;
let tmpDir;
let tokens = {};
let projectId;
let segIds = [];

async function call(method, path, { token, body, raw, headers = {} } = {}) {
  const h = {};
  if (token) h['x-auth-token'] = token;
  if (body !== undefined) {
    h['content-type'] = 'application/json';
    raw = JSON.stringify(body);
  }
  Object.assign(h, headers);
  const res = await fetch(base + path, { method, headers: h, body: raw });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const login = async (name) => {
  const r = await call('POST', '/api/login', { body: { name } });
  assert.equal(r.status, 200);
  tokens[name] = r.data.token;
  return r.data;
};

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'proofdesk-e2e-'));
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: '8931', PROOFDESK_DATA: tmpDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = 'http://127.0.0.1:8931';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server boot timeout')), 8000);
    server.stdout.on('data', (d) => {
      if (String(d).includes('已启动')) {
        clearTimeout(t);
        resolve();
      }
    });
    server.stderr.on('data', (d) => process.stderr.write(d));
  });
});

after(async () => {
  server.kill('SIGKILL');
  await rm(tmpDir, { recursive: true, force: true });
});

test('完整多人校对-冲突-确认-定稿流程', async () => {
  // 1. 三人登录
  const editor = await login('王编辑');
  await login('林校对');
  await login('赵校对');

  // 2. 建项目（含另两人）
  let r = await call('POST', '/api/projects', {
    token: tokens['王编辑'],
    body: { name: 'E2E 口述项目', memberNames: ['林校对', '赵校对'], requireAllMembers: true },
  });
  assert.equal(r.status, 200);
  projectId = r.data.id;
  assert.equal(r.data.membersCount, 3);

  // 3. 导入 3 段（PUT segments，带时间码）
  r = await call('PUT', `/api/projects/${projectId}/segments`, {
    token: tokens['王编辑'],
    body: {
      segments: [
        { start: 0, end: 5, text: '原稿第一段。' },
        { start: 5, end: 10, text: '原稿第二段。' },
        { start: 10, end: 15, text: '原稿第三段。' },
      ],
    },
  });
  assert.equal(r.status, 200);
  segIds = r.data.segments.map((s) => s.id);

  // 4. 段1：三人一致；段2：冲突；段3：只一人校对
  const save = (name, sid, text) =>
    call('PUT', `/api/projects/${projectId}/segments/${sid}/edit`, { token: tokens[name], body: { text } });

  assert.equal((await save('王编辑', segIds[0], '原稿第一段。')).status, 200);
  assert.equal((await save('林校对', segIds[0], '原稿第一段。')).status, 200);
  assert.equal((await save('赵校对', segIds[0], '原稿第一段。')).status, 200);

  await save('王编辑', segIds[1], '第二段，王版。');
  await save('林校对', segIds[1], '第二段，林版。');
  await save('赵校对', segIds[1], '第二段，赵版。');

  await save('王编辑', segIds[2], '原稿第三段。');

  // 5. 合并计划：1 agreed / 1 conflict / 1 incomplete
  r = await call('GET', `/api/projects/${projectId}/merge-plan`, { token: tokens['王编辑'] });
  assert.equal(r.status, 200);
  assert.equal(r.data.counts.agreed, 1);
  assert.equal(r.data.counts.conflict, 1);
  assert.equal(r.data.counts.incomplete, 1);
  assert.equal(r.data.canCommit, false);

  const conflictItem = r.data.items.find((i) => i.status === 'conflict');
  assert.equal(conflictItem.variants.length, 3);

  // 6. 非创建者不能确认冲突
  r = await call('POST', `/api/projects/${projectId}/resolutions/${conflictItem.segmentId}`, {
    token: tokens['林校对'], body: { variantIndex: 0 },
  });
  assert.equal(r.status, 403);

  // 7. 定稿被拦截（有冲突 + 有未齐）
  r = await call('POST', `/api/projects/${projectId}/commit`, { token: tokens['王编辑'] });
  assert.equal(r.status, 409);
  assert.ok(r.data.details.blockingSegmentIds.length >= 2);

  // 8. 自动合并一致段落
  r = await call('POST', `/api/projects/${projectId}/auto-merge`, { token: tokens['王编辑'] });
  assert.equal(r.status, 200);
  assert.equal(r.data.applied, 1);

  // 9. 补齐段3 其余两人
  await save('林校对', segIds[2], '原稿第三段。');
  await save('赵校对', segIds[2], '原稿第三段。');

  // 10. 冲突段：非法确认（空文本改写）被拒
  r = await call('POST', `/api/projects/${projectId}/resolutions/${conflictItem.segmentId}`, {
    token: tokens['王编辑'], body: { text: '   ' },
  });
  assert.equal(r.status, 400);

  // 11. 人工改写确认冲突
  r = await call('POST', `/api/projects/${projectId}/resolutions/${conflictItem.segmentId}`, {
    token: tokens['王编辑'], body: { text: '第二段，经人工裁定的最终文本。' },
  });
  assert.equal(r.status, 200);

  // 12. 此时可以定稿
  r = await call('GET', `/api/projects/${projectId}/merge-plan`, { token: tokens['王编辑'] });
  assert.equal(r.data.canCommit, true, '冲突已确认且全员齐，应可定稿');

  r = await call('POST', `/api/projects/${projectId}/commit`, { token: tokens['王编辑'] });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'confirmed');

  // 13. 定稿后修订被锁定
  r = await save('王编辑', segIds[0], '想再改改');
  assert.equal(r.status, 409);

  // 14. 导出 SRT/TXT
  for (const ext of ['srt', 'txt']) {
    const res = await fetch(`${base}/api/projects/${projectId}/export.${ext}`, {
      headers: { 'x-auth-token': tokens['王编辑'] },
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('人工裁定'), `${ext} 导出应包含人工确认文本`);
  }

  // 15. 创建者重新打开，状态回 draft，修订仍在
  r = await call('POST', `/api/projects/${projectId}/reopen`, { token: tokens['王编辑'] });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'draft');
  r = await call('GET', `/api/projects/${projectId}/segments/${segIds[1]}/history`, {
    token: tokens['王编辑'],
  });
  assert.ok(r.data.edits.length >= 3, '三人修订史应保留');

  // 16. 越权：非成员看不到项目
  const outsider = await login('路人甲');
  r = await call('GET', `/api/projects/${projectId}`, { token: outsider.token });
  assert.equal(r.status, 403);
});

test('权限与校验：未登录 401、时间码倒置 400、添加重复成员 409', async () => {
  let r = await call('GET', '/api/projects');
  assert.equal(r.status, 401);

  r = await call('PUT', `/api/projects/${projectId}/segments`, {
    token: tokens['王编辑'],
    body: { segments: [{ start: 10, end: 5, text: '倒置' }] },
  });
  assert.equal(r.status, 400);

  r = await call('POST', `/api/projects/${projectId}/members`, {
    token: tokens['王编辑'], body: { name: '林校对' },
  });
  assert.equal(r.status, 409);
});

test('音频：上传 WAV 后可 Range 读取', async () => {
  // 构造一个最小 WAV（44 字节头 + 少量采样）
  const data = Buffer.alloc(44 + 8000);
  data.write('RIFF', 0);
  data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVE', 8);
  data.write('fmt ', 12);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(8000, 24);
  data.writeUInt32LE(16000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(8000, 40);

  const create = await call('POST', '/api/projects', {
    token: tokens['王编辑'], body: { name: '音频测试', memberNames: [] },
  });
  const pid = create.data.id;
  const up = await call('POST', `/api/projects/${pid}/audio`, {
    token: tokens['王编辑'], raw: data, headers: { 'content-type': 'audio/wav' },
  });
  assert.equal(up.status, 200);

  const res = await fetch(`${base}/api/projects/${pid}/media?token=${encodeURIComponent(tokens['王编辑'])}`, {
    headers: { Range: 'bytes=0-1023' },
  });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 0-1023/${data.length}`);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.length, 1024);
});
