"""一键演示数据：合成 100 秒 WAV 音频 + 8 段草稿 + 两位校对员的部分校对稿，含一处冲突。"""
from __future__ import annotations

import math
import os
import struct
import wave

from . import service
from .db import DATA_DIR, get_conn, init_db
from .util import uid

UPLOAD_DIR = DATA_DIR / "uploads"

# 每段 (秒, 基准频率Hz, 草稿原文)
SCRIPT = [
    (10, 220, "一九七六年的冬天，我第一次坐上火车，是去县城考中学。"),
    (12, 247, "天还没亮，母亲就在灶屋里忙，给我煮了两个鸡蛋，塞进棉袄口袋。"),
    (11, 277, "车站全是人，背着铺盖卷，雪粒子打在脸上生疼。"),
    (13, 294, "我记得车票是一块二，父亲把钱折成小方块，放在我贴身的衣兜里。"),
    (12, 330, "车厢里没有座位，我们几个学生就蹲在过道，谁也不敢睡。"),
    (14, 262, "窗外的田地白茫茫一片，过了一条大河，才看见县城的烟囱。"),
    (13, 349, "考试那天下着冻雨，教室里生了炭盆，我的鞋还是湿透了。"),
    (15, 392, "后来通知书送到大队部那天，母亲正在纳鞋底，她没说话，只把鞋底又拿起来。"),
]


def _synth_wav(path: str) -> None:
    """为每段合成不同基频的柔和音体，段与段之间留 0.3s 静音，便于听辨边界。"""
    sr = 22050
    gap = 0.3
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        frames = bytearray()
        for i, (dur, freq, _text) in enumerate(SCRIPT):
            n = int(dur * sr)
            for k in range(n):
                t = k / sr
                # 基频 + 泛音，整体淡入淡出避免爆音
                env = min(1.0, t / 0.05, (dur - t) / 0.05)
                val = 0.5 * math.sin(2 * math.pi * freq * t)
                val += 0.2 * math.sin(2 * math.pi * freq * 2 * t)
                val += 0.08 * math.sin(2 * math.pi * 7 * t)
                frames += struct.pack("<h", int(val * env * 11000))
            if i < len(SCRIPT) - 1:
                frames += b"\x00\x00" * int(gap * sr)
        w.writeframes(frames)


def create_demo() -> dict:
    init_db()
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    conn = get_conn()
    try:
        existing = conn.execute(
            "SELECT id FROM projects WHERE name=?", ("演示：一九七六年的冬天",)).fetchone()
        if existing:
            return service.get_project(existing["id"])
    finally:
        conn.close()

    # 校对员
    try:
        u1 = service.create_user("林校对")
    except service.HttpError:
        u1 = service.login_user("林校对")
    try:
        u2 = service.create_user("周校对")
    except service.HttpError:
        u2 = service.login_user("周校对")

    p = service.create_project("演示：一九七六年的冬天",
                               "合成音频与预置草稿，内含一处两位校对员意见不一致的冲突段。", u1)
    pid = p["id"]

    # 音频
    fname = f"{uid()}_demo-1976.wav"
    fpath = UPLOAD_DIR / fname
    _synth_wav(str(fpath))
    total = sum(d for d, _, _ in SCRIPT) + 0.3 * (len(SCRIPT) - 1)
    conn = get_conn()
    try:
        conn.execute(
            "UPDATE projects SET audio_file=?, audio_name=?, audio_mime=?, audio_size=?, audio_dur=? WHERE id=?",
            (fname, "demo-1976.wav", "audio/wav", os.path.getsize(fpath), round(total, 2), pid))
        conn.commit()
    finally:
        conn.close()

    # 分段（含段间静音对齐）
    segs, t = [], 0.0
    for i, (dur, _f, text) in enumerate(SCRIPT):
        start = int(t * 1000)
        t += dur
        end = int(t * 1000)
        segs.append({"start_ms": start, "end_ms": end, "original": text})
        t += 0.3 if i < len(SCRIPT) - 1 else 0
    service.replace_segments(pid, segs, "演示脚本", u1)

    seg_rows = service.get_segments(pid)

    # 林校对：校对 1-6 段，其中第 5 段与周校对有分歧
    edits = {
        0: ("一九七六年的冬天，我头一回坐火车，是去县城考中学。", ""),
        1: ("天还没亮，母亲就在灶屋里忙活，给我煮了两个鸡蛋，塞进棉袄口袋。", ""),
        2: ("车站上全是人，背着铺盖卷，雪粒子打在脸上生疼。", "补「上」字"),
        3: ("我记得车票是一块二，父亲把钱折成小方块，放在我贴身的衣兜里。", ""),
        4: ("车厢里没有座位，我们几个学生就蹲在过道里，谁也不敢睡。", "「过道」后补「里」"),
        5: ("窗外的田地白茫茫一片，过了一条大河，才望见县城的烟囱。", ""),
    }
    for idx, (txt, note) in edits.items():
        service.submit_version(pid, seg_rows[idx]["id"], txt, note, u1)

    # 周校对：校对 2、4、5、6、7 段；第 5 段故意不一致；第 7 段留备注
    edits2 = {
        1: ("天还没亮，母亲就在灶屋里忙活，给我煮了两个鸡蛋，塞进棉袄口袋。", ""),
        3: ("我记得车票是一块二，父亲把钱折成小方块，放在我贴身的衣裳兜里。", "原文「衣兜」"),
        4: ("车厢里没有座位，我们几个学生就蹲在过道上，谁也不敢睡。", ""),
        5: ("窗外的田地白茫茫一片，过了一条大河，才看见县城里的烟囱。", ""),
        6: ("考试那天下着冻雨，教室里生了炭盆，我的棉鞋还是湿透了。", "补「棉」字"),
    }
    for idx, (txt, note) in edits2.items():
        service.submit_version(pid, seg_rows[idx]["id"], txt, note, u2)

    return service.get_project(pid)


if __name__ == "__main__":
    p = create_demo()
    print("演示项目已创建：", p["id"])
