/*
 * 早押しドン — ルーム制の早押しボタン。
 *
 * 通信は公開 MQTT ブローカーの WebSocket。ルームごとに2つのトピックを使う。
 *   hayaoshi-don/v1/<room>/state … ホストだけが書く retained メッセージ。
 *                                   後から来た人にもブローカーが自動で配る。
 *   hayaoshi-don/v1/<room>/buzz  … 各自の早押し。ホストが受信順で勝者を決める。
 *
 * 「最初の1人」の判定はホスト1台に集約している。実際の早押し機と同じで、
 * 判定の基準点をひとつにするのが端末ごとの時計のズレに影響されない。
 */
(function () {
  'use strict';

  var BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081/mqtt'
  ];
  var NS = 'hayaoshi-don/v1/';
  var PROBE_MS = 2000;

  var entry = document.getElementById('entry');
  var game = document.getElementById('game');
  var createBtn = document.getElementById('createBtn');
  var joinBtn = document.getElementById('joinBtn');
  var codeInput = document.getElementById('codeInput');
  var entryNote = document.getElementById('entryNote');
  var roomTag = document.getElementById('roomTag');
  var lamp = document.getElementById('lamp');
  var buzzer = document.getElementById('buzzer');
  var hint = document.getElementById('hint');

  /* ---------------- 音（クイズの回答音 ピンポーン） ---------------- */

  var ctx = null, master = null;

  function audio() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { return null; }
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.8;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') { ctx.resume(); }
    return ctx;
  }

  // 非整数倍音を重ねたベル。倍音ほど速く減衰させて金属的に響かせる。
  function bell(t0, freq, dur, amp) {
    var partials = [[1, 1], [2.0, 0.40], [3.01, 0.18], [4.18, 0.08]];
    for (var i = 0; i < partials.length; i++) {
      var mult = partials[i][0];
      var a = partials[i][1] * amp;
      var d = dur / (1 + (mult - 1) * 0.42);
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq * mult, t0);
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(a, t0 + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
      osc.connect(g); g.connect(master);
      osc.start(t0); osc.stop(t0 + d + 0.05);
    }
  }

  function pinpon() {
    if (!audio()) { return; }
    var t = ctx.currentTime + 0.01;
    bell(t, 1046.50, 0.40, 0.30);          // ピン (C6)
    bell(t + 0.155, 1567.98, 0.95, 0.32);  // ポーン (G6)
    if (navigator.vibrate) { try { navigator.vibrate([18, 40, 60]); } catch (e) {} }
  }

  /* ---------------- 状態 ---------------- */

  var me = sessionStorage.getItem('hd.peer');
  if (!me) {
    me = Math.random().toString(36).slice(2, 12);
    sessionStorage.setItem('hd.peer', me);
  }

  var mqtt = null;
  var connected = false;
  var roomId = null;
  var isHost = false;
  var round = 0;
  var roundOpen = false;
  var lockedOut = false;
  var pressed = false;
  var lastWinner = null;
  var probe = null;      // {room, timer, ok, ng}

  function topicState(id) { return NS + id + '/state'; }
  function topicBuzz(id) { return NS + id + '/buzz'; }

  function setHint(text) { hint.textContent = text || ''; }

  function idleHint() {
    if (!connected) { setHint('接続中…'); return; }
    setHint(isHost ? 'ランプをタップで次の問題へ' : '');
  }

  function applyState(st) {
    round = st.r || 0;
    roundOpen = !!st.open;
    lastWinner = st.win || null;
    if (roundOpen) {
      lockedOut = false;
      pressed = false;
      buzzer.disabled = false;
      lamp.classList.remove('on');
    } else {
      lockedOut = true;
      buzzer.disabled = true;
      lamp.classList.toggle('on', lastWinner === me);
    }
    idleHint();
  }

  function publishState() {
    if (!isHost) { return; }
    mqtt.publish(topicState(roomId), JSON.stringify({
      r: round, open: roundOpen, win: lastWinner, h: me
    }), true);
  }

  /* ---------------- 通信 ---------------- */

  function start() {
    mqtt = new MiniMqtt(BROKERS, { clientId: 'hd-' + me });

    mqtt.onstatus = function (ok) {
      connected = ok;
      if (roomId) { idleHint(); }
      else { entryNote.textContent = ok ? '' : 'サーバーに接続中…'; }
      createBtn.disabled = !ok;
      joinBtn.disabled = !ok || codeInput.value.length !== 6;
    };

    mqtt.onconnect = function () {
      // 再接続後もホストが現状を配り直す（retained なので上書きでよい）
      if (roomId && isHost) { publishState(); }
    };

    mqtt.onmessage = function (topic, text) {
      var parts = topic.split('/');
      var id = parts[2], kind = parts[3];
      var data;
      try { data = JSON.parse(text); } catch (e) { return; }
      if (!data || typeof data !== 'object') { return; }

      if (kind === 'state') {
        if (probe && probe.room === id) { finishProbe(true, data); return; }
        if (id !== roomId) { return; }
        applyState(data);
        return;
      }

      if (kind === 'buzz') {
        if (!isHost || id !== roomId) { return; }
        if (!roundOpen || data.r !== round) { return; }
        if (typeof data.id !== 'string' || data.id.length > 32) { return; }
        roundOpen = false;
        lastWinner = data.id;
        publishState();
        applyState({ r: round, open: false, win: lastWinner });
      }
    };

    mqtt.connect();
  }

  /* ---------------- ルームの有無を確かめる ---------------- */

  function startProbe(id, ok, ng) {
    mqtt.subscribe(NS + id + '/#');
    probe = { room: id, ok: ok, ng: ng, timer: 0 };
    probe.timer = setTimeout(function () { finishProbe(false, null); }, PROBE_MS);
  }

  function finishProbe(exists, data) {
    if (!probe) { return; }
    var p = probe;
    probe = null;
    clearTimeout(p.timer);
    if (exists) { p.ok(p.room, data); } else { p.ng(p.room); }
  }

  function newCode() {
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  /* ---------------- 入室 ---------------- */

  function enterRoom(id, host, state) {
    roomId = id;
    isHost = host;
    roomTag.textContent = id;
    lamp.classList.toggle('host', host);
    entry.hidden = true;
    game.hidden = false;
    mqtt.subscribe(NS + id + '/#');

    sessionStorage.setItem('hd.room', id);
    sessionStorage.setItem('hd.host', host ? '1' : '');

    if (host) {
      round = (state && state.r) || 1;
      roundOpen = true;
      lastWinner = null;
      publishState();
      applyState({ r: round, open: true, win: null });
    } else {
      applyState(state || { r: 0, open: true, win: null });
    }
    audio();
  }

  var creating = 0;

  function createRoom() {
    if (!connected) { return; }
    createBtn.disabled = true;
    entryNote.className = 'note';
    entryNote.textContent = 'ルームを用意しています…';
    creating = 0;
    tryCreate();
  }

  function tryCreate() {
    creating++;
    var id = newCode();
    startProbe(id, function () {                 // 既に使われていた
      if (creating < 5) { tryCreate(); }
      else {
        createBtn.disabled = false;
        entryNote.className = 'note warn';
        entryNote.textContent = '空きルームが見つかりませんでした。もう一度お試しください。';
      }
    }, function (freeId) {                       // 空いていた
      createBtn.disabled = false;
      entryNote.textContent = '';
      enterRoom(freeId, true, null);
    });
  }

  function joinRoom() {
    if (!connected || codeInput.value.length !== 6) { return; }
    var id = codeInput.value;
    joinBtn.disabled = true;
    entryNote.className = 'note';
    entryNote.textContent = 'ルームを探しています…';
    startProbe(id, function (found, state) {
      joinBtn.disabled = false;
      entryNote.textContent = '';
      enterRoom(found, false, state);
    }, function () {
      joinBtn.disabled = false;
      entryNote.className = 'note warn';
      entryNote.textContent = 'そのルームは見つかりませんでした。番号を確かめてください。';
    });
  }

  /* ---------------- 早押し ---------------- */

  function press() {
    if (lockedOut || pressed || !roomId) { return; }
    pinpon();
    buzzer.classList.add('hit');
    setTimeout(function () { buzzer.classList.remove('hit'); }, 110);
    pressed = true;
    mqtt.publish(topicBuzz(roomId), JSON.stringify({ id: me, r: round }), false);
  }

  buzzer.addEventListener('click', press);

  lamp.addEventListener('click', function () {
    if (!isHost || !roomId) { return; }
    round++;
    roundOpen = true;
    lastWinner = null;
    publishState();
    applyState({ r: round, open: true, win: null });
  });

  roomTag.addEventListener('click', function () {
    if (!roomId || !navigator.clipboard) { return; }
    navigator.clipboard.writeText(roomId).then(function () {
      var before = roomTag.textContent;
      roomTag.textContent = 'コピーしました';
      setTimeout(function () { roomTag.textContent = before; }, 1200);
    }, function () {});
  });

  createBtn.addEventListener('click', createRoom);
  joinBtn.addEventListener('click', joinRoom);

  codeInput.addEventListener('input', function () {
    codeInput.value = codeInput.value.replace(/[^0-9]/g, '').slice(0, 6);
    joinBtn.disabled = !connected || codeInput.value.length !== 6;
    entryNote.className = 'note';
    entryNote.textContent = '';
  });

  codeInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { joinRoom(); }
  });

  document.addEventListener('keydown', function (e) {
    if (game.hidden) { return; }
    if (e.code !== 'Space' && e.key !== 'Enter') { return; }
    if (e.target && e.target.tagName === 'INPUT') { return; }
    e.preventDefault();
    if (e.repeat) { return; }
    press();
  });

  // ホストが去ったら retained を空にしてルームを畳む
  window.addEventListener('pagehide', function () {
    if (isHost && roomId && mqtt) { mqtt.publish(topicState(roomId), '', true); }
  });

  /* ---------------- 起動 ---------------- */

  createBtn.disabled = true;
  entryNote.textContent = 'サーバーに接続中…';
  start();

  // 同じタブでのリロードは元のルームへ戻す
  var saved = sessionStorage.getItem('hd.room');
  if (saved) {
    var wasHost = sessionStorage.getItem('hd.host') === '1';
    var waitConnect = setInterval(function () {
      if (!connected) { return; }
      clearInterval(waitConnect);
      if (wasHost) {
        enterRoom(saved, true, null);
      } else {
        startProbe(saved, function (id, st) { enterRoom(id, false, st); },
                          function () { sessionStorage.removeItem('hd.room'); });
      }
    }, 120);
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function () {});
    });
  }
})();
