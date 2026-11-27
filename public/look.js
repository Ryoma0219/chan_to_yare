'use strict';

// Small behaviours the Future look needs: the row spotlight and counting figures up.
window.Look = (() => {
  const root = document.documentElement;
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // spotlight: rows light up around the pointer
  document.addEventListener(
    'pointermove',
    (e) => {
      const row = e.target.closest?.('.row');
      if (!row) return;
      const r = row.getBoundingClientRect();
      row.style.setProperty('--mx', `${e.clientX - r.left}px`);
      row.style.setProperty('--my', `${e.clientY - r.top}px`);
    },
    { passive: true },
  );

  // count figures up from zero (keeps any unit or prefix such as "$" or " h")
  function countUp(container, duration = 1100) {
    if (reduced()) return;
    for (const el of container.querySelectorAll('dd')) {
      const text = el.textContent;
      const m = text.match(/^(\D*)([\d,]+(?:\.\d+)?)(.*)$/);
      if (!m) continue;
      const [, pre, numStr, post] = m;
      const target = Number(numStr.replace(/,/g, ''));
      if (!Number.isFinite(target) || target === 0) continue;
      const decimals = numStr.includes('.') ? numStr.split('.')[1].length : 0;
      const fmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
      const start = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - start) / duration);
        const eased = 1 - (1 - t) ** 4;
        el.textContent = `${pre}${fmt.format(target * eased)}${post}`;
        if (t < 1) requestAnimationFrame(step);
        else el.textContent = text;
      };
      requestAnimationFrame(step);
    }
  }

  return { countUp };
})();
