import { api } from './api.js';
import { avatar, fmtTime, h } from './dom.js';

const EVENT_LABELS = {
  'user.login': '登录校对台',
  'user.rename': '修改署名',
  'project.create': '创建项目',
  'project.update': '修改项目设置',
  'project.commit': '定稿落库',
  'project.reopen': '重新打开修订',
  'member.add': '加入校对成员',
  'member.remove': '移除校对成员',
  'audio.upload': '上传/更换音频',
  'segments.replace': '（重新）导入分段原稿',
  'segment.update': '修改段落时间码/原稿',
  'segment.split': '拆分段落',
  'segment.merge': '合并相邻段落',
  'edit.submit': '提交校对修订',
  'merge.auto': '自动合并一致段落',
  'resolution.set': '人工确认冲突段落',
  'resolution.clear': '撤销冲突确认',
};

export async function renderHistory(ctx) {
  const { workEl, project: p } = ctx;
  const wrap = h('div', { class: 'timeline' });
  workEl.append(wrap);

  wrap.append(h('h2', { style: 'margin:4px 0 4px' }, '版本与操作历史'));
  wrap.append(h('p', { class: 'muted', style: 'margin:0 0 16px' },
    '所有修订按时间留痕，旧版本不会被覆盖：每次提交都记录提交人、时间与文本；段落拆分/合并与人工确认同样可追溯。'));

  // 分段统计
  const segCount = p.segments.length;
  const editCount = p.segments.reduce(
    (n, s) => n + (s.myEdit || s.others.length ? 1 : 0), 0,
  );
  wrap.append(h('div', { class: 'panel', style: 'margin-bottom:18px' }, [
    h('div', { style: 'display:flex;gap:24px;flex-wrap:wrap;font-size:14px' }, [
      h('span', {}, `段落总数：${segCount}`),
      h('span', {}, `存在修订的段落：${p.review.counts.total - p.review.counts.unreviewed}`),
      h('span', {}, `冲突：${p.review.counts.conflict}`),
      h('span', {}, `状态：${p.status === 'confirmed' ? '已定稿' : '校对中'}`),
      p.finalVersion
        ? h('span', {}, `定稿时间：${fmtTime(p.finalVersion.committedAt)}`)
        : null,
    ]),
  ]));

  const [history] = await Promise.all([
    api('GET', `/api/projects/${p.id}/history`),
  ]);

  if (!history.events.length) {
    wrap.append(h('div', { class: 'empty muted' }, '暂无操作记录'));
    return;
  }

  for (const e of history.events) {
    const seg = e.segmentId ? p.segments.find((s) => s.id === e.segmentId) : null;
    wrap.append(h('div', { class: 'tl-item' }, [
      h('span', { class: 'at' }, fmtTime(e.at)),
      avatar(e.userName || '系统', e.userId || e.by || 'x', 'sm'),
      h('span', { class: 'what' }, [
        h('b', {}, e.userName || '系统'),
        ' ',
        EVENT_LABELS[e.type] || e.type,
        seg ? h('span', { class: 'muted' }, `（#${seg.order + 1}）`) : null,
        e.type === 'merge.auto' && e.applied != null ? h('span', { class: 'muted' }, ` ${e.applied} 段`) : null,
      ]),
    ]));
  }
}
