/**
 * 面板的领域逻辑：状态投影与命令执行（`PANEL-4`、`POOL-3`、`USAGE-1`、`USAGE-2`）。
 *
 * 这里全程用**真实的** `PoolStore`（落在临时目录上），不替身：本文件最要紧的两条断言
 * 是「响应里绝不出现明文」与「编辑真的落盘」，而它们只有在真正经过脱敏视图与原子写入
 * 时才成立。替身会把「我以为的脱敏」复制进测试，于是明文照样泄漏而测试全绿。
 *
 * HTTP 那一层不在本文件的射程内（见 `dsh-panel-routes.test.js`）：这里检验的是「命令
 * 做了什么、返回什么」，`{status, body}` 已经足够表达，不必起一个服务器来观察。
 */

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import { PANEL_ERROR_CODES, PanelError, classifyConnectivity, readPanelState, runPanelCommand } from '../lib/panel.js';
import { PoolStore } from '../lib/pool.js';

/** 用例里用到的那把明文密钥。任何响应里出现它，都是 `POOL-3` 的失败。 */
const SECRET = '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';

/** 第二把，用于排序与启停用例。 */
const OTHER_SECRET = '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';

/** 一个落在全新临时目录上的真实密钥池。 */
async function temporaryPool() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tavily-panel-'));
  return new PoolStore({ dir, fileName: 'keys.json' }).load();
}

/**
 * 组装一份面板依赖。
 *
 * @param options - 可覆盖项。
 * @param options.pool - 密钥池；省略时新建一个空池。
 * @param options.settings - 当前设置。
 * @param options.writeSettings - 设置写入 thunk。
 * @param options.refresh - 余额刷新替身。
 * @returns `{ deps, pool, settings }`，`settings` 是一个会被写入改动的可变盒子。
 */
async function panelDeps({ pool, settings, writeSettings, refresh } = {}) {
  const store = pool ?? await temporaryPool();
  const box = {
    value: settings ?? {
      searchEnabled: true,
      searchDepth: 'basic',
      maxResults: 10,
      topic: 'general',
      includeAnswer: false,
    },
    patches: [],
  };
  return {
    pool: store,
    box,
    deps: {
      pool: store,
      readSettings: () => box.value,
      writeSettings: writeSettings ?? (async (patch) => {
        box.patches.push(patch);
        box.value = { ...box.value, ...patch };
      }),
      refresh: refresh ?? (async () => ({ ok: true, recovered: false })),
    },
  };
}

describe('POOL-3：任何响应都不含密钥明文', () => {
  test('状态投影只给脱敏形式，且带齐卡片要显示的字段', async () => {
    const pool = await temporaryPool();
    const added = await pool.addKey({ key: SECRET, label: 'primary' });
    const state = readPanelState({ settings: {}, pool, capabilityReport: undefined, fallback: {} });

    assert.equal(state.keys.length, 1);
    assert.equal(state.keys[0].id, added.id);
    assert.equal(state.keys[0].masked, 'tvly-dev-…iJWq', '脱敏形式保留可识别的首尾段');
    assert.equal(JSON.stringify(state).includes(SECRET), false, '状态里绝不能出现明文');
  });

  test('每一条命令的响应都不含明文', async () => {
    const { deps, pool } = await panelDeps();
    const responses = [];

    responses.push(await runPanelCommand('keys', { action: 'add', key: SECRET, label: 'a' }, deps));
    const [first] = pool.keysInOrder();
    responses.push(await runPanelCommand('keys', { action: 'rename', id: first.id, label: 'b' }, deps));
    responses.push(await runPanelCommand('keys', { action: 'setDisabled', id: first.id, disabled: true }, deps));
    responses.push(await runPanelCommand('keys', { action: 'reorder', ids: [first.id] }, deps));
    responses.push(await runPanelCommand('refresh', {}, deps));
    responses.push(await runPanelCommand('test', { id: first.id }, deps));
    responses.push(await runPanelCommand('keys', { action: 'remove', id: first.id }, deps));

    for (const response of responses) {
      assert.equal(
        JSON.stringify(response).includes(SECRET),
        false,
        `命令响应里出现了明文：${JSON.stringify(response).slice(0, 200)}`,
      );
    }
  });

  test('添加时落盘的是明文，而出口只有脱敏——这正是 POOL-2 与 POOL-3 的分工', async () => {
    const { deps, pool } = await panelDeps();
    await runPanelCommand('keys', { action: 'add', key: SECRET }, deps);

    assert.equal(pool.keysInOrder()[0].key, SECRET, '本地文件里存明文（POOL-2）');
    assert.equal(JSON.stringify(deps.pool.maskedList()).includes(SECRET), false, '而任何出口都只有脱敏（POOL-3）');
  });
});

