/**
 * 真机验证：面板在**真实浏览器**里的渲染与交互。
 *
 * 单测（`test/client-card.test.js`）走的是一个 React 替身：它执行真实的组件函数、断言真实的
 * 元素树与出站请求，但它**看不见渲染**。于是有一整类缺陷它能全绿而真机是坏的——`19` 的第一版
 * 正是如此：弹层的类名写成了 `.dtp-mask`，而那个名字已经属于密钥行里的掩码文本，结果
 * `position:fixed;inset:0` 也被套到每把密钥的掩码上，页面上凭空多出 N 层全屏黑遮罩，
 * 用户看到的是「批量添加之后卡在黑屏里，退出再进还是卡」。
 *
 * 这个脚本补上那一半：它用 CDP 驱动一个真实的 Chrome，在一个**真实运行的 DSH 实例**上把
 * 「设置 → 插件 → 展开卡片 → 批量添加」点一遍，然后检查浏览器里真正发生的事情：
 *
 * 1. **密钥掩码不得是 `position:fixed`**——那正是上面那个缺陷的形态；
 * 2. 弹层与对话框真的在视口里，且屏幕中心点落在对话框内部（而不是被什么盖住）；
 * 3. 关掉之后弹层从 DOM 里消失，页面上不多出任何全屏固定元素；
 * 4. 全程没有 console 异常——bundle 里一个语法错误就会在这里现形（单测用 `vm` 解析源码，
 *    但真机上「宿主投递的是哪一份」是另一回事）。
 *
 * 它需要一台跑着的 `dsh web` 与一个本机 Chrome，因此不属于 `npm test`：
 *
 *   DSH_HOME=/tmp/dsh-tavily-verify/home dsh web --port 3099   # 另开一台隔离实例
 *   node test/live/panel-browser-check.mjs --token-from /tmp/dsh-tavily-verify/probe-instance.log
 *
 * `--token` 也可以直接给；`--base` / `--cdp-port` / `--chrome` / `--keep-open` 见下。
 * 任一项检查失败即以非零码退出。它只读面板、不改密钥池：池里没有密钥时，掩码那条自动跳过。
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

/** 解析 `--flag value` 形式的参数，不引入参数解析库。 */
function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

