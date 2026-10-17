/**
 * 抖音标记视频自动跳过（30x16 / 购物标签）
 *
 * 目标（老师的要求）：在 https://www.douyin.com/?recommend=1 里，
 *   当前视频一旦出现下面任一标记，**立刻**滑动到下一个视频：
 *     ① <rect width="30" height="16" rx="2">
 *     ② <div class="gwmKU4Jo"> 且里面含「购物」
 *
 * ── 判定规则（老师贴的 DOM，照用，不加自己的猜测）────────────────
 *   三个条件同时成立才算「命中当前视频」：
 *     ① 元素在可视区域内（getBoundingClientRect 与视口相交）
 *     ② 元素归属的视频卡片就是页面自报的活跃卡片
 *        （closest('[data-e2e="feed-item"]') === 活跃卡片；找不到归属就不卡这条）
 *     ③ 这个视频还没被处理过（按 data-e2e-vid 去重，跳成功才记账）
 *   只满足「页面上有」不算——预加载的下一张卡片里也有同样的标记，
 *   那不该触发跳转。② 对「购物标签」尤其重要：标签只在卡片里，必须认卡片归属。
 *
 * ── 跳转（沿用带货插件里实测有效的两招，都要校验结果）──────────
 *   1) 点页面自己的「下一个」箭头（最接近原生滑动，也最快）
 *   2) 视频没换 → 把滚动容器 .slidelist **精确推一条**（对齐下一条卡片的真实偏移）
 *   刻意不做的事（v1.0.0 的教训：会让推荐流一片黑）：
 *     ✗ scrollIntoView   —— 会滚动到不确定的祖先，跳过头
 *     ✗ window.scrollBy  —— 会把整个应用布局滚出视野
 *     ✗ 连环多次滚动     —— 虚拟列表没渲染的地方就是黑屏
 *
 * ── 「跳过之后卡住」的修复（v1.1.1，老师反馈后加的）──────────────
 *   症状：带标记的视频确实被跳过了，但画面卡住，得手动按「恢复画面」。
 *   成因有三条，逐条修：
 *     ① **程序化换页会让抖音播放器停在 00:00**（画面像卡住）——换页后要
 *        给滚动容器补发合成的 scroll 事件、并对没在播的视频显式 play()；
 *        分 350/1000/1800ms 三次做，因为刚换页时播放器常常还没挂上新的视频源。
 *     ② **停在两条卡片的边界上**会被页面当成没翻页——兜底多推 4px，
 *        并在跳完 2.5 秒内把当前卡片对齐回容器顶部（alignActive）。
 *     ③ **箭头和滚动各推了一次**（页面换页是异步的，确认太早就会重复推）
 *        —— 箭头点完最多确认三次（500/800/1100ms），确认换了页就绝不再推滚动容器。
 *   原有的空白自救保留：跳完画面上一条卡片都没有，就回滚一条把内容找回来。
 *
 * ── 触发与安全阀 ────────────────────────────────────────────────
 *   比带货插件更「立刻」：轮询 250ms + MutationObserver 兜住 DOM 变化，
 *   触发后只等 600ms 让画面稳定。安全阀沿用实测参数：
 *   10 秒内最多 3 次，超出暂停 20 秒；连续 3 次没跳成功，暂停 30 秒。
 */
