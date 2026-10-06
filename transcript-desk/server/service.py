"""业务规则层：所有写操作在事务内完成并写审计日志。"""
from __future__ import annotations

import time
from typing import Any

from .db import get_conn
from .util import fmt_tc, uid


def now_ms() -> int:
    return int(time.time() * 1000)


class HttpError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def bad(msg: str, code: str = "bad_request") -> HttpError:
    return HttpError(400, code, msg)


def notfound(msg: str = "资源不存在") -> HttpError:
    return HttpError(404, "not_found", msg)


def forbidden(msg: str = "无权操作") -> HttpError:
    return HttpError(403, "forbidden", msg)


def conflict(msg: str, code: str = "conflict") -> HttpError:
    return HttpError(409, code, msg)


# ---------- 审计 ----------

def _audit(conn, project_id: str | None, user_id: str | None, action: str, detail: str = "") -> None:
    conn.execute(
        "INSERT INTO audit_logs(project_id, user_id, action, detail, created_at) VALUES(?,?,?,?,?)",
        (project_id, user_id, action, detail[:2000], now_ms()),
    )


# ---------- 用户 ----------

def create_user(name: str) -> dict:
    name = (name or "").strip()
    if not name:
        raise bad("校对员姓名不能为空")
    if len(name) > 40:
        raise bad("姓名最长 40 字")
    conn = get_conn()
    try:
        row = conn.execute("SELECT id FROM users WHERE name=?", (name,)).fetchone()
        if row:
            raise conflict("该姓名已被占用，请换一个或直接登录")
        u = {"id": uid(), "name": name, "token": uid() + uid(), "created_at": now_ms()}
        conn.execute("INSERT INTO users(id,name,token,created_at) VALUES(?,?,?,?)",
                     (u["id"], u["name"], u["token"], u["created_at"]))
        _audit(conn, None, u["id"], "user.register", f"校对员 {name} 登记")
        conn.commit()
        return u
    finally:
        conn.close()


def login_user(name: str) -> dict:
    name = (name or "").strip()
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM users WHERE name=?", (name,)).fetchone()
        if not row:
            raise notfound("没有这位校对员，请先登记")
        return dict(row)
    finally:
        conn.close()


def user_by_token(token: str) -> dict | None:
    if not token:
        return None
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM users WHERE token=?", (token,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def list_users() -> list[dict]:
    conn = get_conn()
    try:
        return [dict(r) for r in conn.execute("SELECT id,name,created_at FROM users ORDER BY created_at")]
    finally:
        conn.close()


# ---------- 项目 ----------

def create_project(name: str, description: str, user: dict) -> dict:
    name = (name or "").strip()
    if not name:
        raise bad("项目名称不能为空")
    conn = get_conn()
    try:
        p = {"id": uid(), "name": name, "description": (description or "").strip()[:2000],
             "created_by": user["id"], "created_at": now_ms()}
        conn.execute(
            "INSERT INTO projects(id,name,description,status,created_by,created_at) VALUES(?,?,?,?,?,?)",
            (p["id"], p["name"], p["description"], "open", p["created_by"], p["created_at"]))
        _audit(conn, p["id"], user["id"], "project.create", f"创建项目「{p['name']}」")
        conn.commit()
        return get_project(p["id"])
    finally:
        conn.close()


def get_project(project_id: str) -> dict:
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
        if not row:
            raise notfound()
        p = dict(row)
        p["segment_count"] = conn.execute(
            "SELECT COUNT(*) FROM segments WHERE project_id=?", (project_id,)).fetchone()[0]
        p["proofed_count"] = conn.execute(
            "SELECT COUNT(DISTINCT segment_id) FROM versions WHERE project_id=?", (project_id,)).fetchone()[0]
        p["proofreader_count"] = conn.execute(
            "SELECT COUNT(DISTINCT user_id) FROM versions WHERE project_id=?", (project_id,)).fetchone()[0]
        p["finalized_count"] = conn.execute(
            "SELECT COUNT(*) FROM merges WHERE project_id=? AND chosen!='none'", (project_id,)).fetchone()[0]
        return p
    finally:
        conn.close()


