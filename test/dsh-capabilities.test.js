/**
 * 宿主能力探测（`COMPAT-2`、`COMPAT-3`）。
 *
 * 被测的行为是宿主形状改变时会发生什么：插件必须在加载期说出没的是**哪一项**能力，
 * 并且必须尽可能继续工作。
 *
 * 替身 context 刻意做成与真实的一致——服务经 `get(name)` 读取，读取未被 inject 的
 * 服务名会**抛出**——因为这一差异恰恰是探测最容易搞错的地方。
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import {
  describeMissingCapabilities,
  probeCapabilities,
  REQUIRED_CAPABILITIES,
} from '../lib/dsh/capabilities.js';

/**
 * 行为与 Cordis 一致的 context：`get(name)` 是不抛错的读取，而直接访问属性时，
 * 凡是不在 `inject` 里的名字都会抛出。
 *
 * 返回的对象暴露 `services`，好让测试删掉其中一项——从 `ctx.get(...)` 的返回值上删
 * 只会改动那次读取返回的对象。
 *
 * @param services - 提供的服务。
 * @returns 假 context，附有其服务表。
 */
function fakeContext(services) {
  const ctx = new Proxy(
    { get: (name) => services[name] },
    {
      get(target, prop) {
        if (prop === 'get') return target.get;
        if (prop === 'services') return services;
        if (prop in services) return services[prop];
        throw new Error(`cannot get property "${String(prop)}" without inject`);
      },
    },
  );
  return ctx;
}

/** 一个满足全部被探测能力的宿主。 */
function completeHost() {
  return {
    ctx: fakeContext({
      web: { registerSearchProvider() {}, registerFetchProvider() {} },
      settings: { update() {} },
      clientModules: {},
      dshHomePath: (...segments) => join('/home/.dsh', ...segments),
      connection: { fetch: { register() {} } },
    }),
  };
}

describe('COMPAT-2：探测会点名缺了什么', () => {
  test('完整的宿主不报告任何缺失', () => {
    const report = probeCapabilities(completeHost());
    assert.equal(report.ok, true);
    assert.deepEqual(report.missingRequired, []);
    assert.deepEqual(report.missingOptional, []);
    assert.equal(describeMissingCapabilities(report), '');
  });

  test('缺失的服务会被上报，而不是抛出', () => {
    // 直接读 `ctx.settings` 会抛 "without inject"；因此探测必须走反射式读取，
    // 否则它上报的是一次崩溃，而不是一项缺失的能力。
    const host = completeHost();
    delete host.ctx.services.settings;
    const report = probeCapabilities(host);
    // 0.1.7 起 settings 是**可选**能力：设置就是本插件那条 loader 行的配置，读它不需要任何
    // 服务，只有面板的写入要用 `update`。因此它缺席不该让探测失败，但仍必须被点名。
    assert.equal(report.ok, true, 'settings 缺席只该让面板的写入退化');
    assert.deepEqual(report.missingOptional, ['settings.update']);

    // 必需能力缺席仍然是硬的：一项都不能少。
    const brokenHost = completeHost();
    delete brokenHost.ctx.services.clientModules;
    const broken = probeCapabilities(brokenHost);
    assert.equal(broken.ok, false);
    assert.deepEqual(broken.missingRequired, ['clientModules']);
  });

  test('seam 变形后会被按名字报告为缺失', () => {
    const host = completeHost();
    delete host.ctx.services.web.registerSearchProvider;
    const report = probeCapabilities(host);
    assert.equal(report.ok, false);
    assert.deepEqual(report.missingRequired, ['web.registerSearchProvider']);
    const message = describeMissingCapabilities(report);
    assert.match(message, /web\.registerSearchProvider/);
    assert.match(message, /docs\/dsh-upgrade\.md/);
  });

  test('每一项必需能力都确实必需', () => {
    for (const id of REQUIRED_CAPABILITIES) {
      const host = completeHost();
      if (id === 'ctx.reflectiveRead') delete host.ctx.get;
      if (id === 'web.registerSearchProvider') delete host.ctx.services.web.registerSearchProvider;
      if (id === 'clientModules') delete host.ctx.services.clientModules;
      const report = probeCapabilities(host);
      assert.equal(report.ok, false, `移除 ${id} 应当使探测失败`);
      assert.ok(report.missingRequired.includes(id), `${id} 应当被报告为缺失`);
    }
  });

  test('缺失的可选能力只会退化，不会让探测失败', () => {
    const host = completeHost();
    delete host.ctx.services.dshHomePath;
    delete host.ctx.services.connection;
    const report = probeCapabilities(host);
    assert.equal(report.ok, true, '可选能力不得阻碍加载');
    assert.deepEqual(report.missingOptional, ['dshHomePath', 'connection.fetch.register']);
    assert.match(describeMissingCapabilities(report), /\[optional\] dshHomePath/);
  });

  test('探测能容忍完全没有服务的 context', () => {
    const report = probeCapabilities({ ctx: fakeContext({}) });
    assert.equal(report.ok, false);
    // 这里反射式读取是存在的，因此它是唯一一项**不**被报告为缺失的必需能力。
    assert.deepEqual(
      report.missingRequired,
      REQUIRED_CAPABILITIES.filter((id) => id !== 'ctx.reflectiveRead'),
    );
  });

  test('没有反射式读取的宿主会被上报，而不会被误判为健康', () => {
    // 没有 `ctx.get` 就什么都读不到，因此探测绝不能声称其余能力都在，然后让注册在
    // 一份「能力齐备」的报告之后立刻失败。
    const report = probeCapabilities({ ctx: {} });
    assert.equal(report.ok, false);
    assert.ok(report.missingRequired.includes('ctx.reflectiveRead'));
  });
});
