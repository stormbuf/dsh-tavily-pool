/**
 * 零构建卡片（`PANEL-1`、`PANEL-2`、`PANEL-3`、`PANEL-5`、`PANEL-6`）。
 *
 * `lib/client.js` 是一份**脚本**而不是模块：它在加载时读 `window.__ModuleLoader__` 并注册
 * 一个 bundle 工厂，因此这里既不能 `import` 它，也不能真的启动一个浏览器。做法是用
 * `node:vm` 给它一个最小的 `window`，把注册下来的工厂**真的执行一遍**，再让 `apply()`
 * 在一个假的浏览器 context 上跑。被检验的因此是真实的那份代码：
 *
 * - 注册形态（id、工厂、只点种子表里的模块）——`PANEL-2`；
 * - slot 契约（名字、`key`、`locale`）——`PANEL-1`，且 `key` 必须与命名空间逐字相同；
 * - 组件真的能渲染出卡片，且中英两套词表都齐全——`PANEL-3`、`PANEL-5`；
 * - 余额未知时显示「未知」而不是 0%——`PANEL-6`。
 *
 * 用一个自制的 React 替身而不是真的 React：本仓库的 `dependencies` 必须为空（`DOC-1` 的
 * Gherkin 场景），而 `react` 只在浏览器那边由宿主提供。替身只实现卡片用到的那几个 hook，
 * 并把元素树原样返回——于是「渲染出什么」可以被直接断言，而这正是本文件的目的。
 *
 * 渲染用例一律显式传入 `t`：宿主按 `locale: NS` 绑定的翻译函数就是这样传进来的。自带
 * 自带词表那条路另有专门的用例（它取决于 `navigator`，因此要把它注进沙箱）。
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test, { describe } from 'node:test';
import vm from 'node:vm';

import {
  ADVANCED_EXTRACT_CREDITS_PER_FIVE,
  BASIC_EXTRACT_CREDITS_PER_FIVE,
  EXTRACT_DEPTH_VALUES,
  EXTRACT_FORMAT_VALUES,
  EXTRACT_URLS_PER_CREDIT_TIER,
  PACKAGE_NAME,
  PLUGIN_ID,
  USAGE_QUOTA_MAX_CALLS,
  USAGE_QUOTA_WINDOW_MS,
} from '../lib/constants.js';
import {
  MAX_RESULTS_MAX,
  MAX_RESULTS_MIN,
  SCHEDULING_POLICY_VALUES,
  SEARCH_DEPTH_VALUES,
  TOPIC_VALUES,
} from '../lib/settings.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_FILE = join(repoRoot, 'lib/client.js');

/**
 * 宿主浏览器半边提供的种子模块表。
 *
 * 照抄 `dsh-web-frontend` 的 `PLATFORM_MODULES`（`dsh-client-modules` 的 README 称之为
 * 「冻结的模块表」）。`PANEL-2` 要求本 bundle 只点这张表里的键，而这张表就是判据——
 * 抄一份到测试里，是为了让「宿主换了种子表」与「我们点了一个表外的键」这两种失败都能被
 * 抓住。
 */
const SEED_MODULES = Object.freeze([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]);

/**
 * 宿主原语的替身：把收到的属性与子节点原样记进元素树。
 *
 * 三个都要有——缺了 `Tag` 或那个箭头，`h(undefined, ...)` 会造出一个 `type` 为 undefined
 * 的元素，于是「未保存标记」这类断言会因为替身不全而失败，而不是因为卡片没渲染它。
 */
function primitiveStub(name) {
  return (props, ...children) => ({ type: name, props: props ?? {}, children: children.flat(Infinity) });
}

const switchStub = primitiveStub('Switch');

/**
 * 一个够用的 React 替身。
 *
 * `useState` 按**调用次序**返回预设值：卡片刻意只用两个 `useState`（瞬时状态与草稿），
 * 因此这里的次序是稳定的、可读的。`useEffect` 只收集不执行——首次加载会去 `fetch`，而
 * 本文件要断言的是「进入某个状态之后渲染成什么样」，不是网络行为。
 *
 * setter 把收到的更新记进 `updates`：卡片用它们做瞬时反馈（「已添加 N 把密钥」这类提示
 * 只存在于 `patch` 的结果里，不重渲染就看不见）。记下来之后，那些反馈也能被断言。
 *
 * @param options - 预设的 hook 值。
 * @param options.ui - 第一次 `useState` 的返回值。
 * @param options.draft - 第二次 `useState` 的返回值。
 * @returns `{ react, effects, updates }`。
 */
function reactStub({ ui, draft } = {}) {
  const queue = [ui, draft];
  const effects = [];
  const updates = [];
  let index = 0;
  return {
    effects,
    updates,
    react: {
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
      Fragment: Symbol('react.fragment'),
      useState: (initial) => {
        const slot = index;
        index += 1;
        return [
          slot < queue.length && queue[slot] !== undefined ? queue[slot] : initial,
          (next) => updates.push({ slot, next }),
        ];
      },
      useEffect: (effect) => {
        effects.push(effect);
      },
    },
  };
}

/**
 * 把一次 hook setter 收到的更新套到一份基准状态上。
 *
 * `patch` 走的是函数式更新（`setUi((current) => ...)`），因此要看它想写进去的值，只能把它
 * 自己那份基准交给它。
 *
 * @param update - `reactStub` 记下的 `{ slot, next }`。
 * @param base - 该 hook 当前的返回値。
 * @returns 更新后的状态。
 */
function applied(update, base) {
  return typeof update.next === 'function' ? update.next(base) : update.next;
}

/**
 * 把某一次动作里全部 hook 更新按序套到基准状态上。
 *
 * 一次动作会分几次 `patch`（开始、结果、收尾），只看最后一条会漏掉中间那条真正写进
 * 提示的更新。
 *
 * @param updates - `reactStub` 记下的更新。
 * @param base - 动作开始前的瞬时状态。
 * @returns 动作结束后的瞬时状态。
 */
function uiAfter(updates, base) {
  return updates
    .filter((update) => update.slot === 0)
    .reduce((state, update) => applied(update, state), base);
}

/** 让 vm 里那条 async 链跑完：它的每一个 `await` 都落在已兑现的 promise 上。 */
async function flush() {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

/**
 * 弹框用例需要的 `document` 替身（`POOL-8`）。
 *
 * `querySelector` 返回一个非 null 值，是为了让模块体的样式注入那一步直接跳过：本文件检验
 * 的是渲染出什么，不是样式标签怎么挂。`body` 是 portal 的落点，`listeners` 记下挂在
 * document 上的按键监听器——Esc 那条路径只有真的执行 effect 才谈得上被检验。
 *
 * @returns 替身；`listeners` 按事件名索引。
 */
function documentStub() {
  const listeners = new Map();
  return {
    body: { tag: 'body' },
    querySelector: () => ({}),
    addEventListener: (type, handler) => listeners.set(type, handler),
    removeEventListener: (type) => listeners.delete(type),
    listeners,
  };
}

/** `createPortal` 的替身：把挂载点也记进元素树，于是「弹层挂在 body 上」可断言。 */
function portalStub(children, container) {
  return { type: 'portal', props: { container }, children: [children].flat(Infinity) };
}

/**
 * 在 `node:vm` 里执行 `lib/client.js`，取回它注册的 bundle。
 *
 * 沙箱里的全局对象就是这份 bundle 的全局对象——因此 `navigator` 注不注入，直接决定了卡片
 * 拿不到宿主 `t` 时会选哪套词表，而那正是「自带词表」用例要控制的东西。
 *
 * @param globals - 额外注入的沙箱全局。
 * @returns `{ registration, source }`。
 */
async function loadBundle(globals = {}) {
  const source = await readFile(CLIENT_FILE, 'utf8');
  const registrations = [];
  const sandbox = {
    window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) } },
    console,
    ...globals,
  };
  vm.createContext(sandbox);
  new vm.Script(source, { filename: 'lib/client.js' }).runInContext(sandbox);
  assert.equal(registrations.length, 1, '一个 bundle 只该注册一次');
  return { registration: registrations[0], source };
}

/**
 * 执行工厂，并记录它点过哪些模块。
 *
 * `require` 对种子表之外的键**抛错**：这正是「无未命中种子表的模块请求」那条验收的判据。
 *
 * @param registration - `__ModuleLoader__.load` 收到的注册对象。
 * @param options - 覆盖项。
 * @returns `{ exports, requested, effects }`。
 */
function instantiate(registration, options = {}) {
  const requested = [];
  const { react, effects, updates } = reactStub(options.hooks);
  const modules = {
    react,
    'react-dom': { createPortal: portalStub },
    '@deepseek-ai/dsh-client-ui-primitives': {
      Switch: switchStub,
      Tag: primitiveStub('Tag'),
      IconChevronDownOutline14: primitiveStub('IconChevronDownOutline14'),
    },
  };
  const require = (specifier) => {
    requested.push(specifier);
    if (!SEED_MODULES.includes(specifier)) {
      throw new Error(`client-modules: module request outside the platform seed table: ${specifier}`);
    }
    return modules[specifier];
  };
  return { exports: registration.factory(require), requested, effects, updates };
}

/**
 * 在一个假的浏览器 context 上跑 `apply()`，把注册下来的卡片取出来。
 *
 * @param exports - 工厂导出的 `apply` / `inject`。
 * @returns `{ inject, dictionaries, options, component }`。
 */
function mountCard(exports) {
  const dictionaries = [];
  const slots = [];
  const ctx = {
    effect: (fn) => {
      fn();
    },
    locale: {
      register: (ns, dictionary) => {
        dictionaries.push({ ns, dictionary });
        return () => undefined;
      },
    },
    slots: {
      inject: (name, register) => {
        assert.equal(name, 'plugins.row.config');
        register();
        return () => undefined;
      },
      register: (options, component) => {
        slots.push({ options, component });
        return () => undefined;
      },
    },
  };
  exports.apply(ctx);
  assert.equal(slots.length, 1, '只注册一张卡片');
  return { inject: exports.inject, dictionaries, ...slots[0] };
}

/** 从已注册的词表里取一个翻译函数，与宿主按 `locale: NS` 绑定的那个同形。 */
function tOf(dictionaries, locale = 'zh') {
  const table = dictionaries[0].dictionary[locale];
  return (key, values) => {
    const template = table[key] ?? key;
    if (values === undefined || values === null) return template;
    return template.replace(/\{(\w+)\}/gu, (whole, name) => (Object.hasOwn(values, name) ? String(values[name]) : whole));
  };
}

/**
 * 装载并挂载卡片，返回渲染它所需的一切。
 *
 * @param options - 覆盖项。
 * @param options.hooks - 预设的 hook 值。
 * @param options.globals - 额外注入的沙箱全局。
 * @param options.locale - 传给 `tOf` 的语言。
 * @returns `{ component, t, dictionaries, options, inject }`。
 */
async function mountedCard(options = {}) {
  const { registration } = await loadBundle(options.globals);
  const instantiated = instantiate(registration, { hooks: options.hooks });
  const mounted = mountCard(instantiated.exports);
  return {
    ...mounted,
    t: tOf(mounted.dictionaries, options.locale ?? 'zh'),
    updates: instantiated.updates,
    effects: instantiated.effects,
  };
}

/** 服务端状态的一份样本，字段与 `lib/panel.js` 的投影一一对应。 */
function sampleState(overrides = {}) {
  return {
    settings: {
      searchEnabled: true,
      fetchEnabled: true,
      searchDepth: 'basic',
      maxResults: 10,
      topic: 'general',
      includeAnswer: false,
      fetchDepth: 'basic',
      fetchFormat: 'markdown',
      schedulingPolicy: 'balance',
    },
    history: { entries: [], daily: [], error: null },
    keys: [],
    poolError: null,
    capabilities: { ok: true, missingRequired: [], missingOptional: [], summary: 'all present', findings: [] },
    fallback: {
      target: 'deepseek-official',
      credential: 'configured',
      credentialSource: 'probe',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      reason: null,
      lastFailureAt: null,
    },
    ...overrides,
  };
}

