/**
 * 时间预算：常量之间的自洽、与宿主真实绑定值的对账，以及「按宿主值折算预算」本身
 * （`FETCH-4`、`SCHED-9`、`REST-10`）。
 *
 * 这些断言守的是同一类症状：**用户等到的是一条宿主超时，而不是上游的真实错误**。它最难从
 * 日志里认出来，因为那次调用看上去只是「失败了」——失败的原因却被换掉了。
 *
 * 本文件分四层，越往下越靠近真宿主：
 *
 * 1. **常量之间**：预算是多少、等待能从里面分走多少、单次尝试与余量装不装得进去。宿主不在场
 *    时也成立。
 * 2. **宿主真实产物对账**：从 `dsh-base/cordis.patch.yml` 里机械解析 `tool-web` 那一行，并读
 *    `@deepseek-ai/dsh-tool-web` 的配置 schema 默认值，得到宿主**今天真正绑定**的两个
 *    `timeoutMs`，再与 {@link SEARCH_TOTAL_BUDGET_MS} / {@link FETCH_TOTAL_BUDGET_MS} 对账。
 *    审计 `host-contract-2` 之前，这一层是把宿主数字**抄在测试文件里**的：断言的是「我们的
 *    常量 < 我们的常量」，宿主改默认值或被部署覆盖时它不会变红。
 * 3. **单次调用预算的读取**：`readHostToolBudgetMs` 的三档（`host` / `unbound` / `unavailable`）。
 * 4. **由宿主预算折算总预算**：`effectiveBudgetMs` 的两种来源、余量与收敛。
 *
 * 第 2 层需要宿主的安装根，解析链见 {@link resolveHostRoot}。**解析不到就抛错，不跳过**——
 * 静默跳过正是这一层要消灭的那类守卫；宿主不在场时设 `DSH_HOST_ROOT` 指向含
 * `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-tool-web` 的那个 `node_modules`。
 *
 * 这两个包都不是本包的依赖（本包只依赖 seam 与两个提供方包），因此**静态** `import` 在本仓库
 * 里解析不到；第 2 层因此按解析出的绝对路径动态读宿主自己那份安装。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { describe } from 'node:test';

import { effectiveBudgetMs, readHostToolBudgetMs } from '../lib/dsh/host-budget.js';
import { resolveHostRoot } from './host-install.mjs';
import {
  FETCH_TOTAL_BUDGET_MS,
  HOST_BUDGET_MARGIN_MS,
  MIN_ATTEMPT_TIMEOUT_MS,
  SEARCH_TOTAL_BUDGET_MS,
  TAVILY_TIMEOUT_MS,
  WAIT_BUDGET_MS,
  WAIT_BUDGET_SHARE,
} from '../lib/constants.js';

const require = createRequire(import.meta.url);

/** 宿主安装根必须同时具备的两个标记文件（相对根目录）。 */
const HOST_MARKERS = [
  join('@deepseek-ai', 'dsh-base', 'cordis.patch.yml'),
  join('@deepseek-ai', 'dsh-tool-web', 'package.json'),
];

/**
 * 从宿主组合文件里机械取出 `tool-web` 那一行绑定的超时。
 *
 * 只认这一行的**块**：从 `- id: tool-web` 起，到第一个缩进不深于它的非空行为止；块内按
 * `键: 数字` 取值。这样 `fetch` 之类的同级配置不会被误读，也不会因为文件里别处有同名的键而
 * 串味。刻意不引 YAML 依赖：要读的只是两行，而引一份解析器意味着把宿主文件的语法当成本包的
 * 契约。
 *
 * @param patchText - `dsh-base/cordis.patch.yml` 的全文。
 * @returns `{ searchTimeoutMs?, fetchTimeoutMs? }`；未绑定的键不出现。
 * @throws {Error} 文件里没有 `tool-web` 行时抛出——参照物消失也是守卫该红的时候。
 */
function parseToolWebRow(patchText) {
  const lines = patchText.split('\n');
  const start = lines.findIndex((line) => /^[ \t]*-[ \t]*id:[ \t]*tool-web[ \t]*$/.test(line));
  if (start === -1) {
    throw new Error('dsh-tavily-pool: the host composition file has no "- id: tool-web" row; the timeout guard lost its reference');
  }

  const indent = lines[start].search(/\S/);
  const block = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '') continue;
    if (lines[index].search(/\S/) <= indent) break;
    block.push(lines[index]);
  }

  const text = block.join('\n');
  const read = (key) => {
    const match = new RegExp(`^[ \\t]*${key}:[ \\t]*(\\d+)[ \\t]*$`, 'm').exec(text);
    if (match === null) return undefined;
    const value = Number(match[1]);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };

  return { searchTimeoutMs: read('searchTimeoutMs'), fetchTimeoutMs: read('fetchTimeoutMs') };
}