describe('面板状态投影', () => {
  test('密钥池文件损坏时报告错误而不是抛错（POOL-7）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tavily-panel-broken-'));
    const store = new PoolStore({ dir, fileName: 'keys.json' });
    await store.load();
    await store.addKey({ key: SECRET });
    // 直接写坏文件，再让存储重新读盘——这正是用户手工编辑坏文件后的情形。
    await import('node:fs/promises').then(({ writeFile }) => writeFile(store.filePath, '{ not json', 'utf8'));
    const reloaded = await new PoolStore({ dir, fileName: 'keys.json' }).load();

    const state = readPanelState({ settings: {}, pool: reloaded, capabilityReport: undefined, fallback: {} });

    assert.deepEqual(state.keys, [], '坏文件按空池继续');
    assert.equal(state.poolError.reason, 'malformed');
    assert.equal(state.poolError.path, reloaded.filePath, '要告诉用户该去修哪个文件');
    assert.match(state.poolError.message, /not valid JSON/u);
    assert.equal(JSON.stringify(state).includes(SECRET), false, '连错误路径也不能泄漏明文');
  });

  test('密钥池正常时 poolError 为 null', async () => {
    const { deps } = await panelDeps();
    const state = readPanelState({ settings: {}, pool: deps.pool, capabilityReport: undefined, fallback: {} });
    assert.equal(state.poolError, null);
  });

  test('插件初始化失败时给出空列表与说明，而不是让整个面板变成 500', async () => {
    const state = readPanelState({ settings: {}, pool: undefined, capabilityReport: undefined, fallback: {} });

    assert.deepEqual(state.keys, []);
    assert.equal(state.poolError.reason, 'unavailable');
    assert.match(state.poolError.message, /did not finish loading/u);
  });

  test('能力探测结果被暴露出来（COMPAT-3）', async () => {
    const report = {
      ok: false,
      missingRequired: ['settings.register'],
      missingOptional: [],
      summary: 'missing capabilities — required [settings.register], optional []',
      findings: [{ id: 'settings.register', status: 'missing', detail: 'not a function', remedy: 'ctx.settings.register' }],
    };
    const state = readPanelState({ settings: {}, pool: undefined, capabilityReport: report, fallback: {} });

    assert.equal(state.capabilities.ok, false);
    assert.deepEqual(state.capabilities.missingRequired, ['settings.register']);
    assert.equal(state.capabilities.findings[0].remedy, 'ctx.settings.register', '面板要能说清该去哪里看');
  });

  test('两个开关都经 settings 投影出去，面板不需要额外的可用性字段', async () => {
    // `09` 落地时这里曾断言 `fetchToggleAvailable === false`：那时抓取开关确实不存在
    // （属于 `10`），而渲染一个拨了没反应的开关比不渲染更糟。`10` 落地后两个开关都真的
    // 存在，于是那个字段**连同它的断言一起删掉**——留着一个恒为 `true` 的字段，只会让下一
    // 个读代码的人以为它还在表达什么。
    const state = readPanelState({
      settings: { searchEnabled: true, fetchEnabled: false },
      pool: undefined,
      capabilityReport: undefined,
      fallback: {},
    });
    assert.equal(state.settings.searchEnabled, true);
    assert.equal(state.settings.fetchEnabled, false);
    assert.equal('fetchToggleAvailable' in state, false, '那个字段的消费方已随 10 一起消失');
  });
});

