// 版本合并引擎（前后端共享）
//
// 对每个段落收集各校对人的"已提交"修订，归纳为若干版本(variant)：
//   unreviewed  无人校对
//   incomplete  requireAllMembers 模式下尚有成员未提交
//   agreed      所有提交内容一致（含与原稿一致）=> 可自动合并
//   conflict    存在两个及以上不同版本 => 必须人工确认
//
// 落库规则：plan 中只要存在 conflict/incomplete 段落，整稿不得定稿；
// 冲突段落必须由人工显式选定（或另写）最终文本后，方可落库。

export function normalizeText(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').trim();
}

/**
 * @param {{id:string, draftText:string}} segment
 * @param {Array<{userId:string, text:string, submittedAt:(string|number)}>} edits 已提交修订
 * @param {string[]} memberIds 项目成员
 * @param {{requireAllMembers?:boolean, resolution?:object|null}} [opts]
 */
export function planSegment(segment, edits, memberIds, opts = {}) {
  const baseline = normalizeText(segment.draftText);
  const submitted = edits.filter((e) => e && e.text != null);
  const resolution = opts.resolution || null;

  if (submitted.length === 0) {
    return {
      segmentId: segment.id,
      status: 'unreviewed',
      baseline,
      variants: [],
      users: [],
      missingUsers: [...memberIds],
      suggested: resolution ? normalizeText(resolution.text) : baseline,
      resolved: Boolean(resolution),
      blocked: Boolean(opts.requireAllMembers) && !resolution,
    };
  }

  // 按归一化文本归并版本；保留首个原始文本
  const map = new Map();
  for (const e of submitted) {
    const key = normalizeText(e.text);
    if (!map.has(key)) {
      map.set(key, { text: String(e.text ?? '').replace(/\r\n/g, '\n'), users: [] });
    }
    map.get(key).users.push(e.userId);
  }
  const variants = [...map.values()].map((v) => ({
    text: v.text,
    users: [...new Set(v.users)],
    count: new Set(v.users).size,
  }));
  // 版本排序：人数多者优先，其次较早提交
  variants.sort((a, b) => b.count - a.count);

  const users = [...new Set(submitted.map((e) => e.userId))];
  const missingUsers = memberIds.filter((id) => !users.includes(id));

  let status;
  if (variants.length > 1) status = 'conflict';
  else if (opts.requireAllMembers && missingUsers.length > 0) status = 'incomplete';
  else status = 'agreed';

  // 已人工确认的冲突/未齐段落不再阻塞定稿；建议文本以确认为准
  const blocked = (status === 'conflict' || status === 'incomplete') && !resolution;

  return {
    segmentId: segment.id,
    status,
    baseline,
    variants,
    users,
    missingUsers,
    resolved: Boolean(resolution),
    // 唯一版本（或与原稿一致）时给出自动合并建议
    suggested: resolution
      ? String(resolution.text)
      : variants.length === 1
        ? variants[0].text
        : baseline,
    blocked,
  };
}

/**
 * 生成整稿合并计划
 * @param {{members:Array<{userId:string}>|string[], requireAllMembers?:boolean, resolutions?:Object}} project
 * @param {Array<{id:string,draftText:string}>} segments 已按序排列
 * @param {Object<string, Array>} editsBySegment
 */
export function planMerge(project, segments, editsBySegment) {
  const memberIds = (project.members || []).map((m) =>
    typeof m === 'string' ? m : m.userId,
  );
  const requireAllMembers = project.requireAllMembers !== false;
  const resolutions = project.resolutions || {};
  const items = segments.map((seg) =>
    planSegment(seg, editsBySegment[seg.id] || [], memberIds, {
      requireAllMembers,
      resolution: resolutions[seg.id] || null,
    }),
  );

  const counts = {
    total: items.length,
    unreviewed: items.filter((i) => i.status === 'unreviewed').length,
    incomplete: items.filter((i) => i.status === 'incomplete').length,
    agreed: items.filter((i) => i.status === 'agreed').length,
    conflict: items.filter((i) => i.status === 'conflict').length,
  };

  const conflicts = items.filter((i) => i.status === 'conflict');
  const blocking = items.filter((i) => i.blocked);
  return {
    items,
    counts,
    conflicts,
    blocking,
    canCommit: blocking.length === 0,
  };
}

/**
 * 校验一次人工冲突解决是否合法
 * @returns {{ok:true,text:string}|{ok:false,error:string}}
 */
export function validateResolution(item, text) {
  if (!item) return { ok: false, error: '段落不存在' };
  if (item.status !== 'conflict') {
    return { ok: false, error: '仅冲突段落需要人工确认' };
  }
  const t = String(text ?? '').replace(/\r\n/g, '\n');
  if (t.trim() === '') return { ok: false, error: '最终文本不能为空' };
  const known = new Set(item.variants.map((v) => normalizeText(v.text)));
  return {
    ok: true,
    text: t,
    custom: !known.has(normalizeText(t)),
  };
}
