// Hello Clock: the smallest useful widget. It uses only what the Widget API (v1) provides through `ctx`,
// and imports nothing from WidgetBoard. See docs/WIDGET_SPEC.md.
export default {
  // Called once when the widget appears. Build the interface inside ctx.slots.
  mount(ctx) {
    this.time = document.createElement("div");
    this.time.className = "hc-time";
    this.date = document.createElement("div");
    this.date.className = "hc-date";

    // Slots the user collapsed are simply missing, so always check.
    ctx.slots.main?.append(this.time, this.date);
    if (ctx.slots.title) ctx.slots.title.textContent = ctx.settings.label || "Clock";

    // Timers made through ctx are stopped by WidgetBoard when the widget goes away.
    this.timer = ctx.setInterval(() => this.tick(ctx), 1000);
    this.tick(ctx);
  },

  // Called when the user edits this widget's settings. Optional: without it WidgetBoard remounts the widget.
  update(ctx) {
    if (ctx.slots.title) ctx.slots.title.textContent = ctx.settings.label || "Clock";
    this.tick(ctx);
  },

  tick(ctx) {
    const { hour12, seconds, timezone } = ctx.settings;
    const zone = timezone && timezone !== "local" ? { timeZone: timezone } : {};
    const now = new Date();
    this.time.textContent = now.toLocaleTimeString([], {
      hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hour12: !!hour12, ...zone,
    });
    this.date.textContent = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", ...zone });
  },

  // Optional. WidgetBoard also aborts ctx.signal and clears ctx timers, so a widget that forgets still can't leak.
  unmount() {},
};