describe('POOL-4：密钥池的增删改启停排序', () => {
  test('添加后立即出现在脱敏列表里，并带上备注', async () => {
    const { deps } = await panelDeps();
    const { status, body } = await runPanelCommand('keys', { action: 'add', key: SECRET, label: 'primary' }, deps);

    assert.equal(status, 200);
    assert.equal(body.keys.length, 1);
    assert.equal(body.keys[0].label, 'primary');
    assert.equal(body.keys[0].disabled, false);
  });

  test('添加时会去掉密钥两端的空白', async () => {
    const { deps, pool } = await panelDeps();
    await runPanelCommand('keys', { action: 'add', key: `  ${SECRET}\n` }, deps);
    assert.equal(pool.keysInOrder()[0].key, SECRET, '粘贴常常带上换行与空格');
  });

  test('空密钥被拒绝', async () => {
    const { deps } = await panelDeps();
    await assert.rejects(
      () => runPanelCommand('keys', { action: 'add', key: '   ' }, deps),
      (error) => error instanceof PanelError && error.code === PANEL_ERROR_CODES.BAD_REQUEST,
    );
  });

  test('备注缺席时不写入空字符串', async () => {
    const { deps, pool } = await panelDeps();
    await runPanelCommand('keys', { action: 'add', key: SECRET }, deps);
    assert.equal('label' in pool.keysInOrder()[0], false, '空备注表示「没有备注」，不是「备注为空串」');
  });

  test('删除把密钥连同它的历史一起移除', async () => {
    const { deps, pool } = await panelDeps();
    const { body: added } = await runPanelCommand('keys', { action: 'add', key: SECRET }, deps);
    const id = added.keys[0].id;

    const { body } = await runPanelCommand('keys', { action: 'remove', id }, deps);

    assert.deepEqual(body.keys, []);
    assert.equal(pool.keysInOrder().length, 0);
  });

  test('启停只影响调度字段，记录与统计都保留（POOL-5）', async () => {
    const { deps } = await panelDeps();
    const { body: added } = await runPanelCommand('keys', { action: 'add', key: SECRET }, deps);
    const id = added.keys[0].id;

    const { body } = await runPanelCommand('keys', { action: 'setDisabled', id, disabled: true }, deps);

    assert.equal(body.keys[0].disabled, true);
    assert.equal(body.keys[0].id, id, '停用不是删除：记录还在，统计也还在');

    const reenabled = await runPanelCommand('keys', { action: 'setDisabled', id, disabled: false }, deps);
    assert.equal(reenabled.body.keys[0].disabled, false, '重新启用时历史仍在');
  });

  test('改备注：空串表示清除', async () => {
    const { deps, pool } = await panelDeps();
    const { body: added } = await runPanelCommand('keys', { action: 'add', key: SECRET, label: 'x' }, deps);
    const id = added.keys[0].id;

    const renamed = await runPanelCommand('keys', { action: 'rename', id, label: 'y' }, deps);
    assert.equal(renamed.body.keys[0].label, 'y');

    const cleared = await runPanelCommand('keys', { action: 'rename', id, label: '' }, deps);
    assert.equal(cleared.body.keys[0].label, '');
    assert.equal('label' in pool.keysInOrder()[0], false);
  });

  test('重排按传入顺序生效', async () => {
    const { deps } = await panelDeps();
    await runPanelCommand('keys', { action: 'add', key: SECRET }, deps);
    await runPanelCommand('keys', { action: 'add', key: OTHER_SECRET }, deps);
    const ids = deps.pool.keysInOrder().map((record) => record.id);

    const { body } = await runPanelCommand('keys', { action: 'reorder', ids: [ids[1], ids[0]] }, deps);

    assert.deepEqual(body.keys.map((entry) => entry.id), [ids[1], ids[0]]);
  });

  test('不存在的 id 是 404，而不是 400 或 500', async () => {
    const { deps } = await panelDeps();
    await assert.rejects(
      () => runPanelCommand('keys', { action: 'remove', id: 'no-such-id' }, deps),
      (error) => error.status === 404 && error.code === PANEL_ERROR_CODES.NO_SUCH_KEY,
    );
  });

  test('未知的密钥池动作是 404，并指名是哪一个', async () => {
    const { deps } = await panelDeps();
    await assert.rejects(
      () => runPanelCommand('keys', { action: 'explode' }, deps),
      (error) => error.status === 404 && /explode/u.test(error.message),
    );
  });

  test('形状不对的入参是 400', async () => {
    const { deps } = await panelDeps();
    const { body: added } = await runPanelCommand('keys', { action: 'add', key: SECRET }, deps);
    const id = added.keys[0].id;

    for (const payload of [
      { action: 'remove' },
      { action: 'remove', id: 7 },
      { action: 'setDisabled', id, disabled: 'yes' },
      { action: 'rename', id, label: null },
      { action: 'reorder', ids: 'not-an-array' },
      { action: 'reorder', ids: [1, 2] },
    ]) {
      await assert.rejects(
        () => runPanelCommand('keys', payload, deps),
        (error) => error.status === 400,
        `${JSON.stringify(payload)} 必须被拒绝`,
      );
    }
  });

  test('未知命令是 404', async () => {
    const { deps } = await panelDeps();
    await assert.rejects(
      () => runPanelCommand('nonsense', {}, deps),
      (error) => error.status === 404 && error.code === PANEL_ERROR_CODES.UNKNOWN_COMMAND,
    );
  });

  test('密钥池缺席时以 503 拒绝，而不是抛 TypeError', async () => {
    const { deps } = await panelDeps();
    await assert.rejects(
      () => runPanelCommand('keys', { action: 'remove', id: 'x' }, { ...deps, pool: undefined }),
      (error) => error.status === 503 && error.code === PANEL_ERROR_CODES.UNAVAILABLE,
    );
  });
});

