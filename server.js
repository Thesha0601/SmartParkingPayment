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


// =====================================================
// STRIPE WEBHOOK - RAW BODY
// =====================================================

app.post(
    "/webhook",
    express.raw({ type: "application/json" }),
    async (req, res) => {

        let event;

        // -------------------------------------------------
        // VERIFY STRIPE SIGNATURE
        // -------------------------------------------------

        try {
            const signature = req.headers["stripe-signature"];

            event = stripe.webhooks.constructEvent(
                req.body,
                signature,
                process.env.STRIPE_WEBHOOK_SECRET
            );

        } catch (error) {
            console.error(
                "Stripe webhook verification failed:",
                error.message
            );

            return res.status(400).send(
                `Webhook Error: ${error.message}`
            );
        }

        console.log("Verified Stripe event:", event.type);

        try {

            // -------------------------------------------------
            // ONLY PROCESS COMPLETED CHECKOUT SESSIONS
            // -------------------------------------------------

            if (event.type !== "checkout.session.completed") {
                return res.json({ received: true });
            }

            const session = event.data.object;

            if (session.payment_status !== "paid") {
                console.log("Payment is not completed yet.");
                return res.json({ received: true });
            }

            // -------------------------------------------------
            // VALIDATE PAYMENT
            // -------------------------------------------------

            if (
                session.mode !== "payment" ||
                session.amount_total !== MONTHLY_FEE_SEN ||
                session.currency !== "myr"
            ) {
                console.error("Payment amount or currency is incorrect.");

                return res.status(400).send(
                    "Invalid payment amount or currency"
                );
            }

            // -------------------------------------------------
            // STRIPE EVENT ID - DUPLICATE PROTECTION
            // -------------------------------------------------

            const timestamp = Date.now();

            const eventRef = db.ref(
                `processedStripeEvents/${event.id}`
            );

            // Claim this event before processing it.
            // A stale claim can be retried after 2 minutes.

            const claimResult = await eventRef.transaction(
                (current) => {

                    if (
                        current &&
                        (
                            current.status === "COMPLETED" ||
                            current.processedAt
                        )
                    ) {
                        return;
                    }

                    if (
                        current &&
                        current.status === "PROCESSING" &&
                        timestamp - (current.claimedAt || 0) < 120000
                    ) {
                        return;
                    }

                    return {
                        status: "PROCESSING",
                        claimedAt: timestamp,
                        checkoutSessionId: session.id
                    };
                },
                undefined,
                false
            );

            // -------------------------------------------------
            // CHECK WHETHER THIS EVENT WAS ALREADY PROCESSED
            // -------------------------------------------------

            if (!claimResult.committed) {

                const existingEvent =
                    await eventRef.once("value");

                const existingData = existingEvent.val();

                if (
                    existingData &&
                    (
                        existingData.status === "COMPLETED" ||
                        existingData.processedAt
                    )
                ) {
                    console.log("Duplicate Stripe event ignored.");

                    return res.json({
                        received: true,
                        duplicate: true
                    });
                }

                console.log("Stripe event is already being processed.");

                return res.status(500).send(
                    "Payment event is currently being processed. Retry later."
                );
            }

            // -------------------------------------------------
            // READ ONLY THE EMPLOYEE RECORD
            // -------------------------------------------------

            const employeeRef = db
                .ref("employees")
                .child(EMPLOYEE_UID);

            const employeeSnapshot =
                await employeeRef.once("value");

            if (!employeeSnapshot.exists()) {

                console.error("Employee record not found.");

                await eventRef.remove();

                return res.status(500).send(
                    "Employee record not found"
                );
            }

            const employee = employeeSnapshot.val();

            const today = getMalaysiaDate();

            // -------------------------------------------------
            // PREVENT REPEATING AN ALREADY APPLIED PAYMENT
            // -------------------------------------------------

            const alreadyApplied =
                employee.lastProcessedStripeEventId === event.id;

            let newExpiryDate = employee.expiryDate;

            if (!alreadyApplied) {

                const isActive =
                    employee.permitStatus === "ACTIVE" &&
                    typeof employee.expiryDate === "string" &&
                    employee.expiryDate >= today;

                const baseDate = isActive
                    ? employee.expiryDate
                    : today;

                newExpiryDate = addOneMonth(baseDate);
            }

            // -------------------------------------------------
            // CREATE PAYMENT NOTIFICATION
            // -------------------------------------------------

            const notificationKey = `payment_${event.id}`;

            const notification = {
                employeeUID: EMPLOYEE_UID,
                type: "PAYMENT_SUCCESS",
                message: "Your RM50 monthly parking payment was successful. Your permit is now active.",
                date: today,
                timestamp: timestamp
            };

            // -------------------------------------------------
            // UPDATE ONLY REQUIRED FIREBASE PATHS
            // -------------------------------------------------

            const updates = {};

            if (!alreadyApplied) {

                updates[
                    `employees/${EMPLOYEE_UID}/paymentStatus`
                ] = "PAID";

                updates[
                    `employees/${EMPLOYEE_UID}/permitStatus`
                ] = "ACTIVE";

                updates[
                    `employees/${EMPLOYEE_UID}/expiryDate`
                ] = newExpiryDate;

                updates[
                    `employees/${EMPLOYEE_UID}/lastPaymentDate`
                ] = today;

                updates[
                    `employees/${EMPLOYEE_UID}/updatedAt`
                ] = timestamp;

                updates[
                    `employees/${EMPLOYEE_UID}/lastProcessedStripeEventId`
                ] = event.id;
            }

            // Create or recover the notification.
            updates[
                `notifications/${notificationKey}`
            ] = notification;

            // Mark the Stripe event as completed.
            updates[
                `processedStripeEvents/${event.id}`
            ] = {
                status: "COMPLETED",
                checkoutSessionId: session.id,
                processedAt: timestamp
            };

            // One atomic update. Other Firebase paths are untouched.
            await db.ref().update(updates);

            // -------------------------------------------------
            // SUCCESS LOG
            // -------------------------------------------------

            console.log("--------------------------------");
            console.log("PAYMENT SUCCESSFUL");
            console.log("Employee:", EMPLOYEE_UID);
            console.log("Amount: RM50");
            console.log("Payment Status: PAID");
            console.log("Permit Status: ACTIVE");
            console.log("New Expiry:", newExpiryDate);
            console.log("--------------------------------");

            return res.json({
                received: true,
                paymentProcessed: true
            });

        } catch (error) {

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
