// Live voice mode: talk to Thinq out loud, hands-free.
//
//   listen  - the microphone records; the browser watches the sound level and decides when you've stopped talking
//             (about a second of quiet after speech). Nothing leaves the device until then.
//   hear    - that piece of audio goes to /api/transcribe?live=1 (Groq's free Whisper) and comes back as text.
//   think   - the text goes to /api/chat with channel "voice": the same Thinq with all its tools, told to answer
//             in a few short spoken sentences. One spoken exchange counts as one request.
//   speak   - the reply is read out with the free Cloudflare voice when the server has it, otherwise the device's
//             own voice. Never ElevenLabs (it bills per character).
//   ...and back to listening. Tap the orb to interrupt; with the server voice you can also just start talking.
//
// ctx: { state(), api(path, opts), timeZone, conversationId(), setConversation(id), openConversation(id), refresh(), notice(text, kind), icon(name, size) }

const SILENCE_MS = 950;       // quiet after speech that ends your turn
const MIN_SPEECH_MS = 280;    // shorter blips (a cough, a click) are ignored
const MAX_TURN_MS = 45_000;   // one turn is cut here
const IDLE_RESTART_MS = 14_000; // no speech for this long: start a fresh recording so it doesn't grow
const SILENT = "data:audio/wav;base64,UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";
// Whisper sometimes "hears" these in near-silence; treat them as nothing.
const PHANTOM = /^(thank(s| you)( (so much|very much))?( for watching)?|you|bye|okay|\.+|subtitles by .*|thanks for listening)[.!]?$/i;

