// streaming.mjs — the Mastodon streaming API over a hand-rolled WebSocket
// server (send-mostly; we answer pings and ignore everything else a client
// frames at us). No dependencies — the handshake is one SHA-1 and text
// frames are trivial to emit. Clients connect to
//   ws://host/api/v1/streaming?access_token=…&stream=user
// and receive {stream, event, payload} messages for new statuses and
// notifications the moment the agent learns of them.

import crypto from 'node:crypto';

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class Streaming {
  constructor({ masto, log = console.log }) {
    this.masto = masto;
    this.log = log;
    this.sockets = new Set();
  }

  // Attach the upgrade handler to an http.Server.
  attach(server) {
    server.on('upgrade', (req, socket) => {
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith('/api/v1/streaming')) { socket.destroy(); return; }
      const proto = String(req.headers['sec-websocket-protocol'] || '').split(',')[0].trim();
      const token = url.searchParams.get('access_token') || proto;
      if (!this.masto.tokens().includes(token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      const accept = crypto.createHash('sha1')
        .update(req.headers['sec-websocket-key'] + WS_MAGIC).digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
        + `Sec-WebSocket-Accept: ${accept}\r\n`
        + (proto ? `Sec-WebSocket-Protocol: ${proto}\r\n` : '') + '\r\n');
      socket.setNoDelay(true);
      this.sockets.add(socket);
      const drop = () => this.sockets.delete(socket);
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
    const f = this.frame(JSON.stringify({ stream: streams, event, payload: JSON.stringify(payloadObj) }));
    for (const s of this.sockets) {
      try { s.write(f); } catch { this.sockets.delete(s); }
    }
  }
}
