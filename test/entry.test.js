/**
 * 插件入口，经由替身宿主检验。
 *
 * 决定接管到底能不能成立的两条规则都在这里：注册必须先于任何可能失败的事，且
 * `available()` 绝不能返回 false。
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import { apply, inject, name } from '../index.js';
import { KEYS_FILE_NAME, PROVIDER_ID, STATE_DIR_NAME } from '../lib/constants.js';
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
 * @param options - 宿主形状覆盖项。
 * @param options.harnessHome - `ctx.dshHomePath` 上报的 harness 主目录。
 * @param options.omitRegistration - 移除 seam 的注册函数。
 * @returns `{ ctx, registered, warnings, registerCalls }`。
 */
function fakeHost({ harnessHome, omitRegistration = false } = {}) {
  const registered = [];
  const warnings = [];
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
    settings: { register: () => ({ get: () => ({}), watch: () => () => {} }) },
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

  return { ctx, registered, warnings, registerCalls: () => registerCalls };
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
