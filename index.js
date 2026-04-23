const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Redis } = require('@upstash/redis');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const http = require('http');
const QRCode = require('qrcode');

let lastQR = null;

const server = http.createServer(async (req, res) => {
    if (req.url === '/qr') {
        if (!lastQR) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<h2>מחובר לווצאפ! אין צורך בסריקה.</h2>');
        } else {
            const qrImage = await QRCode.toDataURL(lastQR);
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`<html><body style="text-align:center"><h2>סרוק את ה-QR עם ווצאפ</h2><img src="${qrImage}" style="width:300px"/><p>רענן את הדף אם פג תוקף</p></body></html>`);
        }
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

async function saveAuthToRedis(creds) {
    await redis.set('wa_creds', JSON.stringify(creds));
}

async function loadAuthFromRedis() {
    const creds = await redis.get('wa_creds');
    return creds ? JSON.parse(creds) : null;
}

async function connectToWhatsApp() {
    const authDir = './auth_info';
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir);

    const savedCreds = await loadAuthFromRedis();
    if (savedCreds) {
        fs.writeFileSync(path.join(authDir, 'creds.json'), JSON.stringify(savedCreds));
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        const creds = JSON.parse(fs.readFileSync(path.join(authDir, 'creds.json'), 'utf8'));
        await saveAuthToRedis(creds);
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            lastQR = qr;
            console.log('QR code ready - visit /qr to scan');
        }
        if (connection === 'close') {
            lastQR = null;
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            lastQR = null;
            console.log('מחובר לווצאפ בהצלחה!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const chatId = msg.key.remoteJid;
        const text = msg.message.conversation ||
                     msg.message.extendedTextMessage?.text || '';
        if (!text) return;

        try {
            if (!conversations.has(chatId)) {
                conversations.set(chatId, model.startChat({
                    history: [],
                    systemInstruction: 'אתה עוזר אישי חכם ומועיל. ענה תמיד בעברית אלא אם המשתמש כותב בשפה אחרת. היה קצר וברור.'
                }));
            }
            const chat = conversations.get(chatId);
            const result = await chat.sendMessage(text);
            const response = result.response.text();
            await sock.sendMessage(chatId, { text: response });
        } catch (error) {
            console.error('שגיאה:', error);
            await sock.sendMessage(chatId, { text: 'מצטער, הייתה שגיאה. נסה שוב.' });
        }
    });
}

connectToWhatsApp();
