const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Redis } = require('@upstash/redis');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const http = require('http');

http.createServer((req, res) => res.end('Bot is running')).listen(process.env.PORT || 3000);

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
        printQRInTerminal: true,
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
            console.log('סרוק את ה-QR הזה בווצאפ:');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
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
