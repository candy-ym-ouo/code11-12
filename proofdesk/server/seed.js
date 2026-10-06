// 生成演示数据：三个校对人 + 一段 20 秒的 WAV + 4 个段落
//   段1 agreed（两人一致）  段2 conflict（三种文本）  段3 incomplete（只一人校对）
//   段4 unreviewed
// 运行：npm run seed
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Store, newId } from './store.js';
import { DATA_DIR, DB_FILE, MEDIA_DIR } from './config.js';
import { nowISO } from './domain.js';

function makeWav(seconds = 20, freq = 220, sampleRate = 22050) {
  // 生成带淡入淡出的正弦波，便于听见分段边界；加少量频率变化模拟"口述"
  const n = Math.floor(seconds * sampleRate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const segFreq = freq * (1 + 0.15 * Math.sin(t * 0.8));
    const env = Math.min(1, t / 0.05, (seconds - t) / 0.05);
    const v = Math.sin(2 * Math.PI * segFreq * t) * 0.25 * env;
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function main() {
  await mkdir(MEDIA_DIR, { recursive: true });
  if (existsSync(DB_FILE)) await rm(DB_FILE);

  const store = await new Store(DB_FILE).load();
  const db = store.data;
  const at = (offsetSec) => new Date(Date.now() + offsetSec * 1000).toISOString();

  const mkUser = (name) => ({
    id: newId(),
    name,
    token: newId() + newId(),
    createdAt: at(-3600),
  });
  const creator = mkUser('王编辑');
  const lin = mkUser('林校对');
  const zhao = mkUser('赵校对');
  db.users.push(creator, lin, zhao);

  const wav = makeWav(20, 196);
  const fileId = newId();
  const filename = `${fileId}.wav`;
  await writeFile(join(MEDIA_DIR, filename), wav);

  const project = {
    id: newId(),
    name: '祖父口述·一九四八年冬（演示）',
    description: '演示项目：段1 已一致；段2 三人三种文本（冲突，待人工确认）；段3 仅一人校对；段4 未校对。',
    status: 'draft',
    requireAllMembers: true,
    audio: {
      fileId,
      filename,
      contentType: 'audio/wav',
      bytes: wav.length,
      duration: 20,
      uploadedAt: at(-3000),
    },
    createdBy: creator.id,
    createdAt: at(-3000),
    updatedAt: at(-10),
    members: [
      { userId: creator.id, role: 'creator', joinedAt: at(-3000) },
      { userId: lin.id, role: 'reviewer', joinedAt: at(-2900) },
      { userId: zhao.id, role: 'reviewer', joinedAt: at(-2900) },
    ],
    resolutions: {},
    finalVersion: null,
  };
  db.projects.push(project);

  const segData = [
    { start: 0, end: 5, text: '那年冬天，祖父把木箱抬进了堂屋，谁也不让碰。' },
    { start: 5, end: 10, text: '他说这是他从关外带回来的，路上走了整整四十天。' },
    { start: 10, end: 15, text: '箱子里有几件旧衣裳，和一沓用毛边纸订成的本子。' },
    { start: 15, end: 20, text: '后来我们才知道，那些本子上记的，全是一家人的来路。' },
  ];
  const segs = segData.map((s, i) => ({
    id: newId(),
    projectId: project.id,
    order: i,
    start: s.start,
    end: s.end,
    speaker: i % 2 ? '祖父' : '旁白',
    draftText: s.text,
    createdAt: at(-2800),
  }));
  db.segments.push(...segs);

  const addEdit = (seg, user, text, offset) => {
    db.edits.push({
      id: newId(),
      segmentId: seg.id,
      projectId: project.id,
      userId: user.id,
      text,
      submittedAt: at(offset),
      supersedes: null,
    });
  };

  // 段1：全员一致（与原稿同）
  addEdit(segs[0], creator, '那年冬天，祖父把木箱抬进了堂屋，谁也不让碰。', -1100);
  addEdit(segs[0], lin, '那年冬天，祖父把木箱抬进了堂屋，谁也不让碰。', -1000);
  addEdit(segs[0], zhao, '那年冬天，祖父把木箱抬进了堂屋，谁也不让碰。', -900);

  // 段2：三种文本 => conflict
  addEdit(segs[1], creator, '他说，这是他从关外带回来的，路上走了整整四十天。', -800);
  addEdit(segs[1], lin, '他说这是他从关外带回来的，路上整整走了四十天。', -700);
  addEdit(
    segs[1],
    zhao,
    '他说这是他从关外带回来的，路上走了整整四十多天。',
    -600,
  );

  // 段3：只有一人校对 => incomplete
  addEdit(
    segs[2],
    lin,
    '箱子里有几件旧衣裳，和一沓用毛边纸订起来的本子。',
    -500,
  );
  // 段4：无人校对

  db.events.push({
    id: newId(),
    at: at(-3000),
    type: 'project.create',
    projectId: project.id,
    userId: creator.id,
  });
  await store.persist();

  console.log('✓ 演示数据已写入:', DB_FILE);
  console.log('  项目:', project.name);
  console.log('  登录令牌（可在登录页直接粘贴）:');
  for (const u of [creator, lin, zhao]) {
    console.log(`   ${u.name.padEnd(6)} ${u.token}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
