const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const WebSocket = require('ws');

const app = express();
app.use(express.static('public'));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// --- CONFIGURATION ---
const ZELLO_AUTH_TOKEN = 'DEV KEY';
const ZELLO_USERNAME = 'user'; 
const ZELLO_PASSWORD = 'password'; 
const ZELLO_CHANNEL = 'Merthyr Tydfil CB Radio'; 

let zelloWS, currentId, seq = 1, pId = 0, isReady = false, isBusy = false;

function connect() {
    console.log("LOG: Connecting to Zello...");
    zelloWS = new WebSocket('wss://zello.io/ws');
    
    zelloWS.on('open', () => {
        console.log("LOG: Zello Open. Sending Logon...");
        zelloWS.send(JSON.stringify({
            command: "logon", seq: seq++, auth_token: ZELLO_AUTH_TOKEN, 
            username: ZELLO_USERNAME, password: ZELLO_PASSWORD, channels: [ZELLO_CHANNEL]
        }));
    });

    zelloWS.on('message', (data, isBinary) => {
        if (isBinary) return;
        const resp = JSON.parse(data.toString());
        if (resp.status === "online") {
            isReady = true;
            console.log(">>> GATEWAY ONLINE AS MTBC WebUser");
        }
        if (resp.command === "on_stream_start") isBusy = true;
        if (resp.command === "on_stream_stop") isBusy = false;
        if (resp.command === "start_stream" && resp.success) {
            currentId = resp.stream_id;
            pId = 0;
            console.log(">>> CHANNEL KEYED UP: " + currentId);
        }
    });

    zelloWS.on('close', () => setTimeout(connect, 5000));
}

io.on('connection', (socket) => {
    socket.on('ptt_start', () => {
        if (isBusy || !isReady) return;
        zelloWS.send(JSON.stringify({
            command: "start_stream", seq: seq++, type: "audio", codec: "opus",
            codec_header: "gD4BPA==", packet_duration: 20,
            for: ZELLO_CHANNEL, target_type: "channel"
        }));
    });

    socket.on('audio_data', (chunk) => {
        if (zelloWS && currentId && zelloWS.readyState === 1) {
            // Strip WebM headers (0x1A 0x45)
            if (chunk[0] === 0x1A || chunk.length < 20) return;

            const h = Buffer.alloc(9);
            h.writeUInt8(0x01, 0); 
            h.writeUInt32BE(currentId, 1); 
            h.writeUInt32BE(pId++, 5);
            zelloWS.send(Buffer.concat([h, chunk]), { binary: true });
            if (pId % 25 === 0) console.log(`Transmitting... Chunk ${pId}`);
        }
    });

    socket.on('ptt_stop', () => {
        if (currentId) {
            zelloWS.send(JSON.stringify({ command: "stop_stream", seq: seq++, stream_id: currentId }));
            currentId = null;
            console.log(">>> MIC RELEASED");
        }
    });
});

connect();
server.listen(3000, () => console.log("SERVER LISTENING ON PORT 3000"));