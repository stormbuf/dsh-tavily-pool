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
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import {
  HISTORY_CHART_DAYS,
  PANEL_ERROR_CODES,
  PANEL_HISTORY_ENTRIES,
  PanelError,
  classifyConnectivity,
  readPanelState,
  runPanelCommand,
} from '../lib/panel.js';
import {
  HISTORY_MAX_ENTRIES,
  PANEL_KEY_MAX_LENGTH,
  PANEL_KEYS_MAX,
  PANEL_KEYS_MAX_PER_REQUEST,
} from '../lib/constants.js';
import { KeyHealth } from '../lib/health.js';
import { PoolStore } from '../lib/pool.js';
import { UsageQuota, UsageRefresher } from '../lib/usage.js';

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
 * @returns `{ deps, pool, box, added }`，`box` 是一个会被写入改动的可变设置盒子，
 *   `added` 收集 `onKeysAdded` 收到的记录（`USAGE-8` 在添加路径上的触发点）。
 */
async function panelDeps({ pool, settings, writeSettings, refresh } = {}) {
  const store = pool ?? await temporaryPool();
  const added = [];
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
    added,
    deps: {
      pool: store,
      readSettings: () => box.value,
      writeSettings: writeSettings ?? (async (patch) => {
        box.patches.push(patch);
        box.value = { ...box.value, ...patch };
      }),
      refresh: refresh ?? (async () => ({ ok: true, recovered: false })),
      onKeysAdded: (records) => added.push(...records),
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

describe('POOL-8：批量添加', () => {
  /** 五行文本：一行带缩进、一行空、一行全是空白、一行与第一行重复。 */
  const PASTED = [
    '  tvly-dev-batch-one-000000000000  ',
    '',
    'tvly-dev-batch-two-000000000000',
    'tvly-dev-batch-one-000000000000',
    '   ',
  ].join('\n');

  test('一行一把：两侧空白被去掉，空行不算密钥', async () => {
    const { deps, pool } = await panelDeps();
    const { status, body } = await runPanelCommand('keys', { action: 'addBatch', text: PASTED }, deps);

    assert.equal(status, 200);
    assert.deepEqual(
      pool.keysInOrder().map((record) => record.key),
      ['tvly-dev-batch-one-000000000000', 'tvly-dev-batch-two-000000000000'],
    );
    assert.equal(body.keys.length, 2);
  });

  test('重复的被跳过，且如实报告新增与跳过的条数', async () => {
    const { deps } = await panelDeps();
    const { body } = await runPanelCommand('keys', { action: 'addBatch', text: PASTED }, deps);

    assert.deepEqual(body.summary, { received: 3, added: 2, duplicates: 1 });
  });

  test('USAGE-8：新加入的密钥被交给 onKeysAdded，重复的不会被交出去', async () => {
    // 新密钥没有余额读数，因此这一趟必然为它们各问一次官方。**只交真正新增的那些**：
    // 被跳过的重复行对应的密钥池里早就有了，再问一次纯属浪费官方配额。
    const { deps, added } = await panelDeps();
    await runPanelCommand('keys', { action: 'addBatch', text: PASTED }, deps);

    assert.deepEqual(
      added.map((record) => record.key),
      ['tvly-dev-batch-one-000000000000', 'tvly-dev-batch-two-000000000000'],
      '只交出真正新增的两把，不含被跳过的那一行',
    );
  });

  test('USAGE-8：单把添加也交给 onKeysAdded', async () => {
    const { deps, added } = await panelDeps();
    await runPanelCommand('keys', { action: 'add', key: SECRET }, deps);

    assert.deepEqual(added.map((record) => record.key), [SECRET]);
  });

  test('USAGE-8：重复的单把添加不触发刷新', async () => {
    const { deps, added } = await panelDeps();
    await runPanelCommand('keys', { action: 'add', key: SECRET }, deps);
    added.length = 0;
    await runPanelCommand('keys', { action: 'add', key: SECRET }, deps);

    assert.deepEqual(added, [], '没有新增就没有新读数要补');
  });

  test('池里已有的密钥也算重复：粘贴一整份清单不会得到两把一样的密钥', async () => {
    const { deps, pool } = await panelDeps();
    await runPanelCommand('keys', { action: 'add', key: SECRET }, deps);

    const { body } = await runPanelCommand('keys', {
      action: 'addBatch',
      text: `${SECRET}\ntvly-dev-batch-new-000000000000\n`,
    }, deps);

    assert.deepEqual(body.summary, { received: 2, added: 1, duplicates: 1 });
    assert.equal(pool.keysInOrder().length, 2);
  });

  test('粘贴的全是池里已有的密钥时不算失败，只是没有新增', async () => {
    // 「一行都没识别出来」与「识别出来了但没有一把是新的」是两回事：前者是贴错了东西，
    // 后者是把同一份清单又贴了一遍。前者按入参非法拒绝，后者如实回一份 `added: 0`。
    const { deps } = await panelDeps();
    await runPanelCommand('keys', { action: 'add', key: SECRET }, deps);

    const { status, body } = await runPanelCommand('keys', { action: 'addBatch', text: SECRET }, deps);

    assert.equal(status, 200);
    assert.deepEqual(body.summary, { received: 1, added: 0, duplicates: 1 });
    assert.equal(body.keys.length, 1);
  });

  test('一行密钥都没有时按入参非法拒绝，而不是回一个静悄悄的 0', async () => {
    const { deps, pool } = await panelDeps();
    for (const text of ['   ', '\n\n\n', '  \t  \n ']) {
      await assert.rejects(
        () => runPanelCommand('keys', { action: 'addBatch', text }, deps),
        (error) => error instanceof PanelError && error.code === PANEL_ERROR_CODES.BAD_REQUEST,
        `${JSON.stringify(text)} 必须被拒绝`,
      );
    }
    // 拒绝要**什么都不留下**：密钥池没变，也没落过一次盘（spec 的 POOL-10 场景）。
    assert.deepEqual(pool.keysInOrder(), []);
    assert.equal(pool.lastWriteError, undefined);
    await assert.rejects(
      () => readFile(pool.filePath, 'utf8'),
      (error) => error.code === 'ENOENT',
      '被拒绝的批量添加不该开出一个池文件',
    );
  });

  test('text 缺席、不是字符串或为空串时都是 400', async () => {
    const { deps } = await panelDeps();
    for (const payload of [{ action: 'addBatch' }, { action: 'addBatch', text: 7 }, { action: 'addBatch', text: '' }]) {
      await assert.rejects(
        () => runPanelCommand('keys', payload, deps),
        (error) => error.status === 400,
        `${JSON.stringify(payload)} 必须被拒绝`,
      );
    }
  });

  test('响应里只有脱敏形式，而两把都真的加进去了（POOL-2、POOL-3）', async () => {
    const { deps, pool } = await panelDeps();
    const response = await runPanelCommand('keys', {
      action: 'addBatch',
      text: `  ${SECRET}  \n${OTHER_SECRET}`,
    }, deps);

    assert.deepEqual(pool.keysInOrder().map((record) => record.key), [SECRET, OTHER_SECRET], '落盘的是明文');
    assert.equal(JSON.stringify(response).includes(SECRET), false);
    assert.equal(JSON.stringify(response).includes(OTHER_SECRET), false);
    assert.equal(response.body.keys.length, 2);
  });

  test('CRLF 文本同样一行一把：从网页表格里复制出来的常常是它', async () => {
    const { deps, pool } = await panelDeps();
    await runPanelCommand('keys', { action: 'addBatch', text: `${SECRET}\r\n${OTHER_SECRET}\r\n` }, deps);

    assert.deepEqual(pool.keysInOrder().map((record) => record.key), [SECRET, OTHER_SECRET]);
  });

  test('parseKeyLines 给出去重后的明文与计数，不把明文带进返回值以外的地方', async () => {
    const { parseKeyLines } = await import('../lib/panel.js');
    const parsed = parseKeyLines(PASTED, { existing: ['tvly-dev-batch-two-000000000000'] });

    assert.deepEqual(parsed.fresh, ['tvly-dev-batch-one-000000000000'], '池里已有的不算新增');
    assert.equal(parsed.received, 3);
    assert.equal(parsed.duplicates, 2, '批内重复与池内重复走同一条路');
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

describe('14：调用历史的投影', () => {
  /** 一条调用记录。积分字段已不存在（2026-09-20 决定：插件不再统计自身消耗）。 */
  function record(at, overrides = {}) {
    return {
      at: new Date(at).toISOString(),
      endpoint: 'search',
      keyId: 'key-1',
      keyMasked: 'tvly-dev-…iJWq',
      outcome: 'ok',
      durationMs: 100,
      ...overrides,
    };
  }

  test('history 缺席时给空数组，而不是让整个状态变成 undefined', () => {
    const state = readPanelState({ settings: {}, fallback: {} });

    assert.deepEqual(state.history.entries, []);
    assert.equal(state.history.error, null);
    assert.equal(state.history.daily.length, HISTORY_CHART_DAYS, '横轴必须是均匀的，空白天补零');
  });

  test('面板回传的条数上限与文件层面的条数上限一致', () => {
    // 先前这里取 200，而文件上限是 500：14 天里调用超过 200 次时，曲线会**静默**少算前面那
    // 300 条，而「图表正确反映调用趋势」正是这张票的验收之一。体积由文件那一层的裁剪兜住，
    // 面板没有理由再截一刀——这一条断言钉的就是那两个上限相等。
    assert.equal(PANEL_HISTORY_ENTRIES, HISTORY_MAX_ENTRIES);

    const entries = Array.from({ length: HISTORY_MAX_ENTRIES }, (unused, index) => (
      record(Date.parse('2026-09-19T00:00:00.000Z') + index * 1000)
    ));
    const state = readPanelState({ settings: {}, fallback: {}, history: { entries, error: null } });

    assert.equal(state.history.entries.length, HISTORY_MAX_ENTRIES, '文件里有多少条就投影多少条');
  });

  test('读取失败的原因如实带出，而不是显示成「没有调用」', () => {
    const state = readPanelState({ settings: {}, fallback: {}, history: { entries: [], error: 'boom' } });
    assert.equal(state.history.error, 'boom');
  });

  test('按**本地**日期分桶，而不是 UTC', () => {
    // UTC+8 的早晨会把前一晚的调用算到 UTC 的前一天去，而用户看的是「我昨天调了几次」。
    // 取一个本地时刻，断言它落在本地那一天的桶里。
    const now = new Date(2026, 8, 19, 10, 0, 0);
    const state = readPanelState({
      settings: {},
      fallback: {},
      history: { entries: [record(now.getTime())], error: null },
      nowMs: now.getTime(),
    });

    const today = state.history.daily.at(-1);
    assert.equal(today.date, '2026-09-19');
    assert.equal(today.search, 1);
    assert.equal(today.calls, 1);
  });

  test('搜索与抓取分开累计，累计的是**次数**而不是积分', () => {
    // 图表画的是调用次数（2026-09-20 决定）：次数完全来自本地事实（一条记录就是一次真实
    // 调用），不受上游计费规则影响。旧口径下这里累计的是 `credits`，而「消耗未知」的那条
    // 不进曲线；现在没有记账，也就不存在「未知」这一态。
    const now = new Date(2026, 8, 19, 10, 0, 0).getTime();
    const state = readPanelState({
      settings: {},
      fallback: {},
      history: {
        entries: [
          record(now),
          record(now, { endpoint: 'extract' }),
          record(now, { endpoint: 'extract' }),
        ],
        error: null,
      },
      nowMs: now,
    });

    const today = state.history.daily.at(-1);
    assert.equal(today.search, 1, '一次搜索算一次');
    assert.equal(today.extract, 2, '两次抓取算两次');
    assert.equal(today.calls, 3, '合计三次调用');
  });

  test('记录里残留的 credits 不参与汇总——汇总口径与积分无关', () => {
    // 旧文件里可能还带着 `credits`，而投影层读的是记录条数。若哪天有人把汇总改回读
    // `credits`，这条会立刻炸。
    const now = new Date(2026, 8, 19, 10, 0, 0).getTime();
    const state = readPanelState({
      settings: {},
      fallback: {},
      history: {
        entries: [
          record(now, { credits: 99 }),
          record(now, { endpoint: 'extract', credits: 99 }),
        ],
        error: null,
      },
      nowMs: now,
    });

    const today = state.history.daily.at(-1);
    assert.equal(today.search, 1, '一次搜索就是 1，不是 99');
    assert.equal(today.extract, 1, '一次抓取就是 1，不是 99');
  });

  test('今天之外的记录不影响今天的桶', () => {
    const now = new Date(2026, 8, 19, 10, 0, 0).getTime();
    const state = readPanelState({
      settings: {},
      fallback: {},
      history: { entries: [record(now - 24 * 3600 * 1000), record(now)], error: null },
      nowMs: now,
    });

    assert.equal(state.history.daily.at(-1).search, 1);
    assert.equal(state.history.daily.at(-2).search, 1);
  });

  test('超出窗口的记录不出现，且窗口之外的日期根本不建桶', () => {
    const now = new Date(2026, 8, 19, 10, 0, 0).getTime();
    const state = readPanelState({
      settings: {},
      fallback: {},
      history: { entries: [record(now - 60 * 24 * 3600 * 1000)], error: null },
      nowMs: now,
    });

    assert.equal(state.history.daily.length, HISTORY_CHART_DAYS);
    assert.equal(state.history.daily.reduce((total, day) => total + day.search, 0), 0);
  });
});

describe('panel-http-3：单把添加也要去重', () => {
  test('同一把明文提交两次只占一个槽位，第二次明确回报「已在池中」', async () => {
    const { deps, pool } = await panelDeps();
    const first = await runPanelCommand('keys', { action: 'add', key: SECRET, label: 'primary' }, deps);
    assert.deepEqual(first.body.summary, { received: 1, added: 1, duplicates: 0 }, '新增要如实报出来');
    const onDisk = await readFile(pool.filePath, 'utf8');

    const second = await runPanelCommand('keys', { action: 'add', key: SECRET, label: 'again' }, deps);

    // 两个槽位不是「多存了一份数据」这么轻：两行掩码一模一样，而冷却与额度耗尽按各自的
    // record id 独立记账——一次 429 只冷却其中一行，故障切换被自我抵消，同一个上游配额
    // 也被用得更快。
    assert.equal(second.status, 200, '重复不是入参非法：这一把密钥本身完全合法');
    assert.deepEqual(second.body.summary, { received: 1, added: 0, duplicates: 1 }, '必须明确说出没有新增');
    assert.equal(second.body.keys.length, 1);
    assert.equal(pool.keysInOrder().length, 1);
    assert.equal(second.body.keys[0].label, 'primary', '改备注是 rename 的事，重复提交不改动已有那一行');
    assert.equal(await readFile(pool.filePath, 'utf8'), onDisk, '重复提交连一次落盘都不该发生');
    assert.equal(JSON.stringify(second).includes(SECRET), false, '出口仍然只有脱敏形式（POOL-3）');
  });

  test('两端空白不同的同一把明文同样算重复', async () => {
    // 单把添加会先 trim（粘贴常常带上换行与空格），因此判据必须建在 trim 之后的值上。
    const { deps, pool } = await panelDeps();
    await runPanelCommand('keys', { action: 'add', key: SECRET }, deps);

    const { body } = await runPanelCommand('keys', { action: 'add', key: `  ${SECRET}\n` }, deps);

    assert.deepEqual(body.summary, { received: 1, added: 0, duplicates: 1 });
    assert.equal(pool.keysInOrder().length, 1);
  });

  test('单把与批量共用同一份判据：先单把加过的，批量里也算重复', async () => {
    const { deps, pool } = await panelDeps();
    await runPanelCommand('keys', { action: 'add', key: SECRET }, deps);

    const { body } = await runPanelCommand('keys', { action: 'addBatch', text: `${SECRET}\n${OTHER_SECRET}` }, deps);

    assert.deepEqual(body.summary, { received: 2, added: 1, duplicates: 1 });
    assert.equal(pool.keysInOrder().length, 2);
  });

  test('反方向同样成立：批量加过的，单把再提交一次也不算新增', async () => {
    // 两个方向各测一次，是因为「共用同一份判据」这句话只有在两条路径上都能被观察到时
    // 才算被守住；只测一个方向时，单把那条路径完全可以另写一份 includes 而用例照绿。
    const { deps, pool } = await panelDeps();
    await runPanelCommand('keys', { action: 'addBatch', text: SECRET }, deps);

    const { body } = await runPanelCommand('keys', { action: 'add', key: SECRET }, deps);

    assert.deepEqual(body.summary, { received: 1, added: 0, duplicates: 1 });
    assert.equal(pool.keysInOrder().length, 1);
  });
});

describe('panel-http-4：写入上限', () => {
  test('单把超长被拒绝，并说清上限、实收长度与下一步', async () => {
    // 审计里那一把 200 KB 的「密钥」是误粘一整行文件的形状：它会变成一条永远鉴权不通过的
    // 记录，此后每一次 GET /state 都要把它序列化一遍。
    const { deps, pool } = await panelDeps();
    const huge = `tvly-dev-${'a'.repeat(200_000)}`;

    await assert.rejects(
      () => runPanelCommand('keys', { action: 'add', key: huge }, deps),
      (error) => error instanceof PanelError
        && error.status === 400
        && error.code === PANEL_ERROR_CODES.BAD_REQUEST
        && error.message.includes(String(PANEL_KEY_MAX_LENGTH))
        && error.message.includes(String(huge.length))
        && /nothing was written/u.test(error.message),
      '拒绝消息里要有上限、实收长度与下一步，否则用户不知道该删掉什么',
    );
    assert.deepEqual(pool.keysInOrder(), [], '拒绝就是拒绝：不截断，也不留下记录');
    await assert.rejects(
      () => readFile(pool.filePath, 'utf8'),
      (error) => error.code === 'ENOENT',
      '被拒绝的添加不该开出一个池文件',
    );
  });

  test('批量里的超长行指名第几行，并拒绝整次粘贴', async () => {
    const { deps, pool } = await panelDeps();
    const text = `${SECRET}\n${'b'.repeat(PANEL_KEY_MAX_LENGTH + 1)}\n${OTHER_SECRET}`;

    await assert.rejects(
      () => runPanelCommand('keys', { action: 'addBatch', text }, deps),
      (error) => error.status === 400
        && /line 2/u.test(error.message)
        && error.message.includes(String(PANEL_KEY_MAX_LENGTH + 1)),
    );
    assert.deepEqual(pool.keysInOrder(), [], '一次粘贴是一个整体：不能把合法的两把偷偷写进去');
  });

  test('一次粘贴超过条数上限时整次拒绝，并说清上限与实收', async () => {
    const { deps, pool } = await panelDeps();
    const text = Array.from(
      { length: PANEL_KEYS_MAX_PER_REQUEST + 1 },
      (unused, index) => `tvly-dev-limit-${index}`,
    ).join('\n');

    await assert.rejects(
      () => runPanelCommand('keys', { action: 'addBatch', text }, deps),
      (error) => error.status === 400
        && error.code === PANEL_ERROR_CODES.BAD_REQUEST
        && error.message.includes(String(PANEL_KEYS_MAX_PER_REQUEST + 1))
        && error.message.includes(String(PANEL_KEYS_MAX_PER_REQUEST)),
    );
    assert.deepEqual(pool.keysInOrder(), [], '5000 行那类误粘必须在写盘之前被挡住');
  });

  test('池内总数上限同时生效：刚好装满允许，再添加被拒，删掉一把之后又可以加', async () => {
    const { deps, pool } = await panelDeps();
    const text = Array.from({ length: PANEL_KEYS_MAX }, (unused, index) => `tvly-dev-full-${index}`).join('\n');
    const { body } = await runPanelCommand('keys', { action: 'addBatch', text }, deps);
    assert.deepEqual(
      body.summary,
      { received: PANEL_KEYS_MAX, added: PANEL_KEYS_MAX, duplicates: 0 },
      '上限本身是允许的：正好装满不算超',
    );

    await assert.rejects(
      () => runPanelCommand('keys', { action: 'add', key: SECRET }, deps),
      (error) => error.status === 400
        && error.message.includes(String(PANEL_KEYS_MAX))
        && /remove some keys/u.test(error.message),
      '满了之后的添加要给出可操作的下一步，而不是一句「失败」',
    );

    await runPanelCommand('keys', { action: 'removeBatch', ids: [body.keys[0].id] }, deps);
    const after = await runPanelCommand('keys', { action: 'add', key: SECRET }, deps);

    assert.deepEqual(after.body.summary, { received: 1, added: 1, duplicates: 0 }, '上限是为了回到可用规模，不是锁死池子');
  });
});

describe('panel-http-4：批量删除出口', () => {
  const THIRD_SECRET = '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';

  test('一次请求删多把，内存与磁盘都如实', async () => {
    const { deps, pool } = await panelDeps();
    await runPanelCommand('keys', { action: 'addBatch', text: `${SECRET}\n${OTHER_SECRET}\n${THIRD_SECRET}` }, deps);
    const ids = pool.keysInOrder().map((record) => record.id);

    const { status, body } = await runPanelCommand('keys', { action: 'removeBatch', ids: [ids[0], ids[2]] }, deps);

    assert.equal(status, 200);
    assert.deepEqual(body.summary, { received: 2, removed: 2 });
    assert.deepEqual(body.keys.map((entry) => entry.id), [ids[1]], '没被点到的那些原样留在池里');
    const onDisk = JSON.parse(await readFile(pool.filePath, 'utf8'));
    assert.deepEqual(onDisk.keys.map((entry) => entry.id), [ids[1]]);
    assert.deepEqual(onDisk.order, [ids[1]], '顺序表也要跟着收缩');
  });

  test('未知 id 是 404，而且一把都不删：先全部确认存在再动手', async () => {
    // `PoolStore.removeKey` 是逐把落盘的，边删边发现某个 id 不存在会留下一个删了一半的
    // 池子——而用户点的是一个按钮，期望的是一个结果。
    const { deps, pool } = await panelDeps();
    await runPanelCommand('keys', { action: 'addBatch', text: `${SECRET}\n${OTHER_SECRET}` }, deps);
    const ids = pool.keysInOrder().map((record) => record.id);

    await assert.rejects(
      () => runPanelCommand('keys', { action: 'removeBatch', ids: [ids[0], 'no-such-id'] }, deps),
      (error) => error.status === 404 && error.code === PANEL_ERROR_CODES.NO_SUCH_KEY,
    );
    assert.deepEqual(pool.keysInOrder().map((entry) => entry.id), ids);
  });

  test('重复给到的 id 折叠：同一次请求里出现两次不该变成一次 404', async () => {
    const { deps, pool } = await panelDeps();
    await runPanelCommand('keys', { action: 'add', key: SECRET }, deps);
    const [record] = pool.keysInOrder();

    const { body } = await runPanelCommand('keys', { action: 'removeBatch', ids: [record.id, record.id] }, deps);

    assert.deepEqual(body.summary, { received: 1, removed: 1 });
    assert.deepEqual(body.keys, []);
  });

  test('空列表是合法的一次「什么都不删」，不是入参非法', async () => {
    const { deps, pool } = await panelDeps();
    await runPanelCommand('keys', { action: 'add', key: SECRET }, deps);

    const { status, body } = await runPanelCommand('keys', { action: 'removeBatch', ids: [] }, deps);

    assert.equal(status, 200);
    assert.deepEqual(body.summary, { received: 0, removed: 0 });
    assert.equal(pool.keysInOrder().length, 1);
  });

  test('ids 形状不对是 400，且不会碰写入路径', async () => {
    const { deps, pool } = await panelDeps();
    await runPanelCommand('keys', { action: 'add', key: SECRET }, deps);
    const onDisk = await readFile(pool.filePath, 'utf8');

    for (const ids of [undefined, 'no', [7], [null]]) {
      await assert.rejects(
        () => runPanelCommand('keys', { action: 'removeBatch', ids }, deps),
        (error) => error.status === 400 && error.code === PANEL_ERROR_CODES.BAD_REQUEST,
        `${JSON.stringify(ids)} 必须被拒绝`,
      );
    }
    assert.equal(await readFile(pool.filePath, 'utf8'), onDisk);
  });
});

describe('panel-http-6：写失败的错误文案按白名单构造', () => {
  /**
   * 一个**真的会写失败**的密钥池：`keys.json` 的位置是一个目录，于是「临时文件 + rename
   * 覆盖目标」的最后一步必然以 EISDIR 失败，失败原文里同时带着运行账户的绝对状态目录、
   * 进程 pid 与内部临时文件名。
   *
   * 用真实文件系统而不是注入的 fs 替身，是因为要守住的东西正是**真实错误对象上的字段**
   * （`code` / `syscall` / 那句带路径的 message）——替身会把它们换成我以为的形状。
   */
  async function unwritablePool() {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tavily-panel-eisdir-'));
    await mkdir(join(dir, 'keys.json'));
    return { dir, pool: await new PoolStore({ dir, fileName: 'keys.json' }).load() };
  }

  test('只给 errno、文件名与下一步，不给路径、pid 与临时文件名', async () => {
    const { dir, pool } = await unwritablePool();
    const { deps } = await panelDeps({ pool });

    let error;
    try {
      await runPanelCommand('keys', { action: 'add', key: SECRET }, deps);
    } catch (thrown) {
      error = thrown;
    }

    assert.ok(error instanceof PanelError, '落盘失败必须以 PanelError 上报');
    assert.equal(error.status, 500);
    assert.equal(error.code, PANEL_ERROR_CODES.KEY_EDIT_FAILED);
    // 保住的排障线索：errno、哪一步、哪个文件、下一步做什么。
    assert.match(error.message, /EISDIR/u, 'errno 是唯一能拿去搜索的线索');
    assert.match(error.message, /rename/u, 'rename 失败与 open 失败要分得开');
    assert.match(error.message, /keys\.json/u, '要指名是哪个文件写不进去');
    assert.match(error.message, /writable|free space/u, '还要给出下一步');
    // 剥掉的东西：它们是 fs 原文里的环境信息，会被卡片渲染到界面上。
    assert.equal(error.message.includes(dir), false, '绝对状态目录不得出现');
    assert.equal(error.message.includes(homedir()), false);
    assert.equal(error.message.includes(String(process.pid)), false);
    assert.equal(error.message.includes('.tmp'), false, '内部临时文件名不得出现');
    assert.equal(error.message.includes(SECRET), false);
    // 原文并没有丢：它作为 cause 留在进程内，供日志与调试读取。
    assert.equal(error.cause.code, 'EISDIR');
    assert.equal(error.cause.message.includes(dir), true, '原始错误仍在 cause 上');
  });

  test('没有 errno 的失败同样不透出原文——白名单不是「只认 fs 错误」', async () => {
    // 这里是本组唯一用替身的地方：真实文件系统造不出「错误消息里有路径、却没有 `code`」这种
    // 形状，而那正是白名单要挡住的一般情形（将来某个中间层抛出的 TypeError 就长这样）。
    // 替身只参与错误出口，不参与任何明文或落盘路径——本文件开头那条「全程用真实 PoolStore」
    // 的纪律针对的正是后两者。
    const leaked = '/Users/someone/.dsh/dsh-tavily-pool/keys.json.4242.deadbeef.tmp';
    const leaky = {
      filePath: '/Users/someone/.dsh/dsh-tavily-pool/keys.json',
      keysInOrder: () => [],
      maskedList: () => [],
      addKey: async () => {
        throw new TypeError(`cannot write ${leaked}`);
      },
    };
    const { deps } = await panelDeps({ pool: leaky });

    let error;
    try {
      await runPanelCommand('keys', { action: 'add', key: SECRET }, deps);
    } catch (thrown) {
      error = thrown;
    }

    assert.ok(error instanceof PanelError);
    assert.equal(error.code, PANEL_ERROR_CODES.KEY_EDIT_FAILED);
    assert.equal(error.message.includes(leaked), false, '没有 errno 时更不能把原文端出去');
    assert.equal(error.message.includes('/Users/someone'), false);
    assert.equal(error.message.includes('.tmp'), false);
    assert.match(error.message, /keys\.json/u, '文件名仍然要说出来');
    assert.match(error.message, /TypeError/u, '错误的种类仍然要说出来');
  });
});

describe('failure-paths-3：面板的单把刷新是永久失效的复位入口', () => {
  test('「测试连通性」读通一次 /usage 之后，该密钥重新进入候选', async () => {
    // 永久失效在调度器里是硬排除（`SCHED-4`），因此它不可能靠一次搜索成功来撤销——被
    // 排除的密钥没有机会成功。唯一可达的复位信号是官方读通了这把密钥：面板上单把的
    // 「刷新余额」与「测试连通性」两条命令都走 `UsageRefresher.refresh`，这里走后者。
    const pool = await temporaryPool();
    const record = await pool.addKey({ key: SECRET, label: 'primary' });
    const health = new KeyHealth({ pool });
    await health.recordFailure(record.id, { failure: { status: 401, detail: 'invalid api key' } });
    assert.equal(health.snapshotOf(record.id).permanentlyInvalid, true, '先把它移出池子');

    const refresher = new UsageRefresher({
      pool,
      health,
      quota: new UsageQuota(),
      fetchImpl: async () => new Response(
        JSON.stringify({ key: { usage: 1, limit: 100 }, account: { plan_limit: 1000 } }),
        { status: 200 },
      ),
    });
    const { deps } = await panelDeps({
      pool,
      refresh: (id, key, options) => refresher.refresh(id, key, options),
    });

    const response = await runPanelCommand('test', { id: record.id }, deps);

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(
      health.snapshotOf(record.id).permanentlyInvalid,
      false,
      '用户点得到的那条复位入口必须真的复位',
    );
  });
});
