/**
 * 插件入口，经由替身宿主检验。
 *
 * 决定接管到底能不能成立的两条规则都在这里：注册必须先于任何可能失败的事，且
 * `available()` 绝不能返回 false。
 */

import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import { apply, inject, name } from '../index.js';
import { KEYS_FILE_NAME, PROVIDER_ID, SETTINGS_NAMESPACE, STATE_DIR_NAME } from '../lib/constants.js';
import { MissingHostCapabilityError } from '../lib/dsh/register.js';
import { officialFetchProvider, setOfficialFetchProvider } from '../lib/dsh/fallback.js';
import { maskKey } from '../lib/pool.js';

/**
 * 一个足以加载本插件的替身宿主 context。
 *
 * 它模仿真实 context 中本插件所依赖的两件事：服务经 `get(name)` 读取（即反射式
 * 读取，服务缺席时返回 `undefined`）；`ctx.logger` 是 context 的**自有属性**而不是
 * 提供的服务——真实宿主会把 `LoggerService` 构造到每个 context 上，于是
 * `ctx.get('logger')` 是 `undefined`，而 `ctx.logger.warn` 存在。这里搞错，就是探测
 * 结果被静默丢弃的原因。
 *
 * `harnessHome` 是宿主上报的 harness 主目录；插件会像真实解析器那样，在它后面接上
 * 自己的状态目录名，于是测试能把文件放在插件真正会去找的位置。
 *
 * settings 用一份可读写的内存值实现，形状与宿主一致：`register` 返回一个带 `get` 的
 * 句柄，写入经 `set`。这样「开关即时生效」就是可测的，而不是需要重启才知道的事。
 *
 * @param options - 宿主形状覆盖项。
 * @param options.harnessHome - `ctx.dshHomePath` 上报的 harness 主目录。
 * @param options.omitRegistration - 移除 seam 的注册函数。
 * @param options.settings - 命名空间的初始值。
 * @param options.environment - launcher 环境快照的内容；默认为空。
 * @param options.tools - 宿主的 `tools` 服务替身（形如 `{ get(name) }`）；省略表示这个宿主
 *   没有该服务，总预算退回本插件的常量（`host-contract-2`）。
 * @returns `{ ctx, registered, warnings, registerCalls, settings }`。
 */
function fakeHost({ harnessHome, omitRegistration = false, omitFetchRegistration = false, settings = {}, environment = {}, tools } = {}) {
  const registered = [];
  const registeredFetch = [];
  const warnings = [];
  const values = { ...settings };
  let registerCalls = 0;

  const services = {
    web: {
      registerSearchProvider(provider) {
        registerCalls += 1;
        registered.push(provider);
        return () => undefined;
      },
      // 抓取提供方单独收集：两个注册表在 seam 里本来就是分开的，混进一个数组会让
      // 「抓取注册失败时搜索仍在」这条断言无从写起。
      registerFetchProvider(provider) {
        registeredFetch.push(provider);
        return () => undefined;
      },
    },
    // 形状照抄真实的 settings 服务：`get(ns)` 读一个已注册命名空间的解析值，
    // `register(ns, schema)` 返回该命名空间所有者用的句柄。少了服务上的 `get`，
    // 插件会静默退回默认值——那正是这些测试要防的失败，不能让它出现在测试替身里。
    settings: {
      get: (namespace) => values[namespace],
      register: () => ({
        get: () => values[SETTINGS_NAMESPACE],
        set: (next) => {
          values[SETTINGS_NAMESPACE] = next;
        },
      }),
    },
    // 宿主的工具注册表（`host-contract-2`）。默认**不提供**：真实宿主里它由
    // `dsh-tools` 提供，而本替身此前完全没有它——那正是「总预算从不读宿主绑定值」
    // 这条缺陷在单测里没有判据的原因之一。要检验读取，就显式传一个进来。
    ...(tools === undefined ? {} : { tools }),
    clientModules: {},
    connection: { fetch: { register: () => async () => {} } },
    dshHomePath: (...segments) => join(harnessHome ?? '/nonexistent-home/.dsh', ...segments),
    // 宿主总会放一份 launcher 环境快照，因此替身也必须有——**而且默认是空的**。
    // `launchEnvironmentOf` 在快照缺席时会退回真实的 `process.env`，于是「本机没配
    // DEEPSEEK_API_KEY」这个环境偶然事实会变成回落用例的隐含前提：开发机上装了官方
    // 凭据，这些用例就会莫名其妙地红。默认空快照让结果只取决于测试自己给的东西。
    launchEnvironment: { get: (name) => environment[name] },
  };
  if (omitRegistration) delete services.web.registerSearchProvider;
  if (omitFetchRegistration) delete services.web.registerFetchProvider;

  const ctx = {
    get: (name) => services[name],
    services,
    // 与真实宿主同形的 `inject`：依赖齐全时**回调照跑，但不在同步栈上**；缺一个就永不跑。
    //
    // 「不在同步栈上」这一条是这张票（`22` 的 `test-blindspots-1`）补上的，也是最容易被
    // 替身抹掉的一条：真机实测（见 `lib/dsh/host-services.js`）`apply()` 在 `@+817ms` 就
    // 结束，而 `inject:settings` 到 `@+3385ms` 才跑——它排在**整个 profile 组合完成之后**。
    // 同前的替身在这里同步跑回调，于是「在注入回调里才成立的前置条件」这类缺陷在单测里
    // 永远隐形（bug #1 与 bug #4 都是这么来的）。回调用 `setTimeout` 推迟，比任何微任务
    // 都晚，因此 `apply()` 返回时五项服务一个都没绑上——要断言它们就调
    // {@link FakeHost#settleInjections}。
    //
    // 插件用 `ctx.inject` 取 `settings` / `connection` / `credentials`（见
    // `lib/dsh/host-services.js` 的实测表），因此替身少了这个方法，插件在真实宿主上会
    // 走通、在这里却直接抛——那正是替身最容易掩盖的一类失败。
    inject: (deps, callback) => {
      if (deps.every((name) => services[name] !== undefined)) {
        setTimeout(() => {
          callback(ctx);
        }, 0);
      }
      return { dispose: () => undefined };
    },
    // 自有属性，不是服务——因此刻意不出现在 `services` 里。
    logger: { warn: (message) => warnings.push(String(message)) },
  };

  return {
    ctx,
    registered,
    registeredFetch,
    warnings,
    registerCalls: () => registerCalls,
    /**
     * 等注入回调跑完。
     *
     * `setTimeout` 排在注入回调用以推迟自己的那个宏任务**之后**（定时器按到期时刻与入队
     * 顺序兑现），因此 `await` 它一次就足以看到回调的全部后果。
     *
     * @returns 无。
     */
    settleInjections: () => new Promise((resolve) => {
      setTimeout(resolve, 0);
    }),
    /** 改一个设置值，供「改动即时生效」的检验使用。 */
    setSettings: (next) => {
      values[SETTINGS_NAMESPACE] = { ...values[SETTINGS_NAMESPACE], ...next };
    },
  };
}

/**
 * 一个临时 harness 主目录，外加插件能找到的密钥池文件。
 *
 * @param contents - 密钥池文件的内容，需要在文件存在时给出。
 * @returns harness 主目录路径。
 */
async function temporaryHarnessHome(contents) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-tavily-pool-entry-'));
  const stateDir = join(home, STATE_DIR_NAME);
  if (contents !== undefined) {
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, KEYS_FILE_NAME), contents, 'utf8');
  }
  return home;
}

describe('插件形状', () => {
  test('声明对 web 的依赖，使服务重建后会重新注册', () => {
    assert.deepEqual(inject, ['web']);
    assert.equal(name, 'tavily-pool');
  });
});

