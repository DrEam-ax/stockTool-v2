"""报告渲染：Markdown 输出。"""

from __future__ import annotations

import sqlite3
from datetime import datetime

from ..backtest.stats import num, pct

VERDICT = {
    "insufficient": "样本不足",
    "better": "显著优于随机",
    "noise": "与随机无异",
    "worse": "显著差于随机",
}


def _verdict(entry: dict) -> str:
    """判定。优先用对着**实测基线**算出来的结论。

    如果基线还没算（baseline 表为空），退回 50% 口径并明确标注，
    因为 A 股里 50% 这个原假设几乎总是错的。
    """
    if entry.get("verdict"):
        return entry["verdict"]
    if not entry.get("n"):
        return VERDICT["insufficient"]
    if not entry.get("rankable"):
        return VERDICT["insufficient"]
    low = entry.get("wilson_low") or 0.0
    p = entry.get("p_value")
    rate = entry.get("hit_rate") or 0.0
    if p is not None and p < 0.05 and low > 0.5:
        return VERDICT["better"]
    if p is not None and p < 0.05 and rate < 0.5:
        return VERDICT["worse"]
    return VERDICT["noise"]


def render_scoreboard(board: list[dict], *, horizon: int,
                      benchmark_secid: str, min_samples: int) -> str:
    lines: list[str] = []
    baseline = None
    for e in board:
        if e.get("baseline_hit_rate"):
            baseline = e["baseline_hit_rate"]
            break
    lines.append(f"**评价周期：T+{horizon} 交易日　基准：{benchmark_secid}　"
                 f"上榜门槛：{min_samples} 个样本**\n")
    if baseline:
        lines.append(
            f"> 对照基线（随机选股 + 一律看多、同一批日期）：**命中率 "
            f"{baseline * 100:.2f}%**。判定是与这个基线比，不是与 50% 比 —— "
            "A 股里中位数个股本来就跑输市值加权指数，"
            "拿 50% 当基准会冤枉所有人。\n")
    else:
        lines.append(
            "> ⚠️ **还没有计算对照基线**，当前判定退回 50% 口径。\n"
            "> A 股里随机选股的命中率只有约 44%，"
            "50% 是错误原假设，请先跑 `python run.py baseline`。\n")
    lines.append("| # | 大V | 来源 | 样本 | 命中率 | Wilson 95% 下界 | "
                 "vs基线 p | 平均超额 | 中位超额 | 盈亏比 | 判定 |")
    lines.append("|---|-----|------|------|--------|----------------|"
                 "-----------|---------|---------|--------|------|")
    for i, e in enumerate(board, 1):
        p = e.get("p_value_vs_baseline")
        lines.append(
            f"| {i} | {e['author']} | {e['source']} | {e['n']} | "
            f"{pct(e['hit_rate'])} | {pct(e['wilson_low'])} | "
            f"{('%.3f' % p) if p is not None else '—'} | "
            f"{num(e['avg_excess'], 4)} | {num(e['median_excess'], 4)} | "
            f"{('%.2f' % e['payoff']) if e['payoff'] else '—'} | {_verdict(e)} |"
        )
    lines.append("")
    return "\n".join(lines)


def render_author_detail(board: list[dict], *, limit: int = 5) -> str:
    lines: list[str] = ["### 大V 分项明细\n"]
    for e in board[:limit]:
        lines.append(f"\n**{e['author']}**（{e['source']}，n={e['n']}）\n")
        lines.append("| 维度 | 样本 | 命中率 | 平均超额 | 判定 |")
        lines.append("|------|------|--------|---------|------|")
        for label, key in (("个股", "by_stock"), ("板块ETF", "by_fund"),
                           ("行业板块", "by_industry"), ("概念板块", "by_concept"),
                           ("指数", "by_index"),
                           ("看多", "by_bull"), ("看空", "by_bear")):
            sub = e.get(key)
            if not sub or not sub.get("n"):
                continue
            lines.append(f"| {label} | {sub['n']} | {pct(sub['hit_rate'])} | "
                         f"{num(sub['avg_excess'], 4)} | {_verdict(sub)} |")
    lines.append("")
    return "\n".join(lines)


def render_consensus(rows: list[dict], *, scope_label: str,
                     min_authors: int) -> str:
    lines: list[str] = []
    lines.append(f"**口径：{scope_label}　最少参与大V：{min_authors}　"
                 "得分 = Σ 作者历史命中率 × 方向 × 强度权重**\n")
    lines.append("| # | 标的 | 类型 | 代码 | 看多 | 看空 | 参与大V | 加权得分 | 最近提及 |")
    lines.append("|---|------|------|------|------|------|---------|---------|---------|")
    type_cn = {"stock": "个股", "fund": "板块ETF", "industry": "行业",
               "concept": "概念", "index": "指数"}
    for i, r in enumerate(rows, 1):
        lines.append(
            f"| {i} | {r['name']} | {type_cn.get(r['type'], r['type'])} | "
            f"{r['code']} | {r['bull']} | {r['bear']} | {r['n_authors']} | "
            f"{r['score']:+.3f} | {r['last_date']} |"
        )
    lines.append("")
    return "\n".join(lines)


