/**
 * 时间预算的自洽性（`FETCH-4`、`SCHED-9` 的算术部分）。
 *
 * 这些是**常数之间**的关系，不是行为，因此没有别的用例覆盖得到它们——而它们一旦破了，症状
 * 是「用户等到的是一条超时，而不是上游的真实错误」，那是最难从日志里认出来的一类问题。
 *
 * 两个宿主上限写在这里而不是从宿主包读：
 *
 * - `web_search` 的 `searchTimeoutMs` —— `dsh-base` 的 patch 把它抬到 **60000**；
 * - `web_fetch` 的 `fetchTimeoutMs` —— 保持 `dsh-tool-web` 的默认
 *   `DEFAULT_WEB_TOOL_TIMEOUT_MS` = **30000**（`dsh-tool-web/lib/index.js:838`、`:850`）。
 *
 * `dsh-base` 与 `dsh-tool-web` 都不是本包的依赖（本包只依赖 seam 与两个提供方包），因此读不到
 * 它们；这也正是这条守卫的用意——宿主改了默认值，这里是**唯一**会提醒的地方。
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  FETCH_TOTAL_BUDGET_MS,
  MIN_ATTEMPT_TIMEOUT_MS,
  SEARCH_TOTAL_BUDGET_MS,
  TAVILY_TIMEOUT_MS,
  WAIT_BUDGET_MS,
  WAIT_BUDGET_SHARE,
} from '../lib/constants.js';

/** `dsh-tool-web` 的 `DEFAULT_WEB_TOOL_TIMEOUT_MS`：两个工具的默认预算。 */
const HOST_DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/** `dsh-base` 为 `searchTimeoutMs` 设的值。 */
const HOST_SEARCH_TIMEOUT_MS = 60_000;

describe('时间预算自洽', () => {
  test('抓取的总预算严格低于宿主给 web_fetch 的 30 秒', () => {
    // 抓取若沿用搜索的 60 秒，等待上限会折算成 30 秒——**一项就吃掉宿主的全部预算**，随后的
    // 尝试还没发出去就被掐断，用户看到的是「tool call timed out」而不是上游的真实错误。
    assert.ok(
      FETCH_TOTAL_BUDGET_MS < HOST_DEFAULT_TOOL_TIMEOUT_MS,
      `抓取总预算 ${String(FETCH_TOTAL_BUDGET_MS)} 必须小于宿主的 ${String(HOST_DEFAULT_TOOL_TIMEOUT_MS)}`,
    );
  });

  test('搜索的总预算就是宿主给 web_search 的那个值', () => {
    assert.equal(SEARCH_TOTAL_BUDGET_MS, HOST_SEARCH_TIMEOUT_MS);
  });

  test('单次尝试的超时不超过抓取的全部预算', () => {
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
});
