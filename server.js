const express = require("express");

const app = express();

// =====================================================
// STRIPE
// =====================================================


// =====================================================
// BLYNK
// =====================================================

const BLYNK_AUTH_TOKEN = process.env.BLYNK_AUTH_TOKEN;




// =====================================================
// EXPRESS
// =====================================================

app.use(express.json());


// =====================================================
// UPDATE BLYNK
// =====================================================

async function updateBlynk(pin, value)
{
    const url =
        `https://blynk.cloud/external/api/update?token=${BLYNK_AUTH_TOKEN}&${pin}=${encodeURIComponent(value)}`;

    try
    {
        const response = await fetch(url);

        const text = await response.text();

        console.log("--------------------------------");
        console.log(`Blynk ${pin} = ${value}`);
        console.log(`HTTP Status: ${response.status}`);
        console.log(`Response: ${text}`);
        console.log("--------------------------------");

        return response.ok;
    }
    catch (error)
    {
        console.error(
            `Error updating Blynk ${pin}:`,
            error.message
        );

        return false;
    }
}


// =====================================================
// INITIAL PAYMENT / PERMIT STATE
// =====================================================

async function setupPaymentSystem()
{
    console.log("");
    console.log("================================");
    console.log("SETTING UP PAYMENT SYSTEM");
    console.log("================================");


    // ================================================
    // EMPLOYEE ID
    // ================================================

    await updateBlynk(
        "v16",
        "B3 9E 68 10"
    );


    // ================================================
    // MONTHLY FEE
    // ================================================

    await updateBlynk(
        "v17",
        "50.00"
    );


    // ================================================
    // PAYMENT STATUS
    // ================================================

    await updateBlynk(
        "v18",
        "UNPAID"
    );


    // ================================================
    // PERMIT STATUS
    // ================================================

    await updateBlynk(
        "v20",
        "EXPIRED"
    );


    // ================================================
    // EXPIRY DATE
    // ================================================

    const expiryDate = "26/08/2026";

    await updateBlynk(
        "v21",
        expiryDate
    );


    // ================================================
    // EXPIRED NOTIFICATION
    // ================================================

    const notificationUrl =
        `https://blynk.cloud/external/api/logEvent` +
        `?token=${BLYNK_AUTH_TOKEN}` +
        `&code=permit_expired` +
        `&description=${encodeURIComponent(
            "Your employee parking permit has expired. Please renew your permit."
        )}`;

    try
    {
        const response =
            await fetch(notificationUrl);

        console.log("--------------------------------");
        console.log("Permit expired notification sent");
        console.log("HTTP Status:", response.status);
        console.log("--------------------------------");
    }
    catch (error)
    {
        console.error(
            "Error sending expired notification:",
            error.message
        );
    }


    console.log("");
    console.log("================================");
    console.log("PAYMENT SYSTEM READY");
    console.log("Employee ID    : B3 9E 68 10");
    console.log("Monthly Fee    : RM50.00");
    console.log("Payment Status : UNPAID");
    console.log("Permit Status  : EXPIRED");
    console.log("Expiry Date    : 26/08/2026");
    console.log("================================");
}


// =====================================================
// RENEW EXPIRY DATE
// =====================================================

function renewExpiryDate()
{
    // Current demo expiry date

    let expiryDay = 26;
    let expiryMonth = 8;
    let expiryYear = 2026;


    // Add one month

    expiryMonth++;


    if (expiryMonth > 12)
    {
        expiryMonth = 1;
        expiryYear++;
    }


    const day =
        String(expiryDay).padStart(2, "0");

    const month =
        String(expiryMonth).padStart(2, "0");


    return `${day}/${month}/${expiryYear}`;
}


// =====================================================
// STRIPE WEBHOOK
// =====================================================

