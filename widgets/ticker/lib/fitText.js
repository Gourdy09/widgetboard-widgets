// Shrinks a single-line element's font until it fits its container, so numbers like "$104,523.12"
// never overflow a small card. Grows back when the card gets bigger. Returns { update, destroy }.
//
//   const fit = fitText(priceEl, { container: headerEl });
//   priceEl.textContent = "$1,234.56"; fit.update();
//   return () => fit.destroy();   // from render()
export function fitText(el, { container = el.parentElement, minPx = 8 } = {}) {
  let raf = 0;

  function update() {
    if (!el.isConnected || !container) return;
    el.style.fontSize = ""; // measure at the size the stylesheet asks for
    const natural = parseFloat(getComputedStyle(el).fontSize);
    const need = el.scrollWidth;
    const have = container.clientWidth;
    if (need > have && have > 0 && Number.isFinite(natural)) {
      el.style.fontSize = `${Math.max(minPx, Math.floor(natural * (have / need) * 100) / 100 - 0.25)}px`;
    }
  }

  const schedule = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(update);
  };

  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
  if (container) ro?.observe(container);
  window.addEventListener("wb:relayout", schedule);

  return {
    update: schedule,
    destroy() {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener("wb:relayout", schedule);
    },
  };
}
