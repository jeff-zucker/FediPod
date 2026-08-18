// streaming.mjs — the Mastodon streaming API over a hand-rolled WebSocket
// server (send-mostly; we answer pings and ignore everything else a client
// frames at us). No dependencies — the handshake is one SHA-1 and text
// frames are trivial to emit. Clients connect to
//   ws://host/api/v1/streaming?access_token=…&stream=user
// and receive {stream, event, payload} messages for new statuses and
// notifications the moment the agent learns of them.

import crypto from 'node:crypto';

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

import { checkRequest } from './guard.mjs';

export class Streaming {
  constructor({ masto, log = console.log, allowed = null, gate = null, gateOptional = false }) {
    this.masto = masto;
    this.log = log;
    this.allowed = allowed;
    this.gate = gate;
    // A pod-hosted identity is a public instance: a phone app arrives with its
    // bearer and no way to send the operator's header, so there the bearer is
    // the credential. Locally the gate stands in front of the socket as well.
    this.gateOptional = gateOptional;
    this.sockets = new Set();      // entries: { send(string), close() }
  }

  // Whether a client may open the live feed, asked of the upgrade request
  // alone. Shared with the pod-server front, which completes the handshake
  // before any of this runs and so must answer by closing rather than refusing.
  authorizeUpgrade(req, url) {
    // WebSockets are exempt from CORS, so the Host/Origin firewall is the
    // only thing standing between a visited page and the live feed.
    const bad = this.allowed ? checkRequest(req, this.allowed) : null;
    if (bad) return `streaming refused: ${bad}`;
    const proto = String(req.headers['sec-websocket-protocol'] || '').split(',')[0].trim();
    const token = url.searchParams.get('access_token') || proto;
    const hasToken = this.masto.tokens().includes(token);
    // A gate token covers every other route; an upgrade that skipped it was a
    // hole in a control the operator had switched on. A client bearer is the
    // other way in — a phone app has no way to send the operator's header.
    if (this.gate && !this.gate.upgradeOk(req) && !(this.gateOptional && hasToken)) {
      return 'streaming refused: no gate token';
    }
    if (!hasToken) return 'streaming refused: not a live client token';
    return null;
  }

  // Adopt a WebSocket somebody else finished the handshake for — the pod
  // server owns the socket, and hands over an object that already frames.
  adopt(ws) {
    const entry = { send: (str) => ws.send(str), close: () => ws.close() };
    this.sockets.add(entry);
    const drop = () => this.sockets.delete(entry);
    ws.on('close', drop);
    ws.on('error', drop);
    return entry;
  }

  // Let go of every client: the server is stopping, not the connection failing.
  stop() {
    for (const s of this.sockets) { try { s.close(); } catch { /* already gone */ } }
    this.sockets.clear();
  }

  // Attach the upgrade handler to an http.Server.
  attach(server) {
    server.on('upgrade', (req, socket) => {
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith('/api/v1/streaming')) { socket.destroy(); return; }
      // WebSockets are exempt from CORS, so the Host/Origin firewall is the
      // only thing standing between a visited page and the live feed.
      const refusal = this.authorizeUpgrade(req, url);
      if (refusal) {
        this.log(refusal);
        socket.write(refusal.includes('refused:') && !refusal.includes('token')
          ? 'HTTP/1.1 403 Forbidden\r\n\r\n'
          : 'HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      const proto = String(req.headers['sec-websocket-protocol'] || '').split(',')[0].trim();
      const accept = crypto.createHash('sha1')
        .update(req.headers['sec-websocket-key'] + WS_MAGIC).digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
        + `Sec-WebSocket-Accept: ${accept}\r\n`
        + (proto ? `Sec-WebSocket-Protocol: ${proto}\r\n` : '') + '\r\n');
      socket.setNoDelay(true);
      const entry = {
        send: (str) => socket.write(this.frame(str)),
        close: () => { try { socket.end(); } catch { /* already gone */ } },
      };
      this.sockets.add(entry);
      const drop = () => this.sockets.delete(entry);
      socket.on('close', drop);
      socket.on('error', drop);
      socket.on('data', (buf) => {
        if (buf.length && (buf[0] & 0x0f) === 0x9) {          // ping → pong
          try { socket.write(Buffer.from([0x8a, 0x00])); } catch { drop(); }
        }
        if (buf.length && (buf[0] & 0x0f) === 0x8) { drop(); try { socket.end(); } catch {} }  // close
      });
    });
  }

  // Server→client unmasked text frame.
  frame(str) {
    const payload = Buffer.from(str);
    let header;
    if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
    else if (payload.length < 65536) {
      header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    return Buffer.concat([header, payload]);
  }

  broadcast(event, payloadObj, streams = ['user']) {
    if (!this.sockets.size) return;
    const message = JSON.stringify({ stream: streams, event, payload: JSON.stringify(payloadObj) });
    for (const s of this.sockets) {
      try { s.send(message); } catch { this.sockets.delete(s); }
    }
  }
}