def list_projects() -> list[dict]:
    conn = get_conn()
    try:
        rows = conn.execute("SELECT id FROM projects ORDER BY created_at DESC").fetchall()
        ids = [r["id"] for r in rows]
    finally:
        conn.close()
    return [get_project(i) for i in ids]


def set_audio_meta(project_id: str, duration: float | None, user: dict) -> None:
    p = get_project(project_id)
    if p["status"] != "open":
        raise bad("已定稿的项目不能再修改音频")
    conn = get_conn()
    try:
        conn.execute("UPDATE projects SET audio_dur=? WHERE id=?",
                     (float(duration) if duration is not None else None, project_id))
        _audit(conn, project_id, user["id"], "project.audio_meta", f"音频时长 {duration}s")
        conn.commit()
    finally:
        conn.close()


def reopen_project(project_id: str, user: dict) -> dict:
    get_project_or_404(project_id)
    conn = get_conn()
    try:
        conn.execute("UPDATE projects SET status='open', finalized_at=NULL WHERE id=?", (project_id,))
        _audit(conn, project_id, user["id"], "project.reopen", "重新打开项目进入校对")
        conn.commit()
    finally:
        conn.close()
    return get_project(project_id)


def get_project_or_404(project_id: str) -> dict:
    return get_project(project_id)


# ---------- 分段 ----------

def _ensure_open(conn, project_id: str) -> None:
    row = conn.execute("SELECT status FROM projects WHERE id=?", (project_id,)).fetchone()
    if not row:
        raise notfound()
    if row["status"] != "open":
        raise bad("项目已定稿，校对与结构调整已锁定；如需修改请先「重新打开」", "project_finalized")


def replace_segments(project_id: str, segs: list[dict], source: str, user: dict) -> dict:
    """导入草稿：整体替换分段。已有任何校对版本后拒绝，保证历史可追溯。"""
    if not segs:
        raise bad("没有解析出任何分段，请检查草稿格式")
    for s in segs:
        if s["end_ms"] <= s["start_ms"]:
            raise bad(f"分段 {fmt_tc(s['start_ms'])} 的结束时间必须晚于开始时间")
    for a, b in zip(segs, segs[1:]):
        if b["start_ms"] < a["end_ms"]:
            raise bad(
                f"分段时间重叠：{fmt_tc(a['start_ms'])} 的结束晚于下一段开始 {fmt_tc(b['start_ms'])}，"
                "请保证时间码单调不重叠")
    conn = get_conn()
    try:
        _ensure_open(conn, project_id)
        n_ver = conn.execute("SELECT COUNT(*) FROM versions WHERE project_id=?", (project_id,)).fetchone()[0]
        if n_ver > 0:
            raise conflict("已有校对提交，不能整体替换分段（会破坏版本对应关系）；请用逐条调整")
        conn.execute("DELETE FROM segments WHERE project_id=?", (project_id,))
        for i, s in enumerate(segs):
            conn.execute(
                "INSERT INTO segments(id,project_id,idx,start_ms,end_ms,original,created_at)"
                " VALUES(?,?,?,?,?,?,?)",
                (uid(), project_id, i, int(s["start_ms"]), int(s["end_ms"]), s["original"], now_ms()))
        _audit(conn, project_id, user["id"], "segment.import", f"{source} 导入 {len(segs)} 段")
        conn.commit()
    finally:
        conn.close()
    return get_segments(project_id)


