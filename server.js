require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
const server = http.createServer(app);

// WebSocket server
const wss = new WebSocket.Server({ server });

// Serve static files from public directory
app.use(express.static('public'));
app.use(bodyParser.json());

// Configuration
const configInstagrame={
    verifyToken: process.env.VERIFY_TOKEN ,
    PAGEaccessToken: process.env.PAGE_ACCESS_TOKEN,
    app_secret: process.env.APP_SECRET,
    page_id: process.env.PAGE_ID,
   ig_busness_id:process.env.IG_BUSNESS_ID,
    apiVersion: 'v23.0',
    INSTAGRAM_ACCESS_TOKEN:process.env.INSTAGRAM_ACCESS_TOKEN
}

// In-memory storage (replace with database in production)
const clients = new Map(); // WebSocket clients
const messages = new Map(); // contactId → message array
const contacts = new Map(); // contactId → contact info

// Webhook verification endpoint
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token === configInstagrame.verifyToken) {
        console.log('✅ Webhook verified');
        res.status(200).send(challenge);
    } else {
        console.log('❌ Webhook verification failed');
        res.sendStatus(403);
    }
});

// WhatsApp webhook endpoint
app.post('/webhook', (req, res) => {
    try {
        const body = req.body;
  if (body.object === 'instagram' && Array.isArray(body.entry)) {
        body.entry.forEach(entry => {
            if (Array.isArray(entry.messaging)) {
                entry.messaging.forEach(message => {
                    handleIncomingMessage(message);
                });
            }      
     
   });
}
        res.status(200).send('EVENT_RECEIVED');
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).send('Internal Server Error');
    }
});

