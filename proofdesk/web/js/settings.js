import { api, uploadAudio } from './api.js';
import { avatar, fmtTime, h, modal, toast } from './dom.js';
import { evenSegments, formatTC, parseTC, round3 } from '/shared/timecode.js';
import { parseTranscript } from '/shared/transcript.js';

export function renderSettings(ctx) {
  const { workEl, project: p, isCreator, refresh } = ctx;
  const wrap = h('div', { style: 'max-width:960px' });
  workEl.append(wrap);
  if (!isCreator) {
    wrap.append(h('div', { class: 'panel' }, [
      h('h3', {}, '项目设置（只读）'),
      h('p', { class: 'muted' }, '仅项目创建者可修改音频、原稿与成员设置。'),
      membersPanel(ctx),
    ]));
    return;
  }
  const grid = h('div', { class: 'settings-grid' }, [
    h('div', {}, [audioPanel(ctx), infoPanel(ctx)]),
    h('div', {}, [importPanel(ctx), membersPanel(ctx)]),
  ]);
  wrap.append(grid);
}

// ---------- 音频 ----------
function audioPanel(ctx) {
  const { project: p, refresh } = ctx;
  const fileInput = h('input', { type: 'file', accept: 'audio/*', style: 'font-size:13px' });
  const state = h('div', { class: 'muted', style: 'font-size:13px;margin-top:8px' });

  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    state.textContent = `读取时长中…（${(f.size / 1024 / 1024).toFixed(1)} MB）`;
    const url = URL.createObjectURL(f);
    const probe = document.createElement('audio');
    probe.preload = 'metadata';
    probe.src = url;
    probe.onloadedmetadata = async () => {
      const duration = Number.isFinite(probe.duration) ? probe.duration : null;
      URL.revokeObjectURL(url);
      try {
        state.textContent = '上传中…';
        await uploadAudio(p.id, f, duration);
        toast('音频已上传');
        await refresh('settings');
      } catch (e) {
        state.textContent = '上传失败：' + e.message;
      }
    };
    probe.onerror = () => {
      URL.revokeObjectURL(url);
      state.textContent = '浏览器无法识别该音频时长，仍可尝试上传';
    };
  });

  return h('div', { class: 'panel' }, [
    h('h3', {}, '音频'),
    p.audio
      ? h('div', { style: 'font-size:13.5px;line-height:2' }, [
          h('div', {}, `类型：${p.audio.contentType}`),
          h('div', {}, `时长：${p.audio.duration != null ? formatTC(p.audio.duration) : '未知（浏览器可正常播放）'}`),
          h('div', {}, `大小：${(p.audio.bytes / 1024 / 1024).toFixed(2)} MB`),
          h('div', { class: 'muted' }, '上传于 ' + fmtTime(p.audio.uploadedAt)),
        ])
      : h('p', { class: 'muted', style: 'font-size:13.5px' }, '尚未上传音频。支持 mp3 / wav / ogg / m4a / flac / webm（≤200MB）。'),
    h('div', { style: 'margin-top:8px' }, [
      h('label', { class: 'btn sm', style: 'display:inline-block' }, [
        p.audio ? '更换音频' : '选择音频文件',
        fileInput,
      ]),
      h('span', { style: 'display:none' }),
      state,
    ]),
    h('p', { class: 'hint-line' }, '上传后可在「逐段校对」页边听边改；服务端支持 Range 拖动播放。'),
  ]);
}

