import { api, downloadText } from './api.js';
import { avatar, h, modal, toast } from './dom.js';
import { formatTC } from '/shared/timecode.js';
import { player } from './player.js';

export async function renderReview(ctx) {
  const { workEl, project: p, isCreator, refresh } = ctx;
  const wrap = h('div', { style: 'max-width:960px;margin:0 auto' });
  workEl.append(wrap);

  let plan;
  try {
    plan = await api('GET', `/api/projects/${p.id}/merge-plan`);
  } catch (e) {
    wrap.append(h('div', { class: 'empty' }, e.message));
    return;
  }

  const c = plan.counts;
  const resolvedConflicts = plan.items.filter(
    (i) => i.status === 'conflict' && i.resolution,
  ).length;

  // ---- 已定稿视图 ----
  if (p.status === 'confirmed') {
    wrap.append(
      h('div', { class: 'review-summary' }, [
        h('div', { style: 'display:flex;align-items:center;gap:10px' }, [
          h('span', { class: 'badge confirmed' }, '已定稿'),
          h('b', { style: 'font-size:16px' }, '全稿已完成人工确认并落库'),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn sm', onClick: () => downloadText(`/api/projects/${p.id}/export.srt`, '定稿.srt') }, '导出 SRT'),
          h('button', { class: 'btn primary sm', onClick: () => downloadText(`/api/projects/${p.id}/export.txt`, '定稿.txt') }, '导出 TXT'),
          isCreator
            ? h('button', {
                class: 'btn danger sm',
                onClick: async () => {
                  if (!confirm('重新打开项目？定稿将撤销（修订与历史全部保留），需再次确认落库。')) return;
                  await api('POST', `/api/projects/${p.id}/reopen`);
                  toast('项目已重新打开');
                  await refresh('review');
                },
              }, '重新打开修订')
            : null,
        ]),
        h('div', { class: 'muted', style: 'margin-top:8px;font-size:13px' },
          `定稿时间：${new Date(p.finalVersion.committedAt).toLocaleString()}　共 ${c.total} 段`),
      ]),
    );
    return;
  }

  // ---- 统计卡片 ----
  const stat = (cls, num, lbl) =>
    h('div', { class: `stat ${cls}` }, [h('div', { class: 'num' }, String(num)), h('div', { class: 'lbl' }, lbl)]);

  const summary = h('div', { class: 'review-summary' }, [
    h('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap' }, [
      h('b', { style: 'font-size:16px' }, '版本合并总览'),
      h('span', { class: 'spacer' }),
      isCreator
        ? h('button', {
            class: 'btn sm',
            title: '把所有「一致」段落自动落库',
            onClick: async () => {
              const r = await api('POST', `/api/projects/${p.id}/auto-merge`);
              toast(`已自动合并 ${r.applied} 个一致段落`);
              await refresh('review');
            },
          }, '一键自动合并一致段落')
        : null,
      h('button', { class: 'btn sm', onClick: () => downloadText(`/api/projects/${p.id}/export.srt`, '定稿.srt'), disabled: true, title: '定稿后可导出' }, '导出 SRT'),
    ]),
    h('div', { class: 'stat-row' }, [
      stat('', c.total, '总段落'),
      stat('s-agreed', c.agreed, '全员一致'),
      stat('s-conflict', c.conflict, `冲突待确认${c.conflict ? `（已处理 ${resolvedConflicts}）` : ''}`),
      stat('s-incomplete', c.incomplete, '未齐（有成员未校）'),
      stat('', c.unreviewed, '无人校对'),
    ]),
    h('div', { style: 'font-size:13.5px' },
      plan.canCommit
        ? h('span', { style: 'color:var(--green)' }, '✓ 无阻塞项，可以定稿落库。')
        : [
            h('span', { style: 'color:var(--red)' }, '✗ 尚不能定稿：'),
            c.conflict - resolvedConflicts > 0
              ? h('span', {}, `${c.conflict - resolvedConflicts} 个冲突段落未经人工确认；`)
              : null,
            c.incomplete > 0 ? h('span', {}, `${c.incomplete} 个段落尚未全员校对；`) : null,
            c.unreviewed > 0 && p.requireAllMembers
              ? h('span', {}, `${c.unreviewed} 个段落无人校对；`)
              : null,
          ],
    ),
    isCreator
      ? h('div', { style: 'margin-top:14px' }, [
          h('button', {
            class: 'btn primary',
            disabled: !plan.canCommit,
            onClick: async () => {
              if (!confirm('确认定稿？定稿后全稿锁定，可导出 SRT/TXT。之后仍可由创建者重新打开。')) return;
              try {
                await api('POST', `/api/projects/${p.id}/commit`);
                toast('全稿已定稿落库');
                await refresh('review');
              } catch (e) {
                alert(e.message + (e.details?.blockingSegmentIds ? `\n阻塞段落：${e.details.blockingSegmentIds.length} 个` : ''));
              }
            },
          }, '确认无误，定稿落库'),
        ])
      : h('div', { class: 'muted', style: 'margin-top:10px;font-size:13px' }, '仅项目创建者可执行自动合并、冲突确认与定稿。'),
  ]);
  wrap.append(summary);

  // ---- 冲突段落列表（核心：必须人工确认） ----
  const conflicts = plan.items.filter((i) => i.status === 'conflict');
  if (conflicts.length) {
    wrap.append(h('h3', { style: 'margin:22px 0 10px' }, `⚠ 冲突段落（${conflicts.length}）—— 逐条人工确认后落库`));
    for (const item of conflicts) {
      wrap.append(renderConflictCard(item, ctx));
    }
  }

  // ---- 未齐段落 ----
  const incomplete = plan.items.filter((i) => i.status === 'incomplete');
  if (incomplete.length) {
    wrap.append(h('h3', { style: 'margin:22px 0 10px' }, `⏳ 尚未全员校对（${incomplete.length}）`));
    for (const item of incomplete) {
      wrap.append(h('div', { class: 'panel', style: 'margin-bottom:10px;padding:12px 16px' }, [
        h('div', { style: 'display:flex;gap:10px;align-items:center' }, [
          h('span', { class: 'mono muted' }, `#${(item.order ?? 0) + 1}`),
          h('span', { class: 'tc', onClick: () => item.start != null && player.playRange(item.start, item.end ?? item.start + 2) },
            item.start != null ? formatTC(item.start).slice(3) : ''),
          h('span', { class: 'badge incomplete' }, '未齐'),
          h('span', { class: 'muted', style: 'font-size:13px' },
            '等待：' + item.missingUserNames.join('、')),
        ]),
        h('div', { class: 'muted', style: 'margin-top:6px;font-size:13.5px;white-space:pre-wrap' },
          '已有版本：' + (item.variants[0]?.text || item.baseline)),
      ]));
    }
  }

  // ---- 一致段落（可展开查看落库情况） ----
  const agreed = plan.items.filter((i) => i.status === 'agreed');
  if (agreed.length) {
    const box = h('div', {});
    wrap.append(
      h('h3', { style: 'margin:22px 0 10px;display:flex;align-items:center;gap:10px' }, [
        h('span', {}, `✓ 全员一致（${agreed.length}）`),
        h('button', {
          class: 'btn sm ghost',
          onClick: () => { box.hidden = !box.hidden; },
        }, '展开/收起'),
      ]),
      box,
    );
    for (const item of agreed.slice(0, 200)) {
      box.append(h('details', { style: 'margin-bottom:6px' }, [
        h('summary', { style: 'cursor:pointer;font-size:13.5px' }, [
          h('span', { class: 'mono muted' }, `#${(item.order ?? 0) + 1} `),
          h('span', { class: 'badge agreed' }, '一致'),
          h('span', { style: 'margin-left:8px' }, truncate(item.suggested, 60)),
        ]),
        h('div', { style: 'padding:8px 4px;white-space:pre-wrap' }, item.suggested),
      ]));
    }
  }
}

