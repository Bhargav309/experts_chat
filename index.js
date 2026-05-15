const chatContainer = document.getElementById("chatbot-conversation-container");
const userInput = document.getElementById("user-input");
const form = document.querySelector(".input-container");

// Conversation history maintained client-side and sent with every request
let convHistory = [];

function addMessage(text, sender) {
  const bubble = document.createElement("div");
  bubble.classList.add("speech", sender === "human" ? "speech-human" : "speech-ai");

  // Render **bold** markdown-style formatting
  bubble.innerHTML = text
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");

  chatContainer.appendChild(bubble);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function addTypingIndicator() {
  const indicator = document.createElement("div");
  indicator.classList.add("speech", "speech-ai", "typing-indicator");
  indicator.id = "typing";
  indicator.innerHTML = `<span></span><span></span><span></span>`;
  chatContainer.appendChild(indicator);
  chatContainer.scrollTop = chatContainer.scrollHeight;
  return indicator;
}

function removeTypingIndicator() {
  document.getElementById("typing")?.remove();
}

async function sendMessage(question) {
  addMessage(question, "human");
  userInput.value = "";
  userInput.disabled = true;

  const indicator = addTypingIndicator();

  try {
    const response = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, conv_history: convHistory }),
    });

    const data = await response.json();
    removeTypingIndicator();

    if (data.error) {
      addMessage("Sorry, something went wrong. Please try again.", "ai");
    } else {
      addMessage(data.answer, "ai");
      // Update conversation history with what the server returned
      convHistory = data.conv_history;
    }
  } catch (err) {
    removeTypingIndicator();
    addMessage("Connection error. Is the server running?", "ai");
  }

  userInput.disabled = false;
  userInput.focus();
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const question = userInput.value.trim();
  if (!question) return;
  sendMessage(question);
});

// Welcome message on load