def adjust_segment(project_id: str, segment_id: str, start_ms: int, end_ms: int, user: dict) -> dict:
    conn = get_conn()
    try:
        _ensure_open(conn, project_id)
        seg = conn.execute("SELECT * FROM segments WHERE id=? AND project_id=?",
                           (segment_id, project_id)).fetchone()
        if not seg:
            raise notfound("分段不存在")
        if end_ms <= start_ms:
            raise bad("结束时间必须晚于开始时间")
        # 与相邻分段不能重叠（允许首尾相接）
        nbr = conn.execute(
            "SELECT start_ms, end_ms FROM segments WHERE project_id=? AND id!=? AND "
            "(? < end_ms AND ? > start_ms)",
            (project_id, segment_id, end_ms, start_ms)).fetchone()
        if nbr:
            raise bad(f"与相邻分段 {fmt_tc(nbr['start_ms'])}–{fmt_tc(nbr['end_ms'])} 重叠")
        conn.execute("UPDATE segments SET start_ms=?, end_ms=? WHERE id=?",
                     (int(start_ms), int(end_ms), segment_id))
        _audit(conn, project_id, user["id"], "segment.adjust",
               f"段#{seg['idx'] + 1} 时间码 {fmt_tc(seg['start_ms'])}→{fmt_tc(start_ms)}")
        conn.commit()
        return {"id": segment_id, "start_ms": int(start_ms), "end_ms": int(end_ms)}
    finally:
        conn.close()


def split_segment(project_id: str, segment_id: str, at_ms: int, user: dict) -> list[dict]:
    conn = get_conn()
    try:
        _ensure_open(conn, project_id)
        seg = conn.execute("SELECT * FROM segments WHERE id=? AND project_id=?",
                           (segment_id, project_id)).fetchone()
        if not seg:
            raise notfound("分段不存在")
        if not (seg["start_ms"] + 200 < at_ms < seg["end_ms"] - 200):
            raise bad("切点必须在分段内部，且距端点至少 0.2 秒")
        n_ver = conn.execute("SELECT COUNT(*) FROM versions WHERE segment_id=?", (segment_id,)).fetchone()[0]
        if n_ver:
            raise conflict("该段已有校对版本，拆分将使版本失配，不能拆分")
        conn.execute("UPDATE segments SET end_ms=? WHERE id=?", (int(at_ms), segment_id))
        new_id = uid()
        conn.execute(
            "INSERT INTO segments(id,project_id,idx,start_ms,end_ms,original,created_at)"
            " VALUES(?,?,?,?,?,?,?)",
            (new_id, project_id, seg["idx"] + 1, int(at_ms), seg["end_ms"], seg["original"], now_ms()))
        conn.execute("UPDATE segments SET idx=idx+1 WHERE project_id=? AND idx>?",
                     (project_id, seg["idx"]))
        _audit(conn, project_id, user["id"], "segment.split",
               f"段#{seg['idx'] + 1} 在 {fmt_tc(at_ms)} 处拆分")
        conn.commit()
    finally:
        conn.close()
    return get_segments(project_id)


def _segments_with_versions(conn, project_id: str) -> list[dict]:
    segs = [dict(r) for r in conn.execute(
        "SELECT * FROM segments WHERE project_id=? ORDER BY idx", (project_id,))]
    vers = [dict(r) for r in conn.execute(
        """SELECT v.*, u.name AS user_name FROM versions v JOIN users u ON u.id=v.user_id
           WHERE v.project_id=? ORDER BY v.updated_at""", (project_id,))]
    merges = {r["segment_id"]: dict(r) for r in conn.execute(
        "SELECT * FROM merges WHERE project_id=?", (project_id,))}
    vs_by_seg: dict[str, list[dict]] = {}
    for v in vers:
        vs_by_seg.setdefault(v["segment_id"], []).append(v)
    for s in segs:
        s["versions"] = vs_by_seg.get(s["id"], [])
        s["merge"] = merges.get(s["id"])
    return segs


def get_segments(project_id: str) -> list[dict]:
    conn = get_conn()
    try:
        if not conn.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
            raise notfound()
        return _segments_with_versions(conn, project_id)
    finally:
        conn.close()


# ---------- 校对提交 ----------