describe('CFG-3、CFG-4：设置经宿主写入，校验失败原样透出', () => {
  test('patch 被合并进设置并读回新值', async () => {
    const { deps, box } = await panelDeps();
    const { status, body } = await runPanelCommand('settings', { patch: { searchDepth: 'advanced' } }, deps);

    assert.equal(status, 200);
    assert.deepEqual(box.patches, [{ searchDepth: 'advanced' }]);
    assert.equal(body.settings.searchDepth, 'advanced');
  });

  test('schema 拒绝的文案原样透出，用户才知道该改成什么', async () => {
    const { deps } = await panelDeps({
      writeSettings: async () => {
        throw new TypeError('$.maxResults expected number <= 20 but got 21');
      },
    });

    await assert.rejects(
      () => runPanelCommand('settings', { patch: { maxResults: 21 } }, deps),
      (error) => error.status === 400
        && error.code === PANEL_ERROR_CODES.INVALID_SETTINGS
        && error.message === '$.maxResults expected number <= 20 but got 21',
    );
  });

  test('宿主报的 revision 冲突映射成 409', async () => {
    const { deps } = await panelDeps({
      writeSettings: async () => {
        const error = new Error('settings namespace dsh-tavily-pool moved');
        error.code = 'SETTINGS_CONFLICT';
        throw error;
      },
    });

    await assert.rejects(
      () => runPanelCommand('settings', { patch: {} }, deps),
      (error) => error.status === 409 && error.code === PANEL_ERROR_CODES.SETTINGS_CONFLICT,
    );
  });

  test('宿主没有 settings 服务时映射成 503，而不是 400', async () => {
    // 报成 400 会让用户以为是自己填错了值。
    const { deps } = await panelDeps({
      writeSettings: async () => {
        const error = new Error('the host has no settings service');
        error.code = PANEL_ERROR_CODES.UNAVAILABLE;
        throw error;
      },
    });

    await assert.rejects(
      () => runPanelCommand('settings', { patch: { topic: 'news' } }, deps),
      (error) => error.status === 503 && error.code === PANEL_ERROR_CODES.UNAVAILABLE,
    );
  });

  test('patch 不是对象时是 400，且不会碰写入路径', async () => {
    const { deps, box } = await panelDeps();
    for (const patch of [undefined, null, 'x', 3, ['a']]) {
      await assert.rejects(
        () => runPanelCommand('settings', { patch }, deps),
        (error) => error.status === 400 && error.code === PANEL_ERROR_CODES.BAD_REQUEST,
        `${JSON.stringify(patch)} 必须被拒绝`,
      );
    }
    assert.deepEqual(box.patches, [], '形状不对的入参不该走到宿主那里');
  });
});