// ---------- 信息 / 全员策略 ----------
function infoPanel(ctx) {
  const { project: p, refresh } = ctx;
  const nameIn = h('input', { class: 'input', value: p.name });
  const descIn = h('textarea', { class: 'input', rows: 2 }, p.description || '');
  const requireAll = h('input', { type: 'checkbox', checked: p.requireAllMembers });
  return h('div', { class: 'panel', style: 'margin-top:18px' }, [
    h('h3', {}, '项目信息'),
    h('label', { class: 'field' }, [h('span', {}, '名称'), nameIn]),
    h('label', { class: 'field' }, [h('span', {}, '说明'), descIn]),
    h('label', { style: 'display:flex;gap:8px;align-items:center;cursor:pointer' }, [
      requireAll,
      h('span', {}, [h('b', {}, '全员校对齐方可定稿'), h('div', { class: 'muted', style: 'font-size:12.5px' }, '关闭后允许部分成员未校对时定稿')]),
    ]),
    h('div', { style: 'margin-top:12px' }, [
      h('button', {
        class: 'btn primary sm',
        onClick: async () => {
          await api('PATCH', `/api/projects/${p.id}`, {
            name: nameIn.value, description: descIn.value, requireAllMembers: requireAll.checked,
          });
          toast('已保存');
          await refresh('settings');
        },
      }, '保存信息'),
    ]),
  ]);
}

// ---------- 原稿导入 ----------
function importPanel(ctx) {
  const { project: p, refresh } = ctx;
  const segLen = h('input', {
    type: 'number', min: '5', max: '600', value: '30', class: 'input', style: 'width:90px',
  });
  const fileInput = h('input', { type: 'file', accept: '.srt,.txt,.md,text/plain', style: 'font-size:13px' });
  const ta = h('textarea', {
    class: 'input', rows: 5,
    placeholder: '也可以直接粘贴：SRT、[00:00:03] 开头的带时间码文本、或空行分隔的自然段',
  });

  const doImport = (raw) => {
    const parsed = parseTranscript(raw);
    if (!parsed.segments.length) return toast('没有解析出任何段落', true);
    previewImport(parsed, ctx);
  };

  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    doImport(await f.text());
  });

  // 等距切分
  const evenBtn = h('button', {
    class: 'btn sm',
    onClick: () => {
      const dur = p.audio?.duration;
      if (!dur) return toast('缺少音频时长：请先上传音频（由浏览器读取时长）', true);
      const step = Number(segLen.value) || 30;
      const ranges = evenSegments(dur, step);
      const parsed = {
        format: 'even',
        segments: ranges.map((r, i) => ({
          start: round3(r.start),
          end: round3(r.end),
          text: `（第 ${i + 1} 段，${formatTC(r.start)} – ${formatTC(r.end)}，待填原稿）`,
        })),
      };
      previewImport(parsed, ctx);
    },
  }, '生成等距空段');

  return h('div', { class: 'panel' }, [
    h('h3', {}, '原稿导入与分段'),
    h('p', { class: 'muted', style: 'font-size:13px' },
      p.segments.length ? `当前 ${p.segments.length} 段。重新导入将整体替换。` : '尚无段落。'),
    h('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap' }, [
      h('span', { style: 'font-size:13.5px' }, '等距切分：每'),
      segLen,
      h('span', { style: 'font-size:13.5px' }, '秒一段'),
      evenBtn,
    ]),
    h('div', { class: 'muted', style: 'font-size:12.5px;margin-bottom:8px' }, '或导入原稿文件：'),
    h('div', { style: 'margin-bottom:10px' }, fileInput),
    ta,
    h('div', { style: 'margin-top:8px' }, [
      h('button', { class: 'btn primary sm', onClick: () => doImport(ta.value) }, '解析并预览'),
    ]),
  ]);
}

