/**
 * Reading host services without tripping the context proxy.
 *
 * Cordis exposes two ways to read a service from a context, and they differ in
 * exactly the way that matters to a capability probe:
 *
 * - `ctx.someService` is the *consumer* form. It requires the service to be in
 *   the reading fiber's `inject` list (or provided by an ancestor fiber), and
 *   otherwise throws `cannot get property "x" without inject`.
 * - `ctx.get('someService')` is the *reflective* form. It returns `undefined`
 *   when the service is absent, which is what a probe needs: the whole point of
 *   probing is to find out what is missing.
 *
 * Using the consumer form in a probe is a real bug, not a style preference: the
 * throw happens inside the probe, which then reports "initialization failed"
 * instead of "this capability is missing", and — worse — aborts the rest of the
 * initialization that had nothing to do with the missing service.
 *
 * @module dsh-tavily-pool/dsh/read-service
 */

/**
 * Read one service from a context, tolerating its absence.
 *
 * Falls back to a direct property read only when the reflective form is not
 * available, and swallows the resulting throw: a probe that throws is useless.
 *
 * @param ctx - plugin context.
 * @param name - service name.
 * @returns the service value, or `undefined` when it is not provided.
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
