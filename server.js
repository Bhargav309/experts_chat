import express from "express";
import path from "path";
import { processQuery } from "./retrieval.js";

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.resolve("./")));

app.post("/chat", async (req, res) => {
  const { question, conv_history = [] } = req.body;

  if (!question?.trim()) {
    return res.status(400).json({ error: "No question provided" });
  }

  try {
    const { answer, updatedHistory } = await processQuery(question, conv_history);
    res.json({ answer, conv_history: updatedHistory });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});