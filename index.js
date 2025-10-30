// index.js
import express from "express";
import bodyParser from "body-parser";
import pkg from "twilio";
import fetch from "node-fetch";
import { GoogleAuth } from "google-auth-library";
import { google } from "googleapis";
import dotenv from "dotenv";
dotenv.config();

const { twiml } = pkg;
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const sessions = {}; // In-memory sessions
let inputTries = 0;

// ✅ Dialogflow helper
async function getDialogflowToken() {
  const dialogflowKey = JSON.parse(process.env.DIALOGFLOW_KEY);
  const auth = new GoogleAuth({
    credentials: dialogflowKey,
    scopes: ["https://www.googleapis.com/auth/dialogflow"],
  });
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  return tokenResponse.token;
}

// ✅ Calendar helper
async function createCalendarEvent({ name, phone, date, time, address, service }) {
  const dialogflowKey = JSON.parse(process.env.DIALOGFLOW_KEY);
  const auth = new GoogleAuth({
    credentials: dialogflowKey,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  const client = await auth.getClient();
  const calendar = google.calendar({ version: "v3", auth: client });

  const datePart = date.split("T")[0];
  const timePart = time.split("T")[1];
  const startTime = `${datePart}T${timePart}`;
  const endTime = new Date(startTime);
  endTime.setHours(endTime.getHours() + 1);

  const event = {
    summary: `${service || "Cleaning"} Appointment`,
    description: `Booked via phone bot.
    Service: ${service}
    Name: ${name || "Unknown"}
    Phone: ${phone || "Unknown"}
    Address: ${address || "Not provided"}`,
    start: { dateTime: startTime, timeZone: "America/New_York" },
    end: { dateTime: endTime.toISOString(), timeZone: "America/New_York" },
  };

  const response = await calendar.events.insert({
    calendarId: "hiltonheadcleaningco@gmail.com",
    resource: event,
  });
  return response.data;
}

// 🔹 Root
app.get("/", (req, res) => res.send("Twilio Dialogflow Bot is running ✅"));

// 🔹 Incoming call → Service Menu
app.post("/voice", (req, res) => {
  const caller = req.body.From;
  if (!sessions[caller]) {
    sessions[caller] = { phone: caller, name: null, service: null, date: null, time: null, address: null };
  }

  const response = new twiml.VoiceResponse();
  const gather = response.gather({
    input: "dtmf",
    numDigits: 1,
    action: `${process.env.HOME_URL}/select_service`,
    speechTimeout: "auto",
    timeout: 5,
  });

  gather.say(
    "Welcome to Hilton Head Cleaning Company. " +
    "Press 1 for Airbnb cleaning, 2 for handyman services, 3 for residential cleaning, or 4 for commercial cleaning. " +
    "Or press 0 anytime to speak to a live agent."
  );

  // 🔹 Fallback if no input detected
  response.say("I didn’t get any input. Let me repeat...");
  response.redirect(`${process.env.HOME_URL}/voice`);

  res.type("text/xml");
  res.send(response.toString());
});

// 🔹 Handle service selection
app.post("/select_service", (req, res) => {
  const caller = req.body.From;
  const dtmf = req.body.Digits || "";
  const session = sessions[caller];


  let service = null;
  switch (dtmf) {
    case "1": service = "Airbnb"; break;
    case "2": service = "Handyman"; break;
    case "3": service = "Residential"; break;
    case "4": service = "Commercial"; break;
    case "0":
      const agentResponse = new twiml.VoiceResponse();
      agentResponse.redirect(`${process.env.HOME_URL}/connect_to_agent`);
      res.type("text/xml");
      return res.send(agentResponse.toString());
  }

  if (service) {
    session.service = service;
  }

  const response = new twiml.VoiceResponse();
  const gather = response.gather({
    input: "speech dtmf",
    numDigits: 1,
    action: `${process.env.HOME_URL}/process_speech`,
    speechTimeout: "auto",
    timeout: 5,
  });

  if (service) {
    gather.say(`Great, you selected ${service} cleaning. Can I have your first name please?`);
  } else {
    gather.say("Sorry, I didn’t get it, can you please say it again?");
    inputTries++;
  }

  // fallback for no response
  if (inputTries <= 2) {
    response.redirect(`${process.env.HOME_URL}/select_service`);
  }
  else {
    inputTries = 0;
    response.say("I’m still having trouble understanding. Let me connect you to a live agent.");
    response.redirect(`${process.env.HOME_URL}/connect_to_agent`);
  }


  res.type("text/xml");
  res.send(response.toString());
});

// Test - route for receiving OTPs
app.post("/receive_otp", (req, res) => {
  const response = new twiml.VoiceResponse();

  response.dial("+18433045481" || "+15555555555");

  // Send TwiML response back to Twilio
  res.type("text/xml");
  res.send(twiml.toString());
});

// 🔹 Connect to live agent
app.post("/connect_to_agent", (req, res) => {
  const response = new twiml.VoiceResponse();
  response.say("Connecting you to a live assistant. Please hold.");
  response.dial(process.env.AGENT_PHONE_NUMBER || "+15555555555");
  res.type("text/xml");
  res.send(response.toString());
});

// 🔹 Process name/date/time/address via Dialogflow
app.post("/process_speech", async (req, res) => {
  const userSpeech = req.body.SpeechResult || "";
  const dtmf = req.body.Digits || "";
  const caller = req.body.From;
  const session = sessions[caller] || (sessions[caller] = { phone: caller });

  // Initialize speechTries per caller
  session.speechTries = session.speechTries || 0;

  // Agent override
  if (dtmf === "0") {
    const response = new twiml.VoiceResponse();
    response.redirect(`${process.env.HOME_URL}/connect_to_agent`);
    res.type("text/xml");
    return res.send(response.toString());
  }

  let botReply = "Sorry, I didn’t catch that.";

  try {
    const token = await getDialogflowToken();
    const dialogflowResponse = await fetch(
      "https://dialogflow.googleapis.com/v2/projects/cleaning-service-bot/agent/sessions/12345:detectIntent",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          queryInput: { text: { text: userSpeech, languageCode: "en-US" } },
        }),
      }
    );

    const result = await dialogflowResponse.json();
    const queryResult = result.queryResult || {};
    const intentName = queryResult.intent?.displayName;
    const params = queryResult.parameters || {};

    // 🧠 Default bot reply
    botReply = queryResult.fulfillmentText || botReply;

    function nextMissing() {
      if (!session.date) return "date";
      if (!session.time) return "time";
      if (!session.address) return "address";
      return null;
    }

    function formatDateForSpeech(dateStr) {
      try {
        const date = new Date(dateStr);
        return date.toLocaleDateString("en-US", {
          weekday: "long",
          month: "long",
          day: "numeric"
        });
      } catch {
        return dateStr;
      }
    }

    function formatTimeForSpeech(timeStr) {
      try {
        // Split into parts like "HH:mm:ss"
        const [hours, minutes] = timeStr.split(":").map(Number);
        if (isNaN(hours)) return timeStr;

        // Build a local Date with today's date but that time
        const now = new Date();
        const local = new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate(),
          hours,
          minutes
        );

        return local.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit"
        });
      } catch {
        return timeStr;
      }
    }



    // Start of switch statement
    switch (intentName) {
      case "GetName":
        if (params.name) {
          session.name = params.name;
          session.speechTries = 0;
          // If we already have service, move to date; otherwise prompt for service
          if (session.service) {
            session.awaiting = "date";
            botReply = `Thanks ${session.name}. What date should we book your ${session.service} cleaning for?`;
          } else {
            botReply = `Thanks ${session.name}. What type of cleaning would you like?`;
          }
        } else {
          session.speechTries++;
          botReply = "Could I please get your name?";
        }
        break;

      // If user supplies service earlier in the flow
      case "GetServiceType":
        if (params.service_type) {
          session.service = params.service_type;
          session.speechTries = 0;
          session.awaiting = "date";
          botReply = `Got it — a ${session.service} cleaning. What date works best for you?`;
        } else {
          session.speechTries++;
          botReply = "Please tell me which cleaning service you want.";
        }
        break;

      // User gave a date
      case "GetDate":
        if (params.date) {
          session.date = params.date;
          session.speechTries = 0;
          // next ask time
          session.awaiting = "time";
          const spokenDate = formatDateForSpeech(session.date);
          botReply = `Great — ${spokenDate}. What time would you prefer?`;
        } else {
          session.speechTries++;
          botReply = "I didn't catch the date. What date would you like?";
        }
        break;

      // User gave a time
      case "GetTime":
        if (params.time) {
          session.time = params.time;
          session.speechTries = 0;
          // next ask address
          session.awaiting = "address";
          const spokenTime = formatTimeForSpeech(session.time);
          botReply = `Thanks. We'll plan for ${spokenTime}. Could you give me the address for the appointment?`;
        } else {
          session.speechTries++;
          botReply = "I didn't catch the time. What time works best for you?";
        }
        break;

      // User gave the address
      case "GetAddress":
        if (params.address) {
          session.address = params.address;
          session.speechTries = 0;
          session.awaiting = null; // all collected (for now)
          // Confirm everything before creating the calendar event
          const spokenDate = formatDateForSpeech(session.date);
          const spokenTime = formatTimeForSpeech(session.time);
          botReply = `Got it. Just to confirm, ${session.name}, you want a ${session.service} cleaning on ${spokenDate} at ${spokenTime} at ${session.address}. Is that correct?`;

        } else {
          session.speechTries++;
          botReply = "Please tell me the full address for the cleaning.";
        }
        break;

      // Confirm booking: yes/no flow
      case "ConfirmBooking":
        // Interpret user's raw speech for confirm/deny
        if (/^\s*(yes|yeah|yep|correct|that's right|that is correct|sure)\b/i.test(userSpeech)) {
          // Try to create calendar event
          const allFieldsPresent =
            session.name && session.date && session.time && session.address && session.service;
          if (allFieldsPresent) {
            try {
              await createCalendarEvent(session);
              const spokenDate = formatDateForSpeech(session.date);
              const spokenTime = formatTimeForSpeech(session.time);
              botReply = `Perfect ${session.name}, your ${session.service} appointment is booked for ${spokenDate} at ${spokenTime}. We’ll call you soon to confirm.`;
              session.speechTries = 0;
              session.awaiting = null;
            } catch (e) {
              console.error("Calendar save error:", e);
              botReply = "I got your details but couldn’t save them to the calendar.";
            }
          } else {
            // Missing something — ask for the next missing field
            const missingNow = nextMissing();
            session.awaiting = missingNow;
            session.speechTries++;
            botReply = missingNow
              ? `Okay — I still need the ${missingNow}. Could you provide the ${missingNow}?`
              : "I’m missing some details. Could you repeat the date, time, or address?";
          }
        } else if (/^\s*(no|nah|nope|change|incorrect|wrong)\b/i.test(userSpeech)) {
          // Let user correct — ask which field to change (date/time/address)
          session.speechTries = 0;
          session.awaiting = "date"; // default to date first; you can tune this
          botReply = "No problem — which part would you like to change? (date, time, or address)";
        } else {
          session.speechTries++;
          botReply = "Please say yes to confirm or no to make changes.";
        }
        break;

      case "Closure":
        const closureResponse = new twiml.VoiceResponse();
        closureResponse.say("Thank you for calling Hilton Head Cleaning Company. Goodbye!  ");
        closureResponse.hangup();
        res.type("text/xml");
        return res.send(closureResponse.toString());
    }
  } catch (err) {
    console.error("❌ Dialogflow error:", err);
    botReply = "Sorry, I’m having some trouble processing that.";
    session.speechTries++;
  }

  if (
    botReply.toLowerCase().includes("sorry, i didn’t catch that") ||
    botReply.toLowerCase().includes("sorry, i didn't catch that")
  ) {
    session.speechTries++;
  }


  // 🔹 Prepare next prompt
  const response = new twiml.VoiceResponse();
  const gather = response.gather({
    input: "speech dtmf",
    numDigits: 1,
    action: `${process.env.HOME_URL}/process_speech`,
    speechTimeout: "auto",
    timeout: 6,
  });
  gather.say(botReply);

  // 🔹 Retry or escalate logic
  if (session.speechTries < 3) {
    // Let the gather repeat if still missing info
    response.redirect(`${process.env.HOME_URL}/process_speech`);
  } else {
    // Escalate to live agent after 3 failed attempts
    session.speechTries = 0;
    response.say("I’m still having trouble understanding. Let me connect you to a live agent.");
    response.redirect(`${process.env.HOME_URL}/connect_to_agent`);
  }

  res.type("text/xml");
  res.send(response.toString());
});

// Handle SIP Domain INVITES (outbound from Zoiper/Bria)
app.post('/sip-calls', (req, res) => {
  let dialedNumber = req.body.To;
  // console.log(dialedNumber)

  // Force into E.164 if user dials without +1
  if (dialedNumber && !dialedNumber.startsWith('+')) {
    dialedNumber = '+1' + dialedNumber.replace(/\D/g, '');
  }

  const response = new twiml.VoiceResponse();
  response.dial({ callerId: '+18436040666' }, dialedNumber);

  res.type('text/xml');
  res.send(response.toString());
});



const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
