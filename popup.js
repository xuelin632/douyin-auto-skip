/* 抖音标记视频自动跳过（30x16/购物） —— 弹窗逻辑 */

const $ = (id) => document.getElementById(id);

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

/** 问当前标签页的内容脚本要状态；不在抖音页会失败，这里给出提示 */
function ask(message) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        if (!tab || !tab.id) return resolve({ ok: false, error: 'no-tab' });
        chrome.tabs.sendMessage(tab.id, message, (res) => {
          if (chrome.runtime.lastError) {
            return resolve({ ok: false, error: 'no-content' });
          }
          resolve(res || { ok: false, error: 'empty' });
        });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });
}

function render(res) {
  if (!res || !res.ok) {
    setText('marker', '读不到');
    $('reason').textContent = '上次动作：读不到页面，请确认当前标签页是抖音的推荐页，并刷新一次。';
    return;
  }
  $('enabled').checked = res.enabled !== false;
  setText('today', String(res.today || 0));
  setText('total', String(res.total || 0));
  setText('vid', res.vid ? String(res.vid) : '-');
  setText('marker', res.marker ? '出现（' + res.marker + '）' : '未出现');
  $('reason').textContent = '上次动作：' + (res.lastReason || '-') + (res.paused ? '（安全阀暂停中）' : '');
}

async function refresh() {
  const res = await ask({ type: 'state' });
  render(res);
}

$('enabled').addEventListener('change', async (e) => {
  await ask({ type: 'toggle', enabled: e.target.checked });
  refresh();
});

$('scan').addEventListener('click', async () => {
  $('reason').textContent = '正在检查…';
  const res = await ask({ type: 'scan' });
  if (res && res.ok) {
    if (res.hit) {
      $('reason').textContent = '检测到标记（' + res.hit + '），跳转动作：' + (res.how || '-');
    } else {
      const detail = Array.isArray(res.detail) ? res.detail : [];
      const tip = '识别两种标记：rect 30x16 rx2，或 div.gwmKU4Jo 里的「购物」。';
      if (detail.length) {
        const kinds = detail.map((d) => (d.kind || '?') + (d.active === false ? '(不在当前这条)' : '')).join('、');
        $('reason').textContent = tip + ' 页面上有 ' + detail.length + ' 个：' + kinds;
      } else {
        $('reason').textContent = tip + ' 当前画面上都没有出现。';
      }
    }
  } else {
    $('reason').textContent = '读不到页面，请刷新抖音页面后重试。';
  }
  refresh();
});

$('recover').addEventListener('click', async () => {
  $('reason').textContent = '正在尝试把画面滚回来…';
  const res = await ask({ type: 'recover' });
  $('reason').textContent = res && res.ok && res.recovered
    ? '已回滚一条，看看画面回来没有'
    : '读不到页面，请刷新抖音页面后重试。';
  refresh();
});

$('reset').addEventListener('click', async () => {
  try {
    await chrome.storage.local.set({ total: 0, today: 0 });
    await ask({ type: 'forget' });
  } catch (e) { /* ignore */ }
  refresh();
});

refresh();