app.post("/webhook", async (req, res) =>
{
    const event = req.body;


    console.log("");
    console.log("================================");
    console.log("STRIPE EVENT RECEIVED");
    console.log("Event Type:", event.type);
    console.log("================================");


    // =================================================
    // CHECKOUT PAYMENT COMPLETED
    // =================================================

    if (event.type === "checkout.session.completed")
    {
        const session =
            event.data.object;


        console.log("");
        console.log("================================");
        console.log("PAYMENT SUCCESSFUL");
        console.log("Checkout Session:");
        console.log(session.id);
        console.log("================================");


        // =============================================
        // CREATE NEW EXPIRY DATE
        // =============================================

        const newExpiryDate =
            renewExpiryDate();


        console.log("");
        console.log("Updating Blynk...");
        console.log("V18 = PAID");
        console.log("V20 = ACTIVE");
        console.log("V21 =", newExpiryDate);


        // =============================================
        // UPDATE PAYMENT STATUS
        // =============================================

        const paymentUpdated =
            await updateBlynk(
                "v18",
                "PAID"
            );


        // =============================================
        // UPDATE PERMIT STATUS
        // =============================================

        const permitUpdated =
            await updateBlynk(
                "v20",
                "ACTIVE"
            );


        // =============================================
        // UPDATE EXPIRY DATE
        // =============================================

        const expiryUpdated =
            await updateBlynk(
                "v21",
                newExpiryDate
            );


        // =============================================
        // PAYMENT SUCCESS NOTIFICATION
        // =============================================

        const notificationUrl =
            `https://blynk.cloud/external/api/logEvent` +
            `?token=${BLYNK_AUTH_TOKEN}` +
            `&code=payment_success` +
            `&description=${encodeURIComponent(
                "Payment successful. Your employee parking permit has been renewed."
            )}`;


        let notificationUpdated = false;


        try
        {
            const response =
                await fetch(notificationUrl);

            notificationUpdated =
                response.ok;

            console.log("--------------------------------");
            console.log("Payment success notification sent");
            console.log(
                "HTTP Status:",
                response.status
            );
            console.log("--------------------------------");
        }
        catch (error)
        {
            console.error(
                "Error sending payment notification:",
                error.message
            );
        }


        // =============================================
        // CHECK RESULTS
        // =============================================

        console.log("");


        if (
            paymentUpdated &&
            permitUpdated &&
            expiryUpdated &&
            notificationUpdated
        )
        {
            console.log("================================");
            console.log("BLYNK UPDATED SUCCESSFULLY");
            console.log("Payment Status : PAID");
            console.log("Permit Status  : ACTIVE");
            console.log(
                "Expiry Date    :",
                newExpiryDate
            );
            console.log("Notification   : SENT");
            console.log("================================");
        }
        else
        {
            console.log("================================");
            console.log("BLYNK UPDATE PARTIALLY FAILED");

            console.log(
                "V18:",
                paymentUpdated ? "OK" : "FAILED"
            );

            console.log(
                "V20:",
                permitUpdated ? "OK" : "FAILED"
            );

            console.log(
                "V21:",
                expiryUpdated ? "OK" : "FAILED"
            );

            console.log(
                "Notification:",
                notificationUpdated ? "OK" : "FAILED"
            );

            console.log("================================");
        }
    }


    // =================================================
    // SEND RESPONSE TO STRIPE
    // =================================================

    res.json({
        received: true
    });
});

// =====================================================
// RESET PAYMENT FOR DEMO
// =====================================================

app.get("/reset-payment", async (req, res) => {
    try {
        await updateBlynk("v18", "UNPAID");
        await updateBlynk("v20", "EXPIRED");
        await updateBlynk("v21", "26/08/2026");

        console.log("Payment reset to UNPAID");

        res.send("Payment reset successfully: UNPAID / EXPIRED");
    } catch (error) {
        console.error("Reset payment error:", error);
        res.status(500).send("Failed to reset payment");
    }
});
// =====================================================
// TEST BLYNK CONNECTION
// =====================================================

app.get("/test-blynk", async (req, res) =>
{
    const result =
        await updateBlynk(
            "v18",
            "TEST"
        );


    if (result)
    {
        res.send(
            "Blynk test successful"
        );
    }
    else
    {
        res.status(500).send(
            "Blynk test failed"
        );
    }
});


// =====================================================
// SERVER
// =====================================================

app.listen(4242, async () =>
{
    console.log("================================");
    console.log("Smart Parking Payment Backend");
    console.log("Server running on port 4242");
    console.log("================================");


    // Setup initial payment/permit state

    await setupPaymentSystem();
});
