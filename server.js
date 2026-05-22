import express from "express";
import path from "path";
import { processQuery } from "./retrieval.mjs";

const app = express();

// Middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.resolve("./")));

// In-memory session store
const sessions = {};

// Chat endpoint
app.post("/chat", async (req, res) => {
  try {
    const { question, session_id } = req.body || {};

    // Validation
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

    // Create session if missing
    if (!sessions[session_id]) {
      sessions[session_id] = {
        history: [],
        memory: null,
      };
    }

    const { history, memory } = sessions[session_id];

    // Process query
    const {
      answer,
      updatedHistory,
      memoryState,
    } = await processQuery(
      question,
      history,
      memory
    );

    // Save updated session state
    sessions[session_id].history = updatedHistory;
    sessions[session_id].memory = memoryState;

    // Return response
    res.json({ answer });

  } catch (err) {
    console.error("Chat error:", err);

    res.status(500).json({
      error: "Something went wrong. Please try again.",
    });
  }
});

// Reset endpoint
// Handles BOTH normal JSON requests and sendBeacon text/plain requests
app.post("/chat/reset", express.text({ type: "*/*" }), (req, res) => {
  try {
    let session_id = null;

    // Case 1: JSON body
    if (typeof req.body === "object" && req.body !== null) {
      session_id = req.body.session_id;
    }

    // Case 2: sendBeacon text body
    else if (typeof req.body === "string") {
      try {
        const parsed = JSON.parse(req.body);
        session_id = parsed.session_id;
      } catch {
        session_id = null;
      }
    }

    // Delete session if exists
    if (session_id && sessions[session_id]) {
      delete sessions[session_id];

      console.log(`Session cleared: ${session_id}`);
    }

    res.json({ ok: true });

  } catch (err) {
    console.error("Reset error:", err);

    res.status(500).json({
      error: "Failed to reset session",
    });
  }
});

// Optional cleanup for abandoned sessions
// Runs every hour
setInterval(() => {
  console.log(
    `Active sessions: ${Object.keys(sessions).length}`
  );
}, 1000 * 60 * 60);

// Start server
app.listen(3001, () => {
  console.log("Server running on http://localhost:3001");
});