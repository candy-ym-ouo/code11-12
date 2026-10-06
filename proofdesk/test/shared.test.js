import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTC, parseTC, shortTC, evenSegments } from '../shared/timecode.js';
import { planSegment, planMerge, validateResolution, normalizeText } from '../shared/merge.js';
import { parseTranscript } from '../shared/transcript.js';
import { diffText } from '../shared/diff.js';

test('formatTC / parseTC 往返', () => {
  assert.equal(formatTC(0), '00:00:00.000');
  assert.equal(formatTC(3661.5), '01:01:01.500');
  assert.equal(formatTC(3661.5, ','), '01:01:01,500');
  assert.equal(parseTC('01:01:01.500'), 3661.5);
  assert.equal(parseTC('01:01:01,500'), 3661.5);
  assert.equal(parseTC('90:00'), 5400);
  assert.equal(parseTC('12.5'), 12.5);
  assert.equal(parseTC('00:60'), null);
  assert.equal(parseTC(''), null);
  assert.equal(parseTC('abc'), null);
  assert.equal(shortTC(65), '1:05');
  assert.equal(shortTC(3700), '1:01:40');
});

test('evenSegments 等距切分对齐边界', () => {
  const segs = evenSegments(61, 30);
  assert.equal(segs.length, 3);
  assert.deepEqual(segs.map((s) => [s.start, s.end]), [[0, 30], [30, 60], [60, 61]]);
  assert.deepEqual(evenSegments(0), []);
  assert.deepEqual(evenSegments(-3), []);
});

test('planSegment: 无修订 => unreviewed 且 requireAll 时阻塞', () => {
  const r = planSegment({ id: 's1', draftText: '甲' }, [], ['u1', 'u2'], { requireAllMembers: true });
  assert.equal(r.status, 'unreviewed');
  assert.equal(r.blocked, true);
  assert.deepEqual(r.missingUsers, ['u1', 'u2']);
});

test('planSegment: 两人一致 => agreed，不阻塞', () => {
  const edits = [
    { userId: 'u1', text: '  修订后文本' },
    { userId: 'u2', text: '修订后文本' },
  ];
  const r = planSegment({ id: 's1', draftText: '原稿' }, edits, ['u1', 'u2'], { requireAllMembers: true });
  assert.equal(r.status, 'agreed');
  assert.equal(r.blocked, false);
  assert.equal(r.suggested, '  修订后文本');
  assert.equal(normalizeText(r.suggested), '修订后文本');
});

test('planSegment: requireAllMembers 缺一人 => incomplete 阻塞', () => {
  const edits = [{ userId: 'u1', text: '修订' }];
  const r = planSegment({ id: 's1', draftText: '原稿' }, edits, ['u1', 'u2'], { requireAllMembers: true });
  assert.equal(r.status, 'incomplete');
  assert.equal(r.blocked, true);
  assert.deepEqual(r.missingUsers, ['u2']);

  const r2 = planSegment({ id: 's1', draftText: '原稿' }, edits, ['u1', 'u2'], { requireAllMembers: false });
  assert.equal(r2.status, 'agreed');
  assert.equal(r2.blocked, false);
});

test('planSegment: 三种版本 => conflict 阻塞', () => {
  const edits = [
    { userId: 'u1', text: '甲' },
    { userId: 'u2', text: '乙' },
    { userId: 'u3', text: '乙' }, // 多数
  ];
  const r = planSegment({ id: 's1', draftText: '原' }, edits, ['u1', 'u2', 'u3']);
  assert.equal(r.status, 'conflict');
  assert.equal(r.blocked, true);
  assert.equal(r.variants.length, 2);
  assert.equal(r.variants[0].text, '乙'); // 人数多的排前
  assert.equal(r.variants[0].count, 2);
});

test('每人多次提交只取最新版本', () => {
  const edits = [
    { userId: 'u1', text: '旧', submittedAt: '2026-01-01T00:00:00Z' },
    { userId: 'u1', text: '新', submittedAt: '2026-01-02T00:00:00Z' },
    { userId: 'u2', text: '新', submittedAt: '2026-01-03T00:00:00Z' },
  ];
  // planSegment 不去重；去重发生在调用方（domain.mergePlanView 按用户取最新）。
  // 这里验证：把最新版过滤后再传入 => agreed
  const byUser = new Map();
  for (const e of edits) byUser.set(e.userId, e);
  const r = planSegment({ id: 's1', draftText: '' }, [...byUser.values()], ['u1', 'u2']);
  assert.equal(r.status, 'agreed');
});