/** 一份「已就绪」的瞬时状态。 */
function readyUi(stateOverrides = {}) {
  return {
    phase: 'ready',
    state: sampleState(stateOverrides),
    error: null,
    busy: null,
    notice: null,
    tests: {},
    confirming: null,
    renaming: null,
    renameText: '',
    newKey: '',
    newLabel: '',
    batchOpen: false,
    batchText: '',
    // 渲染用例一律以**展开**态断言主体内容；收起态另有专门的用例。
    expanded: true,
  };
}

/** 与 {@link readyUi} 相同，但卡片处于收起态（即首次渲染时的默认态）。 */
function collapsedUi(stateOverrides = {}) {
  return { ...readyUi(stateOverrides), expanded: false };
}

/** 与 `sampleState().settings` 一致的草稿。 */
function readyDraft() {
  return {
    searchEnabled: true,
    fetchEnabled: true,
    searchDepth: 'basic',
    maxResults: '10',
    topic: 'general',
    includeAnswer: false,
    fetchDepth: 'basic',
    fetchFormat: 'markdown',
    schedulingPolicy: 'balance',
  };
}

/** 一条脱敏后的密钥记录。 */
function keyRecord(overrides = {}) {
  return {
    id: 'key-1',
    masked: 'tvly-dev-…iJWq',
    label: 'primary',
    addedAt: '2026-09-19T00:00:00.000Z',
    disabled: false,
    stats: { calls: 2, successes: 1, failures: 1 },
    usage: undefined,
    ...overrides,
  };
}

/** 把一棵元素树摊平成元素数组，便于按类型与属性断言。 */
function flatten(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out);
    return out;
  }
  if (typeof node === 'object' && typeof node.type !== 'undefined') {
    out.push(node);
    for (const child of node.children ?? []) flatten(child, out);
  }
  return out;
}

/** 摊平之后所有字符串文本。 */
function textsOf(tree) {
  const out = [];
  const walk = (node) => {
    if (typeof node === 'string' || typeof node === 'number') {
      out.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node !== null && typeof node === 'object' && typeof node.type !== 'undefined') {
      for (const child of node.children ?? []) walk(child);
    }
  };
  walk(tree);
  return out;
}

/** 按文本找一个按钮。 */
function buttonWithText(tree, text) {
  return flatten(tree).find((element) => element.type === 'button' && textsOf(element).includes(text));
}

