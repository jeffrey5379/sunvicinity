// One mutually-exclusive, per-frame animation at a time — replaces a raw
// `animation` name variable plus a `currentStep` counter that used to be
// shared (and manually reset) across every place that could start or chain
// an animation. play() both starts a new animation and restarts the ones a
// tick function chains straight into (e.g. CLUSTER_ONE -> CLUSTER_TWO), so
// the step counter can never leak from the previous animation or be
// forgotten by a caller.
export const AnimationRunner = (() => {
  const handlers = {};
  let current = null;
  let step = 0;

  // One-time setup: which tick function runs each frame while `name` plays.
  function registerHandler(name, tickFn) {
    handlers[name] = tickFn;
  }

  // Starts `name` — or, called from inside a tick function, chains straight
  // into the next animation — resetting the step counter either way.
  function play(name) {
    current = name;
    step = 0;
  }

  function stop() {
    current = null;
    step = 0;
  }

  function isRunning() {
    return current !== null;
  }

  function isPlaying(name) {
    return current === name;
  }

  // Called once per frame from render(). Advances the step counter first,
  // so the ticking handler always sees the step it's about to render.
  function update() {
    if (current === null) return;
    step++;
    handlers[current]?.();
  }

  return {
    registerHandler, play, stop, isRunning, isPlaying, update,
    get step() { return step; },
  };
})();