(() => {
  'use strict';

  const LOG = '[标记跳过]';
  const CART_RE = /购物/;
  /**
   * 标记清单。sel 是选择器；text 是可选的文本条件（命中必须同时满足）。
   *
   * 关于「购物」标签：抖音的 class 是 CSS-in-JS 生成的（wgmKU4Jo → nreJijFE → …），
   * 每次发版都可能变，所以**不写死任何 class**。改成两条语义规则：
   *   1. span/div 的**文本恰好是「购物」**（前后不夹别的字），并且可见、属于当前卡片；
   *   2. 文本**包含「购物」但很短**（≤6 字）的元素，作为兜底。
   * 只要抖音还把它渲染成一段文字「购物」，改 class 都不影响。
   */
  const MARKERS = [
    { kind: 'rect-30x16-rx2', sel: 'rect[width="30"][height="16"][rx="2"]' },
    { kind: 'text-购物-精确', sel: 'span, div', exactText: '购物' },
    { kind: 'text-购物-短句', sel: 'span, div', text: CART_RE, maxLen: 6 }
  ];

  /**
   * 作者名选择器：卡片里以 @ 开头的那个 span。
   * 抖音的 class 是 CSS-in-JS 生成的（现在叫 WLnPrnPW），会变——所以这里不写死
   * class，而是用「span 文本以 @ 开头」这个语义去扫，改名不会失效。
   */
  const AUTHOR_MAX_LEN = 40;

  /** 把元素里的作者名规范化：去掉开头的 @、去掉后面 " · 时间" 之类的尾巴 */
  function normalizeAuthor(raw) {
    let s = String(raw || '').trim();
    if (!s) return '';
    if (s.charAt(0) === '@') s = s.slice(1);
    // 有些节点文本是 "@名字 · 5天前"，只留名字
    const cut = s.search(/\s*[·・]\s*/);
    if (cut > 0) s = s.slice(0, cut);
    return s.trim();
  }

  const TICK_MS = 250;             // 检测节拍
  const OBSERVE_THROTTLE_MS = 120; // DOM 变动后的最快重检间隔
  const MIN_GAP_MS = 600;          // 两次跳转的最小间隔（老师要求「立刻」，所以很短）
  const TRIGGER_COOLDOWN_MS = 600; // 一次触发后多久内不再触发
  const VERIFY_MS = 500;           // 每个动作后的校验等待
  const MAX_PER_10S = 3;           // 安全阀：10 秒最多 3 次
  const PAUSE_MS = 20000;
  const FAIL_LIMIT = 3;            // 连续失败次数上限
  const FAIL_PAUSE_MS = 30000;
  const RECOVER_WINDOW_MS = 12000; // 跳转后多久内允许自动自救
  const ALIGN_WINDOW_MS = 2500;    // 跳转后多久内允许自动把卡片对齐回边界
  const SEEN_MAX = 200;            // 已处理视频 id 的保留上限

  const state = {
    enabled: true,
    lastAdvanceAt: 0,
    lastTriggerAt: 0,
    attempts: [],
    pausedUntil: 0,
    failStreak: 0,
    total: 0,
    today: 0,
    date: dayKey(),
    lastReason: '',
    lastAdvanceEnd: 0,
    seen: new Set(),        // 已成功跳过的视频 id
    blockedAuthors: []      // 作者黑名单（不含 @ 的规范化名字）
  };

  function dayKey() {
    const d = new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function log(msg) {
    try { console.info(LOG, msg); } catch (e) { /* ignore */ }
  }

  // ───────────────────────── 识别标记 ─────────────────────────

  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    if (vh < 50) return false;
    return r.bottom > 1 && r.top < vh - 1 && r.right > 1 && r.left < vw - 1;
  }

  function activeCard() {
    const box = document.querySelector('[data-e2e="feed-active-video"]');
    if (box) {
      const card = box.closest('[data-e2e="feed-item"]');
      if (card) return card;
    }
    return null;
  }

  /**
   * 标记是否属于「正在播的这一条」。
   * 找不到归属（标记不在卡片里，比如浮层）时不拦，交给可视性判定。
   */
  function belongsToActive(el) {
    let card = null;
    try { card = el.closest('[data-e2e="feed-item"]'); } catch (e) { card = null; }
    if (!card) return true;
    const active = activeCard();
    if (!active) return true;
    return card === active;
  }

  /**
   * 文本类标记的命中判定：只看这个元素**自己**的文字，不含子元素拼起来的长文本。
   * 这样「购物」标签能中，而整张卡片的简介里出现「购物」不会误判。
   */
  function ownText(el) {
    let s = '';
    try {
      for (const node of el.childNodes) {
        if (node.nodeType === 3) s += node.nodeValue || '';
      }
    } catch (e) { /* ignore */ }
    return s.replace(/\s+/g, ' ').trim();
  }

  function matchTextMarker(el, marker) {
    const own = ownText(el);
    if (!own) return false;
    if (marker.exactText) return own === marker.exactText;
    if (marker.text) {
      if (!marker.text.test(own)) return false;
      if (marker.maxLen && own.length > marker.maxLen) return false;
      return true;
    }
    return false;
  }

  function findMarker() {
    for (const marker of MARKERS) {
      let nodes = [];
      try { nodes = document.querySelectorAll(marker.sel); } catch (e) { nodes = []; }
      for (const el of nodes) {
        if ((marker.text || marker.exactText) && !matchTextMarker(el, marker)) continue;
        if (!visible(el)) continue;
        if (!belongsToActive(el)) continue;
        return { kind: marker.kind, el };
      }
    }
    // 作者黑名单：当前这条视频的作者名命中了就跳过
    const author = currentAuthor();
    if (author && isBlockedAuthor(author)) {
      return { kind: '作者：@' + author, el: null };
    }
    return null;
  }

  /** 这一条正在播的视频的作者名（规范化后，不含 @） */
  function currentAuthor() {
    const active = activeCard();
    const scopes = active ? [active] : [];
    if (!scopes.length) {
      // 认不出活跃卡片时，退化为“整个文档里可见的那个 @ 名”
      scopes.push(document.body);
    }
    for (const scope of scopes) {
      if (!scope) continue;
      let nodes = [];
      try { nodes = scope.querySelectorAll('span'); } catch (e) { nodes = []; }
      for (const el of nodes) {
        const txt = (el.textContent || '').trim();
        if (!txt || txt.charAt(0) !== '@') continue;
        if (txt.length > AUTHOR_MAX_LEN) continue;
        if (!visible(el)) continue;
        const name = normalizeAuthor(txt);
        if (name) return name;
      }
    }
    return '';
  }

  /** 作者名是否在黑名单里（大小写不敏感 + 去空格全等比较，免得误伤同名片段） */
  function isBlockedAuthor(name) {
    if (!name || !state.blockedAuthors || state.blockedAuthors.length === 0) return false;
    const key = name.replace(/\s+/g, '').toLowerCase();
    for (const b of state.blockedAuthors) {
      if (String(b).replace(/\s+/g, '').toLowerCase() === key) return true;
    }
    return false;
  }

  function addBlockedAuthor(name) {
    const clean = normalizeAuthor(name);
    if (!clean) return false;
    if (isBlockedAuthor(clean)) return false;
    state.blockedAuthors.push(clean);
    if (state.blockedAuthors.length > 500) state.blockedAuthors = state.blockedAuthors.slice(-500);
    save();
    return true;
  }

  function removeBlockedAuthor(name) {
    const key = normalizeAuthor(name).replace(/\s+/g, '').toLowerCase();
    const before = state.blockedAuthors.length;
    state.blockedAuthors = state.blockedAuthors.filter((b) => String(b).replace(/\s+/g, '').toLowerCase() !== key);
    if (state.blockedAuthors.length !== before) { save(); return true; }
    return false;
  }

  /** 诊断用：页面上所有标记的位置与归属，给弹窗看 */
  function debugMarkers() {
    const active = activeCard();
    const out = [];
    for (const marker of MARKERS) {
      let nodes = [];
      try { nodes = document.querySelectorAll(marker.sel); } catch (e) { nodes = []; }
      for (const el of nodes) {
        // 文本类标记只统计真正命中的元素，不然「span」会把整页都算进来
        if ((marker.text || marker.exactText) && !matchTextMarker(el, marker)) continue;
        const r = el.getBoundingClientRect();
        let card = null;
        try { card = el.closest('[data-e2e="feed-item"]'); } catch (e) { card = null; }
        out.push({
          kind: marker.kind,
          text: ownText(el).slice(0, 12),
          visible: visible(el),
          active: active ? card === active : null,
          w: Math.round(r.width),
          h: Math.round(r.height),
          top: Math.round(r.top)
        });
        if (out.length >= 8) break;
      }
      if (out.length >= 8) break;
    }
    return out;
  }

  // ───────────────────────── 定位视频与容器 ─────────────────────────

  function items() {
    return Array.from(document.querySelectorAll('[data-e2e="feed-item"]'));
  }

  function currentVid() {
    const box = document.querySelector('[data-e2e="feed-active-video"]');
    if (box) {
      const id = box.getAttribute('data-e2e-vid');
      if (id) return String(id);
    }
    const node = document.querySelector('[class*="video_"]');
    if (node) {
      const m = String(node.className || '').match(/video_(\d{6,})/);
      if (m) return m[1];
    }
    return '';
  }

  function currentItem() {
    const card = activeCard();
    if (card) return card;
    const list = items();
    if (!list.length) return null;
    const cy = (window.innerHeight || 0) / 2;
    let best = null;
    let bestDist = Infinity;
    for (const it of list) {
      const r = it.getBoundingClientRect();
      if (r.height < 50) continue;
      const dist = Math.abs(r.top + r.height / 2 - cy);
      if (dist < bestDist) { bestDist = dist; best = it; }
    }
    return best;
  }

  function nextItem() {
    const list = items();
    const cur = currentItem();
    if (cur) {
      const i = list.indexOf(cur);
      if (i >= 0 && list[i + 1]) return list[i + 1];
    }
    let best = null;
    let bestTop = Infinity;
    for (const it of list) {
      const r = it.getBoundingClientRect();
      if (r.top > 20 && r.top < bestTop) { bestTop = r.top; best = it; }
    }
    return best;
  }

  function findScroller() {
    for (const sel of ['.slidelist', '[data-e2e="slideList"]']) {
      const el = document.querySelector(sel);
      if (el && el.scrollHeight > el.clientHeight + 20) return el;
    }
    let best = null;
    for (const el of document.querySelectorAll('div, main, section')) {
      const ch = el.clientHeight;
      if (ch < 200) continue;
      if (el.scrollHeight > ch + 100 && (!best || ch > best.clientHeight)) best = el;
    }
    return best || null;
  }

  // ───────────────────────── 动作 ─────────────────────────

  function clickLike(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
      button: 0
    };
    try {
      if (typeof PointerEvent === 'function') {
        el.dispatchEvent(new PointerEvent('pointerover', base));
        el.dispatchEvent(new PointerEvent('pointerdown', base));
      }
      el.dispatchEvent(new MouseEvent('mousedown', base));
      if (typeof PointerEvent === 'function') el.dispatchEvent(new PointerEvent('pointerup', base));
      el.dispatchEvent(new MouseEvent('mouseup', base));
      // 只发这一个 click：再调一次 el.click() 会让页面的监听器收到两次点击，
      // 实测会把推荐流一次推两条（离线用例复现过），所以刻意不调 el.click()。
      el.dispatchEvent(new MouseEvent('click', base));
      return true;
    } catch (e) {
      return false;
    }
  }

  function nextArrow() {
    return (
      document.querySelector('[data-e2e="video-switch-next-arrow"]') ||
      document.querySelector('[data-e2e="video-switch-next"]') ||
      document.querySelector('.xgplayer-playswitch-next') ||
      null
    );
  }

  /** 把滚动容器精确推一条：优先对齐到下一条卡片的真实位置 */
  function skipByOneItem() {
    const sc = findScroller();
    if (!sc) return false;
    const before = sc.scrollTop;
    const h = sc.clientHeight || window.innerHeight || 800;
    // 兜底刻意多推 4px：正好落在两条卡片的边界上时，页面会当成「没翻页」，画面就卡住了
    let target = before + h + 4;
    const nxt = nextItem();
    if (nxt) {
      const scTop = sc.getBoundingClientRect().top;
      const delta = nxt.getBoundingClientRect().top - scTop;
      if (delta > 4 && delta < h * 3) target = before + delta;
    }
    try { sc.scrollTop = target; } catch (e) { /* ignore */ }
    nudgeScroll(sc);
    return sc.scrollTop !== before;
  }

  /** 给滚动容器补一个（合成的）scroll 事件：抖音的虚拟列表要靠它去渲染/挂上新卡片 */
  function nudgeScroll(sc) {
    try {
      if (sc) sc.dispatchEvent(new Event('scroll', { bubbles: true }));
      window.dispatchEvent(new Event('scroll'));
    } catch (e) { /* ignore */ }
  }

  /** 画面上还有没有一条像样的卡片 */
  function hasVisibleItem() {
    const vh = window.innerHeight || 800;
    for (const it of items()) {
      const r = it.getBoundingClientRect();
      if (r.height > 120 && r.bottom > 60 && r.top < vh - 60) return true;
    }
    return false;
  }

  /** 空白自救：一条都看不见就把内容滚回来一点 */
  function recoverIfBlank() {
    if (hasVisibleItem()) return false;
    const sc = findScroller();
    if (!sc) return false;
    const h = sc.clientHeight || window.innerHeight || 800;
    try { sc.scrollTop = Math.max(0, sc.scrollTop - h); } catch (e) { return false; }
    nudgeScroll(sc);
    log('检测到空白，已回滚一条');
    return true;
  }

  /** 当前这条卡片里的 video（找不到就退回页面上第一个 video） */
  function activeVideo() {
    try {
      const box = document.querySelector('[data-e2e="feed-active-video"]') || currentItem() || document;
      return box.querySelector('video') || document.querySelector('video');
    } catch (e) {
      return null;
    }
  }

  /**
   * 「跳完把播放救回来」——这是针对老师反馈的「跳过之后画面卡住」的关键补丁。
   * 程序化换页会让抖音的播放器停在 00:00（看起来就是卡住），所以换页后要在新卡片上
   *   ① 给滚动容器补发一次 scroll 事件   ② 对还没在播的视频显式 play()
   * 分三次延时做（350 / 1000 / 1800ms）：刚换页那一瞬间播放器常常还没挂上新的视频源，
   * 只做一次会漏掉。
   */
  function resumePlayback() {
    [350, 1000, 1800].forEach((delay) => {
      setTimeout(() => {
        nudgeScroll(findScroller());
        try {
          const v = activeVideo();
          if (v && (v.paused || v.currentTime < 0.05)) {
            const p = v.play();
            if (p && typeof p.catch === 'function') p.catch(() => { /* ignore */ });
          }
        } catch (e) { /* ignore */ }
      }, delay);
    });
  }

  /**
   * 把「当前这条」卡片对齐到滚动容器顶部。
   * 停在两条卡片之间也是「卡住」的一种表现：上一条露一半、下一条露一半，
   * 播放器不知道该放谁。只在「偏得不多」的时候修（超过 0.6 屏就不碰，
   * 免得反而把它整条跳过去）。
   */
  function alignActive() {
    const sc = findScroller();
    const card = currentItem();
    if (!sc || !card) return false;
    const h = sc.clientHeight || window.innerHeight || 800;
    const delta = Math.round(card.getBoundingClientRect().top - sc.getBoundingClientRect().top);
    if (Math.abs(delta) <= 4 || Math.abs(delta) > h * 0.6) return false;
    const before = sc.scrollTop;
    try { sc.scrollTop = before + delta; } catch (e) { return false; }
    if (sc.scrollTop === before) return false;
    nudgeScroll(sc);
    log('把当前卡片对齐：修正 ' + delta + 'px');
    return true;
  }

  function toast(text) {
    try {
      const id = 'dy-rect-skip-toast';
      let el = document.getElementById(id);
      if (!el) {
        el = document.createElement('div');
        el.id = id;
        el.style.cssText =
          'position:fixed;left:16px;bottom:16px;z-index:2147483647;padding:8px 14px;' +
          'border-radius:8px;background:rgba(17,18,22,.92);color:#fff;font:13px/1.5 sans-serif;' +
          'box-shadow:0 4px 16px rgba(0,0,0,.35);pointer-events:none;transition:opacity .3s';
        document.documentElement.appendChild(el);
      }
      el.textContent = text;
      el.style.opacity = '1';
      clearTimeout(el.__t);
      el.__t = setTimeout(() => { el.style.opacity = '0'; }, 1800);
    } catch (e) { /* ignore */ }
  }

  function save() {
    try {
      chrome.storage.local.set({
        enabled: state.enabled,
        total: state.total,
        today: state.today,
        date: state.date,
        lastReason: state.lastReason,
        blockedAuthors: state.blockedAuthors
      });
    } catch (e) { /* ignore */ }
  }

  function bump() {
    if (state.date !== dayKey()) { state.date = dayKey(); state.today = 0; }
    state.total += 1;
    state.today += 1;
  }

  function remember(vid) {
    if (!vid) return;
    state.seen.add(vid);
    if (state.seen.size > SEEN_MAX) {
      const first = state.seen.values().next();
      if (!first.done) state.seen.delete(first.value);
    }
  }

  function finish(step, before, confirmed) {
    resumePlayback();
    const after = currentVid();
    const changed = Boolean(confirmed || (after && before && after !== before));
    if (changed) {
      state.failStreak = 0;
      remember(before);   // 只有确认跳走了，才把这个视频记成「已处理」
      bump();
      toast('已跳过标记视频');
    } else {
      state.failStreak += 1;
    }
    state.lastAdvanceEnd = Date.now();
    state.lastReason = (changed ? '已跳到下一个' : '尝试跳转（未确认）') + ' · 手法 ' + step;
    log(state.lastReason);
    save();
  }

  /** 页面到底换没换页：视频 id 变了，或者当前卡片换成了另一个元素 */
  function pageMoved(beforeVid, beforeCard) {
    const vid = currentVid();
    if (vid && beforeVid && vid !== beforeVid) return true;
    const card = currentItem();
    return Boolean(card && beforeCard && card !== beforeCard);
  }

  /**
   * 一次跳转尝试：先点页面自己的箭头，没换再精确推一条。
   *
   * 两个关键细节（都是「跳过之后卡住」的成因）：
   *   ① 箭头点完要**多确认一次**再决定要不要推滚动容器。播放器换页是异步的，
   *      只等一次的话会在「页面其实已经跳了」的时候又推一条 → 一次跨两条、并且错位卡住。
   *   ② 无论用哪一招，跳完都要把播放救回来（补 scroll 事件 + play）并把卡片对齐。
   */
  function advance(reason) {
    const now = Date.now();
    if (!state.enabled) return 'off';
    if (now < state.pausedUntil) return 'paused';
    if (now - state.lastAdvanceAt < MIN_GAP_MS) return 'cooldown';

    state.attempts = state.attempts.filter((t) => now - t < 10000);
    if (state.attempts.length >= MAX_PER_10S) {
      state.pausedUntil = now + PAUSE_MS;
      state.attempts = [];
      toast('连续跳过太多，暂停一会儿');
      log('触发安全阀，暂停 ' + PAUSE_MS / 1000 + ' 秒');
      return 'safety';
    }
    if (state.failStreak >= FAIL_LIMIT) {
      state.pausedUntil = now + FAIL_PAUSE_MS;
      state.failStreak = 0;
      toast('连续几次没跳成功，先歇一会儿');
      log('连续失败，暂停 ' + FAIL_PAUSE_MS / 1000 + ' 秒');
      return 'failstop';
    }
    state.attempts.push(now);
    state.lastAdvanceAt = now;

    const before = currentVid();
    const beforeCard = currentItem();
    let step = '';

    const arrow = nextArrow();
    if (arrow) {
      clickLike(arrow);
      step = 'arrow';
    }

    const confirmThen = (attempt) => {
      if (pageMoved(before, beforeCard)) {
        // 页面自己跳成功了就不再推滚动容器
        finish(step || 'arrow', before, true);
        return;
      }
      if (step && attempt < 3) {
        setTimeout(() => confirmThen(attempt + 1), 300);
        return;
      }
      const moved = skipByOneItem();
      step += (step ? '+' : '') + (moved ? 'scroll' : 'scrollFailed');
      setTimeout(() => {
        if (!pageMoved(before, beforeCard) && !hasVisibleItem()) {
          if (recoverIfBlank()) step += '+recover';
        }
        finish(step, before, pageMoved(before, beforeCard));
      }, VERIFY_MS);
    };

    setTimeout(() => confirmThen(1), VERIFY_MS);
    return 'started';
  }

  // ───────────────────────── 检测循环 ─────────────────────────

  let timer = null;
  let observer = null;
  let observeQueued = false;

  function tick(force) {
    if (!state.enabled && !force) return null;
    if (!force && Date.now() - state.lastTriggerAt < TRIGGER_COOLDOWN_MS) return null;

    const hit = findMarker();
    if (!hit) return null;

    // 这个视频已经处理过了就不再动它（虚拟列表回收 DOM 也不会重复跳）
    const vid = currentVid();
    if (!force && vid && state.seen.has(vid)) return null;

    const how = advance(hit.kind);
    if (how === 'started') state.lastTriggerAt = Date.now();
    return { hit: hit.kind, how, vid };
  }

  /**
   * 跳转后的短窗口内盯着画面（与标记无关）：
   *   · 一条卡片都看不见 → 回滚一条把内容找回来（空白自救）
   *   · 有卡片但没对齐   → 对齐到卡片边界（"停在两条之间"也是卡住）
   * 视频停在 00:00 那种卡住由 resumePlayback 的三次延时负责救。
   */
  function settleWatch() {
    if (Date.now() - state.lastAdvanceEnd > RECOVER_WINDOW_MS) return;
    try {
      if (!hasVisibleItem()) {
        const sc = findScroller();
        if (sc) {
          const h = sc.clientHeight || window.innerHeight || 800;
          sc.scrollTop = Math.max(0, sc.scrollTop - h);
          nudgeScroll(sc);
          log('空白看守：已回滚一条');
        }
        return;
      }
      if (Date.now() - state.lastAdvanceEnd <= ALIGN_WINDOW_MS) alignActive();
    } catch (e) { /* ignore */ }
  }

  /** DOM 一变就尽快重检一次（节流），让「立刻」不依赖 250ms 的节拍 */
  function queueCheck() {
    if (observeQueued) return;
    observeQueued = true;
    setTimeout(() => {
      observeQueued = false;
      if (!state.enabled) return;
      try { tick(false); } catch (e) { /* ignore */ }
    }, OBSERVE_THROTTLE_MS);
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      try {
        settleWatch();
        tick(false);
        paintAuthorChip();
      } catch (e) { /* ignore */ }
    }, TICK_MS);

    try {
      observer = new MutationObserver(queueCheck);
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) { observer = null; }

    log('已启动，节拍 ' + TICK_MS + 'ms，最小间隔 ' + MIN_GAP_MS + 'ms，标记 ' + MARKERS.map((m) => m.kind).join(' / '));
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (observer) { try { observer.disconnect(); } catch (e) { /* ignore */ } observer = null; }
    unpaintAuthorChip();
  }

  // ───────────────────────── 页面内的"屏蔽这个作者"浮标 ─────────────────────────
  //
  // 老师不想每次都开弹窗手打名字，所以在当前视频旁边挂一枚小按钮：
  //   点它 = 把当前这条的作者加入黑名单；已经屏蔽过的显示成"已屏蔽"，再点取消。
  // 用完不干扰画面：极小、半透明、只在有作者名时出现。

  let chip = null;

  function chipId() { return 'dy-rect-skip-author-chip'; }

  function unpaintAuthorChip() {
    try {
      const el = document.getElementById(chipId());
      if (el && el.parentNode) el.parentNode.removeChild(el);
    } catch (e) { /* ignore */ }
    chip = null;
  }

  function paintAuthorChip() {
    if (!state.enabled) { unpaintAuthorChip(); return; }
    const author = currentAuthor();
    if (!author) { unpaintAuthorChip(); return; }
    const blocked = isBlockedAuthor(author);
    const label = (blocked ? '🚫 已屏蔽 ' : '⛔ 屏蔽 ') + '@' + author;

    try {
      let el = document.getElementById(chipId());
      if (!el) {
        el = document.createElement('div');
        el.id = chipId();
        el.style.cssText =
          'position:fixed;left:16px;top:50%;transform:translateY(-50%);z-index:2147483646;' +
          'padding:5px 10px;border-radius:14px;font:12px/1.4 system-ui,"Microsoft YaHei",sans-serif;' +
          'background:rgba(17,18,22,.62);color:#fff;cursor:pointer;user-select:none;' +
          'opacity:.28;transition:opacity .18s,background .18s;white-space:nowrap;max-width:46vw;' +
          'overflow:hidden;text-overflow:ellipsis';
        el.addEventListener('mouseenter', () => { el.style.opacity = '1'; });
        el.addEventListener('mouseleave', () => { el.style.opacity = '.28'; });
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          const now = currentAuthor();
          if (!now) return;
          if (isBlockedAuthor(now)) {
            removeBlockedAuthor(now);
            toast('已取消屏蔽：@' + now);
          } else {
            addBlockedAuthor(now);
            toast('已屏蔽作者：@' + now + '（以后刷到就跳过）');
          }
          paintAuthorChip();
        });
        document.documentElement.appendChild(el);
      }
      if (el.textContent !== label) el.textContent = label;
      el.style.background = blocked ? 'rgba(196,48,43,.72)' : 'rgba(17,18,22,.62)';
      chip = el;
    } catch (e) { /* ignore */ }
  }

  // ───────────────────────── 与弹窗通信 ─────────────────────────

  try {
    chrome.runtime.onMessage.addListener((msg, sender, reply) => {
      if (!msg || typeof msg !== 'object') return false;
      if (msg.type === 'state') {
        const hit = findMarker();
        reply({
          ok: true,
          enabled: state.enabled,
          total: state.total,
          today: state.today,
          lastReason: state.lastReason,
          marker: hit ? hit.kind : '',
          vid: currentVid(),
          author: currentAuthor(),
          blockedAuthors: state.blockedAuthors.slice(),
          paused: Date.now() < state.pausedUntil
        });
        return true;
      }
      if (msg.type === 'scan') {
        const res = tick(true);
        reply({
          ok: true,
          hit: res ? res.hit : '',
          how: res ? res.how : '',
          marker: findMarker() ? 'yes' : 'no',
          vid: currentVid(),
          detail: debugMarkers()
        });
        return true;
      }
      if (msg.type === 'recover') {
        const sc = findScroller();
        let done = false;
        if (sc) {
          const h = sc.clientHeight || window.innerHeight || 800;
          try { sc.scrollTop = Math.max(0, sc.scrollTop - h); done = true; } catch (e) { done = false; }
        }
        // 快捷键触发时没有弹窗可看，所以在页面上提示一下
        if (msg.silent !== true) toast(done ? '恢复画面：已回滚一条' : '恢复画面：没找到滚动容器');
        reply({ ok: true, recovered: done, vid: currentVid() });
        return true;
      }
      if (msg.type === 'toggle') {
        state.enabled = msg.enabled !== false;
        state.pausedUntil = 0;
        state.failStreak = 0;
        save();
        reply({ ok: true, enabled: state.enabled });
        return true;
      }
      if (msg.type === 'forget') {
        state.seen.clear();
        reply({ ok: true });
        return true;
      }
      if (msg.type === 'blockAuthor') {
        const name = msg.name ? normalizeAuthor(msg.name) : currentAuthor();
        const added = addBlockedAuthor(name);
        if (added) toast('已屏蔽作者：@' + normalizeAuthor(name));
        reply({ ok: true, added, name: normalizeAuthor(name), blockedAuthors: state.blockedAuthors.slice() });
        return true;
      }
      if (msg.type === 'unblockAuthor') {
        const removed = removeBlockedAuthor(msg.name || '');
        reply({ ok: true, removed, blockedAuthors: state.blockedAuthors.slice() });
        return true;
      }
      if (msg.type === 'clearAuthors') {
        state.blockedAuthors = [];
        save();
        reply({ ok: true, blockedAuthors: [] });
        return true;
      }
      if (msg.type === 'whoIs') {
        reply({ ok: true, author: currentAuthor(), vid: currentVid() });
        return true;
      }
      return false;
    });
  } catch (e) {
    log('消息通道注册失败：' + e);
  }

  // ───────────────────────── 启动 ─────────────────────────

  try {
    chrome.storage.local.get({ enabled: true, total: 0, today: 0, date: dayKey(), lastReason: '', blockedAuthors: [] }, (data) => {
      state.enabled = data.enabled !== false;
      state.total = Number(data.total) || 0;
      state.today = Number(data.today) || 0;
      state.date = data.date || dayKey();
      state.lastReason = data.lastReason || '';
      state.blockedAuthors = Array.isArray(data.blockedAuthors) ? data.blockedAuthors.slice() : [];
      if (state.date !== dayKey()) { state.date = dayKey(); state.today = 0; }
      start();
    });
  } catch (e) {
    start();
  }

  window.addEventListener('pagehide', stop, { once: true });
})();