/**
 * 宿主**今天真正绑定**的两个预算。
 *
 * `searchTimeoutMs` / `fetchTimeoutMs` 在组合文件里可能缺席，缺席时生效的是
 * `dsh-tool-web` 的 schema 默认值（`DEFAULT_WEB_TOOL_TIMEOUT_MS`）。两者都从宿主自己那份
 * 安装里读：前者解析组合文件，后者动态 import 宿主包，经 `Config({})` 取 schema 解析出的
 * 默认值——测试里因此没有任何抄来的宿主数字。
 *
 * 结果记忆化，免得每个用例都重新 import 一次宿主包。
 *
 * @returns Promise，解析为 `{ root, patchPath, searchTimeoutMs, fetchTimeoutMs }`。
 */
let hostTruthPromise;
function hostTruth() {
  hostTruthPromise ??= (async () => {
    const root = resolveHostRoot({
      markers: HOST_MARKERS,
      what: 'the tool-timeout guard',
    });
    const patchPath = join(root, HOST_MARKERS[0]);
    const row = parseToolWebRow(readFileSync(patchPath, 'utf8'));

    const hostRequire = createRequire(join(root, 'index.js'));
    const toolWeb = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-tool-web')).href);
    const defaults = toolWeb.Config({});

    return {
      root,
      patchPath,
      searchTimeoutMs: row.searchTimeoutMs ?? defaults.searchTimeoutMs,
      fetchTimeoutMs: row.fetchTimeoutMs ?? defaults.fetchTimeoutMs,
    };
  })();

  return hostTruthPromise;
}

/**
 * 造一个只提供 `tools` 的 context 替身。
 *
 * `get` 把每次入参原样记进 `calls`，因此用例能断言「我们只按工具名读、没有带 agent scope」。
 *
 * @param definitions - 全局视图：工具名到定义的映射。
 * @returns `{ ctx, calls }`。
 */
function toolsContext(definitions) {
  const calls = [];
  const tools = {
    get(...args) {
      calls.push(args);
      return definitions[args[0]];
    },
  };
  return { ctx: { get: (name) => (name === 'tools' ? tools : undefined) }, calls };
}

describe('时间预算自洽（常量之间）', () => {
  test('单次尝试的超时不超过两条总预算', () => {
    // 20 秒的单次超时是 `FETCH-4` 的硬要求；它还必须装得进抓取那条更紧的总预算里，否则第一次
    // 尝试就吃光全部时间，故障切换形同不存在。
    assert.ok(TAVILY_TIMEOUT_MS <= FETCH_TOTAL_BUDGET_MS);
    assert.ok(TAVILY_TIMEOUT_MS <= SEARCH_TOTAL_BUDGET_MS);
  });

  test('等待额度是总预算的一部分，且给真正的请求留出至少一半', () => {
    assert.ok(WAIT_BUDGET_SHARE > 0 && WAIT_BUDGET_SHARE <= 0.5);
    // 折算后的等待上限在抓取那条预算下必须小于它本身——`min(WAIT_BUDGET_MS, 预算 × 份额)`。
    const fetchWaitCeiling = Math.min(WAIT_BUDGET_MS, FETCH_TOTAL_BUDGET_MS * WAIT_BUDGET_SHARE);
    assert.ok(fetchWaitCeiling < FETCH_TOTAL_BUDGET_MS);
  });

  test('保底尝试时间装得进总预算', () => {
    // `MIN_ATTEMPT_TIMEOUT_MS` 是「宁可略微超出总预算也要让最后一次尝试真的发生」的那条保底，
    // 但它不该本身就是个会把预算一次吃光的数。
    assert.ok(MIN_ATTEMPT_TIMEOUT_MS < FETCH_TOTAL_BUDGET_MS);
  });

  test('留给收尾的余量是正数，且装得进两条预算', () => {
    // 余量若为 0，折算出的预算就等于宿主的 deadline——那正是审计 `host-contract-2` 记下的
    // 情形：宿主的超时顶掉上游的真实错误。余量若大过预算，预算会被压到 1 毫秒，等于取消调用。
    assert.ok(HOST_BUDGET_MARGIN_MS > 0);
    assert.ok(HOST_BUDGET_MARGIN_MS < FETCH_TOTAL_BUDGET_MS);
    assert.ok(HOST_BUDGET_MARGIN_MS < SEARCH_TOTAL_BUDGET_MS);
  });
});