def submit_version(project_id: str, segment_id: str, text: str, note: str, user: dict) -> dict:
    text = (text or "").strip()
    if not text:
        raise bad("校对文本不能为空（如需标记跳过请写说明）")
    if len(text) > 20000:
        raise bad("单段文本过长（上限 2 万字）")
    conn = get_conn()
    try:
        _ensure_open(conn, project_id)
        seg = conn.execute("SELECT * FROM segments WHERE id=? AND project_id=?",
                           (segment_id, project_id)).fetchone()
        if not seg:
            raise notfound("分段不存在")
        existing = conn.execute("SELECT * FROM versions WHERE segment_id=? AND user_id=?",
                                (segment_id, user["id"])).fetchone()
        ts = now_ms()
        if existing:
            conn.execute("UPDATE versions SET text=?, note=?, updated_at=? WHERE id=?",
                         (text, (note or "").strip()[:1000], ts, existing["id"]))
            vid = existing["id"]
            action = "proof.update"
            detail = f"校对员 {user['name']} 更新段#{seg['idx'] + 1}"
        else:
            vid = uid()
            conn.execute(
                "INSERT INTO versions(id,segment_id,project_id,user_id,text,note,created_at,updated_at)"
                " VALUES(?,?,?,?,?,?,?,?)",
                (vid, segment_id, project_id, user["id"], text, (note or "").strip()[:1000], ts, ts))
            action = "proof.submit"
            detail = f"校对员 {user['name']} 提交段#{seg['idx'] + 1}"
        # 重新计算自动合并：
        # - 全部一致 → 自动合并；若此前是人工裁定/冲突状态，复位（审计已留痕）
        # - 存在分歧 → 冲突待确认；已有人工裁定则保留并标记「需复核」，其余清空定稿
        row = conn.execute("SELECT * FROM merges WHERE segment_id=?", (segment_id,)).fetchone()
        texts = {r["text"] for r in conn.execute(
            "SELECT text FROM versions WHERE segment_id=?", (segment_id,))}
        if len(texts) == 1:
            chosen_text = next(iter(texts))
            author = conn.execute(
                "SELECT user_id FROM versions WHERE segment_id=? ORDER BY updated_at LIMIT 1",
                (segment_id,)).fetchone()["user_id"]
            was_manual = bool(row and row["chosen"] == "manual")
            conn.execute(
                "INSERT INTO merges(segment_id,project_id,chosen,chosen_user,text,conflict,"
                "resolved_by,resolved_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(segment_id) DO UPDATE SET chosen='auto',"
                "chosen_user=excluded.chosen_user,text=excluded.text,conflict=0,"
                "resolved_by=NULL,resolved_at=NULL,updated_at=excluded.updated_at",
                (segment_id, project_id, "auto", author, chosen_text, 0, None, None, ts))
            detail += "；全文一致，自动合并且无冲突"
            if was_manual:
                detail += "（原人工裁定因文本趋同而自动复位，过程见审计日志）"
        else:
            # 已人工确认过：裁定文本保留（终稿仍可用），冲突位保留以提示「版本又有变化，建议复核」
            # 未确认过：进入待确认队列
            keep_manual = bool(row and row["chosen"] == "manual" and row["text"])
            conn.execute(
                "INSERT INTO merges(segment_id,project_id,chosen,chosen_user,text,conflict,"
                "resolved_by,resolved_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(segment_id) DO UPDATE SET conflict=1, "
                "chosen=CASE WHEN merges.chosen='manual' AND merges.text<>'' THEN 'manual' ELSE 'none' END,"
                "chosen_user=CASE WHEN merges.chosen='manual' AND merges.text<>'' "
                "THEN merges.chosen_user ELSE NULL END,"
                "text=CASE WHEN merges.chosen='manual' AND merges.text<>'' THEN merges.text ELSE '' END,"
                "updated_at=excluded.updated_at",
                (segment_id, project_id, "none", None, "", 1, None, None, ts))
            detail += "；与他人版本不一致，" + (
                "原人工裁定保留为定稿（建议复核新版本）" if keep_manual else "标记为冲突待人工确认")
        _audit(conn, project_id, user["id"], action, detail)
        conn.commit()
        return {"id": vid, "updated_at": ts}
    finally:
        conn.close()


# ---------- 合并视图 / 冲突确认 ----------

