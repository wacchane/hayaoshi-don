/*
 * mqtt-mini.js — MQTT 3.1.1 over WebSocket の最小クライアント。
 *
 * 必要なのは QoS 0 の publish / subscribe と retain だけなので、
 * CONNECT / CONNACK / SUBSCRIBE / SUBACK / PUBLISH / PINGREQ / PINGRESP /
 * DISCONNECT のみを実装している。外部ライブラリに依存しないので
 * Service Worker でそのままキャッシュでき、CDN 障害の影響も受けない。
 *
 *   var c = new MiniMqtt(['wss://broker.example/mqtt']);
 *   c.onconnect = function(){ c.subscribe('foo/#'); };
 *   c.onmessage = function(topic, text, retained){ ... };
 *   c.connect();
 *   c.publish('foo/bar', 'hello', true);   // 第3引数が retain
 */
(function (global) {
  'use strict';

  var enc = new TextEncoder();
  var dec = new TextDecoder();

  function encLen(n) {
    var out = [];
    do {
      var b = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) { b = b | 128; }
      out.push(b);
    } while (n > 0);
    return out;
  }

  function encStr(s) {
    var b = enc.encode(s);
    var out = [b.length >> 8, b.length & 255];
    for (var i = 0; i < b.length; i++) { out.push(b[i]); }
    return out;
  }

  function packet(byte1, body) {
    var head = [byte1].concat(encLen(body.length));
    var out = new Uint8Array(head.length + body.length);
    out.set(head, 0);
    out.set(body, head.length);
    return out;
  }

  function concat(a, b) {
    var out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  function MiniMqtt(urls, opts) {
    opts = opts || {};
    this.urls = urls;
    this.urlIndex = 0;
    this.clientId = opts.clientId || ('hd-' + Math.random().toString(36).slice(2, 12));
    this.keepalive = opts.keepalive || 45;
    this.ws = null;
    this.buf = new Uint8Array(0);
    this.pid = 1;
    this.subs = [];        // 再接続時に貼り直す購読
    this.ready = false;
    this.closed = false;
    this.retries = 0;
    this.pingTimer = null;
    this.retryTimer = null;
    this.onconnect = null;   // function()
    this.onmessage = null;   // function(topic, payloadText, retained)
    this.onstatus = null;    // function(connected)
  }

  MiniMqtt.prototype._status = function (ok) {
    if (this.onstatus) { this.onstatus(ok); }
  };

  MiniMqtt.prototype.connect = function () {
    if (this.closed) { return; }
    var self = this;
    var url = this.urls[this.urlIndex % this.urls.length];
    var ws;
    try {
      ws = new WebSocket(url, ['mqtt']);
    } catch (e) {
      this._retry();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.buf = new Uint8Array(0);
    this.ready = false;

    ws.onopen = function () {
      // CONNECT: protocol level 4, clean session, keepalive
      var vh = encStr('MQTT').concat([4, 2, self.keepalive >> 8, self.keepalive & 255]);
      var body = vh.concat(encStr(self.clientId));
      ws.send(packet(0x10, body));
    };

    ws.onmessage = function (ev) {
      self._feed(new Uint8Array(ev.data));
    };

    ws.onclose = function () {
      if (self.ws !== ws) { return; }
      self.ready = false;
      self._stopPing();
      self._status(false);
      self.urlIndex++;      // 次はほかのブローカーを試す
      self._retry();
    };

    ws.onerror = function () {
      try { ws.close(); } catch (e) {}
    };
  };

  MiniMqtt.prototype._retry = function () {
    if (this.closed) { return; }
    var self = this;
    var wait = Math.min(800 * Math.pow(1.7, Math.min(this.retries, 5)), 15000);
    this.retries++;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(function () { self.connect(); }, wait);
  };

  MiniMqtt.prototype._startPing = function () {
    var self = this;
    this._stopPing();
    this.pingTimer = setInterval(function () {
      if (self.ready && self.ws && self.ws.readyState === 1) {
        self.ws.send(new Uint8Array([0xC0, 0x00]));
      }
    }, this.keepalive * 500);   // keepalive の半分の間隔
  };

  MiniMqtt.prototype._stopPing = function () {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  };

  MiniMqtt.prototype._feed = function (chunk) {
    this.buf = concat(this.buf, chunk);
    for (;;) {
      var buf = this.buf;
      if (buf.length < 2) { return; }
      // 可変長の Remaining Length を読む
      var mult = 1, val = 0, i = 1, b;
      do {
        if (i >= buf.length) { return; }
        if (i > 4) { this.buf = new Uint8Array(0); return; }   // 壊れている
        b = buf[i];
        val += (b & 127) * mult;
        mult *= 128;
        i++;
      } while (b & 128);
      var total = i + val;
      if (buf.length < total) { return; }
      this._handle(buf.subarray(0, total), i);
      this.buf = buf.slice(total);
    }
  };

  MiniMqtt.prototype._handle = function (pkt, headLen) {
    var type = pkt[0] >> 4;

    if (type === 2) {                     // CONNACK
      if (pkt[headLen + 1] !== 0) { return; }
      this.ready = true;
      this.retries = 0;
      this._startPing();
      this._status(true);
      var again = this.subs.slice();
      this.subs = [];
      for (var i = 0; i < again.length; i++) { this.subscribe(again[i]); }
      if (this.onconnect) { this.onconnect(); }
      return;
    }

    if (type === 3) {                     // PUBLISH
      var qos = (pkt[0] >> 1) & 3;
      var retained = (pkt[0] & 1) === 1;
      var p = headLen;
      var tlen = (pkt[p] << 8) | pkt[p + 1];
      p += 2;
      var topic = dec.decode(pkt.subarray(p, p + tlen));
      p += tlen;
      if (qos > 0) { p += 2; }            // packet identifier
      var text = dec.decode(pkt.subarray(p));
      if (this.onmessage) { this.onmessage(topic, text, retained); }
      return;
    }
    // SUBACK(9) / PINGRESP(13) は確認不要
  };

  MiniMqtt.prototype.subscribe = function (filter) {
    if (this.subs.indexOf(filter) === -1) { this.subs.push(filter); }
    if (!this.ready || !this.ws || this.ws.readyState !== 1) { return; }
    var id = this.pid++ & 0xFFFF || 1;
    var body = [id >> 8, id & 255].concat(encStr(filter), [0]);
    this.ws.send(packet(0x82, body));
  };

  MiniMqtt.prototype.publish = function (topic, text, retain) {
    if (!this.ready || !this.ws || this.ws.readyState !== 1) { return false; }
    var payload = enc.encode(text == null ? '' : String(text));
    var body = encStr(topic);
    for (var i = 0; i < payload.length; i++) { body.push(payload[i]); }
    this.ws.send(packet(0x30 | (retain ? 1 : 0), body));
    return true;
  };

  MiniMqtt.prototype.end = function () {
    this.closed = true;
    this._stopPing();
    clearTimeout(this.retryTimer);
    if (this.ws && this.ws.readyState === 1) {
      try {
        this.ws.send(new Uint8Array([0xE0, 0x00]));
        this.ws.close();
      } catch (e) {}
    }
    this.ws = null;
  };

  global.MiniMqtt = MiniMqtt;
})(window);
