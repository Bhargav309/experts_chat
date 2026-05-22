import express from "express";
import path from "path";
import { processQuery } from "./retrieval.mjs";

const app = express();

// -------------------- Middleware --------------------
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.resolve("./")));

// -------------------- Session Store --------------------
const sessions = {};

// ======================================================
// CHAT ENDPOINT
// ======================================================
app.post("/chat", async (req, res) => {
  try {
    const { question, session_id } = req.body || {};

    // ---------------- Validation ----------------
    if (!question?.trim()) {
      return res.status(400).json({
        error: "No question provided",
      });
    }

    if (!session_id) {
      return res.status(400).json({
        error: "No session ID provided",
      });
    }

    // ---------------- Create session if missing ----------------
    let session = sessions[session_id];

    if (!session) {
      session = sessions[session_id] = {
        history: [],
        memory: null,
        lastSeen: Date.now(),
      };
    }

    session.lastSeen = Date.now();

    const { history, memory } = session;

    // ---------------- Process query ----------------
    const {
      answer,
      compressedHistory,
      memoryState,
    } = await processQuery(
      question,
      history,
      memory
    );

    /*
      IMPORTANT:
      Session may have been deleted while
      processQuery() was running.
    */

    if (sessions[session_id]) {
      sessions[session_id].history =
        compressedHistory;

      sessions[session_id].memory =
        memoryState;

      sessions[session_id].lastSeen =
        Date.now();
    }

    return res.json({
      answer,
    });

  } catch (err) {
    console.error("Chat error:", err);

    return res.status(500).json({
      error:
        "Something went wrong. Please try again.",
    });
  }
});

// ======================================================
// RESET SESSION
// Handles:
// - fetch(...)
// - axios(...)
// - navigator.sendBeacon(...)
// ======================================================
app.post(
  "/chat/reset",
  express.text({ type: "*/*" }),
  (req, res) => {
    try {
      let session_id = null;

      // JSON body
      if (
        typeof req.body === "object" &&
        req.body !== null
      ) {
        session_id = req.body.session_id;
      }

      // sendBeacon body
      else if (typeof req.body === "string") {
        try {
          const parsed =
            JSON.parse(req.body);

          session_id =
            parsed.session_id;
        } catch {
          session_id = null;
        }
      }

      if (
        session_id &&
        sessions[session_id]
      ) {
        delete sessions[session_id];

        console.log(
          `Session cleared: ${session_id}`
        );
      }

      return res.json({
        ok: true,
      });

    } catch (err) {
      console.error(
        "Reset error:",
        err
      );

      return res.status(500).json({
        error:
          "Failed to reset session",
      });
    }
  }
);

// ======================================================
// AUTO CLEANUP OLD SESSIONS
// Removes inactive sessions after 1 hour
// ======================================================
const SESSION_TIMEOUT =
  1000 * 60 * 60; // 1 hour

setInterval(() => {
  const now = Date.now();

  for (const id in sessions) {
    const session =
      sessions[id];

    if (
      now - session.lastSeen >
      SESSION_TIMEOUT
    ) {
      delete sessions[id];

      console.log(
        `Expired session removed: ${id}`
      );
    }
  }

  console.log(
    `Active sessions: ${
      Object.keys(sessions).length
    }`
  );

}, 1000 * 60 * 10); // every 10 min

// ======================================================
// START SERVER
// ======================================================
const PORT = 3001;

app.listen(PORT, () => {
  console.log(
    `Server running on http://localhost:${PORT}`
  );
});