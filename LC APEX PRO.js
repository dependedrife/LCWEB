// ==UserScript==
// @name         Lightcord Pro (Apex Edition - Switch Fix)
// @namespace    http://tampermonkey.net/
// @version      3.3
// @description  Filterless ultra-raw stereo Opus pipeline with intelligent peer connection recycling, zero-phase delay, 10-band EQ, pro compressor suite, and collapsible start-minimized UI.
// @author       Skenzo discord.gg/lightcord (Apex Upgraded & Switch-Fix)
// @match        *://*.discord.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
'use strict';

const CFG = Object.freeze({
  mic: Object.freeze({
    channelCount:     { ideal: 2 },
    sampleRate:       { ideal: 48000 },
    sampleSize:       { ideal: 24 },
    echoCancellation: { exact: false },
    noiseSuppression: { exact: false },
    autoGainControl:  { exact: false },
  }),
  opus: Object.freeze({
    stereo:            '1',
    'sprop-stereo':    '1',
    maxaveragebitrate: '384000',
    maxplaybackrate:   '48000',
    usedtx:            '0',
    useinbandfec:      '0',
    minptime:          '10',
    ptime:             '20',
  }),
  bitrate: 384000,
  blocklist: ['krisp', 'noise', 'suppression'],
  eq: Object.freeze([
    { freq:    31, gain: 0, q: 1.4 },
    { freq:    62, gain: 0, q: 1.4 },
    { freq:   125, gain: 0, q: 1.4 },
    { freq:   250, gain: 0, q: 1.4 },
    { freq:   500, gain: 0, q: 1.4 },
    { freq:  1000, gain: 0, q: 1.4 },
    { freq:  2000, gain: 0, q: 1.4 },
    { freq:  4000, gain: 0, q: 1.4 },
    { freq:  8000, gain: 0, q: 1.4 },
    { freq: 16000, gain: 0, q: 1.4 },
  ]),
});

const State = new class {
  #live      = null;
  #processed = null;
  #sym       = Symbol('dsm-pro');

  setRaw(track)       { this.#live = track; }
  getRaw()            { return this.#live; }
  setProcessed(track) { this.#processed = track; }
  getProcessed()      { return this.#processed; }
  outbound()          { return this.#processed ?? this.#live; }
  key()               { return this.#sym; }
  active()            { return this.outbound()?.readyState === 'live'; }
  foreign(t)          { return t?.kind === 'audio' && this.active() && t.id !== this.outbound().id; }
};

class SDPEditor {
  static #RTPMAP = /^a=rtpmap:(\d+)\s+opus\/48000\/2/gm;
  static #FMTP   = (pt) => new RegExp(`^a=fmtp:${pt}\\s+(.*)$`, 'm');

  static #decode(str) {
    return Object.fromEntries(
      str.split(';').flatMap(p => {
        const [k, ...v] = p.trim().split('=');
        return k ? [[k.trim(), v.join('=').trim()]] : [];
      })
    );
  }

  static #encode(map) {
    return Object.entries(map).map(([k, v]) => `${k}=${v}`).join(';');
  }

  static #opusPTs(sdp) {
    const pts = new Set();
    let m;
    const re = new RegExp(SDPEditor.#RTPMAP.source, 'gm');
    while ((m = re.exec(sdp)) !== null) pts.add(m[1]);
    return [...pts];
  }

  static #rewriteFmtp(sdp, pt) {
    const re = SDPEditor.#FMTP(pt);
    const match = re.exec(sdp);
    if (!match) return sdp;
    const remote = SDPEditor.#decode(match[1]);
    delete remote.cbr;
    delete remote.usedtx;
    const merged = { ...remote, ...CFG.opus };
    return sdp.replace(match[0], `a=fmtp:${pt} ${SDPEditor.#encode(merged)}`);
  }

  static #stripCaps(sdp) {
    return sdp.replace(/^b=AS:\d+\r?\n?/gm, '').replace(/^b=TIAS:\d+\r?\n?/gm, '');
  }

  static process(sdp) {
    if (typeof sdp !== 'string') return sdp;
    return SDPEditor.#stripCaps(
      SDPEditor.#opusPTs(sdp).reduce(SDPEditor.#rewriteFmtp.bind(SDPEditor), sdp)
    );
  }
}

class BitrateLayer {
  static #pcs = new Set();

  static #encoding(enc = {}) {
    const out = { ...enc, active: true, dtx: 'disabled', ptime: 20, priority: 'high', networkPriority: 'high' };
    delete out.minBitrate;
    if (out.maxBitrate != null && out.maxBitrate < CFG.bitrate) out.maxBitrate = CFG.bitrate;
    else if (out.maxBitrate == null) out.maxBitrate = CFG.bitrate;
    return out;
  }

  static encodings(encs) {
    return (encs ?? [{}]).map(e => BitrateLayer.#encoding(e));
  }

  static apply(sender) {
    if (sender?.track?.kind !== 'audio') return;
    try {
      const p = sender.getParameters();
      p.encodings = (p.encodings?.length ? p.encodings : [{}]).map(BitrateLayer.#encoding);
      sender.setParameters(p);
      TrackLayer.purify(sender.track);
    } catch (_) {}
  }

  static track(pc) {
    BitrateLayer.#pcs.add(pc);
    
    // Safety check: close stale connections instantly if a new instance spins up during channel hops
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
        BitrateLayer.#pcs.delete(pc);
      } else if (pc.connectionState === 'connected') {
        // Close other lingering active connections to prevent DTLS collision locks
        for (const activePC of BitrateLayer.#pcs) {
          if (activePC !== pc && activePC.connectionState !== 'closed') {
            try { activePC.close(); } catch (_) {}
            BitrateLayer.#pcs.delete(activePC);
          }
        }
        pc.getSenders().forEach(s => BitrateLayer.apply(s));
      }
    });
  }

  static install() {
    const Orig = RTCPeerConnection;
    const wrapped = function (...args) {
      // Forcefully clean up any dangling connections prior to instantiating a new channel session
      for (const pc of BitrateLayer.#pcs) {
        if (pc.connectionState !== 'closed') {
          try { pc.close(); } catch (_) {}
        }
      }
      BitrateLayer.#pcs.clear();

      const pc = new Orig(...args);
      BitrateLayer.track(pc);
      return pc;
    };
    wrapped.prototype = Orig.prototype;
    Object.setPrototypeOf(wrapped, Orig);
    window.RTCPeerConnection = wrapped;
  }
}