describe('与宿主真实绑定值对账', () => {
  test('搜索的总预算就是宿主组合文件里绑定的那个值', async () => {
    const truth = await hostTruth();
    assert.equal(
      SEARCH_TOTAL_BUDGET_MS,
      truth.searchTimeoutMs,
      `搜索总预算 ${String(SEARCH_TOTAL_BUDGET_MS)} 与宿主 ${truth.patchPath} 绑定的 ${String(truth.searchTimeoutMs)} 不一致`,
    );
  });

  test('抓取的总预算严格低于宿主为 web_fetch 绑定的值', async () => {
    const truth = await hostTruth();
    // 抓取若沿用搜索的 60 秒，等待上限会折算成 30 秒——**一项就吃掉宿主的全部预算**，随后的
    // 尝试还没发出去就被掐断。这条断言按宿主当场的值算，而不是按抄下来的 30 秒。
    assert.ok(
      FETCH_TOTAL_BUDGET_MS < truth.fetchTimeoutMs,
      `抓取总预算 ${String(FETCH_TOTAL_BUDGET_MS)} 必须小于宿主绑定的 ${String(truth.fetchTimeoutMs)}（${truth.patchPath}）`,
    );
  });

  test('按宿主绑定值折算后的两条预算都严格早于宿主的 deadline', async () => {
    // ⚠️ **这条是漂移守卫，不是「接线对了」的判据。** 它调的是我们自己的 `effectiveBudgetMs`
    // 并只喂进从宿主 patch 读到的数值，因此把 `index.js` 的 `budgetFor` 改成忽略宿主时它照样
    // 全绿——真正的判据在 `test/entry.test.js` 的 `host-contract-2` 组（真计时：让 fetch 挂着，
    // 看它多久被宿主绑定的那个 `timeoutMs` 中止）。这里盯的是另一半：常量与折算规则**自身**
    // 与宿主当场的值自洽（宿主把 `searchTimeoutMs` 调小、或有人改了余量，这里先红）。
    const truth = await hostTruth();
    for (const [toolName, hostMs, fallbackMs] of [
      ['web_search', truth.searchTimeoutMs, SEARCH_TOTAL_BUDGET_MS],
      ['web_fetch', truth.fetchTimeoutMs, FETCH_TOTAL_BUDGET_MS],
    ]) {
      const { budgetMs, source } = effectiveBudgetMs({ hostMs, fallbackMs, marginMs: HOST_BUDGET_MARGIN_MS });
      // `source` 必须是 host：落在常量上说明我们根本没读到宿主绑定的值，那时「严格早于」
      // 只是巧合，而不是这条路径成立的理由。
      assert.equal(source, 'host', `${toolName} 没有按宿主绑定值折算预算`);
      assert.ok(budgetMs < hostMs, `${toolName} 的预算 ${String(budgetMs)} 不早于宿主的 ${String(hostMs)}`);
    }
  });
});

describe('readHostToolBudgetMs：单次调用预算的读取', () => {
  test('读到工具定义上的 timeoutMs 时按 host 报出', () => {
    const { ctx } = toolsContext({ web_search: { name: 'web_search', timeoutMs: 60_000 } });
    assert.deepEqual(readHostToolBudgetMs(ctx, 'web_search'), { timeoutMs: 60_000, source: 'host' });
  });

  test('工具定义在但没有 timeoutMs 时按 unbound 报出', () => {
    // 宿主策略是 `ctx.tools.get(name, agent)?.timeoutMs`，读不到就直接 `next()`——即不武装
    // deadline。此时没有可跟随的预算，只能按常量排布。
    const { ctx } = toolsContext({ web_search: { name: 'web_search' } });
    assert.deepEqual(readHostToolBudgetMs(ctx, 'web_search'), { source: 'unbound' });
  });

  test('工具在全局视图里没有注册时按 unbound 报出', () => {
    const { ctx } = toolsContext({});
    assert.deepEqual(readHostToolBudgetMs(ctx, 'web_fetch'), { source: 'unbound' });
  });

  test('timeoutMs 不是有限正数时一律按 unbound 报出', () => {
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { ctx } = toolsContext({ web_fetch: { timeoutMs } });
      assert.deepEqual(
        readHostToolBudgetMs(ctx, 'web_fetch'),
        { source: 'unbound' },
        `timeoutMs = ${String(timeoutMs)} 不该被当成宿主绑定值`,
      );
    }
  });

  test('tools 服务读不到时按 unavailable 报出', () => {
    const { ctx } = toolsContext({});
    assert.deepEqual(readHostToolBudgetMs({ get: () => undefined }, 'web_search'), { source: 'unavailable' });
    // 服务缺席与「工具缺席」不是一回事：前者连问都问不到，后者问到了、只是没绑 deadline。
    assert.deepEqual(readHostToolBudgetMs(ctx, 'web_search'), { source: 'unbound' });
  });

  test('ctx.get 抛错（未 inject）时按 unavailable 报出，而不是让读取本身炸掉', () => {
    const ctx = {
      get() {
        throw new Error('cannot get property "tools" without inject');
      },
    };
    assert.deepEqual(readHostToolBudgetMs(ctx, 'web_search'), { source: 'unavailable' });
  });

  test('只按工具名读全局视图，不带 agent scope', () => {
    const { ctx, calls } = toolsContext({ web_search: { timeoutMs: 60_000 } });
    readHostToolBudgetMs(ctx, 'web_search');
    // `tools.get(name, scope)` 的 scope 是发起调用的 agent；提供方手里没有它，猜一个比读不到更糟
    // （见 lib/dsh/host-budget.js 的模块说明）。
    assert.deepEqual(calls, [['web_search']]);
  });
});