test('planMerge: canCommit 仅在无阻塞时为真', () => {
  const project = { members: [{ userId: 'u1' }, { userId: 'u2' }], requireAllMembers: true };
  const segments = [
    { id: 'a', draftText: 'A' },
    { id: 'b', draftText: 'B' },
  ];
  const editsBy = {
    a: [
      { userId: 'u1', text: 'A' },
      { userId: 'u2', text: 'A2' },
    ], // conflict
    b: [{ userId: 'u1', text: 'B' }], // incomplete
  };
  const plan = planMerge(project, segments, editsBy);
  assert.equal(plan.canCommit, false);
  assert.equal(plan.counts.conflict, 1);
  assert.equal(plan.counts.incomplete, 1);
  assert.equal(plan.blocking.length, 2);
});

test('planMerge: 冲突段经人工确认后解除阻塞，可以定稿', () => {
  const project = {
    members: [{ userId: 'u1' }, { userId: 'u2' }],
    requireAllMembers: true,
    resolutions: { b: { text: '人工裁定', source: 'manual-custom' } },
  };
  const segments = [
    { id: 'a', draftText: 'A' },
    { id: 'b', draftText: 'B' },
  ];
  const editsBy = {
    a: [{ userId: 'u1', text: 'A' }, { userId: 'u2', text: 'A' }],
    b: [{ userId: 'u1', text: 'B1' }, { userId: 'u2', text: 'B2' }],
  };
  const plan = planMerge(project, segments, editsBy);
  assert.equal(plan.counts.conflict, 1); // 状态本身仍是 conflict
  assert.equal(plan.canCommit, true); // 但已人工确认 => 不阻塞
  assert.deepEqual(plan.blocking, []);
  const bItem = plan.items.find((i) => i.segmentId === 'b');
  assert.equal(bItem.suggested, '人工裁定');
  assert.equal(bItem.resolved, true);
});

test('validateResolution: 冲突段落才能解决，禁止空文本', () => {
  const item = {
    status: 'conflict',
    variants: [{ text: '甲', users: ['u1'] }, { text: '乙', users: ['u2'] }],
  };
  assert.equal(validateResolution(item, '甲').ok, true);
  assert.equal(validateResolution(item, '甲').custom, false);
  assert.equal(validateResolution(item, '我综合一下：丙').custom, true);
  assert.equal(validateResolution(item, '   ').ok, false);
  assert.equal(validateResolution({ status: 'agreed' }, 'x').ok, false);
});

test('parseTranscript: SRT', () => {
  const srt = '1\n00:00:01,000 --> 00:00:03,500\n第一句。\n\n2\n00:00:04.000 --> 00:00:06.000\n第二句。\n';
  const r = parseTranscript(srt);
  assert.equal(r.format, 'srt');
  assert.equal(r.segments.length, 2);
  assert.equal(r.segments[0].start, 1);
  assert.equal(r.segments[0].end, 3.5);
  assert.equal(r.segments[0].text, '第一句。');
});

test('parseTranscript: 行内时间码', () => {
  const txt = '[00:00:03] 那年冬天。\n继续说。\n[00:15] 他走了四十天。\n';
  const r = parseTranscript(txt);
  assert.equal(r.format, 'inline-tc');
  assert.equal(r.segments.length, 2);
  assert.equal(r.segments[0].start, 3);
  assert.equal(r.segments[0].end, 15);
  assert.equal(r.segments[0].text, '那年冬天。\n继续说。');
});

test('parseTranscript: 自然段', () => {
  const r = parseTranscript('第一段话。\n\n第二段话。\n');
  assert.equal(r.format, 'paragraphs');
  assert.equal(r.segments.length, 2);
  assert.equal(r.segments[0].start, null);
});

test('diffText: 增删改均能检出', () => {
  const ops = diffText('今天天气很好', '今天天气非常好');
  const kinds = ops.map(([k]) => k).join('');
  assert.match(kinds, /ins/);
  const del = diffText('abc', '');
  assert.ok(del.some(([k]) => k === 'del'));
  const same = diffText('完全相同', '完全相同');
  assert.ok(same.every(([k]) => k === 'eq'));
});