def merge_overview(project_id: str) -> dict:
    conn = get_conn()
    try:
        if not conn.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
            raise notfound()
        segs = _segments_with_versions(conn, project_id)
    finally:
        conn.close()

    items, auto_n, conflict_n, pending_n, review_n, missing_n = [], 0, 0, 0, 0, 0
    for s in segs:
        vs = s["versions"]
        mg = s["merge"]
        unique_texts = sorted({v["text"] for v in vs})
        if not vs:
            state = "missing"
            missing_n += 1
        elif len(unique_texts) == 1:
            state = "agreed"
            auto_n += 1
        elif mg and mg["chosen"] == "manual" and mg["text"]:
            latest_v = max((v["updated_at"] for v in vs), default=0)
            if mg["resolved_at"] and latest_v > mg["resolved_at"]:
                # 人工确认之后又有校对员提交了不同版本 → 裁定仍是定稿，但提示复核
                state = "review"
                conflict_n += 1
                review_n += 1
            else:
                state = "resolved"
                conflict_n += 1
        else:
            state = "conflict"
            conflict_n += 1
            pending_n += 1
        items.append({
            "id": s["id"], "idx": s["idx"],
            "start_ms": s["start_ms"], "end_ms": s["end_ms"],
            "original": s["original"], "state": state,
            "versions": [{"user_id": v["user_id"], "user_name": v["user_name"],
                          "text": v["text"], "note": v["note"], "updated_at": v["updated_at"]}
                         for v in vs],
            "merge": ({"chosen": mg["chosen"], "chosen_user": mg["chosen_user"],
                       "text": mg["text"], "conflict": bool(mg["conflict"]),
                       "resolved_by": mg["resolved_by"], "resolved_at": mg["resolved_at"]}
                      if mg else None),
        })
    return {"project_id": project_id, "items": items,
            "stats": {"total": len(segs), "agreed": auto_n, "conflict": conflict_n,
                      "conflict_pending": pending_n, "needs_review": review_n,
                      "missing": missing_n}}


def resolve_conflict(project_id: str, segment_id: str, chosen: str, text: str,
                     chosen_user: str | None, user: dict) -> dict:
    """冲突段人工确认。chosen ∈ user_a/user_b/manual；manual 时 text 必填。"""
    text = (text or "").strip()
    conn = get_conn()
    try:
        _ensure_open(conn, project_id)
        seg = conn.execute("SELECT * FROM segments WHERE id=? AND project_id=?",
                           (segment_id, project_id)).fetchone()
        if not seg:
            raise notfound("分段不存在")
        versions = conn.execute(
            "SELECT v.*, u.name FROM versions v JOIN users u ON u.id=v.user_id WHERE segment_id=?",
            (segment_id,)).fetchall()
        texts = {r["text"] for r in versions}
        if len(texts) < 2:
            raise bad("该分段不存在分歧，无需人工确认")
        final_text = ""
        final_user = None
        if chosen == "manual":
            if not text:
                raise bad("人工裁定需要填写定稿文本")
            final_text = text
        elif chosen in ("user_a", "user_b"):
            if chosen_user is None:
                raise bad("请指定采用哪位校对员的版本")
            row = conn.execute("SELECT * FROM versions WHERE segment_id=? AND user_id=?",
                               (segment_id, chosen_user)).fetchone()
            if not row:
                raise bad("指定的校对员版本不存在")
            if row["text"] not in texts:
                raise bad("所选版本不属于该分段")
            final_text = row["text"]
            final_user = chosen_user
        else:
            raise bad("chosen 只能是 user_a / user_b / manual")
        ts = now_ms()
        conn.execute(
            """INSERT INTO merges(segment_id,project_id,chosen,chosen_user,text,conflict,
               resolved_by,resolved_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
               ON CONFLICT(segment_id) DO UPDATE SET chosen='manual',
               chosen_user=excluded.chosen_user, text=excluded.text, conflict=1,
               resolved_by=excluded.resolved_by, resolved_at=excluded.resolved_at,
               updated_at=excluded.updated_at""",
            (segment_id, project_id, "manual", final_user, final_text, 1, user["id"], ts, ts))
        _audit(conn, project_id, user["id"], "merge.resolve",
               f"段#{seg['idx'] + 1} 冲突人工确认（采用方式：{chosen}）")
        conn.commit()
        return {"segment_id": segment_id, "text": final_text, "resolved_at": ts}
    finally:
        conn.close()


