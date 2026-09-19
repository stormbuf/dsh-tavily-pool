/**
 * 故障切换：一次请求内跨密钥的尝试编排。
 *
 * 与宿主零耦合（`COMPAT-1`）。它把三个协作者串起来——调度器选密钥、内核发请求、
 * 健康状态记录结果——并决定什么时候继续换密钥、什么时候停下来把错误交给调用方。
 *
 * 三条边界在这里被钉死：
 *
 * - **请求本身有误不换密钥**（`REST-8`）：换一把密钥不会让一个不合法的请求变得合法。
 * - **取消不是失败**：调用方中止时立刻向上传递，不记在密钥头上、也不再试。
 * - **失败即换**（`SCHED-4`）：冷却、额度耗尽、永久失效都换成池内另一把；全部试遍
 *   之后透穿**最后一个真实的上游响应**（`REST-10`），而不是一个自造的汇总错误。
 *
 * @module dsh-tavily-pool/attempts
 */

import { FAILURE_ACTIONS, QUOTA_ADVICE } from './health.js';
import { SEARCH_WAIT_BUDGET_MS, WAIT_BUDGET_SHARE } from './constants.js';
import { TavilyError } from './tavily.js';

/**
 * 单次请求内最多尝试的密钥数。
 *
 * 池子可能有几十把密钥，但一次 `web_search` 只有 60 秒预算，而且每次尝试都是一次
 * 真实的网络往返。三次足以越过一把坏密钥，又不至于让一次搜索在池子里转一整圈。
 */
export const MAX_ATTEMPTS = 3;

/**
 * 依次尝试池内密钥，直到成功、或确定再换也没用。
 *
 * @param options - 本次编排。
 * @param options.scheduler - 调度器，提供 `select()`。
 * @param options.health - 健康状态，提供 `recordSuccess()` / `recordFailure()`。
 * @param options.invoke - 用给定密钥执行一次真实调用，返回 `{ result, credits }`；
 *   抛出的 {@link TavilyError} 会被分类。
 * @param options.probeQuota - 池内只剩额度耗尽的密钥时调用一次（`SCHED-10`）：返回
 *   true 表示「探测后确有密钥恢复」，于是重新尝试调度；返回 false 表示仍没有候选，
 *   按没有候选处理。省略表示不做自动探测。
 * @param options.signal - 调用方取消信号。
 * @param options.deadlineMs - 本次搜索的截止时刻（`SCHED-9` 的总预算）。
 * @param options.waitDeadlineMs - 允许等待到的最晚时刻；省略时按截止时刻与
 *   {@link WAIT_BUDGET_SHARE} 折算。
 * @param options.maxAttempts - 最多尝试几把密钥。
 * @param options.now - 当前时刻，测试时可注入。
 * @returns `{ result, keyId, attempts, failedKeyIds }`。
 * @throws {TavilyError} 成功之前无法再试时抛出：最后一次的真实失败、请求本身有误的
 *   错误、池内没有候选、或取消。
 */