describe('PANEL-2：零构建产物可被加载', () => {
  test('外壳是 __ModuleLoader__.load，id 是包名', async () => {
    const { registration } = await loadBundle();
    assert.equal(registration.id, 'dsh-tavily-pool');
    assert.equal(typeof registration.factory, 'function');
  });

  test('工厂只 request 种子表里的模块，且一个都不多', async () => {
    const { registration } = await loadBundle();
    const { requested, exports } = instantiate(registration);

    // 三个：`react`、`react-dom`（批量添加的弹层用 `createPortal`）、`primitives`（开关与
    // 展开箭头）。多一个键就多一处随宿主漂移的面。
    assert.deepEqual(requested, ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives']);
    for (const specifier of requested) {
      assert.equal(SEED_MODULES.includes(specifier), true, `${specifier} 不在种子表里`);
    }
    assert.equal(typeof exports.apply, 'function');
  });

  test('钉住的种子表本身是 9 个键——宿主换了表，这条会红', () => {
    // 这条守的是「我们抄的那张表」：宿主删掉一个种子键时，上面那条 request 断言仍然会过
    // （我们只点两个键），但那张表已经不是当初核验过的那张了。
    assert.equal(SEED_MODULES.length, 9);
  });

  test('没有 JSX，也不需要任何转译', async () => {
    // 零构建的字面含义就是「原样投给浏览器」。`vm.Script` 已经证明它能被直接解析；这条
    // 额外盯住 JSX 的典型形态，免得将来有人顺手写上一段。
    const { source } = await loadBundle();
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
    assert.equal(/<[A-Za-z][^>]*>/u.test(withoutComments), false, '不得出现 JSX');
    assert.match(source, /window\.__ModuleLoader__\.load\(/u);
  });

  test('样式注入带 data-plugin-css，且在没有 document 时不抛', async () => {
    // 本文件本身就是在一个没有 document 的环境里被加载的（上面的 loadBundle 就是这样做的），
    // 因此这条守卫同时证明了「零构建产物可被加载」与「宿主能按 data-plugin-css 记账」。
    const { source } = await loadBundle();
    assert.match(source, /typeof document !== 'undefined'/u);
    assert.match(source, /tag\.dataset\.pluginCss = 'dsh-tavily-pool\/card'/u);
  });

  test('CSS 里没有重复的选择器：重名会让后一条悄悄改掉前一条的样式', async () => {
    // `19` 的第一版把弹层类名写成了 `.dtp-mask`——那已经是密钥行里掩码文本的类名
    // （`.dtp-mask{font-family:ui-monospace…}`）。于是 `position:fixed;inset:0` 也被套到每把
    // 密钥的掩码上：真机上每把密钥都变成一层全屏黑遮罩，页面被压暗、点击被吞，弹框关掉之后
    // 依然卡着。本文件看不见渲染，但「同一个选择器写了两遍」这件事在这里就能被抓住。
    const { source } = await loadBundle();
    const selectors = cssSelectors(source);
    const seen = new Set();
    const duplicates = selectors.filter((selector) => {
      if (seen.has(selector)) return true;
      seen.add(selector);
      return false;
    });

    assert.deepEqual(duplicates, [], `这些选择器写了两遍：${duplicates.join('、')}`);
  });

  test('JS 里用到的每一个 dtp- 类名都在 CSS 里有定义', async () => {
    // 反过来守一遍：改了类名却漏改另一边时，元素会静默地退回无样式（`19` 修重名时就要求
    // 两边一起改）。模板字符串拼出来的类名扫不到，因此这条只覆盖字面量——漏检是安全的，
    // 误报才不是。
    const { source } = await loadBundle();
    const defined = new Set(
      cssSelectors(source)
        .flatMap((selector) => selector.split(/[\s>+~]+/u))
        .map((part) => part.replace(/^\./u, '').split(':')[0])
        .filter((name) => name.startsWith('dtp-')),
    );
    const used = new Set();
    for (const match of source.matchAll(/className: '([^']*)'/gu)) {
      for (const name of match[1].split(' ')) if (name.startsWith('dtp-')) used.add(name);
    }
    assert.notEqual(used.size, 0, '一个类名都没扫到，说明扫描规则已经与源码脱节');

    const missing = [...used].filter((name) => !defined.has(name));
    assert.deepEqual(missing, [], `这些类名没有对应的 CSS：${missing.join('、')}`);
  });
});

/**
 * 从 bundle 源码里取出 `CSS` 常量里的全部选择器（已去掉注释、拆开选择器组）。
 *
 * @param source - `lib/client.js` 的源码。
 * @returns 选择器字符串数组。
 */
function cssSelectors(source) {
  const css = /const CSS = `([\s\S]*?)`\.trim\(\);/u.exec(source)[1];
  return [...css.replaceAll(/\/\*[\s\S]*?\*\//gu, '').matchAll(/([^{}]+)\{/gu)]
    .flatMap((match) => match[1].split(',').map((part) => part.trim()))
    .filter((selector) => selector.length > 0);
}

describe('PANEL-1：卡片注册进 plugins.row.config', () => {
  test('slot 名、key、locale 三者配对', async () => {
    const { inject, options } = await mountedCard();

    // 展开成调用方这一侧的数组再比：工厂是在 `vm` 里创建的，它返回的数组带的是那个
    // realm 的原型，`deepStrictEqual` 会因此判不等——那是 realm 的差异，不是内容的差异。
    assert.deepEqual([...inject], ['slots', 'locale']);
    assert.equal(
      options.name,
      'plugins.row.config',
      '0.1.7 起插件配置页挂在 Plugins 页的行详情上；注册到不存在的 slot 不会报错，卡片只是永不渲染',
    );
    assert.equal(
      options.key,
      `${PACKAGE_NAME}#${PLUGIN_ID}`,
      'key 是 <包名>#<行 id>；不一致时卡片不会被派发，而且没有任何报错',
    );
    assert.equal(options.locale, PACKAGE_NAME, 'locale 仍是本插件的词表命名空间');
  });

  test('注册的是中英两套词表（PANEL-5）', async () => {
    const { dictionaries } = await mountedCard();

    assert.equal(dictionaries.length, 1);
    assert.equal(dictionaries[0].ns, PACKAGE_NAME);
    assert.deepEqual(Object.keys(dictionaries[0].dictionary).sort(), ['en', 'zh']);
  });

  test('两套词表的键集完全相同', async () => {
    // 一边加了键、另一边忘了加，症状是英文界面出现一个中文键名——最难发现的那类不一致，
    // 因为它只在切换语言之后才看得见。
    const { dictionaries } = await mountedCard();
    const { zh, en } = dictionaries[0].dictionary;

    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  });

  test('源码里用到的每一个 t() 键都在两套词表里', async () => {
    // 反过来也要守：组件里写了一个词表没有的键，界面会显示那个键名本身。
    const { dictionaries } = await mountedCard();
    const { zh, en } = dictionaries[0].dictionary;
    const source = await readFile(CLIENT_FILE, 'utf8');

    const used = new Set();
    for (const match of source.matchAll(/\bt\('([A-Za-z][A-Za-z0-9]*)'/gu)) used.add(match[1]);
    assert.notEqual(used.size, 0, '一个 t() 调用都没扫到，说明扫描规则已经与源码脱节');

    for (const key of used) {
      assert.equal(key in zh, true, `中文词表缺少 ${key}`);
      assert.equal(key in en, true, `英文词表缺少 ${key}`);
    }
  });
});

describe('PANEL-2、PANEL-3：卡片自绘控件，只复用已核实的基础组件', () => {
  test('开关用种子模块里的 Switch——两个接管开关与「生成答案」各一个', async () => {
    const { component, t } = await mountedCard({ hooks: { ui: readyUi(), draft: readyDraft() } });

    const switches = flatten(component({ t })).filter((element) => element.type === switchStub);
    assert.deepEqual(switches.map((element) => element.props.checked), [true, true, false]);
  });

  test('表单字段与列表控件都是自绘的（input / select / button / ul / li）', async () => {
    const { component, t } = await mountedCard({
      hooks: { ui: readyUi({ keys: [keyRecord()] }), draft: readyDraft() },
    });
    const types = new Set(flatten(component({ t })).map((element) => element.type));

    for (const tag of ['li', 'input', 'select', 'button', 'ul']) {
      assert.equal(types.has(tag), true, `卡片应当自绘 <${tag}>`);
    }
  });

  test('卡片外壳是 li：这一页把卡片渲染进 ul，内置卡片返回的也是 li', async () => {
    const { component, t } = await mountedCard({ hooks: { ui: readyUi(), draft: readyDraft() } });

    const shell = flatten(component({ t }))[0];
    assert.equal(shell.type, 'li');
    assert.match(shell.props.className, /dtp-card/u);
  });

  test('池里有密钥时渲染成列表项', async () => {
    const { component, t } = await mountedCard({
      hooks: { ui: readyUi({ keys: [keyRecord()] }), draft: readyDraft() },
    });

    // 卡片外壳本身也是一个 `li`，因此按类名断言**密钥行**，而不是数 `li` 的个数。
    assert.equal(
      flatten(component({ t })).filter((element) => element.props?.className === 'dtp-key').length,
      1,
    );
  });

  test('不引用宿主未导出的表单原语', async () => {
    // `ValueField` / `SecretField` 是内置设置插件**模块内的私有实现**，第三方 require
    // 不到；引用了它们的卡片在真实宿主上会以模块解析失败告终。
    //
    // 扫描前先去掉注释：本文件的开头正是用这几个名字说明「为什么不能引用它们」，把注释
    // 一起扫进去只会得到一条自指的假失败。
    const source = await readFile(CLIENT_FILE, 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
    for (const forbidden of ['ValueField', 'SecretField', 'PluginCard', 'dsh-client-ui-settings']) {
      assert.equal(code.includes(forbidden), false, `不得引用 ${forbidden}`);
    }
  });

  test('只从 primitives 取用已核实的那三个组件', async () => {
    // `PANEL-3` 明文点名的三个：`Switch`（开关）、`Tag`（未保存标记）、
    // `IconChevronDownOutline14`（卡片的展开箭头，宿主自己的卡片用的就是它）。
    // 换成别的宿主原语必须先确认它在种子表里，因此这条清单是白名单而不是随口一列。
    const source = await readFile(CLIENT_FILE, 'utf8');
    const used = new Set();
    for (const match of source.matchAll(/primitives\.([A-Za-z][A-Za-z0-9]*)/gu)) used.add(match[1]);
    assert.deepEqual([...used].sort(), ['IconChevronDownOutline14', 'Switch', 'Tag']);
  });
});

describe('POOL-8：批量添加', () => {
  /** 一个记录请求的 fetch 替身：`keys` 路由回一份带 `summary` 的结果，其余当状态读。 */
  function fetchStub(calls, summary) {
    return async (path, options = {}) => {
      calls.push({ path, body: options.body === undefined ? undefined : JSON.parse(options.body) });
      const payload = path === '/api/tavily-pool.keys' ? { keys: [], summary } : sampleState();
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    };
  }

  /** 粘进框里的那段文本：首尾有换行、中间有缩进、还夹着一个重复行。 */
  const PASTED = '\ntvly-dev-a\n  tvly-dev-b  \n\ntvly-dev-a';

  /** 弹框打开时的瞬时状态。 */
  function openUi(text = PASTED) {
    return { ...readyUi(), batchOpen: true, batchText: text };
  }

  /** 弹框里的按钮——按类名先定位弹框，免得撞上单把添加表单里那个同名的「添加」。 */
  function dialogButton(tree, text) {
    const dialog = flatten(tree).find((element) => element.props?.className === 'dtp-dialog');
    assert.notEqual(dialog, undefined, '弹框没有渲染出来');
    return flatten(dialog).find((element) => element.type === 'button' && textsOf(element).includes(text));
  }

  /**
   * 批量删除弹框打开时的瞬时状态。
   *
   * 默认池里有两条记录：勾选框的数量与 `ui.state.keys` 一一对应，空池下这条断言没有判据。
   *
   * @param picked - 已勾选的 id。
   * @param keys - 池内记录；默认两条。
   * @returns 一份瞬时状态。
   */
  function removeUi(picked = [], keys = [keyRecord({ id: 'key-1' }), keyRecord({ id: 'key-2', masked: 'tvly-dev-…B' })]) {
    return { ...readyUi({ keys }), removeOpen: true, removePicked: new Set(picked) };
  }

  /** 删除弹框里的按钮——按 `role=dialog` 先定位弹框，免得撞上别处的同名按钮。 */
  function removeDialogButton(tree, text) {
    const dialog = flatten(tree).find((element) => element.props?.['aria-label'] === '批量删除密钥');
    assert.notEqual(dialog, undefined, '删除弹框没有渲染出来');
    return flatten(dialog).find((element) => element.type === 'button' && textsOf(element).includes(text));
  }

  test('单把添加重复时说一句话：列表一行没变，否则看起来像加失败了（D1）', async () => {
    // 服务端在 `add` 上也查重（`POOL-9`）：重复时回 200 + `added: 0`。前端若只看 HTTP 状态，
    // 用户看到的是「输入框清了、列表没多一行」——那读起来像加失败，而不是「本来就有」。
    const calls = [];
    const addedAgain = async (path, options = {}) => {
      calls.push({ path, body: options.body === undefined ? undefined : JSON.parse(options.body) });
      const payload = path === '/api/tavily-pool.keys'
        ? { keys: [keyRecord()], summary: { received: 1, added: 0, duplicates: 1 } }
        : sampleState({ keys: [keyRecord()] });
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    };
    const { component, t, updates } = await mountedCard({
      globals: { fetch: addedAgain },
      hooks: { ui: { ...readyUi({ keys: [keyRecord()] }), newKey: 'tvly-dev-dup' }, draft: readyDraft() },
    });

    await buttonWithText(component({ t }), '添加').props.onClick();
    await flush();

    const post = calls.find((call) => call.path === '/api/tavily-pool.keys');
    assert.deepEqual(post.body, { action: 'add', key: 'tvly-dev-dup' });
    assert.equal(uiAfter(updates, readyUi()).notice, '这一把已经在池中了，没有新增。');

    // 对照：真的加进去时不留这句话（否则每次成功都会挂一句多余提示）。
    const fresh = [];
    const { component: okComponent, t: okT, updates: okUpdates } = await mountedCard({
      globals: {
        fetch: async (path, options = {}) => {
          fresh.push({ path, body: options.body === undefined ? undefined : JSON.parse(options.body) });
          const payload = path === '/api/tavily-pool.keys'
            ? { keys: [keyRecord()], summary: { received: 1, added: 1, duplicates: 0 } }
            : sampleState({ keys: [keyRecord()] });
          return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
        },
      },
      hooks: { ui: { ...readyUi(), newKey: 'tvly-dev-new' }, draft: readyDraft() },
    });
    await buttonWithText(okComponent({ t: okT }), '添加').props.onClick();
    await flush();
    assert.equal(uiAfter(okUpdates, readyUi()).notice, null);
  });

  test('读不到宿主绑定预算时给出提示，读到时一个字都不多说（F2）', async () => {
    // 「我们按哪个预算排布」在别处没有任何出口。读到了就不说——那是正常情况，说了只是噪音；
    // 读不到才要有人知道：那意味着宿主收紧 timeout 时我们仍按旧常量排布，而症状是「用户等到
    // 的是一条宿主超时，而不是上游的真实错误」。
    const silent = await mountedCard({
      hooks: {
        ui: readyUi({ hostBudget: { search: { budgetMs: 58_000, source: 'host', hostSource: 'host' } } }),
        draft: readyDraft(),
      },
    });
    assert.equal(
      textsOf(silent.component({ t: silent.t })).some((text) => text.includes('常量')),
      false,
      '读到宿主值时不该多说一句',
    );

    const warned = await mountedCard({
      hooks: {
        ui: readyUi({ hostBudget: { search: { budgetMs: 60_000, source: 'constant', hostSource: 'unavailable' } } }),
        draft: readyDraft(),
      },
    });
    assert.equal(
      textsOf(warned.component({ t: warned.t })).some((text) => text.includes('60000ms')),
      true,
      '退回常量时必须说出来，并带上那个数',
    );

    const never = await mountedCard({ hooks: { ui: readyUi({ hostBudget: null }), draft: readyDraft() } });
    assert.equal(
      textsOf(never.component({ t: never.t })).some((text) => text.includes('常量')),
      false,
      '一次都没搜过时没有任何观测，不该断言任何事',
    );
  });

  test('密钥池标题行给出批量删除入口，且一把密钥都没有时它是灰的', async () => {
    // `panel-http-4` 的出口是服务端的一半，这里是另一半：**没有入口的上限等于没有清理的路**。
    const { component, t } = await mountedCard({
      hooks: { ui: readyUi({ keys: [keyRecord()] }), draft: readyDraft() },
    });
    const withKeys = component({ t });
    const entry = buttonWithText(withKeys, '批量删除');
    assert.notEqual(entry, undefined, '标题行要有批量删除的入口');
    assert.equal(entry.props.disabled, false);

    const emptyCard = await mountedCard({ hooks: { ui: readyUi({ keys: [] }), draft: readyDraft() } });
    const empty = buttonWithText(emptyCard.component({ t: emptyCard.t }), '批量删除');
    assert.equal(empty.props.disabled, true, '池子空着时这个按钮没有意义');
  });

  test('确认之前一个勾都没打时，主按钮不可用——空提交不该发一趟请求', async () => {
    const { component, t } = await mountedCard({
      globals: { document: documentStub() },
      hooks: { ui: removeUi(), draft: readyDraft() },
    });

    assert.equal(removeDialogButton(component({ t }), '一把都没勾选').props.disabled, true);
  });

  test('确认把勾到的 id 发成 removeBatch：勾选集按 id 记，不按下标', async () => {
    const calls = [];
    const { component, t, updates } = await mountedCard({
      globals: {
        document: documentStub(),
        fetch: async (path, options = {}) => {
          calls.push({ path, body: options.body === undefined ? undefined : JSON.parse(options.body) });
          const payload = path === '/api/tavily-pool.keys'
            ? { keys: [], summary: { received: 2, removed: 2 } }
            : sampleState();
          return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
        },
      },
      hooks: { ui: removeUi(['key-1', 'key-2']), draft: readyDraft() },
    });

    await removeDialogButton(component({ t }), '删除所选').props.onClick();
    await flush();

    const post = calls.find((call) => call.path === '/api/tavily-pool.keys');
    assert.notEqual(post, undefined, '确认要经面板接口提交');
    assert.deepEqual(post.body, { action: 'removeBatch', ids: ['key-1', 'key-2'] });
    const ui = uiAfter(updates, removeUi(['key-1', 'key-2']));
    assert.equal(ui.removeOpen, false, '成功后弹框关闭');
    assert.equal(ui.removePicked.size, 0, '勾选一并清空，免得下次打开还留着上一轮的 id');
    assert.equal(ui.notice, '已删除 2 把密钥');
  });

  test('每一行是一个复选框，勾选状态来自 id 集合', async () => {
    const keys = [keyRecord({ id: 'key-1' }), keyRecord({ id: 'key-2', masked: 'tvly-dev-…B' })];
    const { component, t } = await mountedCard({
      globals: { document: documentStub() },
      hooks: { ui: removeUi(['key-2']), draft: readyDraft() },
    });

    const dialog = flatten(component({ t }))
      .find((element) => element.props?.['aria-label'] === '批量删除密钥');
    const boxes = flatten(dialog).filter((element) => element.type === 'input');
    assert.equal(boxes.length, keys.length, '池里有几把就画几个复选框');
    assert.deepEqual(boxes.map((box) => box.props.checked), [false, true]);
  });

  test('提交中整框禁用：删除不可撤销，不能在飞的时候改选', async () => {
    const { component, t } = await mountedCard({
      globals: { document: documentStub() },
      hooks: { ui: { ...removeUi(['key-1']), busy: 'removeBatch' }, draft: readyDraft() },
    });
    const tree = component({ t });

    assert.equal(removeDialogButton(tree, '删除中…').props.disabled, true);
    const dialog = flatten(tree).find((element) => element.props?.['aria-label'] === '批量删除密钥');
    const boxes = flatten(dialog).filter((element) => element.type === 'input');
    assert.equal(boxes.every((box) => box.props.disabled === true), true);
  });

  test('密钥池标题行给出入口，没点开时一个弹层都不渲染', async () => {
    const { component, t } = await mountedCard({ hooks: { ui: readyUi(), draft: readyDraft() } });
    const tree = component({ t });

    assert.notEqual(buttonWithText(tree, '批量添加'), undefined, '标题行要有批量添加的入口');
    assert.equal(flatten(tree).some((element) => element.type === 'portal'), false);
    assert.equal(flatten(tree).some((element) => element.props?.className === 'dtp-dialog'), false);
  });

  test('打开后弹框挂在 document.body 上，里面有文本框与「一行一个」的说明', async () => {
    const doc = documentStub();
    const { component, t } = await mountedCard({
      globals: { document: doc },
      hooks: { ui: openUi(), draft: readyDraft() },
    });
    const tree = component({ t });

    const portal = flatten(tree).find((element) => element.type === 'portal');
    assert.notEqual(portal, undefined);
    assert.equal(portal.props.container, doc.body, '弹层要挂到卡片之外，否则定位受祖先元素摆布');

    const dialog = flatten(tree).find((element) => element.props?.className === 'dtp-dialog');
    assert.equal(dialog.props.role, 'dialog');
    assert.equal(dialog.props['aria-modal'], true);

    const textarea = flatten(dialog).find((element) => element.type === 'textarea');
    assert.notEqual(textarea, undefined, '要有一个能粘贴几十行的多行文本框');
    assert.equal(textarea.props.value, PASTED);
    assert.equal(textarea.props.autoFocus, true);

    const texts = textsOf(dialog);
    assert.equal(texts.includes('批量添加密钥'), true);
    assert.equal(texts.some((text) => text.includes('一行一个密钥')), true);
    assert.equal(texts.some((text) => text.includes('空行与重复的会被跳过')), true, '规则要说在按钮前面');
  });

  test('入口按钮打开弹框，并把上一次的文本清掉', async () => {
    const stale = { ...readyUi(), batchText: '上一次留下的明文' };
    const { component, t, updates } = await mountedCard({
      globals: { document: documentStub() },
      hooks: { ui: stale, draft: readyDraft() },
    });

    buttonWithText(component({ t }), '批量添加').props.onClick();

    const ui = uiAfter(updates, stale);
    assert.equal(ui.batchOpen, true);
    assert.equal(ui.batchText, '', '打开时清空：上一次的明文不该在框里等着');
  });

  test('Esc 关闭弹框并清空文本，关闭后摘掉监听器', async () => {
    const doc = documentStub();
    const { component, t, effects, updates } = await mountedCard({
      globals: { document: doc },
      hooks: { ui: openUi(), draft: readyDraft() },
    });
    component({ t });

    // 第一个 effect 是首次加载，第二个才是 Esc（顺序即组件里 `useEffect` 的调用顺序）。
    const cleanup = effects[1]();
    const onKeyDown = doc.listeners.get('keydown');
    assert.notEqual(onKeyDown, undefined, '弹框打开时要挂上 Esc 监听');

    onKeyDown({ key: 'a' });
    assert.equal(uiAfter(updates, openUi()).batchOpen, true, '别的键不该把弹框关掉');

    onKeyDown({ key: 'Escape' });
    const closed = uiAfter(updates, openUi());
    assert.equal(closed.batchOpen, false);
    assert.equal(closed.batchText, '', '关掉之后明文不该留在状态里');

    cleanup();
    assert.equal(doc.listeners.has('keydown'), false, '关闭之后要摘掉监听器');
  });

  test('提交中按 Esc 不关弹框：请求还在飞，文本不能丢', async () => {
    const doc = documentStub();
    const working = { ...openUi(), busy: 'addBatch' };
    const { component, t, effects, updates } = await mountedCard({
      globals: { document: doc },
      hooks: { ui: working, draft: readyDraft() },
    });
    component({ t });

    effects[1]();
    doc.listeners.get('keydown')({ key: 'Escape' });

    assert.equal(uiAfter(updates, working).batchOpen, true, '失败时用户要靠框里的文本重试');
  });

  test('点遮罩关闭、点弹框内部不关闭', async () => {
    const { component, t, updates } = await mountedCard({
      globals: { document: documentStub() },
      hooks: { ui: openUi(), draft: readyDraft() },
    });
    const overlay = flatten(component({ t })).find((element) => element.props?.className === 'dtp-overlay');
    assert.notEqual(overlay, undefined);

    const inside = {};
    overlay.props.onClick({ target: inside, currentTarget: {} });
    assert.equal(uiAfter(updates, openUi()).batchOpen, true, '面板内部的点击会冒泡到遮罩，不能因此关掉弹框');

    overlay.props.onClick({ target: inside, currentTarget: inside });
    assert.equal(uiAfter(updates, openUi()).batchOpen, false);
  });

  test('取消按钮关闭弹框并清空文本', async () => {
    const { component, t, updates } = await mountedCard({
      globals: { document: documentStub() },
      hooks: { ui: openUi(), draft: readyDraft() },
    });

    dialogButton(component({ t }), '取消').props.onClick();

    const ui = uiAfter(updates, openUi());
    assert.equal(ui.batchOpen, false);
    assert.equal(ui.batchText, '');
  });

  test('文本框为空时确认按钮不可用——空粘贴不该发一趟请求', async () => {
    const { component, t } = await mountedCard({
      globals: { document: documentStub() },
      hooks: { ui: openUi('  \n\n'), draft: readyDraft() },
    });

    assert.equal(dialogButton(component({ t }), '添加').props.disabled, true);
  });

  test('提交中弹框保持打开且禁用：刚粘进去的文本不会丢', async () => {
    const { component, t } = await mountedCard({
      globals: { document: documentStub() },
      hooks: { ui: { ...openUi(), busy: 'addBatch' }, draft: readyDraft() },
    });
    const tree = component({ t });

    assert.equal(dialogButton(tree, '添加中…').props.disabled, true);
    assert.equal(flatten(tree).find((element) => element.type === 'textarea').props.disabled, true);
  });

  test('确认把整段文本原样发给 keys 路由：切行与去重只有服务端一份实现', async () => {
    const calls = [];
    const { component, t, updates } = await mountedCard({
      globals: {
        document: documentStub(),
        fetch: fetchStub(calls, { received: 3, added: 2, duplicates: 1 }),
      },
      hooks: { ui: openUi(), draft: readyDraft() },
    });

    await dialogButton(component({ t }), '添加').props.onClick();
    await flush();

    const post = calls.find((call) => call.path === '/api/tavily-pool.keys');
    assert.notEqual(post, undefined, '确认要经面板接口提交');
    assert.deepEqual(
      post.body,
      { action: 'addBatch', text: PASTED },
      '前端一个字符都不动：首尾换行、行内空白、空行与重复行全部原样交给服务端',
    );

    // 结果要**说出来**：批量添加不像单把那样能在列表里一眼看出多了几行。
    const ui = uiAfter(updates, openUi());
    assert.equal(ui.batchOpen, false, '成功后弹框关闭');
    assert.equal(ui.batchText, '', '明文不该留在界面状态里等着下次打开');
    assert.equal(ui.notice, '已添加 2 把密钥，跳过 1 把重复的。');
  });

  test('一把重复都没有时，提示不啰嗦地报一句「已添加 N 把」', async () => {
    const calls = [];
    const { component, t, updates } = await mountedCard({
      globals: {
        document: documentStub(),
        fetch: fetchStub(calls, { received: 2, added: 2, duplicates: 0 }),
      },
      hooks: { ui: openUi('tvly-dev-a\ntvly-dev-b'), draft: readyDraft() },
    });

    await dialogButton(component({ t }), '添加').props.onClick();
    await flush();

    assert.equal(
      uiAfter(updates, openUi('tvly-dev-a\ntvly-dev-b')).notice,
      '已添加 2 把密钥。',
    );
  });

  test('一把都没加进去时说「没有新增」，而不是「已添加 0 把」', async () => {
    const calls = [];
    const { component, t, updates } = await mountedCard({
      globals: {
        document: documentStub(),
        fetch: fetchStub(calls, { received: 2, added: 0, duplicates: 2 }),
      },
      hooks: { ui: openUi('tvly-dev-a\ntvly-dev-a'), draft: readyDraft() },
    });

    await dialogButton(component({ t }), '添加').props.onClick();
    await flush();

    assert.equal(
      uiAfter(updates, openUi('tvly-dev-a\ntvly-dev-a')).notice,
      '没有新增：这 2 把密钥都已在池中。',
      '数字诚实但「已添加 0 把」读起来像出错',
    );
  });

  test('失败时弹框不关：文本还在，用户能就地改一行重试', async () => {
    const calls = [];
    const { component, t, updates } = await mountedCard({
      globals: {
        document: documentStub(),
        fetch: async (path, options = {}) => {
          calls.push({ path, body: options.body === undefined ? undefined : JSON.parse(options.body) });
          if (path === '/api/tavily-pool.keys') {
            return {
              ok: false,
              status: 400,
              text: async () => JSON.stringify({ error: { code: 'PANEL_BAD_REQUEST', message: 'no key' } }),
            };
          }
          return { ok: true, status: 200, text: async () => JSON.stringify(sampleState()) };
        },
      },
      hooks: { ui: openUi(), draft: readyDraft() },
    });

    await dialogButton(component({ t }), '添加').props.onClick();
    await flush();

    const ui = uiAfter(updates, openUi());
    assert.equal(ui.batchOpen, true, '失败不该把弹框连同文本一起丢掉');
    assert.equal(ui.batchText, PASTED, '文本原样留在框里，改一行就能重试');
    assert.equal(ui.notice, 'no key', '失败原因经卡片自己的提示说出来');
  });
});

describe('PANEL-5：卡片渲染出中英双语文案', () => {
  test('默认收起：收起时只有标题行，主体控件一个都不渲染', async () => {
    // 设置页里内置的每一张卡片都是收起的；一张常开的卡片既突兀又占地方。收起态仍要说清
    // 「接管开没开、池里有几把密钥」，因此摘要行是必需的，而不是装饰。
    const { component, t } = await mountedCard({
      hooks: { ui: collapsedUi({ keys: [keyRecord()] }), draft: readyDraft() },
    });

    const tree = component({ t });
    const types = new Set(flatten(tree).map((element) => element.type));

    assert.equal(types.has('input'), false, '收起时不该渲染输入框');
    assert.equal(types.has('select'), false, '收起时不该渲染下拉');
    assert.equal(types.has('ul'), false, '收起时不该渲染密钥列表');

    const texts = textsOf(tree);
    assert.equal(texts.includes('Tavily 密钥池'), true, '标题始终可见');
    assert.equal(texts.includes('已接管搜索 · 已接管抓取 · 1 把密钥'), true, '摘要行要说清当前状态');
  });

  test('标题行是一个 aria-expanded 的按钮，点一下才展开', async () => {
    const { component, t } = await mountedCard({ hooks: { ui: collapsedUi(), draft: readyDraft() } });

    const header = flatten(component({ t })).find((element) => element.props?.className === 'dtp-header');
    assert.notEqual(header, undefined);
    assert.equal(header.type, 'button');
    assert.equal(header.props['aria-expanded'], false);
    assert.match(String(header.props['aria-label']), /展开/u);
  });

  test('摘要行跟着开关与密钥数走，而不是一句固定文案', async () => {
    const off = await mountedCard({
      hooks: { ui: collapsedUi(), draft: { ...readyDraft(), searchEnabled: false } },
    });
    assert.equal(
      textsOf(off.component({ t: off.t })).includes('搜索未接管 · 已接管抓取 · 尚无密钥'),
      true,
    );

    // 两个开关彼此独立（`CFG-2`）：摘要必须分别反映它们，否则用户无从知道抓取此刻走的是谁。
    const fetchOff = await mountedCard({
      hooks: { ui: collapsedUi(), draft: { ...readyDraft(), fetchEnabled: false } },
    });
    assert.equal(
      textsOf(fetchOff.component({ t: fetchOff.t })).includes('已接管搜索 · 抓取未接管 · 尚无密钥'),
      true,
    );

    const many = await mountedCard({
      hooks: { ui: collapsedUi({ keys: [keyRecord(), keyRecord({ id: 'key-2' })] }), draft: readyDraft() },
    });
    assert.equal(
      textsOf(many.component({ t: many.t })).includes('已接管搜索 · 已接管抓取 · 2 把密钥'),
      true,
    );
  });

  test('诊断块**始终可见**，收起也藏不住', async () => {
    // 收起状态藏掉一条「密钥池文件坏了」比不显示它更糟。
    const { component, t } = await mountedCard({
      hooks: {
        ui: collapsedUi({ poolError: { message: 'not valid JSON', path: '/tmp/keys.json', reason: 'malformed' } }),
        draft: readyDraft(),
      },
    });

    assert.equal(textsOf(component({ t })).some((text) => text.includes('not valid JSON')), true);
  });

  test('有未保存改动时标题行带标记，且标题行是唯一的入口', async () => {
    const { component, t } = await mountedCard({
      hooks: { ui: collapsedUi(), draft: { ...readyDraft(), searchDepth: 'advanced' } },
    });

    assert.equal(textsOf(component({ t })).includes('有未保存的改动'), true);
  });

  test('初始渲染显示加载中', async () => {
    const { component, t } = await mountedCard();

    assert.equal(textsOf(component({ t })).includes('加载中…'), true);
  });

  test('加载失败时显示原因与重试，而不是空白', async () => {
    const { component, t } = await mountedCard({
      hooks: { ui: { ...readyUi(), phase: 'failed', state: null, error: 'boom' }, draft: null },
    });

    const texts = textsOf(component({ t }));
    assert.equal(texts.some((text) => text.includes('boom')), true);
    assert.equal(texts.includes('重试'), true);
  });

  test('就绪态渲染标题、说明、两个开关与密钥池', async () => {
    const { component, t } = await mountedCard({ hooks: { ui: readyUi(), draft: readyDraft() } });
    const tree = component({ t });
    const texts = textsOf(tree);

    assert.equal(texts.includes('Tavily 密钥池'), true);
    assert.equal(texts.includes('接管搜索（web_search）'), true);
    assert.equal(texts.includes('接管抓取（web_fetch）'), true);
    assert.equal(texts.includes('搜索参数'), true);
    assert.equal(texts.includes('抓取参数'), true);
    assert.equal(texts.includes('密钥池'), true);

    // 两个开关都必须是**真的开关**，而不是一句说明（`CFG-2`）。
    const switches = flatten(tree).filter((element) => element.type === switchStub);
    assert.deepEqual(switches.map((element) => element.props.label), [
      '接管搜索（web_search）',
      '接管抓取（web_fetch）',
      '生成答案',
    ]);
  });

  test('两个开关各自读自己那一项设置，而不是共用一个值', async () => {
    // 「独立开关」（`CFG-2`）的实质是两个开关各自由自己那一项设置驱动。只断言「渲染了
    // 两个 Switch」会漏掉「两个都读 searchEnabled」这种把独立性抹掉的实现。
    const onlyFetch = await mountedCard({
      hooks: { ui: readyUi({ settings: { ...sampleState().settings, searchEnabled: false } }), draft: { ...readyDraft(), searchEnabled: false } },
    });
    const onlyFetchSwitches = flatten(onlyFetch.component({ t: onlyFetch.t }))
      .filter((element) => element.type === switchStub);
    assert.deepEqual(onlyFetchSwitches.slice(0, 2).map((element) => element.props.checked), [false, true]);

    const onlySearch = await mountedCard({
      hooks: { ui: readyUi({ settings: { ...sampleState().settings, fetchEnabled: false } }), draft: { ...readyDraft(), fetchEnabled: false } },
    });
    const onlySearchSwitches = flatten(onlySearch.component({ t: onlySearch.t }))
      .filter((element) => element.type === switchStub);
    assert.deepEqual(onlySearchSwitches.slice(0, 2).map((element) => element.props.checked), [true, false]);
  });

  test('传入宿主自己的 t 时优先用它', async () => {
    const { component } = await mountedCard({ hooks: { ui: readyUi(), draft: readyDraft() } });

    const texts = textsOf(component({ t: (key) => `[${key}]` }));
    assert.equal(texts.includes('[title]'), true);
    assert.equal(texts.includes('Tavily 密钥池'), false, '宿主给了 t 就不该用自带词表');
  });

  test('抓取参数与抓取开关一起出现，取值与 schema 的词表一致', async () => {
    // `10` 之前卡片上有一句「抓取接管尚在开发中」，它绑在服务端的 `fetchToggleAvailable`
    // 上。那个字段随本票一起删掉了：**没有消费方的字段位就是一个空洞**，而它的前任正是
    // 「一句必然会过时的说明」。这条用例盯住取而代之的事实——两项抓取参数都可选且选项与
    // `lib/settings.js` 的词表逐字一致。
    const { component, t } = await mountedCard({ hooks: { ui: readyUi(), draft: readyDraft() } });
    const selects = flatten(component({ t })).filter((element) => element.type === 'select');
    const values = selects.map((element) => element.props.value);
    // `maxResults` 是 `<input type="number">`，不在这一列里。
    assert.deepEqual(values, ['basic', 'general', 'balance', 'basic', 'markdown']);

    const options = selects.map((element) => element.children.map((child) => child.props.value));
    // 期望值来自权威导出，不是抄一份字面量：改了 schema 的词表而没改客户端副本时，这条会红。
    assert.deepEqual(options[2], [...SCHEDULING_POLICY_VALUES], '调度策略的词表要与 SCHEDULING_POLICY_VALUES 一致');
    assert.deepEqual(options[3], [...EXTRACT_DEPTH_VALUES], '抽取深度的词表要与 EXTRACT_DEPTH_VALUES 一致');
    assert.deepEqual(options[4], [...EXTRACT_FORMAT_VALUES], '返回格式的词表要与 EXTRACT_FORMAT_VALUES 一致');
  });

  test('每把密钥的最近耗时也显示出来（USAGE-7）', async () => {
    const { component, t } = await mountedCard({
      hooks: {
        ui: readyUi({ keys: [keyRecord({ stats: { calls: 1, successes: 1, failures: 0, lastDurationMs: 812 } })] }),
        draft: readyDraft(),
      },
    });

    assert.equal(textsOf(component({ t })).some((text) => text.includes('最近耗时：812 ms')), true);
  });

  test('SCHED-7：选 manual 时说清列表顺序就是调度顺序，balance 下不说', async () => {
    // 手动顺序策略下，密钥池列表的顺序**换了一个含义**。用户没有任何别的线索能知道这件事，
    // 因此那句话必须在切到 manual 的那一刻出现；而它在 balance 下常显，会让用户以为上下移
    // 也在影响调度。
    const balance = await mountedCard({ hooks: { ui: readyUi(), draft: readyDraft() } });
    assert.equal(
      textsOf(balance.component({ t: balance.t })).some((text) => text.includes('这个列表的顺序就是调度顺序')),
      false,
      'balance 下不该声称排序在起作用',
    );

    const manual = await mountedCard({
      hooks: { ui: readyUi(), draft: { ...readyDraft(), schedulingPolicy: 'manual' } },
    });
    assert.equal(
      textsOf(manual.component({ t: manual.t })).some((text) => text.includes('这个列表的顺序就是调度顺序')),
      true,
    );
  });

  test('拿不到宿主 t 时按 navigator.language 选自带词表', async () => {
    // 宿主没传 `t` 时走自带词表：预览期形态若变动，卡片至少还是可读的，而不是一片 undefined。
    const chinese = await mountedCard({
      globals: { navigator: { language: 'zh-CN' } },
      hooks: { ui: readyUi(), draft: readyDraft() },
    });
    assert.equal(textsOf(chinese.component({})).includes('Tavily 密钥池'), true);

    const english = await mountedCard({
      globals: { navigator: { language: 'en-US' } },
      hooks: { ui: readyUi(), draft: readyDraft() },
    });
    assert.equal(textsOf(english.component({})).includes('Tavily key pool'), true);
  });

  test('英文词表渲染英文（PANEL-5）', async () => {
    const { component, dictionaries } = await mountedCard({
      locale: 'en',
      hooks: { ui: readyUi(), draft: readyDraft() },
    });

    const texts = textsOf(component({ t: tOf(dictionaries, 'en') }));
    assert.equal(texts.includes('Tavily key pool'), true);
    assert.equal(texts.includes('Search parameters'), true);
  });

  test('两套词表确实是两份文案，而不是同一份被复制了两遍', async () => {
    const { dictionaries } = await mountedCard();
    const { zh, en } = dictionaries[0].dictionary;

    assert.notEqual(zh.searchToggle, en.searchToggle);
    assert.notEqual(zh.fallbackMissing, en.fallbackMissing);
  });
});

describe('PANEL-6：余额未知时显示未知', () => {
  test('从未刷新过余额的密钥显示「未知」，而不是一根空进度条', async () => {
    const { component, t } = await mountedCard({
      hooks: { ui: readyUi({ keys: [keyRecord({ usage: undefined })] }), draft: readyDraft() },
    });

    const tree = component({ t });
    assert.equal(textsOf(tree).includes('未知'), true);
    assert.deepEqual(
      flatten(tree).filter((element) => element.props?.className === 'dtp-bar'),
      [],
      '未知不该画成 0%',
    );
  });

  test('余额为正时画出进度条并给出剩余积分', async () => {
    const { component, t } = await mountedCard({
      hooks: {
        ui: readyUi({ keys: [keyRecord({ usage: { key: { limit: 1000, usage: 250 }, stale: false } })] }),
        draft: readyDraft(),
      },
    });

    const tree = component({ t });
    assert.equal(textsOf(tree).some((text) => text.includes('剩余 750 / 1000 积分')), true);

    const fills = flatten(tree).filter((element) => element.props?.className === 'dtp-bar-fill');
    assert.equal(fills.length, 1);
    assert.equal(fills[0].props.style.width, '75%');
  });

  test('两侧都没有上限时才显示「无限」，且仍不画进度条', async () => {
    const { component, t } = await mountedCard({
      hooks: {
        ui: readyUi({
          keys: [keyRecord({
            usage: { key: { limit: null, usage: 12 }, account: { plan_limit: null }, stale: false },
          })],
        }),
        draft: readyDraft(),
      },
    });

    const tree = component({ t });
    assert.equal(textsOf(tree).includes('无限'), true);
    assert.deepEqual(flatten(tree).filter((element) => element.props?.className === 'dtp-bar'), []);
  });

  test('免费账号的 key.limit 是 null，但面板要按 account.plan_limit 画真实剩余（ticket 20）', async () => {
    // 实测的官方响应：`key.limit` 为 `null`、`account.plan_limit` 为 1000。修之前面板显示
    // 「无限」、不画进度条——而用户实际只有 1000 积分/月，其中 250 已经用掉。
    const { component, t } = await mountedCard({
      hooks: {
        ui: readyUi({
          keys: [keyRecord({
            usage: {
              key: { limit: null, usage: 250 },
              account: { current_plan: 'Researcher', plan_usage: 250, plan_limit: 1000 },
              stale: false,
            },
          })],
        }),
        draft: readyDraft(),
      },
    });

    const tree = component({ t });
    assert.equal(textsOf(tree).includes('无限'), false, '免费账号不是无限额度');
    assert.equal(textsOf(tree).some((text) => text.includes('剩余 750 / 1000 积分')), true);

    const fills = flatten(tree).filter((element) => element.props?.className === 'dtp-bar-fill');
    assert.equal(fills.length, 1, '有分母就该画进度条');
    assert.equal(fills[0].props.style.width, '75%');
  });

  test('上限读不出来时显示「未知」，不显示「无限」', async () => {
    // 没有 account 段的响应（形状变化、残缺）读不出上限：显示「未知」而不是「无限」——
    // 「以为它用不完」比「以为它没量了」危险得多。
    const { component, t } = await mountedCard({
      hooks: {
        ui: readyUi({ keys: [keyRecord({ usage: { key: { limit: null, usage: 12 }, stale: false } })] }),
        draft: readyDraft(),
      },
    });

    const tree = component({ t });
    assert.equal(textsOf(tree).includes('无限'), false);
    assert.equal(textsOf(tree).includes('未知'), true);
  });

  test('刷新失败的读数标成陈旧（USAGE-3）', async () => {
    const { component, t } = await mountedCard({
      hooks: {
        ui: readyUi({ keys: [keyRecord({ usage: { key: { limit: 1000, usage: 250 }, stale: true } })] }),
        draft: readyDraft(),
      },
    });

    assert.equal(textsOf(component({ t })).some((text) => text.includes('陈旧')), true);
  });

  test('陈旧时**进度条本身**有视觉区分，而不只是下面多一行字', async () => {
    // `13` 的验收原文就是「进度条需有视觉区分」：进度条是这张卡片上最先被扫到的东西，
    // 只在它下面挂一行说明等于没区分。
    const stale = await mountedCard({
      hooks: {
        ui: readyUi({ keys: [keyRecord({ usage: { key: { limit: 1000, usage: 250 }, stale: true } })] }),
        draft: readyDraft(),
      },
    });
    const staleBar = flatten(stale.component({ t: stale.t })).find(
      (element) => element.props?.className?.startsWith('dtp-bar'),
    );
    assert.match(staleBar.props.className, /dtp-bar-stale/u);

    const fresh = await mountedCard({
      hooks: {
        ui: readyUi({ keys: [keyRecord({ usage: { key: { limit: 1000, usage: 250 }, stale: false } })] }),
        draft: readyDraft(),
      },
    });
    const freshBar = flatten(fresh.component({ t: fresh.t })).find(
      (element) => element.props?.className?.startsWith('dtp-bar'),
    );
    assert.equal(freshBar.props.className, 'dtp-bar', '新鲜的读数不该带陈旧样式');
  });

  test('统计行显示调用、成功与失败，且不再显示任何积分（USAGE-7）', async () => {
    // 插件不再统计自身消耗积分（2026-09-20 决定）：积分规则由上游随时可能更改，任何自算的
    // 数字都可能在某次规则调整后变成误导。展示只用 `/usage` 的官方余额。
    const { component, t } = await mountedCard({
      hooks: {
        ui: readyUi({ keys: [keyRecord({ stats: { calls: 2, successes: 1, failures: 1, credits: 3 } })] }),
        draft: readyDraft(),
      },
    });

    const texts = textsOf(component({ t }));
    assert.equal(
      texts.some((text) => text.includes('调用 2 · 成功 1 · 失败 1')),
      true,
      '统计行只报调用次数',
    );
    assert.equal(
      texts.some((text) => text.includes('消耗')),
      false,
      '即使状态里还带着 credits，也不该再渲染出任何「消耗」字样',
    );
  });

  test('状态里残留的 creditsUnknown 也不再渲染——「消耗未知」这一态已不存在', async () => {
    // 旧口径下「不知道消耗了多少」会单独标出来（`REST-3`）。现在没有记账、只有估算，而估算
    // 总是已知的，因此那条文案连同它的 i18n 键一并删掉了。
    const { component, t } = await mountedCard({
      hooks: {
        ui: readyUi({
          keys: [keyRecord({ stats: { calls: 3, successes: 3, failures: 0, credits: 2, creditsUnknown: 1 } })],
        }),
        draft: readyDraft(),
      },
    });

    const texts = textsOf(component({ t }));
    assert.equal(texts.some((text) => text.includes('其中 1 次消耗未知')), false);
    assert.equal(texts.some((text) => text.includes('调用 3 · 成功 3 · 失败 0')), true, '其余统计照常显示');
  });
});

describe('面板状态里的诊断信息照样渲染出来', () => {
  test('密钥池文件坏掉时卡片显示原因与路径（POOL-7）', async () => {
    const { component, t } = await mountedCard({
      hooks: {
        ui: readyUi({ poolError: { message: 'not valid JSON', path: '/tmp/keys.json', reason: 'malformed' } }),
        draft: readyDraft(),
      },
    });

    const texts = textsOf(component({ t }));
    assert.equal(texts.some((text) => text.includes('not valid JSON')), true);
    assert.equal(texts.some((text) => text.includes('/tmp/keys.json')), true);
  });

  test('宿主能力缺失时卡片显示缺了什么（COMPAT-3）', async () => {
    const { component, t } = await mountedCard({
      hooks: {
        ui: readyUi({
          capabilities: {
            ok: false,
            missingRequired: ['settings.register'],
            missingOptional: [],
            summary: 'missing',
            findings: [],
          },
        }),
        draft: readyDraft(),
      },
    });

    assert.equal(textsOf(component({ t })).some((text) => text.includes('settings.register')), true);
  });

  test('回落凭据的两态给出不同的下一步（CFG-5）', async () => {
    const cases = [
      ['missing', /Models/u],
      ['invalid', /401|失效/u],
      ['configured', /已配置/u],
    ];
    for (const [credential, pattern] of cases) {
      const { component, t } = await mountedCard({
        hooks: {
          ui: readyUi({ fallback: { ...sampleState().fallback, credential } }),
          draft: readyDraft(),
        },
      });
      assert.equal(
        textsOf(component({ t })).some((text) => pattern.test(text)),
        true,
        `${credential} 应当有可据以行动的文案`,
      );
    }
  });

  test('连通性测试的结论按分类词渲染成可据以行动的文案（12）', async () => {
    const cases = [
      [{ ok: false, classification: 'auth' }, /鉴权失败/u],
      [{ ok: false, classification: 'rate-limited' }, /限流/u],
      [{ ok: false, classification: 'quota' }, /配额已用尽/u],
      [{ ok: true, classification: 'ok' }, /可用/u],
    ];
    for (const [outcome, pattern] of cases) {
      const { component, t } = await mountedCard({
        hooks: {
          ui: { ...readyUi({ keys: [keyRecord()] }), tests: { 'key-1': outcome } },
          draft: readyDraft(),
        },
      });
      assert.equal(textsOf(component({ t })).some((text) => pattern.test(text)), true, `${outcome.classification} 应当有文案`);
    }
  });

  test('宿主给了一个我们不认识的分类时原样显示，而不是显示拼出来的键名', async () => {
    const { component, t } = await mountedCard({
      hooks: {
        ui: { ...readyUi({ keys: [keyRecord()] }), tests: { 'key-1': { ok: false, classification: 'brand-new' } } },
        draft: readyDraft(),
      },
    });

    assert.equal(
      textsOf(component({ t })).some((text) => text.includes('brand-new')),
      true,
      '分类词表是显式的，因此新分类退化为原词而不是 classificationBrandNew 这样的键名',
    );
  });

  test('池里没有密钥时给出空态说明', async () => {
    const { component, t } = await mountedCard({ hooks: { ui: readyUi(), draft: readyDraft() } });

    assert.equal(textsOf(component({ t })).some((text) => text.includes('还没有密钥')), true);
  });

  test('被停用、额度耗尽、永久失效的密钥各自带标记（POOL-5、SCHED-8、REST-5）', async () => {
    const { component, t } = await mountedCard({
      hooks: {
        ui: readyUi({
          keys: [keyRecord({
            disabled: true,
            stats: {
              calls: 0,
              successes: 0,
              failures: 1,
              quotaExhaustedAt: '2026-09-01T00:00:00.000Z',
              permanentlyInvalidAt: '2026-09-02T00:00:00.000Z',
            },
          })],
        }),
        draft: readyDraft(),
      },
    });

    const texts = textsOf(component({ t }));
    assert.equal(texts.includes('已停用'), true);
    assert.equal(texts.includes('额度耗尽'), true);
    assert.equal(texts.includes('永久失效'), true);
  });

  test('最近错误显示出来（USAGE-7）', async () => {
    const { component, t } = await mountedCard({
      hooks: {
        ui: readyUi({
          keys: [keyRecord({
            stats: {
              calls: 1,
              successes: 0,
              failures: 1,
              lastError: { code: 'TAVILY_HTTP_432', status: 432, message: 'quota exceeded' },
            },
          })],
        }),
        draft: readyDraft(),
      },
    });

    assert.equal(textsOf(component({ t })).some((text) => text.includes('quota exceeded')), true);
  });

  test('有未保存改动时提示，并让保存按钮可用（CFG-3）', async () => {
    const { component, t } = await mountedCard({
      hooks: { ui: readyUi(), draft: { ...readyDraft(), searchDepth: 'advanced' } },
    });

    const tree = component({ t });
    assert.equal(textsOf(tree).includes('有未保存的改动'), true);
    const save = buttonWithText(tree, '保存');
    assert.notEqual(save, undefined);
    assert.equal(save.props.disabled, false);
  });

  test('越界的 maxResults 让保存按钮不可用，并说明取值区间（CFG-4）', async () => {
    const range = `${MAX_RESULTS_MIN}–${MAX_RESULTS_MAX}`;
    const { component, t } = await mountedCard({
      hooks: { ui: readyUi(), draft: { ...readyDraft(), maxResults: String(MAX_RESULTS_MAX + 1) } },
    });

    const tree = component({ t });
    // 区间由权威常量算出：schema 放宽上界而卡片还停在旧区间时，这里给的就是两个不同的串。
    assert.equal(textsOf(tree).some((text) => text.includes(range)), true);
    assert.equal(buttonWithText(tree, '保存').props.disabled, true, '本地就不该放一个必然被 schema 拒绝的值出去');
  });

  test('没有改动时保存按钮不可用', async () => {
    const { component, t } = await mountedCard({ hooks: { ui: readyUi(), draft: readyDraft() } });

    assert.equal(buttonWithText(component({ t }), '保存').props.disabled, true);
  });
});

describe('HTTP 只经面板接口（PANEL-4）', () => {
  test('卡片里出现的每一条路径都在 /api 之下，且只有这五条', async () => {
    const source = await readFile(CLIENT_FILE, 'utf8');
    const paths = [...source.matchAll(/'(\/api\/[A-Za-z0-9_$.-]+)'/gu)].map((match) => match[1]);

    assert.deepEqual(paths.sort(), [
      '/api/tavily-pool.keys',
      '/api/tavily-pool.refresh',
      '/api/tavily-pool.settings',
      '/api/tavily-pool.state',
      '/api/tavily-pool.test',
    ]);
  });

  test('路径与 lib/dsh/panel-routes.js 的常量逐字相同', async () => {
    // 两边各写一遍字面量是这套设计里唯一的重复，而它会静默失败：路径不一致时卡片只是
    // 收到 404，界面表现为「接口不可用」。
    const { PANEL_ROUTE_PATHS } = await import('../lib/dsh/panel-routes.js');
    const source = await readFile(CLIENT_FILE, 'utf8');

    for (const path of Object.values(PANEL_ROUTE_PATHS)) {
      assert.equal(source.includes(`'${path}'`), true, `客户端缺少 ${path}`);
    }
  });

  test('不请求任何返回明文或做导入导出的接口（POOL-3、Q12）', async () => {
    const source = await readFile(CLIENT_FILE, 'utf8');
    assert.equal(/\/(reveal|plaintext|export|import)/u.test(source), false);
  });
});

describe('14：调用历史与图表', () => {
  /** 一份按日汇总，形状与 `readPanelState` 的投影一致。 */
  function daily() {
    return Array.from({ length: 14 }, (unused, index) => ({
      date: `2026-09-${String(index + 6).padStart(2, '0')}`,
      search: index,
      extract: index % 3,
      calls: index + 1,
    }));
  }

  /** 一条调用记录。 */
  function callRecord(overrides = {}) {
    return {
      at: '2026-09-19T02:30:00.000Z',
      endpoint: 'search',
      keyId: 'key-1',
      keyMasked: 'tvly-dev-…iJWq',
      outcome: 'ok',
      credits: 1,
      durationMs: 812,
      ...overrides,
    };
  }

  test('曲线自绘成 SVG 折线，不引任何图表依赖', async () => {
    const { component, t } = await mountedCard({
      hooks: {
        ui: readyUi({ history: { entries: [callRecord()], daily: daily(), error: null } }),
        draft: readyDraft(),
      },
    });
    const tree = component({ t });
    const polylines = flatten(tree).filter((element) => element.type === 'polyline');

    // 两条线：搜索一条、抓取一条。它们不共用纵轴刻度（量级差太远），因此必须是两条独立的折线。
    assert.equal(polylines.length, 2);
    for (const line of polylines) {
      assert.match(line.props.points, /^[\d.,\s]+$/u);
      assert.equal(line.props.points.split(' ').length, 14, '每天的桶都要有一个点，空白天补零');
    }
    assert.equal(flatten(tree).some((element) => element.type === 'svg'), true);
  });

  test('图表正确反映积分趋势：点的高度跟着当天的积分走', async () => {
    // 「正确反映趋势」这句话可断言的部分就是它：数值大的那天，点在坐标系里更高（y 更小）。
    const flat = Array.from({ length: 14 }, (unused, index) => ({
      date: `2026-09-${String(index + 6).padStart(2, '0')}`,
      search: 0,
      extract: 0,
      calls: 0,
    }));
    const growing = flat.map((day, index) => ({ ...day, search: index }));

    const { component, t } = await mountedCard({
      hooks: {
        ui: readyUi({ history: { entries: [callRecord()], daily: growing, error: null } }),
        draft: readyDraft(),
      },
    });
    const [search] = flatten(component({ t })).filter((element) => element.type === 'polyline');
    const ys = search.props.points.split(' ').map((pair) => Number(pair.split(',')[1]));

    // 坐标系 y 向下，因此「更高」= 更小的 y。
    assert.ok(ys[0] > ys[ys.length - 1], `单调上升的消耗应当画成上升的折线，实际 y=${ys.join(',')}`);
    for (let index = 1; index < ys.length; index += 1) {
      assert.ok(ys[index] <= ys[index - 1], '每个点都不该比前一个低');
    }
  });

  test('明细表列出时间、端点、密钥、结果与耗时，且没有积分列', async () => {
    const { component, t } = await mountedCard({
      hooks: {
        ui: readyUi({
          history: {
            entries: [
              callRecord(),
              callRecord({ endpoint: 'extract', keyMasked: 'tvly-dev-…0000', outcome: 'failed', code: 'TAVILY_HTTP_401', durationMs: 41 }),
            ],
            daily: daily(),
            error: null,
          },
        }),
        draft: readyDraft(),
      },
    });
    const texts = textsOf(component({ t }));

    assert.equal(texts.includes('调用历史'), true);
    assert.equal(texts.includes('时间'), true);
    assert.equal(texts.some((text) => text.includes('tvly-dev-…iJWq')), true);
    assert.equal(texts.includes('TAVILY_HTTP_401'), true, '失败行要给出机器码');
    assert.equal(texts.some((text) => text.includes('812 ms')), true);
    // 积分列连同「未知」那一格一并删掉：插件不再统计自身消耗。
    assert.equal(texts.includes('积分'), false, '表头里不该再有积分列');
    assert.equal(texts.includes('未知'), false, '「消耗未知」这一格已不存在');
  });

  test('没有任何记录时说「还没有调用」而不是画一条零线', async () => {
    // 画一条贴着零的线看起来像「有数据但都是 0」，而事实是「一次都没调用过」。
    const { component, t } = await mountedCard({
      hooks: { ui: readyUi({ history: { entries: [], daily: daily(), error: null } }), draft: readyDraft() },
    });
    const tree = component({ t });

    assert.equal(flatten(tree).some((element) => element.type === 'polyline'), false);
    assert.equal(textsOf(tree).some((text) => text.includes('还没有调用记录')), true);
  });

  test('历史读不出来时如实说明，而不是显示成「没有调用」', async () => {
    const { component, t } = await mountedCard({
      hooks: {
        ui: readyUi({ history: { entries: [], daily: [], error: 'Unexpected token { in JSON' } }),
        draft: readyDraft(),
      },
    });

    assert.equal(
      textsOf(component({ t })).some((text) => text.includes('Unexpected token { in JSON')),
      true,
    );
  });

  test('明细行数有上限，超出时说明只显示了最近多少条', async () => {
    const many = Array.from({ length: 30 }, (unused, index) => callRecord({ durationMs: index }));
    const { component, t } = await mountedCard({
      hooks: { ui: readyUi({ history: { entries: many, daily: daily(), error: null } }), draft: readyDraft() },
    });

    // 只渲染一次：测试里的 react 替身每次调用都从同一列 hook 值里往后取，第二次渲染会
    // 落到「加载中」那个分支上——那样断言的就不是同一个树了。
    const tree = component({ t });
    const rows = flatten(tree).filter((element) => element.type === 'tr');
    // 表头一行 + 明细若干行。
    assert.equal(rows.length, 1 + 20);
    assert.equal(
      textsOf(tree).some((text) => text.includes('仅显示最近 20 条（共 30 条）')),
      true,
      '要说清只显示了最近多少条、总共有多少条',
    );
  });

  test('卡片在宿主没给 history 字段时也不崩（半坏仍可用）', async () => {
    // 面板状态的投影变了而卡片还没跟上，或者反过来——预览期这事会真的发生。
    const { component, t } = await mountedCard({
      hooks: { ui: { ...readyUi(), state: { ...sampleState() } }, draft: readyDraft() },
    });

    assert.doesNotThrow(() => component({ t }));
  });
});

/**
 * 渲染一把密钥，返回屏幕上出现的文字与进度条宽度。
 *
 * 余额用例的判据一律是**渲染出来的东西**：`balanceOf` 在工厂体内，抠不出来也不该为测试
 * 开一个口子。
 *
 * @param usage - 密钥记录里的 `usage`。
 * @returns `{ texts, width }`；`width` 为 `undefined` 表示没有画进度条。
 */
async function renderKeyUsage(usage) {
  const { component, t } = await mountedCard({
    hooks: { ui: readyUi({ keys: [keyRecord({ usage })] }), draft: readyDraft() },
  });
  const tree = component({ t });
  const fill = flatten(tree).find((element) => element.props?.className === 'dtp-bar-fill');
  return { texts: textsOf(tree), width: fill?.props.style.width };
}

describe('22-E1：「测试连通性」之后要重读状态', () => {
  /** 一个记录请求的 fetch 替身：`test` 路由回一条成功结论，其余当状态读。 */
  function fetchStub(calls) {
    return async (path, options = {}) => {
      calls.push(`${options.method ?? 'GET'} ${path}`);
      const payload = path === '/api/tavily-pool.test'
        ? { id: 'key-1', ok: true, classification: 'ok', error: null }
        : sampleState({ keys: [keyRecord()] });
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    };
  }

  test('成功之后重新读 /state：额度耗尽标记与余额不会停在旧快照上（client-artifact-1）', async () => {
    const calls = [];
    const base = readyUi({ keys: [keyRecord()] });
    const { component, t, updates } = await mountedCard({
      globals: { fetch: fetchStub(calls) },
      hooks: { ui: base, draft: readyDraft() },
    });

    await buttonWithText(component({ t }), '测试连通性').props.onClick();
    await flush();

    // 这条路由走的是同一次 `/usage` 刷新：它会写余额缓存，并在余额为正时清掉额度耗尽
    // 标记（`SCHED-8`）。只把结论记进 `ui.tests` 的话，同一行会同时显示「额度耗尽」与
    // 「可用」，而余额停在旧读数上——这个按钮存在的意义正是让用户看到它是不是真恢复了。
    assert.deepEqual(calls, ['POST /api/tavily-pool.test', 'GET /api/tavily-pool.state']);

    const ui = uiAfter(updates, base);
    assert.equal(ui.tests['key-1'].classification, 'ok', '测试结论要留在状态里');
    assert.equal(ui.state.keys[0].masked, 'tvly-dev-…iJWq', '重读回来的状态也要留下');
  });
});

describe('22-E2：客户端内联的余额判定与 lib/balance.js 等价', () => {
  test('逐条比对：判定层给什么结论，面板就说同一件事（boundaries-drift-1）', async () => {
    const { readBalance } = await import('../lib/balance.js');

    // 前四条是「上限不大于 0」那一类：判定层对上限没有下限约束，客户端副本曾经多判一条
    // 「不大于 0 就算未知」，于是同一把密钥在面板上是「未知」、在调度器里却是 rank 0
    // （`SCHED-2`）并被优先使用——用户看到「未知」，却解释不了调度为什么先用它。
    const entries = [
      { key: { limit: 0, usage: 0 } },
      { key: { limit: 0, usage: 5 } },
      { key: { limit: null, usage: 5 }, account: { plan_limit: 0 } },
      { key: { limit: -5, usage: 0 } },
      { key: { limit: 1000, usage: 250 } },
      { key: { limit: 1000, usage: 1200 } },
      { key: { limit: null, usage: 12 }, account: { plan_limit: 1000 } },
      { key: { limit: null, usage: 12 }, account: { plan_limit: null } },
      { key: { limit: null, usage: 12 } },
      { key: { limit: 1000 } },
      {},
    ];

    for (const entry of entries) {
      const expected = readBalance(entry);
      const { texts, width } = await renderKeyUsage(entry);
      const label = `usage = ${JSON.stringify(entry)}`;

      if (expected.kind === 'known') {
        // 显示层的除法保护：上限为 0 时进度条画 0%，而不是把 `NaN` 写进 `width`。
        const percent = expected.limit > 0 ? Math.round((expected.remaining / expected.limit) * 100) : 0;
        assert.equal(
          texts.includes(`剩余 ${expected.remaining} / ${expected.limit} 积分`),
          true,
          `${label}：判定层给了 known，面板就该给出同一组数字`,
        );
        assert.equal(width, `${percent}%`, `${label}：进度条宽度`);
      } else if (expected.kind === 'unlimited') {
        assert.equal(texts.includes('无限'), true, `${label}：判定层给了 unlimited`);
        assert.equal(width, undefined, `${label}：没有分母就不画进度条`);
      } else {
        assert.equal(texts.includes('未知'), true, `${label}：判定层给了 unknown`);
        assert.equal(width, undefined, `${label}：未知不该画成 0%`);
      }
    }
  });
});

describe('22-E4：读数的陈旧度要看得见', () => {
  /**
   * 一份带读数时刻的 `usage`。
   *
   * @param agoMs - 官方读数距现在多久。
   * @param overrides - 额外覆盖。
   * @returns `usage` 缓存项。
   */
  function usageReadAgo(agoMs, overrides = {}) {
    return {
      key: { limit: 1000, usage: 250 },
      stale: false,
      fetchedAt: new Date(Date.now() - agoMs).toISOString(),
      ...overrides,
    };
  }

  test('本地前推过的读数与刚刷新出来的读数渲染不同（client-artifact-8）', async () => {
    // `lib/pool.js` 的 `advanceUsage` 只前推 `usage`、**不动 `fetchedAt`**：于是「本地前推
    // 过」与「刚跟官方对过」在服务端只差读数时刻有多旧。这里用同一份 usage 值渲染两次，
    // 差异因此只可能来自那一行读数时刻。
    const fresh = await renderKeyUsage(usageReadAgo(0));
    const aged = await renderKeyUsage(usageReadAgo(2 * 3600 * 1000));

    assert.notDeepEqual(aged.texts, fresh.texts, '读数是不是刚拿到的，必须看得出来');

    const difference = aged.texts.filter((text) => !fresh.texts.includes(text));
    assert.equal(difference.length, 1, `差别只该是读数时刻那一行，实际：${JSON.stringify(difference)}`);
    assert.match(difference[0], /上次官方读数/u, '说的是事实（读数时刻），不是「这是估计值」这类无从验证的结论');
    assert.equal(aged.width, fresh.width, '陈旧度是读数的事，不改动余额本身');
  });

  test('读数还很新时一个字都不多说', async () => {
    const fresh = await renderKeyUsage(usageReadAgo(0));
    const justNow = await renderKeyUsage(usageReadAgo(60 * 1000));

    assert.deepEqual(justNow.texts, fresh.texts, '一分钟前的读数与刚刚读到的是同一件事，多一行只是噪音');
  });

  test('读数时刻读不出来时什么都不说，也不渲染 Invalid Date', async () => {
    const fresh = await renderKeyUsage(usageReadAgo(0));

    for (const fetchedAt of [undefined, 'not-a-date', 42]) {
      const broken = await renderKeyUsage({ key: { limit: 1000, usage: 250 }, stale: false, fetchedAt });
      assert.deepEqual(broken.texts, fresh.texts, `fetchedAt = ${String(fetchedAt)} 时不该编造读数时刻`);
    }
  });

  test('陈旧标记与读数时刻是两件事，同时成立时两行都在', async () => {
    const { texts } = await renderKeyUsage(usageReadAgo(2 * 3600 * 1000, { stale: true }));

    assert.equal(texts.some((text) => text.includes('上次刷新失败')), true, '陈旧标记说的是「上次刷新失败」');
    assert.equal(texts.some((text) => text.includes('上次官方读数')), true, '读数时刻说的是「这个数字有多旧」');
  });
});

/**
 * 从 `dtp-field` 里按标签取出那个下拉的选项值。
 *
 * 按**标签**而不是按出现次序定位：次序是布局的副产品，谁把字段挪一下就会让对账比错对象，
 * 而那种失败看起来像「词表漂移」，会把排查引到错的地方。
 *
 * @param tree - 渲染出来的元素树。
 * @param label - 字段标签（已翻译）。
 * @returns 选项值数组。
 */
function optionsOfField(tree, label) {
  const field = flatten(tree).find(
    (element) => element.props?.className === 'dtp-field' && textsOf(element).includes(label),
  );
  assert.notEqual(field, undefined, `没有找到「${label}」这个字段`);
  const select = flatten(field).find((element) => element.type === 'select');
  assert.notEqual(select, undefined, `「${label}」应当是一个下拉`);
  return select.children.map((child) => child.props.value);
}

/**
 * 从一份文案里抽出「每个窗口允许发多少次 `/usage`」。
 *
 * 五处文案的语序各不相同（`10 calls per 600s`、`每 600 秒 10 次`、`10 次 / 10 分钟`、
 * `10 requests / 10 minutes`、`10-per-10-minutes`），因此每种写法一条正则。正则只规定
 * **语序与单位词**，数字一个都不写死——期望值由常量算出，于是「改了常量、文案停在旧数字」
 * 这条漂移必然被抓住。
 *
 * @param text - 文件全文。
 * @returns `{ calls, windowMs, text }[]`，按扫描顺序。
 */
function quotaNumbersIn(text) {
  const patterns = [
    { re: /(\d+) calls per (\d+)s/gu, unitMs: 1_000, callsFirst: true },
    { re: /每 (\d+) 秒 (\d+) 次/gu, unitMs: 1_000, callsFirst: false },
    { re: /(\d+) 次 \/ (\d+) 分钟/gu, unitMs: 60_000, callsFirst: true },
    { re: /(\d+) requests \/ (\d+) minutes/gu, unitMs: 60_000, callsFirst: true },
    { re: /(\d+)-per-(\d+)-minutes/gu, unitMs: 60_000, callsFirst: true },
  ];
  const found = [];
  for (const { re, unitMs, callsFirst } of patterns) {
    for (const match of text.matchAll(re)) {
      const first = Number(match[1]);
      const second = Number(match[2]);
      found.push({
        calls: callsFirst ? first : second,
        windowMs: (callsFirst ? second : first) * unitMs,
        text: match[0],
      });
    }
  }
  return found;
}

/**
 * 数词到数字。计费文案里两种写法都有：正文用阿拉伯数字（`每 5 个`），而 `five-URL`、
 * `every fifth`、`每第五次` 用的是词。守卫两种都要认，否则改常量时那几处会静默留在旧数字上。
 */
const NUMBER_WORDS = Object.freeze({
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
});

/**
 * 把文案里捕获到的「数字或数词」解析成数字。
 *
 * 解析不出来时断言失败而不是跳过：那说明文案被改写成了守卫不认识的写法，而静默跳过等于
 * 把这条对账悄悄关掉。
 *
 * @param token - 捕获到的片段。
 * @returns 数字。
 */
function numberOf(token) {
  if (/^\d+$/u.test(token)) return Number(token);
  const value = NUMBER_WORDS[token.toLowerCase()];
  assert.notEqual(value, undefined, `不认识这个数词：${token}`);
  return value;
}

/**
 * 计费文案的副本清单：每条给出「数字出现的语序」与「每个捕获组扮演的角色」。
 *
 * 角色到期望值的映射在用例里由 `lib/constants.js` 算出。没列入的只有两类，都不在这张表里：
 * 派生出来的修辞句（`drain it five times faster`、`快五倍地掉`），以及 `account.plan_limit`
 * 那个官方实测值（`1000`）——前者不是规则陈述，后者根本不是本仓库的常量。
 */
const BILLING_COPY = Object.freeze([
  {
    file: 'lib/client.js',
    label: '中文抓取提示',
    pattern: /每 (\S+) 个成功抽取的 URL 计 (\S+) 积分（advanced 计 (\S+)）/gu,
    roles: ['tierUrls', 'basicCredits', 'advancedCredits'],
  },
  {
    file: 'lib/client.js',
    label: '英文抓取提示',
    pattern: /Every (\S+) successful URLs cost (\S+) credit \(advanced costs (\S+)\)/gu,
    roles: ['tierUrls', 'basicCredits', 'advancedCredits'],
  },
  {
    file: 'lib/settings.js',
    label: '抓取深度描述',
    pattern: /每 (\S+) 个成功 URL 分别计 (\S+) \/ (\S+) 积分/gu,
    roles: ['tierUrls', 'basicCredits', 'advancedCredits'],
  },
  {
    file: 'docs/usage.md',
    label: '抓取计费行',
    pattern: /every \*\*(\S+) successful\*\* URL extractions cost (\S+) credit \(`basic`\) or (\S+)/gu,
    roles: ['tierUrls', 'basicCredits', 'advancedCredits'],
  },
  { file: 'docs/usage.md', label: 'five-URL 计数器', pattern: /the (\S+)-URL counter/gu, roles: ['tierUrls'] },
  {
    file: 'docs/usage.md',
    label: 'every fifth 那句',
    pattern: /every (\S+) successful fetch crosses a tier/gu,
    roles: ['tierUrls'],
  },
  {
    file: 'docs/usage.zh-CN.md',
    label: '抓取计费行',
    pattern: /每 \*\*(\S+) 个成功抓取\*\*的 URL 计 (\S+) 积分（`basic`）或 (\S+) 积分/gu,
    roles: ['tierUrls', 'basicCredits', 'advancedCredits'],
  },
  {
    file: 'docs/usage.zh-CN.md',
    label: '「每 N 个成功 URL」的 N',
    pattern: /「每 (\S+) 个成功 URL」的 (\S+)/gu,
    roles: ['tierUrls', 'tierUrls'],
  },
  {
    file: 'docs/usage.zh-CN.md',
    label: '每第 N 次那句',
    pattern: /每第(\S+)次成功抓取/gu,
    roles: ['tierUrls'],
  },
  // ⚠️ 两份 README **不再有**计费数字的副本（2026-09-20 决定）：它们先前各有一条
  // 「每 5 个成功 URL 计 1 / 2 积分」的功能说明，而那正是「插件自己算积分」时代的产物。
  // 现在插件不做任何记账，README 的功能列表改为指向官方 `/usage` 读数，计费规则只在
  // `docs/usage*.md` 里作为**背景知识**保留（并继续被下面的条目守着）。因此这里不再
  // 为 README 设守卫——守一个不存在的副本只会得到一条「正则与文案脱节」的假警报。
]);

describe('22-E3：客户端副本与权威常量对账', () => {
  test('五份词表逐项等于权威导出（client-artifact-5）', async () => {
    const { component, t } = await mountedCard({ hooks: { ui: readyUi(), draft: readyDraft() } });
    const tree = component({ t });

    // 判据是权威模块的导出，不是另一份手抄副本：`lib/settings.js` 的 `schema.union([...])`
    // 取的就是这几个数组，`lib/constants.js` 那两个同理。
    const vocabulary = [
      ['searchDepth', SEARCH_DEPTH_VALUES],
      ['topic', TOPIC_VALUES],
      ['schedulingPolicy', SCHEDULING_POLICY_VALUES],
      ['fetchDepth', EXTRACT_DEPTH_VALUES],
      ['fetchFormat', EXTRACT_FORMAT_VALUES],
    ];

    for (const [field, values] of vocabulary) {
      // 服务端多一个合法取值时，副本少一项的那个 select 会静默显示成列表第一项：draft 仍持
      // 真实值、dirty 为 false、保存按钮是灰的，用户既看不出不对也改不回来。
      assert.deepEqual(optionsOfField(tree, t(field)), [...values], `${field} 的词表副本与权威不一致`);
    }
  });

  test('maxResults 的区间与 schema 的上下界一致（client-artifact-5）', async () => {
    const range = `${MAX_RESULTS_MIN}–${MAX_RESULTS_MAX}`;
    const { component, t } = await mountedCard({ hooks: { ui: readyUi(), draft: readyDraft() } });
    const tree = component({ t });
    const input = flatten(tree).find((element) => element.props?.type === 'number');

    assert.notEqual(input, undefined, '结果条数应当是一个数字输入框');
    assert.equal(input.props.min, String(MAX_RESULTS_MIN));
    assert.equal(input.props.max, String(MAX_RESULTS_MAX));
    assert.equal(textsOf(tree).some((text) => text.includes(`取值 ${range}。`)), true, '合法时显示区间');

    // 放宽区间时相反的后果：副本把 schema 允许的新取值判为非法，保存按钮变灰，并显示一句
    // 已经不正确的话。取一个必然越界的值，那句提示里的区间同样得由常量算出来。
    const invalid = await mountedCard({
      hooks: { ui: readyUi(), draft: { ...readyDraft(), maxResults: String(MAX_RESULTS_MAX + 1) } },
    });
    assert.equal(
      textsOf(invalid.component({ t: invalid.t })).some((text) => text.includes(`结果条数必须是 ${range} 之间的整数。`)),
      true,
      '非法时的提示也要说同一个区间',
    );
  });

  test('配额数字的每一处文案副本都与 USAGE_QUOTA_* 一致（boundaries-drift-5）', async () => {
    const files = ['lib/panel.js', 'lib/client.js', 'README.md', 'README.zh-CN.md', 'docs/usage.md', 'docs/usage.zh-CN.md'];

    for (const file of files) {
      const found = quotaNumbersIn(await readFile(join(repoRoot, file), 'utf8'));
      assert.notEqual(found.length, 0, `${file} 里一句配额文案都没扫到，说明守卫的正则已经与文案脱节`);

      for (const entry of found) {
        assert.equal(entry.calls, USAGE_QUOTA_MAX_CALLS, `${file} 的「${entry.text}」与 USAGE_QUOTA_MAX_CALLS 不一致`);
        assert.equal(entry.windowMs, USAGE_QUOTA_WINDOW_MS, `${file} 的「${entry.text}」与 USAGE_QUOTA_WINDOW_MS 不一致`);
      }
    }
  });

  test('计费数字的每一处文案副本都与计费常量一致（boundaries-drift-5）', async () => {
    const expected = {
      tierUrls: EXTRACT_URLS_PER_CREDIT_TIER,
      basicCredits: BASIC_EXTRACT_CREDITS_PER_FIVE,
      advancedCredits: ADVANCED_EXTRACT_CREDITS_PER_FIVE,
    };

    for (const { file, label, pattern, roles } of BILLING_COPY) {
      const matches = [...(await readFile(join(repoRoot, file), 'utf8')).matchAll(pattern)];
      assert.notEqual(matches.length, 0, `${file} 的${label}没扫到，说明守卫的正则已经与文案脱节`);

      for (const match of matches) {
        assert.equal(match.length - 1, roles.length, `${file} 的${label}捕获组数与角色数对不上`);
        match.slice(1).forEach((token, index) => {
          const role = roles[index];
          assert.equal(numberOf(token), expected[role], `${file} 的${label}里「${token}」与 ${role} 不一致`);
        });
      }
    }
  });
});