export function createVoiceMode(ctx) {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let v = null; // the running session

  const recMime = () => ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || "";
  const supported = () => Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder && (window.AudioContext || window.webkitAudioContext));

  // ---------- the screen ----------
  function render() {
    const el = $("#voice");
    el.dataset.mode = v?.mode || "off";
    el.toggleAttribute("data-muted", Boolean(v?.muted));
    const label = { starting: "Starting…", listening: v?.muted ? "Microphone off" : "Listening", hearing: "Got it…", thinking: v?.status || "Thinking…", speaking: "Speaking", paused: "Paused", error: "Something went wrong" }[v?.mode] || "";
    $("#voiceState").textContent = label;
    $("#voiceHint").textContent =
      v?.mode === "speaking" ? (v.canBargeIn ? "Tap the orb or start talking to interrupt" : "Tap the orb to interrupt")
      : v?.mode === "listening" ? (v.muted ? "Tap the microphone to talk again" : "Talk whenever you're ready")
      : v?.mode === "paused" ? "Tap the orb to carry on" : "";
    $("#voiceMute").setAttribute("aria-pressed", String(Boolean(v?.muted)));
    $("#voiceMute").setAttribute("aria-label", v?.muted ? "Turn the microphone on" : "Turn the microphone off");
    $("#voiceMute").innerHTML = ctx.icon(v?.muted ? "i-mic-off" : "i-mic", 20);
  }
  function caption(who, text, extra = "") {
    const box = $("#voiceCaps");
    const line = document.createElement("p");
    line.className = `cap ${who}`;
    line.innerHTML = `<span>${who === "you" ? "You" : "Thinq"}</span>${esc(text)}${extra}`;
    box.append(line);
    while (box.children.length > 4) box.firstElementChild.remove();
    return line;
  }
  const setMode = (mode, status) => { if (!v) return; v.mode = mode; v.status = status; render(); };

  // ---------- start / stop ----------
  async function start() {
    if (v) return;
    if (!supported()) return ctx.notice("This browser can't do voice mode. Try Chrome, Edge or Safari.");
    v = { mode: "starting", muted: false, chunks: [], session: Symbol("voice") };
    $("#voice").hidden = false; document.body.classList.add("voice-on");
    $("#voiceCaps").innerHTML = "";
    render();
    // Unlock audio inside the tap (iPhone only allows sound that a tap started).
    v.player = new Audio(); v.player.playsInline = true; v.player.src = SILENT; v.player.play().catch(() => {});
    try { speechSynthesis?.speak(new SpeechSynthesisUtterance("")); } catch {}
    try {
      v.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch {
      stop(); return ctx.notice("Thinq couldn't use your microphone. Allow microphone access for this site and try again.");
    }
    if (!v) { return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    v.ac = new AC(); v.ac.resume?.();
    v.analyser = v.ac.createAnalyser(); v.analyser.fftSize = 1024;
    v.ac.createMediaStreamSource(v.stream).connect(v.analyser);
    v.buf = new Float32Array(v.analyser.fftSize);
    try { v.wake = await navigator.wakeLock?.request("screen"); } catch {}
    if (!ctx.conversationId()) {
      try { ctx.setConversation((await ctx.api("/api/conversations", { method: "POST" })).id); } catch (err) { stop(); return ctx.notice(err.message); }
    }
    v.convId = ctx.conversationId();
    calibrate();
  }

  function stop() {
    if (!v) return;
    const cur = v; v = null;
    cancelAnimationFrame(cur.raf); clearTimeout(cur.timer);
    try { cur.recorder?.state !== "inactive" && cur.recorder?.stop(); } catch {}
    cur.stream?.getTracks().forEach((t) => t.stop());
    cur.ac?.close().catch(() => {});
    cur.abort?.abort();
    stopSpeaking(cur);
    cur.wake?.release?.().catch(() => {});
    $("#voice").hidden = true; document.body.classList.remove("voice-on");
    $("#voice").style.removeProperty("--level");
    // Show the conversation that was just had, as a normal chat.
    if (cur.convId && cur.turns) ctx.openConversation(cur.convId).then(() => ctx.refresh()).catch(() => {});
  }

  // ---------- listening ----------
  const level = () => {
    v.analyser.getFloatTimeDomainData(v.buf);
    let sum = 0; for (const x of v.buf) sum += x * x;
    return Math.sqrt(sum / v.buf.length);
  };
  // Half a second of the room's own noise, to know what "quiet" is here.
  function calibrate() {
    const samples = [], t0 = performance.now();
    const tick = () => {
      if (!v) return;
      samples.push(level());
      if (performance.now() - t0 < 500) { v.raf = requestAnimationFrame(tick); return; }
      const floor = samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)] || 0.005;
      v.threshold = Math.min(0.08, Math.max(0.012, floor * 3));
      listen();
    };
    tick();
  }

  function listen() {
    if (!v) return;
    setMode("listening");
    if (v.muted) return;
    const type = recMime();
    const chunks = [];
    const rec = new MediaRecorder(v.stream, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: 32000 });
    v.recorder = rec;
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.start(250);
    const session = v.session;
    let speechStart = 0, lastLoud = 0, loudFor = 0;
    const began = performance.now();
    const tick = () => {
      if (!v || v.session !== session || v.recorder !== rec || v.mode !== "listening") return;
      const now = performance.now(), lv = level();
      $("#voice").style.setProperty("--level", Math.min(1, lv / (v.threshold * 6)).toFixed(3));
      if (lv > v.threshold) { loudFor += 16; lastLoud = now; if (!speechStart && loudFor > 90) speechStart = now - loudFor; }
      else loudFor = Math.max(0, loudFor - 8);
      const spoke = speechStart && lastLoud - speechStart > MIN_SPEECH_MS;
      if (spoke && now - lastLoud > SILENCE_MS) return finishTurn(rec, chunks, type);
      if (speechStart && now - speechStart > MAX_TURN_MS) return finishTurn(rec, chunks, type);
      if (!speechStart && now - began > IDLE_RESTART_MS) { rec.onstop = () => { if (v && v.recorder === rec) listen(); }; rec.stop(); return; }
      v.raf = requestAnimationFrame(tick);
    };
    v.raf = requestAnimationFrame(tick);
  }

  function finishTurn(rec, chunks, type) {
    setMode("hearing");
    $("#voice").style.setProperty("--level", "0");
    rec.onstop = () => hear(new Blob(chunks, { type: rec.mimeType || type || "audio/webm" }));
    rec.stop();
  }

  // ---------- hearing + thinking ----------
  async function hear(blob) {
    if (!v) return;
    const session = v.session;
    let text = "";
    try {
      const res = await fetch("/api/transcribe?live=1", { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
      if (res.status === 401) { location.href = "/login.html"; return; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 400) return v?.session === session && listen(); // too short / nothing heard: just keep listening
        throw new Error(data.error || "Couldn't hear that.");
      }
      text = String(data.text || "").trim();
    } catch (err) { return fail(err.message); }
    if (!v || v.session !== session) return;
    if (!text || PHANTOM.test(text)) return listen();
    caption("you", text);
    think(text);
  }

  async function think(text) {
    setMode("thinking", "Thinking…");
    const session = v.session, abort = (v.abort = new AbortController());
    let reply = null;
    try {
      const res = await fetch("/api/chat", { method: "POST", signal: abort.signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: v.convId, text, timeZone: ctx.timeZone, channel: "voice" }) });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || "Thinq couldn't answer that.");
      const reader = res.body.getReader(), dec = new TextDecoder(); let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          if (!chunk.startsWith("data: ")) continue;
          const ev = JSON.parse(chunk.slice(6));
          if (ev.type === "status" && v?.session === session) setMode("thinking", `${ev.text}…`);
          else if (ev.type === "reply") reply = ev;
          else if (ev.type === "error") throw new Error(ev.text);
        }
      }
    } catch (err) {
      if (err.name === "AbortError") return;
      return fail(err.message);
    }
    if (!v || v.session !== session || !reply) return;
    v.turns = (v.turns || 0) + 1;
    const waiting = (reply.approvals || []).filter((a) => a?.status === "pending").length;
    caption("thinq", plain(reply.text), waiting ? ` <button class="voice-chip" data-voice-approvals>${waiting === 1 ? "1 draft waiting for your OK" : `${waiting} drafts waiting for your OK`}</button>` : "");
    speak(plain(reply.text));
  }

  // Markdown -> words for the voice.
  const plain = (t) => String(t || "")
    .replace(/```[\s\S]*?```/g, " ").replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/https?:\/\/\S+/g, "a link")
    .replace(/^\s*[-*•]\s+/gm, "").replace(/^\s*#+\s*/gm, "").replace(/[*_~>#|]/g, "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/\n{2,}/g, ". ").replace(/\s+/g, " ").replace(/\s+([.,!?])/g, "$1").replace(/\.{2,}/g, ".").trim();

  // ---------- speaking ----------
  async function speak(text) {
    if (!v || !text) return listen();
    const session = v.session;
    setMode("speaking");
    const done = () => { if (v && v.session === session && v.mode === "speaking") { stopSpeaking(v); listen(); } };
    const st = ctx.state() || {};
    if (st.liveVoice?.freeVoice && !v.serverVoiceOff) {
      try {
        const res = await fetch("/api/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, live: true }) });
        if (!res.ok) throw Object.assign(new Error("server voice unavailable"), { off: true });
        const url = URL.createObjectURL(await res.blob());
        if (!v || v.session !== session || v.mode !== "speaking") { URL.revokeObjectURL(url); return; }
        v.canBargeIn = true; render(); // the page's own audio is removed by echo cancellation, so talking over it works
        v.player.onended = () => { URL.revokeObjectURL(url); done(); };
        v.player.onerror = () => { URL.revokeObjectURL(url); speakWithDevice(text, session, done); };
        v.player.src = url;
        await v.player.play();
        watchForBargeIn(session);
        return;
      } catch (err) {
        if (err.off) v.serverVoiceOff = true; // use the device's voice for the rest of this session
      }
    }
    speakWithDevice(text, session, done);
  }

  function pickVoice() {
    const all = speechSynthesis.getVoices().filter((x) => /^en/i.test(x.lang));
    const pref = [/Ava|Samantha|Zoe|Allison|Serena/i, /Google US English|Google UK English Female/i, /Natural|Neural|Premium|Enhanced/i];
    for (const re of pref) { const hit = all.find((x) => re.test(x.name)); if (hit) return hit; }
    return all.find((x) => x.default) || all[0] || null;
  }
  function speakWithDevice(text, session, done) {
    if (!("speechSynthesis" in window)) return done();
    v.canBargeIn = false; render(); // the device voice isn't removed by echo cancellation: tap to interrupt instead
    // Short sentences, one after another (long utterances get cut off in some browsers).
    const parts = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
    const voice = pickVoice();
    let i = 0;
    const next = () => {
      if (!v || v.session !== session || v.mode !== "speaking") return;
      if (i >= parts.length) return done();
      const u = new SpeechSynthesisUtterance(parts[i++].trim());
      if (voice) u.voice = voice;
      u.rate = 1.04;
      u.onend = next; u.onerror = next;
      speechSynthesis.speak(u);
    };
    speechSynthesis.cancel();
    next();
  }
  function stopSpeaking(cur = v) {
    if (!cur) return;
    try { cur.player && (cur.player.onended = cur.player.onerror = null, cur.player.pause()); } catch {}
    try { speechSynthesis.cancel(); } catch {}
  }
  // While the server voice plays: if you start talking, Thinq stops and listens.
  function watchForBargeIn(session) {
    let loudFor = 0;
    const tick = () => {
      if (!v || v.session !== session || v.mode !== "speaking") return;
      const lv = level();
      $("#voice").style.setProperty("--level", (0.35 + 0.25 * Math.sin(performance.now() / 180)).toFixed(3));
      if (!v.muted && lv > Math.max(0.05, v.threshold * 4)) loudFor += 16; else loudFor = Math.max(0, loudFor - 10);
      if (loudFor > 320) { interrupt(); return; }
      v.raf = requestAnimationFrame(tick);
    };
    v.raf = requestAnimationFrame(tick);
  }
  function interrupt() {
    if (!v) return;
    if (v.mode === "speaking") { stopSpeaking(); listen(); }
    else if (v.mode === "thinking") { v.abort?.abort(); listen(); }
    else if (v.mode === "paused") resume();
  }
  // After the app was in the background the phone may have closed the microphone: get a fresh one.
  async function resume() {
    if (!v) return;
    v.ac?.resume?.();
    if (!v.stream?.getAudioTracks().some((t) => t.readyState === "live")) {
      try {
        v.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        v.ac.createMediaStreamSource(v.stream).connect(v.analyser);
      } catch { return fail("Thinq couldn't use your microphone. Allow microphone access and tap the orb again."); }
    }
    listen();
  }

  function fail(message) {
    if (!v) return;
    caption("thinq", message);
    setMode("paused");
  }

  // ---------- controls ----------
  $("#voiceOrb").addEventListener("click", () => {
    if (!v) return;
    if (v.mode === "listening" && v.muted) { v.muted = false; listen(); return; }
    interrupt();
  });
  $("#voiceMute").addEventListener("click", () => {
    if (!v) return;
    v.muted = !v.muted;
    if (v.muted && v.mode === "listening") { cancelAnimationFrame(v.raf); try { v.recorder.onstop = null; v.recorder.stop(); } catch {} v.recorder = null; $("#voice").style.setProperty("--level", "0"); render(); }
    else if (!v.muted && v.mode === "listening") listen();
    else render();
  });
  $("#voiceEnd").addEventListener("click", stop);
  $("#voice").addEventListener("click", (e) => { if (e.target.closest("[data-voice-approvals]")) { stop(); ctx.showApprovals?.(); } });
  document.addEventListener("keydown", (e) => { if (v && e.key === "Escape") stop(); });
  // Phones stop the microphone when the app goes to the background: pause, and carry on when it's back.
  document.addEventListener("visibilitychange", () => {
    if (!v) return;
    if (document.visibilityState === "hidden") { stopSpeaking(); v.abort?.abort(); cancelAnimationFrame(v.raf); try { v.recorder?.stop(); } catch {} setMode("paused"); }
  });

  return { start, stop, supported, active: () => Boolean(v) };
}
