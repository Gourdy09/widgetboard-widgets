const SVG_NS = "http://www.w3.org/2000/svg";

const COLORS = {
  up: "var(--wb-positive, #20d879)",
  down: "var(--wb-negative, #ff5252)",
  grid: "var(--wb-text-faint, #666)",
};

function element(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function validNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function getBounds(data) {
  const values = data.flatMap((item) => [item.low, item.high, item.close]).filter(validNumber);
  if (!values.length) return { min: 0, max: 1 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = (max - min || Math.abs(max) * 0.02 || 1) * 0.12;
  return { min: min - padding, max: max + padding };
}

function makeScale(bounds, width, height, padding = 5) {
  const span = bounds.max - bounds.min || 1;
  return {
    x: (index, count) => count <= 1 ? width / 2 : padding + (index / (count - 1)) * (width - padding * 2),
    y: (value) => height - padding - ((value - bounds.min) / span) * (height - padding * 2),
  };
}

function drawGrid(svg, width, height) {
  [0.25, 0.5, 0.75].forEach((fraction) => {
    svg.append(element("line", {
      x1: 0, x2: width, y1: height * fraction, y2: height * fraction,
      stroke: COLORS.grid, "stroke-width": 0.7, "stroke-dasharray": "2 5", opacity: 0.28,
    }));
  });
}

function drawSparkline(svg, data, scale, width, height, area = false) {
  const points = data.filter((item) => validNumber(item.close));
  if (points.length < 2) return;
  const coords = points.map((item, index) => [scale.x(index, points.length), scale.y(item.close)]);
  const d = coords.map(([x, y], index) => `${index ? "L" : "M"} ${x} ${y}`).join(" ");
  const rising = points.at(-1).close >= points[0].close;
  const color = rising ? COLORS.up : COLORS.down;

  if (area) {
    const [firstX] = coords[0];
    const [lastX] = coords.at(-1);
    const areaPath = `${d} L ${lastX} ${height} L ${firstX} ${height} Z`;
    const gradientId = `ticker-area-${Math.random().toString(36).slice(2)}`;
    const defs = element("defs");
    const gradient = element("linearGradient", { id: gradientId, x1: "0", x2: "0", y1: "0", y2: "1" });
    gradient.append(element("stop", { offset: "0%", "stop-color": color, "stop-opacity": 0.3 }));
    gradient.append(element("stop", { offset: "100%", "stop-color": color, "stop-opacity": 0 }));
    defs.append(gradient);
    svg.append(defs);
    svg.append(element("path", { d: areaPath, fill: `url(#${gradientId})` }));
  }

  svg.append(element("path", {
    d, fill: "none", stroke: color, "stroke-width": 2.2,
    "stroke-linecap": "round", "stroke-linejoin": "round", "vector-effect": "non-scaling-stroke",
  }));
}

function drawCandles(svg, data, scale, width, height, type) {
  const valid = data.filter((item) => validNumber(item.open) && validNumber(item.high)
    && validNumber(item.low) && validNumber(item.close));
  if (!valid.length) return;
  const step = width / valid.length;
  const bodyWidth = Math.max(2, Math.min(9, step * 0.58));

  valid.forEach((item, index) => {
    const x = (index + 0.5) * step;
    const bullish = item.close >= item.open;
    const color = bullish ? COLORS.up : COLORS.down;
    const highY = scale.y(item.high);
    const lowY = scale.y(item.low);
    const openY = scale.y(item.open);
    const closeY = scale.y(item.close);

    svg.append(element("line", {
      x1: x, x2: x, y1: highY, y2: lowY, stroke: color,
      "stroke-width": 1.25, "vector-effect": "non-scaling-stroke",
    }));

    if (type === "ohlc") {
      const tick = Math.max(2, bodyWidth * 0.75);
      svg.append(element("line", { x1: x - tick, x2: x, y1: openY, y2: openY, stroke: color, "stroke-width": 1.5 }));
      svg.append(element("line", { x1: x, x2: x + tick, y1: closeY, y2: closeY, stroke: color, "stroke-width": 1.5 }));
    } else {
      const top = Math.min(openY, closeY);
      const bodyHeight = Math.max(1.5, Math.abs(closeY - openY));
      svg.append(element("rect", {
        x: x - bodyWidth / 2, y: top, width: bodyWidth, height: bodyHeight,
        rx: 0.6, fill: color,
      }));
    }
  });
}

function drawBars(svg, data, scale, width, height) {
  const valid = data.filter((item) => validNumber(item.close));
  if (!valid.length) return;
  const step = width / valid.length;
  const barWidth = Math.max(1, Math.min(8, step * 0.65));
  const baseline = scale.y(Math.min(...valid.map((item) => item.close)));
  valid.forEach((item, index) => {
    const x = (index + 0.5) * step - barWidth / 2;
    const y = scale.y(item.close);
    const color = index === 0 || item.close >= valid[index - 1].close ? COLORS.up : COLORS.down;
    svg.append(element("rect", {
      x, y: Math.min(y, baseline), width: barWidth,
      height: Math.max(1, Math.abs(baseline - y)), rx: 0.7, fill: color, opacity: 0.9,
    }));
  });
}

/** Render a price series into an existing SVG element. */
export function renderChart(svg, { type = "sparkline", data = [] } = {}) {
  const width = 200;
  const height = 60;
  svg.replaceChildren();
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.dataset.chartType = type;

  const usable = data.filter((item) => validNumber(item.close));
  if (usable.length < 2) return;

  const bounds = getBounds(data);
  const scale = makeScale(bounds, width, height, 5);

  if (type === "area") {
    drawSparkline(svg, usable, scale, width, height, true);
  } else if (type === "candlestick" || type === "ohlc") {
    drawGrid(svg, width, height);
    drawCandles(svg, data, scale, width, height, type);
  } else if (type === "bar") {
    drawBars(svg, usable, scale, width, height);
  } else {
    drawSparkline(svg, usable, scale, width, height, false);
  }
}