describe('effectiveBudgetMs：由宿主预算折算总预算', () => {
  test('宿主绑定值是预算的来源，且比它小一个余量', () => {
    assert.deepEqual(
      effectiveBudgetMs({ hostMs: 60_000, fallbackMs: SEARCH_TOTAL_BUDGET_MS, marginMs: HOST_BUDGET_MARGIN_MS }),
      { budgetMs: 60_000 - HOST_BUDGET_MARGIN_MS, source: 'host' },
    );
  });

  test('宿主把 web_fetch 收紧到 15 秒时，预算跟着缩到它以内', () => {
    // 审计 `host-contract-2` 的复现时间线：宿主 deadline 15 秒、插件仍按 25 秒排布，于是模型
    // 看到的是 `tool call timed out after 15000ms` 而不是上游的真实错误。
    const { budgetMs, source } = effectiveBudgetMs({
      hostMs: 15_000,
      fallbackMs: FETCH_TOTAL_BUDGET_MS,
      marginMs: HOST_BUDGET_MARGIN_MS,
    });
    assert.equal(source, 'host');
    assert.ok(budgetMs < 15_000, `收紧后预算 ${String(budgetMs)} 仍不早于宿主的 15000`);
  });

  test('没有宿主绑定值时用常量，并把这件事说成 constant', () => {
    for (const hostMs of [undefined, 0, Number.NaN]) {
      assert.deepEqual(
        effectiveBudgetMs({ hostMs, fallbackMs: FETCH_TOTAL_BUDGET_MS, marginMs: HOST_BUDGET_MARGIN_MS }),
        { budgetMs: FETCH_TOTAL_BUDGET_MS, source: 'constant' },
        `hostMs = ${String(hostMs)} 时应当回落到常量`,
      );
    }
  });

  test('余量比宿主绑定值还大时收敛到 1 毫秒，而不是 0 或负数', () => {
    // 0 毫秒的预算等于取消这次调用，而不是保护它；真到这一步该被看见的是那份部署配置。
    assert.deepEqual(
      effectiveBudgetMs({ hostMs: 1_000, fallbackMs: SEARCH_TOTAL_BUDGET_MS, marginMs: HOST_BUDGET_MARGIN_MS }),
      { budgetMs: 1, source: 'host' },
    );
  });

  test('三档读取各自的折算结果：host 跟随宿主，unbound 与 unavailable 都用常量', () => {
    const wiring = (definitions) => {
      const { ctx } = toolsContext(definitions);
      const { timeoutMs } = readHostToolBudgetMs(ctx, 'web_search');
      return effectiveBudgetMs({
        hostMs: timeoutMs,
        fallbackMs: SEARCH_TOTAL_BUDGET_MS,
        marginMs: HOST_BUDGET_MARGIN_MS,
      });
    };

    assert.deepEqual(wiring({ web_search: { timeoutMs: 45_000 } }), { budgetMs: 43_000, source: 'host' });
    assert.deepEqual(wiring({ web_search: {} }), { budgetMs: SEARCH_TOTAL_BUDGET_MS, source: 'constant' });
    assert.deepEqual(
      effectiveBudgetMs({
        hostMs: readHostToolBudgetMs({ get: () => undefined }, 'web_search').timeoutMs,
        fallbackMs: SEARCH_TOTAL_BUDGET_MS,
        marginMs: HOST_BUDGET_MARGIN_MS,
      }),
      { budgetMs: SEARCH_TOTAL_BUDGET_MS, source: 'constant' },
    );
  });
});