function previewImport(parsed, ctx) {
  const { project: p, refresh } = ctx;
  const rows = parsed.segments.slice(0, 500).map((s, i) => {
    const tr = h('tr', {}, [
      h('td', { class: 'mono' }, String(i + 1)),
      h('td', {}, h('input', { value: s.start != null ? formatTC(s.start) : '' })),
      h('td', {}, h('input', { value: s.end != null ? formatTC(s.end) : '' })),
      h('td', {}, h('input', { style: 'width:100%;min-width:260px', value: s.text })),
    ]);
    return tr;
  });

  const tableWrap = h('div', { style: 'overflow:auto;max-height:50vh' }, [
    h('table', { class: 'preview-table' }, [
      h('thead', {}, h('tr', {}, [
        h('th', {}, '#'), h('th', { style: 'width:130px' }, '起始'), h('th', { style: 'width:130px' }, '结束'), h('th', {}, '文本（可直接修改）'),
      ])),
      h('tbody', {}, rows),
    ]),
  ]);

  modal({
    title: `导入预览（识别为 ${formatName(parsed.format)}，共 ${parsed.segments.length} 段）`,
    wide: true,
    body: [
      parsed.format === 'paragraphs'
        ? h('p', { class: 'hint-line' }, '未检测到时间码：段落起止留空。提交后可用「等距切分」补齐，或逐段手工校准。')
        : null,
      p.segments.length
        ? h('p', { style: 'color:var(--amber);font-size:13px' },
            '⚠ 项目已有分段。整体替换后，旧修订会与新段落脱钩——若已有修订，系统将要求二次确认并清除旧修订。')
        : null,
      tableWrap,
    ],
    footer: (close) => [
      h('button', { class: 'btn', onClick: close }, '取消'),
      h('button', {
        class: 'btn primary',
        onClick: async () => {
          const trs = tableWrap.querySelectorAll('tbody tr');
          const segments = [...trs].map((tr) => {
            const ins = tr.querySelectorAll('input');
            const start = parseTC(ins[0].value.trim());
            const end = ins[1].value.trim() ? parseTC(ins[1].value.trim()) : null;
            return { start, end, text: ins[2].value };
          });
          const hasEdits = p.segments.some((s) => (s.myEdit || s.others.length));
          try {
            await api('PUT', `/api/projects/${p.id}/segments`, {
              segments,
              confirm: hasEdits ? confirm('已有校对修订，确认整体替换并清除旧修订？') : undefined,
            });
            toast(`已导入 ${segments.length} 段`);
            close();
            await refresh('proof');
            ctx.go('proof');
          } catch (e) {
            if (e.status === 409) toast('已有修订，请勾选确认后再提交', true);
            else toast(e.message, true);
          }
        },
      }, '确认导入'),
    ],
  });
}

function formatName(f) {
  return { srt: 'SRT 字幕', 'inline-tc': '行内时间码文本', paragraphs: '自然段文本', even: '等距切分' }[f] || f;
}

// ---------- 成员 ----------
function membersPanel(ctx) {
  const { project: p, isCreator, refresh } = ctx;
  const nameIn = h('input', { class: 'input', placeholder: '校对人姓名', style: 'flex:1' });
  return h('div', { class: 'panel', style: 'margin-top:18px' }, [
    h('h3', {}, `校对成员（${p.members.length}）`),
    ...p.members.map((m) =>
      h('div', { class: 'member-row' }, [
        avatar(m.name, m.userId, 'lg'),
        h('div', {}, [
          h('div', {}, [
            h('b', {}, m.name),
            m.userId === p.createdBy ? h('span', { class: 'badge solid', style: 'margin-left:6px' }, '创建者') : null,
          ]),
          h('div', { class: 'muted', style: 'font-size:12px' }, '加入于 ' + fmtTime(m.joinedAt)),
        ]),
        h('span', { class: 'spacer' }),
        isCreator && m.userId !== p.createdBy
          ? h('button', {
              class: 'btn danger sm',
              onClick: async () => {
                if (!confirm(`移除成员「${m.name}」？其已提交的修订仍会保留在历史中。`)) return;
                await api('DELETE', `/api/projects/${p.id}/members/${m.userId}`);
                toast('已移除');
                await refresh('settings');
              },
            }, '移除')
          : null,
      ]),
    ),
    isCreator
      ? h('div', { style: 'display:flex;gap:8px;margin-top:12px' }, [
          nameIn,
          h('button', {
            class: 'btn primary sm',
            onClick: async () => {
              const name = nameIn.value.trim();
              if (!name) return;
              try {
                await api('POST', `/api/projects/${p.id}/members`, { name });
                toast(`已加入：${name}`);
                await refresh('settings');
              } catch (e) { toast(e.message, true); }
            },
          }, '添加成员'),
        ])
      : null,
    isCreator
      ? h('p', { class: 'hint-line' }, '新成员首次进入时用相同姓名登录即可；令牌在种子数据/服务端日志中可查。')
      : null,
  ]);
}
