require("dotenv").config();

const express = require("express");
const { cert, initializeApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const Stripe = require("stripe");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
app.get("/", (req, res) => {
    res.send("Smart Parking Payment Backend is running.");
});
// =====================================================
// FIREBASE CONNECTION
// =====================================================

const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : require("./serviceAccountKey.json");

const firebaseApp = initializeApp({
    credential: cert(serviceAccount),
    databaseURL: "https://smartparkingemployeeapp-default-rtdb.asia-southeast1.firebasedatabase.app"
});

const db = getDatabase(firebaseApp);

// =====================================================
// EMPLOYEE PAYMENT SETTINGS
// =====================================================

const EMPLOYEE_UID = "B3 9E 68 10";
const MONTHLY_FEE_SEN = 5000;


// =====================================================
// GET CURRENT MALAYSIA DATE
// =====================================================

function getMalaysiaDate()
{
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kuala_Lumpur",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(new Date());

    const values = {};

    for (const part of parts)
    {
        values[part.type] = part.value;
    }

    return `${values.year}-${values.month}-${values.day}`;
}


// =====================================================
// ADD ONE CALENDAR MONTH
// =====================================================

function addOneMonth(dateString)
{
    const [year, month, day] =
        dateString.split("-").map(Number);

    const nextMonth = month === 12 ? 1 : month + 1;

    const nextYear = month === 12 ? year + 1 : year;

    const lastDay = new Date(
        Date.UTC(nextYear, nextMonth, 0)
    ).getUTCDate();

    const finalDay = Math.min(day, lastDay);

    return `${nextYear}-${String(nextMonth).padStart(2, "0")}-${String(finalDay).padStart(2, "0")}`;
}

// =====================================================
// STRIPE WEBHOOK - RAW BODY
// =====================================================

app.post(
    "/webhook",
    express.raw({ type: "application/json" }),
    async (req, res) => {

        let event;

        try {
            const signature = req.headers["stripe-signature"];

            event = stripe.webhooks.constructEvent(
                req.body,
                signature,
                process.env.STRIPE_WEBHOOK_SECRET
            );

        } catch (error) {
            console.error("Stripe webhook verification failed:", error.message);

            return res.status(400).send(
                `Webhook Error: ${error.message}`
            );
        }

        console.log("Verified Stripe event:", event.type);

       
        // =====================================================
        // PROCESS SUCCESSFUL STRIPE PAYMENT
        // =====================================================

        try
        {
            // Only process completed Checkout Sessions

            if (event.type !== "checkout.session.completed")
            {
                return res.json({ received: true });
            }

            const session = event.data.object;

            // Check successful payment

            if (session.payment_status !== "paid")
            {
                console.log("Payment is not completed yet.");
                return res.json({ received: true });
            }

            // Check payment mode and amount

            if (
                session.mode !== "payment" ||
                session.amount_total !== MONTHLY_FEE_SEN ||
                session.currency !== "myr"
            )
            {
                console.error("Payment amount or currency is incorrect.");

                return res.status(400).send(
                    "Invalid payment amount or currency"
                );
            }

            // Get employee and payment information

            const today = getMalaysiaDate();

            const notificationKey =
                db.ref("notifications").push().key;

            const timestamp = Date.now();

            // Update Firebase safely

            const result = await db.ref().transaction(
                (data) =>
                {
                    if (!data)
                    {
                        return;
                    }

                    data.processedStripeEvents =
                        data.processedStripeEvents || {};

                    // Prevent duplicate payment processing

                    if (data.processedStripeEvents[event.id])
                    {
                        return;
                    }

                    const employee =
                        data.employees?.[EMPLOYEE_UID];

                    if (!employee)
                    {
                        return;
                    }

                    // Check whether existing permit is active

                    const isActive =
                        employee.permitStatus === "ACTIVE" &&
                        typeof employee.expiryDate === "string" &&
                        employee.expiryDate >= today;

                    // Decide the starting date

                    const baseDate = isActive
                        ? employee.expiryDate
                        : today;

                    // Calculate new expiry date

                    const newExpiryDate =
                        addOneMonth(baseDate);

                    // Update employee information

                    employee.paymentStatus = "PAID";
                    employee.permitStatus = "ACTIVE";
                    employee.expiryDate = newExpiryDate;
                    employee.lastPaymentDate = today;
                    employee.updatedAt = timestamp;

                    // Create payment notification

                    data.notifications =
                        data.notifications || {};

                    data.notifications[notificationKey] = {
                        employeeUID: EMPLOYEE_UID,
                        type: "PAYMENT_SUCCESS",
                        message: "Your RM50 monthly parking payment was successful. Your permit is now active.",
                        date: today,
                        timestamp: timestamp
                    };

                    // Record processed Stripe event

                    data.processedStripeEvents[event.id] = {
                        checkoutSessionId: session.id,
                        processedAt: timestamp
                    };

                    return data;
                },
                undefined,
                false
            );

            // Check transaction result

            if (!result.committed)
            {
                const processedSnapshot =
                    await db.ref(
                        `processedStripeEvents/${event.id}`
                    ).once("value");

                if (processedSnapshot.exists())
                {
                    console.log("Duplicate Stripe event ignored.");

                    return res.json({
                        received: true,
                        duplicate: true
                    });
                }

                console.error("Employee record not found.");

                return res.status(500).send(
                    "Employee record not found"
                );
            }

            console.log("--------------------------------");
            console.log("PAYMENT SUCCESSFUL");
            console.log("Employee:", EMPLOYEE_UID);
            console.log("Amount: RM50");
            console.log("Payment Status: PAID");
            console.log("Permit Status: ACTIVE");
            console.log("New Expiry:", result.snapshot
                .child(`employees/${EMPLOYEE_UID}/expiryDate`)
                .val());
            console.log("--------------------------------");

            return res.json({
                received: true,
                paymentProcessed: true
            });
        }
        catch (error)
        {
            console.error(
                "Payment processing error:",
                error.message
            );

            return res.status(500).send(
                "Payment processing failed"
            );
        }

    }
);

// =====================================================
// EXPRESS JSON MIDDLEWARE
// =====================================================

app.use(express.json());


// =====================================================
// SERVER
// =====================================================
const PORT = process.env.PORT || 4242;


app.listen(PORT, async () => 
{
    console.log("================================");
    console.log("Smart Parking Payment Backend");
    console.log("Server running on port " + PORT);
    console.log("================================");

    try {
        const snapshot = await db
            .ref("employees")
            .child(EMPLOYEE_UID)
            .once("value");

        console.log("FIREBASE EMPLOYEE CHECK:", snapshot.exists());
        console.log("FIREBASE EMPLOYEE DATA:", snapshot.val());

        // NEW ROOT DATABASE TEST
        const rootSnapshot = await db.ref("/").once("value");

        console.log("ROOT DATABASE EXISTS:", rootSnapshot.exists());
        console.log("ROOT EMPLOYEES:", rootSnapshot.child("employees").val());

    } catch (error) {
        console.error("FIREBASE READ ERROR:", error.message);
    }
});
