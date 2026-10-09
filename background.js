/**
 * 后台服务（MV3 service worker）
 *
 * 只负责一件事：把「恢复画面」的快捷键转给当前标签页里的内容脚本。
 *
 * 快捷键定义在 manifest.json 的 commands 里，默认 Ctrl+Shift+Z
 * （刻意不用 Ctrl+Z，避免和「抖音带货视频自动跳过」那个插件抢同一个键）。
 * 想换键位：
 *   ① 打开 chrome://extensions/shortcuts 直接改（不用重新加载扩展）
 *   ② 或者告诉爱丽丝想换成什么
 *
 * 注意：Chrome 的扩展快捷键必须是「修饰键 + 一个普通键」，
 * 单独一个 Alt / Ctrl 系统不允许注册。
 */

const RECOVER_COMMAND = 'recover-screen';

chrome.commands.onCommand.addListener((command) => {
  if (command !== RECOVER_COMMAND) return;

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || typeof tab.id !== 'number') return;

    chrome.tabs.sendMessage(tab.id, { type: 'recover' }, () => {
      // 当前页没装内容脚本（例如不是抖音）时会产生 lastError，读一下吞掉它
      if (chrome.runtime.lastError) { /* 忽略即可 */ }
    });
  });
});
