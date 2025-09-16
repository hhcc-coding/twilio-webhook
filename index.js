// server.js
import express from "express";
import bodyParser from "body-parser";
import pkg from "twilio";
import fetch from "node-fetch";
import { GoogleAuth } from "google-auth-library";
import { google } from "googleapis";
import dotenv from "dotenv";
dotenv.config();

//console.log(process.env.HOME_URL);

async function getDialogflowToken() {
  const auth = new GoogleAuth({
    keyFile: "credentials/dialogflow-key.json",
    scopes: ["https://www.googleapis.com/auth/dialogflow"]
  });
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  return tokenResponse.token;
}

// ✅ Calendar helper
async function createCalendarEvent({ name, phone, date, time, address }) {
  const auth = new GoogleAuth({
    keyFile: "credentials/dialogflow-key.json",
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });

  const client = await auth.getClient();
  const calendar = google.calendar({ version: "v3", auth: client });

  //console.log("🗓️ Creating event with:", { name, phone, date, time, address });

  const datePart = date.split("T")[0];
  const timePart = time.split("T")[1];
  const startTime = `${datePart}T${timePart}`;
  const endTime = new Date(startTime);
  endTime.setHours(endTime.getHours() + 1);

  const event = {
    summary: "Cleaning Appointment",
    description: `Booked via phone bot.
    Name: ${name || "Unknown"}
    Phone: ${phone || "Unknown"}
    Address: ${address || "Not provided"}`,
    start: {
      dateTime: startTime,
      timeZone: "America/New_York",
    },
    end: {
      dateTime: endTime.toISOString(),
      timeZone: "America/New_York",
    },
  };

  const response = await calendar.events.insert({
    calendarId: "hiltonheadcleaningco@gmail.com",
    resource: event,
  });

  //console.log("📅 Event created:", response.data.htmlLink);
  return response.data;
}

const { twiml } = pkg;
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// in-memory session store
const sessions = {};

// 🔹 Root
app.get("/", (req, res) => {
  res.send("Twilio Dialogflow Bot is running ✅");
});

// 🔹 Incoming calls
app.post("/voice", (req, res) => {
  const caller = req.body.From;
  if (!sessions[caller]) {
    sessions[caller] = { name: null, phone: caller, date: null, time: null, address: null };
  }

  const twimlResponse = new twiml.VoiceResponse();

  const gather = twimlResponse.gather({
    input: "speech dtmf",
    numDigits: 1,
    action: `${process.env.HOME_URL}/process_speech`,
    speechTimeout: "auto",
    timeout: 5,
  });

  gather.say(
    "Hello! Welcome to Hilton Head Cleaning Company. How can we help you today? " +
    "For booking a cleaning appointment, just say your first name. " +
    "Or press 0 anytime to speak to a live agent."
  );

  res.type("text/xml");
  res.send(twimlResponse.toString());
});

// 🔹 IRL assistant transfer
app.post("/connect_to_agent", (req, res) => {
  const twimlResponse = new twiml.VoiceResponse();
  twimlResponse.say("Connecting you to a live assistant. Please hold.");
  twimlResponse.dial(process.env.AGENT_PHONE_NUMBER || "+15555555555"); // Set this number in .env
  res.type("text/xml");
  res.send(twimlResponse.toString());
});

// 🔹 Handle speech or DTMF input
app.post("/process_speech", async (req, res) => {
  const userSpeech = req.body.SpeechResult || "";
  const dtmf = req.body.Digits || "";
  const caller = req.body.From;

  if (!sessions[caller]) sessions[caller] = { phone: caller };

  // 🔸 Check if user pressed 0 to talk to agent
  if (dtmf === "0") {
    const twimlResponse = new twiml.VoiceResponse();
    twimlResponse.redirect(`${process.env.HOME_URL}/connect_to_agent`);
    res.type("text/xml");
    return res.send(twimlResponse.toString());
  }

  const token = await getDialogflowToken();
  //console.log("🔊 Caller said:", userSpeech);

  let botReply = "Sorry, I had trouble understanding you.";

  try {
    const dialogflowResponse = await fetch(
      "https://dialogflow.googleapis.com/v2/projects/cleaning-service-bot/agent/sessions/12345:detectIntent",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          queryInput: {
            text: { text: userSpeech, languageCode: "en-US" }
          }
        })
      }
    );

    const result = await dialogflowResponse.json();
    //console.log("🤖 Dialogflow raw response:", result);

    const queryResult = result.queryResult || {};
    botReply = queryResult.fulfillmentText || botReply;

    // ✅ Closure
    if (queryResult.intent?.displayName === "Closure") {
      const twimlResponse = new twiml.VoiceResponse();
      twimlResponse.say("Thank you for calling Hilton Head Cleaning Company, goodbye!");
      twimlResponse.hangup();
      res.type("text/xml");
      return res.send(twimlResponse.toString());
    }

    // ✅ Capture name
    if (queryResult.intent?.displayName === "GetName") {
      const name = queryResult.parameters?.name;
      if (name) {
        sessions[caller].name = name;
        botReply = `Thanks ${name}. Can you tell me the date, time, and address for your cleaning appointment? ` +
                   `Or press 0 to speak to a live agent.`;
      }
    }

    // ✅ Booking
    if (queryResult.intent?.displayName === "BookCleaning") {
      const params = queryResult.parameters || {};
      sessions[caller].date = params.date || null;
      sessions[caller].time = params.time || null;
      sessions[caller].address = params.address || "No address provided";

      const { name, phone, date, time, address } = sessions[caller];

      if (date && time && address && name) {
        try {
          await createCalendarEvent({ name, phone, date, time, address });

          botReply = `Perfect ${name}. Your booking info was saved. Expect a call soon for confirmation.`;
        } catch (err) {
          console.error("❌ Error creating calendar event:", err);
          botReply = "I got your booking details but couldn’t save it to the calendar.";
        }
      } else {
        botReply = "I still need some details. Please provide the date, time, and address for your cleaning.";
      }
    }

  } catch (err) {
    console.error("❌ Error talking to Dialogflow:", err);
  }

  // 🔹 Default flow
  const twimlResponse = new twiml.VoiceResponse();
  twimlResponse.say(botReply);
  twimlResponse.gather({
    input: "speech dtmf",
    numDigits: 1,
    action: `${process.env.HOME_URL}/process_speech`,
    speechTimeout: "auto",
    timeout: 5,
  });

  res.type("text/xml");
  res.send(twimlResponse.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
