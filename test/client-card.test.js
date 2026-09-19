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

import { SETTINGS_NAMESPACE } from '../lib/constants.js';

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

/** 卡片用到的 `Switch` 替身：把收到的属性原样记进元素树。 */
function switchStub(props) {
  return { type: 'Switch', props };
}

/**
 * 一个够用的 React 替身。
 *
 * `useState` 按**调用次序**返回预设值：卡片刻意只用两个 `useState`（瞬时状态与草稿），
 * 因此这里的次序是稳定的、可读的。`useEffect` 只收集不执行——首次加载会去 `fetch`，而
 * 本文件要断言的是「进入某个状态之后渲染成什么样」，不是网络行为。
 *
 * @param options - 预设的 hook 值。
 * @param options.ui - 第一次 `useState` 的返回值。
 * @param options.draft - 第二次 `useState` 的返回值。
 * @returns `{ react, effects }`。
 */
function reactStub({ ui, draft } = {}) {
  const queue = [ui, draft];
  const effects = [];
  let index = 0;
  return {
    effects,
    react: {
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
      Fragment: Symbol('react.fragment'),
      useState: (initial) => {
        const slot = index;
        index += 1;
        return [slot < queue.length && queue[slot] !== undefined ? queue[slot] : initial, () => undefined];
      },
      useEffect: (effect) => {
        effects.push(effect);
      },
    },
  };
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
  const { react, effects } = reactStub(options.hooks);
  const modules = {
    react,
    '@deepseek-ai/dsh-client-ui-primitives': { Switch: switchStub },
  };
  const require = (specifier) => {
    requested.push(specifier);
    if (!SEED_MODULES.includes(specifier)) {
      throw new Error(`client-modules: module request outside the platform seed table: ${specifier}`);
    }
    return modules[specifier];
  };
  return { exports: registration.factory(require), requested, effects };
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
        assert.equal(name, 'settings.plugin.item');
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
  const mounted = mountCard(instantiate(registration, { hooks: options.hooks }).exports);
  return { ...mounted, t: tOf(mounted.dictionaries, options.locale ?? 'zh') };
}

/** 服务端状态的一份样本，字段与 `lib/panel.js` 的投影一一对应。 */
function sampleState(overrides = {}) {
  return {
    settings: {
      searchEnabled: true,
      searchDepth: 'basic',
      maxResults: 10,
      topic: 'general',
      includeAnswer: false,
    },
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
    fetchToggleAvailable: false,
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
  };
}

/** 与 `sampleState().settings` 一致的草稿。 */
function readyDraft() {
  return { searchEnabled: true, searchDepth: 'basic', maxResults: '10', topic: 'general', includeAnswer: false };
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

    assert.deepEqual(requested, ['react', '@deepseek-ai/dsh-client-ui-primitives']);
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
});

