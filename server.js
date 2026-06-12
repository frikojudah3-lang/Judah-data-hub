const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config(); // Loads values from your secure .env file

const app = express();

app.use(express.json());
// Serves static files directly out of the public folder
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// CONFIGURATION KEYS - DRIVEN BY ENVIRONMENT
// ==========================================
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || 'YOUR_PAYSTACK_SECRET_KEY';
const HUBNET_API_KEY = process.env.HUBNET_API_KEY || 'YOUR_HUBNET_API_KEY';
const LIVE_DOMAIN = process.env.LIVE_DOMAIN || 'https://your-tunnel.ngrok-free.app';
const ADMIN_PHONE = process.env.ADMIN_PHONE || '0240000000'; // Fallback admin alert line

/**
 * 1. INITIATE PAYMENT ROUTE
 */
app.post('/api/initiate-payment', async (req, res) => {
    try {
        const { phone, network, volume, amount, provider } = req.body;

        if (!phone || !network || !volume || !amount || !provider) {
            return res.status(400).json({ success: false, message: "Missing required transaction fields." });
        }

        // Paystack handles payments in minor units (Pesewas) -> GHS 4.80 becomes 480
        const amountInPesewas = Math.round(parseFloat(amount) * 100);
        const customReference = 'TX-' + crypto.randomBytes(6).toString('hex').toUpperCase();

        const paystackPayload = {
            amount: amountInPesewas,
            email: `customer-${phone}@frikodata.com`,
            currency: "GHS",
            reference: customReference,
            mobile_money: {
                phone: phone,
                provider: provider // 'mtn', 'tigo', or 'vodafone'
            },
            // Match our backend normalization schema strings safely
            metadata: { phone, volume, network } 
        };

        await axios.post('https://api.paystack.co/charge', paystackPayload, {
            headers: {
                Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        return res.status(200).json({ success: true, message: "USSD Prompt sent successfully!", reference: customReference });

    } catch (error) {
        console.error("Paystack Error:", error.response ? error.response.data : error.message);
        return res.status(500).json({ success: false, message: "Failed to fire mobile money prompt." });
    }
});

/**
 * 2. SECURE WEBHOOK LISTENER
 */
app.post('/api/paystack-webhook', async (req, res) => {
    // Instantly return 200 to Paystack so they don't timeout trying to talk to us
    res.sendStatus(200);

    try {
        const paystackSignature = req.headers['x-paystack-signature'];
        const calculatedHash = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(JSON.stringify(req.body)).digest('hex');

        if (calculatedHash !== paystackSignature) {
            console.error("⚠️ Security Alert: Unauthorized Webhook Signature!");
            return;
        }

        const event = req.body;

        if (event.event === 'charge.success') {
            const txData = event.data;
            const metadata = txData.metadata;

            const recipientPhone = metadata.phone;
            const bundleVolume = metadata.volume;     // Data size string (in MB, e.g. "1000")
            const inputNetwork = metadata.network;     // The clean input string from frontend
            const transactionRef = txData.reference;

            console.log(`💰 Payment Confirmed via Paystack! Reference: ${transactionRef}`);

            // Fire off the delivery process asynchronously using our resilient core engine
            dispatchHubnetBundle(inputNetwork, bundleVolume, recipientPhone, transactionRef);
        }

    } catch (webhookError) {
        console.error("❌ Webhook execution framework crashed:", webhookError.message);
    }
});

/**
 * 3. RESILIENT HUBNET DATA DISPATCH ENGINE
 * Built completely on guidelines from Documentation Sections 9 & 10
 */
async function dispatchHubnetBundle(networkStr, volumeMb, phone, referenceCode, retryCount = 0) {
    // Precise dynamic mapping matching PHP Sample (page 8)
    const networkMap = {
        'MTN': 'mtn',
        'AT': 'at',
        'AirtelTigo': 'at',
        'Telecel': 'telecel',
        'BigTime': 'big-time'
    };

    const cleanNetworkSlug = networkMap[networkStr] || 'mtn';
    const hubnetUrl = `https://console.hubnet.app/live/api/context/business/transaction/${cleanNetworkSlug}-new-transaction`;

    const hubnetPayload = {
        phone: phone,
        volume: String(volumeMb), // Must be passed as an explicit string (page 3)
        reference: referenceCode,
        referrer: ADMIN_PHONE,    // Phone number to receive SMS notifications (page 3)
        webhook: `${LIVE_DOMAIN}/api/hubnet-callback` // CRITICAL REQUIRED PARAMETER FIX
    };

    try {
        console.log(`📡 Hitting Hubnet URL: ${hubnetUrl} [Attempt #${retryCount + 1}]`);

        const response = await axios.post(hubnetUrl, hubnetPayload, {
            headers: {
                'token': `Bearer ${HUBNET_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000 // 30 seconds connection timeout requirement (page 8)
        });

        const result = response.data;

        // Process status rules mapped out on Page 5 & 6
        if (result.status === true && result.message === '0000') {
            console.log(`✅ Success: Bundle queued by Hubnet. Tx ID: ${result.transaction_id}`);
            return;
        }

        // Structural error code recovery from Section 9 Documentation page
        if (result.message === '1004') {
            console.warn(`🔄 Error 1004: Duplicate reference detected. Appending random hash and retrying...`);
            const newRef = `${referenceCode}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
            return await dispatchHubnetBundle(networkStr, volumeMb, phone, newRef, retryCount);
        }

        if (result.message === '1005') {
            console.error(`🚨 Error 1005: Out of Funds! Insufficient wallet balance on Hubnet account.`);
            return;
        }

    } catch (error) {
        console.error(`💥 Hubnet Communication Error:`, error.message);

        // Capture documentation Section 10 Rate limiting code block (Page 10)
        if (error.response && error.response.data && error.response.data.message === '1007') {
            console.error("⏳ Error 1007: Rate limit tripped (5 reqs/min). Cooling down for 60 seconds...");
            await new Promise(resolve => setTimeout(resolve, 60000));
            return await dispatchHubnetBundle(networkStr, volumeMb, phone, referenceCode, retryCount);
        }

        // Section 9: Exponential Back-off delay rule implementation for timeouts or HTTP 5xx codes
        if (retryCount < 3) {
            const backoffDelays = [1000, 2000, 4000]; // 1 second, 2 seconds, 4 seconds delays
            const currentDelay = backoffDelays[retryCount] || 4000;

            console.log(`⚠️ Network layer failure. Backing off for ${currentDelay}ms before retry...`);
            await new Promise(resolve => setTimeout(resolve, currentDelay));
            
            return await dispatchHubnetBundle(networkStr, volumeMb, phone, referenceCode, retryCount + 1);
        } else {
            console.error(`🛑 System Failure: All 3 dispatch retries exhausted for order ${referenceCode}.`);
        }
    }
}

/**
 * 4. HUBNET DELIVERY RESOLUTION CALLBACK
 * Listens for Hubnet to tell us if the network dropped the bundle successfully (Page 4)
 */
app.post('/api/hubnet-callback', (req, res) => {
    res.sendStatus(200); // Always respond immediately to Hubnet

    const { event, data } = req.body;

    if (event === 'transfer.delivered') {
        console.log(`🎉 Ultimate Success: Bundle delivered directly to client handset! Number: ${data.msisdn}, Vol: ${data.volume}MB`);
    } else if (event === 'transfer.processing') {
        console.log(`⏳ Hubnet Status Update: Transaction ${data.reference} is actively hitting the cell tower.`);
    }
});

// Replace your old app.listen block at the very bottom of server.js with this:
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`🚀 Store Backend Engine Active on Port: ${PORT}`);

    try {
        const localtunnel = require('localtunnel');
        // Automatically creates a secure public tunnel gateway for port 3000
        const tunnel = await localtunnel({ port: PORT });

        console.log(`\n==================================================`);
        console.log(`🌐 YOUR LIVE INTERNET WEBHOOK ADDRESS IS:`);
        console.log(`👉 ${tunnel.url}`);
        console.log(`==================================================\n`);

        // Handle tunnel connection drops gracefully
        tunnel.on('close', () => {
            console.log('📡 Tunnel closed down.');
        });

    } catch (tunnelError) {
        console.error('⚠️ Could not open public tunnel automatically:', tunnelError.message);
    }
});
