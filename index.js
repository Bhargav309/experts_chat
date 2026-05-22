const chatContainer = document.getElementById("chatbot-conversation-container");
const userInput = document.getElementById("user-input");
const form = document.querySelector(".input-container");

// Create a completely fresh session every page load
let SESSION_ID = crypto.randomUUID();

// Add chat bubble
function addMessage(text, sender) {
  const bubble = document.createElement("div");

  bubble.classList.add(
    "speech",
    sender === "human" ? "speech-human" : "speech-ai"
  );

  // Basic markdown formatting
  bubble.innerHTML = text
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");

  chatContainer.appendChild(bubble);

  // Auto-scroll
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

// Typing animation
function addTypingIndicator() {
  const indicator = document.createElement("div");

  indicator.classList.add(
    "speech",
    "speech-ai",
    "typing-indicator"
  );

  indicator.id = "typing";

  indicator.innerHTML = `
    <span></span>
    <span></span>
    <span></span>
  `;

  chatContainer.appendChild(indicator);

  chatContainer.scrollTop = chatContainer.scrollHeight;
}

// Remove typing animation
function removeTypingIndicator() {
  document.getElementById("typing")?.remove();
}

// Send message to backend
async function sendMessage(question) {
  // Show user message immediately
  addMessage(question, "human");

  // Clear input
  userInput.value = "";

  // Disable while waiting
  userInput.disabled = true;

  // Show typing
  addTypingIndicator();

  try {
    const response = await fetch("/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        question,
        session_id: SESSION_ID,
      }),
    });

    const data = await response.json();

    // Remove typing animation
    removeTypingIndicator();

    // Handle errors
    if (data.error) {
      addMessage(
        "Sorry, something went wrong. Please try again.",
        "ai"
      );
    } else {
      addMessage(data.answer, "ai");
    }
  } catch (error) {
    console.error(error);

    removeTypingIndicator();

    addMessage(
      "Connection error. Is the server running?",
      "ai"
    );
  }

  // Re-enable input
  userInput.disabled = false;

  // Focus input again
  userInput.focus();
}

// Form submit
form.addEventListener("submit", (e) => {
  e.preventDefault();

  const question = userInput.value.trim();

  if (!question) return;

  sendMessage(question);
});

// Cleanup session on refresh/tab close
window.addEventListener("beforeunload", () => {
  navigator.sendBeacon(
    "/chat/reset",
    JSON.stringify({
      session_id: SESSION_ID,
    })
  );
});

// Optional welcome message
// addMessage("Hello! How can I help you today?", "ai");