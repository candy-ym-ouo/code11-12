import { api } from './api.js';
import { avatar, debounce, esc, h, modal, statusBadge, toast } from './dom.js';
import { diffText } from '/shared/diff.js';
import { formatTC, parseTC, shortTC } from '/shared/timecode.js';
import { player } from './player.js';

// 逐段校对页
export function renderProof(ctx) {
  const { project: p, workEl, me, isCreator, refresh } = ctx;
  player.setSegments(p.segments);

  if (!p.audio) {
    workEl.append(emptyHint('还没有音频', '请到「项目设置」上传音频，或先用原稿文本校对。', () => ctx.go('settings')));
    return;
  }
  if (p.segments.length === 0) {
    workEl.append(emptyHint('还没有分段原稿', '请到「项目设置」导入 SRT / 带时间码文本，或按音频时长等距切分。', () => ctx.go('settings')));
    return;
  }

  const list = h('div', { class: 'seg-list' });
  const segEls = new Map();

  for (const seg of p.segments) {
    const card = renderSegment(seg, ctx);
    segEls.set(seg.id, card);
    list.append(card.el);
  }
  workEl.append(list);

  // 播放时高亮当前段
  player.onTime = (t) => {
    const cur = p.segments.find((s) => t >= (s.start ?? 0) && (s.end == null || t < s.end));
    list.querySelectorAll('.seg.active').forEach((n) => n.classList.remove('active'));
    if (cur) {
      const node = segEls.get(cur.id)?.el;
      if (node) {
        node.classList.add('active');
        if (followBox.checked) {
          const r = node.getBoundingClientRect();
          if (r.top < 90 || r.bottom > innerHeight - 60) {
            node.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }
      }
    }
  };

  const followBox = h('input', { type: 'checkbox', checked: true });
  const bar = h('div', {
    style: 'position:fixed;right:22px;bottom:18px;background:var(--panel);border:1px solid var(--line);border-radius:99px;padding:7px 14px;box-shadow:var(--shadow);font-size:13px;display:flex;gap:8px;align-items:center;z-index:10',
  }, [
    followBox,
    h('span', {}, '跟随播放'),
    h('span', { class: 'muted', style: 'margin:0 6px' }, '|'),
    h('span', { class: 'muted' }, [h('span', { class: 'kbd' }, '空格'), ' 播放/暂停　', h('span', { class: 'kbd' }, 'Tab'), ' 切换页签']),
  ]);
  workEl.append(bar);
}

function renderSegment(seg, ctx) {
  const { project: p, me, isCreator } = ctx;
  const locked = p.status === 'confirmed';
  const review = seg.review;

  const statusNode = statusBadge(review.status);

  // ---- 头部：序号、时间码、说话人、状态、成员点 ----
  const tcStart = h('span', {
    class: 'tc',
    title: '从此处开始播放',
    onClick: () => player.playRange(seg.start ?? 0, seg.end ?? (seg.start ?? 0) + 2),
  }, formatTC(seg.start ?? 0).slice(3));
  const tcEnd = h('span', {
    class: 'tc',
    onClick: () => player.seekTo(seg.end ?? seg.start ?? 0),
  }, seg.end != null ? formatTC(seg.end).slice(3) : '——');

  const memberDots = p.members.map((m) => {
    const done = review.users.includes(m.userId);
    return h('span', {
      title: `${m.name}${done ? ' 已提交' : ' 未校对'}`,
      style: `opacity:${done ? 1 : 0.35}`,
    }, avatar(m.name, m.userId, 'sm'));
  });

  const head = h('div', { class: 'seg-head' }, [
    h('span', { class: 'idx' }, `#${String(seg.order + 1).padStart(3, '0')}`),
    tcStart,
    h('span', { class: 'muted' }, '→'),
    tcEnd,
    seg.speaker ? h('span', { class: 'badge draft' }, seg.speaker) : null,
    statusNode,
    review.status === 'incomplete'
      ? h('span', { class: 'muted', style: 'font-size:12px' },
          '缺：' + review.missingUsers
            .map((uid) => p.members.find((m) => m.userId === uid)?.name || '?')
            .join('、'))
      : null,
    h('span', { class: 'spacer' }),
    h('span', { class: 'people' }, memberDots),
    h('button', {
      class: 'btn ghost sm',
      title: '播放本段并循环',
      onClick: () => player.playRange(seg.start ?? 0, seg.end ?? (seg.start ?? 0) + 2),
    }, '🔁 听'),
  ]);

  // ---- 正文 ----
  const body = h('div', { class: 'seg-body' + (locked ? ' single' : '') });

  // 原稿（含与我的修订的 diff）
  const draftPane = h('div', {}, [
    h('div', { class: 'pane-label' }, '原稿 / 听写底稿'),
    h('div', { class: 'draft-text' }, seg.draftText),
  ]);

  body.append(draftPane);

  // 我的修订
  if (!locked) {
    const ta = h('textarea', { class: 'edit-text' }, seg.myEdit?.text ?? seg.draftText);
    const state = h('span', { class: 'save-state' },
      seg.myEdit ? `已提交 ${shortClock(seg.myEdit.submittedAt)}` : '自动保存为草稿不会提交，点「提交修订」');
    let baseline = seg.draftText;

    const doSave = debounce(async (text) => {
      if (!text.trim() || text === baseline) return;
      state.textContent = '保存中…';
      state.classList.remove('saved');
      try {
        const r = await api('PUT', `/api/projects/${p.id}/segments/${seg.id}/edit`, { text });
        state.textContent = r.ok === 'unchanged' ? '内容未变化' : `已提交 ${shortClock(r.edit.submittedAt)}`;
        state.classList.add('saved');
        baseline = text;
        await ctx.refresh();
      } catch (e) {
        state.textContent = '保存失败：' + e.message;
      }
    }, 600);

    ta.addEventListener('input', () => {
      state.textContent = '编辑中…';
      state.classList.remove('saved');
      doSave(ta.value);
    });

    const submitBtn = h('button', {
      class: 'btn primary sm',
      onClick: async () => {
        if (!ta.value.trim()) return toast('文本不能为空', true);
        try {
          await api('PUT', `/api/projects/${p.id}/segments/${seg.id}/edit`, { text: ta.value });
          toast('修订已提交');
          await ctx.refresh();
        } catch (e) {
          toast(e.message, true);
        }
      },
    }, '立即提交');

    const resetBtn = h('button', {
      class: 'btn sm',
      title: '恢复为原稿',
      onClick: () => { ta.value = seg.draftText; },
    }, '恢复原稿');

    const editPane = h('div', {}, [
      h('div', { class: 'pane-label' }, [
        h('span', {}, '我的校对（边听边改，停顿自动提交）'),
        h('span', { class: 'spacer' }),
      ]),
      ta,
      h('div', { class: 'seg-foot', style: 'padding:6px 0 0' }, [
        state,
        h('span', { class: 'spacer' }),
        resetBtn,
        submitBtn,
      ]),
    ]);
    body.append(editPane);
  } else {
    const final = seg.resolution;
    body.append(h('div', {}, [
      h('div', { class: 'pane-label' }, '定稿文本'),
      h('div', { class: 'final-box' }, final?.text || seg.draftText),
      h('div', { class: 'muted', style: 'font-size:12.5px;margin-top:4px' },
        final ? `落库方式：${sourceLabel(final.source)}` : ''),
    ]));
  }

  // 他人版本
  if (seg.others.length > 0) {
    const othersBox = h('div', { class: 'others' },
      seg.others.map((o) =>
        h('div', { class: 'other-item' }, [
          h('span', { class: 'who' }, [
            avatar(o.userName || o.userId, o.userId, 'sm'),
            h('span', {}, o.userName || o.userId),
          ]),
          h('span', { class: 'txt' }, o.text),
        ]),
      ),
    );
    body.append(othersBox);
  }

  const el = h('div', { class: `seg ${review.status}${locked ? ' locked' : ''}`, dataset: { id: seg.id } }, [
    head,
    body,
  ]);

  // 创建者：段操作（改时间码/拆分/合并）放在底部小行
  if (isCreator && !locked) {
    body.append(h('div', { class: 'others' }, [
      h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, [
        h('span', { class: 'muted', style: 'font-size:12.5px' }, '创建者操作：'),
        h('button', { class: 'btn sm', onClick: () => editTimeModal(seg, ctx) }, '改时间码/说话人'),
        h('button', { class: 'btn sm', onClick: () => splitModal(seg, ctx) }, '拆分此段'),
        seg.order + 1 < p.segments.length
          ? h('button', {
              class: 'btn sm',
              onClick: async () => {
                if (!confirm('与下一段合并？两段原稿将拼接，已有修订保留。')) return;
                await api('POST', `/api/projects/${p.id}/segments/${seg.id}/merge-next`);
                toast('已合并');
                await ctx.refresh();
              },
            }, '合并下一段')
          : null,
        h('button', {
          class: 'btn ghost sm',
          onClick: async () => {
            const hist = await api('GET', `/api/projects/${p.id}/segments/${seg.id}/history`);
            historyModal(seg, hist);
          },
        }, '本段修订史'),
      ]),
    ]));
  }

  return { el };
}

