/* MP3 Converter — decode with WebAudio, trim/fade/mix in plain JS, encode with lamejs (LGPL, unmodified). Nothing is uploaded. */
(function () {
  "use strict";
  var $ = S3.$, $$ = S3.$$, h = S3.h;

  // ---------- pure helpers (tested in S3_SELFTEST) ----------
  function parseTime(s) {
    s = String(s).trim().replace(",", ".");
    if (!/^\d+(:\d+){0,2}(\.\d*)?$/.test(s)) return NaN;
    return s.split(":").reduce(function (acc, p) { return acc * 60 + parseFloat(p); }, 0);
  }
  function fmtT(sec, ms) {
    sec = Math.max(0, sec || 0);
    var t = Math.round(sec * (ms ? 1000 : 1)), f = ms ? t % 1000 : 0, s = ms ? Math.floor(t / 1000) : t;
    var hh = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
    return (hh ? hh + ":" + String(m).padStart(2, "0") : m) + ":" + String(ss).padStart(2, "0") + (ms ? "." + String(f).padStart(3, "0") : "");
  }
  // MPEG-2 rates (below 32 kHz) top out at 160 kbps; lame would silently pick another bitrate.
  function effKbps(kbps, rate) { return rate < 32000 ? Math.min(kbps, 160) : kbps; }
  function peakOf(chans) { var p = 0; chans.forEach(function (ch) { for (var i = 0; i < ch.length; i++) { var x = Math.abs(ch[i]); if (x > p) p = x; } }); return p; }
  // Cut [start,end) seconds, mix to mono or keep up to 2 channels, linear fades, gain (or normalise to -1 dBFS).
  function renderEdit(chans, rate, o) {
    var len = chans[0].length, s0 = Math.max(0, Math.min(len, Math.round((o.start || 0) * rate)));
    var s1 = o.end == null ? len : Math.max(s0, Math.min(len, Math.round(o.end * rate))), n = s1 - s0;
    var src;
    if (o.channels === 1 || chans.length === 1) {
      var m = new Float32Array(n);
      chans.forEach(function (ch) { for (var i = 0; i < n; i++) m[i] += ch[s0 + i] / chans.length; });
      src = [m];
      if (o.channels === 2) src = [m, m.slice()]; // mono source, stereo output
    } else src = [chans[0].slice(s0, s1), chans[1].slice(s0, s1)];
    var g = o.gain == null ? 1 : o.gain;
    if (o.normalize) { var p = peakOf(src); if (p > 0) g = Math.pow(10, -1 / 20) / p; }
    var fi = Math.min(n, Math.round((o.fadeIn || 0) * rate)), fo = Math.min(n, Math.round((o.fadeOut || 0) * rate));
    src.forEach(function (ch) {
      for (var i = 0; i < n; i++) {
        var e = g;
        if (fi && i < fi) e *= i / fi;
        if (fo && i >= n - fo) e *= (n - 1 - i) / fo;
        ch[i] *= e;
      }
    });
    return src;
  }
  function toInt16(f, out) { for (var i = 0; i < f.length; i++) { var s = f[i] > 1 ? 1 : f[i] < -1 ? -1 : f[i]; out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF; } return out; }
  var tick = (function () { // a fast yield to the event loop (setTimeout(0) is clamped to 4 ms)
    var ch = new MessageChannel(), q = [];
    ch.port1.onmessage = function () { var r = q.shift(); if (r) r(); };
    return function () { return new Promise(function (r) { q.push(r); ch.port2.postMessage(0); }); };
  })();
  async function encodeMp3(chans, rate, kbps, onProg, isCancelled) {
    var enc = new lamejs.Mp3Encoder(chans.length, rate, effKbps(kbps, rate)), n = chans[0].length, B = 1152, out = [];
    var l16 = new Int16Array(B), r16 = new Int16Array(B), t = performance.now();
    for (var i = 0; i < n; i += B) {
      var m = Math.min(B, n - i), l = toInt16(chans[0].subarray(i, i + m), l16.subarray(0, m));
      var b = chans.length === 2 ? enc.encodeBuffer(l, toInt16(chans[1].subarray(i, i + m), r16.subarray(0, m))) : enc.encodeBuffer(l);
      if (b.length) out.push(new Uint8Array(b.buffer, b.byteOffset, b.length).slice());
      if (performance.now() - t > 25) {
        if (onProg) onProg(i / n);
        await tick();
        if (isCancelled && isCancelled()) throw new Error("cancelled");
        t = performance.now();
      }
    }
    var f = enc.flush(); if (f.length) out.push(new Uint8Array(f.buffer, f.byteOffset, f.length).slice());
    return new Blob(out, { type: "audio/mpeg" });
  }
  function encodeWAV(chans, rate) {
    var n = chans.length, len = chans[0].length, block = n * 2, buf = new ArrayBuffer(44 + len * block), v = new DataView(buf);
    function str(o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }
    str(0, "RIFF"); v.setUint32(4, 36 + len * block, true); str(8, "WAVE"); str(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, n, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * block, true); v.setUint16(32, block, true); v.setUint16(34, 16, true);
    str(36, "data"); v.setUint32(40, len * block, true);
    for (var i = 0, o = 44; i < len; i++) for (var c = 0; c < n; c++, o += 2) {
      var s = Math.max(-1, Math.min(1, chans[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return new Blob([buf], { type: "audio/wav" });
  }
  function decodeAt(ab, rate) {
    var ctx = new OfflineAudioContext(1, 1, rate);
    return new Promise(function (res, rej) { ctx.decodeAudioData(ab, res, rej); });
  }
  function chansOf(buf) { var c = []; for (var i = 0; i < Math.min(2, buf.numberOfChannels); i++) c.push(buf.getChannelData(i)); return c; }

  // ---------- settings ----------
  var o = Object.assign({ fmt: "mp3", kbps: 192, channels: 2, rate: 44100, fadeIn: 0, fadeOut: 0, norm: false }, S3.store("mp3conv") || {});
  function saveOpts() { S3.store("mp3conv", o); }
  function seg(id, key, num) {
    $$("#" + id + " button").forEach(function (b) {
      b.setAttribute("aria-pressed", String(String(o[key]) === b.dataset.v));
      b.addEventListener("click", function () {
        o[key] = num ? +b.dataset.v : b.dataset.v; saveOpts();
        $$("#" + id + " button").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
        syncOpts();
      });
    });
  }
  seg("fmt", "fmt"); seg("kbps", "kbps", true); seg("chan", "channels", true);
  $("#rate").value = String(o.rate);
  $("#rate").addEventListener("change", function () { o.rate = +this.value; saveOpts(); syncOpts(); });
  [["fadeIn", "fiV"], ["fadeOut", "foV"]].forEach(function (p) {
    $("#" + p[0]).value = o[p[0]];
    $("#" + p[0]).addEventListener("input", function () { o[p[0]] = +this.value; $("#" + p[1]).textContent = o[p[0]].toFixed(1) + " s"; });
    $("#" + p[0]).addEventListener("change", saveOpts);
  });
  $("#norm").checked = o.norm; $("#norm").addEventListener("change", function () { o.norm = this.checked; saveOpts(); });
  function syncOpts() {
    $("#kbpsWrap").hidden = o.fmt !== "mp3";
    $("#fiV").textContent = o.fadeIn.toFixed(1) + " s"; $("#foV").textContent = o.fadeOut.toFixed(1) + " s";
    $("#go").lastChild.textContent = "Convert all to " + o.fmt.toUpperCase();
    items.forEach(paint);
  }

  // ---------- the batch ----------
  var items = [], busy = false, stopFlag = false, uid = 0;
  function key() { return [o.fmt, o.kbps, o.channels, o.rate, o.fadeIn, o.fadeOut, o.norm].join("|"); }
  function estimate(it) {
    var d = Math.max(0, (it.end == null ? it.dur : it.end) - it.start);
    if (o.fmt === "wav") return d * o.rate * o.channels * 2 + 44;
    return d * effKbps(o.kbps, o.rate) * 125;
  }
  S3.drop($("#drop"), function (files) { files.forEach(add); }, { accept: "audio/*,video/*,.mp3,.wav,.m4a,.aac,.ogg,.oga,.opus,.flac,.webm,.weba,.mp4,.m4v,.mov,.mkv,.3gp,.amr,.wma", multiple: true });
  async function add(file) {
    var it = { id: ++uid, file: file, name: file.name, base: file.name.replace(/\.[^.]+$/, "") || "audio", status: "reading", start: 0, end: null, dur: 0, ch: 0, out: null, prog: 0 };
    items.push(it); build(it); $("#list").hidden = false; $("#drop").classList.add("mc-compact"); counts();
    try {
      var buf = await decodeAt(await S3.readFile(file), o.rate);
      it.dur = buf.duration; it.ch = buf.numberOfChannels; it.status = "ready";
      if (!buf.length) throw new Error("empty");
    } catch (e) {
      it.status = "error";
      it.err = /^video\//.test(file.type) || /\.(mp4|m4v|mov|mkv|webm|3gp)$/i.test(file.name)
        ? "No playable audio track: the video has no sound, or this browser can't decode its audio codec (try Chrome or Edge)."
        : "This browser can't decode this file's audio format. Try Chrome or Edge, or a different file.";
    }
    paint(it); counts();
  }
  function build(it) {
    var startIn = h("input", { "class": "input mono", inputmode: "decimal", "aria-label": "Start time for " + it.name, value: "0:00" });
    var endIn = h("input", { "class": "input mono", inputmode: "decimal", "aria-label": "End time for " + it.name });
    function trimIn(inp, k) {
      inp.addEventListener("change", function () {
        var v = inp.value.trim() === "" ? (k === "end" ? null : 0) : parseTime(inp.value);
        if (v !== null && isNaN(v)) { S3.toast("Use seconds (12.5) or m:ss (1:05)", "error"); }
        else { it[k] = v === null ? null : Math.min(v, it.dur); if (it.end != null && it.end <= it.start) { S3.toast("End must be after start", "error"); it[k] = k === "end" ? null : 0; } }
        paint(it);
      });
    }
    trimIn(startIn, "start"); trimIn(endIn, "end");
    it.el = h("div", { "class": "mc-row" }, [
      h("div", { "class": "mc-ico" }, [svgIcon(/^video\//.test(it.file.type) ? "i-play" : "i-file")]),
      h("div", { "class": "mc-name" }, [h("b", { text: it.name, title: it.name }), h("span", { "class": "faint mc-info" })]),
      h("div", { "class": "mc-trim" }, [h("label", {}, ["Start", startIn]), h("label", {}, ["End", endIn])]),
      h("div", { "class": "mc-state" }, [h("span", { "class": "chip mc-chip" }), h("progress", { max: "1", value: "0", hidden: true })]),
      h("div", { "class": "mc-act" }, [
        h("button", { "class": "btn small mc-main", type: "button", onclick: function () { rowAction(it); } }),
        h("button", { "class": "btn ghost small icon", type: "button", "aria-label": "Remove " + it.name, title: "Remove", onclick: function () { remove(it); } }, [svgIcon("i-x")])
      ])
    ]);
    it.inputs = { start: startIn, end: endIn };
    $("#rows").appendChild(it.el); paint(it);
  }
  function svgIcon(id) { var s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("class", "i"); var u = document.createElementNS("http://www.w3.org/2000/svg", "use"); u.setAttribute("href", "#" + id); s.appendChild(u); return s; }
  function paint(it) {
    if (!it.el) return;
    var info = it.el.querySelector(".mc-info"), chip = it.el.querySelector(".mc-chip"), pr = it.el.querySelector("progress"), btn = it.el.querySelector(".mc-main");
    var fresh = it.out && it.out.key === key() + "|" + it.start + "|" + it.end;
    info.textContent = it.status === "reading" ? "Reading…" : it.status === "error" ? S3.fmtBytes(it.file.size) :
      fmtT(it.dur) + " · " + (it.ch === 1 ? "mono" : "stereo") + " · " + S3.fmtBytes(it.file.size);
    if (document.activeElement !== it.inputs.start) it.inputs.start.value = fmtT(it.start, it.start % 1 !== 0);
    if (document.activeElement !== it.inputs.end) { it.inputs.end.value = it.status === "ready" || it.status === "done" || it.status === "working" ? fmtT(it.end == null ? it.dur : it.end, (it.end == null ? it.dur : it.end) % 1 !== 0 && it.end != null) : ""; }
    it.inputs.start.disabled = it.inputs.end.disabled = it.status === "error" || it.status === "reading" || it.status === "working";
    pr.hidden = it.status !== "working"; pr.value = it.prog;
    chip.className = "chip mc-chip";
    if (it.status === "error") { chip.textContent = "Can't read audio"; chip.classList.add("bad"); chip.title = it.err; }
    else if (it.status === "working") { chip.textContent = it.phase || "Converting…"; chip.title = ""; }
    else if (fresh) { chip.textContent = it.out.name.split(".").pop().toUpperCase() + " · " + S3.fmtBytes(it.out.blob.size); chip.classList.add("ok"); chip.title = ""; }
    else if (it.status === "ready" || it.status === "done") { chip.textContent = "≈ " + S3.fmtBytes(estimate(it)) + " " + o.fmt.toUpperCase(); chip.title = "Estimated output size"; }
    else chip.textContent = "Reading…";
    btn.disabled = it.status === "error" || it.status === "reading" || (busy && it.status !== "working");
    btn.textContent = it.status === "working" ? "Stop" : fresh ? "Download" : "Convert";
    btn.classList.toggle("primary", !!fresh);
    var errLine = it.el.querySelector(".mc-err");
    if (it.status === "error" && !errLine) it.el.appendChild(h("p", { "class": "mc-err", text: it.err }));
  }
  function counts() {
    var done = items.filter(function (i) { return i.out && i.out.key === key() + "|" + i.start + "|" + i.end; }).length;
    $("#count").textContent = items.length ? done + " of " + items.length + " converted" : "";
    $("#zip").disabled = !items.some(function (i) { return i.out; }) || busy;
    $("#go").disabled = busy || !items.some(function (i) { return i.status === "ready" || i.status === "done"; });
    $("#clearAll").disabled = busy;
    if (!items.length) { $("#list").hidden = true; $("#drop").classList.remove("mc-compact"); }
  }
  function remove(it) {
    if (it.status === "working") { stopFlag = true; return; }
    items = items.filter(function (x) { return x !== it; }); it.el.remove(); counts();
  }
  function rowAction(it) {
    if (it.status === "working") { stopFlag = true; return; }
    if (it.out && it.out.key === key() + "|" + it.start + "|" + it.end) { S3.download(it.out.blob, it.out.name); S3.done(); return; }
    runAll([it]);
  }
  async function convert(it) {
    it.status = "working"; it.prog = 0; it.phase = "Decoding…"; paint(it);
    var k = key() + "|" + it.start + "|" + it.end, rate = o.rate;
    var buf = await decodeAt(await S3.readFile(it.file), rate);
    var chans = renderEdit(chansOf(buf), rate, { start: it.start, end: it.end, channels: o.channels, fadeIn: o.fadeIn, fadeOut: o.fadeOut, normalize: o.norm });
    buf = null;
    if (!chans[0].length) throw new Error("Nothing left after trimming");
    var blob;
    it.phase = "Encoding…"; paint(it);
    if (o.fmt === "wav") blob = encodeWAV(chans, rate);
    else blob = await encodeMp3(chans, rate, o.kbps, function (p) { it.prog = p; it.phase = "Encoding " + Math.round(p * 100) + "%"; paint(it); }, function () { return stopFlag; });
    var trimmed = it.start > 0 || it.end != null;
    it.out = { blob: blob, key: k, name: it.base + (trimmed ? "-trim" : "") + "." + o.fmt };
  }
  async function runAll(list) {
    if (busy) return;
    busy = true; stopFlag = false; counts(); items.forEach(paint);
    var made = 0;
    for (var i = 0; i < list.length && !stopFlag; i++) {
      var it = list[i];
      if (it.status === "error" || it.status === "reading") continue;
      if (it.out && it.out.key === key() + "|" + it.start + "|" + it.end) continue;
      try { await convert(it); made++; }
      catch (e) { if (!stopFlag) S3.toast("Couldn't convert " + it.name + (e && e.message === "Nothing left after trimming" ? ": nothing left after trimming" : ""), "error"); }
      it.status = "done"; it.prog = 0; paint(it); counts();
    }
    if (stopFlag) S3.toast("Stopped");
    busy = false; stopFlag = false; items.forEach(paint); counts();
    if (made) S3.done();
    if (made && list.length === 1 && list[0].out) S3.download(list[0].out.blob, list[0].out.name);
  }
  $("#go").addEventListener("click", function () { runAll(items.slice()); });
  $("#clearAll").addEventListener("click", function () { if (busy) return; items = []; $("#rows").textContent = ""; counts(); });
  $("#zip").addEventListener("click", async function () {
    var done = items.filter(function (i) { return i.out; }), used = {}, files = [];
    for (var i = 0; i < done.length; i++) {
      var n = done[i].out.name; while (used[n]) n = n.replace(/(\.\w+)$/, "-" + (used[n]++) + "$1"); used[n] = 1;
      files.push({ name: n, data: new Uint8Array(await done[i].out.blob.arrayBuffer()) });
    }
    S3.download(S3.zip(files), "converted-audio.zip"); S3.done();
  });
  syncOpts();

  // ---------- demo + self-test ----------
  function synth(secs, rate, notes, bpm, voice) {
    var n = Math.round(secs * rate), L = new Float32Array(n), R = new Float32Array(n), beatLen = 60 / bpm;
    for (var i = 0; i < n; i++) {
      var t = i / rate, beat = Math.floor(t / beatLen), ph = (t - beat * beatLen) / beatLen, f = notes[beat % notes.length];
      var env = voice ? (0.5 + 0.5 * Math.sin(t * 7)) * 0.35 : Math.exp(-ph * 3) * 0.5;
      var v = env * (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t));
      L[i] = v; R[i] = v * 0.85;
    }
    return [L, R];
  }
  window.S3_DEMO = async function () {
    o.fmt = "mp3"; o.kbps = 192; o.channels = 2; o.rate = 44100; o.fadeIn = 0; o.fadeOut = 1;
    $("#fadeOut").value = 1; $("#rate").value = "44100";
    [["fmt", "mp3"], ["kbps", "192"], ["chan", "2"]].forEach(function (p) { $$("#" + p[0] + " button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.v === p[1])); }); });
    syncOpts();
    var files = [
      new File([encodeWAV(synth(6, 44100, [262, 330, 392, 523], 120), 44100)], "holiday-video.wav", { type: "audio/wav" }),
      new File([encodeWAV(synth(4, 22050, [196, 247, 294], 90, true), 22050)], "voice-note.wav", { type: "audio/wav" }),
      new File([encodeWAV(synth(5, 44100, [440, 392, 349, 330], 140), 44100)], "podcast-intro.wav", { type: "audio/wav" })
    ];
    for (var i = 0; i < files.length; i++) await add(files[i]);
    items[2].start = 1; items[2].end = 4.5;
    await runAll(items.slice(0, 2));
    items.forEach(paint); counts();
  };

  function freqPeak(x, rate, lo, hi, step) { // brute-force DFT magnitude scan; returns the strongest frequency
    var best = 0, bestF = 0;
    for (var f = lo; f <= hi; f += step) {
      var re = 0, im = 0, w = 2 * Math.PI * f / rate;
      for (var i = 0; i < x.length; i++) { re += x[i] * Math.cos(w * i); im += x[i] * Math.sin(w * i); }
      var m = re * re + im * im; if (m > best) { best = m; bestF = f; }
    }
    return bestF;
  }
  window.S3_SELFTEST = async function () {
    var ok = parseTime("1:05.5") === 65.5 && parseTime("12,25") === 12.25 && isNaN(parseTime("x")) && fmtT(65) === "1:05" && fmtT(3723.5, true) === "1:02:03.500" &&
      effKbps(320, 22050) === 160 && effKbps(320, 44100) === 320;
    var ones = new Float32Array(1000).fill(1);
    var e = renderEdit([ones, new Float32Array(1000).fill(0.5)], 1000, { start: 0.1, end: 0.6, channels: 1, fadeIn: 0.1, gain: 1 })[0];
    ok = ok && e.length === 500 && e[0] === 0 && Math.abs(e[50] - 0.375) < 1e-6 && Math.abs(e[499] - 0.75) < 1e-6;
    var nrm = renderEdit([new Float32Array([0.1, -0.5, 0.25])], 1, { channels: 2, normalize: true });
    ok = ok && nrm.length === 2 && Math.abs(Math.abs(nrm[0][1]) - Math.pow(10, -1 / 20)) < 1e-6 && nrm[1][1] === nrm[0][1];
    if (!ok) return "helpers failed";
    // 1 s of 440 Hz -> MP3 -> decode again
    var rate = 44100, sine = new Float32Array(rate);
    for (var i = 0; i < rate; i++) sine[i] = 0.6 * Math.sin(2 * Math.PI * 440 * i / rate);
    var mp3 = new Uint8Array(await (await encodeMp3([sine], rate, 128)).arrayBuffer());
    var off = 0; if (mp3[0] === 0x49 && mp3[1] === 0x44 && mp3[2] === 0x33) off = 10 + ((mp3[6] << 21) | (mp3[7] << 14) | (mp3[8] << 7) | mp3[9]); // skip an ID3 tag if any
    if (!(mp3[off] === 0xFF && (mp3[off + 1] & 0xE0) === 0xE0)) return "no MP3 frame sync";
    if ((mp3[off + 1] & 0x18) !== 0x18 || (mp3[off + 1] & 0x06) !== 0x02) return "not MPEG-1 Layer III";
    var expect = 128 * 125; // bytes per second at 128 kbps
    if (Math.abs(mp3.length - expect) > expect * 0.15) return "size " + mp3.length + " not ≈ " + expect;
    var dec = await decodeAt(mp3.buffer.slice(0), rate);
    if (Math.abs(dec.duration - 1) > 0.08) return "decoded duration " + dec.duration;
    var d = dec.getChannelData(0), mid = d.subarray(Math.floor(rate * 0.3), Math.floor(rate * 0.3) + 4410);
    var f = freqPeak(mid, rate, 300, 600, 5);
    if (Math.abs(f - 440) > 5) return "dominant frequency " + f;
    var rms = Math.sqrt(mid.reduce(function (s, x) { return s + x * x; }, 0) / mid.length);
    if (Math.abs(rms - 0.6 / Math.SQRT2) > 0.05) return "level " + rms;
    // stereo at a low MPEG-2 rate also encodes and decodes
    var st = new Uint8Array(await (await encodeMp3([sine.subarray(0, 22050), sine.subarray(0, 22050)], 22050, 320)).arrayBuffer());
    if (!(st[0] === 0xFF && (st[1] & 0x18) === 0x10)) return "22.05 kHz stereo not MPEG-2";
    var dec2 = await decodeAt(st.buffer.slice(0), 22050);
    if (dec2.numberOfChannels !== 2 || Math.abs(dec2.duration - 1) > 0.1) return "stereo decode " + dec2.numberOfChannels + " " + dec2.duration;
    // WAV export header
    var wav = new Uint8Array(await encodeWAV([new Float32Array([0, 1])], 8000).arrayBuffer());
    return String.fromCharCode.apply(null, wav.subarray(0, 4)) === "RIFF" && wav.length === 48 && wav[46] === 0xFF && wav[47] === 0x7F;
  };
})();