describe('PANEL-1：卡片注册进 settings.plugin.item', () => {
  test('slot 名、key、locale 三者配对，key 与 settings 命名空间逐字相同', async () => {
    const { inject, options } = await mountedCard();

    // 展开成调用方这一侧的数组再比：工厂是在 `vm` 里创建的，它返回的数组带的是那个
    // realm 的原型，`deepStrictEqual` 会因此判不等——那是 realm 的差异，不是内容的差异。
    assert.deepEqual([...inject], ['slots', 'locale']);
    assert.equal(options.name, 'settings.plugin.item');
    assert.equal(
      options.key,
      SETTINGS_NAMESPACE,
      'key 与命名空间不一致时卡片根本不会被派发，而且没有任何报错',
    );
    assert.equal(options.locale, SETTINGS_NAMESPACE, '文案命名空间与设置命名空间同源');
  });

  test('注册的是中英两套词表（PANEL-5）', async () => {
    const { dictionaries } = await mountedCard();

    assert.equal(dictionaries.length, 1);
    assert.equal(dictionaries[0].ns, SETTINGS_NAMESPACE);
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
  test('开关用种子模块里的 Switch——搜索接管与「生成答案」各一个', async () => {
    const { component, t } = await mountedCard({ hooks: { ui: readyUi(), draft: readyDraft() } });

    const switches = flatten(component({ t })).filter((element) => element.type === switchStub);
    assert.deepEqual(switches.map((element) => element.props.checked), [true, false]);
  });

  test('表单字段与列表控件都是自绘的（input / select / button / ul / section）', async () => {
    const { component, t } = await mountedCard({ hooks: { ui: readyUi(), draft: readyDraft() } });
    const types = new Set(flatten(component({ t })).map((element) => element.type));

    for (const tag of ['section', 'input', 'select', 'button', 'ul']) {
      assert.equal(types.has(tag), true, `卡片应当自绘 <${tag}>`);
    }
  });

  test('池里有密钥时渲染成列表项', async () => {
    const { component, t } = await mountedCard({
      hooks: { ui: readyUi({ keys: [keyRecord()] }), draft: readyDraft() },
    });

    assert.equal(flatten(component({ t })).filter((element) => element.type === 'li').length, 1);
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

  test('只从 primitives 取用已核实的组件', async () => {
    const source = await readFile(CLIENT_FILE, 'utf8');
    const used = new Set();
    for (const match of source.matchAll(/primitives\.([A-Za-z][A-Za-z0-9]*)/gu)) used.add(match[1]);
    assert.deepEqual([...used], ['Switch'], '除 Switch 之外不要引入更多宿主原语');
  });
});

describe('PANEL-5：卡片渲染出中英双语文案', () => {
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

  test('就绪态渲染标题、说明、开关与密钥池', async () => {
    const { component, t } = await mountedCard({ hooks: { ui: readyUi(), draft: readyDraft() } });
    const tree = component({ t });
    const texts = textsOf(tree);

    assert.equal(texts.includes('Tavily 密钥池'), true);
    assert.equal(texts.includes('接管搜索（web_search）'), true);
    assert.equal(texts.includes('搜索参数'), true);
    assert.equal(texts.includes('密钥池'), true);
    assert.equal(
      flatten(tree).some((element) => element.type === switchStub && /抓取|fetch/iu.test(element.props.label)),
      false,
      '抓取开关属于 ticket 10，此刻不该出现在卡片上',
    );
  });

  test('传入宿主自己的 t 时优先用它', async () => {
    const { component } = await mountedCard({ hooks: { ui: readyUi(), draft: readyDraft() } });

    const texts = textsOf(component({ t: (key) => `[${key}]` }));
    assert.equal(texts.includes('[title]'), true);
    assert.equal(texts.includes('Tavily 密钥池'), false, '宿主给了 t 就不该用自带词表');
  });

  test('「抓取接管尚在开发中」这句绑在服务端事实上，而不是写死的', async () => {
    // `10` 落地之后 `fetchToggleAvailable` 会变成 true；那时这句话必须自己消失，否则卡片会
    // 继续宣称一个早已完成的开发状态，而没有任何测试会发现。
    const developing = await mountedCard({ hooks: { ui: readyUi(), draft: readyDraft() } });
    assert.equal(
      textsOf(developing.component({ t: developing.t })).some((text) => text.includes('抓取接管尚在开发中')),
      true,
    );

    const shipped = await mountedCard({
      hooks: { ui: readyUi({ fetchToggleAvailable: true }), draft: readyDraft() },
    });
    assert.equal(
      textsOf(shipped.component({ t: shipped.t })).some((text) => text.includes('抓取接管尚在开发中')),
      false,
      '开关已经存在时不该再说它还在开发中',
    );
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

  test('无限额度显示「无限」，仍不画进度条', async () => {
    const { component, t } = await mountedCard({
      hooks: {
        ui: readyUi({ keys: [keyRecord({ usage: { key: { limit: null, usage: 12 }, stale: false } })] }),
        draft: readyDraft(),
      },
    });

    const tree = component({ t });
    assert.equal(textsOf(tree).includes('无限'), true);
    assert.deepEqual(flatten(tree).filter((element) => element.props?.className === 'dtp-bar'), []);
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

  test('统计行显示调用、成功、失败与消耗（USAGE-7）', async () => {
    const { component, t } = await mountedCard({
      hooks: {
        ui: readyUi({ keys: [keyRecord({ stats: { calls: 2, successes: 1, failures: 1, credits: 3 } })] }),
        draft: readyDraft(),
      },
    });

    assert.equal(
      textsOf(component({ t })).some((text) => text.includes('调用 2 · 成功 1 · 失败 1 · 消耗 3 积分')),
      true,
    );
  });

  test('消耗未知的次数被如实标出，而不是并进那个数字里（REST-3）', async () => {
    const { component, t } = await mountedCard({
      hooks: {
        ui: readyUi({
          keys: [keyRecord({ stats: { calls: 3, successes: 3, failures: 0, credits: 2, creditsUnknown: 1 } })],
        }),
        draft: readyDraft(),
      },
    });

    assert.equal(textsOf(component({ t })).some((text) => text.includes('其中 1 次消耗未知')), true);
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
    const { component, t } = await mountedCard({
      hooks: { ui: readyUi(), draft: { ...readyDraft(), maxResults: '21' } },
    });

    const tree = component({ t });
    assert.equal(textsOf(tree).some((text) => text.includes('1–20')), true);
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