export async function runWithFailover({
  scheduler,
  health,
  invoke,
  probeQuota,
  signal,
  deadlineMs,
  waitDeadlineMs,
  maxAttempts = MAX_ATTEMPTS,
  now = Date.now,
}) {
  const attempts = [];
  const failedKeyIds = [];
  const tried = new Set();
  let lastError;
  let attemptsMade = 0;
  let probed = false;

  while (attemptsMade < maxAttempts) {
    // 每次尝试之前重算等待上限。只算一次会让后两次沿用初始预算：先前那次尝试若已经
    // 吃掉大半时间，后面的等待就不再满足「留出至少一半剩余预算给真正的请求」这个约束，
    // 而它存在的理由正是「等到了也来不及发出去的等待没有意义」。
    const waitUntil = waitDeadlineMs ?? waitAllowance(deadlineMs, now());
    const selection = await scheduler.select({ signal, exclude: tried, waitDeadlineMs: waitUntil });

    if (selection.key === undefined) {
      if (selection.blocked === 'aborted') {
        throw new TavilyError('Tavily search aborted by the caller', { code: 'TAVILY_ABORTED' });
      }
      // `SCHED-5` 的例外：池内只剩额度耗尽的密钥时通常不该等待，但其中若有密钥正处在
      // `SCHED-10` 的自动探测窗口内，**先完成那次探测再判断是否放弃**。否则一把在月初
      // 已经恢复的密钥要等用户手动点一次刷新才可能被用上，而自动恢复本来就是它存在的
      // 理由。
      //
      // 探测**不占用尝试次数**：它不是一次用密钥发起的请求，失败也不说明任何一把密钥
      // 有问题。一次搜索里最多探测一次——探测自身有 6 小时栅格与配额预占两道约束，这里
      // 再循环只会让一次注定失败的搜索多绕几圈。
      if (selection.blocked === 'all-unusable' && probeQuota !== undefined && !probed) {
        probed = true;
        if (await probeQuota()) continue;
      }
      // 已经试过的那些真实失败比「没有候选了」更能说明发生了什么，因此优先透穿
      // 它们（`REST-10`）——它带着上游的 request_id 与状态码。**这条路径不回落**：
      // 手上有上游的真实答复时，换一个来源重试会把它丢掉。
      if (lastError !== undefined) throw withAdvice(lastError, exhaustedAdvice(tried, health));
      // 没有真实失败可透穿，于是给出一个本地结论。**`blocked` 挂到错误上**：调用方要
      // 据它区分两种截然不同的情形——「池内没有可能在本次请求内恢复的候选」按
      // `SCHED-5` 回落，而「全都还在冷却、只是等到期不划算」按 `SCHED-9`/`REST-10`
      // 如实上报。用消息文本去区分这两者是把判据放错了地方。
      const blocked = new TavilyError(messageFor(selection), { code: 'TAVILY_NO_USABLE_KEY' });
      blocked.blocked = selection.blocked;
      throw blocked;
    }

    attemptsMade += 1;
    const { id, key } = selection.key;
    tried.add(id);
    const startedAt = now();
    let outcome;
    try {
      outcome = await invoke({ id, key });
    } catch (error) {
      const durationMs = now() - startedAt;
      if (error?.code === 'TAVILY_ABORTED') throw error;
      // 只有我们自己的失败能被分类；别的错误（编码 bug、宿主抛出的东西）与密钥健康
      // 无关，原样向上。
      if (!(error instanceof TavilyError)) throw error;

      const { classification, persisted } = health.recordFailure(id, {
        failure: failureFactsOf(error),
        message: error.message,
        durationMs,
      });
      attempts.push({ keyId: id, status: error.status, code: error.code, action: classification.action });
      failedKeyIds.push(id);
      lastError = error;

      // 请求本身不合法，或者是一种换密钥无法修复的失败：再试只是重复同一个错误。
      if (classification.action === FAILURE_ACTIONS.FATAL) throw error;

      // 等状态落盘再进入下一次尝试。内存里的状态**已经**生效（冷却、额度耗尽都立刻
      // 参与下一次调度），这里等的只是持久化本身：一次搜索返回之后，磁盘上的状态就
      // 应当与刚才发生的事一致——否则进程在紧接着的瞬间退出，用户看到的是一把「没
      // 有失败过」的密钥。
      await persisted;
      continue;
    }

    const durationMs = now() - startedAt;
    const persisted = health.recordSuccess(id, { credits: outcome?.credits, durationMs });
    attempts.push({ keyId: id, status: 200, action: 'success' });
    // 同失败路径：成功也要落盘后才算这次搜索结束，否则紧接着的一次调度会读到一份
    // 过期的状态（例如仍以为这把密钥在冷却中）。
    await persisted;
    return { result: outcome?.result, keyId: id, attempts, failedKeyIds };
  }

  // 循环只在每次失败后 `continue` 时才会走满，因此这里必然有一个真实失败可透穿。
  throw withAdvice(lastError, exhaustedAdvice(tried, health));
}

/**
 * 池内密钥全部试遍之后，按它们的状态补一句「接下来该怎么办」。
 *
 * 上游的错误文本说的是**发生了什么**（「Key limit or Plan Limit exceeded」），而用户
 * 需要的是**该做什么**。`REST-7` 明确要求额度耗尽时附上官方自愈路径，且那条路径是
 * 「到 Tavily dashboard 提高限额」，**不是**「换一把密钥」——官方对 432 与 433 的指引
 * 都是前者。
 *
 * 只有**永久失效**的文案写在这里，额度耗尽的取自 {@link QUOTA_ADVICE}：后者属于
 * 「这个状态是什么」的知识，归 `lib/health.js`；把它抄一份到这里，同一句指引就会
 * 有两处真相，而用户看到哪一处取决于失败走了哪条路径。
 *
 * 只在全部候选都耗尽时才补：还有别的密钥可试时，故障切换本身就是答案，多说一句反而
 * 让人以为需要动手。
 *
 * @param tried - 本次请求已经试过的密钥 id。
 * @param health - 健康状态，用于读取每把密钥当前处于哪一类失败。
 * @returns 附言；没有可说的话时返回 `undefined`。
 */
