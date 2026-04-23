const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

const conversations = new Map();

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('סרוק את הQR הזה בווצאפ:');
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
                    systemInstruction: 'אתה עוזר אישי חכם ומועיל בשם "בוט". ענה תמיד בעברית אלא אם המשתמש כותב בשפה אחרת. היה קצר וברור.'
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
