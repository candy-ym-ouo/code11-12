// API 路由表：[METHOD, pattern, handler(ctx)]
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { newId } from './store.js';
import { MAX_AUDIO_BYTES } from './config.js';
import { HttpError, readJson, readRaw } from './http-util.js';
import {
  buildFinal,
  editsOfSegment,
  getUser,
  latestEditByUser,
  logEvent,
  normalizeText,
  nowISO,
  planMerge,
  projectDetail,
  projectSummary,
  requireCreator,
  requireMember,
  requireProject,
  requireUser,
  reopenProject,
  segmentsOf,
  validateResolution,
  validateTimeRange,
} from './domain.js';
import { formatTC, round3 } from '../shared/timecode.js';
import { MEDIA_DIR } from './config.js';

const MIME_AUDIO = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/ogg',
  'audio/webm',
  'audio/mp4',
  'audio/aac',
  'audio/m4a',
  'audio/x-m4a',
  'audio/flac',
]);
const AUDIO_EXT = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/flac': 'flac',
};

const touch = (project) => {
  project.updatedAt = nowISO();
};

export function buildRoutes(store) {
  const D = store.data;

  // ---------- 会话 ----------
  const routes = [
    ['POST', '/api/login', async (ctx) => {
      const body = await readJson(ctx.req, 16 * 1024);
      const name = String(body.name || '').trim();
      if (!name) throw new HttpError(400, '请输入校对人姓名');
      if (name.length > 40) throw new HttpError(400, '姓名过长');

      return store.mutate((db) => {
        // 同一浏览器沿用旧 token；姓名重复时加后缀
        let user = db.users.find((u) => u.token === ctx.token);
        if (user) {
          user.name = name;
          logEvent(db, 'user.rename', { userId: user.id, name });
        } else {
          let finalName = name;
          if (db.users.some((u) => u.name === name)) {
            finalName = `${name}-${db.users.length + 1}`;
          }
          user = {
            id: newId(),
            name: finalName,
            token: newId() + newId(),
            createdAt: nowISO(),
          };
          db.users.push(user);
          logEvent(db, 'user.login', { userId: user.id, name: finalName });
        }
        return { id: user.id, name: user.name, token: user.token };
      });
    }],

    ['GET', '/api/me', async (ctx) => {
      const user = requireUser(D, ctx.token);
      return { id: user.id, name: user.name };
    }],

    ['POST', '/api/logout', async (ctx) => {
      const user = getUser(D, ctx.token);
      if (user) {
        await store.mutate((db) => {
          const u = db.users.find((x) => x.id === user.id);
          if (u) u.token = newId() + newId(); // 作废旧令牌
        });
      }
      return { ok: true };
    }],

    // ---------- 项目 ----------
    ['GET', '/api/projects', async (ctx) => {
      const user = requireUser(D, ctx.token);
      return D.projects
        .filter((p) => p.members.some((m) => m.userId === user.id))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((p) => projectSummary(D, p));
    }],

    ['POST', '/api/projects', async (ctx) => {
      const user = requireUser(D, ctx.token);
      const body = await readJson(ctx.req, 64 * 1024);
      const name = String(body.name || '').trim();
      if (!name) throw new HttpError(400, '项目名称不能为空');

      const project = {
        id: newId(),
        name,
        description: String(body.description || '').slice(0, 2000),
        status: 'draft', // draft | confirmed
        requireAllMembers: body.requireAllMembers !== false,
        audio: null,
        createdBy: user.id,
        createdAt: nowISO(),
        updatedAt: nowISO(),
        members: [{ userId: user.id, role: 'creator', joinedAt: nowISO() }],
        resolutions: {},
        finalVersion: null,
      };
      if (Array.isArray(body.memberNames)) {
        for (const rawName of body.memberNames.slice(0, 20)) {
          const n = String(rawName || '').trim();
          if (!n) continue;
          let invited = store.data.users.find((u) => u.name === n);
          if (!invited) {
            invited = {
              id: newId(),
              name: n,
              token: newId() + newId(),
              createdAt: nowISO(),
            };
            store.data.users.push(invited);
          }
          if (!project.members.some((m) => m.userId === invited.id)) {
            project.members.push({ userId: invited.id, role: 'reviewer', joinedAt: nowISO() });
          }
        }
      }

      return store.mutate((db) => {
        db.projects.push(project);
        logEvent(db, 'project.create', { projectId: project.id, userId: user.id });
        return projectSummary(db, project);
      });
    }],

    ['GET', '/api/projects/:id', async (ctx) => {
      const user = requireUser(D, ctx.token);
      const project = requireProject(D, ctx.params.id);
      requireMember(project, user.id);
      return projectDetail(D, project, user.id);
    }],

    ['PATCH', '/api/projects/:id', async (ctx) => {
      const user = requireUser(D, ctx.token);
      const body = await readJson(ctx.req, 64 * 1024);
      return store.mutate((db) => {
        const project = requireProject(db, ctx.params.id);
        requireCreator(project, user.id);
        if (project.status === 'confirmed') throw new HttpError(409, '已定稿项目请先重开再修改');
        if (body.name !== undefined) {
          const name = String(body.name).trim();
          if (!name) throw new HttpError(400, '项目名称不能为空');
          project.name = name;
        }
        if (body.description !== undefined) project.description = String(body.description).slice(0, 2000);
        if (body.requireAllMembers !== undefined) {
          project.requireAllMembers = Boolean(body.requireAllMembers);
        }
        touch(project);
        logEvent(db, 'project.update', { projectId: project.id, userId: user.id });
        return projectSummary(db, project);
      });
    }],

    ['POST', '/api/projects/:id/reopen', async (ctx) => {
      const user = requireUser(D, ctx.token);
      return store.mutate((db) => {
        const project = requireProject(db, ctx.params.id);
        reopenProject(db, project, user.id);
        return projectDetail(db, project, user.id);
      });
    }],

    // ---------- 成员 ----------
    ['POST', '/api/projects/:id/members', async (ctx) => {
      const user = requireUser(D, ctx.token);
      const body = await readJson(ctx.req, 16 * 1024);
      const name = String(body.name || '').trim();
      if (!name) throw new HttpError(400, '请填写校对人姓名');
      return store.mutate((db) => {
        const project = requireProject(db, ctx.params.id);
        requireCreator(project, user.id);
        if (project.status === 'confirmed') throw new HttpError(409, '已定稿项目不可加人');
        let invited = db.users.find((u) => u.name === name);
        if (!invited) {
          invited = { id: newId(), name, token: newId() + newId(), createdAt: nowISO() };
          db.users.push(invited);
        }
        if (project.members.some((m) => m.userId === invited.id)) {
          throw new HttpError(409, '该成员已在项目中');
        }
        project.members.push({ userId: invited.id, role: 'reviewer', joinedAt: nowISO() });
        touch(project);
        logEvent(db, 'member.add', { projectId: project.id, userId: invited.id, by: user.id });
        return projectDetail(db, project, user.id);
      });
    }],

    ['DELETE', '/api/projects/:id/members/:userId', async (ctx) => {
      const user = requireUser(D, ctx.token);
      return store.mutate((db) => {
        const project = requireProject(db, ctx.params.id);
        requireCreator(project, user.id);
        if (ctx.params.userId === project.createdBy) throw new HttpError(400, '创建者不可移除');
        const before = project.members.length;
        project.members = project.members.filter((m) => m.userId !== ctx.params.userId);
        if (project.members.length === before) throw new HttpError(404, '成员不在项目中');
        touch(project);
        logEvent(db, 'member.remove', {
          projectId: project.id,
          userId: ctx.params.userId,
          by: user.id,
        });
        return projectDetail(db, project, user.id);
      });
    }],

    // ---------- 音频 ----------
    ['POST', '/api/projects/:id/audio', async (ctx) => {
      const user = requireUser(D, ctx.token);
      const project = requireProject(D, ctx.params.id);
      requireCreator(project, user.id);
      if (project.status === 'confirmed') throw new HttpError(409, '已定稿项目不可更换音频');

      const ctype = (ctx.req.headers['content-type'] || '').split(';')[0].trim();
      if (!MIME_AUDIO.has(ctype)) {
        throw new HttpError(415, '不支持的音频类型：' + ctype);
      }
      const buf = await readRaw(ctx.req, MAX_AUDIO_BYTES);
      await mkdir(MEDIA_DIR, { recursive: true });
      const fileId = newId();
      const ext = AUDIO_EXT[ctype] || 'audio';
      const filename = `${fileId}.${ext}`;
      await writeFile(join(MEDIA_DIR, filename), buf);

      const durationHeader = Number(ctx.req.headers['x-audio-duration'] || NaN);
      return store.mutate((db) => {
        const p = requireProject(db, project.id);
        p.audio = {
          fileId,
          filename,
          contentType: ctype,
          bytes: buf.length,
          duration: Number.isFinite(durationHeader) ? round3(durationHeader) : null,
          uploadedAt: nowISO(),
        };
        touch(p);
        logEvent(db, 'audio.upload', { projectId: p.id, fileId, bytes: buf.length });
        return { audio: p.audio };
      });
    }],

    // ---------- 分段 / 原稿 ----------
    ['PUT', '/api/projects/:id/segments', async (ctx) => {
      // 整体替换分段（导入原稿或重新等距切分时调用）
      const user = requireUser(D, ctx.token);
      const body = await readJson(ctx.req, 8 * 1024 * 1024);
      const list = body.segments;
      if (!Array.isArray(list) || list.length === 0) throw new HttpError(400, '段落为空');
      if (list.length > 5000) throw new HttpError(400, '段落数量超出上限（5000）');

      const parsed = list.map((s, i) => {
        const start = s.start === null || s.start === undefined ? null : Number(s.start);
        const end = s.end === null || s.end === undefined ? null : Number(s.end);
        const text = String(s.text ?? '');
        if (!text.trim()) throw new HttpError(400, `第 ${i + 1} 段文本为空`);
        if (start != null && end != null) {
          if (!(end > start)) throw new HttpError(400, `第 ${i + 1} 段时间码倒置`);
        }
        return {
          order: i,
          start: start == null ? null : round3(start),
          end: end == null ? null : round3(end),
          speaker: s.speaker ? String(s.speaker).slice(0, 40) : null,
          draftText: text.replace(/\r\n/g, '\n'),
        };
      });
      for (let i = 1; i < parsed.length; i++) {
        if (
          parsed[i].start != null &&
          parsed[i - 1].start != null &&
          parsed[i].start < parsed[i - 1].start
        ) {
          throw new HttpError(400, `第 ${i + 1} 段起始时间早于前一段`);
        }
      }

      return store.mutate((db) => {
        const project = requireProject(db, ctx.params.id);
        requireCreator(project, user.id);
        const oldSegs = segmentsOf(db, project.id);
        if (oldSegs.some((s) => db.edits.some((e) => e.segmentId === s.id))) {
          if (!body.confirm) {
            throw new HttpError(
              409,
              '已有校对修订，整体替换会使修订与段落脱钩。请显式确认。',
              { code: 'EDITS_EXIST' },
            );
          }
          const oldIds = new Set(oldSegs.map((s) => s.id));
          db.edits = db.edits.filter((e) => !oldIds.has(e.segmentId));
          project.resolutions = {};
        }
        db.segments = db.segments.filter((s) => s.projectId !== project.id);
        for (const s of parsed) {
          db.segments.push({
            id: newId(),
            projectId: project.id,
            ...s,
            createdAt: nowISO(),
          });
        }
        touch(project);
        logEvent(db, 'segments.replace', {
          projectId: project.id,
          count: parsed.length,
          userId: user.id,
        });
        return projectDetail(db, project, user.id);
      });
    }],

    ['PATCH', '/api/projects/:id/segments/:sid', async (ctx) => {
      // 单段改时间码 / 说话人 / 原稿（仅创建者）
      const user = requireUser(D, ctx.token);
      const body = await readJson(ctx.req, 64 * 1024);
      return store.mutate((db) => {
        const project = requireProject(db, ctx.params.id);
        requireCreator(project, user.id);
        if (project.status === 'confirmed') throw new HttpError(409, '已定稿项目段落锁定');
        const seg = db.segments.find(
          (s) => s.id === ctx.params.sid && s.projectId === project.id,
        );
        if (!seg) throw new HttpError(404, '段落不存在');

        if (body.start !== undefined || body.end !== undefined) {
          const start = body.start === undefined ? seg.start : body.start === null ? null : Number(body.start);
          const end = body.end === undefined ? seg.end : body.end === null ? null : Number(body.end);
          validateTimeRange(start, end, { allowOpenEnd: true });
          seg.start = start == null ? null : round3(start);
          seg.end = end == null ? null : round3(end);
        }
        if (body.speaker !== undefined) {
          seg.speaker = body.speaker ? String(body.speaker).slice(0, 40) : null;
        }
        if (body.draftText !== undefined) {
          const t = String(body.draftText);
          if (!t.trim()) throw new HttpError(400, '原稿文本不能为空');
          seg.draftText = t.replace(/\r\n/g, '\n');
        }
        touch(project);
        logEvent(db, 'segment.update', {
          projectId: project.id,
          segmentId: seg.id,
          userId: user.id,
        });
        return projectDetail(db, project, user.id);
      });
    }],

    ['POST', '/api/projects/:id/segments/:sid/split', async (ctx) => {
      const user = requireUser(D, ctx.token);
      const body = await readJson(ctx.req, 16 * 1024);
      return store.mutate((db) => {
        const project = requireProject(db, ctx.params.id);
        requireCreator(project, user.id);
        if (project.status === 'confirmed') throw new HttpError(409, '已定稿项目段落锁定');
        const segs = segmentsOf(db, project.id);
        const idx = segs.findIndex((s) => s.id === ctx.params.sid);
        if (idx < 0) throw new HttpError(404, '段落不存在');
        const seg = segs[idx];

        const at = body.at === undefined ? null : Number(body.at);
        const partA = String(body.textA ?? '');
        const partB = String(body.textB ?? '');
        if (!partA.trim() || !partB.trim()) throw new HttpError(400, '拆分后两段文本都不能为空');
        if (at != null) {
          if (!(at > seg.start && (seg.end == null || at < seg.end))) {
            throw new HttpError(400, '切分点必须落在本段时间范围内');
          }
        } else if (seg.start != null && seg.end != null) {
          throw new HttpError(400, '请指定切分时间点');
        }

        const next = segs[idx + 1] || null;
        db.segments = db.segments.filter((s) => s.id !== seg.id);
        const a = {
          id: newId(),
          projectId: project.id,
          order: 0,
          start: seg.start,
          end: at == null ? null : round3(at),
          speaker: seg.speaker,
          draftText: partA.replace(/\r\n/g, '\n'),
          createdAt: nowISO(),
        };
        const b = {
          id: newId(),
          projectId: project.id,
          order: 0,
          start: at == null ? seg.start : round3(at),
          end: seg.end,
          speaker: seg.speaker,
          draftText: partB.replace(/\r\n/g, '\n'),
          createdAt: nowISO(),
        };
        db.segments.push(a, b);
        // 重排
        const rebuilt = [];
        for (const s of segs) {
          if (s.id === seg.id) {
            rebuilt.push(a, b);
          } else {
            rebuilt.push(db.segments.find((x) => x.id === s.id) || s);
          }
        }
        rebuilt.forEach((s, i) => {
          s.order = i;
        });
        // 旧修订挂到 A 段（保留上下文，避免静默丢失）
        db.edits.forEach((e) => {
          if (e.segmentId === seg.id) e.segmentId = a.id;
        });
        touch(project);
        logEvent(db, 'segment.split', {
          projectId: project.id,
          segmentId: seg.id,
          at,
          userId: user.id,
        });
        return projectDetail(db, project, user.id);
      });
    }],

    ['POST', '/api/projects/:id/segments/:sid/merge-next', async (ctx) => {
      const user = requireUser(D, ctx.token);
      return store.mutate((db) => {
        const project = requireProject(db, ctx.params.id);
        requireCreator(project, user.id);
        if (project.status === 'confirmed') throw new HttpError(409, '已定稿项目段落锁定');
        const segs = segmentsOf(db, project.id);
        const idx = segs.findIndex((s) => s.id === ctx.params.sid);
        if (idx < 0 || idx + 1 >= segs.length) throw new HttpError(404, '没有可合并的下一段');
        const a = segs[idx];
        const b = segs[idx + 1];
        db.segments = db.segments.filter((s) => s.id !== b.id);
        a.draftText = `${a.draftText}\n${b.draftText}`;
        a.end = b.end;
        // b 的修订并入 a：保留但标注来源段
        db.edits.forEach((e) => {
          if (e.segmentId === b.id) {
            e.segmentId = a.id;
            e.mergedFrom = b.id;
          }
        });
        segmentsOf(db, project.id).forEach((s, i) => (s.order = i));
        touch(project);
        logEvent(db, 'segment.merge', {
          projectId: project.id,
          from: b.id,
          into: a.id,
          userId: user.id,
        });
        return projectDetail(db, project, user.id);
      });
    }],

    // ---------- 校对修订（每段保存最新一版，历史全留） ----------
    ['PUT', '/api/projects/:id/segments/:sid/edit', async (ctx) => {
      const user = requireUser(D, ctx.token);
      const body = await readJson(ctx.req, 1024 * 1024);
      return store.mutate((db) => {
        const project = requireProject(db, ctx.params.id);
        requireMember(project, user.id);
        if (project.status === 'confirmed') throw new HttpError(409, '项目已定稿，段落已锁定');
        const seg = db.segments.find(
          (s) => s.id === ctx.params.sid && s.projectId === project.id,
        );
        if (!seg) throw new HttpError(404, '段落不存在');

        const text = String(body.text ?? '').replace(/\r\n/g, '\n');
        if (!text.trim()) throw new HttpError(400, '校对文本不能为空');
        const prev = latestEditByUser(db, seg.id, user.id);
        if (prev && normalizeText(prev.text) === normalizeText(text)) {
          return { ok: 'unchanged', edit: { text: prev.text, submittedAt: prev.submittedAt } };
        }
        const edit = {
          id: newId(),
          segmentId: seg.id,
          projectId: project.id,
          userId: user.id,
          text,
          submittedAt: nowISO(),
          supersedes: prev ? prev.id : null,
        };
        db.edits.push(edit);
        touch(project);
        logEvent(db, 'edit.submit', {
          projectId: project.id,
          segmentId: seg.id,
          editId: edit.id,
          userId: user.id,
        });
        return { ok: 'saved', edit: { text: edit.text, submittedAt: edit.submittedAt } };
      });
    }],

    ['GET', '/api/projects/:id/segments/:sid/history', async (ctx) => {
      const user = requireUser(D, ctx.token);
      const project = requireProject(D, ctx.params.id);
      requireMember(project, user.id);
      const seg = D.segments.find((s) => s.id === ctx.params.sid && s.projectId === project.id);
      if (!seg) throw new HttpError(404, '段落不存在');
      const users = new Map(D.users.map((u) => [u.id, u]));
      return {
        segment: {
          id: seg.id,
          order: seg.order,
          start: seg.start,
          end: seg.end,
          draftText: seg.draftText,
        },
        edits: editsOfSegment(D, seg.id).map((e) => ({
          id: e.id,
          userId: e.userId,
          userName: users.get(e.userId)?.name || '（已注销）',
          text: e.text,
          submittedAt: e.submittedAt,
          supersedes: e.supersedes || null,
          mergedFrom: e.mergedFrom || null,
        })),
        resolution: project.resolutions?.[seg.id] || null,
      };
    }],

    // ---------- 合并 / 冲突 ----------
    ['GET', '/api/projects/:id/merge-plan', async (ctx) => {
      const user = requireUser(D, ctx.token);
      const project = requireProject(D, ctx.params.id);
      requireMember(project, user.id);
      return mergePlanView(D, project);
    }],

    ['POST', '/api/projects/:id/auto-merge', async (ctx) => {
      // 把所有 agreed 段落自动落库（仍需在定稿前统一确认；冲突/incomplete 不动）
      const user = requireUser(D, ctx.token);
      return store.mutate((db) => {
        const project = requireProject(db, ctx.params.id);
        requireCreator(project, user.id);
        if (project.status === 'confirmed') throw new HttpError(409, '项目已定稿');
        const plan = mergePlanView(db, project);
        let applied = 0;
        project.resolutions = project.resolutions || {};
        for (const item of plan.items) {
          if (item.status === 'agreed' && !project.resolutions[item.segmentId]) {
            project.resolutions[item.segmentId] = {
              text: item.suggested,
              source: 'auto',
              by: user.id,
              at: nowISO(),
            };
            applied++;
          }
        }
        touch(project);
        logEvent(db, 'merge.auto', { projectId: project.id, applied, userId: user.id });
        return { applied, detail: projectDetail(db, project, user.id) };
      });
    }],

    ['POST', '/api/projects/:id/resolutions/:sid', async (ctx) => {
      // 人工确认冲突段落：选定某版本或另写
      const user = requireUser(D, ctx.token);
      const body = await readJson(ctx.req, 1024 * 1024);
      return store.mutate((db) => {
        const project = requireProject(db, ctx.params.id);
        requireCreator(project, user.id);
        if (project.status === 'confirmed') throw new HttpError(409, '项目已定稿');
        const plan = mergePlanView(db, project);
        const item = plan.items.find((i) => i.segmentId === ctx.params.sid);
        if (!item) throw new HttpError(404, '段落不存在');
        if (item.status !== 'conflict') {
          throw new HttpError(409, '仅冲突段落需要人工确认；一致段落可直接自动合并');
        }
        let text;
        if (body.variantIndex != null) {
          const v = item.variants[Number(body.variantIndex)];
          if (!v) throw new HttpError(400, '版本序号无效');
          text = v.text;
        } else {
          text = String(body.text ?? '');
        }
        const check = validateResolution(item, text);
        if (!check.ok) throw new HttpError(400, check.error);

        project.resolutions = project.resolutions || {};
        project.resolutions[item.segmentId] = {
          text: check.text,
          source: check.custom ? 'manual-custom' : 'manual-pick',
          by: user.id,
          at: nowISO(),
        };
        touch(project);
        logEvent(db, 'resolution.set', {
          projectId: project.id,
          segmentId: item.segmentId,
          source: check.custom ? 'manual-custom' : 'manual-pick',
          userId: user.id,
        });
        return { detail: projectDetail(db, project, user.id) };
      });
    }],

    ['DELETE', '/api/projects/:id/resolutions/:sid', async (ctx) => {
      // 撤销人工确认（发现选错时）
      const user = requireUser(D, ctx.token);
      return store.mutate((db) => {
        const project = requireProject(db, ctx.params.id);
        requireCreator(project, user.id);
        if (!project.resolutions?.[ctx.params.sid]) throw new HttpError(404, '该段落没有确认记录');
        delete project.resolutions[ctx.params.sid];
        touch(project);
        logEvent(db, 'resolution.clear', {
          projectId: project.id,
          segmentId: ctx.params.sid,
          userId: user.id,
        });
        return { ok: true };
      });
    }],

    ['POST', '/api/projects/:id/commit', async (ctx) => {
      // 定稿：所有段落必须已有 resolution，或处于 agreed/incomplete-unblocked?
      // 规则：canCommit 要求全部段落非 conflict 且（requireAllMembers 时）全员已提交。
      //      定稿前自动把 agreed 段落补齐 resolution；仍有阻塞则 409。
      const user = requireUser(D, ctx.token);
      return store.mutate((db) => {
        const project = requireProject(db, ctx.params.id);
        requireCreator(project, user.id);
        if (project.status === 'confirmed') throw new HttpError(409, '项目已定稿');
        const plan = mergePlanView(db, project);
        if (!plan.canCommit) {
          const reasons = [];
          if (plan.counts.conflict > 0) reasons.push(`有 ${plan.counts.conflict} 个冲突段落待人工确认`);
          if (plan.counts.incomplete > 0) reasons.push(`有 ${plan.counts.incomplete} 个段落尚有成员未校对`);
          throw new HttpError(409, '暂不能定稿：' + reasons.join('；'), {
            blockingSegmentIds: plan.blocking.map((i) => i.segmentId),
          });
        }
        project.resolutions = project.resolutions || {};
        for (const item of plan.items) {
          if (!project.resolutions[item.segmentId]) {
            project.resolutions[item.segmentId] = {
              text: item.suggested,
              source: 'auto',
              by: user.id,
              at: nowISO(),
            };
          }
        }
        project.status = 'confirmed';
        project.finalVersion = { version: 1, committedAt: nowISO(), by: user.id };
        touch(project);
        logEvent(db, 'project.commit', { projectId: project.id, userId: user.id });
        return projectDetail(db, project, user.id);
      });
    }],

    // ---------- 导出 ----------
    ['GET', '/api/projects/:id/export.txt', async (ctx) => {
      const user = requireUser(D, ctx.token);
      const project = requireProject(D, ctx.params.id);
      requireMember(project, user.id);
      const final = buildFinal(D, project);
      return {
        contentType: 'text/plain',
        filename: `${safeName(project.name)}-定稿.txt`,
        body: final.map((f) => f.text).join('\n\n') + '\n',
      };
    }],

    ['GET', '/api/projects/:id/export.srt', async (ctx) => {
      const user = requireUser(D, ctx.token);
      const project = requireProject(D, ctx.params.id);
      requireMember(project, user.id);
      const final = buildFinal(D, project);
      const srt = final
        .map((f, i) => {
          const start = f.start ?? 0;
          const end = f.end ?? final[i + 1]?.start ?? start + 2;
          return `${i + 1}\n${formatTC(start, ',')} --> ${formatTC(end, ',')}\n${f.text}`;
        })
        .join('\n\n');
      return {
        contentType: 'text/plain',
        filename: `${safeName(project.name)}-定稿.srt`,
        body: srt + '\n',
      };
    }],

    // ---------- 事件流 ----------
    ['GET', '/api/projects/:id/history', async (ctx) => {
      const user = requireUser(D, ctx.token);
      const project = requireProject(D, ctx.params.id);
      requireMember(project, user.id);
      const users = new Map(D.users.map((u) => [u.id, u]));
      return {
        events: D.events
          .filter((e) => e.projectId === project.id)
          .sort((a, b) => b.at.localeCompare(a.at))
          .map((e) => ({ ...e, userName: users.get(e.userId || e.by)?.name || null })),
      };
    }],
  ];

  return routes;
}

function mergePlanView(db, project) {
  const segs = segmentsOf(db, project.id);
  const editsBySegment = {};
  for (const s of segs) {
    const byUser = new Map();
    for (const e of editsOfSegment(db, s.id)) byUser.set(e.userId, e);
    editsBySegment[s.id] = [...byUser.values()];
  }
  const plan = planMerge(project, segs, editsBySegment);
  const users = new Map(db.users.map((u) => [u.id, u]));
  return {
    ...plan,
    items: plan.items.map((item) => {
      const seg = segs.find((s) => s.id === item.segmentId);
      return {
        ...item,
        order: seg?.order,
        start: seg?.start,
        end: seg?.end,
        resolution: project.resolutions?.[item.segmentId] || null,
        variants: item.variants.map((v) => ({
          ...v,
          userNames: v.users.map((id) => users.get(id)?.name || '（已注销）'),
        })),
        missingUserNames: item.missingUsers.map((id) => users.get(id)?.name || '（已注销）'),
      };
    }),
  };
}

function safeName(name) {
  return String(name).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'transcript';
}
