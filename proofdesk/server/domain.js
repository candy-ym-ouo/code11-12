// 领域辅助：在 store 数据上做查询与权限校验
import { newId } from './store.js';
import { HttpError } from './http-util.js';
import { normalizeText, planMerge, validateResolution } from '../shared/merge.js';
import { round3 } from '../shared/timecode.js';

export const nowISO = () => new Date().toISOString();

export function getUser(db, token) {
  if (!token) return null;
  return db.users.find((u) => u.token === token) || null;
}

export function requireUser(db, token) {
  const user = getUser(db, token);
  if (!user) throw new HttpError(401, '未登录或登录已失效');
  return user;
}

export function getProject(db, id) {
  return db.projects.find((p) => p.id === id) || null;
}

export function requireProject(db, id) {
  const p = getProject(db, id);
  if (!p) throw new HttpError(404, '项目不存在');
  return p;
}

export function requireMember(project, userId) {
  if (!project.members.some((m) => m.userId === userId)) {
    throw new HttpError(403, '你不是该项目的校对成员');
  }
}

export const requireCreator = (project, userId) => {
  if (project.createdBy !== userId) throw new HttpError(403, '仅项目创建者可执行该操作');
};

export function segmentsOf(db, projectId) {
  return db.segments
    .filter((s) => s.projectId === projectId)
    .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
}

export function editsOfSegment(db, segmentId) {
  return db.edits
    .filter((e) => e.segmentId === segmentId)
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
}

export function latestEditByUser(db, segmentId, userId) {
  const mine = db.edits
    .filter((e) => e.segmentId === segmentId && e.userId === userId)
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  return mine[0] || null;
}

/** 事件流水（审计：谁在何时做了什么） */
export function logEvent(db, type, payload) {
  db.events.push({ id: newId(), at: nowISO(), type, ...payload });
}

export function userMap(db) {
  return new Map(db.users.map((u) => [u.id, u]));
}

/** 项目视图（列表用，不含段落） */
export function projectSummary(db, project) {
  const segs = segmentsOf(db, project.id);
  const edits = db.edits.filter((e) =>
    segs.some((s) => s.id === e.segmentId),
  );
  const submittedSegmentIds = new Set(edits.map((e) => e.segmentId));
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    status: project.status,
    requireAllMembers: project.requireAllMembers,
    audio: project.audio,
    createdBy: project.createdBy,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    members: project.members,
    membersCount: project.members.length,
    segmentCount: segs.length,
    touchedCount: submittedSegmentIds.size,
    finalVersion: project.finalVersion || null,
  };
}

/** 项目详情：段落 + 每人最新修订状态 + 合并计划 */
export function projectDetail(db, project, viewerId) {
  const segs = segmentsOf(db, project.id);
  const users = userMap(db);
  const editsBySegment = {};
  for (const s of segs) {
    // 合并计划只采用每人最新一条修订
    const byUser = new Map();
    for (const e of editsOfSegment(db, s.id)) byUser.set(e.userId, e);
    editsBySegment[s.id] = [...byUser.values()];
  }
  const plan = planMerge(project, segs, editsBySegment);
  const memberIds = project.members.map((m) => m.userId);
  const segments = segs.map((s, idx) => {
    const item = plan.items[idx];
    const myEdit = viewerId ? latestEditByUser(db, s.id, viewerId) : null;
    const latestByOthers = memberIds
      .filter((uid) => uid !== viewerId)
      .map((uid) => {
        const e = [...(editsBySegment[s.id] || [])].find((x) => x.userId === uid);
        return e ? { userId: uid, text: e.text, submittedAt: e.submittedAt } : null;
      })
      .filter(Boolean);
    return {
      id: s.id,
      order: s.order,
      start: s.start,
      end: s.end,
      speaker: s.speaker || null,
      draftText: s.draftText,
      review: {
        status: item.status,
        variants: item.variants,
        users: item.users,
        missingUsers: item.missingUsers,
        suggested: item.suggested,
      },
      resolution: project.resolutions?.[s.id] || null,
      myEdit: myEdit ? { text: myEdit.text, submittedAt: myEdit.submittedAt } : null,
      others: latestByOthers,
    };
  });

  return {
    ...projectSummary(db, project),
    members: project.members.map((m) => ({
      userId: m.userId,
      name: users.get(m.userId)?.name || '（已注销）',
      role: m.role,
      joinedAt: m.joinedAt,
    })),
    review: {
      counts: plan.counts,
      canCommit: plan.canCommit,
      blockingSegmentIds: plan.blocking.map((i) => i.segmentId),
    },
    segments,
  };
}

/** 导出/定稿用：生成最终文本（已确认项目取 resolutions，否则给自动合并草稿） */
export function buildFinal(db, project, { requireCommitted = true } = {}) {
  if (requireCommitted && project.status !== 'confirmed') {
    throw new HttpError(409, '项目尚未定稿');
  }
  const segs = segmentsOf(db, project.id);
  const editsBySegment = {};
  for (const s of segs) {
    const byUser = new Map();
    for (const e of editsOfSegment(db, s.id)) byUser.set(e.userId, e);
    editsBySegment[s.id] = [...byUser.values()];
  }
  const plan = planMerge(project, segs, editsBySegment);
  return segs.map((s, i) => ({
    segmentId: s.id,
    order: s.order,
    start: s.start,
    end: s.end,
    speaker: s.speaker || null,
    text: project.resolutions?.[s.id]?.text ?? plan.items[i].suggested,
    source: project.resolutions?.[s.id]
      ? project.resolutions[s.id].source
      : plan.items[i].status === 'agreed'
        ? 'auto'
        : 'draft',
  }));
}

/** 重新打开已定稿项目（仅创建者；保留全部修订/历史，解除定稿） */
export function reopenProject(db, project, userId) {
  requireCreator(project, userId);
  if (project.status !== 'confirmed') throw new HttpError(409, '项目尚未定稿，无需重开');
  project.status = 'draft';
  project.resolutions = {};
  project.finalVersion = null;
  project.updatedAt = nowISO();
  logEvent(db, 'project.reopen', { projectId: project.id, userId });
}

/** 段级校验 */
export function validateTimeRange(start, end, { allowOpenEnd = false } = {}) {
  if (start == null || !Number.isFinite(start) || start < 0) {
    throw new HttpError(400, '起始时间码无效');
  }
  if (end != null) {
    if (!Number.isFinite(end) || end < 0) throw new HttpError(400, '结束时间码无效');
    if (round3(end) <= round3(start)) throw new HttpError(400, '结束时间必须晚于起始时间');
  } else if (!allowOpenEnd) {
    throw new HttpError(400, '结束时间码无效');
  }
}

export { normalizeText, planMerge, validateResolution };
