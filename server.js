const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Server } = require('socket.io');
const OpusScript = require('opusscript');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.static('public'));
app.use(express.json());

let zelloWs = null;
let zelloConnected = false;
let currentStreamId = null;
let seq = 1;
let opusEncoder = null;

// Zello connection state
let channelName = '';
let usersOnline = 0;

console.log('🎙️ Zello Web PTT Server Starting...');

// Socket.IO connection from web client
io.on('connection', (socket) => {
    console.log('✅ Web client connected:', socket.id);
    
    // Test that socket works
    socket.emit('log', '✅ Socket.IO connected to server');

    // Send current Zello status
    socket.emit('zello_status', {
        connected: zelloConnected,
        channel: channelName,
        users: usersOnline
    });

    // Connect to Zello
    socket.on('zello_connect', (credentials) => {
        console.log('📞 Received zello_connect event');
        console.log('Credentials:', {
            hasToken: !!credentials.token,
            hasChannel: !!credentials.channel,
            tokenLength: credentials.token ? credentials.token.length : 0,
            channel: credentials.channel
        });
        connectToZello(credentials, socket);
    });

    // Start PTT transmission
    socket.on('start_ptt', () => {
        console.log('Received start_ptt event');
        if (!zelloConnected) {
            socket.emit('error', 'Not connected to Zello');
            return;
        }
        startZelloTransmission(socket);
    });

    // Receive audio from browser
    socket.on('audio_data', (audioData) => {
        if (currentStreamId && opusEncoder) {
            try {
                // Convert Float32Array to Int16Array (PCM)
                const pcm = new Int16Array(audioData.length);
                for (let i = 0; i < audioData.length; i++) {
                    pcm[i] = Math.max(-32768, Math.min(32767, audioData[i] * 32768));
                }

                // Encode to Opus (960 samples = 20ms at 48kHz)
                const opusPacket = opusEncoder.encode(pcm, 960);
                
                // Send to Zello
                sendAudioToZello(opusPacket);
            } catch (e) {
                console.error('Encoding error:', e);
            }
        }
    });

    // Stop PTT transmission
    socket.on('stop_ptt', () => {
        console.log('Received stop_ptt event');
        stopZelloTransmission();
    });

    socket.on('disconnect', () => {
        console.log('❌ Web client disconnected:', socket.id);
        stopZelloTransmission();
    });
});

function connectToZello(credentials, socket) {
    const wsUrl = 'wss://zello.io/ws';
    
    console.log('Attempting Zello connection...');
    console.log('Token:', credentials.token.substring(0, 20) + '...');
    console.log('Channel:', credentials.channel);
    
    zelloWs = new WebSocket(wsUrl);
    zelloWs.binaryType = 'arraybuffer';

    zelloWs.on('open', () => {
        console.log('✅ Connected to Zello WebSocket');
        socket.emit('log', '✅ WebSocket opened');
        
        const loginMsg = {
            command: 'logon',
            seq: seq++,
            auth_token: credentials.token,
            channel: credentials.channel
        };

        if (credentials.username) loginMsg.username = credentials.username;
        if (credentials.password) loginMsg.password = credentials.password;

        console.log('Sending login:', JSON.stringify(loginMsg, null, 2));
        zelloWs.send(JSON.stringify(loginMsg));
        socket.emit('log', '🔐 Authenticating...');
    });

    zelloWs.on('message', (data) => {
        if (data instanceof Buffer || data instanceof ArrayBuffer) {
            socket.emit('incoming_audio', Array.from(new Uint8Array(data)));
            return;
        }

        try {
            const msg = JSON.parse(data.toString());
            console.log('Zello response:', JSON.stringify(msg, null, 2));
            
            if (msg.refresh_token) {
                console.log('✅ Authenticated to Zello');
                socket.emit('log', '✅ Authenticated to Zello');
            }

            if (msg.command === 'on_channel_status') {
                console.log('Channel status:', msg.status);
                if (msg.status === 'online') {
                    zelloConnected = true;
                    channelName = msg.channel;
                    usersOnline = msg.users_online;
                    
                    console.log(`✅ Connected to channel: ${channelName} (${usersOnline} users)`);
                    
                    socket.emit('zello_status', {
                        connected: true,
                        channel: channelName,
                        users: usersOnline
                    });

                    socket.emit('log', `✅ Connected: ${channelName} (${usersOnline} users)`);
                }
            } else if (msg.command === 'on_stream_start') {
                const speaker = msg.from || msg.contactName || 'Unknown';
                console.log(`🔊 ${speaker} is speaking`);
                socket.emit('speaker_update', speaker);
                socket.emit('log', `🔊 ${speaker}`);
            } else if (msg.command === 'on_stream_stop') {
                console.log('Stream stopped');
                socket.emit('speaker_update', null);
            } else if (msg.error) {
                console.error('❌ Zello error:', msg.error);
                socket.emit('error', msg.error);
                socket.emit('log', `❌ Error: ${msg.error}`);
            } else if (msg.stream_id) {
                currentStreamId = msg.stream_id;
                console.log(`✅ Got stream_id: ${currentStreamId}`);
                socket.emit('log', `✅ Stream started: ${currentStreamId}`);
            }
        } catch (e) {
            console.error('Parse error:', e);
        }
    });

    zelloWs.on('error', (error) => {
        console.error('❌ WebSocket error:', error);
        socket.emit('error', 'WebSocket connection error');
        socket.emit('log', '❌ WebSocket error');
    });

    zelloWs.on('close', (code, reason) => {
        console.log(`❌ Zello WebSocket closed (code: ${code}, reason: ${reason})`);
        zelloConnected = false;
        currentStreamId = null;
        socket.emit('zello_status', { connected: false });
        socket.emit('log', '❌ Disconnected from Zello');
    });
}

function startZelloTransmission(socket) {
    console.log('🎤 Starting PTT transmission');
    
    // Initialize Opus encoder (48kHz, mono, VOIP mode)
    opusEncoder = new OpusScript(48000, 1, 2048);
    
    const startMsg = {
        command: 'start_stream',
        seq: seq++,
        type: 'audio',
        codec: 'opus',
        codec_header: 'gD4BPA==',
        packet_duration: 20
    };

    console.log('Sending start_stream:', JSON.stringify(startMsg));
    zelloWs.send(JSON.stringify(startMsg));
    socket.emit('log', '🎤 Transmitting...');
}

let packetId = 0;

function sendAudioToZello(opusPacket) {
    if (!currentStreamId || !zelloWs || zelloWs.readyState !== WebSocket.OPEN) {
        return;
    }

    // Create binary packet header
    const header = Buffer.alloc(9);
    header.writeUInt8(0x01, 0); // type
    header.writeUInt32BE(currentStreamId, 1);
    header.writeUInt32BE(packetId++, 5);

    const packet = Buffer.concat([header, Buffer.from(opusPacket)]);
    zelloWs.send(packet);
    
    // Log every 50 packets
    if (packetId % 50 === 0) {
        console.log(`📡 Sent ${packetId} audio packets`);
    }
}

function stopZelloTransmission() {
    if (!currentStreamId) return;

    console.log('🔇 Stopping PTT transmission');

    if (zelloWs && zelloWs.readyState === WebSocket.OPEN) {
        zelloWs.send(JSON.stringify({
            command: 'stop_stream',
            seq: seq++,
            stream_id: currentStreamId
        }));
    }

    currentStreamId = null;
    opusEncoder = null;
    packetId = 0;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log(`📡 Ready to accept web client connections`);
});
