/* Kleine Canvas-Diagramm-Bibliothek (dunkles Theme, Touch-tauglich). Keine Abhaengigkeiten. */
(function (root) {
  'use strict';
  var TH = { bg: '#2f2f2f', panel: '#262626', grid: 'rgba(255,255,255,.08)', axis: '#4a4a4a', text: '#e2e2e2', mut: '#a3a3a3' };
  var C = { blue: '#4ea8de', orange: '#ffbb00', green: '#78c841', red: '#ff4d5e', grey: '#a3a3a3', purple: '#c08cff', yellow: '#ffd75e' };
  var FONT = '11px "Open Sans","Segoe UI",Roboto,Arial,sans-serif';

  function niceStep(range, n) {
    var raw = range / n, mag = Math.pow(10, Math.floor(Math.log10(raw))), r = raw / mag;
    return (r < 1.5 ? 1 : r < 3 ? 2 : r < 7 ? 5 : 10) * mag;
  }
  function ticks(lo, hi, n) {
    var st = niceStep(hi - lo, n), a = Math.ceil(lo / st - 1e-9) * st, out = [];
    for (var v = a; v <= hi + st * 1e-9; v += st) out.push(Math.abs(v) < st * 1e-9 ? 0 : v);
    return { t: out, step: st };
  }
  function fmt(v, step) { var d = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step))); if (Math.abs(v) >= 10000) return (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'k'; return v.toFixed(d); }
  function ext(series, key, log) {
    var lo = Infinity, hi = -Infinity;
    series.forEach(function (s) { var a = s[key]; if (!a) return; for (var i = 0; i < a.length; i++) { var v = a[i]; if (v === v && isFinite(v) && (!log || v > 0)) { if (v < lo) lo = v; if (v > hi) hi = v; } } });
    return [lo, hi];
  }
  // Min/Max-Dezimierung: erhaelt Spitzen bei vielen Punkten
  function decimate(x, y, w, x0, x1) {
    var n = x.length, i0 = 0, i1 = n;
    if (n < w * 3) return [x, y];
    var ox = [], oy = [], span = (x1 - x0) / w, b = -1, mn, mx, imn, imx;
    function flush() { if (b < 0) return; if (imn < imx) { ox.push(x[imn], x[imx]); oy.push(y[imn], y[imx]); } else if (imn > imx) { ox.push(x[imx], x[imn]); oy.push(y[imx], y[imn]); } else { ox.push(x[imn]); oy.push(y[imn]); } }
    for (var i = i0; i < i1; i++) {
      var v = y[i]; if (v !== v) continue;
      var bk = Math.floor((x[i] - x0) / span);
      if (bk !== b) { flush(); b = bk; mn = mx = v; imn = imx = i; }
      else { if (v < mn) { mn = v; imn = i; } if (v > mx) { mx = v; imx = i; } }
    }
    flush(); return [ox, oy];
  }
  function dash(ctx, d) { ctx.setLineDash(d === 'dash' ? [5, 4] : d === 'dot' ? [2, 3] : []); }

  // ---- ein Panel zeichnen ----
  function panel(ctx, box, o) {
    var ml = 50, mr = o.y2 ? 46 : 12, mt = o.title ? 24 : 8, mb = o.xlabel ? 36 : (o.xticks === false ? 6 : 22);
    var px = box.x + ml, py = box.y + mt, pw = box.w - ml - mr, ph = box.h - mt - mb;
    if (pw < 20 || ph < 20) return;
    var S = o.series || [], left = S.filter(function (s) { return s.axis !== 'y2'; }), right = S.filter(function (s) { return s.axis === 'y2'; });
    var xr = o.xlim || (function () { var e = ext(S.filter(function (s) { return !s.bars; }).concat(S.filter(function (s) { return s.bars; })), 'x'); return e; })();
    if (!(xr[1] > xr[0])) xr = [xr[0] - 1, xr[0] + 1];
    function yRange(arr, lim, log) {
      if (lim) return lim.slice();
      var e = ext(arr, 'y', log); if (!isFinite(e[0])) return [0, 1];
      (o.hlines || []).forEach(function (h) { if (!h.right && !log) { e[0] = Math.min(e[0], h.y); e[1] = Math.max(e[1], h.y); } });
      if (log) return [Math.pow(10, Math.floor(Math.log10(e[0]))), Math.pow(10, Math.ceil(Math.log10(e[1]) + 0.05))];
      if (arr.some(function (s) { return s.bars; })) e[0] = Math.min(0, e[0]);
      var pad = (e[1] - e[0]) * 0.06 || 1; return [e[0] - (o.padLow === false ? 0 : pad), e[1] + pad];
    }
    var yl = yRange(left, o.ylim, o.ylog), yr = right.length ? yRange(right, o.y2lim, false) : null;
    function X(v) { return px + (v - xr[0]) / (xr[1] - xr[0]) * pw; }
    function Yl(v) { if (o.ylog) { v = Math.max(v, yl[0]); return py + ph - (Math.log10(v) - Math.log10(yl[0])) / (Math.log10(yl[1]) - Math.log10(yl[0])) * ph; } return py + ph - (v - yl[0]) / (yl[1] - yl[0]) * ph; }
    function Yr(v) { return py + ph - (v - yr[0]) / (yr[1] - yr[0]) * ph; }
    ctx.save(); ctx.font = FONT;
    ctx.fillStyle = TH.panel; ctx.fillRect(px, py, pw, ph);
    // Spans
    (o.spans || []).forEach(function (s) { ctx.fillStyle = s.color; ctx.fillRect(Math.max(px, X(s.x0)), py, Math.min(px + pw, X(s.x1)) - Math.max(px, X(s.x0)), ph); });
    // Bild (Spektrogramm)
    if (o.image) { ctx.imageSmoothingEnabled = false; ctx.drawImage(o.image.canvas, X(o.image.x0), py, X(o.image.x1) - X(o.image.x0), ph); }
    // Gitter + Ticks
    ctx.strokeStyle = TH.grid; ctx.lineWidth = 1; ctx.fillStyle = TH.mut; ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
    if (!o.image) {
      if (o.ylog) { for (var d = Math.log10(yl[0]); d <= Math.log10(yl[1]) + 1e-9; d++) { var yy = Yl(Math.pow(10, d)); ctx.beginPath(); ctx.moveTo(px, yy); ctx.lineTo(px + pw, yy); ctx.stroke(); ctx.fillText('1e' + d, px - 5, yy); } }
      else { var ty = ticks(yl[0], yl[1], Math.max(2, Math.floor(ph / 38))); ty.t.forEach(function (v) { var yy2 = Yl(v); ctx.beginPath(); ctx.moveTo(px, yy2); ctx.lineTo(px + pw, yy2); ctx.stroke(); ctx.fillText(fmt(v, ty.step), px - 5, yy2); }); }
    } else { var tyi = ticks(o.ylim[0], o.ylim[1], 4); tyi.t.forEach(function (v) { ctx.fillText(fmt(v, tyi.step), px - 5, py + ph - (v - o.ylim[0]) / (o.ylim[1] - o.ylim[0]) * ph); }); }
    if (yr) { ctx.textAlign = 'left'; var t2 = ticks(yr[0], yr[1], Math.max(2, Math.floor(ph / 38))); t2.t.forEach(function (v) { ctx.fillText(fmt(v, t2.step), px + pw + 5, Yr(v)); }); }
    var tx = ticks(xr[0], xr[1], Math.max(3, Math.floor(pw / 80)));
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    tx.t.forEach(function (v) { var xx = X(v); if (!o.image) { ctx.beginPath(); ctx.moveTo(xx, py); ctx.lineTo(xx, py + ph); ctx.stroke(); } if (o.xticks !== false) ctx.fillText(fmt(v, tx.step), xx, py + ph + 4); });
    // Serien
    ctx.save(); ctx.beginPath(); ctx.rect(px, py, pw, ph); ctx.clip();
    S.forEach(function (s) {
      var Y = s.axis === 'y2' ? Yr : Yl; ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineWidth = s.width || 1.2; dash(ctx, s.dash);
      if (s.bars) {
        var bw = Math.max(1, (s.bw || 1) / (xr[1] - xr[0]) * pw - 1), base = o.ylog ? py + ph : Y(0);
        ctx.globalAlpha = s.alpha || 0.85; for (var i = 0; i < s.x.length; i++) { if (!(s.y[i] > 0) && o.ylog) continue; var yy3 = Y(s.y[i]); ctx.fillRect(X(s.x[i]) - bw / 2, Math.min(yy3, base), bw, Math.abs(base - yy3)); } ctx.globalAlpha = 1;
      } else if (s.points) {
        for (var k = 0; k < s.x.length; k++) { ctx.beginPath(); ctx.arc(X(s.x[k]), Y(s.y[k]), s.r || 2.2, 0, 6.3); ctx.fill(); }
      } else if (s.vlines) {
        ctx.globalAlpha = 0.75; for (var q = 0; q < s.x.length; q++) { ctx.beginPath(); ctx.moveTo(X(s.x[q]), Y(0)); ctx.lineTo(X(s.x[q]), Y(s.y[q])); ctx.stroke(); } ctx.globalAlpha = 1;
        for (var q2 = 0; q2 < s.x.length; q2++) { ctx.beginPath(); ctx.arc(X(s.x[q2]), Y(s.y[q2]), 2.2, 0, 6.3); ctx.fill(); }
      } else {
        var dd = decimate(s.x, s.y, Math.max(40, Math.floor(pw)), xr[0], xr[1]), xs = dd[0], ys = dd[1], on = false;
        ctx.beginPath(); var fx0 = null, fx1 = null; for (var j = 0; j < xs.length; j++) { var yv = ys[j]; if (yv !== yv || (o.ylog && !(yv > 0))) { on = false; continue; } var xp = X(xs[j]), yp = Y(yv); if (fx0 === null) fx0 = xp; fx1 = xp; if (!on) { ctx.moveTo(xp, yp); on = true; } else ctx.lineTo(xp, yp); } ctx.stroke();
        if (s.fill && fx0 !== null) { ctx.lineTo(fx1, py + ph); ctx.lineTo(fx0, py + ph); ctx.closePath(); ctx.globalAlpha = 0.28; ctx.fill(); ctx.globalAlpha = 1; }
      }
    });
    (o.hlines || []).forEach(function (h) { ctx.strokeStyle = h.color || TH.text; ctx.lineWidth = 1; dash(ctx, h.dash || 'dash'); var yy4 = h.right ? Yr(h.y) : Yl(h.y); ctx.beginPath(); ctx.moveTo(px, yy4); ctx.lineTo(px + pw, yy4); ctx.stroke(); });
    (o.vlines || []).forEach(function (v) { ctx.strokeStyle = v.color || TH.text; ctx.lineWidth = 1.1; dash(ctx, v.dash || 'dot'); var xx = X(v.x); ctx.beginPath(); ctx.moveTo(xx, py); ctx.lineTo(xx, py + ph); ctx.stroke(); });
    ctx.restore(); dash(ctx, '');
    (o.vlines || []).forEach(function (v) { if (!v.label) return; ctx.fillStyle = v.color || TH.text; ctx.font = '10px "Open Sans","Segoe UI",Arial,sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(v.label, Math.min(X(v.x) + 3, px + pw - 60), py + 3 + (v.row || 0) * 12); });
    // Rahmen + Beschriftung
    ctx.strokeStyle = TH.axis; ctx.strokeRect(px + .5, py + .5, pw, ph);
    ctx.font = FONT; ctx.fillStyle = TH.text;
    if (o.title) { ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.font = '600 12px "Open Sans","Segoe UI",Arial,sans-serif'; ctx.fillText(o.title, px + pw / 2, box.y + 15); ctx.font = FONT; }
    ctx.fillStyle = TH.mut;
    if (o.ylabel) { ctx.save(); ctx.translate(box.x + 11, py + ph / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(o.ylabel, 0, 0); ctx.restore(); }
    if (o.y2label && yr) { ctx.save(); ctx.translate(box.x + box.w - 8, py + ph / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(o.y2label, 0, 0); ctx.restore(); }
    if (o.xlabel) { ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(o.xlabel, px + pw / 2, py + ph + 20); }
    // Legende
    var lg = S.filter(function (s) { return s.label; });
    if (lg.length && o.legend !== false) {
      var lw = 0; lg.forEach(function (s) { lw = Math.max(lw, ctx.measureText(s.label).width); }); lw += 30; var lh = lg.length * 14 + 6;
      var lx = o.legend === 'left' ? px + 6 : px + pw - lw - 6, ly = o.legend === 'bottom' ? py + ph - lh - 4 : py + 5;
      ctx.fillStyle = 'rgba(38,38,38,.88)'; ctx.fillRect(lx, ly, lw, lh);
      lg.forEach(function (s, i) { var yy5 = ly + 10 + i * 14; ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineWidth = 2; dash(ctx, s.dash); ctx.beginPath(); ctx.moveTo(lx + 6, yy5); ctx.lineTo(lx + 22, yy5); ctx.stroke(); dash(ctx, ''); ctx.fillStyle = TH.text; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(s.label, lx + 26, yy5); });
    }
    ctx.restore();
  }

  // ---- Figur: Zeilen mit Panels, passt sich der Breite an ----
  function figure(parent, spec) {
    var wrap = document.createElement('figure'), cv = document.createElement('canvas'), cap = document.createElement('figcaption');
    wrap.appendChild(cv); if (spec.caption) { cap.textContent = spec.caption; wrap.appendChild(cap); }
    parent.appendChild(wrap);
    function layout(W) {
      var rows = [], narrow = W < 640;
      spec.rows.forEach(function (r) {
        if (narrow && r.panels.length > 1) r.panels.forEach(function (p) { rows.push({ h: Math.max(r.h, 170), panels: [p], widths: [1] }); });
        else rows.push(r);
      });
      return rows;
    }
    function draw() {
      var W = Math.max(280, wrap.clientWidth - 24), rows = layout(W), H = rows.reduce(function (a, r) { return a + r.h; }, 0) + (spec.title ? 26 : 0), dpr = window.devicePixelRatio || 1;
      cv.style.width = W + 'px'; cv.style.height = H + 'px'; cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      var ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = TH.bg; ctx.fillRect(0, 0, W, H);
      var y = 0; if (spec.title) { ctx.fillStyle = TH.text; ctx.font = '600 13px "Open Sans","Segoe UI",Arial,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillText(spec.title, W / 2, 17); y = 26; }
      rows.forEach(function (r) {
        var tot = r.widths ? r.widths.reduce(function (a, b) { return a + b; }, 0) : r.panels.length, x = 0;
        r.panels.forEach(function (p, i) { var w = W * (r.widths ? r.widths[i] : 1) / tot; panel(ctx, { x: x, y: y, w: w, h: r.h }, p); x += w; });
        y += r.h;
      });
    }
    draw(); var last = wrap.clientWidth, t;
    window.addEventListener('resize', function () { clearTimeout(t); t = setTimeout(function () { if (wrap.clientWidth !== last) { last = wrap.clientWidth; draw(); } }, 120); });
    return wrap;
  }
  // ---- Histogramm ----
  function hist(vals, lo, hi, bins) { var cnt = new Float64Array(bins), cx = new Float64Array(bins), w = (hi - lo) / bins; for (var i = 0; i < bins; i++) cx[i] = lo + (i + .5) * w; for (var j = 0; j < vals.length; j++) { var v = vals[j]; if (v !== v) continue; v = Math.min(hi - 1e-9, Math.max(lo, v)); cnt[Math.floor((v - lo) / w)]++; } return { x: cx, y: cnt, w: w }; }
  // ---- Colormaps (Spektrogramm) ----
  var MAGMA = ['#000004', '#140e36', '#3b0f70', '#641a80', '#8c2981', '#b73779', '#de4968', '#f7705c', '#fe9f6d', '#fecf92', '#fcfdbf'];
  var REDS = ['#262626', '#3d1a26', '#7a1d2a', '#b01e28', '#e0332c', '#ff6b5e', '#ffb3a7'];
  function hex(h) { return [parseInt(h.substr(1, 2), 16), parseInt(h.substr(3, 2), 16), parseInt(h.substr(5, 2), 16)]; }
  function cmap(stops, t) { t = Math.min(1, Math.max(0, t)); var x = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i, a = hex(stops[i]), b = hex(stops[i + 1]); return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]; }
  function heat(data, nx, ny, vmin, vmax, stops) { // data[x*ny + y]; y=0 unten
    var c = document.createElement('canvas'); c.width = nx; c.height = ny; var g = c.getContext('2d'), im = g.createImageData(nx, ny);
    for (var x = 0; x < nx; x++) for (var y = 0; y < ny; y++) { var col = cmap(stops, (data[x * ny + y] - vmin) / (vmax - vmin)), o = ((ny - 1 - y) * nx + x) * 4; im.data[o] = col[0]; im.data[o + 1] = col[1]; im.data[o + 2] = col[2]; im.data[o + 3] = 255; }
    g.putImageData(im, 0, 0); return c;
  }
  var api = { figure: figure, panel: panel, hist: hist, heat: heat, MAGMA: MAGMA, REDS: REDS, C: C, TH: TH };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Charts = api;
})(typeof self !== 'undefined' ? self : this);