const base = flag('base', 'http://127.0.0.1:3099');
const cdpPort = flag('cdp-port', '9223');
const chromePath = flag('chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const keepOpen = process.argv.includes('--keep-open');

/** 输出一条检查结果。 */
function check(label, detail) {
  process.stdout.write(`  ok   ${label}${detail === undefined ? '' : ` — ${detail}`}\n`);
}

/** 取访问令牌：直接给，或从 `dsh web` 的启动日志里读那一行 URL。 */
async function resolveToken() {
  const direct = flag('token');
  if (direct !== undefined) return direct;
  const logPath = flag('token-from');
  if (logPath === undefined) throw new Error('需要 --token <token> 或 --token-from <dsh web 的启动日志>');
  const log = await readFile(logPath, 'utf8');
  const match = /http:\/\/127\.0\.0\.1:\d+\/\?token=([A-Za-z0-9_-]+)/u.exec(log);
  if (match === null) throw new Error(`${logPath} 里没有带 token 的启动 URL`);
  return match[1];
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * 起一个 headless Chrome。
 *
 * `--no-sandbox` 是必需的而不是图省事：在受限环境里（例如 DSH 自己的文件沙箱）Chrome 的子进程
 * 沙箱初始化会失败并以 `Failed to initialize sandbox` 退出。这个页面只访问本机实例。
 */
function launchChrome() {
  const child = spawn(chromePath, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-gpu-sandbox',
    '--disable-crash-reporter',
    '--disable-dev-shm-usage',
    '--no-first-run',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${flag('profile-dir', '/tmp/dsh-tavily-browser-check')}`,
    '--window-size=1400,900',
    'about:blank',
  ], { stdio: 'ignore' });
  return child;
}

/** 等 CDP 就绪，返回页面的 WebSocket 地址。 */
async function waitForCdp() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
      const page = targets.find((target) => target.type === 'page');
      if (page !== undefined) return page.webSocketDebuggerUrl;
    } catch {
      // 还没起来
    }
    await sleep(250);
  }
  throw new Error(`CDP 在 ${cdpPort} 上没有就绪`);
}

/** 一个最小的 CDP 客户端：只用到 Runtime.evaluate 与 Page.captureScreenshot。 */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

  let nextId = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = (nextId += 1);
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  };
  return { ws, send, evaluate, errors };
}

/** 页面上一份体检报告。 */
const SNAPSHOT = `
(() => {
  const masks = [...document.querySelectorAll('.dtp-mask')];
  const overlay = document.querySelector('.dtp-overlay');
  const dialog = document.querySelector('.dtp-dialog');
  const rect = (element) => element.getBoundingClientRect();
  return {
    keyRows: document.querySelectorAll('.dtp-key').length,
    maskCount: masks.length,
    masksAllStatic: masks.every((element) => getComputedStyle(element).position !== 'fixed'),
    overlayExists: overlay !== null,
    overlayIsFullScreen: overlay !== null && rect(overlay).width >= innerWidth - 1 && rect(overlay).height >= innerHeight - 1,
    dialogExists: dialog !== null,
    dialogInViewport: dialog !== null && (() => { const r = rect(dialog); return r.width > 200 && r.height > 120 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth; })(),
    centerHitsDialog: dialog !== null && dialog.contains(document.elementFromPoint(innerWidth / 2, innerHeight / 2)),
    strayFullScreenFixed: [...document.querySelectorAll('body *')].filter((element) => {
      const r = rect(element);
      return getComputedStyle(element).position === 'fixed' && r.width >= innerWidth - 1 && r.height >= innerHeight - 1
        && !element.classList.contains('dtp-overlay');
    }).map((element) => element.tagName + '.' + String(element.className).slice(0, 32)),
  };
})()`;

const clickText = (text) => `(() => {
  const button = [...document.querySelectorAll('button')].find((node) => (node.textContent ?? '').trim() === ${JSON.stringify(text)});
  if (button === undefined) return false;
  button.click();
  return true;
})()`;

const token = await resolveToken();
const chrome = launchChrome();
let failure;
try {
  const client = await connect(await waitForCdp());
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Page.navigate', { url: `${base}/?token=${token}` });
  await sleep(2500);

  if (!await client.evaluate(clickText('设置'))) throw new Error('找不到「设置」入口');
  await sleep(900);
  if (!await client.evaluate(clickText('插件'))) throw new Error('找不到「插件」导航项');
  await sleep(900);
  await client.evaluate("(() => { document.querySelector('.dtp-header')?.click(); return true; })()");
  await sleep(900);
  check('卡片已展开', await client.evaluate("document.querySelector('.dtp-add') !== null ? '密钥池表单在' : '密钥池表单缺席'"));

  const closed = await client.evaluate(SNAPSHOT);
  if (closed.dialogExists) throw new Error('弹框在没点开时就渲染了');
  check('弹框未打开时页面上没有它', `密钥 ${String(closed.keyRows)} 把、掩码 ${String(closed.maskCount)} 个`);

  if (!await client.evaluate(clickText('批量添加'))) throw new Error('找不到「批量添加」按钮');
  await sleep(900);
  const open = await client.evaluate(SNAPSHOT);

  // 1. 全屏遮罩只有一个，且是弹层自己；密钥掩码必须留在文档流里。
  if (!open.overlayExists) throw new Error('弹层没有渲染出来（.dtp-overlay 不在 DOM 里）');
  if (!open.overlayIsFullScreen) throw new Error('弹层没有铺满视口——类名与 CSS 对不上时就会这样');
  if (!open.masksAllStatic) throw new Error('有密钥掩码变成了 fixed——类名冲突的典型症状');
  if (open.keyRows > 0) {
    if (open.maskCount !== open.keyRows) {
      throw new Error(`掩码数量与密钥行数不符：${String(open.maskCount)} vs ${String(open.keyRows)}`);
    }
    check('每把密钥的掩码都留在文档流里', `${String(open.maskCount)} 个掩码，全部 static`);
  } else {
    check('池里没有密钥，掩码检查跳过');
  }

  // 2. 对话框真的看得见：在视口内，且屏幕中心落在它里面。
  if (!open.dialogInViewport) throw new Error('对话框不在视口里');
  if (!open.centerHitsDialog) throw new Error('屏幕中心被别的东西盖住了——对话框点不到');
  check('对话框在视口内，且屏幕中心点落在它内部');

  // 3. 页面上不该多出别人的全屏固定元素（宿主自己的遮罩不算）。
  const stray = open.strayFullScreenFixed.filter((name) => name.startsWith('DIV.dtp'));
  if (stray.length > 0) throw new Error(`页面上有多余的全屏固定元素：${stray.join('、')}`);
  check('页面上没有多出来的全屏固定元素');

  // 4. 关掉之后弹层要真的消失——`19` 的缺陷正是「关掉之后仍然卡着」。
  if (!await client.evaluate(clickText('取消'))) throw new Error('找不到「取消」按钮');
  await sleep(700);
  const after = await client.evaluate(SNAPSHOT);
  if (after.overlayExists || after.dialogExists) throw new Error('取消之后弹层还在 DOM 里');
  if (!after.masksAllStatic) throw new Error('取消之后密钥掩码变成了 fixed');
  check('取消之后弹层消失，密钥掩码仍然留在文档流里');

  // 5. 再打开一次：用户报的正是「退出再进还是卡」。
  if (!await client.evaluate(clickText('批量添加'))) throw new Error('第二次找不到「批量添加」按钮');
  await sleep(700);
  const again = await client.evaluate(SNAPSHOT);
  if (!again.dialogInViewport || !again.centerHitsDialog) throw new Error('第二次打开时对话框不可见');
  check('再次打开弹框同样正常');

  if (client.errors.length > 0) throw new Error(`页面报了异常：${client.errors.join(' | ')}`);
  check('全程没有 console 异常');

  process.stdout.write('panel-browser-check: 全部真机检查通过\n');
} catch (error) {
  failure = error;
  process.stdout.write(`panel-browser-check: 失败 — ${String(error?.message ?? error)}\n`);
} finally {
  if (!keepOpen) {
    chrome.kill('SIGKILL');
  }
}

if (failure !== undefined) process.exit(1);
process.exit(0);
