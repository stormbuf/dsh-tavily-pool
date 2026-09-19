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
 * @returns `{ ctx, registered, warnings, registerCalls, settings }`。
 */
function fakeHost({ harnessHome, omitRegistration = false, settings = {} } = {}) {
  const registered = [];
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
      registerFetchProvider() {
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
    clientModules: {},
    connection: { fetch: { register: () => async () => {} } },
    dshHomePath: (...segments) => join(harnessHome ?? '/nonexistent-home/.dsh', ...segments),
  };
  if (omitRegistration) delete services.web.registerSearchProvider;

  const ctx = {
    get: (name) => services[name],
    services,
    // 自有属性，不是服务——因此刻意不出现在 `services` 里。
    logger: { warn: (message) => warnings.push(String(message)) },
  };

  return {
    ctx,
    registered,
    warnings,
    registerCalls: () => registerCalls,
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

  test('logger 损坏绝不会成为搜索失败的原因', () => {
    const host = fakeHost();
    // 方法会抛错的 logger 不得从 apply() 里传播出去：日志是尽力而为的，而这段代码
    // 运行在提供方已经注册之后。
    host.ctx.logger = {
      warn() {
        throw new Error('simulated logger failure');
      },
    };
    assert.doesNotThrow(() => {
      apply(host.ctx, {});
    });
    assert.equal(host.registered.length, 1);
  });

  test('退化的宿主在加载期被上报，并点名缺了什么', () => {
    const host = fakeHost();
    // 移除一项可选能力：探测仍须成功，而该发现必须进入日志，而不是被静默吞掉。
    delete host.ctx.services.dshHomePath;
    apply(host.ctx, {});

    assert.equal(host.registered.length, 1, '退化的宿主不得阻止注册');
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

describe('搜索失败会带上可据以行动的 code 上报', () => {
  test('空池会告诉用户去哪里添加密钥', async () => {
    const host = fakeHost({ harnessHome: await temporaryHarnessHome() });
    apply(host.ctx, {});

    const error = await host.registered[0].search({ query: 'q' }).catch((thrown) => thrown);
    assert.equal(error.code, 'TAVILY_NO_USABLE_KEY');
    assert.match(error.message, /no Tavily key is configured/u);
    assert.match(error.message, /dsh-tavily-pool/u);
  });

  test('损坏的密钥池文件按路径上报，而不是报成空池', async () => {
    const host = fakeHost({ harnessHome: await temporaryHarnessHome('not json at all') });
    apply(host.ctx, {});

    const error = await host.registered[0].search({ query: 'q' }).catch((thrown) => thrown);
    assert.equal(error.code, 'TAVILY_NO_USABLE_KEY');
    assert.match(error.message, /could not be read/u);
    assert.match(error.message, /keys\.json/u);
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
      authorization: init?.headers?.authorization,
      body: JSON.parse(init?.body ?? '{}'),
    };
    calls.push(call);
    const outcome = handler(call) ?? { status: 200, body: { results: [] } };
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
async function hostWithKeys(keys, options = {}) {
  const home = await temporaryHarnessHome('{"version":1,"keys":[],"order":[],"stats":{},"usageCache":{}}');
  const host = fakeHost({ harnessHome: home, settings: options.settings });
  apply(host.ctx, {});

  // 先经真实的加载路径读入空池，再经存储自身的编辑接口添加密钥——与面板将来做的
  // 是同一件事，因此这里检验的是真实的往返，而不是一份手工写出的文件。
  const { PoolStore } = await import('../lib/pool.js');
  const store = new PoolStore({ dir: join(home, STATE_DIR_NAME), fileName: KEYS_FILE_NAME });
  await store.load();
  for (const [index, entry] of keys.entries()) {
    await store.addKey({ key: `tvly-dev-${index}-${'a'.repeat(20)}`, label: entry.label });
  }
  return host;
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

    assert.equal(error.code, 'TAVILY_NO_USABLE_KEY');
    assert.match(error.message, /out of credits/u);
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
    assert.equal(error.code, 'TAVILY_NO_USABLE_KEY');
    assert.match(error.message, /no Tavily key is configured/u);
  });

  test('关闭搜索开关时不再向 Tavily 发请求', async () => {
    const host = await hostWithKeys([{ label: 'only' }], { settings: { [SETTINGS_NAMESPACE]: {} } });
    host.setSettings({ searchEnabled: false });

    let requests = 0;
    const error = await withStubbedFetch(
      () => {
        requests += 1;
        return { status: 200, body: {} };
      },
      () => host.registered[0].search({ query: 'q' }).catch((thrown) => thrown),
    ).then(({ result }) => result);

    assert.equal(requests, 0, '开关关闭时不得向 api.tavily.com 发起任何请求');
    assert.equal(error.code, 'TAVILY_SEARCH_DISABLED', '并且要说清楚发生了什么');
  });

  test('开关改动即时生效，无需重新注册提供方', async () => {
    const host = await hostWithKeys([{ label: 'only' }], { settings: { [SETTINGS_NAMESPACE]: {} } });
    const provider = host.registered[0];

    host.setSettings({ searchEnabled: false });
    const disabled = await provider.search({ query: 'q' }).catch((thrown) => thrown);
    assert.equal(disabled.code, 'TAVILY_SEARCH_DISABLED');

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