describe('PIN-5 / 硬约束 5：注册发生在最前', () => {
  test('提供方以 profile patch pin 住的 id 注册', () => {
    const host = fakeHost();
    apply(host.ctx, {});

    assert.equal(host.registered.length, 1);
    assert.equal(host.registered[0].id, PROVIDER_ID);
    assert.equal(PROVIDER_ID, 'tavily');
  });

  test('注册之后的失败仍会让提供方保持已注册', () => {
    const host = fakeHost();
    // 用插件无法吞掉的方式弄坏后面某个初始化步骤：状态目录解析不出来，于是
    // `apply()` 会走它的 catch。
    host.ctx.services.dshHomePath = () => {
      throw new Error('simulated host failure');
    };
    delete process.env.DSH_HOME;
    const previousHome = process.env.HOME;
    process.env.HOME = '';

    try {
      apply(host.ctx, {});
    } finally {
      process.env.HOME = previousHome;
    }

    assert.equal(host.registered.length, 1, '提供方必须挺过初始化损坏');
    assert.equal(host.registered[0].available(), true);
    assert.match(host.warnings.join('\n'), /initialization failed/u, '并且该失败必须被上报');
  });

  test('logger 损坏绝不会成为搜索失败的原因', async () => {
    // **这条用例名承诺的是「搜索照常」，而正文此前只断言 `apply()` 不抛**（ticket `22` 的
    // `test-blindspots-7`）——把一处裸 `ctx.logger.warn(...)` 加进搜索路径，这条用例照样
    // 全绿，因为它一次 `search` 都没跑。日志按定义是尽力而为的，而 `report()` 的 `try` 就是
    // 那条承诺的实现，因此判据只能是「跑一次搜索，而且它真的记过日志」。
    //
    // 一份坏掉的 `keys.json` 同时满足这两个条件：加载期与每次搜索各有一条告警（`POOL-7`），
    // 而搜索本身照常回落、照常返回结果——那条回落**成功**的日志同样只经 `report()` 出去。
    const home = await temporaryHarnessHome('{ this is not json');
    const host = fakeHost({ harnessHome: home });
    const warnings = [];
    host.ctx.logger = {
      warn(message) {
        warnings.push(String(message));
        throw new Error('simulated logger failure');
      },
    };

    assert.doesNotThrow(() => {
      apply(host.ctx, {});
    });
    assert.equal(host.registered.length, 1);

    const error = await host.registered[0]
      .search({ query: 'q' })
      .then(() => undefined, (thrown) => thrown);

    assert.equal(
      error?.code,
      'TAVILY_FALLBACK_CREDENTIAL_MISSING',
      '搜索必须照常走到回落那条路上，而不是被坏 logger 打断',
    );
    assert.ok(warnings.length > 0, '坏 logger 必须真的被调用过，否则这条用例是空转');
  });

  test('退化的宿主在加载期被上报，并点名缺了什么', async () => {
    const host = fakeHost();
    // 移除一项可选能力：探测仍须成功，而该发现必须进入日志，而不是被静默吞掉。
    delete host.ctx.services.dshHomePath;
    apply(host.ctx, {});

    assert.equal(host.registered.length, 1, '退化的宿主不得阻止注册');
    // 探测刻意推迟一轮宏任务：`settings` / `connection` / `credentials` 三项只能经
    // `ctx.inject` 取得，而它的回调是异步的（真机实测见 `lib/dsh/host-services.js`）。
    // 同步探测会把它们全报成缺失——那是探测自身的时序假象。
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    const reported = host.warnings.join('\n');
    assert.match(reported, /dshHomePath/u);
    assert.match(reported, /docs\/dsh-upgrade\.md/u);
  });
});

describe('COMPAT-2：seam 变形会在加载期响亮地失败', () => {
  test('缺失的注册函数会被精确点名', () => {
    const host = fakeHost({ omitRegistration: true });
    const error = (() => {
      try {
        apply(host.ctx, {});
        return undefined;
      } catch (thrown) {
        return thrown;
      }
    })();
    assert.ok(error instanceof MissingHostCapabilityError, 'seam 必须以具名错误失败，而不是 TypeError');
    assert.equal(error.path, 'ctx.web.registerSearchProvider');
    assert.match(error.message, /ctx\.web\.registerSearchProvider/u);
    assert.match(error.message, /docs\/dsh-upgrade\.md/u);
  });
});

describe('PIN-2 / 硬约束 1：available() 恒为 true', () => {
  test('一把密钥都没有的提供方仍然自称可用', () => {
    const host = fakeHost({ harnessHome: '/nonexistent-home' });
    apply(host.ctx, {});
    assert.equal(host.registered[0].available(), true);
  });

  test('密钥池文件损坏的提供方仍然自称可用', async () => {
    const home = await temporaryHarnessHome('not json at all');
    const host = fakeHost({ harnessHome: home });
    apply(host.ctx, {});

    await host.registered[0].search({ query: 'anything' }).catch(() => undefined);
    assert.equal(
      host.registered[0].available(),
      true,
      '被 pin 住的提供方自称不可用会硬抛，而不是回落',
    );
  });
});

