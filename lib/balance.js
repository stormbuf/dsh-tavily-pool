/**
 * 余额的三态判定（`SCHED-2`、`SCHED-8`、`PANEL-6`）。
 *
 * **这是唯一一份判定**。调度排序、额度恢复判定、本地前推与面板显示此前各写了一遍同样的
 * 「`key.limit === null` 就是无限」，于是同一个误读有四个副本——`20` 修掉的正是它：
 * **免费账号的 `key.limit` 也返回 `null`**，只看这一个字段会把 1000 积分/月的账号读成
 * 「无限额度」（实测见 ticket `20` 的 Comments）。
 *
 * 判定顺序（密钥维度优先，缺失时退回**该密钥所属账号**的套餐上限）：
 *
 * 1. `key.limit` 是有限数 → 用它。官方给单把密钥设的上限，最贴近「这把密钥能用多少」。
 * 2. 否则 `account.plan_limit` 是有限数 → 用它。`account` 段是**这次响应里那把密钥所属
 *    账号**的信息，一对一地跟着这把密钥回来，因此它仍然是「这把密钥的额度上限」。
 * 3. 两者都**明确为 `null`** → 无限额度。
 * 4. 其余（字段缺失、类型不认识）→ 未知。
 *
 * **不做任何跨密钥的推理**：本模块只吃一份 `/usage` 缓存，看不到池里别的密钥，也不去猜
 * 「哪几把属于同一个账号」——官方不提供归属信息，而猜错会让两把各自独立的密钥被当成共享
 * 一份额度。因此每把密钥各算各的，`account.plan_limit` 只作为**这一把**的上限来源。
 *
 * @module dsh-tavily-pool/balance
 */

/** 余额的三种状态。 */
export const BALANCE_KINDS = Object.freeze({
  /** 上限与用量都读得到。 */
  known: 'known',
  /** 密钥级与账号级都没有上限（官方以 `null` 表示）。 */
  unlimited: 'unlimited',
  /** 从未刷新过，或响应里读不出可用的上限/用量。 */
  unknown: 'unknown',
});

/** 一个有限数（`NaN`、`Infinity`、字符串都不算）。 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 这把密钥的额度上限。
 *
 * @param usageEntry - 缓存下来的 `/usage` 响应，形状为 `{ key, account, ... }`。
 * @returns 有限数表示上限；`null` 表示两侧都明确无上限；`undefined` 表示读不出来。
 */
export function quotaLimitOf(usageEntry) {
  const key = usageEntry?.key;
  if (key === null || typeof key !== 'object') return undefined;
  if (isFiniteNumber(key.limit)) return key.limit;
  // `key.limit` 既不是有限数也不是 `null`（缺失、字符串、`NaN`…）时不再往下退：
  // 形状已经不认识了，拿账号层的数字去补只会掩盖这个问题。
  if (key.limit !== null) return undefined;

  const planLimit = usageEntry?.account?.plan_limit;
  if (isFiniteNumber(planLimit)) return planLimit;
  if (planLimit === null) return null;
  return undefined;
}

/**
 * 读出一把密钥此刻的余额。
 *
 * @param usageEntry - 缓存下来的 `/usage` 响应。
 * @returns `{ kind, limit?, used?, remaining? }`：
 *   `kind` 为 `known` 时三个数值都在（`remaining` 已按 0 截断，容忍本地前推让 `usage`
 *   略微越过 `limit`）；`unlimited` 与 `unknown` 时不带数值——没有分母可减，也不该编造。
 */
export function readBalance(usageEntry) {
  const limit = quotaLimitOf(usageEntry);
  if (limit === null) return { kind: BALANCE_KINDS.unlimited };
  if (limit === undefined) return { kind: BALANCE_KINDS.unknown };

  const used = usageEntry?.key?.usage;
  // 上限读到了、用量读不到：减法做不出来，而「不知道还剩多少」与「还剩零」在决定要不要
  // 用这把密钥时含义完全不同——按未知处理，让调用方保守对待（`SCHED-2` 的未知垫底）。
  if (!isFiniteNumber(used)) return { kind: BALANCE_KINDS.unknown };

  return { kind: BALANCE_KINDS.known, limit, used, remaining: Math.max(0, limit - used) };
}
