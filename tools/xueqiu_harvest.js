/* ============================================================
 *  雪球发言归档脚本 v3
 * ============================================================
 *
 *  【推荐用法：存成 DevTools 代码段，之后一键运行】
 *
 *    1. Edge 打开  https://xueqiu.com/u/<改成目标UID>
 *    2. F12 打开开发者工具
 *    3. 点顶部「源代码 / Sources」标签
 *    4. 左侧面板里找「代码段 / Snippets」（找不到就点 >> 展开）
 *    5. 点「+ 新建代码段」，名字随便起，比如 xq
 *    6. 把本文件全部内容粘进去，按 Ctrl+S 保存
 *    7. 选中这个代码段，按 Ctrl+Enter 运行
 *
 *    之后每次要续跑：
 *      刷新页面(F5) → 点一下代码段 → Ctrl+Enter
 *    —— 不用再复制粘贴。
 *
 *  ------------------------------------------------------------
 *  v3 相比 v2：
 *    · 撞到风控时最多重试 5 次，退避到 30s/60s/120s/180s/240s
 *      （风控多半是时间窗口，等一等通常能过，不必每次人工干预）
 *    · 明确报告「每页实际多少条」——count=100 若能生效，
 *      117 页会压缩到 20 多次请求，一轮就能跑完
 *    · 进度存 localStorage，刷新后自动从上次的页继续
 *
 *  跑不完是正常的。刷新页面再按一次 Ctrl+Enter 即可，
 *  直到控制台出现「★ 全部完成！」。
 * ============================================================ */

