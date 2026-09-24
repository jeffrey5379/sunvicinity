// Chain-of-responsibility for "what happens when this click resolves to
// object X" — replaces a growing if/else chain keyed on object.apptype/
// game-mode flags. Handlers are tried in registration order; the first
// whose test() matches gets its handle() called and nothing else runs
// (falling through every handler, like falling through the old chain, is a
// silent no-op). Register the catch-all/default handler last.
export const ClickRouter = (() => {
  const handlers = [];

  // handler: { test(object, intersects) -> boolean, handle(object, intersects) }
  // `object` is the already-resolved target (promoted to its apptype-
  // bearing parent where relevant); `intersects` is the full raycaster hit
  // list, for handlers that need more than the first hit.
  function register(handler) {
    handlers.push(handler);
  }

  async function dispatch(object, intersects) {
    for (const h of handlers) {
      if (h.test(object, intersects)) {
        await h.handle(object, intersects);
        return true;
      }
    }
    return false;
  }

  return { register, dispatch };
})();
