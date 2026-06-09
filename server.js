const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());
app.use(express.static("."));

const API_KEY = "PUT_YOUR_NEW_API_KEY_HERE";
const BASE_URL = "https://console.hubnet.app";

const orders = {};

/* ---------------- PRICE ---------------- */
function getPrice(bundle) {
    const prices = {
        "1GB": 5,
        "2GB": 10,
        "3GB": 15,
        "4GB": 20,
        "5GB": 25,
        "10GB": 50,
        "15GB": 70,
    };

    return prices[bundle] || 5;
}

/* ---------------- PHONE FORMAT ---------------- */
function formatPhone(phone) {
    phone = phone.toString().trim();

    if (phone.startsWith("0")) {
        return "233" + phone.slice(1);
    }

    if (phone.startsWith("233")) {
        return phone;
    }

    return phone;
}

/* ---------------- PAY REQUEST ---------------- */
app.post("/pay", async (req, res) => {
    const { phone, network, bundle } = req.body;

    console.log("PAY REQUEST:", req.body);

    const reference = "FDH" + Date.now();

    orders[reference] = {
        phone,
        network,
        bundle
    };

    try {
        const response = await axios.post(
            `${BASE_URL}/api/v1/transaction`,
            {
                phone: formatPhone(phone),
                network: network.toUpperCase(),
                amount: getPrice(bundle),
                reference: reference,

                // Change this AFTER deploying
                callback_url: "http://localhost:3000/callback"
            },
            {
                headers: {
                    Authorization: `Bearer ${API_KEY}`,
                    "Content-Type": "application/json"
                }
            }
        );

        console.log("HUBNET RESPONSE:", response.data);

        res.json({
            success: true,
            reference,
            message: "Check your phone to approve payment"
        });

    } catch (err) {
        console.log(
            "HUBNET ERROR:",
            err.response?.data || err.message
        );

        res.status(500).json({
            success: false,
            error: err.response?.data || err.message
        });
    }
});

/* ---------------- CALLBACK ---------------- */
app.post("/callback", async (req, res) => {
    console.log("CALLBACK RECEIVED:", req.body);

    const data = req.body;
    const reference = data.reference;

    if (data.status === "success") {
        const order = orders[reference];

        if (order) {
            await sendBundle(order.phone, order.bundle);
            console.log("Bundle sent successfully");
        } else {
            console.log("Order not found:", reference);
        }
    }

    res.send("OK");
});

/* ---------------- SEND BUNDLE ---------------- */
async function sendBundle(phone, bundle) {
    try {
        const response = await axios.post(
            `${BASE_URL}/bundle/send`,
            {
                phone,
                bundle
            },
            {
                headers: {
                    Authorization: `Bearer ${API_KEY}`
                }
            }
        );

        console.log("BUNDLE RESPONSE:", response.data);

    } catch (err) {
        console.log(
            "BUNDLE ERROR:",
            err.response?.data || err.message
        );
    }
}

/* ---------------- HOME PAGE ---------------- */
app.get("/", (req, res) => {
    res.sendFile(__dirname + "/index.html");
});

/* ---------------- START SERVER ---------------- */
app.listen(3000, () => {
    console.log("Server running on port 3000");
});