(async () => {
  const UID = '';                 // ← 必填：目标用户的雪球 UID
  const EXPECT_NAME = '';          // ← 必填：目标用户的昵称，用于身份校验，不符立即停止
  const GAP_MIN = 5000, GAP_MAX = 9000;   // 正常翻页间隔
  const RETRY_WAITS = [30000, 60000, 120000, 180000, 240000];  // 撞风控后的退避
  const MAX_PAGES_PER_RUN = 200;
  const PART_EVERY = 20;                  // 每多少页导出一个分段文件
  // 主动冷却：实测风控大约在连续 5~6 次请求后触发，
  // 与其被拦下再等 90s，不如每几页主动停一下，失败请求更少。
  const COOLDOWN_EVERY = 5;
  const COOLDOWN_MIN = 45000, COOLDOWN_MAX = 75000;

  // 实测 count=200/100/50 一律 400 Bad Request，服务端上限约 20 条/页。
  // 所以不再浪费请求去试它们。
  const COUNT_CANDIDATES = [20, 0];       // 0 = 不传 count，用默认

  const KEY = `xq_harvest_${UID}`;
  const say = (...a) => console.log('%c[归档]', 'color:#0a0;font-weight:bold', ...a);
  const warn = (...a) => console.log('%c[归档]', 'color:#e60;font-weight:bold', ...a);
  const bad = (...a) => console.log('%c[归档]', 'color:#c00;font-weight:bold', ...a);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const gap = () => GAP_MIN + Math.random() * (GAP_MAX - GAP_MIN);

  const state = JSON.parse(localStorage.getItem(KEY) || '{}');
  let nextPage = state.nextPage || 1;
  let base = state.base || null;
  let maxPage = state.maxPage || null;
  const collected = [];
  const seen = new Set();
  const runStart = Date.now();
  const eta = (pages, secPerPage) => {
    const m = Math.round((pages * secPerPage) / 60);
    return m < 1 ? '不到 1 分钟' : `约 ${m} 分钟`;
  };

  async function checkIdentity(st) {
    const au = (st[0] && st[0].user) || {};
    if (String(au.id) !== UID) {
      bad(`身份不符！期望 uid=${UID}，实际 ${au.id}（${au.screen_name}）。已停止。`);
      return false;
    }
    if (au.screen_name && au.screen_name !== EXPECT_NAME) {
      bad(`昵称不符！期望「${EXPECT_NAME}」，实际「${au.screen_name}」。已停止。`);
      return false;
    }
    return true;
  }

  // ---------- 1) 探测端点 + 找出最大可用页大小 ----------
  if (!base) {
    say('探测端点与页大小…');
    const paths = [
      `/v4/statuses/user_timeline.json?user_id=${UID}`,
      `/statuses/user_timeline.json?user_id=${UID}`,
    ];
    const counts = COUNT_CANDIDATES;
    let best = null;

    outer:
    for (const p of paths) {
      for (const c of counts) {
        const qs = c ? `&count=${c}` : '';
        try {
          const r = await fetch(`${p}${qs}&page=1`, { credentials: 'include' });
          const t = await r.text();
          if (!t.trim().startsWith('{')) { continue; }
          const j = JSON.parse(t);
          if (!j.statuses || !j.statuses.length) { continue; }
          if (!(await checkIdentity(j.statuses))) { return; }

          const per = j.statuses.length;
          if (!best || per > best.per) {
            best = { p, c, per, maxPage: j.maxPage, total: j.total };
          }
          say(`  ${p} count=${c || '默认'} → 每页 ${per} 条`);
          break outer;   // 第一个能用的就够，但要报告实际页大小
        } catch (e) { /* 试下一个 */ }
        await sleep(700);
      }
    }

    if (!best) {
      bad('所有候选端点都不可用。请把上面的输出发给我。');
      return;
    }

    base = `${best.p}${best.c ? `&count=${best.c}` : ''}&page=`;
    maxPage = best.maxPage;
    say(`端点确认：${best.p}`);
    say(`每页实际 ${best.per} 条（请求 count=${best.c || '默认'}）`);
    say(`总页数 ${best.maxPage}，总条数 ${best.total}`);
    if (best.per < 30) {
      warn(`服务端把每页限制在 ${best.per} 条，共需 ${best.maxPage} 次请求。`);
      warn(`按每次请求约 7 秒 + 每 ${COOLDOWN_EVERY} 页冷却 1 分钟估算，`);
      warn(`整轮大约需要 ${Math.round((best.maxPage * 7 + (best.maxPage / COOLDOWN_EVERY) * 60) / 60)} 分钟。`);
      warn('请把本标签页保持在前台 —— 浏览器会限制后台标签的定时器，');
      warn('切到别的标签会让它慢几十倍。');
    } else {
      say(`按每页 ${best.per} 条计算，只需 ${best.maxPage} 次请求`);
    }
    localStorage.setItem(KEY, JSON.stringify({ nextPage, base, maxPage }));
  } else {
    say(`沿用上次的端点，从第 ${nextPage} 页继续（共 ${maxPage || '?'} 页）`);
  }

  // ---------- 2) 翻页 ----------
  let page = nextPage;
  let done = 0;
  const startPage = page;

  while (page <= 1000 && done < MAX_PAGES_PER_RUN) {
    let j = null;
    let gaveUp = false;

    for (let attempt = 0; attempt <= RETRY_WAITS.length; attempt++) {
      if (attempt > 0) {
        const wait = RETRY_WAITS[attempt - 1];
        warn(`第 ${page} 页触发风控，等 ${wait / 1000}s 后重试 `
             + `(${attempt}/${RETRY_WAITS.length})…`);
        await sleep(wait);
      }
      try {
        const r = await fetch(base + page, { credentials: 'include' });
        const t = await r.text();
        if (!t.trim().startsWith('{')) { continue; }   // 风控页，进下一轮退避
        j = JSON.parse(t);
        if (attempt > 0) say(`  ✓ 第 ${page} 页重试成功`);
        break;
      } catch (e) {
        warn(`第 ${page} 页请求异常：${e.message}`);
      }
    }

    if (!j) {
      gaveUp = true;
      warn(`第 ${page} 页重试 ${RETRY_WAITS.length} 次仍失败，本次运行结束。`);
      warn('请【刷新页面】后重新按 Ctrl+Enter 运行，会从这一页继续。');
    }

    if (gaveUp) break;

    const st = j.statuses || [];
    if (j.maxPage) maxPage = j.maxPage;
    if (!st.length) { say(`第 ${page} 页为空，已到末尾`); nextPage = page; break; }

    let fresh = 0;
    for (const s of st) {
      if (s && s.id && !seen.has(s.id)) { seen.add(s.id); collected.push(s); fresh++; }
    }
    const pct = maxPage ? ` (${((page / maxPage) * 100).toFixed(0)}%)` : '';
    say(`第 ${page}/${maxPage || '?'} 页${pct}：${st.length} 条，新增 ${fresh}，`
        + `本次累计 ${collected.length}`);

    if (fresh === 0) { say('本页无新内容，判定已到末尾'); nextPage = page; break; }

    nextPage = page + 1;
    localStorage.setItem(KEY, JSON.stringify({ nextPage, base, maxPage }));
    page++;
    done++;

    if (maxPage && page > maxPage) { say('已翻到最后一页'); break; }

    if (done % PART_EVERY === 0) {
      download(collected, `${startPage}-${page - 1}`, false);
      const remaining = maxPage ? maxPage - nextPage + 1 : '?';
      say(`已导出分段文件（第 ${startPage}~${page - 1} 页），`
          + `剩 ${remaining} 页，预计还需 ${eta(remaining, 7)}`);
    }

    // 主动冷却，降低触发风控的概率
    if (done % COOLDOWN_EVERY === 0) {
      const cool = COOLDOWN_MIN + Math.random() * (COOLDOWN_MAX - COOLDOWN_MIN);
      say(`主动冷却 ${Math.round(cool / 1000)}s，避免触发风控…`);
      await sleep(cool);
    } else {
      await sleep(gap());
    }
  }

  // ---------- 3) 收尾 ----------
  if (collected.length) download(collected, `${startPage}-${nextPage - 1}`, true);

  const finished = maxPage && nextPage > maxPage;
  const mins = ((Date.now() - runStart) / 60000).toFixed(1);
  if (finished) {
    localStorage.removeItem(KEY);
    say(`★ 全部完成！共跑 ${mins} 分钟。可以停止运行了。`);
    say('请把所有 xueqiu_*.json 告诉我，我来导入。');
  } else if (collected.length) {
    const remaining = maxPage ? maxPage - nextPage + 1 : '?';
    say(`本次跑了 ${mins} 分钟，进度已保存：下次从第 ${nextPage} 页继续。`);
    warn(`还需约 ${remaining} 页。请【刷新页面】后按 Ctrl+Enter 继续。`);
  } else {
    warn('本次没有抓到新内容。若反复如此，请把上面的输出发给我。');
  }

  function download(list, range, isLast) {
    const payload = {
      _source: 'xueqiu-console-harvest',
      _harvested_at: new Date().toISOString(),
      uid: UID,
      endpoint: base,
      page_range: range,
      is_last_batch: !!isLast,
      count: list.length,
      statuses: list,
    };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `xueqiu_${UID}_p${range}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    say(`已下载 xueqiu_${UID}_p${range}.json（${list.length} 条）`);
  }
})();
