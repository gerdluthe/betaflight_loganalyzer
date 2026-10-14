/* Rotorflight/Betaflight Blackbox (BBL) Parser - Nachbau der Logik von blackbox_decode (blackbox-tools).
   Liefert pro Log: header, names, n, cols{name: Float64Array}. Werte wie in der CSV von blackbox_decode (roh). */
(function (root) {
  'use strict';
  var ENC = { SVB: 0, UVB: 1, NEG14: 3, ED_U: 4, ED_S: 5, T8_8SVB: 6, T2_3S32: 7, T8_4S16: 8, NUL: 9, EG_U: 10, EG_S: 11 };
  var MAX_FRAME_LEN = 256, MAX_ITER_JUMP = 500 * 10, MAX_TIME_JUMP = 10 * 1000 * 1000;
  var MARKERS = { 73: 'I', 80: 'P', 71: 'G', 72: 'H', 83: 'S', 69: 'E' };

  function sx(v, bits) { var s = 32 - bits; return (v << s) >> s; }

  function parseOne(data, start, end) {
    var pos = start, hdr = {}, defs = {};
    function def(t) { return defs[t] || (defs[t] = { names: [], signed: [], pred: [], enc: [], n: 0 }); }
    function ints(s) { return s.split(',').map(function (x) { var v = parseInt(x, 10); return isNaN(v) ? 0 : v; }); }
    // ---- Header ----
    while (pos < end && data[pos] === 72 && data[pos + 1] === 32) {
      var e = pos; while (e < end && data[e] !== 10) e++;
      var line = ''; for (var i = pos + 2; i < e; i++) line += String.fromCharCode(data[i]);
      pos = e + 1;
      var c = line.indexOf(':'); if (c < 0) continue;
      var k = line.slice(0, c).trim(), v = line.slice(c + 1).trim();
      hdr[k] = v;
      if (k.indexOf('Field ') === 0) {
        var ft = k.charAt(6), d = def(ft);
        if (/ name$/.test(k)) { d.names = v.split(','); d.n = d.names.length; if (ft === 'I') { def('P').names = d.names; def('P').n = d.n; } }
        else if (/ signed$/.test(k)) { d.signed = ints(v); if (ft === 'I') def('P').signed = d.signed; }
        else if (/ predictor$/.test(k)) d.pred = ints(v);
        else if (/ encoding$/.test(k)) d.enc = ints(v);
      }
    }
    var I = defs.I; if (!I || !I.n) throw new Error('Keine Feld-Definitionen im Log');
    var cfg = { frameIntervalI: Math.max(1, parseInt(hdr['I interval'], 10) || 32), pNum: 1, pDen: 1,
                dataVersion: parseInt(hdr['Data version'], 10) || 0, minthrottle: parseInt(hdr['minthrottle'], 10) || 0,
                vbatref: parseInt(hdr['vbatref'], 10) || 0, motorOutputLow: 0 };
    var pi = hdr['P interval']; if (pi && pi.indexOf('/') > 0) { cfg.pNum = parseInt(pi, 10); cfg.pDen = parseInt(pi.split('/')[1], 10); }
    cfg.motorOutputLow = cfg.minthrottle;
    if (hdr['motorOutput']) cfg.motorOutputLow = parseInt(hdr['motorOutput'].split(',')[0], 10) || 0;

    var names = I.names.slice(), nMain = I.n, S = defs.S, nSlow = S ? S.n : 0;
    var allNames = names.concat(S ? S.names : []);
    var iTime = names.indexOf('time'), iIter = names.indexOf('loopIteration'), iMotor0 = names.indexOf('motor[0]');
    // ---- Spaltenspeicher ----
    var cap = 1 << 14, ncol = nMain + nSlow, cols = []; for (var q = 0; q < ncol; q++) cols.push(new Float64Array(cap));
    var nrows = 0;
    function pushRow(frame, slow) {
      if (nrows === cap) { cap *= 2; for (var q = 0; q < ncol; q++) { var a = new Float64Array(cap); a.set(cols[q]); cols[q] = a; } }
      for (var q = 0; q < nMain; q++) cols[q][nrows] = frame[q];
      for (var s = 0; s < nSlow; s++) cols[nMain + s][nrows] = slow[s];
      nrows++;
    }
    // ---- Stream ----
    var p = pos, eof = false;
    function rb() { if (p >= end) { eof = true; p++; return 0; } return data[p++]; }
    function uvb() { var r = 0, sh = 0; for (var i = 0; i < 5; i++) { if (p >= end) { eof = true; p++; return 0; } var c = data[p++]; r = (r | ((c & 0x7f) << sh)) >>> 0; if (c < 128) return r; sh += 7; } return 0; }
    function svb() { var u = uvb(); return ((u >>> 1) ^ -(u & 1)) | 0; }
    function t23s32(v) {
      var lead = rb();
      switch (lead >> 6) {
        case 0: v[0] = sx((lead >> 4) & 3, 2); v[1] = sx((lead >> 2) & 3, 2); v[2] = sx(lead & 3, 2); break;
        case 1: v[0] = sx(lead & 15, 4); lead = rb(); v[1] = sx(lead >> 4, 4); v[2] = sx(lead & 15, 4); break;
        case 2: v[0] = sx(lead & 63, 6); lead = rb(); v[1] = sx(lead & 63, 6); lead = rb(); v[2] = sx(lead & 63, 6); break;
        default:
          for (var i = 0; i < 3; i++) {
            switch (lead & 3) {
              case 0: v[i] = sx(rb(), 8); break;
              case 1: { var a = rb(), b = rb(); v[i] = sx(a | (b << 8), 16); break; }
              case 2: { var a2 = rb(), b2 = rb(), c2 = rb(); v[i] = sx(a2 | (b2 << 8) | (c2 << 16), 24); break; }
              default: { var a3 = rb(), b3 = rb(), c3 = rb(), d3 = rb(); v[i] = (a3 | (b3 << 8) | (c3 << 16) | (d3 << 24)) | 0; }
            }
            lead >>= 2;
          }
      }
    }
    function t84s16(v) {
      var sel = rb(), buf = 0, nib = 0;
      for (var i = 0; i < 4; i++) {
        switch (sel & 3) {
          case 0: v[i] = 0; break;
          case 1: if (nib === 0) { buf = rb(); v[i] = sx(buf >> 4, 4); nib = 1; } else { v[i] = sx(buf & 15, 4); nib = 0; } break;
          case 2: if (nib === 0) { v[i] = sx(rb(), 8); } else { var c1 = (buf << 4) & 255; buf = rb(); c1 |= buf >> 4; v[i] = sx(c1, 8); } break;
          default:
            if (nib === 0) { var a = rb(), b = rb(); v[i] = sx(((a << 8) | b) & 0xffff, 16); }
            else { var a2 = rb(), b2 = rb(); v[i] = sx(((buf << 12) | (a2 << 4) | (b2 >> 4)) & 0xffff, 16); buf = b2; }
        }
        sel >>= 2;
      }
    }
    function t88svb(v, count) {
      if (count === 1) { v[0] = svb(); return; }
      var h = rb(); for (var i = 0; i < 8; i++, h >>= 1) v[i] = (h & 1) ? svb() : 0;
    }
    // ---- Frames ----
    var hist = [new Float64Array(nMain), new Float64Array(nMain), new Float64Array(nMain)];
    var cur = hist[0], prev = null, prev2 = null, ring = 0;
    var lastSlow = new Float64Array(Math.max(nSlow, 1)), lastIter = -1, lastTime = -1, rollover = 0;
    var mainValid = false, lastSkipped = 0, ev = -1;
    function should(fi) { return (((fi % cfg.frameIntervalI) + cfg.pNum - 1) % cfg.pDen) < cfg.pNum; }
    function skippedFrames() { if (lastIter === -1) return 0; var c = 0; for (var fi = lastIter + 1; !should(fi); fi++) c++; return c; }
    function predict(i, pr, value, frame) {
      switch (pr) {
        case 0: break;
        case 4: value += cfg.minthrottle; break;
        case 8: value += 1500; break;
        case 5: value += frame[iMotor0]; break;
        case 9: value += cfg.vbatref; break;
        case 1: if (prev) value += prev[i]; break;
        case 2: if (prev) value += 2 * prev[i] - prev2[i]; break;
        case 3: if (prev) value += Math.trunc((prev[i] + prev2[i]) / 2); break;
        case 10: if (prev) value += prev[iTime]; break;
        case 11: value += cfg.motorOutputLow; break;
        default: throw new Error('Predictor ' + pr + ' nicht unterstuetzt');
      }
      return value;
    }
    function parseFrame(t, frame, skipped) {
      var d = defs[t], pred = d.pred, enc = d.enc, sg = d.signed, i = 0, v = [0, 0, 0, 0, 0, 0, 0, 0], val, j, gc;
      while (i < d.n) {
        if (pred[i] === 6) { frame[i] = skipped + 1 + (prev ? prev[i] : 0); i++; continue; }
        switch (enc[i]) {
          case ENC.SVB: val = svb(); break;
          case ENC.UVB: val = uvb(); break;
          case ENC.NEG14: val = -sx(uvb() & 0x3fff, 14); break;
          case ENC.T8_4S16: t84s16(v); for (j = 0; j < 4; j++, i++) frame[i] = predict(i, pred[i], v[j], frame); continue;
          case ENC.T2_3S32: t23s32(v); for (j = 0; j < 3; j++, i++) frame[i] = predict(i, pred[i], v[j], frame); continue;
          case ENC.T8_8SVB:
            for (j = i + 1; j < i + 8 && j < d.n; j++) if (enc[j] !== ENC.T8_8SVB) break;
            gc = j - i; t88svb(v, gc); for (j = 0; j < gc; j++, i++) frame[i] = predict(i, pred[i], v[j], frame); continue;
          case ENC.NUL: val = 0; break;
          default: throw new Error('Encoding ' + enc[i] + ' nicht unterstuetzt');
        }
        val = predict(i, pred[i], val, frame);
        frame[i] = sg[i] ? (val | 0) : (val >>> 0);   // Feldbreite 4 (Standard)
        i++;
      }
    }
    function rotate(isI) {
      if (isI) { prev = hist[ring]; prev2 = hist[ring]; } else { prev2 = prev; prev = hist[ring]; }
      ring = (ring + 1) % 3; cur = hist[ring];
    }
    function rolloverFix() {
      var t = cur[iTime];
      if (lastTime !== -1 && (t >>> 0) < (lastTime >>> 0) && (((t >>> 0) - (lastTime >>> 0)) >>> 0) < MAX_TIME_JUMP) rollover += 4294967296;
      cur[iTime] = (t >>> 0) + rollover;
    }
    function validate() { return cur[iIter] >= lastIter && cur[iIter] < lastIter + MAX_ITER_JUMP && cur[iTime] >= lastTime && cur[iTime] < lastTime + MAX_TIME_JUMP; }
    function invalidate() { mainValid = false; prev = null; prev2 = null; }
    while (p < end) {
      var m = MARKERS[data[p]];
      if (!m) { mainValid = false; p++; continue; }
      p++; var fs = p; eof = false;
      var ok = true, t = m;
      try {
        if (t === 'I') { parseFrame('I', cur, 0); }
        else if (t === 'P') { lastSkipped = skippedFrames(); parseFrame('P', cur, lastSkipped); }
        else if (t === 'S') { if (S) parseFrame('S', lastSlow, 0); }
        else if (t === 'G' || t === 'H') { if (defs[t]) parseFrame(t, new Float64Array(defs[t].n), 0); }
        else if (t === 'E') {
          var et = rb(); ev = et;
          if (et === 0) uvb(); else if (et === 13) { var f = rb(); if (f > 127) { p += 4; } else svb(); }
          else if (et === 14) { var li = uvb(), ct = uvb() + rollover; ev = { resume: [li, ct] }; }
          else if (et === 255) { if (p + 11 <= end) { var s = ''; for (var z = 0; z < 11; z++) s += String.fromCharCode(data[p + z]); p += 11; if (s === 'End of log\0') end = p; else ev = -1; } else { p = end; } }
          else ev = -1;
        }
      } catch (err) { if (/nicht unterstuetzt/.test(err.message)) throw err; ok = false; }
      var size = p - fs;
      if (!ok || size > MAX_FRAME_LEN) { mainValid = false; p = Math.max(p, fs) ; p++; continue; }
      // ---- complete ----
      if (t === 'I') {
        rolloverFix();
        if (lastIter !== -1 && !validate()) invalidate(); else mainValid = true;
        if (mainValid) { lastIter = cur[iIter]; lastTime = cur[iTime]; pushRow(cur, lastSlow); rotate(true); }
      } else if (t === 'P') {
        rolloverFix();
        if (mainValid && !validate()) invalidate();
        if (mainValid) { lastIter = cur[iIter]; lastTime = cur[iTime]; pushRow(cur, lastSlow); rotate(false); }
      } else if (t === 'E' && ev && ev.resume) { lastIter = ev.resume[0]; lastTime = ev.resume[1]; }
    }
    var out = { header: hdr, names: allNames, n: nrows, cols: {}, nMain: nMain };
    for (var q = 0; q < ncol; q++) out.cols[allNames[q]] = cols[q].subarray(0, nrows);
    return out;
  }

  function parse(buf) {
    var data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    var key = [72, 32, 80, 114, 111, 100, 117, 99, 116, 58]; // "H Product:"
    var starts = [];
    for (var i = 0; i + key.length < data.length; i++) {
      if (data[i] === 72 && data[i + 1] === 32 && data[i + 2] === 80) {
        var ok = true; for (var j = 3; j < key.length; j++) if (data[i + j] !== key[j]) { ok = false; break; }
        if (ok) starts.push(i);
      }
    }
    var logs = [];
    for (var s = 0; s < starts.length; s++) {
      var end = s + 1 < starts.length ? starts[s + 1] : data.length;
      try { logs.push(parseOne(data, starts[s], end)); } catch (e) { logs.push({ error: e.message, header: {}, n: 0, cols: {}, names: [] }); }
    }
    return logs;
  }
  var api = { parse: parse };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.BBL = api;
})(typeof self !== 'undefined' ? self : this);
