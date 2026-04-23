const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Redis } = require('@upstash/redis');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const http = require('http');

let lastQR = null;
let isConnected = false;
let status = 'starting';

const server = http.createServer((req, res) => {
    if (req.url === '/qr') {
        if (isConnected) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h2>מחובר לווצאפ בהצלחה!</h2>');
        } else if (lastQR) {
            const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(lastQR);
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<html><body style="text-align:center;font-family:Arial"><h2>סרוק עם ווצאפ</h2><img src="' + qrUrl + '"/><p>רענן אם פג תוקף</p></body></html>');
        } else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<html><head><meta http-equiv="refresh" content="5"></head><body><h2>ממתין ל-QR... מתרענן אוטומטית</h2><p>סטטוס: ' + status + '</p></body></html>');
        }
    } else if (req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('connected: ' + isConnected + '\nhasQR: ' + (lastQR !== null) + '\nstatus: ' + status);
    } else {
        res.writeHead(200);
        res.end('Bot is running');
    }
});

server.listen(process.env.PORT || 3000);

const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
const conversations = new Map();

async function connectToWhatsApp() {
    status = 'cleaning auth';
    const authDir = './auth_info';
    try { fs.rmSync(authDir, { recursive: true, force: true }); } catch(e) {}
    fs.mkdirSync(authDir, { recursive: true });

    status = 'initializing';
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    status = 'connecting';
const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' }),
    browser: ['Chrome', 'Chrome', '120.0.0.0'],
    connectTimeoutMs: 60000,
});

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            lastQR = qr;
            isConnected = false;
            status = 'waiting for scan';
            console.log('QR ready - open /qr in browser');
        }
        if (connection === 'close') {
            isConnected = false;
            lastQR = null;
            status = 'disconnected';
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code !== DisconnectReason.loggedOut) {
                status = 'reconnecting';
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            isConnected = true;
            lastQR = null;
            status = 'connected';
            console.log('Connected to WhatsApp!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const chatId = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        if (!text) return;
        try {
            if (!conversations.has(chatId)) {
                conversations.set(chatId, model.startChat({
                    history: [],
                    systemInstruction: 'אתה עוזר אישי חכם ומועיל. ענה תמיד בעברית אלא אם המשתמש כותב בשפה אחרת. היה קצר וברור.'
                }));
            }
            const result = await conversations.get(chatId).sendMessage(text);
            await sock.sendMessage(chatId, { text: result.response.text() });
        } catch (e) {
            console.error(e);
            await sock.sendMessage(chatId, { text: 'שגיאה, נסה שוב.' });
        }
    });
}

connectToWhatsApp();