// API endpoint to get messages
app.get('/api/messages/:contactId', (req, res) => {
    const contactId = req.params.contactId;
    res.json({
        messages: messages.get(contactId) || [],
        contact: contacts.get(contactId) || { id: contactId, name: contactId }
    });
});
app.get('/privacy-policy', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Politique de confidentialité</title>
      </head>
      <body>
        <h1>Politique de confidentialité</h1>
        <p>Nous respectons la vie privée des utilisateurs. Aucune donnée personnelle n’est collectée,
        stockée ou partagée sans consentement explicite.</p>
      </body>
    </html>
  `);
});
// Handle incoming WhatsApp messages
function handleIncomingMessage(value) {
    try {
        console.log('message afficher', JSON.stringify(value, null, 2));

        const senderId = value.sender.id;
        const timestamp = new Date(parseInt(value.timestamp) * 1000);
        const text = value.message?.text || '[Message Instagram non textuel]';

        const msgData = {
            id: value.message.mid || `insta-${Date.now()}`,
            contactId: senderId,
            text,
            direction: 'incoming',
            timestamp,
            status: 'received'
        };

        // Stocker les infos de contact
        if (!contacts.has(senderId)) {
            contacts.set(senderId, {
                id: senderId,
                name: `Instagram User ${senderId}`,
                lastMessage: text,
                messages: [],
                lastMessageTime: timestamp
            });
        } else {
            // Mettre à jour les infos du contact existant
            const contact = contacts.get(senderId);
            contact.lastMessage = text;
            contact.lastMessageTime = timestamp;
        }

        // Stocker le message
        if (!messages.has(senderId)) {
            messages.set(senderId, []);
        }
        messages.get(senderId).push(msgData);

        // Récupérer les infos de contact à envoyer aux clients
        const contactInfo = contacts.get(senderId);

        // Broadcast aux clients connectés
        broadcast({
            type: 'message',
            message: msgData,
            contact: contactInfo
        });

        // Read receipt (si `message.id` existe bien)
        if (value.message?.id) {
            markMessageAsRead(value.message.id);
        }

    } catch (error) {
        console.error('Error handling incoming message:', error);
    }
}


function getMessageText(message) {
    // console.log('📨 Contenu brut du message reçu :', JSON.stringify(message, null, 2));
    // console.log(typeof message=== 'string');
        if (typeof message === 'string') return message;// ✅ pour Instagram
        // if (typeof message.text === 'object' && message.text.body) return message.text.body; // ✅ pour WhatsApp

    if (message.image) return '[Image]';
    if (message.video) return '[Video]';
    if (message.audio) return '[Audio]';
    if (message.document) return '[Document]';
    return '[Media message]';
}

// WebSocket connection handler
wss.on('connection', (ws) => {
    const clientId = Date.now().toString();
    clients.set(clientId, ws);
    console.log(`Client connected: ${clientId}`);

    // Send initial contacts
    ws.send(JSON.stringify({
        type: 'contacts',
        contacts: Array.from(contacts.values())
    }));

    // Handle client messages
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            
            if (message.type === 'auth' && message.token === configInstagrame.PAGEaccessToken) {
                console.log(`Client ${clientId} authenticated`);
            } 
            else if (message.type === 'send_message') {
                handleClientMessage(message, clientId);
            }
        } catch (error) {
            console.error('WebSocket message error:', error);
        }
    });

    // Handle disconnection
    ws.on('close', () => {
        clients.delete(clientId);
        console.log(`Client disconnected: ${clientId}`);
    });
});

// Handle outgoing messages from client
async function handleClientMessage(data, clientId) {
    try {
        const { contactId, text } = data;
        if (!contactId || typeof contactId !== 'string' ) {
    throw new Error(`Invalid Instagram recipient ID: ${contactId}`);
}

        // Create temporary message for UI
        const tempMsg = {
            id: `temp-${Date.now()}`,
            contactId,
            text: getMessageText(text),
            direction: 'outgoing',
            timestamp: new Date(),
            status: 'sending'
        };

        // Store temporarily
        if (!messages.has(contactId)) messages.set(contactId, []);
        messages.get(contactId).push(tempMsg);

        // Broadcast to all clients
        broadcast({
            type: 'message',
            message: tempMsg
        });

        // Send via WhatsApp API
        const response = await sendWhatsAppMessage(contactId, text);
        
        // Update with real message ID and status
        const realMsg = {
            ...tempMsg,
            id: response.messages[0].id,
            status: 'sent'
        };

        // Update in storage
        const contactMessages = messages.get(contactId);
        const msgIndex = contactMessages.findIndex(m => m.id === tempMsg.id);
        if (msgIndex !== -1) contactMessages[msgIndex] = realMsg;

        // Broadcast update
        broadcast({
            type: 'message',
            message: realMsg
        });

    } catch (error) {
        console.error('Error sending message:', error);
        const ws = clients.get(clientId);
        if (ws) {
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Failed to send message'
            }));
        }
    }
}

// WhatsApp API functions
async function sendWhatsAppMessage(contactId, text) {
    const response = await axios.post(
        `https://graph.facebook.com/${configInstagrame.apiVersion}/${configInstagrame.ig_busness_id}/messages`,
        {
            messaging_product: 'instagram',
          recipient:{id:contactId },
            // type: 'text',
            text: { body: text }
        },
        {
            headers: {
                'Authorization': `Bearer ${configInstagrame.PAGEaccessToken}`,
                'Content-Type': 'application/json'
            }
        },
    );
    return response.data;
}

async function markMessageAsRead(messageId) {
    try {
        await axios.post(
        `https://graph.facebook.com/${configInstagrame.apiVersion}/${configInstagrame.ig_busness_id}/messages`,
           {
            messaging_product: 'instagram',
          recipient:{id:contactId },
            type: 'text',
            text: { body: messageId }
        },
            {
               headers: {
                'Authorization': `Bearer ${configInstagrame.PAGEaccessToken}`,
                'Content-Type': 'application/json'
            }
            }
        );
    } catch (error) {
        console.error('Error marking message as read:', error.response?.data || error.message);
    }
}

// Broadcast to all connected clients
function broadcast(data) {
    const message = JSON.stringify(data);
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Webhook URL: ${process.env.NEXT_PUBLIC_APP_URL}/webhook`);
});