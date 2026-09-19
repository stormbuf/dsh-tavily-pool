/**
 * 宿主服务的读取方式。
 *
 * Cordis 提供两种从 context 读取服务的途径，而二者的差异恰是能力探测最在意的：
 *
 * - `ctx.someService` 是**消费者**写法。它要求该服务出现在读取方 fiber 的
 *   `inject` 列表里（或由祖先 fiber 提供），否则抛
 *   `cannot get property "x" without inject`。
 * - `ctx.get('someService')` 是**反射**写法。服务不存在时返回 `undefined`，
 *   而这正是探测需要的：探测的全部意义就是搞清楚缺了什么。
 *
 * 在探测里用消费者写法是实打实的缺陷，不是风格偏好：抛出发生在探测内部，
 * 于是探测报的是「初始化失败」而不是「缺少这项能力」；更糟的是，它会连带中断
 * 剩下那些与缺失服务毫无关系的初始化步骤。
 *
 * @module dsh-tavily-pool/dsh/read-service
 */

/**
 * 从 context 读取一个服务，容忍其不存在。
 *
 * 仅在反射写法不可用时才退回直接属性读取，并吞掉随之而来的抛出：会抛的探测
 * 毫无用处。
 *
 * @param ctx - 插件 context。
 * @param name - 服务名。
 * @returns 服务值；未被提供时返回 `undefined`。
 */
export function readService(ctx, name) {
  if (ctx === null || ctx === undefined) return undefined;
  if (typeof ctx.get === 'function') {
    try {
      return ctx.get(name);
    } catch {
      return undefined;
    }
  }
  try {
    return ctx[name];
  } catch {
    return undefined;
  }
}