describe('PIN-3 / SCHED-5：没有可用候选时回落到官方提供方', () => {
  test('空池回落，且错误同时说清起点与回落目标', async () => {
    const host = fakeHost({ harnessHome: await temporaryHarnessHome() });
    apply(host.ctx, {});

    const error = await host.registered[0].search({ query: 'q' }).catch((thrown) => thrown);

    // 本机没有官方凭据，因此回落目标报的是「凭据未配置」。要紧的是这两件事都在错误里：
    // 用户刚被从 Tavily 那条路踢出来，只看到一条关于 DeepSeek 凭据的错误会让他去修
    // 错的东西。
    assert.equal(error.code, 'TAVILY_FALLBACK_CREDENTIAL_MISSING');
    assert.match(error.message, /no Tavily key is configured/u, '必须说清为什么离开 Tavily');
    assert.match(error.message, /DEEPSEEK_API_KEY/u, '必须说清回落目标缺的是什么');
  });

  test('损坏的密钥池文件回落，但仍按路径把文件问题说出来', async () => {
    const host = fakeHost({ harnessHome: await temporaryHarnessHome('not json at all') });
    apply(host.ctx, {});

    const error = await host.registered[0].search({ query: 'q' }).catch((thrown) => thrown);

    assert.equal(error.code, 'TAVILY_FALLBACK_CREDENTIAL_MISSING');
    assert.match(error.message, /could not be read/u, '文件坏了与没加密钥要用户做的事不同');
    assert.match(error.message, /keys\.json/u, '并且要点名是哪个文件');
    assert.match(
      host.warnings.join('\n'),
      /falling back to the official search provider/u,
      '回落成功会掩盖这条线索，因此它必须至少留在日志里',
    );
    assert.match(host.warnings.join('\n'), /keys\.json/u, '日志里也要点名是哪个文件');
  });

  test('回落到官方并**成功**时也留下痕迹，且同一原因只记一次', async () => {
    // 这一条不是可有可无的：本机通常配着 DEEPSEEK_API_KEY，于是密钥池为空的用户会静默地
    // 用上官方搜索——面板上两个开关都开着、搜索也正常工作，没有任何迹象说明 Tavily 根本
    // 没被用上。
    const host = fakeHost({ harnessHome: await temporaryHarnessHome() });
    apply(host.ctx, {});

    const original = globalThis.fetch;
    // 一份官方提供方会当作成功的最小 Messages 响应：它要求响应里有
    // `web_search_tool_result` 块，缺了会按 WEB_PROVIDER_ERROR 抛错。
    globalThis.fetch = async () => new Response(JSON.stringify({
      content: [{
        type: 'web_search_tool_result',
        content: [{ type: 'web_search_result', url: 'https://official.example', title: 'T' }],
      }],
    }), { status: 200 });
    try {
      // 给官方提供方一份字面凭据，让它走到「成功」而不是「凭据缺失」。
      host.ctx.services.settings.get = (namespace) => (namespace === 'web-search-deepseek'
        ? { apiKey: 'sk-literal' }
        : { searchEnabled: true });
      const before = host.warnings.length;
      let served = 0;
      for (let index = 0; index < 3; index += 1) {
        const result = await host.registered[0].search({ query: 'q' }).catch(() => undefined);
        if (result?.sources?.length > 0) served += 1;
      }

      assert.equal(served, 3, '三次都应当由官方提供方成功服务');
      const logged = host.warnings.slice(before).filter((message) => /serving this search through/u.test(message));
      assert.equal(logged.length, 1, '回落成功要留痕，但同一个原因不该每次搜索都刷一遍');
      assert.match(logged[0], /no Tavily key is usable/u, '痕迹里要写清为什么离开 Tavily');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('坏文件是个持续状态：连搜三次只报告一次，不刷屏', async () => {
    const host = fakeHost({ harnessHome: await temporaryHarnessHome('not json at all') });
    apply(host.ctx, {});
    const before = host.warnings.length;

    for (let index = 0; index < 3; index += 1) {
      await host.registered[0].search({ query: 'q' }).catch(() => undefined);
    }

    // 每一次搜索都会重新看见同一个 loadError。若不加抑制，一次持续的文件损坏会在日志里
    // 堆成一条与搜索次数成正比的长龙，把真正新发生的事淹掉。
    assert.equal(
      host.warnings.slice(before).filter((message) => /key pool at/u.test(message)).length,
      1,
      '同一个坏文件只报告一次',
    );
  });

  test('换成另一种坏法时应当**再报一次**，而不是被当成同一个旧故障', async () => {
    // `reportedPoolLoadError` 是「新发生的故障」与「同一个旧故障」的分界。去重若做得过头，
    // 换了坏法的第二次损坏就会彻底静默——那比刷屏更糟。
    //
    // 注意两次损坏之间**没有**「先修好」这一步：密钥池一旦成功加载就被记忆化，此后不再
    // 重读（面板编辑走的是同一份内存文档，因此不受影响；手工改文件要重启才生效）。而
    // 读取失败时 `ensureLoaded` 会丢弃记忆，于是下一次搜索真的会重新读——那正是这里要压
    // 的那条路径。
    const home = await temporaryHarnessHome('not json at all');
    const host = fakeHost({ harnessHome: home });
    apply(host.ctx, {});

    await host.registered[0].search({ query: 'q' }).catch(() => undefined);
    assert.equal(host.warnings.filter((message) => /key pool at/u.test(message)).length, 1);

    // 换成另一种坏法：能解析成 JSON，但不匹配 schema。
    await writeFile(join(home, STATE_DIR_NAME, KEYS_FILE_NAME), '{"version":99}', 'utf8');
    await host.registered[0].search({ query: 'q' }).catch(() => undefined);

    const reported = host.warnings.filter((message) => /key pool at/u.test(message));
    assert.equal(reported.length, 2, '换了坏法是一次新故障，必须再报一次');
    assert.match(reported[1], /does not match the expected schema/u, '第二次报的是新的原因');
  });

  test('手工修好坏文件之后无需重启即可重新用上 Tavily', async () => {
    // 这条压的是一个真实的回归：`load()` 对坏文件**不抛错**（按 POOL-7 以空池继续），
    // 因此「成功兑现」会把密钥池的加载记忆化钉死。用户照日志里的话修好 keys.json 之后，
    // 插件若仍抱着那份空池，症状就是「我修好了，搜索却还是不走 Tavily」，而且只有重启
    // 才能恢复——用户没有任何线索知道要这么做。
    const home = await temporaryHarnessHome('not json at all');
    const host = fakeHost({ harnessHome: home });
    apply(host.ctx, {});

    const first = await host.registered[0].search({ query: 'q' }).catch((thrown) => thrown);
    assert.equal(first.code, 'TAVILY_FALLBACK_CREDENTIAL_MISSING', '先是回落');
    assert.equal(host.warnings.filter((message) => /key pool at/u.test(message)).length, 1);

    // 用户按日志的指引修好文件。
    await writeFile(
      join(home, STATE_DIR_NAME, KEYS_FILE_NAME),
      JSON.stringify({
        version: 1,
        keys: [{ id: 'a', key: 'tvly-dev-repaired-aaaaaaaaaaaa', disabled: false }],
        order: ['a'],
        stats: {},
        usageCache: {},
      }),
      'utf8',
    );

    const { result } = await withStubbedFetch(
      () => ({ status: 200, body: { results: [{ url: 'https://ok.example' }] } }),
      (calls) => host.registered[0].search({ query: 'q' }).then((value) => ({ value, calls })),
    );

    assert.equal(result.value.sources.length, 1, '修好之后就该重新走 Tavily，不该需要重启');
    assert.match(result.calls[0].url, /api\.tavily\.com\/search/u);
    assert.match(result.calls[0].authorization, /repaired/u, '用的应当是刚修好的那把密钥');
  });
});

describe('本模块无需加载 harness 服务即可导入', () => {
  test('apply() 是函数，且该行可以携带空配置', () => {
    assert.equal(typeof apply, 'function');
    assert.equal(apply.length >= 1, true);
  });
});

/**
 * 在桩件 `fetch` 之下跑一次搜索。
 *
 * 插件的网络实现取自 `globalThis.fetch`，因此在这里替换它就能观察「线上实际发出了
 * 什么」，而不必把 fetch 一路穿进插件接口——那会为了可测性在接口上开一个洞。
 *
 * @param handler - 收到 `{ url, body, authorization }`，返回 `{ status, body }` 或抛出。
 * @param run - 在桩件生效期间执行的函数。
 * @returns `run` 的返回值。
 */
async function withStubbedFetch(handler, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const call = {
      url,
      method: init?.method,
      authorization: init?.headers?.authorization,
      // 信号也收下来：它是**唯一**能反查「宿主给了这个工具多久」的观测面——单次尝试的超时
      // 就挂在它上面（`AbortSignal.timeout`），而它由本次的总预算折算而来（`host-contract-2`）。
      signal: init?.signal,
      body: JSON.parse(init?.body ?? '{}'),
    };
    calls.push(call);
    const outcome = handler(call) ?? { status: 200, body: { results: [] } };
    // **异步桩件按原样返回。** 它存在的理由正是造出「响应一直不来」这类真实时序（体读阶段
    // 超时、连接重置、取消），而在这里 `await` 会把它拆成一个 `Response`——于是「挂住」变成
    // 「立刻回一个空响应」，被检验的时序根本不会发生。
    if (outcome instanceof Promise) return outcome;
    if (outcome.throw !== undefined) throw outcome.throw;
    return new Response(JSON.stringify(outcome.body ?? {}), {
      status: outcome.status ?? 200,
      headers: outcome.headers,
    });
  };
  try {
    return { result: await run(calls) };
  } finally {
    globalThis.fetch = original;
  }
}

/** 一个已加载插件、池中已有若干密钥的替身宿主。 */
/**
 * 抓取开关**默认关闭**（`CFG-2`，2026-09-20 决定），因此凡是断言「请求真的走了 Tavily
 * `/extract`」的用例，都必须先把设置显式打开——否则请求会按设计回落给官方本地抓取器。
 *
 * @param extra - 与 `fetchEnabled` 一并写进设置的其它字段。
 * @returns 可以直接交给 `hostWithKeys` 的 `settings` 值。
 */
function fetchOn(extra = {}) {
  return { [SETTINGS_NAMESPACE]: { fetchEnabled: true, ...extra } };
}

/**
 * 造一个带密钥池的假宿主。
 *
 * @param keys - 要预置的密钥。
 * @param options - 宿主选项。
 * @returns 假宿主，另带密钥池文件路径。
 */
async function hostWithKeys(keys, options = {}) {
  const home = await temporaryHarnessHome('{"version":1,"keys":[],"order":[],"stats":{},"usageCache":{}}');
  const host = fakeHost({ harnessHome: home, settings: options.settings, tools: options.tools });
  apply(host.ctx, {});

  // 先经真实的加载路径读入空池，再经存储自身的编辑接口添加密钥——与面板将来做的
  // 是同一件事，因此这里检验的是真实的往返，而不是一份手工写出的文件。
  const { PoolStore } = await import('../lib/pool.js');
  const store = new PoolStore({ dir: join(home, STATE_DIR_NAME), fileName: KEYS_FILE_NAME });
  await store.load();
  for (const [index, entry] of keys.entries()) {
    await store.addKey({ key: `tvly-dev-${index}-${'a'.repeat(20)}`, label: entry.label });
  }
  // 密钥池的真实落盘位置一并交出去：落盘断言若自己拼一遍路径，拼错的症状会是一条
  // ENOENT，而那看起来像「没写盘」——把路径的来源留在解析它的那一处，断言才在断言它
  // 想断言的东西。
  return { ...host, keyPoolPath: join(home, STATE_DIR_NAME, KEYS_FILE_NAME) };
}

describe('POOL-1：密钥池落在用户级 harness 目录，而不是 profile 目录', () => {
  test('写入路径由 ctx.dshHomePath 决定，且落在 dsh-tavily-pool/keys.json', async () => {
    const home = await temporaryHarnessHome(JSON.stringify({
      version: 1, keys: [{ id: 'a', key: 'tvly-dev-aaaaaaaaaaaaaaaa', disabled: false }],
      order: ['a'], stats: {}, usageCache: {},
    }));
    const host = fakeHost({ harnessHome: home });
    apply(host.ctx, {});

    await withStubbedFetch(
      () => ({ status: 200, body: { results: [{ url: 'https://ok.example' }] } }),
      () => host.registered[0].search({ query: 'q' }),
    );

    // 记账会落盘，因此搜索之后该文件必定存在，且位置正是宿主上报的 home 之下。
    const written = await readFile(join(home, STATE_DIR_NAME, KEYS_FILE_NAME), 'utf8');
    assert.match(written, /useSeq/u, '轮转序号必须落盘');

    // 「不写 profile 目录」是这条需求的一半，而它是「经 dshHomePath 解析」的直接推论：
    // 插件从不拼接 `profiles/` 之类的路径，因此唯一的写入位置就是上面那个。
    const { resolveStateDir } = await import('../lib/dsh/home-path.js');
    assert.equal(resolveStateDir(host.ctx), join(home, STATE_DIR_NAME));
  });
});

describe('调度与故障切换经入口真实生效', () => {
  test('搜索用池中的密钥发往 Tavily', async () => {
    const host = await hostWithKeys([{ label: 'only' }]);
    const { result } = await withStubbedFetch(
      () => ({ status: 200, body: { results: [{ url: 'https://example.com', title: 'T' }] } }),
      (calls) => host.registered[0].search({ query: 'hello' }).then((value) => ({ value, calls })),
    );

    assert.equal(result.value.sources.length, 1);
    assert.equal(result.calls.length, 1);
    assert.match(result.calls[0].url, /api\.tavily\.com\/search/u);
    assert.match(result.calls[0].authorization, /^Bearer tvly-dev-0-/u);
  });

  test('401 且措辞命中失效时自动改用第二把密钥，并把状态落盘', async () => {
    const host = await hostWithKeys([{ label: 'bad' }, { label: 'good' }]);
    const { result } = await withStubbedFetch(
      (call) => (call.authorization.includes('-0-')
        ? { status: 401, body: { detail: { error: 'Unauthorized: invalid API key.' } } }
        : { status: 200, body: { results: [{ url: 'https://ok.example' }] } }),
      () => host.registered[0].search({ query: 'q' }),
    );

    assert.equal(result.sources[0].url, 'https://ok.example');

    // 第一把必须被标记为永久失效，并且这一事实已经落到磁盘上——重启后仍然成立。
    const onDisk = JSON.parse(
      await readFile(join(host.ctx.services.dshHomePath(STATE_DIR_NAME), KEYS_FILE_NAME), 'utf8'),
    );
    const stats = Object.values(onDisk.stats);
    assert.equal(stats.length, 2, '两把密钥各有一条记录');
    assert.equal(
      stats.filter((entry) => entry.permanentlyInvalidAt !== undefined).length,
      1,
      '只有措辞命中的那一把被标记永久失效',
    );
  });

  test('全部密钥都在冷却时立即失败，而不是等满整个等待预算', async () => {
    const home = await temporaryHarnessHome(JSON.stringify({
      version: 1,
      keys: [{ id: 'a', key: 'tvly-dev-cooling-aaaaaaaaaaaa', disabled: false }],
      order: ['a'],
      // 冷却到 300 秒之后——远超 30 秒的等待预算。
      stats: { a: { cooldownUntil: new Date(Date.now() + 300_000).toISOString() } },
      usageCache: {},
    }));
    const host = fakeHost({ harnessHome: home });
    apply(host.ctx, {});

    const startedAt = Date.now();
    const error = await host.registered[0].search({ query: 'q' }).catch((thrown) => thrown);
    const elapsed = Date.now() - startedAt;

    assert.equal(error.code, 'TAVILY_NO_USABLE_KEY');
    assert.match(error.message, /cooling down/u);
    assert.ok(elapsed < 5_000, `不得真的等 300 秒（实际 ${String(elapsed)}ms）`);
  });

  test('额度耗尽的密钥不会被选中，也不需要等待', async () => {
    // 标记刚发生，尚未跨过任何月起始，因此不落在 SCHED-10 的探测窗口内。
    const home = await temporaryHarnessHome(JSON.stringify({
      version: 1,
      keys: [{ id: 'a', key: 'tvly-dev-out-of-credits-aaaaaaaa', disabled: false }],
      order: ['a'],
      stats: { a: { quotaExhaustedAt: new Date().toISOString() } },
      usageCache: {},
    }));
    const host = fakeHost({ harnessHome: home });
    apply(host.ctx, {});

    const startedAt = Date.now();
    const error = await host.registered[0].search({ query: 'q' }).catch((thrown) => thrown);

    assert.equal(error.code, 'TAVILY_FALLBACK_CREDENTIAL_MISSING');
    assert.match(error.message, /out of credits/u, '回落的原因必须带上：用户要知道为什么离开 Tavily');
    assert.ok(Date.now() - startedAt < 5_000, '额度耗尽不可等待：恢复可能在下月 1 日');
  });

  test('停用的密钥不参与调度', async () => {
    const home = await temporaryHarnessHome(JSON.stringify({
      version: 1,
      keys: [{ id: 'a', key: 'tvly-dev-disabled-aaaaaaaaaaaa', disabled: true }],
      order: ['a'],
      stats: {},
      usageCache: {},
    }));
    const host = fakeHost({ harnessHome: home });
    apply(host.ctx, {});

    const error = await host.registered[0].search({ query: 'q' }).catch((thrown) => thrown);
    assert.equal(error.code, 'TAVILY_FALLBACK_CREDENTIAL_MISSING');
    assert.match(error.message, /no Tavily key is configured/u);
  });

  test('关闭搜索开关时不再向 Tavily 发请求', async () => {
    const host = await hostWithKeys([{ label: 'only' }], { settings: { [SETTINGS_NAMESPACE]: {} } });
    host.setSettings({ searchEnabled: false });

    let requests = 0;
    const { result: error } = await withStubbedFetch(
      () => {
        requests += 1;
        return { status: 200, body: {} };
      },
      () => host.registered[0].search({ query: 'q' }).catch((thrown) => thrown),
    );

    assert.equal(requests, 0, '开关关闭时不得向 api.tavily.com 发起任何请求');
    // 本机没有官方凭据，于是回落目标报「凭据未配置」；而原因里写着起点是开关。
    assert.equal(error.code, 'TAVILY_FALLBACK_CREDENTIAL_MISSING');
    assert.match(error.message, /toggle is off/u, '要说清楚是开关关的，而不是池子空了');
  });

  test('开关改动即时生效，无需重新注册提供方', async () => {
    const host = await hostWithKeys([{ label: 'only' }], { settings: { [SETTINGS_NAMESPACE]: {} } });
    const provider = host.registered[0];

    host.setSettings({ searchEnabled: false });
    const disabled = await provider.search({ query: 'q' }).catch((thrown) => thrown);
    assert.equal(disabled.code, 'TAVILY_FALLBACK_CREDENTIAL_MISSING');
    assert.match(disabled.message, /toggle is off/u);

    host.setSettings({ searchEnabled: true });
    const { result } = await withStubbedFetch(
      () => ({ status: 200, body: { results: [{ url: 'https://ok.example' }] } }),
      () => provider.search({ query: 'q' }),
    );
    assert.equal(result.sources.length, 1, '同一个提供方实例，改动立刻生效');
    assert.equal(host.registered.length, 1, '不得为了携带新设置而重新注册提供方');
  });

  test('统计写不进去时搜索照常成功，但会留下一条指名路径的告警', async () => {
    // 状态目录设为不可写：读取密钥池仍然成功，而写入（临时文件 + rename）必然失败。
    // 这正是「磁盘满 / 目录只读 / 权限不对」在用户那里的症状。
    const home = await temporaryHarnessHome(JSON.stringify({
      version: 1,
      keys: [{ id: 'a', key: 'tvly-dev-aaaaaaaaaaaaaaaa', disabled: false }],
      order: ['a'],
      stats: {},
      usageCache: {},
    }));
    const stateDir = join(home, STATE_DIR_NAME);
    await chmod(stateDir, 0o500);

    try {
      const host = fakeHost({ harnessHome: home });
      apply(host.ctx, {});
      const before = host.warnings.length;

      const { result } = await withStubbedFetch(
        () => ({ status: 200, body: { results: [{ url: 'https://ok.example' }] } }),
        () => host.registered[0].search({ query: 'q' }),
      );

      assert.equal(result.sources.length, 1, '统计不是正确性前提：搜索必须照常成功');
      const reported = host.warnings.slice(before).join('\n');
      assert.match(reported, /could not record key stats/u, '写不进去绝不能是静默的');
      assert.match(reported, /keys\.json/u, '告警必须指名是哪个文件');

      // 一次失败只报告一次，而不是每次搜索都把同一条旧日志再刷一遍。这里的状态目录
      // 仍然不可写，因此第二次搜索会**再次**写入失败、**再次**得到一条新告警——这正是
      // 期望的行为（新发生的故障要报告）；要防的是「没有新故障却重复报告」，那由
      // `lastWriteError` 在报告后被清掉保证。
      assert.equal(
        host.warnings.slice(before).filter((message) => /could not record key stats/u.test(message)).length,
        1,
        '本次搜索只产生一条告警，而不是每把密钥各一条',
      );
    } finally {
      // 恢复权限，否则临时目录无法清理。
      await chmod(stateDir, 0o700);
    }
  });
});

describe('CFG-3：搜索参数经设置生效，且改动无需重启', () => {
  test('默认参数被送进请求体', async () => {
    const host = await hostWithKeys([{ label: 'only' }], { settings: { [SETTINGS_NAMESPACE]: {} } });

    const { result } = await withStubbedFetch(
      () => ({ status: 200, body: { results: [{ url: 'https://ok.example' }] } }),
      (calls) => host.registered[0].search({ query: 'q' }).then((value) => ({ value, calls })),
    );

    assert.equal(result.calls[0].body.search_depth, 'basic');
    assert.equal(result.calls[0].body.topic, 'general');
    assert.equal(result.calls[0].body.include_answer, false);
    assert.equal(result.calls[0].body.max_results, 10);
    assert.equal(result.calls[0].body.include_usage, true, 'REST-2：记账的前提');
  });

  test('改 searchDepth 之后下一次搜索立即生效', async () => {
    const host = await hostWithKeys([{ label: 'only' }], { settings: { [SETTINGS_NAMESPACE]: {} } });
    const provider = host.registered[0];
    const respond = () => ({ status: 200, body: { results: [{ url: 'https://ok.example' }] } });

    const before = await withStubbedFetch(respond, (calls) => provider.search({ query: 'q' }).then((v) => ({ v, calls })));
    assert.equal(before.result.calls[0].body.search_depth, 'basic');

    host.setSettings({ searchDepth: 'advanced', topic: 'news', includeAnswer: true, maxResults: 3 });

    const after = await withStubbedFetch(respond, (calls) => provider.search({ query: 'q' }).then((v) => ({ v, calls })));
    assert.equal(after.result.calls[0].body.search_depth, 'advanced');
    assert.equal(after.result.calls[0].body.topic, 'news');
    assert.equal(after.result.calls[0].body.include_answer, true);
    assert.equal(after.result.calls[0].body.max_results, 3);
    assert.equal(host.registered.length, 1, '不得为了携带新参数而重新注册提供方');
  });

  test('调用方的 maxResults 更小时听调用方的', async () => {
    const host = await hostWithKeys([{ label: 'only' }], {
      settings: { [SETTINGS_NAMESPACE]: { maxResults: 20 } },
    });

    const { result } = await withStubbedFetch(
      () => ({ status: 200, body: { results: [{ url: 'https://ok.example' }] } }),
      (calls) => host.registered[0].search({ query: 'q', maxResults: 4 }).then((value) => ({ value, calls })),
    );

    assert.equal(result.calls[0].body.max_results, 4);
  });

  test('include_answer 为真时响应里的 answer 成为结果的 content', async () => {
    const host = await hostWithKeys([{ label: 'only' }], {
      settings: { [SETTINGS_NAMESPACE]: { includeAnswer: true } },
    });

    const { result } = await withStubbedFetch(
      () => ({ status: 200, body: { answer: 'the answer', results: [{ url: 'https://ok.example' }] } }),
      () => host.registered[0].search({ query: 'q' }),
    );

    assert.equal(result.content, 'the answer');
    assert.equal(result.sources.length, 1);
  });
});

describe('SCHED-10：跨月起始后自动探测并恢复', () => {
  /** 一把在某个时刻被标记为额度耗尽的密钥所在的 harness home。 */
  async function homeWithExhaustedKey(markedAt) {
    return temporaryHarnessHome(JSON.stringify({
      version: 1,
      keys: [{ id: 'a', key: 'tvly-dev-exhausted-aaaaaaaaaaaa', disabled: false }],
      order: ['a'],
      stats: { a: { quotaExhaustedAt: new Date(markedAt).toISOString() } },
      usageCache: {},
    }));
  }

  /**
   * 在桩住的时钟下加载插件并跑一个用例。
   *
   * 时钟必须在 `apply()` **之前**装上：协作者把 `Date.now` 作为构造参数的默认值捕获
   * （`now = Date.now`），因此 `apply()` 之后再替换全局函数是无效的——插件仍持着原来
   * 那个引用。这不是测试的怪癖，而是「依赖注入而非全局读取」的直接后果。
   *
   * @param markedAt - 额度耗尽的标记时刻。
   * @param nowIso - 本次用例看到的当前时刻。
   * @param run - 收到已加载的 host 与桩住的 fetch 调用记录。
   */
  async function withFrozenClock(markedAt, nowIso, run) {
    const home = await homeWithExhaustedKey(markedAt);
    const realNow = Date.now;
    Date.now = () => Date.parse(nowIso);
    try {
      const host = fakeHost({ harnessHome: home });
      apply(host.ctx, {});
      return await run(host);
    } finally {
      Date.now = realNow;
    }
  }

  test('跨过月起始后先探测，恢复则用同一把密钥完成本次搜索', async () => {
    // 标记发生在 3 月 20 日，因此第一个月起始是 4 月 1 日 00:00 UTC。
    await withFrozenClock('2026-03-20T10:00:00Z', '2026-04-01T00:00:30Z', async (host) => {
      const { result } = await withStubbedFetch(
        (call) => (call.url.includes('/usage')
          ? { status: 200, body: { key: { usage: 0, limit: 1000 }, account: { plan_limit: 1000 } } }
          : { status: 200, body: { results: [{ url: 'https://ok.example' }] } }),
        (calls) => host.registered[0].search({ query: 'q' }).then((value) => ({ value, calls })),
      );

      assert.equal(result.value.sources.length, 1, '探测确认恢复之后，本次搜索应当用这把密钥完成');
      assert.equal(result.calls[0].url, 'https://api.tavily.com/usage', '先探测');
      assert.equal(result.calls[0].method, 'GET', '/usage 只能是 GET');
      assert.match(result.calls[1].url, /api\.tavily\.com\/search/u, '探测确认恢复后才搜索');

      // 恢复之后额度耗尽的标记应当已被清掉，且探测记录也一并清掉。
      const onDisk = JSON.parse(await readFile(join(host.ctx.services.dshHomePath(STATE_DIR_NAME), KEYS_FILE_NAME), 'utf8'));
      assert.equal(onDisk.stats.a.quotaExhaustedAt, undefined, 'SCHED-8：官方确认余额回升才恢复');
    });
  });

  test('探测显示仍未恢复时回落，且不再向搜索端点发请求', async () => {
    await withFrozenClock('2026-03-20T10:00:00Z', '2026-04-01T00:00:30Z', async (host) => {
      const { result } = await withStubbedFetch(
        () => ({ status: 200, body: { key: { usage: 100, limit: 100 }, account: { plan_limit: 100 } } }),
        (calls) => host.registered[0].search({ query: 'q' }).catch((thrown) => thrown).then((value) => ({ value, calls })),
      );

      assert.equal(result.value.code, 'TAVILY_FALLBACK_CREDENTIAL_MISSING');
      assert.match(result.value.message, /out of credits/u);
      assert.equal(
        result.calls.filter((call) => call.url.includes('/search')).length,
        0,
        '探测没确认恢复，就不该再向搜索端点发请求',
      );
    });
  });

  test('探测过后 6 小时内不再探测，避免打满官方配额', async () => {
    const markedAt = '2026-03-20T10:00:00Z';
    const home = await homeWithExhaustedKey(Date.parse(markedAt));
    const realNow = Date.now;
    let probes = 0;
    const respond = (call) => {
      if (call.url.includes('/usage')) {
        probes += 1;
        return { status: 200, body: { key: { usage: 100, limit: 100 } } };
      }
      return { status: 200, body: {} };
    };

    try {
      Date.now = () => Date.parse('2026-04-01T00:00:30Z');
      const host = fakeHost({ harnessHome: home });
      apply(host.ctx, {});
      await withStubbedFetch(respond, () => host.registered[0].search({ query: 'q' }).catch(() => undefined));

      // 同一个探测窗口内再搜三次：一次都不该再问官方。
      Date.now = () => Date.parse('2026-04-01T01:00:00Z');
      for (let index = 0; index < 3; index += 1) {
        await withStubbedFetch(respond, () => host.registered[0].search({ query: 'q' }).catch(() => undefined));
      }
    } finally {
      Date.now = realNow;
    }

    assert.equal(probes, 1, '6 小时栅格内只探测一次；否则 10 分钟就能把 /usage 配额打满');
  });

  test('标记尚未跨过月起始时不探测', async () => {
    // 同一份密钥池，时钟停在标记当天。
    await withFrozenClock('2026-03-20T10:00:00Z', '2026-03-20T11:00:00Z', async (host) => {
      const { result } = await withStubbedFetch(
        () => ({ status: 200, body: {} }),
        (calls) => host.registered[0].search({ query: 'q' }).catch((thrown) => thrown).then((value) => ({ value, calls })),
      );

      assert.match(result.value.message, /out of credits/u);
      assert.equal(result.value.code, 'TAVILY_FALLBACK_CREDENTIAL_MISSING');
      assert.equal(result.calls.length, 0, '月中探测只会浪费官方配额，一次请求都不该发出');
    });
  });
});

describe('USAGE-5：搜索成功后按**估算**前推余额', () => {
  /** 读出密钥池文件里那把密钥的官方余额读数与本地前推后的 `usage`。 */
  async function usageOnDisk(host) {
    const onDisk = JSON.parse(
      await readFile(join(host.ctx.services.dshHomePath(STATE_DIR_NAME), KEYS_FILE_NAME), 'utf8'),
    );
    return { onDisk, stats: Object.values(onDisk.stats)[0], usage: Object.values(onDisk.usageCache)[0] };
  }

  test('一次 basic 搜索成功把余额前推 1——用的是本地估算，不是上游回传值', async () => {
    const host = await hostWithKeys([{ label: 'only' }]);

    // 先播一份官方余额，否则前推没有可减的对象。
    const { PoolStore } = await import('../lib/pool.js');
    const store = new PoolStore({ dir: join(host.ctx.services.dshHomePath(STATE_DIR_NAME), ''), fileName: KEYS_FILE_NAME });
    await store.load();
    await store.setUsage(store.maskedList()[0].id, {
      key: { usage: 10, limit: 100 },
      account: { plan_usage: 10, plan_limit: 1000 },
    });

    // 上游回传 credits: 7，但默认档是 basic，估算值应当是 1——若这里读到 17 就说明
    // 插件又在读上游回传值了（spec 的 Gherkin 场景「响应里的 credits 被忽略」）。
    await withStubbedFetch(
      () => ({ status: 200, body: { results: [{ url: 'https://ok.example' }], usage: { credits: 7 } } }),
      () => host.registered[0].search({ query: 'q' }),
    );

    const { stats, usage } = await usageOnDisk(host);
    assert.equal(stats.successes, 1);
    assert.equal('credits' in stats, false, '统计里不再有积分流水这一项');
    assert.equal(usage.key.usage, 11, '下降幅度是估算值 1，而不是响应里的 7');
  });

  test('advanced 搜索前推 2：深度取自设置，且改动即时生效', async () => {
    const host = await hostWithKeys([{ label: 'only' }], {
      settings: { [SETTINGS_NAMESPACE]: { searchDepth: 'advanced' } },
    });

    const { PoolStore } = await import('../lib/pool.js');
    const store = new PoolStore({ dir: join(host.ctx.services.dshHomePath(STATE_DIR_NAME), ''), fileName: KEYS_FILE_NAME });
    await store.load();
    await store.setUsage(store.maskedList()[0].id, {
      key: { usage: 10, limit: 100 },
      account: { plan_usage: 10, plan_limit: 1000 },
    });

    await withStubbedFetch(
      () => ({ status: 200, body: { results: [{ url: 'https://ok.example' }] } }),
      () => host.registered[0].search({ query: 'q' }),
    );

    const { usage } = await usageOnDisk(host);
    assert.equal(usage.key.usage, 12, 'advanced 搜索估 2 积分');
  });

  test('估算值总是已知的：上游没回传 usage 也照样前推', async () => {
    // 旧口径下「上游没回传 credits」会被记成未知并放弃前推（`REST-3`）。现在没有记账、
    // 只有估算，而估算总有值。
    const host = await hostWithKeys([{ label: 'only' }]);

    const { PoolStore } = await import('../lib/pool.js');
    const store = new PoolStore({ dir: join(host.ctx.services.dshHomePath(STATE_DIR_NAME), ''), fileName: KEYS_FILE_NAME });
    await store.load();
    await store.setUsage(store.maskedList()[0].id, {
      key: { usage: 10, limit: 100 },
      account: { plan_usage: 10, plan_limit: 1000 },
    });

    await withStubbedFetch(
      () => ({ status: 200, body: { results: [{ url: 'https://ok.example' }] } }),
      () => host.registered[0].search({ query: 'q' }),
    );

    const { stats, usage } = await usageOnDisk(host);
    assert.equal(usage.key.usage, 11, '估算不依赖上游回传，照常前推 1');
    assert.equal('creditsUnknown' in stats, false, '「消耗未知」这一态已不存在');
  });
});

describe('10：抓取接管经入口真实生效', () => {
  /** 在桩件 `fetch` 之下跑一次抓取。抓取开关默认关闭，因此调用方要先把设置打开（`CFG-2`）。 */
  async function fetchVia(host, url) {
    const provider = host.registeredFetch[0];
    assert.notEqual(provider, undefined, '抓取提供方必须在 apply() 之后存在');
    return withStubbedFetch(
      () => ({ status: 200, body: { results: [{ url, raw_content: '# 正文' }], failed_results: [] } }),
      (calls) => provider.fetch({ url }).then((value) => ({ value, calls })),
    );
  }

  test('抓取提供方与搜索提供方共用 id，分别注册进两个注册表', async () => {
    const host = await hostWithKeys([{ label: 'only' }]);
    assert.equal(host.registeredFetch.length, 1);
    assert.equal(host.registeredFetch[0].id, PROVIDER_ID);
    assert.equal(host.registeredFetch[0].available(), true, '被 pin 的提供方自称不可用会让 web_fetch 硬抛');
  });

  test('FETCH-1：开关为开且池中有密钥时走 /extract，并返回纯文本', async () => {
    const host = await hostWithKeys([{ label: 'only' }], { settings: fetchOn() });
    const { result } = await fetchVia(host, 'https://example.com');

    assert.equal(result.calls.length, 1);
    assert.match(result.calls[0].url, /api\.tavily\.com\/extract/u);
    assert.match(result.calls[0].authorization, /^Bearer tvly-dev-0-/u);
    assert.deepEqual(result.calls[0].body.urls, ['https://example.com']);

    assert.equal(result.value.body.kind, 'text');
    assert.equal(result.value.body.content, '# 正文');
    assert.equal(result.value.statusCode, 200);
  });

  test('抓取参数从设置里来（WebFetchRequest 只有 url）', async () => {
    const host = await hostWithKeys([{ label: 'only' }], {
      settings: fetchOn({ fetchDepth: 'advanced', fetchFormat: 'text' }),
    });
    const { result } = await fetchVia(host, 'https://example.com');

    assert.equal(result.calls[0].body.extract_depth, 'advanced');
    assert.equal(result.calls[0].body.format, 'text');
  });

  test('USAGE-6：抓取按成功 URL 数**累计估算**前推余额，而不是按请求计费', async () => {
    // 官方口径是「每 5 个成功 URL 计 1 积分」，而 5 是跨请求累计的。因此单 URL 的前四次抓取
    // 各估 0，直到第五次才估 1。按请求计费（每次估 1）会让本地余额比官方账单快五倍地掉，
    // 而余额正是 `balance` 策略的排序输入——这条用例因此是那个口径在**入口**上的守卫。
    //
    // 插件不再统计自身消耗积分（2026-09-20 决定），因此这里断言的是**余额前推**：估算值
    // 唯一的去处是 `usageCache`，`stats` 里只留下累计的成功 URL 数。
    const host = await hostWithKeys([{ label: 'only' }], { settings: fetchOn() });

    // 先给这把密钥一份官方余额读数，否则前推没有可减的对象（`advanceUsage` 不凭空造估计）。
    const { PoolStore } = await import('../lib/pool.js');
    const store = new PoolStore({ dir: join(host.ctx.services.dshHomePath(STATE_DIR_NAME), ''), fileName: KEYS_FILE_NAME });
    await store.load();
    const [seeded] = store.maskedList();
    await store.setUsage(seeded.id, { key: { usage: 0, limit: 100 }, account: { plan_usage: 0, plan_limit: 1000 } });

    for (let call = 1; call <= 4; call += 1) {
      await fetchVia(host, 'https://example.com');
      const midway = JSON.parse(await readFile(host.keyPoolPath, 'utf8'));
      const midwayStats = Object.values(midway.stats)[0];
      assert.equal(
        midwayStats.extractUrls,
        call,
        `第 ${String(call)} 次抓取：累计成功 URL 数每次都要落盘，它才是跨档估算的输入`,
      );
      assert.equal('credits' in midwayStats, false, '不再有积分流水这一项');
      assert.equal(
        Object.values(midway.usageCache)[0].key.usage,
        0,
        `第 ${String(call)} 次抓取还没跨过第 5 个成功 URL，估算值为 0，余额不该被前推`,
      );
    }

    await fetchVia(host, 'https://example.com');
    const onDisk = JSON.parse(await readFile(host.keyPoolPath, 'utf8'));
    const [stats] = Object.values(onDisk.stats);

    assert.equal(stats.successes, 5, '五次抓取各算一次成功');
    assert.equal(stats.extractUrls, 5, '累计的成功 URL 数要落盘——它才是下一条估算判据的来源');
    assert.equal(
      Object.values(onDisk.usageCache)[0].key.usage,
      1,
      '第 5 个成功 URL 跨过档位，估算出 1 积分并前推进余额缓存',
    );
  });

  test('CFG-2：抓取开关独立于搜索开关——关掉抓取不影响搜索', async () => {
    const host = await hostWithKeys([{ label: 'only' }], {
      settings: { [SETTINGS_NAMESPACE]: { fetchEnabled: false } },
    });

    // 回落目标换成记录调用的桩件：这里要观察的是「请求交给了**谁**」，而真实官方实例
    // 一旦跑起来就会去做真实的 DNS 解析——那既慢又取决于本机网络，还会被「域名解析到
    // 非公网地址」那条策略挡下，得到一条与本需求无关的错误。限值是否逐字段一致由下面那条
    // 读官方 schema 的用例负责，两者合起来才是完整的回落契约。
    const original = officialFetchProvider();
    const seen = [];
    setOfficialFetchProvider({
      id: 'http',
      available: () => true,
      fetch: async (request) => {
        seen.push(request);
        return { url: request.url, statusCode: 200, body: { kind: 'text', content: 'official' }, truncated: false };
      },
    });
    try {
      const fetched = await host.registeredFetch[0].fetch({ url: 'https://example.com' });

      assert.deepEqual(seen, [{ url: 'https://example.com' }], '回落目标收到的就是 seam 的原始请求');
      assert.equal(fetched.body.content, 'official');
      assert.match(String(host.warnings.join('\n')), /the Tavily fetch toggle is off/u);

      // 而搜索开关没动，因此下一次搜索照旧走 Tavily。
      const searched = await withStubbedFetch(
        () => ({ status: 200, body: { results: [{ url: 'https://ok.example' }] } }),
        (calls) => host.registered[0].search({ query: 'q' }).then((value) => ({ value, calls })),
      );
      assert.match(searched.result.calls[0].url, /api\.tavily\.com\/search/u);
    } finally {
      setOfficialFetchProvider(original);
    }
  });

  test('反过来也成立：关掉搜索不影响抓取', async () => {
    const host = await hostWithKeys([{ label: 'only' }], {
      settings: fetchOn({ searchEnabled: false }),
    });

    const { result } = await fetchVia(host, 'https://example.com');
    assert.match(result.calls[0].url, /api\.tavily\.com\/extract/u);
  });

  test('池内无可用密钥时回落到官方抓取器，而不是抛错', async () => {
    const host = await hostWithKeys([], { settings: fetchOn() });
    const original = officialFetchProvider();
    const seen = [];
    setOfficialFetchProvider({
      id: 'http',
      available: () => true,
      fetch: async (request) => {
        seen.push(request.url);
        return { url: request.url, statusCode: 200, body: { kind: 'text', content: 'official' }, truncated: false };
      },
    });
    try {
      const fetched = await host.registeredFetch[0].fetch({ url: 'https://example.com' });

      assert.deepEqual(seen, ['https://example.com']);
      assert.equal(fetched.statusCode, 200);
      assert.match(String(host.warnings.join('\n')), /official local HTTP fetcher instead of Tavily/u);
    } finally {
      setOfficialFetchProvider(original);
    }
  });

  test('宿主没有 registerFetchProvider 时只丢抓取，搜索照常注册', () => {
    const host = fakeHost({ omitFetchRegistration: true });
    apply(host.ctx, {});

    assert.equal(host.registeredFetch.length, 0);
    assert.equal(host.registered.length, 1, 'PIN-5：抓取的注册失败不得把搜索一起拖下水');
    assert.match(String(host.warnings.join('\n')), /could not register the Tavily fetch provider/u);
  });
});

describe('10：回落契约——关掉开关后逐字段复现官方抓取器', () => {
  test('我们照抄的限值与官方 Config schema 逐字段一致', async () => {
    // ticket `10` 的回落契约要求「关闭开关后，抓取行为与本机原有官方实现逐字段一致」。
    // 这条断言直接读**官方包自己的** schema，因此上游一改默认值它当场变红——而不是等到
    // 某个用户发现超时时间不对。
    const { Config } = await import('@deepseek-ai/dsh-web-fetch-http');
    const { officialFetchLimits } = await import('../lib/dsh/fallback.js');

    const official = Config({});
    assert.deepEqual(officialFetchLimits(), {
      maxResponseBytes: official.maxResponseBytes,
      maxBodyChars: official.maxBodyChars,
      timeoutMs: official.timeoutMs,
      maxRedirects: official.maxRedirects,
      userAgent: official.userAgent,
    });
  });

  test('回落目标就是官方类本身，且 id 是 http', async () => {
    // `COMPAT-6`：不访问未导出字段。官方包根导出 `HttpFetchProvider` 与
    // `DEFAULT_USER_AGENT`，而我们只用这两个加上一份照抄的限值表。
    const official = await import('@deepseek-ai/dsh-web-fetch-http');
    const { officialFetchProvider, setOfficialFetchProvider } = await import('../lib/dsh/fallback.js');

    setOfficialFetchProvider(undefined);
    const provider = officialFetchProvider();
    assert.ok(provider instanceof official.HttpFetchProvider);
    assert.equal(provider.id, official.LOCAL_FETCH_PROVIDER_ID);
    assert.equal(provider.id, 'http');
    // 只造一次：抓取开关每关一次就重造一个实例，只会让「谁是回落目标」多出很多答案。
    assert.equal(officialFetchProvider(), provider);
  });
});


describe('18：调度策略经入口真实生效（SCHED-7）', () => {
  /**
   * 直接往临时 harness home 的密钥池里写一份余额缓存。
   *
   * 写文件而不是经 `/usage` 打桩，是因为本组用例要检验的是**排序**，余额从哪来与它无关；
   * 而走真实刷新路径会让每条用例多出一层与本需求无关的往返。
   */
  async function seedBalance(keyPoolPath, index, key) {
    const document = JSON.parse(await readFile(keyPoolPath, 'utf8'));
    document.usageCache[document.order[index]] = { key, fetchedAt: new Date().toISOString(), stale: false };
    await writeFile(keyPoolPath, JSON.stringify(document), 'utf8');
  }

  /** 一次搜索用的是哪把密钥——从出站请求的 Authorization 头读出来。 */
  async function keyUsedBy(host) {
    const { result } = await withStubbedFetch(
      () => ({ status: 200, body: { results: [{ url: 'https://ok.example' }] } }),
      (calls) => host.registered[0].search({ query: 'q' }).then(() => calls[0].authorization),
    );
    return result;
  }

  test('默认 balance：余额高的密钥先被选中', async () => {
    const host = await hostWithKeys([{ label: 'low' }, { label: 'high' }]);
    await seedBalance(host.keyPoolPath, 0, { limit: 200, usage: 190 });
    await seedBalance(host.keyPoolPath, 1, { limit: 200, usage: 0 });

    // 池里第二把（`-1-`）余额更高，因此默认策略下被选中。
    assert.match(await keyUsedBy(host), /^Bearer tvly-dev-1-/u);
  });

  test('切到 manual 之后按池内顺序选，不参考余额', async () => {
    const host = await hostWithKeys([{ label: 'low' }, { label: 'high' }]);
    await seedBalance(host.keyPoolPath, 0, { limit: 200, usage: 190 });
    await seedBalance(host.keyPoolPath, 1, { limit: 200, usage: 0 });

    host.setSettings({ schedulingPolicy: 'manual' });

    // 第一把余额更低，但 manual 只看顺序——这正是 `SCHED-7` 的「不参考余额」。
    assert.match(await keyUsedBy(host), /^Bearer tvly-dev-0-/u);
    // 而且**不轮转**：紧接着的第二次仍然选它。
    assert.match(await keyUsedBy(host), /^Bearer tvly-dev-0-/u);
  });

  test('手动顺序下的硬排除照旧：第一把失败后轮到第二把', async () => {
    const host = await hostWithKeys([{ label: 'first' }, { label: 'second' }]);
    host.setSettings({ schedulingPolicy: 'manual' });

    const { result } = await withStubbedFetch(
      (call) => (call.authorization.includes('-0-')
        ? { status: 500, body: { detail: { error: 'boom' } } }
        : { status: 200, body: { results: [{ url: 'https://ok.example' }] } }),
      (calls) => host.registered[0].search({ query: 'q' }).then(() => calls.map((call) => call.authorization)),
    );

    assert.equal(result.length, 2, '第一把 500 之后必须换第二把，而不是原地重试');
    assert.match(result[0], /^Bearer tvly-dev-0-/u);
    assert.match(result[1], /^Bearer tvly-dev-1-/u);
  });

  test('策略改动即时生效，不需要重新注册提供方', async () => {
    const host = await hostWithKeys([{ label: 'low' }, { label: 'high' }]);
    await seedBalance(host.keyPoolPath, 0, { limit: 200, usage: 190 });
    await seedBalance(host.keyPoolPath, 1, { limit: 200, usage: 0 });

    assert.match(await keyUsedBy(host), /^Bearer tvly-dev-1-/u, 'balance：选余额高的');
    host.setSettings({ schedulingPolicy: 'manual' });
    assert.match(await keyUsedBy(host), /^Bearer tvly-dev-0-/u, 'manual：改选顺序最前的');
    host.setSettings({ schedulingPolicy: 'balance' });
    assert.match(await keyUsedBy(host), /^Bearer tvly-dev-1-/u, '切回去又按余额');

    assert.equal(host.registered.length, 1, '全程只有一次注册');
  });
});

describe('14：调用历史经入口真的落盘', () => {
  /** 读一份落在临时 harness home 下的历史。 */
  async function readHistory(host) {
    const { CallHistory } = await import('../lib/history.js');
    const { HISTORY_FILE_NAME } = await import('../lib/constants.js');
    const history = new CallHistory({ dir: join(host.ctx.services.dshHomePath(STATE_DIR_NAME), ''), fileName: HISTORY_FILE_NAME });
    return history.read();
  }

  test('一次成功的搜索记一条，带端点、密钥与耗时', async () => {
    const host = await hostWithKeys([{ label: 'only' }]);
    await withStubbedFetch(
      () => ({ status: 200, body: { results: [{ url: 'https://ok.example' }], usage: { credits: 1 }, request_id: 'req-h1' } }),
      () => host.registered[0].search({ query: 'q' }),
    );

    // 历史是**排队落盘**的（`recordCall` 刻意不等待），因此这里要让事件循环跑几轮再读。
    let entries = [];
    for (let attempt = 0; attempt < 40 && entries.length === 0; attempt += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 25); });
      entries = await readHistory(host);
    }

    assert.equal(entries.length, 1);
    assert.equal(entries[0].endpoint, 'search');
    assert.equal(entries[0].outcome, 'ok');
    // 上游回传了 usage.credits，但插件刻意不读它：积分规则由上游随时可能更改，历史只记
    // 「发生了一次调用」这个事实（2026-09-20 决定）。
    assert.equal('credits' in entries[0], false, '历史记录里不再有积分字段');
    assert.equal(entries[0].requestId, 'req-h1', 'request_id 要持久化，供上游排障');
    assert.equal(entries[0].keyMasked, maskKey('tvly-dev-0-' + 'a'.repeat(20)), '脱敏形式当场存一份，密钥删掉后记录仍可读');
    assert.ok(entries[0].durationMs >= 0);
  });

  test('抓取记成 extract，并带上是这一次成功几个 URL（不再记积分）', async () => {
    const host = await hostWithKeys([{ label: 'only' }], { settings: fetchOn() });
    await withStubbedFetch(
      () => ({ status: 200, body: { results: [{ url: 'https://example.com', raw_content: '# 正文' }], failed_results: [] } }),
      () => host.registeredFetch[0].fetch({ url: 'https://example.com' }),
    );

    let entries = [];
    for (let attempt = 0; attempt < 40 && entries.length === 0; attempt += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 25); });
      entries = await readHistory(host);
    }

    assert.equal(entries.length, 1);
    assert.equal(entries[0].endpoint, 'extract');
    assert.equal(entries[0].successfulUrls, 1, '这一次成功几个 URL 要留下：它是关于这次调用的事实');
    assert.equal('credits' in entries[0], false, '积分估算不写进历史');
  });

  test('每次尝试各记一条——换过密钥的那次搜索留下两条', async () => {
    // 一次请求里的每次尝试都是一次真实的上游调用，也就各花各的积分。只记「请求级」的一条会
    // 让故障切换花掉的量在历史里消失。
    const host = await hostWithKeys([{ label: 'bad' }, { label: 'good' }]);
    await withStubbedFetch(
      (call) => (call.authorization.includes('-0-')
        ? { status: 500, body: { detail: { error: 'boom' } } }
        : { status: 200, body: { results: [{ url: 'https://ok.example' }] } }),
      () => host.registered[0].search({ query: 'q' }),
    );

    let entries = [];
    for (let attempt = 0; attempt < 40 && entries.length < 2; attempt += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 25); });
      entries = await readHistory(host);
    }

    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((item) => item.outcome), ['failed', 'ok']);
    assert.equal(entries[0].status, 500);
  });

  test('写不进去时不影响这次调用本身', async () => {
    // 历史是记录而不是正确性前提：把它的目录变成只读文件，搜索仍必须成功。
    const host = await hostWithKeys([{ label: 'only' }]);
    const { HISTORY_FILE_NAME } = await import('../lib/constants.js');
    const blocking = join(host.ctx.services.dshHomePath(STATE_DIR_NAME), HISTORY_FILE_NAME);
    await mkdir(blocking, { recursive: true });

    const { result } = await withStubbedFetch(
      () => ({ status: 200, body: { results: [{ url: 'https://ok.example' }] } }),
      (calls) => host.registered[0].search({ query: 'q' }).then((value) => ({ value, calls })),
    );

    assert.equal(result.value.sources.length, 1, '历史写不进去也不该让搜索失败');
    assert.equal(result.calls.length, 1);
  });
});