function exhaustedAdvice(tried, health) {
  let exhausted = 0;
  let invalid = 0;
  for (const id of tried) {
    const state = health.snapshotOf(id);
    if (state.quotaExhausted) exhausted += 1;
    else if (state.permanentlyInvalid) invalid += 1;
  }
  if (exhausted === 0 && invalid === 0) return undefined;

  const parts = [];
  if (exhausted > 0) {
    parts.push(`${String(exhausted)} key(s) in the pool have no credits left this cycle. ${QUOTA_ADVICE}`);
  }
  if (invalid > 0) {
    parts.push(
      `${String(invalid)} key(s) were rejected by Tavily as invalid or revoked and need to be replaced in `
      + 'Settings → Plugins → dsh-tavily-pool.',
    );
  }
  return parts.join(' ');
}

/**
 * 把附言并进错误消息，**不**改动原错误的 `code` 与 `status`。
 *
 * 上游的失败仍要如实上报（`REST-10`）：消费方按 `code` 分流，把 432 改写成我们自造的
 * 码会让它对不上 Tavily 的错误表。因此这里只加一句话。
 *
 * @param error - 要透穿的原始失败。
 * @param advice - 附言；缺席时原样返回。
 * @returns 可抛出的错误。
 */
function withAdvice(error, advice) {
  if (advice === undefined || error === undefined) return error;
  if (error.message.includes(advice)) return error;
  const enriched = new TavilyError(`${error.message} ${advice}`, {
    code: error.code,
    status: error.status,
    detail: error.detail,
    retryAfter: error.retryAfter,
    requestId: error.requestId,
    cause: error.cause,
  });
  return enriched;
}

/**
 * 从内核错误里取出分类需要的事实。
 *
 * `retryAfter` 原样携带，解析与 clamp 属于健康状态；这里只搬运「上游给了什么」。
 *
 * @param error - 内核抛出的 {@link TavilyError}。
 * @returns `{ status, detail, code, retryAfter }`。
 */
function failureFactsOf(error) {
  return {
    status: error.status,
    detail: error.detail,
    code: error.code,
    retryAfter: error.retryAfter,
  };
}

/**
 * 算出本次搜索允许等待到的最晚时刻（`SCHED-9`）。
 *
 * 取两者的较小者：固定的等待预算，以及剩余总预算的一半。前者是 spec §5.3 给的
 * 「建议 ≤30s」；后者在**先前的尝试已经吃掉大半预算**时才生效——那时一个 30 秒的
 * 等待会让剩余预算归零，等到了也来不及把请求发出去，等与不等结果一样，却白让调用
 * 方多等半分钟。留出至少一半剩余预算给真正的请求，等待才是有意义的。
 *
 * @param deadlineMs - 本次搜索的截止时刻；缺席表示调用方未给总预算，此时只受固定
 *   等待预算约束。
 * @param nowMs - 当前时刻。
 * @returns 允许等待到的最晚时刻（epoch 毫秒）。
 */
export function waitAllowance(deadlineMs, nowMs) {
  const cap = nowMs + SEARCH_WAIT_BUDGET_MS;
  if (typeof deadlineMs !== 'number' || !Number.isFinite(deadlineMs)) return cap;
  return Math.min(cap, nowMs + Math.max(0, deadlineMs - nowMs) * WAIT_BUDGET_SHARE);
}

/** 按被阻塞的原因给出可据以行动的话。 */
function messageFor(selection) {
  if (selection.blocked === 'no-keys') {
    return 'no Tavily key is configured; add one in Settings → Plugins → dsh-tavily-pool';
  }
  if (selection.blocked === 'cooling') {
    return 'every Tavily key in the pool is cooling down, and waiting for the earliest one would '
      + 'exceed this request\'s budget';
  }
  if (selection.blocked === 'exhausted-attempts') {
    return 'every Tavily key this request was allowed to try has been tried and failed';
  }
  // `all-unusable`：全部额度耗尽或永久失效。等待不会有结果——恢复要等下月 1 日或
  // 用户提额，永久失效则永不恢复。这条消息在**没有真实上游失败可透穿**时才出现
  // （调度器直接判定没有候选），因此它就是用户看到的全部信息，必须自带行动指引。
  return 'every Tavily key in the pool is disabled, out of credits, or permanently invalid. Credits '
    + 'reset on the 1st of each month regardless of the billing date; add a key, re-enable one, or '
    + 'raise the limit in the Tavily dashboard (https://app.tavily.com/account/plan).';
}