describe('USAGE-1、USAGE-2：余额刷新', () => {
  test('不带 id 时刷新池内全部密钥，含已停用者', async () => {
    const calls = [];
    const { deps } = await panelDeps({
      refresh: async (id, key) => {
        calls.push({ id, key });
        return { ok: true };
      },
    });
    await runPanelCommand('keys', { action: 'add', key: SECRET }, deps);
    await runPanelCommand('keys', { action: 'add', key: OTHER_SECRET }, deps);
    const [first] = deps.pool.keysInOrder();
    await runPanelCommand('keys', { action: 'setDisabled', id: first.id, disabled: true }, deps);

    const { body } = await runPanelCommand('refresh', {}, deps);

    assert.equal(body.results.length, 2, '停用只影响调度（POOL-5），余额仍应可刷');
    assert.deepEqual(calls.map((call) => call.key).sort(), [SECRET, OTHER_SECRET].sort());
  });

  test('带 id 时只刷新那一把', async () => {
    const calls = [];
    const { deps } = await panelDeps({ refresh: async (id) => { calls.push(id); return { ok: true }; } });
    await runPanelCommand('keys', { action: 'add', key: SECRET }, deps);
    await runPanelCommand('keys', { action: 'add', key: OTHER_SECRET }, deps);
    const [first] = deps.pool.keysInOrder();

    await runPanelCommand('refresh', { id: first.id }, deps);

    assert.deepEqual(calls, [first.id]);
  });

  test('刷新器缺席时以 503 拒绝', async () => {
    const { deps } = await panelDeps();
    await assert.rejects(
      () => runPanelCommand('refresh', {}, { ...deps, refresh: undefined }),
      (error) => error.status === 503,
    );
  });

  test('配额跳过如实上报，绝不假装刷新成功（USAGE-2）', async () => {
    // 假装成功会让用户以为屏幕上的余额是新鲜的——而那正是这个按钮存在的意义。
    const { deps } = await panelDeps({ refresh: async () => ({ ok: false, skipped: 'quota', reason: 'manual' }) });
    await runPanelCommand('keys', { action: 'add', key: SECRET }, deps);

    const { body } = await runPanelCommand('refresh', {}, deps);

    assert.equal(body.results[0].ok, false);
    assert.equal(body.results[0].skipped, 'quota');
    assert.equal(body.results[0].error, null, '跳过不是失败，没有错误可报');
  });

  test('刷新失败报告陈旧标记与错误码（USAGE-3）', async () => {
    const { deps } = await panelDeps({
      refresh: async () => {
        const error = new Error('Tavily usage query returned HTTP 500: boom');
        error.code = 'TAVILY_HTTP_500';
        error.status = 500;
        return { ok: false, stale: true, error };
      },
    });
    await runPanelCommand('keys', { action: 'add', key: SECRET }, deps);

    const { body } = await runPanelCommand('refresh', {}, deps);

    assert.equal(body.results[0].ok, false);
    assert.equal(body.results[0].stale, true);
    assert.equal(body.results[0].error.code, 'TAVILY_HTTP_500');
    assert.equal(body.results[0].error.status, 500);
  });

  test('刷新成功时报告余额是否因此恢复（SCHED-8）', async () => {
    const { deps } = await panelDeps({ refresh: async () => ({ ok: true, recovered: true }) });
    await runPanelCommand('keys', { action: 'add', key: SECRET }, deps);

    const { body } = await runPanelCommand('refresh', {}, deps);

    assert.equal(body.results[0].ok, true);
    assert.equal(body.results[0].recovered, true);
  });

  test('按池内顺序串行刷新', async () => {
    // 串行不是性能取舍：配额预占按密钥维度记账，并发只会让「跳过」出现在不可预期的位置。
    const order = [];
    const { deps } = await panelDeps({
      refresh: async (id) => {
        order.push(id);
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { ok: true };
      },
    });
    await runPanelCommand('keys', { action: 'add', key: SECRET }, deps);
    await runPanelCommand('keys', { action: 'add', key: OTHER_SECRET }, deps);
    const ids = deps.pool.keysInOrder().map((record) => record.id);

    await runPanelCommand('refresh', {}, deps);

    assert.deepEqual(order, ids);
  });
});