function sourceLabel(s) {
  return ({
    auto: '一致自动落库',
    'manual-pick': '人工选定版本',
    'manual-custom': '人工改写',
  })[s] || s;
}

function shortClock(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function emptyHint(title, sub, onClick) {
  return h('div', { class: 'empty' }, [
    h('div', { class: 'big' }, '🎙'),
    h('div', { style: 'font-size:16px;margin-bottom:6px' }, title),
    h('div', {}, sub),
    h('div', { style: 'height:12px' }),
    h('button', { class: 'btn primary', onClick }, '去项目设置'),
  ]);
}

// ---------- 创建者操作弹窗 ----------
function editTimeModal(seg, ctx) {
  const sIn = h('input', { class: 'input mono', value: formatTC(seg.start ?? 0), placeholder: 'HH:MM:SS.mmm' });
  const eIn = h('input', { class: 'input mono', value: seg.end != null ? formatTC(seg.end) : '', placeholder: '可留空' });
  const spIn = h('input', { class: 'input', value: seg.speaker || '', placeholder: '如：祖父（可留空）' });
  modal({
    title: `修改 #${seg.order + 1} 时间码 / 说话人`,
    body: h('div', {}, [
      h('label', { class: 'field' }, [h('span', {}, '起始时间码'), sIn]),
      h('label', { class: 'field' }, [h('span', {}, '结束时间码'), eIn]),
      h('label', { class: 'field' }, [h('span', {}, '说话人'), spIn]),
    ]),
    footer: (close) => [
      h('button', { class: 'btn', onClick: close }, '取消'),
      h('button', {
        class: 'btn primary',
        onClick: async () => {
          const start = parseTC(sIn.value);
          const end = eIn.value.trim() ? parseTC(eIn.value) : null;
          if (start == null) return toast('起始时间码无法解析', true);
          if (eIn.value.trim() && end == null) return toast('结束时间码无法解析', true);
          try {
            await api('PATCH', `/api/projects/${ctx.project.id}/segments/${seg.id}`, {
              start, end, speaker: spIn.value,
            });
            toast('已保存');
            close();
            await ctx.refresh();
          } catch (e) { toast(e.message, true); }
        },
      }, '保存'),
    ],
  });
}

function splitModal(seg, ctx) {
  const atIn = h('input', {
    class: 'input mono',
    value: seg.start != null && seg.end != null ? formatTC((seg.start + seg.end) / 2) : '',
    placeholder: '切分点时间码',
  });
  const aIn = h('textarea', { class: 'input', rows: 3 }, seg.draftText);
  const bIn = h('textarea', { class: 'input', rows: 2 }, '');
  modal({
    title: `拆分 #${seg.order + 1}`,
    body: h('div', {}, [
      h('label', { class: 'field' }, [h('span', {}, '切分点（落在本段起止之间）'), atIn]),
      h('label', { class: 'field' }, [h('span', {}, '前半段文本'), aIn]),
      h('label', { class: 'field' }, [h('span', {}, '后半段文本'), bIn]),
    ]),
    footer: (close) => [
      h('button', { class: 'btn', onClick: close }, '取消'),
      h('button', {
        class: 'btn primary',
        onClick: async () => {
          const at = parseTC(atIn.value);
          if (at == null) return toast('切分点时间码无法解析', true);
          try {
            await api('POST', `/api/projects/${ctx.project.id}/segments/${seg.id}/split`, {
              at, textA: aIn.value, textB: bIn.value,
            });
            toast('已拆分');
            close();
            await ctx.refresh();
          } catch (e) { toast(e.message, true); }
        },
      }, '拆分'),
    ],
  });
}

function historyModal(seg, hist) {
  const users = new Map();
  const rows = hist.edits.map((e) =>
    h('div', { class: 'other-item', style: 'flex-direction:column;gap:4px' }, [
      h('div', { style: 'display:flex;gap:8px;align-items:center' }, [
        avatar(e.userName, e.userId, 'sm'),
        h('b', {}, e.userName),
        h('span', { class: 'muted', style: 'font-size:12px' }, new Date(e.submittedAt).toLocaleString()),
        e.mergedFrom ? h('span', { class: 'badge unreviewed' }, '由邻段合并而来') : null,
      ]),
      h('div', { style: 'white-space:pre-wrap' }, e.text),
    ]),
  );
  modal({
    title: `#${seg.order + 1} 修订史（${hist.edits.length} 版）`,
    wide: true,
    body: rows.length ? h('div', { style: 'display:flex;flex-direction:column;gap:8px' }, rows) : h('div', { class: 'muted' }, '尚无修订'),
  });
}