function renderConflictCard(item, ctx) {
  const { project: p, isCreator, refresh } = ctx;
  const existing = item.resolution;
  const card = h('div', { class: 'conflict-card' + (existing ? ' resolved' : '') });

  card.append(h('div', { class: 'seg-head', style: 'padding:10px 16px' }, [
    h('span', { class: 'idx mono' }, `#${(item.order ?? 0) + 1}`),
    h('span', {
      class: 'tc',
      onClick: () => item.start != null && player.playRange(item.start, item.end ?? item.start + 2),
    }, item.start != null ? formatTC(item.start).slice(3) : ''),
    h('span', { class: 'badge conflict' }, existing ? '已人工确认' : '待人工确认'),
    h('span', { class: 'spacer' }),
    h('span', {
      class: 'btn ghost sm',
      onClick: () => player.playRange(item.start ?? 0, item.end ?? (item.start ?? 0) + 2),
    }, '🔁 听原音频'),
  ]));

  const body = h('div', { class: 'conflict-body' });
  body.append(h('div', { class: 'muted', style: 'font-size:13px' }, [
    '原稿：',
    h('span', { style: 'color:var(--ink)' }, item.baseline),
  ]));

  let chosen = { type: 'variant', value: existing?.source === 'manual-custom' ? 'custom' : '0' };
  const customTa = h('textarea', {
    class: 'input', rows: 3, placeholder: '也可以综合各版本，在此人工改写最终文本',
  }, existing?.source === 'manual-custom' ? existing.text : '');

  item.variants.forEach((v, i) => {
    const checked = existing
      ? (existing.source === 'manual-pick' && existing.text === v.text)
      : i === 0;
    if (checked && existing) chosen = { type: 'variant', value: String(i) };
    const radio = h('input', {
      type: 'radio', name: `v-${item.segmentId}`,
      checked,
      onChange: () => {
        chosen = { type: 'variant', value: String(i) };
        card.querySelectorAll('.variant').forEach((n) => n.classList.remove('picked'));
        radio.closest('.variant').classList.add('picked');
      },
    });
    const node = h('div', { class: 'variant' + (checked ? ' picked' : '') }, [
      radio,
      h('div', { style: 'flex:1' }, [
        h('div', { class: 'txt' }, v.text),
        h('div', { class: 'meta' }, [
          ...v.users.map((uid, k) =>
            h('span', { style: 'display:inline-flex;align-items:center;gap:4px' }, [
              avatar(v.userNames[k], uid, 'sm'),
              h('span', {}, v.userNames[k]),
            ]),
          ),
          h('span', {}, `（${v.count} 人）`),
        ]),
      ]),
    ]);
    body.append(node);
  });

  const customRadio = h('input', {
    type: 'radio', name: `v-${item.segmentId}`,
    checked: existing?.source === 'manual-custom',
    onChange: () => (chosen = { type: 'custom' }),
  });
  body.append(h('div', { class: 'variant' + (existing?.source === 'manual-custom' ? ' picked' : '') }, [
    customRadio,
    h('div', { style: 'flex:1' }, [h('div', {}, [h('b', {}, '✍ 人工改写：'), customTa])]),
  ]));

  if (existing) {
    body.append(h('div', { style: 'font-size:12.5px;color:var(--green)' },
      `当前落库文本：${existing.source === 'auto' ? '自动' : '人工'}确认 · ${new Date(existing.at).toLocaleString()}`));
  }

  if (isCreator) {
    body.append(h('div', { style: 'display:flex;gap:10px;justify-content:flex-end' }, [
      existing
        ? h('button', {
            class: 'btn sm danger',
            onClick: async () => {
              await api('DELETE', `/api/projects/${p.id}/resolutions/${item.segmentId}`);
              toast('已撤销确认，段落回到冲突状态');
              await refresh('review');
            },
          }, '撤销确认')
        : null,
      h('button', {
        class: 'btn primary',
        onClick: async () => {
          try {
            if (chosen.type === 'custom') {
              if (!customTa.value.trim()) return toast('请填写改写文本', true);
              await api('POST', `/api/projects/${p.id}/resolutions/${item.segmentId}`, { text: customTa.value });
            } else {
              await api('POST', `/api/projects/${p.id}/resolutions/${item.segmentId}`, {
                variantIndex: Number(chosen.value),
              });
            }
            toast(existing ? '已更新确认' : '冲突段落已人工确认');
            await refresh('review');
          } catch (e) {
            toast(e.message, true);
          }
        },
      }, existing ? '更新确认' : '确认此版本落库'),
    ]));
  }

  card.append(body);
  return card;
}

function truncate(s, n) {
  s = String(s).replace(/\s+/g, ' ');
  return s.length > n ? s.slice(0, n) + '…' : s;
}