describe('host-contract-2：总预算读宿主真正绑定的值', () => {
  /**
   * 一个宿主的 `tools` 服务替身，只实现 `get(name)`。
   *
   * 真实签名是 `get(name, scope)`，且 `scope` 是发起调用的 agent——本插件在发起请求之前
   * 拿不到它，因此固定按**全局视图**（省略 scope）读取。这个替身照此实现，因此它同时也
   * 是「有没有偷偷去猜 agent」的判据：一旦代码传了 scope，这里会把它记下来。
   *
   * @param definitions - 工具名到定义的映射。
   * @returns 服务本身（形状 `{ get(name, scope) }`），外加一个 `scopes` 数组，
   *   记录每次读取用过的 scope。
   */
  function fakeTools(definitions) {
    const scopes = [];
    return {
      scopes,
      get(name, scope) {
        scopes.push(scope);
        return definitions[name];
      },
    };
  }

  test('宿主绑了 3000ms 时，单次尝试在一个远早于插件常量的时间点上超时', async () => {
    // **这是「读到了宿主绑定值」唯一的直接判据。** 宿主把 `timeoutMs` 绑在工具定义上、
    // 由 timeout-policy 武装成硬 deadline；插件若不读它，就会按自己的 20 秒单次超时排布，
    // 于是宿主先用一句 `tool call timed out after …ms` 顶掉上游的真实错误（`REST-10`）。
    //
    // 观测面只有一处：插件的单次尝试超时挂在它交给 `fetch` 的那个信号上。因此让 fetch
    // 一直挂着，看它多久被中止——3000ms 的宿主预算（减去余量后 1000ms，被单次尝试的下限
    // `MIN_ATTEMPT_TIMEOUT_MS` 抬到 2000ms）必定在 4.5 秒内中止，而按插件自己的常量
    // 排布时第一次尝试要 20 秒才会中止——那正是这条用例能反向验证的地方。
    const tools = fakeTools({ web_search: { timeoutMs: 3_000 } });
    const host = await hostWithKeys([{ label: 'only' }], { tools });

    const startedAt = Date.now();
    const outcome = await withStubbedFetch(
      // 一个「没有对端会回应」的连接：promise 一直挂着，直到插件的单次超时把信号中止掉。
      // `keep` 是有意留着的**普通**定时器：`AbortSignal.timeout` 内部的定时器不持有事件循环，
      // 少了它，Node 会在这个挂起的 await 处直接退出——那会被报成用例失败，而失败的其实是
      // 测试自己没能把时间等出来。
      (call) => new Promise((resolve, reject) => {
        const keep = setTimeout(() => reject(new Error('the plugin never aborted this attempt')), 15_000);
        call.signal?.addEventListener('abort', () => {
          clearTimeout(keep);
          reject(call.signal.reason);
        }, { once: true });
      }),
      (calls) => host.registered[0].search({ query: 'q' })
        .then(() => ({ aborted: false, calls }))
        .catch(() => ({ aborted: true, calls })),
    );
    const elapsed = Date.now() - startedAt;

    assert.equal(outcome.result.calls.length, 1, '只该发出一次尝试');
    assert.equal(outcome.result.aborted, true, '宿主给出的信号必须真的中止这次尝试');
    assert.ok(elapsed < 4_500, `必须按宿主绑定的 3000ms 排布，实际 ${String(elapsed)}ms`);
    assert.deepEqual(tools.scopes, [undefined], '必须按全局视图读，不去猜 agent scope');
  });

  test('宿主没有 tools 服务时退回常量预算，搜索照常', async () => {
    // 退化宿主（或 `tools` 在本 fiber 不可见）不是错误：预算是排布依据，不是正确性前提。
    // 判据是这次调用仍然成功，且**没有**因为读不到而抛。
    const host = await hostWithKeys([{ label: 'only' }]);

    const { result } = await withStubbedFetch(
      () => ({ status: 200, body: { results: [{ url: 'https://ok.example' }] } }),
      (calls) => host.registered[0].search({ query: 'q' }).then((value) => ({ value, calls })),
    );

    assert.equal(result.value.sources.length, 1, '读不到宿主预算时搜索必须照常');
    assert.equal(result.calls.length, 1);
  });

  test('抓取路径同样按 web_fetch 的绑定值排布', async () => {
    // 两条路径各自的宿主预算不同（`web_search` 默认 30 秒、`dsh-base` 抬到 60；`web_fetch`
    // 30 秒），因此「按工具名问」是这条修复的一半——两个常量共用一份读取代码时，把
    // `web_fetch` 写成 `web_search` 会让抓取按 60 秒排布，而宿主 30 秒就掐断。
    const tools = fakeTools({ web_search: { timeoutMs: 60_000 }, web_fetch: { timeoutMs: 3_000 } });
    const host = await hostWithKeys([{ label: 'only' }], { tools, settings: fetchOn() });

    const startedAt = Date.now();
    const outcome = await withStubbedFetch(
      (call) => new Promise((resolve, reject) => {
        const keep = setTimeout(() => reject(new Error('the plugin never aborted this attempt')), 15_000);
        call.signal?.addEventListener('abort', () => {
          clearTimeout(keep);
          reject(call.signal.reason);
        }, { once: true });
      }),
      (calls) => host.registeredFetch[0].fetch({ url: 'https://slow.example' })
        .then(() => ({ aborted: false, calls }))
        .catch(() => ({ aborted: true, calls })),
    );
    const elapsed = Date.now() - startedAt;

    assert.equal(outcome.result.calls.length, 1, '只该发出一次尝试');
    assert.equal(outcome.result.aborted, true);
    assert.ok(elapsed < 4_500, `抓取必须按 web_fetch 的 3000ms 排布，实际 ${String(elapsed)}ms`);
    assert.deepEqual(tools.scopes, [undefined], '同样按全局视图读');
  });
});