# ---------- 定稿 ----------

def finalize(project_id: str, user: dict) -> dict:
    """落库闸门：无分段、有未校对段、有未确认冲突 → 一律拒绝。"""
    conn = get_conn()
    try:
        _ensure_open(conn, project_id)
        total = conn.execute("SELECT COUNT(*) FROM segments WHERE project_id=?", (project_id,)).fetchone()[0]
        if total == 0:
            raise bad("还没有分段，无法定稿")
        segs = _segments_with_versions(conn, project_id)
        missing = [s["idx"] + 1 for s in segs if not s["versions"]]
        if missing:
            raise conflict(f"还有 {len(missing)} 段无人校对（如第 {_preview(missing)} 段），"
                           "所有分段至少需要一份校对稿", "missing_proofs")
        pending = []
        for s in segs:
            texts = {v["text"] for v in s["versions"]}
            mg = s["merge"]
            if len(texts) >= 2 and not (mg and mg["chosen"] == "manual" and mg["text"]):
                pending.append(s["idx"] + 1)
        if pending:
            raise conflict(f"有 {len(pending)} 个冲突段必须人工确认（如第 {_preview(pending)} 段），"
                           "确认后才能落库", "unresolved_conflicts")
        ts = now_ms()
        conn.execute("UPDATE projects SET status='finalized', finalized_at=? WHERE id=?", (ts, project_id))
        _audit(conn, project_id, user["id"], "project.finalize", f"全稿定稿落库，共 {total} 段")
        conn.commit()
    finally:
        conn.close()
    return get_project(project_id)


def _preview(xs: list[int], k: int = 5) -> str:
    head = ", ".join(str(x) for x in xs[:k])
    return head + (" 等" if len(xs) > k else "")


def final_transcript(project_id: str) -> list[dict]:
    conn = get_conn()
    try:
        if not conn.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
            raise notfound()
        segs = _segments_with_versions(conn, project_id)
        out = []
        for s in segs:
            # 定稿文本统一以 merges 记录为准：auto=唯一一致值，manual=人工确认值
            text = s["merge"]["text"] if s["merge"] else ""
            out.append({"idx": s["idx"], "start_ms": s["start_ms"], "end_ms": s["end_ms"],
                        "original": s["original"], "text": text,
                        "versions": [{"user_name": v["user_name"], "text": v["text"]} for v in s["versions"]]})
        return out
    finally:
        conn.close()


# ---------- 在线状态 ----------

def heartbeat(project_id: str, segment_id: str | None, user: dict) -> list[dict]:
    conn = get_conn()
    try:
        ts = now_ms()
        conn.execute(
            "INSERT INTO presence(user_id,project_id,segment_id,seen_at) VALUES(?,?,?,?) "
            "ON CONFLICT(user_id,project_id) DO UPDATE SET segment_id=excluded.segment_id,"
            "seen_at=excluded.seen_at",
            (user["id"], project_id, segment_id, ts))
        cutoff = ts - 15_000
        rows = conn.execute(
            """SELECT p.segment_id, u.id AS user_id, u.name AS user_name, p.seen_at
               FROM presence p JOIN users u ON u.id=p.user_id
               WHERE p.project_id=? AND p.seen_at>=? ORDER BY u.name""",
            (project_id, cutoff)).fetchall()
        conn.commit()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# ---------- 审计日志 ----------

def audit_logs(project_id: str, limit: int = 200) -> list[dict]:
    conn = get_conn()
    try:
        rows = conn.execute(
            """SELECT a.*, u.name AS user_name FROM audit_logs a
               LEFT JOIN users u ON u.id=a.user_id
               WHERE a.project_id=? ORDER BY a.id DESC LIMIT ?""",
            (project_id, limit)).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()
