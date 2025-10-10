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
let speechTries = 0;

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
    input: "dtmf speech",
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

    switch (intentName) {
      case "GetName":
        if (params.name) {
          session.name = params.name;
          botReply = `Thanks ${session.name}. What date, time, and address should we book for your ${session.service} cleaning?`;
          session.speechTries = 0; // progress made → reset counter
        } else {
          session.speechTries++;
        }
        break;

      case "BookCleaning":
        // extract all possible booking details
        session.date = params.date || session.date || null;
        session.time = params.time || session.time || null;
        session.address = params.address || session.address || null;

        // check completeness
        const allFieldsPresent =
          session.name && session.date && session.time && session.address && session.service;

        if (allFieldsPresent) {
          try {
            await createCalendarEvent(session);
            botReply = `Perfect ${session.name}, your ${session.service} booking has been saved. We’ll call you soon to confirm.`;
            session.speechTries = 0; // reset
          } catch {
            botReply = "I got your details but couldn’t save it to the calendar.";
          }
        } else {
          session.speechTries++;
          botReply = "I still need the date, time, or address. Could you please provide that?";
        }
        break;

      case "Closure":
        const closureResponse = new twiml.VoiceResponse();
        closureResponse.say("Thank you for calling Hilton Head Cleaning Company. Goodbye!");
        closureResponse.hangup();
        res.type("text/xml");
        return res.send(closureResponse.toString());
    }
  } catch (err) {
    console.error("❌ Dialogflow error:", err);
    botReply = "Sorry, I’m having some trouble processing that.";
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