class TrackLayer {
  static #clean = Object.freeze({
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl:  false,
  });

  static purify(track) {
    if (!track || track.kind !== 'audio') return;
    try { track.contentHint = 'music'; } catch (_) {}
    track.applyConstraints(TrackLayer.#clean).catch(() => {});
  }

  static install() {
    Interceptor.async_(MediaStreamTrack.prototype, 'applyConstraints', async (o, c) => {
      if (this.kind !== 'audio') return o(c);
      const clean = { ...c, ...TrackLayer.#clean };
      if (Array.isArray(c?.advanced))
        clean.advanced = c.advanced.map(a => ({ ...a, ...TrackLayer.#clean }));
      return o(clean);
    });
  }
}

class Interceptor {
  static #wrap(target, key, builder) {
    const original = target[key];
    if (!original) return;
    const replacement = builder(original);
    replacement.toString = () => original.toString();
    target[key] = replacement;
  }

  static async_(target, key, builder) {
    Interceptor.#wrap(target, key, (orig) =>
      function (...args) { return builder(orig.bind(this), ...args); }
    );
  }

  static sync(target, key, builder) {
    Interceptor.#wrap(target, key, (orig) =>
      function (...args) { return builder.call(this, orig.bind(this), ...args); }
    );
  }
}

const sdpDesc    = (orig, desc) => orig(desc?.sdp ? { type: desc.type, sdp: SDPEditor.process(desc.sdp) } : desc);
const sdpResult  = async (orig, ...args) => { const r = await orig(...args); return { type: r.type, sdp: SDPEditor.process(r.sdp) }; };

class MicLayer {
  static install() {
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (constraints) => {
      if (!constraints?.audio) return gum(constraints);
      const deviceId = constraints.audio?.deviceId;
      const audio = { ...CFG.mic, ...(deviceId ? { deviceId } : {}) };
      return gum({ ...constraints, audio }).then(stream => {
        const t = stream.getAudioTracks()[0];
        if (t) {
          State.setRaw(t);
          TrackLayer.purify(t);
          const ctx = AudioPipelineLayer.getContext();
          if (ctx.state === 'suspended') ctx.resume();
          const src = ctx.createMediaStreamSource(new MediaStream([t]));
          AudioPipelineLayer.connectMicSource(src);
        }
        return stream;
      });
    };
  }
}

class AudioPipelineLayer {
  static #ctx       = null;
  static #nodes     = {};
  static #bands     = [];
  static #ready     = false;
  static #leftMs    = 0;
  static #rightMs   = 0;
  static #compActive = false;

  static install() {
    AudioPipelineLayer.#boot();
  }

  static #knobToSeconds(leftKnob, rightKnob) {
    let dL = 0, dR = 0;
    if (leftKnob >= 0) dL += leftKnob;
    else dR += -leftKnob;
    if (rightKnob >= 0) dR += rightKnob;
    else dL += -rightKnob;
    return [dL / 1000, dR / 1000];
  }

  static #applyStereoDelay() {
    const { delayL, delayR, crossFeed } = AudioPipelineLayer.#nodes;
    if (!delayL || !delayR) return;
    const [dL, dR] = AudioPipelineLayer.#knobToSeconds(
      AudioPipelineLayer.#leftMs,
      AudioPipelineLayer.#rightMs
    );
    
    const now = AudioPipelineLayer.#ctx.currentTime;
    delayL.delayTime.setTargetAtTime(dL, now, 0.005);
    delayR.delayTime.setTargetAtTime(dR, now, 0.005);

    if (crossFeed) {
      const activeOffset = Math.abs(AudioPipelineLayer.#leftMs) + Math.abs(AudioPipelineLayer.#rightMs);
      crossFeed.gain.setTargetAtTime(activeOffset > 0 ? 0.15 : 0.0, now, 0.01);
    }
  }

  static #boot() {
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    AudioPipelineLayer.#ctx = ctx;

    const masterGain = ctx.createGain();
    const splitter   = ctx.createChannelSplitter(2);
    const merger     = ctx.createChannelMerger(2);
    const delayL     = ctx.createDelay(0.1);
    const delayR     = ctx.createDelay(0.1);
    
    const crossFeed  = ctx.createGain();
    const phaseInver = ctx.createGain();
    phaseInver.gain.value = -0.20;

    const micMix     = ctx.createGain();
    const musicMix   = ctx.createGain();
    const mixer      = ctx.createGain();
    
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -12.0;
    compressor.knee.value      = 6.0;
    compressor.ratio.value     = 4.0;
    compressor.attack.value    = 0.003;
    compressor.release.value   = 0.250;

    const compBypass = ctx.createGain();
    compBypass.gain.value = 1.0;
    const compActiveGain = ctx.createGain();
    compActiveGain.gain.value = 0.0;

    const dest       = ctx.createMediaStreamDestination();
    dest.channelCount          = 2;
    dest.channelCountMode      = 'explicit';
    dest.channelInterpretation = 'discrete';

    micMix.gain.value = 1;
    musicMix.gain.value = 1;
    masterGain.gain.value = 1;
    crossFeed.gain.value = 0.0;

    const bands = CFG.eq.map(({ freq, gain, q }) => {
      const f = ctx.createBiquadFilter();
      f.type      = 'peaking';
      f.frequency.value = freq;
      f.gain.value      = gain;
      f.Q.value         = q;
      return { node: f, enabled: true, defaultGain: gain };
    });

    AudioPipelineLayer.#bands = bands;

    const chain = [...bands.map(b => b.node), masterGain];
    chain.reduce((a, b) => { a.connect(b); return b; }, mixer);
    
    masterGain.connect(splitter);
    
    splitter.connect(delayL, 0);
    splitter.connect(delayR, 1);
    
    delayL.connect(merger, 0, 0);
    delayR.connect(merger, 0, 1);

    splitter.connect(crossFeed, 0, 0);
    crossFeed.connect(phaseInver);
    phaseInver.connect(merger, 0, 0);
    phaseInver.connect(merger, 0, 1);

    merger.connect(compBypass);
    merger.connect(compressor);
    compressor.connect(compActiveGain);

    compBypass.connect(dest);
    compActiveGain.connect(dest);

    micMix.connect(mixer);
    musicMix.connect(mixer);

    AudioPipelineLayer.#nodes = {
      ctx, masterGain, splitter, merger, delayL, delayR,
      crossFeed, micMix, musicMix, mixer, compressor, compBypass, compActiveGain, dest,
    };
    AudioPipelineLayer.#ready = true;
    AudioPipelineLayer.#applyStereoDelay();

    const outTrack = dest.stream.getAudioTracks()[0];
    TrackLayer.purify(outTrack);
    State.setProcessed(outTrack);
  }

  static #assertReady() {
    if (!AudioPipelineLayer.#ready) throw new Error('AudioPipelineLayer not ready');
  }

  static getContext()  { return AudioPipelineLayer.#ctx; }
  static getNodes()    { return AudioPipelineLayer.#nodes; }

  static connectMicSource(sourceNode) {
    sourceNode.connect(AudioPipelineLayer.#nodes.micMix);
  }

  static connectMusicSource(sourceNode) {
    sourceNode.connect(AudioPipelineLayer.#nodes.musicMix);
  }

  static setBand(index, gain) {
    AudioPipelineLayer.#assertReady();
    const band = AudioPipelineLayer.#bands[index];
    if (!band) return;
    band.node.gain.value = band.enabled ? gain : 0;
    band.defaultGain = gain;
  }

  static enableBand(index, bool) {
    AudioPipelineLayer.#assertReady();
    const band = AudioPipelineLayer.#bands[index];
    if (!band) return;
    band.enabled = bool;
    band.node.gain.value = bool ? band.defaultGain : 0;
  }

  static setMasterGain(value) {
    AudioPipelineLayer.#assertReady();
    AudioPipelineLayer.#nodes.masterGain.gain.value = value;
  }

  static setCompressorEnabled(active) {
    AudioPipelineLayer.#assertReady();
    AudioPipelineLayer.#compActive = active;
    const { compBypass, compActiveGain } = AudioPipelineLayer.#nodes;
    const now = AudioPipelineLayer.#ctx.currentTime;
    if (active) {
      compBypass.gain.setTargetAtTime(0.0, now, 0.01);
      compActiveGain.gain.setTargetAtTime(1.0, now, 0.01);
    } else {
      compBypass.gain.setTargetAtTime(1.0, now, 0.01);
      compActiveGain.gain.setTargetAtTime(0.0, now, 0.01);
    }
  }

  static setCompressorParam(paramName, value) {
    AudioPipelineLayer.#assertReady();
    const comp = AudioPipelineLayer.#nodes.compressor;
    if (!comp || comp[paramName] == null) return;
    comp[paramName].value = value;
  }

  static resetAll() {
    AudioPipelineLayer.#assertReady();
    AudioPipelineLayer.#nodes.masterGain.gain.value = 1;
    AudioPipelineLayer.#nodes.micMix.gain.value = 1;
    AudioPipelineLayer.#nodes.musicMix.gain.value = 1;
    AudioPipelineLayer.#leftMs = 0;
    AudioPipelineLayer.#rightMs = 0;
    AudioPipelineLayer.setCompressorEnabled(false);
    AudioPipelineLayer.#applyStereoDelay();
    AudioPipelineLayer.resetEQ();
  }

  static resetEQ() {
    AudioPipelineLayer.#bands.forEach((b, i) => {
      b.defaultGain = CFG.eq[i].gain;
      b.node.gain.value = b.enabled ? CFG.eq[i].gain : 0;
    });
  }

  static muteMic(muted) {
    AudioPipelineLayer.#assertReady();
    AudioPipelineLayer.#nodes.micMix.gain.value = muted ? 0 : 1;
  }

  static setMusicVolume(value) {
    AudioPipelineLayer.#assertReady();
    AudioPipelineLayer.#nodes.musicMix.gain.value = value;
  }

  static setStereoDelay(leftMs, rightMs) {
    AudioPipelineLayer.#assertReady();
    AudioPipelineLayer.#leftMs  = Math.max(-15, Math.min(25, leftMs));
    AudioPipelineLayer.#rightMs = Math.max(-15, Math.min(25, rightMs));
    AudioPipelineLayer.#applyStereoDelay();
  }
}

class LocalAudioLayer {
  static #el      = null;
  static #srcNode = null;
  static #gainNode= null;
  static #muted   = false;
  static #volume  = 1;

  static install() {
    LocalAudioLayer.#setup();
  }

  static #setup() {
    const ctx  = AudioPipelineLayer.getContext();
    const gain = ctx.createGain();
    gain.gain.value = LocalAudioLayer.#volume;
    AudioPipelineLayer.connectMusicSource(gain);
    LocalAudioLayer.#gainNode = gain;

    const el = new Audio();
    el.crossOrigin = 'anonymous';
    el.loop        = false;
    LocalAudioLayer.#el = el;

    const srcNode = ctx.createMediaElementSource(el);
    srcNode.connect(gain);
    LocalAudioLayer.#srcNode = srcNode;
  }

  static loadFile(file) {
    const url = URL.createObjectURL(file);
    LocalAudioLayer.#el.src = url;
    LocalAudioLayer.#el.load();
  }

  static play()         { LocalAudioLayer.#el?.play(); }
  static pause()        { LocalAudioLayer.#el?.pause(); }
  static stop()         { const el = LocalAudioLayer.#el; if (!el) return; el.pause(); el.currentTime = 0; }
  static seek(seconds)  { if (LocalAudioLayer.#el) LocalAudioLayer.#el.currentTime = seconds; }
  static setLoop(bool)  { if (LocalAudioLayer.#el) LocalAudioLayer.#el.loop = bool; }
  static isPlaying()    { return LocalAudioLayer.#el ? !LocalAudioLayer.#el.paused : false; }
  static currentTime()  { return LocalAudioLayer.#el?.currentTime ?? 0; }
  static duration()     { return LocalAudioLayer.#el?.duration ?? 0; }

  static setMusicVolume(value) {
    LocalAudioLayer.#volume = value;
    if (LocalAudioLayer.#gainNode) LocalAudioLayer.#gainNode.gain.value = value;
    AudioPipelineLayer.setMusicVolume(value);
  }

  static muteMusic(bool) {
    LocalAudioLayer.#muted = bool;
    if (LocalAudioLayer.#gainNode)
      LocalAudioLayer.#gainNode.gain.value = bool ? 0 : LocalAudioLayer.#volume;
  }

  static reset() {
    LocalAudioLayer.stop();
    LocalAudioLayer.setLoop(false);
    LocalAudioLayer.#muted = false;
    LocalAudioLayer.#volume = 1;
    if (LocalAudioLayer.#gainNode) LocalAudioLayer.#gainNode.gain.value = 1;
    if (LocalAudioLayer.#el) {
      LocalAudioLayer.#el.src = '';
      LocalAudioLayer.#el.load();
    }
    AudioPipelineLayer.setMusicVolume(1);
  }
}

class RTCLayer {
  static #PC  = RTCPeerConnection.prototype;
  static #RTP = RTCRtpSender.prototype;

  static install() {
    RTCLayer.#sdp();
    RTCLayer.#tracks();
    RTCLayer.#encoding();
  }

  static #sdp() {
    Interceptor.sync(RTCLayer.#PC, 'setLocalDescription',  (o, d) => sdpDesc(o, d));
    Interceptor.sync(RTCLayer.#PC, 'setRemoteDescription', (o, d) => sdpDesc(o, d));
    Interceptor.async_(RTCLayer.#PC, 'createOffer',  sdpResult);
    Interceptor.async_(RTCLayer.#PC, 'createAnswer', sdpResult);
  }

  static #tracks() {
    const orig = RTCLayer.#PC.addTrack;
    RTCLayer.#PC.addTrack = function (track, ...streams) {
      if (State.foreign(track)) track = State.outbound();
      const sender = orig.call(this, track, ...streams);
      BitrateLayer.apply(sender);
      return sender;
    };
    RTCLayer.#PC.addTrack.toString = () => orig.toString();

    Interceptor.async_(RTCLayer.#RTP, 'replaceTrack', async (o, t) => {
      const track = State.foreign(t) ? State.outbound() : t;
      const r = await o(track);
      BitrateLayer.apply(this);
      return r;
    });
  }

  static #encoding() {
    Interceptor.sync(RTCLayer.#PC, 'addTransceiver', function (o, tk, init = {}) {
      if (tk === 'audio' || tk?.kind === 'audio')
        init = { ...init, sendEncodings: BitrateLayer.encodings(init.sendEncodings) };
      const tr = o(tk, init);
      if (tk === 'audio' || tk?.kind === 'audio') BitrateLayer.apply(tr.sender);
      return tr;
    });

    Interceptor.sync(RTCLayer.#RTP, 'setParameters', function (o, p) {
      if (p?.encodings && this.track?.kind === 'audio')
        p = { ...p, encodings: BitrateLayer.encodings(p.encodings) };
      return o(p);
    });
  }
}

class WorkletLayer {
  static install() {
    const proto = AudioWorklet?.prototype;
    if (!proto?.addModule) return;
    Interceptor.async_(proto, 'addModule', (o, url, ...rest) => {
      const u = String(url);
      if (CFG.blocklist.some(w => u.includes(w))) return Promise.resolve();
      return o(url, ...rest);
    });
  }
}

class AudioCtxLayer {
  static #stereoize(node) {
    try {
      node.channelCount          = 2;
      node.channelCountMode      = 'explicit';
      node.channelInterpretation = 'discrete';
    } catch (_) {}
    return node;
  }

  static install() {
    const proto = AudioContext.prototype;
    Interceptor.sync(proto, 'createMediaStreamSource', (o, s) =>
      AudioCtxLayer.#stereoize(o(s))
    );
    Interceptor.sync(proto, 'createMediaStreamDestination', (o) =>
      AudioCtxLayer.#stereoize(o())
    );
  }
}

[BitrateLayer, MicLayer, TrackLayer, AudioPipelineLayer, LocalAudioLayer, RTCLayer, WorkletLayer, AudioCtxLayer]
  .forEach(m => m.install());

// ── Floating Control Panel (Apex Edition - Minimized on Start) ─────────────────
const UI = new class {
  #el       = null;
  #dragging = false;
  #dx = 0; #dy = 0;
  #micMuted = false;
  #musicMuted = false;
  #minimized = true;

  build() {
    const s = document.createElement('style');
    s.textContent = `
      #dsm-panel{position:fixed;top:60px;right:16px;z-index:2147483647;width:320px;
        background:#111318;border:1px solid #2a2d36;border-radius:10px;
        font:12px/1.4 'gg sans','Noto Sans',sans-serif;color:#ccc;
        box-shadow:0 8px 32px #000a;user-select:none;transition:height 0.2s ease;}
      #dsm-panel.minimized .dsm-body{display:none;}
      #dsm-panel h2{margin:0;padding:10px 14px;font-size:11px;font-weight:700;
        letter-spacing:1px;text-transform:uppercase;color:#7289da;
        border-bottom:1px solid #1e2029;cursor:move;display:flex;justify-content:space-between;align-items:center;}
      #dsm-panel.minimized h2{border-bottom:none;}
      #dsm-panel h2 .header-right{display:flex;align-items:center;gap:8px;}
      #dsm-panel h2 span.badge{font-size:9px;color:#555;font-weight:400;letter-spacing:0}
      #dsm-panel h2 button.min-btn{background:none;border:none;color:#7289da;cursor:pointer;font-weight:bold;font-size:13px;padding:0 2px;}
      #dsm-panel section{padding:10px 14px;border-bottom:1px solid #1e2029;}
      #dsm-panel label{display:flex;justify-content:space-between;align-items:center;
        gap:8px;margin-bottom:6px;font-size:11px;color:#aaa;}
      #dsm-panel input[type=range]{flex:1;accent-color:#7289da;height:3px;cursor:pointer;}
      #dsm-panel input[type=number]{width:72px;background:#1a1d24;border:1px solid #2a2d36;
        border-radius:4px;color:#fff;font-size:11px;padding:2px 6px;text-align:right;}
      #dsm-panel input[type=number]:focus{outline:none;border-color:#7289da;}
      #dsm-panel .row{display:flex;gap:6px;align-items:center;margin-bottom:6px;}
      #dsm-panel .mute{padding:2px 8px;border-radius:4px;border:1px solid #2a2d36;
        background:#1a1d24;color:#aaa;font-size:10px;cursor:pointer;}
      #dsm-panel .mute.on{background:#7289da22;border-color:#7289da;color:#7289da;}
      #dsm-panel .eq-grid{display:grid;grid-template-columns:repeat(10,1fr);gap:4px;align-items:end;height:120px;}
      #dsm-panel .eq-col{display:flex;flex-direction:column;align-items:center;gap:3px;height:100%;}
      #dsm-panel .eq-col input[type=range]{writing-mode:vertical-lr;direction:rtl;
        flex:1;width:16px;accent-color:#7289da;cursor:pointer;}
      #dsm-panel .eq-col span{font-size:8px;color:#555;white-space:nowrap;}
      #dsm-panel .eq-col .eq-val{font-size:8px;color:#7289da;min-width:24px;text-align:center;}
      #dsm-panel .sec-head{display:flex;justify-content:space-between;align-items:center;
        margin-bottom:8px;}
      #dsm-panel .sec-head span{font-weight:600;color:#7289da;font-size:10px;letter-spacing:.5px;}
      #dsm-panel .reset-sm{padding:2px 8px;border-radius:4px;border:1px solid #2a2d36;
        background:#1a1d24;color:#aaa;font-size:9px;cursor:pointer;flex-shrink:0;}
      #dsm-panel .reset-sm:hover{border-color:#7289da;color:#7289da;}
      #dsm-panel .reset{width:100%;padding:4px;background:#1a1d24;border:1px solid #2a2d36;
        border-radius:4px;color:#aaa;font-size:10px;cursor:pointer;margin-top:4px;}
      #dsm-panel .reset:hover{border-color:#7289da;color:#7289da;}
      #dsm-panel .player{display:flex;flex-direction:column;gap:6px;}
      #dsm-panel .player-title{font-size:10px;color:#7289da;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center;padding:2px 0;}
      #dsm-panel .player-btns{display:flex;gap:4px;justify-content:center;}
      #dsm-panel .pb{padding:4px 10px;border-radius:4px;border:1px solid #2a2d36;background:#1a1d24;
        color:#ccc;font-size:11px;cursor:pointer;transition:border-color .15s,color .15s;}
      #dsm-panel .pb:hover{border-color:#7289da;color:#7289da;}
      #dsm-panel .pb.active{background:#7289da22;border-color:#7289da;color:#7289da;}
      #dsm-panel .player-seek{display:flex;align-items:center;gap:6px;font-size:9px;color:#555;}
      #dsm-panel .player-seek input{flex:1;accent-color:#7289da;height:3px;cursor:pointer;}
      #dsm-panel .player-file{display:none;}
      #dsm-panel .pick-file{width:100%;padding:4px;background:#1a1d24;border:1px solid #2a2d36;
        border-radius:4px;color:#aaa;font-size:10px;cursor:pointer;text-align:center;}
      #dsm-panel .pick-file:hover{border-color:#7289da;color:#7289da;}
    `;
    document.head.appendChild(s);

    const p = document.createElement('div');
    p.id = 'dsm-panel';
    p.className = 'minimized';
    p.innerHTML = `
      <h2>
        <span>Lightcord Apex <span class="badge">Switch-Fix</span></span>
        <div class="header-right">
          <button class="min-btn" id="dsm-min-toggle" title="Maximize/Minimize">+</button>
        </div>
      </h2>
      <div class="dsm-body">
        <section>
          <div class="sec-head"><span>VOLUME</span><button class="reset-sm" id="dsm-reset-vol">Reset</button></div>
          <div class="row">
            <label style="flex:1;margin:0">Master
              <input type="range" id="dsm-mg" min="0" max="100" step="0.1" value="1">
              <input type="number" id="dsm-mg-n" value="1" step="0.5">
            </label>
            <button class="mute" id="dsm-mm">Mute</button>
          </div>
        </section>
        <section>
          <div class="sec-head"><span>STEREO DELAY (ms)</span><button class="reset-sm" id="dsm-reset-delay">Reset</button></div>
          <label>Left
            <input type="range" id="dsm-dl" min="-15" max="25" step="1" value="0">
            <input type="number" id="dsm-dl-n" min="-15" max="25" step="1" value="0">
          </label>
          <label>Right
            <input type="range" id="dsm-dr" min="-15" max="25" step="1" value="0">
            <input type="number" id="dsm-dr-n" min="-15" max="25" step="1" value="0">
          </label>
          <div style="font-size:9px;color:#555;margin-top:2px">Zero-Phase Cross-Feed Widening Active</div>
        </section>
        <section>
          <div class="sec-head"><span>PRO COMPRESSOR (DYNAMIC)</span><button class="reset-sm" id="dsm-reset-comp">Reset</button></div>
          <div class="row">
            <button class="mute" id="dsm-comp-toggle" style="flex:1;text-align:center">Enable Compressor</button>
          </div>
          <label>Threshold (dB)
            <input type="range" id="dsm-cp-th" min="-60" max="0" step="1" value="-12">
            <input type="number" id="dsm-cp-th-n" value="-12" step="1">
          </label>
          <label>Ratio (:1)
            <input type="range" id="dsm-cp-rt" min="1" max="20" step="0.5" value="4">
            <input type="number" id="dsm-cp-rt-n" value="4" step="0.5">
          </label>
          <label>Attack (s)
            <input type="range" id="dsm-cp-at" min="0" max="1" step="0.001" value="0.003">
            <input type="number" id="dsm-cp-at-n" value="0.003" step="0.001">
          </label>
          <label>Release (s)
            <input type="range" id="dsm-cp-rl" min="0.01" max="1" step="0.01" value="0.25">
            <input type="number" id="dsm-cp-rl-n" value="0.25" step="0.01">
          </label>
        </section>
        <section>
          <div class="sec-head"><span>EQ — 10 BAND</span><button class="reset-sm" id="dsm-eqr">Reset EQ</button></div>
          <div class="eq-grid" id="dsm-eq"></div>
        </section>
        <section>
          <div class="sec-head"><span>MUSIC PLAYER</span><button class="reset-sm" id="dsm-reset-music">Reset</button></div>
          <div class="player">
            <button class="pick-file" id="dsm-pick">Load Audio File (mp3, flac, wav)</button>
            <input class="player-file" type="file" id="dsm-file" accept=".mp3,.wav,.flac,.aac,.ogg,.m4a">
            <div class="player-title" id="dsm-track">No file loaded</div>
            <div class="player-seek">
              <span id="dsm-cur">0:00</span>
              <input type="range" id="dsm-seek" min="0" max="100" step="0.1" value="0">
              <span id="dsm-dur">0:00</span>
            </div>
            <div class="player-btns">
              <button class="pb" id="dsm-play">&#9654;</button>
              <button class="pb" id="dsm-pause">&#9646;&#9646;</button>
              <button class="pb" id="dsm-stop">&#9632;</button>
              <button class="pb" id="dsm-loop">&#8635; Loop</button>
            </div>
            <label style="margin-top:4px">Music Vol
              <input type="range" id="dsm-mvol" min="0" max="10" step="0.01" value="1">
              <input type="number" id="dsm-mvol-n" value="1" step="0.1">
            </label>
            <div class="row">
              <button class="mute" id="dsm-mum2" style="flex:1;text-align:center">Mute Music</button>
            </div>
          </div>
        </section>
        <section style="border-bottom:none">
          <button class="reset" id="dsm-reset-all">Reset All Defaults</button>
        </section>
      </div>
    `;
    document.body.appendChild(p);
    this.#el = p;
    this.#drag(p.querySelector('h2'));
    this.#bindMinimize();
    this.#bindVolumes();
    this.#bindStereoDelay();
    this.#bindCompressor();
    this.#buildEQ();
    this.#bindMutes();
    this.#buildPlayer();
    this.#bindSectionResets();
    this.#bindResetAll();
  }

  #bindMinimize() {
    const btn = document.getElementById('dsm-min-toggle');
    const header = this.#el.querySelector('h2');
    const toggle = () => {
      this.#minimized = !this.#minimized;
      this.#el.classList.toggle('minimized', this.#minimized);
      btn.textContent = this.#minimized ? '+' : '—';
    };
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
    header.addEventListener('dblclick', () => toggle());
  }

  #drag(handle) {
    handle.addEventListener('mousedown', e => {
      if (e.target.tagName === 'BUTTON') return;
      this.#dragging = true;
      const r = this.#el.getBoundingClientRect();
      this.#dx = e.clientX - r.left;
      this.#dy = e.clientY - r.top;
    });
    document.addEventListener('mousemove', e => {
      if (!this.#dragging) return;
      this.#el.style.right = 'auto';
      this.#el.style.left  = (e.clientX - this.#dx) + 'px';
      this.#el.style.top   = (e.clientY - this.#dy) + 'px';
    });
    document.addEventListener('mouseup', () => { this.#dragging = false; });
  }

  #linkVolume(sliderId, numberId, setter) {
    const sl = document.getElementById(sliderId);
    const nb = document.getElementById(numberId);
    const apply = (v) => {
      const n = Math.max(0, parseFloat(v) || 0);
      sl.value = Math.min(n, parseFloat(sl.max));
      nb.value = n;
      setter(n);
    };
    sl.addEventListener('input',  () => apply(sl.value));
    nb.addEventListener('change', () => apply(nb.value));
    nb.addEventListener('keydown', e => { if (e.key === 'Enter') apply(nb.value); });
  }

  #bindVolumes() {
    this.#linkVolume('dsm-mg', 'dsm-mg-n', v => AudioPipelineLayer.setMasterGain(v));
  }

  #linkDelay(sliderId, numberId, side) {
    const sl = document.getElementById(sliderId);
    const nb = document.getElementById(numberId);
    const apply = (v) => {
      const n = Math.max(-15, Math.min(25, parseInt(v, 10) || 0));
      sl.value = n;
      nb.value = n;
      const left  = side === 'left'  ? n : parseInt(document.getElementById('dsm-dl').value, 10);
      const right = side === 'right' ? n : parseInt(document.getElementById('dsm-dr').value, 10);
      AudioPipelineLayer.setStereoDelay(left, right);
    };
    sl.addEventListener('input',  () => apply(sl.value));
    nb.addEventListener('change', () => apply(nb.value));
    nb.addEventListener('keydown', e => { if (e.key === 'Enter') apply(nb.value); });
  }

  #bindStereoDelay() {
    this.#linkDelay('dsm-dl', 'dsm-dl-n', 'left');
    this.#linkDelay('dsm-dr', 'dsm-dr-n', 'right');
  }

  #linkCompressorParam(sliderId, numberId, paramKey) {
    const sl = document.getElementById(sliderId);
    const nb = document.getElementById(numberId);
    const apply = (v) => {
      const n = parseFloat(v) || 0;
      sl.value = n;
      nb.value = n;
      AudioPipelineLayer.setCompressorParam(paramKey, n);
    };
    sl.addEventListener('input',  () => apply(sl.value));
    nb.addEventListener('change', () => apply(nb.value));
    nb.addEventListener('keydown', e => { if (e.key === 'Enter') apply(nb.value); });
  }

  #bindCompressor() {
    let compOn = false;
    const btn = document.getElementById('dsm-comp-toggle');
    btn.addEventListener('click', () => {
      compOn = !compOn;
      AudioPipelineLayer.setCompressorEnabled(compOn);
      btn.textContent = compOn ? 'Disable Compressor' : 'Enable Compressor';
      btn.classList.toggle('on', compOn);
    });

    this.#linkCompressorParam('dsm-cp-th', 'dsm-cp-th-n', 'threshold');
    this.#linkCompressorParam('dsm-cp-rt', 'dsm-cp-rt-n', 'ratio');
    this.#linkCompressorParam('dsm-cp-at', 'dsm-cp-at-n', 'attack');
    this.#linkCompressorParam('dsm-cp-rl', 'dsm-cp-rl-n', 'release');
  }

  #bindMutes() {
    const mm = document.getElementById('dsm-mm');
    mm.addEventListener('click', () => {
      this.#micMuted = !this.#micMuted;
      AudioPipelineLayer.muteMic(this.#micMuted);
      mm.textContent = this.#micMuted ? 'Unmute' : 'Mute';
      mm.classList.toggle('on', this.#micMuted);
    });
  }

  #fmt(s) {
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2,'0')}`;
  }

  #buildPlayer() {
    let looping = false, seeking = false;

    const pick   = document.getElementById('dsm-pick');
    const file   = document.getElementById('dsm-file');
    const track  = document.getElementById('dsm-track');
    const seekEl = document.getElementById('dsm-seek');
    const curEl  = document.getElementById('dsm-cur');
    const durEl  = document.getElementById('dsm-dur');
    const playB  = document.getElementById('dsm-play');
    const pauseB = document.getElementById('dsm-pause');
    const stopB  = document.getElementById('dsm-stop');
    const loopB  = document.getElementById('dsm-loop');
    const mum    = document.getElementById('dsm-mum2');
    const volSl  = document.getElementById('dsm-mvol');
    const volNb  = document.getElementById('dsm-mvol-n');

    pick.addEventListener('click', () => {
      const ctx = AudioPipelineLayer.getContext();
      if (ctx.state === 'suspended') ctx.resume();
      file.click();
    });
    file.addEventListener('change', () => {
      const f = file.files[0];
      if (!f) return;
      LocalAudioLayer.loadFile(f);
      track.textContent = f.name;
      seekEl.value = 0;
      curEl.textContent = '0:00';
    });

    playB.addEventListener('click',  () => {
      const ctx = AudioPipelineLayer.getContext();
      if (ctx.state === 'suspended') ctx.resume();
      LocalAudioLayer.play();
      playB.classList.add('active');
    });
    pauseB.addEventListener('click', () => { LocalAudioLayer.pause(); playB.classList.remove('active'); });
    stopB.addEventListener('click',  () => { LocalAudioLayer.stop();  playB.classList.remove('active'); seekEl.value = 0; curEl.textContent = '0:00'; });

    loopB.addEventListener('click', () => {
      looping = !looping;
      LocalAudioLayer.setLoop(looping);
      loopB.classList.toggle('active', looping);
    });

    seekEl.addEventListener('mousedown', () => { seeking = true; });
    seekEl.addEventListener('mouseup',   () => {
      LocalAudioLayer.seek(parseFloat(seekEl.value));
      seeking = false;
    });

    mum.addEventListener('click', () => {
      this.#musicMuted = !this.#musicMuted;
      LocalAudioLayer.muteMusic(this.#musicMuted);
      mum.textContent = this.#musicMuted ? 'Unmute Music' : 'Mute Music';
      mum.classList.toggle('on', this.#musicMuted);
    });

    const applyVol = (v) => {
      const n = Math.max(0, parseFloat(v) || 0);
      volSl.value = Math.min(n, 10);
      volNb.value = n;
      LocalAudioLayer.setMusicVolume(n);
    };
    volSl.addEventListener('input',   () => applyVol(volSl.value));
    volNb.addEventListener('change',  () => applyVol(volNb.value));
    volNb.addEventListener('keydown', e => { if (e.key === 'Enter') applyVol(volNb.value); });

    setInterval(() => {
      const dur = LocalAudioLayer.duration();
      const cur = LocalAudioLayer.currentTime();
      if (!seeking && dur > 0) {
        seekEl.max = dur;
        seekEl.value = cur;
        curEl.textContent = this.#fmt(cur);
        durEl.textContent = this.#fmt(dur);
      }
      if (LocalAudioLayer.isPlaying()) playB.classList.add('active');
      else playB.classList.remove('active');
    }, 250);
  }

  #setUI(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = val;
  }

  #resetEQUI() {
    for (let i = 0; i < 10; i++) {
      this.#setUI(`dsm-eq-${i}`, 0);
      const v = document.getElementById(`dsm-eq-v${i}`);
      if (v) v.textContent = '0';
    }
    AudioPipelineLayer.resetEQ();
  }

  #bindSectionResets() {
    document.getElementById('dsm-reset-vol').addEventListener('click', () => {
      AudioPipelineLayer.setMasterGain(1);
      this.#setUI('dsm-mg', 1);
      this.#setUI('dsm-mg-n', 1);
    });

    document.getElementById('dsm-reset-delay').addEventListener('click', () => {
      AudioPipelineLayer.setStereoDelay(0, 0);
      this.#setUI('dsm-dl', 0); this.#setUI('dsm-dl-n', 0);
      this.#setUI('dsm-dr', 0); this.#setUI('dsm-dr-n', 0);
    });

    document.getElementById('dsm-reset-comp').addEventListener('click', () => {
      AudioPipelineLayer.setCompressorEnabled(false);
      AudioPipelineLayer.setCompressorParam('threshold', -12);
      AudioPipelineLayer.setCompressorParam('ratio', 4);
      AudioPipelineLayer.setCompressorParam('attack', 0.003);
      AudioPipelineLayer.setCompressorParam('release', 0.25);

      this.#setUI('dsm-cp-th', -12); this.#setUI('dsm-cp-th-n', -12);
      this.#setUI('dsm-cp-rt', 4);   this.#setUI('dsm-cp-rt-n', 4);
      this.#setUI('dsm-cp-at', 0.003); this.#setUI('dsm-cp-at-n', 0.003);
      this.#setUI('dsm-cp-rl', 0.25);  this.#setUI('dsm-cp-rl-n', 0.25);

      const btn = document.getElementById('dsm-comp-toggle');
      btn.textContent = 'Enable Compressor';
      btn.classList.remove('on');
    });

    document.getElementById('dsm-eqr').addEventListener('click', () => {
      this.#resetEQUI();
    });

    document.getElementById('dsm-reset-music').addEventListener('click', () => {
      this.#musicMuted = false;
      LocalAudioLayer.setMusicVolume(1);
      LocalAudioLayer.muteMusic(false);
      this.#setUI('dsm-mvol', 1);
      this.#setUI('dsm-mvol-n', 1);
      const mum = document.getElementById('dsm-mum2');
      mum.textContent = 'Mute Music';
      mum.classList.remove('on');
    });
  }

  #bindResetAll() {
    document.getElementById('dsm-reset-all').addEventListener('click', () => {
      this.#micMuted = false;
      this.#musicMuted = false;
      AudioPipelineLayer.resetAll();
      LocalAudioLayer.reset();

      this.#setUI('dsm-mg', 1); this.#setUI('dsm-mg-n', 1);
      this.#setUI('dsm-dl', 0); this.#setUI('dsm-dl-n', 0);
      this.#setUI('dsm-dr', 0); this.#setUI('dsm-dr-n', 0);
      this.#setUI('dsm-mvol', 1); this.#setUI('dsm-mvol-n', 1);
      this.#setUI('dsm-cp-th', -12); this.#setUI('dsm-cp-th-n', -12);
      this.#setUI('dsm-cp-rt', 4);   this.#setUI('dsm-cp-rt-n', 4);
      this.#setUI('dsm-cp-at', 0.003); this.#setUI('dsm-cp-at-n', 0.003);
      this.#setUI('dsm-cp-rl', 0.25);  this.#setUI('dsm-cp-rl-n', 0.25);
      this.#setUI('dsm-seek', 0);
      this.#resetEQUI();

      const mm = document.getElementById('dsm-mm');
      mm.textContent = 'Mute';
      mm.classList.remove('on');

      const compBtn = document.getElementById('dsm-comp-toggle');
      compBtn.textContent = 'Enable Compressor';
      compBtn.classList.remove('on');

      const mum = document.getElementById('dsm-mum2');
      mum.textContent = 'Mute Music';
      mum.classList.remove('on');

      document.getElementById('dsm-track').textContent = 'No file loaded';
      document.getElementById('dsm-cur').textContent = '0:00';
      document.getElementById('dsm-dur').textContent = '0:00';
      document.getElementById('dsm-play').classList.remove('active');
      document.getElementById('dsm-loop').classList.remove('active');
      document.getElementById('dsm-file').value = '';
    });
  }

  #buildEQ() {
    const labels = ['31','62','125','250','500','1k','2k','4k','8k','16k'];
    const grid   = document.getElementById('dsm-eq');
    labels.forEach((lbl, i) => {
      const col = document.createElement('div');
      col.className = 'eq-col';
      col.innerHTML = `
        <div class="eq-val" id="dsm-eq-v${i}">0</div>
        <input type="range" id="dsm-eq-${i}" min="-12" max="12" step="0.1" value="0">
        <span>${lbl}</span>
      `;
      grid.appendChild(col);
      const sl  = col.querySelector('input');
      const val = col.querySelector('.eq-val');
      sl.addEventListener('input', () => {
        const v = parseFloat(sl.value);
        val.textContent = (v > 0 ? '+' : '') + v.toFixed(1);
        AudioPipelineLayer.setBand(i, v);
      });
    });
  }
};

if (document.body) UI.build();
else document.addEventListener('DOMContentLoaded', () => UI.export ? null : UI.build());

})();