describe('12：单密钥连通性测试', () => {
  test('成功时归类为 ok', async () => {
    const { deps } = await panelDeps({ refresh: async () => ({ ok: true }) });
    await runPanelCommand('keys', { action: 'add', key: SECRET }, deps);
    const [record] = deps.pool.keysInOrder();

    const { status, body } = await runPanelCommand('test', { id: record.id }, deps);

    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.classification, 'ok');
  });

  test('配额用尽时如实说是配额，而不是失败或静默', async () => {
    const { deps } = await panelDeps({ refresh: async () => ({ ok: false, skipped: 'quota' }) });
    await runPanelCommand('keys', { action: 'add', key: SECRET }, deps);
    const [record] = deps.pool.keysInOrder();

    const { body } = await runPanelCommand('test', { id: record.id }, deps);

    assert.equal(body.ok, false);
    assert.equal(body.classification, 'quota');
    assert.match(body.error.message, /10 calls per 600s/u);
  });

  test('鉴权失败、限流与网络不可达分得开：一个要换密钥，一个只需等', async () => {
    const cases = [
      [{ status: 401, detail: 'invalid api key', code: 'TAVILY_HTTP_401' }, 'auth'],
      [{ status: 429, code: 'TAVILY_HTTP_429', retryAfter: '30' }, 'rate-limited'],
      [{ status: 432, code: 'TAVILY_HTTP_432' }, 'exhausted'],
      [{ code: 'TAVILY_NETWORK_ERROR' }, 'network'],
      [{ code: 'TAVILY_TIMEOUT' }, 'network'],
      [{ status: 500, code: 'TAVILY_HTTP_500' }, 'upstream'],
      [{ status: 400, code: 'TAVILY_HTTP_400' }, 'fatal'],
    ];

    for (const [failure, expected] of cases) {
      const { deps } = await panelDeps({ refresh: async () => ({ ok: false, stale: true, error: failure }) });
      await runPanelCommand('keys', { action: 'add', key: SECRET }, deps);
      const [record] = deps.pool.keysInOrder();

      const { body } = await runPanelCommand('test', { id: record.id }, deps);

      assert.equal(body.classification, expected, `${JSON.stringify(failure)} 应归入 ${expected}`);
      assert.equal(body.ok, false);
    }
  });

  test('分类复用 04 的分类器：401 在调度里是冷却，在这里是鉴权', () => {
    // 两处对同一次失败的理解必须一致，只是措辞粒度不同：调度关心「下一步对这把密钥做
    // 什么」，面板关心「用户该去改什么」。
    assert.equal(classifyConnectivity({ status: 401, code: 'TAVILY_HTTP_401' }), 'auth');
    assert.equal(classifyConnectivity({ status: 403, code: 'TAVILY_HTTP_403' }), 'auth');
  });

  test('没有状态码的失败一律算网络，不硬凑一个结论', () => {
    assert.equal(classifyConnectivity({ code: 'TAVILY_UNPROCESSABLE_RESPONSE' }), 'network');
    assert.equal(classifyConnectivity(undefined), 'network');
  });
});