def render_overview(con: sqlite3.Connection, cfg) -> str:
    def scalar(sql: str, *params):
        row = con.execute(sql, params).fetchone()
        return list(row)[0] if row else 0

    lines = ["### 数据概览\n", "| 项 | 数量 |", "|----|------|"]
    lines.append(f"| 大V | {scalar('SELECT COUNT(*) FROM author')} |")
    lines.append(f"| 原始文档 | {scalar('SELECT COUNT(*) FROM doc')} |")
    lines.append(f"| 文档版本快照 | {scalar('SELECT COUNT(*) FROM doc_revision')} |")
    lines.append(f"| 标的（可匹配） | {scalar('SELECT COUNT(*) FROM instrument')} |")
    lines.append(f"| 别名 | {scalar('SELECT COUNT(*) FROM alias')} |")
    lines.append(f"| 日线记录 | {scalar('SELECT COUNT(*) FROM quote_daily')} |")
    total_op = scalar("SELECT COUNT(*) FROM opinion")
    resolved = scalar("SELECT COUNT(*) FROM opinion WHERE resolved = 1")
    lines.append(f"| 观点总数 | {total_op} |")
    lines.append(f"| 观点（已归属标的） | {resolved} |")
    dup = scalar("SELECT COUNT(*) FROM opinion WHERE is_dup = 1")
    if total_op:
        lines.append(f"| 观点（已归属标的） | {resolved} |")
        lines.append(f"| 观点（去重后独立） | {total_op - dup} |")
        lines.append(f"| 重复观点（反复发帖，已排除） | {dup} |")
        lines.append(f"| 归属率 | {resolved / total_op * 100:.1f}% |")
    for status in ("ok", "pending", "no_data", "self_benchmark"):
        n = scalar(
            "SELECT COUNT(*) FROM opinion_eval e JOIN opinion o ON o.id = e.opinion_id "
            "WHERE e.status = ? AND o.is_dup = 0", status)
        label = {"self_benchmark": "回测 大盘类(基准自身，不计入)"}.get(
            status, f"回测 {status}")
        lines.append(f"| {label} | {n} |")
    lines.append("")

    by_type = con.execute(
        "SELECT subject_type, COUNT(*) n FROM opinion WHERE resolved = 1 "
        "GROUP BY subject_type ORDER BY n DESC"
    ).fetchall()
    if by_type:
        lines.append("按标的类型分布：" + "　".join(
            f"{r['subject_type']}={r['n']}" for r in by_type) + "\n")
    return "\n".join(lines)


def render_header(title: str, cfg) -> str:
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    return (f"# {title}\n\n"
            f"> 生成时间：{ts}　基准：`{cfg.values['benchmark_secid']}`　"
            f"评价周期：{cfg.values['horizons']}\n\n"
            "> ⚠️ 本报告是研究工具输出，不构成任何投资建议。"
            "命中率受样本量影响极大，请优先看 Wilson 区间与 p 值，不要只看命中率。\n\n")


def render_caveats() -> str:
    return (
        "\n---\n\n## 已知局限（务必先读）\n\n"
        "1. **判定用实测基线，不是 50%**。A 股里中位数个股本来就跑输市值加权的"
        "沪深300，随机选股在同一批日期上的命中率只有 **44%/45%/43%**。"
        "拿 50% 做符号检验会把几乎所有大V判成「显著差于随机」——那是假结论。"
        "所以报告里的 p 值是对着基线算的；基线由 `baseline` 命令抽样实测并落库。\n"
        "2. **「大盘」类观点已排除**。它们的标的即基准，超额收益恒为 0、"
        "命中恒为 0，混进来会系统性拉低命中率。"
        "（实测这一项曾把 907 个样本里的 71 个记成全错，足以颠倒结论。）\n"
        "3. **样本量**：n < 10 的命中率没有统计意义。Wilson 下界才是能比较的数字。\n"
        "4. **幸存者偏差**：只采集了仍在发声的大V。"
        "已删号、删帖的失败者不在样本里，整体命中率会被系统性高估。\n"
        "5. **删帖风险**：正文已做快照（`doc_revision`），采集之前被删的无法追回。\n"
        "6. **这是公开观点，不是他的实盘**。他可能说一套做一套；"
        "而且他 73% 的观点是看多，本榜单主要衡量的是他的看多能力。\n"
        "7. **提取误差**：LLM 抽取仍会漏（尤其不带方向词的隐含观点），"
        "也会把跨句的标的归属搞错。归属率约 78%，未归属的观点不进回测。\n"
        "8. **不是投资建议**：本输出只描述历史统计事实，不预测未来。\n"
        "9. **已去重**：大V 会反复顶帖、分别回复不同人，同一段话生成多条帖子。"
        "实测重复率可达两成（同一观点最多重复七次）。"
        "不去重会让样本量虚高、Wilson 区间变窄、p 值假性显著。"
        "本报告的统计已排除重复项（`is_dup=1`）。\n"
        "10. **判定的方向性**：所谓「在某标的上显著强」，可能是他**看空**判断准，"
        "不代表他推荐过该标的。请结合 `per_subject` 的方向明细阅读。\n"
        "11. **必须看长周期**：实测某左侧+长期持有型大V，"
        "T+5/20/60 全部「与随机无异」，**T+250 却是「显著强于随机」（p=0.000）**。"
        "只跑短周期会把这类人误判成没水平——这是本项目踩过的最大的方法论坑。\n"
    )
