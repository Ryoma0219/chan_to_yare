// 音はファイルを鳴らさず Web Audio で合成する (audio 要素は自動再生制限で鳴らないことがあるため)。
// ブラウザは一度も操作されていないページで音を出させないので、最初のクリックで AudioContext を起こす。
'use strict';

window.Chime = (() => {
  let ctx = null;

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function note(freq, at, length, gain) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq, at);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, at + length);
    o.connect(g).connect(ctx.destination);
    o.start(at);
    o.stop(at + length + 0.05);
  }

  return {
    unlock() {
      return ensure()?.state !== undefined;
    },
    get ready() {
      return Boolean(ctx && ctx.state === 'running');
    },
    // reply: 返事待ちになった (下がる2音、柔らかく)
    // ask:   許可・質問で止まっている (上がる2音を2回、少し強く)
    play(kind) {
      if (!ensure() || ctx.state !== 'running') return;
      const t = ctx.currentTime + 0.02;
      if (kind === 'ask') {
        note(784, t, 0.18, 0.16);
        note(1047, t + 0.12, 0.28, 0.16);
        note(784, t + 0.5, 0.18, 0.12);
        note(1047, t + 0.62, 0.32, 0.12);
      } else {
        note(880, t, 0.35, 0.12);
        note(659, t + 0.16, 0.55, 0.12);
      }
    },
  };
})();
