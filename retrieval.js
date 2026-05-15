import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

// ---------- CLIENTS ----------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const deepseek = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ---------- DOMAIN MAP ----------
const DOMAIN_MAP = `
AVAILABLE EXPERT DATA:
- overview: name, type, partner tier, rating, review count, description
- location_contact: city, country, supported countries, languages, email, phone, website, social media
- pricing: starting price, price range (e.g. "$20 to $1000", "starting from $20")
- industries: clothing/fashion, food/drink, health/beauty, jewelry/accessories, electronics, etc.
- primary_service: service name + detailed description + price
- secondary_services: list of additional services offered
- featured_work: past project title + description + URL
- capabilities: LLM-synthesized summary of what the expert has proven experience building
- review: reviewer name, service, communication/quality/overall ratings, written review

FILTERABLE FIELDS: country, supported_countries, languages, industries, services, rating, chunk_type
`.trim();

// ---------- MASTER SYSTEM RULES ----------
const MASTER_RULES = `
You are a Shopify expert search and recommendation engine.

Your job:
Help users find the most relevant Shopify experts using ONLY retrieved expert evidence.

STRICT RULES:
- Never invent capabilities, pricing, languages, industries, reviews, experience, or countries.
- Never assume support unless explicitly evidenced.
- Distinguish:

Explicit evidence:
Directly stated

Inferred evidence:
Likely but not confirmed

Missing evidence:
No strong proof

- Prefer:
"No strong evidence found"
over guessing.

- Prioritize precision over recall.
- Never recommend irrelevant experts.
- If no exact match exists:
    explain closest alternatives
    explain missing requirements

- Keep answers:
concise
structured
scan-friendly
factual

- Respect active memory constraints.
- Preserve confirmed constraints unless changed.
`.trim();

// ---------- SCENARIO PROMPTS ----------
const SCENARIO_PROMPTS = {

  recommendation: `
You are a Shopify expert recommendation engine.
${DOMAIN_MAP}

Your job: Recommend the best matching expert(s) for the user's request.
- Lead with the capabilities chunk if available — it tells you what they have actually built
- Mention specific services, industries, and featured works that match the request
- Include starting price and rating
- If multiple experts match, compare them side by side
- If no expert is a perfect match, suggest the closest ones and explain what they cover and what they don't
- Never say "no results found" — always suggest something
- Show maximum 5 experts using this card format per expert:
  [Expert Name]
  - Match Reason:
  - Capabilities:
  - Industries:
  - Languages:
  - Pricing:
  - Strong Evidence:
  - Missing Evidence / Gaps:
`.trim(),

  pricing: `
You are a Shopify expert pricing advisor.
${DOMAIN_MAP}

Your job: Answer pricing questions about the specific expert(s) the user asked about.

STRICT RULES:
- Answer ONLY about the expert(s) the user asked about — never introduce others unprompted
- Answer ONLY in the context of what the user is asking about — if they asked about a handcraft store, show only store build pricing
- NEVER produce comparison tables or lists of other experts unless the user explicitly asks to compare
- Pricing data will appear as "$X-$Y", "starting from $X", "price range: $X to $Y", or "min $X max $Y" — state it clearly
- Do NOT say pricing is unavailable or suggest contacting the expert if any price figure is present
- Only say to contact the expert if truly zero price data exists
`.trim(),

  reviews: `
You are analyzing Shopify expert reputation and customer feedback.
${DOMAIN_MAP}

Your job: Summarize what customers say about the expert(s).
- Highlight patterns across reviews (recurring praise or complaints)
- Mention specific ratings: communication, quality, overall
- Quote themes from reviews, not just scores
- If few reviews exist, note that and mention overall rating
- If no reviews found, mention their rating score and partner tenure as proxies for trust
`.trim(),

  capabilities: `
You are explaining what a Shopify expert is capable of building.
${DOMAIN_MAP}

Your job: Describe the expert's proven experience and skills.
- Lead with the capabilities chunk — this is the synthesized experience summary
- Back it up with specific featured works that demonstrate those capabilities
- Mention industries they specialize in
- Connect their services to what the user is trying to build
- If capabilities chunk is missing, synthesize from featured works and services directly
`.trim(),

  location: `
You are filtering Shopify experts by location and language.
${DOMAIN_MAP}

Your job: Answer location/language/country-based queries precisely.
- State where the expert is based
- List supported countries clearly
- Mention languages spoken
- If the user needs a specific country/language and no exact match exists, suggest the closest alternative and flag the gap
`.trim(),

  aggregation: `
You are answering a factual count or list query about Shopify experts.
${DOMAIN_MAP}

Your job: Give a direct, factual answer.
- State the count clearly
- List expert names and their specific languages from the EXPERT DETAILS provided
- Answer directly — do NOT say "data does not specify" if language info is present
- If the count is zero, suggest relaxing the filter
- Be concise — no fluff
`.trim(),

  comparison: `
You are comparing Shopify experts objectively.
${DOMAIN_MAP}

Your job: Compare experts on the requested dimensions only.
- Highlight tradeoffs
- Avoid declaring a universal winner unless evidence is overwhelming
- Mention missing evidence clearly
- Use side-by-side comparison structure
- Comparison areas: capabilities, pricing, reviews, industries, communication, technical complexity
`.trim(),

  smalltalk: `
You are a friendly assistant for a Shopify expert directory.
Respond naturally to greetings and small talk.
Keep it brief. Don't mention experts unless asked.
`.trim(),

  no_match: `
You are explaining why no exact Shopify expert match was found.
${DOMAIN_MAP}

Rules:
- Explain WHICH requirement caused failure
- Preserve hard constraints unless relaxing explicitly
- Suggest closest alternatives carefully and explain what is missing
- Never pretend a near match is an exact match
`.trim(),
};

// ---------- CHUNK TYPE MAP ----------
const CHUNK_TYPE_MAP = {
  pricing:      ["pricing", "primary_service", "overview"],
  location:     ["location_contact"],
  reviews:      ["review", "overview"],
  capabilities: ["capabilities", "featured_work", "primary_service"],
};

// ============================================================
// PROMPT PIPELINE FUNCTIONS
// ============================================================

// 1. CLASSIFY / INTENT DETECTION
async function classifyQuery(query) {
  const completion = await deepseek.chat.completions.create({
    model: "deepseek-chat",
    messages: [
      {
        role: "system",
        content: `You classify user queries into one of these types:
- "recommendation"  — someone describing their business, product, or goal and wanting expert suggestions.
  e.g. "I want to build a store for pickles", "looking for someone for my fashion brand", "I'm a businessman who needs a website"
  NOTE: queries describing a business need are ALWAYS recommendation, never aggregation

- "comparison"      — explicitly comparing two or more named experts side by side

- "aggregation"     — ONLY pure counting or listing with explicit attribute filters like country, language, industry.
  e.g. "how many experts from india", "list experts who speak hindi", "how many support clothing"
  NOT: "find me someone who builds websites" — that is recommendation

- "list_all"        — listing ALL experts with no filter (e.g. "show me all experts")

- "specific_expert" — asking about a named expert's reviews, services, capabilities or feedback

- "pricing"         — asking about cost, price, rates, budget

- "reviews"         — asking about reputation, reviews, feedback, ratings, trustworthiness

- "capabilities"    — asking what an expert can build, their experience, past work, portfolio

- "location"        — filtering by country, city, language, supported regions

- "follow_up"       — short refinements referencing previous results: "any cheaper?", "only english?", "what about reviews?"

- "smalltalk"       — greetings, personal info, off-topic
  CRITICAL: personal name introductions are ALWAYS smalltalk.
  e.g. "name is bhargav", "my name is john" — user telling you their own name is NOT asking about an expert.

Reply with ONLY the type. Nothing else.`,
      },
      { role: "user", content: query },
    ],
  });
  return completion.choices[0].message.content.trim().toLowerCase();
}

// 2. CONVERSATIONAL MEMORY RESOLVER
async function resolveMemoryState(query, conversationHistory, previousMemory = null) {
  const memoryJson = previousMemory ? JSON.stringify(previousMemory, null, 2) : "{}";
  const completion = await deepseek.chat.completions.create({
    model: "deepseek-chat",
    messages: [
      {
        role: "system",
        content: `You maintain active search constraints for a Shopify expert search engine.

Previous Active Constraints:
${memoryJson}

Rules:
- Preserve previously confirmed constraints unless changed
- Add newly stated constraints
- Remove constraints only if the user explicitly changes or removes them
- Convert vague budget wording: cheap → low budget, premium → high budget, startup → budget conscious
- Follow-up refinements should narrow previous results

Return ONLY valid JSON:
{
  "hard_constraints": {
    "country": [],
    "languages": [],
    "services": [],
    "industries": [],
    "required_capabilities": []
  },
  "soft_preferences": {
    "budget": "",
    "strong_reviews": false,
    "fast_communication": false
  }
}`,
      },
      ...conversationHistory,
      { role: "user", content: query },
    ],
  });
  try {
    const text = completion.choices[0].message.content.trim();
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    return {
      hard_constraints: { country: [], languages: [], services: [], industries: [], required_capabilities: [] },
      soft_preferences: { budget: "", strong_reviews: false, fast_communication: false },
    };
  }
}

// 3. CLARIFICATION DETECTOR
async function detectClarification(query, conversationHistory, memoryState) {
  const completion = await deepseek.chat.completions.create({
    model: "deepseek-chat",
    messages: [
      {
        role: "system",
        content: `Determine if clarification is needed before Shopify expert retrieval.

Rules:
- Ask at most ONE question (the highest-impact missing detail)
- Do not ask for information already known from: ${JSON.stringify(memoryState)}
- Prefer questions that significantly improve retrieval precision
- For most queries with a clear service or industry, no clarification is needed
Priority Order: 1. service type  2. industry  3. country/language  4. budget  5. technical requirements

Examples:
"I need help with my store" → needs_clarification: true (too vague)
"I need someone for fashion store setup" → needs_clarification: false
"I'm a businessman" → needs_clarification: true (ask about service type)

Return ONLY valid JSON:
{
  "needs_clarification": false,
  "question": ""
}`,
      },
      ...conversationHistory,
      { role: "user", content: query },
    ],
  });
  try {
    const text = completion.choices[0].message.content.trim();
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    return { needs_clarification: false, question: "" };
  }
}

// 4. HARD FILTER EXTRACTION
async function extractHardFilters(query, conversationHistory, memoryState) {
  const completion = await deepseek.chat.completions.create({
    model: "deepseek-chat",
    messages: [
      {
        role: "system",
        content: `Extract explicit hard constraints from the query.

Memory State: ${JSON.stringify(memoryState)}

Rules:
- Only include EXPLICITLY stated requirements — do not infer
- Merge with existing memory state constraints (do not drop them)
- Languages are hard constraints ONLY if explicitly requested
- Budget is NEVER a hard constraint unless explicitly strict
- For aggregation queries also extract: country, supported_countries, languages, industries, services

Return ONLY valid JSON:
{
  "country": null,
  "supported_countries": null,
  "languages": null,
  "industries": null,
  "services": null,
  "budget_limit": null
}`,
      },
      ...conversationHistory,
      { role: "user", content: query },
    ],
  });
  try {
    const text = completion.choices[0].message.content.trim();
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    // Merge memory state hard constraints
    const mc = memoryState?.hard_constraints || {};
    if (!parsed.country && mc.country?.length) parsed.country = mc.country.join(", ");
    if (!parsed.languages && mc.languages?.length) parsed.languages = mc.languages.join(", ");
    if (!parsed.industries && mc.industries?.length) parsed.industries = mc.industries.join(", ");
    if (!parsed.services && mc.services?.length) parsed.services = mc.services.join(", ");
    return parsed;
  } catch {
    return { country: null, supported_countries: null, languages: null, industries: null, services: null, budget_limit: null };
  }
}

// 5. SEMANTIC QUERY EXPANSION
async function expandSemanticQuery(query) {
  const completion = await deepseek.chat.completions.create({
    model: "deepseek-chat",
    messages: [
      {
        role: "system",
        content: `Expand the user's ecommerce request into semantically related Shopify concepts.

Rules:
- Keep expansions tightly relevant
- Include service synonyms, industry synonyms, related ecommerce terminology
- Focus on Shopify/ecommerce meaning — do not introduce unrelated industries
- Return ONLY a comma-separated list of expansion terms

Examples:
"sports kits website" -> sportswear ecommerce, apparel store, fashion ecommerce, shopify clothing store
"plain clothes" -> clothing, fashion, apparel, garments, fashion ecommerce
"modern handcrafted lifestyle brand" -> handcrafted products, artisan brands, lifestyle ecommerce, traditional products`,
      },
      { role: "user", content: query },
    ],
  });
  return completion.choices[0].message.content.trim();
}

// 6. RETRIEVAL STRATEGY PLANNER
async function planRetrievalStrategy(queryType, hasHistoryExperts, filters) {
  const hasFilters = filters && Object.values(filters).some((v) => v && v !== "null");

  if (queryType === "follow_up" && hasHistoryExperts) return "expert_followup_search";
  if (queryType === "specific_expert" || queryType === "reviews" || queryType === "capabilities") {
    return hasHistoryExperts ? "expert_followup_search" : "semantic_search";
  }
  if (queryType === "aggregation" || queryType === "list_all") {
    return hasFilters ? "hard_filter_search" : "plain_aggregation";
  }
  if (hasFilters && hasHistoryExperts) return "expert_followup_search";
  if (hasFilters) return "hybrid_search";
  return "semantic_search";
}

// 7. EXPERT RERANKING
async function rerankExperts(query, groupedResults, memoryState) {
  const expertSummaries = Object.entries(groupedResults).map(([id, chunks]) => {
    const overview = chunks.find((c) => (c.chunk_type ?? c.metadata?.chunk_type) === "overview");
    const caps = chunks.find((c) => (c.chunk_type ?? c.metadata?.chunk_type) === "capabilities");
    return `Expert ID: ${id}\nOverview: ${overview?.content?.slice(0, 300) || "N/A"}\nCapabilities: ${caps?.content?.slice(0, 300) || "N/A"}`;
  }).join("\n\n---\n\n");

  const completion = await deepseek.chat.completions.create({
    model: "deepseek-chat",
    messages: [
      {
        role: "system",
        content: `You are reranking Shopify experts for relevance.

User Requirements: ${query}
Memory/Constraints: ${JSON.stringify(memoryState)}

Ranking Priorities:
1. Hard constraint satisfaction (country, language, industry, services)
2. Capability relevance
3. Featured work relevance
4. Review quality
5. Pricing suitability

Rules:
- Penalize missing critical requirements
- Penalize vague evidence
- Reward explicit capability evidence and direct featured-work relevance
- Prefer explicit evidence over inferred evidence
- Confidence: high (strong direct evidence), medium (inferred), low (weak/missing)

Return ONLY valid JSON array:
[
  {
    "expert_id": "",
    "score": 0,
    "strengths": [],
    "weaknesses": [],
    "missing_requirements": [],
    "confidence": "high|medium|low"
  }
]`,
      },
      { role: "user", content: `Experts to rank:\n${expertSummaries}` },
    ],
  });

  try {
    const text = completion.choices[0].message.content.trim();
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    return null;
  }
}

// 8 & 12. HALLUCINATION GUARD — runs on final response for recommendation/capabilities
async function applyHallucinationGuard(response, context) {
  // Only run for longer responses to avoid latency on simple queries
  if (response.length < 200) return response;

  const completion = await deepseek.chat.completions.create({
    model: "deepseek-chat",
    messages: [
      {
        role: "system",
        content: `You validate AI responses about Shopify experts for unsupported claims.

Available Evidence:
${context.slice(0, 3000)}

Rules:
- Remove claims that lack evidence in the above data
- Remove invented pricing, language support, technical experience, or review summaries
- Downgrade uncertain claims: "supports Telugu" → "No explicit Telugu support listed"
- Prefer omission over speculation
- Return the cleaned response only — no commentary, no "Here is the cleaned response:" prefix
- If the response is mostly accurate, return it mostly unchanged`,
      },
      { role: "user", content: response },
    ],
  });
  return completion.choices[0].message.content.trim();
}

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

function normalizeExpertId(id = "") {
  return String(id).toLowerCase().trim().replace(/[-_\s]/g, "");
}

async function expandLanguages(languageStr) {
  const completion = await deepseek.chat.completions.create({
    model: "deepseek-chat",
    messages: [
      {
        role: "system",
        content: `You expand broad language group terms into specific language names.
Examples:
"indian languages" -> "Hindi, Tamil, Telugu, Kannada, Malayalam, Marathi, Bengali, Punjabi, Gujarati"
"european languages" -> "English, French, German, Spanish, Italian, Portuguese, Dutch"
"hindi" -> "Hindi"
Reply with ONLY a comma-separated list. Nothing else.`,
      },
      { role: "user", content: languageStr },
    ],
  });
  return completion.choices[0].message.content.trim();
}

async function resolveRealExpertIds(expertIds) {
  const realIds = [];
  for (const id of expertIds) {
    const clean = id.trim();
    if (!clean) continue;

    const { data: exact } = await supabase
      .from("expert_knowledge")
      .select("expert_id")
      .eq("chunk_type", "overview")
      .eq("expert_id", clean)
      .limit(1);

    if (exact?.length) { realIds.push(exact[0].expert_id); continue; }

    const { data: fuzzy } = await supabase
      .from("expert_knowledge")
      .select("expert_id")
      .eq("chunk_type", "overview")
      .ilike("content", `%${clean}%`)
      .limit(1);

    realIds.push(fuzzy?.length ? fuzzy[0].expert_id : clean);
  }
  return [...new Set(realIds)];
}

async function resolveSearchQuery(query, conversationHistory) {
  const completion = await deepseek.chat.completions.create({
    model: "deepseek-chat",
    messages: [
      {
        role: "system",
        content: `You are a query resolver. Extract ONLY the search intent relevant to finding Shopify experts.
Rules:
- Ignore personal info like names, greetings, or small talk
- Return ONLY the clean search query
- If the message is small talk or has no search intent, return "none"

Examples:
"my name is Bhargav" -> "none"
"I need someone for web design" -> "web design shopify expert"
"what about their pricing?" -> "expert pricing"
"hi" -> "none"`,
      },
      ...conversationHistory,
      { role: "user", content: query },
    ],
  });
  return completion.choices[0].message.content.trim().toLowerCase();
}

async function resolveExpertsFromHistory(query, conversationHistory) {
  const completion = await deepseek.chat.completions.create({
    model: "deepseek-chat",
    messages: [
      {
        role: "system",
        content: `Check if the user's query is a follow-up about previously mentioned experts.

This includes:
- Explicit references: "out of these", "which of them", "their", "them", "of the ones you mentioned"
- Short clarifying questions about a previous answer: "only english?", "just one?", "any cheaper?", "what about reviews?"
- Any question that only makes sense in the context of previously mentioned experts

If follow-up: return a comma-separated list of those expert IDs exactly as they appear in conversation history.
If completely new search: return "none".
Reply with ONLY the expert IDs or "none". Nothing else.`,
      },
      ...conversationHistory,
      { role: "user", content: query },
    ],
  });
  return completion.choices[0].message.content.trim().toLowerCase();
}

async function extractLastMentionedExperts(conversationHistory) {
  const completion = await deepseek.chat.completions.create({
    model: "deepseek-chat",
    messages: [
      {
        role: "system",
        content: `Find the most recently mentioned experts in the conversation history.
Return them as a comma-separated list.
If no experts mentioned, return "none".
Reply with ONLY the expert IDs or "none".`,
      },
      ...conversationHistory,
    ],
  });
  return completion.choices[0].message.content.trim().toLowerCase();
}

async function extractExpertName(query) {
  const completion = await deepseek.chat.completions.create({
    model: "deepseek-chat",
    messages: [
      {
        role: "system",
        content: `Extract the expert or company name from the user query.
Reply with ONLY the name. If no name found, reply "unknown".`,
      },
      { role: "user", content: query },
    ],
  });
  return completion.choices[0].message.content.trim();
}

async function isFilteredAggregation(query) {
  const completion = await deepseek.chat.completions.create({
    model: "deepseek-chat",
    messages: [
      {
        role: "system",
        content: `Determine if a query has a filter or is a plain total count.
Reply with ONLY "filtered" or "plain".
Examples:
"how many experts are there?" -> "plain"
"how many experts from india?" -> "filtered"
"experts who speak tamil" -> "filtered"`,
      },
      { role: "user", content: query },
    ],
  });
  return completion.choices[0].message.content.trim().toLowerCase() === "filtered";
}

function isPersonalIntroduction(query) {
  const q = query.trim();
  const patterns = [
    /^(my\s+)?name\s+is\s+\w+/i,
    /^i\s+am\s+\w+/i,
    /^i'm\s+\w+/i,
    /^im\s+\w+/i,
    /^call\s+me\s+\w+/i,
    /^(hi|hello|hey)[,!]?\s+(i\s+am|i'm|im|my\s+name\s+is)\s+\w+/i,
  ];
  return patterns.some((p) => p.test(q));
}

function trimHistory(history, maxTurns = 10) {
  const maxMessages = maxTurns * 2;
  if (history.length <= maxMessages) return history;
  return history.slice(history.length - maxMessages);
}

// ============================================================
// FETCH FUNCTIONS
// ============================================================

async function fetchAggregation() {
  const { data, error } = await supabase
    .from("expert_knowledge")
    .select("expert_id")
    .eq("chunk_type", "overview");
  if (error) { console.error("Aggregation fetch error:", error); return []; }
  return data || [];
}

async function fetchMultiFilter(filters) {
  let expertIds = null;

  if (filters.country) {
    const countryRaw = Array.isArray(filters.country) ? filters.country.join(",") : filters.country;
    const { data } = await supabase
      .from("expert_knowledge")
      .select("expert_id")
      .eq("chunk_type", "location_contact")
      .ilike("content", `%based in%${countryRaw}%`);
    const ids = [...new Set(data?.map((d) => d.expert_id) ?? [])];
    expertIds = expertIds === null ? ids : expertIds.filter((id) => ids.includes(id));
  }

  if (filters.languages) {
    const langsRaw = Array.isArray(filters.languages) ? filters.languages.join(",") : filters.languages;
    const expandedLangs = await expandLanguages(langsRaw);
    const langs = expandedLangs.split(",").map((l) => l.trim()).filter(Boolean);
    let q = supabase.from("expert_knowledge").select("expert_id").eq("chunk_type", "location_contact");
    q = langs.length === 1
      ? q.ilike("content", `%languages%${langs[0]}%`)
      : q.or(langs.map((l) => `content.ilike.%languages%${l}%`).join(","));
    const { data } = await q;
    const ids = [...new Set(data?.map((d) => d.expert_id) ?? [])];
    expertIds = expertIds === null ? ids : expertIds.filter((id) => ids.includes(id));
  }

  if (filters.industries) {
    const indsRaw = Array.isArray(filters.industries) ? filters.industries.join(",") : filters.industries;
    const inds = indsRaw.split(/,| or /).map((i) => i.trim()).filter(Boolean);
    let q = supabase.from("expert_knowledge").select("expert_id").eq("chunk_type", "industries");
    q = inds.length === 1
      ? q.ilike("content", `%${inds[0]}%`)
      : q.or(inds.map((i) => `content.ilike.%${i}%`).join(","));
    const { data } = await q;
    const ids = [...new Set(data?.map((d) => d.expert_id) ?? [])];
    expertIds = expertIds === null ? ids : expertIds.filter((id) => ids.includes(id));
  }

  if (filters.supported_countries) {
    const scRaw = Array.isArray(filters.supported_countries)
      ? filters.supported_countries.join(",")
      : filters.supported_countries;
    const { data } = await supabase
      .from("expert_knowledge")
      .select("expert_id")
      .eq("chunk_type", "location_contact")
      .ilike("content", `%${scRaw.toLowerCase()}%`);
    const ids = [...new Set(data?.map((d) => d.expert_id) ?? [])];
    expertIds = expertIds === null ? ids : expertIds.filter((id) => ids.includes(id));
  }

  if (filters.services) {
    const svcsRaw = Array.isArray(filters.services) ? filters.services.join(",") : filters.services;
    const svcs = svcsRaw.split(/,| or /).map((s) => s.trim()).filter(Boolean);
    let q = supabase.from("expert_knowledge").select("expert_id").in("chunk_type", ["primary_service", "secondary_services"]);
    q = svcs.length === 1
      ? q.ilike("content", `%${svcs[0]}%`)
      : q.or(svcs.map((s) => `content.ilike.%${s}%`).join(","));
    const { data } = await q;
    const ids = [...new Set(data?.map((d) => d.expert_id) ?? [])];
    expertIds = expertIds === null ? ids : expertIds.filter((id) => ids.includes(id));
  }

  if (!expertIds || expertIds.length === 0) return [];

  const { data, error } = await supabase
    .from("expert_knowledge")
    .select("content, metadata, expert_id")
    .eq("chunk_type", "overview")
    .in("expert_id", expertIds);
  if (error) { console.error("Multi-filter final fetch error:", error); return []; }
  return data || [];
}

async function fetchAllProfiles() {
  const { data, error } = await supabase
    .from("expert_knowledge")
    .select("content, metadata, expert_id")
    .eq("chunk_type", "overview");
  if (error) { console.error("Profile fetch error:", error); return []; }
  return data || [];
}

async function fetchExpertChunksByIds(expertIds, chunkTypes = null) {
  let q = supabase
    .from("expert_knowledge")
    .select("content, metadata, expert_id, chunk_type")
    .in("expert_id", expertIds);
  if (chunkTypes?.length) q = q.in("chunk_type", chunkTypes);
  const { data, error } = await q;
  if (error) { console.error("Chunk fetch by ID error:", error); return []; }
  return data || [];
}

async function fetchSuggestions() {
  const { data, error } = await supabase
    .from("expert_knowledge")
    .select("content, metadata, expert_id, chunk_type")
    .eq("chunk_type", "overview")
    .order("rating", { ascending: false })
    .limit(3);
  if (error || !data?.length) return [];
  return data;
}

async function fetchSemantic(query) {
  try {
    const expandedQuery = await expandSemanticQuery(query);
    const finalQuery = `${query}, ${expandedQuery}`;

    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: finalQuery,
    });
    const queryEmbedding = embeddingResponse.data[0].embedding;

    const { data, error } = await supabase.rpc("search_expert_knowledge", {
      query_embedding: queryEmbedding,
      match_count: 20,
      allowed_chunk_types: ["capabilities", "featured_work", "overview", "primary_service", "industries"],
    });

    if (error) {
      console.error("Semantic search error:", error);
      if (error.message?.includes("statement timeout")) {
        return [{ content: "Semantic search timeout occurred internally.", metadata: { chunk_type: "system_error" } }];
      }
      return [];
    }
    return data || [];
  } catch (err) {
    return [{ content: "Semantic search failed internally.", metadata: { chunk_type: "system_error" } }];
  }
}

async function fetchExpertByName(query) {
  const name = await extractExpertName(query);
  if (!name || name === "unknown") return await fetchSemantic(query);

  const { data: overviewData } = await supabase
    .from("expert_knowledge")
    .select("expert_id")
    .eq("chunk_type", "overview")
    .ilike("content", `%${name}%`)
    .limit(1);

  if (!overviewData?.length) return await fetchSemantic(query);

  const expertId = overviewData[0].expert_id;
  const { data, error } = await supabase
    .from("expert_knowledge")
    .select("content, metadata, expert_id, chunk_type")
    .eq("expert_id", expertId);

  if (error || !data?.length) return await fetchSemantic(query);
  return data;
}

// ============================================================
// CONTEXT / RESPONSE BUILDING
// ============================================================

function groupResultsByExpert(results) {
  const grouped = {};
  for (const result of results) {
    const expertId = normalizeExpertId(result.expert_id || result.metadata?.expert_id || "unknown");
    if (!grouped[expertId]) grouped[expertId] = [];
    grouped[expertId].push(result);
  }
  return grouped;
}

function buildContext(groupedResults, isSuggestion = false) {
  const chunkOrder = [
    "overview", "capabilities", "location_contact", "pricing",
    "industries", "primary_service", "secondary_services", "featured_work", "review",
  ];

  let context = isSuggestion ? "No exact match found. Here are some suggested experts you may consider:\n" : "";

  for (const expertId in groupedResults) {
    context += `\n========================\nEXPERT: ${expertId}\n========================\n`;
    const chunks = groupedResults[expertId].sort((a, b) => {
      const ai = chunkOrder.indexOf(a.chunk_type ?? a.metadata?.chunk_type);
      const bi = chunkOrder.indexOf(b.chunk_type ?? b.metadata?.chunk_type);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
    chunks.forEach((result) => {
      const chunkType = result.chunk_type ?? result.metadata?.chunk_type ?? "unknown";
      context += `\n[${chunkType.toUpperCase()}]\n${result.content}\n`;
      if (result.similarity != null) context += `Similarity: ${result.similarity}\n`;
    });
  }
  return context;
}

function pickScenarioPrompt(queryType) {
  const map = {
    recommendation:  SCENARIO_PROMPTS.recommendation,
    semantic:        SCENARIO_PROMPTS.recommendation,
    follow_up:       SCENARIO_PROMPTS.recommendation,
    pricing:         SCENARIO_PROMPTS.pricing,
    reviews:         SCENARIO_PROMPTS.reviews,
    capabilities:    SCENARIO_PROMPTS.capabilities,
    specific_expert: SCENARIO_PROMPTS.capabilities,
    location:        SCENARIO_PROMPTS.location,
    comparison:      SCENARIO_PROMPTS.comparison,
    aggregation:     SCENARIO_PROMPTS.aggregation,
    list_all:        SCENARIO_PROMPTS.aggregation,
    smalltalk:       SCENARIO_PROMPTS.smalltalk,
  };
  return map[queryType] ?? SCENARIO_PROMPTS.recommendation;
}

// Apply reranking order to grouped results
function applyRerankingToContext(groupedResults, rankingData) {
  if (!rankingData?.length) return groupedResults;

  const rankMap = {};
  rankingData.forEach((r, i) => {
    rankMap[normalizeExpertId(r.expert_id)] = { rank: i, data: r };
  });

  // Filter to top 5 by rank; annotate with reranking metadata
  const reordered = {};
  const sorted = Object.keys(groupedResults).sort((a, b) => {
    const ra = rankMap[a]?.rank ?? 99;
    const rb = rankMap[b]?.rank ?? 99;
    return ra - rb;
  }).slice(0, 5);

  for (const id of sorted) {
    reordered[id] = groupedResults[id];
    // Inject reranking signals as a synthetic chunk for LLM context
    const rankInfo = rankMap[id];
    if (rankInfo?.data) {
      reordered[id].push({
        chunk_type: "reranking_signals",
        expert_id: id,
        content: `Strengths: ${rankInfo.data.strengths?.join(", ") || "N/A"} | Weaknesses: ${rankInfo.data.weaknesses?.join(", ") || "N/A"} | Missing: ${rankInfo.data.missing_requirements?.join(", ") || "none"} | Confidence: ${rankInfo.data.confidence}`,
      });
    }
  }
  return reordered;
}

async function generateAndReturn(query, context, queryType, conversationHistory) {
  const systemPrompt = pickScenarioPrompt(queryType);

  const userMessage = {
    role: "user",
    content: context ? `USER REQUEST: ${query}\n\nINFORMATION:\n${context}` : query,
  };
  const updatedHistory = [...conversationHistory, userMessage];

  const completion = await deepseek.chat.completions.create({
    model: "deepseek-chat",
    messages: [
      {
        role: "system",
        content: `${systemPrompt}\n\n${MASTER_RULES}`,
      },
      ...updatedHistory,
    ],
  });

  let answer = completion.choices[0].message.content;

  // Apply hallucination guard for recommendation/capabilities responses with context
  if (context && ["recommendation", "capabilities", "specific_expert", "follow_up"].includes(queryType)) {
    answer = await applyHallucinationGuard(answer, context);
  }

  return {
    answer,
    updatedHistory: [...updatedHistory, { role: "assistant", content: answer }],
  };
}

// ============================================================
// MAIN EXPORTED FUNCTION
// ============================================================

export async function processQuery(query, conversationHistory = [], memoryState = null) {

  // Trim history upfront
  conversationHistory = trimHistory(conversationHistory);

  // 0. PERSONAL INTRO GUARD — deterministic pre-check before LLM classifier
  if (isPersonalIntroduction(query)) {
    const nameMatch = query.match(/(?:name\s+is|i\s+am|i'm|im|call\s+me)\s+(\w+)/i);
    const userName = nameMatch ? nameMatch[1] : "there";
    const result = await generateAndReturn(
      `The user just said hello and told me their name is ${userName}. Greet them warmly by name.`,
      "",
      "smalltalk",
      conversationHistory
    );
    return { ...result, memoryState };
  }

  // 1. CLASSIFY INTENT
  const queryType = await classifyQuery(query);

  // 2. SMALL TALK — short circuit
  if (queryType === "smalltalk") {
    const result = await generateAndReturn(query, "", "smalltalk", conversationHistory);
    return { ...result, memoryState };
  }

  // 3. MEMORY RESOLVER — update active constraints
  const updatedMemory = await resolveMemoryState(query, conversationHistory, memoryState);

  // 4. CLARIFICATION DETECTOR (for recommendation/capabilities only — skip for follow-ups)
  if (["recommendation", "capabilities"].includes(queryType) && !conversationHistory.length) {
    const clarification = await detectClarification(query, conversationHistory, updatedMemory);
    if (clarification.needs_clarification && clarification.question) {
      const clarifyAnswer = clarification.question;
      return {
        answer: clarifyAnswer,
        updatedHistory: [
          ...conversationHistory,
          { role: "user", content: query },
          { role: "assistant", content: clarifyAnswer },
        ],
        memoryState: updatedMemory,
      };
    }
  }

  // 5. AGGREGATION PATH
  if (queryType === "aggregation" || queryType === "list_all") {
    const filtered = queryType === "list_all" ? false : await isFilteredAggregation(query);

    if (filtered) {
      const filters = await extractHardFilters(query, conversationHistory, updatedMemory);
      let data = await fetchMultiFilter(filters);

      const resolvedExperts = await resolveExpertsFromHistory(query, conversationHistory);
      if (resolvedExperts !== "none") {
        const expertList = resolvedExperts.split(",").map((e) => normalizeExpertId(e.trim()));
        data = data.filter((d) =>
          expertList.includes(normalizeExpertId(d.expert_id || d.metadata?.expert_id))
        );
      }

      const expertIdMap = {};
      data.forEach((d) => {
        const raw = d.expert_id || d.metadata?.expert_id;
        if (raw) expertIdMap[normalizeExpertId(raw)] = raw;
      });
      const originalExpertIds = Object.values(expertIdMap);

      if (originalExpertIds.length > 0) {
        const locationChunks = await fetchExpertChunksByIds(originalExpertIds, ["location_contact"]);
        const locationContext = locationChunks
          .map((c) => `${c.expert_id}: ${c.content}`)
          .join("\n");
        const contextMsg = `There are ${originalExpertIds.length} experts matching: ${originalExpertIds.join(", ")}\n\nEXPERT DETAILS:\n${locationContext}`;
        const result = await generateAndReturn(query, contextMsg, "aggregation", conversationHistory);
        return { ...result, memoryState: updatedMemory };
      } else {
        // No filter match — fall back to semantic search
        console.log("  (no filter match — falling back to semantic search)");
        const semanticResults = await fetchSemantic(query);
        const validSemantic = semanticResults.filter(
          (r) => (r.chunk_type ?? r.metadata?.chunk_type) !== "system_error"
        );
        if (validSemantic.length) {
          const grouped = groupResultsByExpert(validSemantic);
          const context = buildContext(grouped);
          const result = await generateAndReturn(query, context, "recommendation", conversationHistory);
          return { ...result, memoryState: updatedMemory };
        }
        const suggestions = await fetchSuggestions();
        const grouped = groupResultsByExpert(suggestions);
        const context = buildContext(grouped, true);
        const result = await generateAndReturn(query, context, "recommendation", conversationHistory);
        return { ...result, memoryState: updatedMemory };
      }
    }

    // Plain aggregation
    const data = await fetchAggregation();
    const contextMsg = `There are ${data.length} experts available: ${data.map((d) => d.expert_id).join(", ")}`;
    const result = await generateAndReturn(query, contextMsg, "aggregation", conversationHistory);
    return { ...result, memoryState: updatedMemory };
  }

  // 6. RESOLVE SEARCH INTENT
  const searchQuery = await resolveSearchQuery(query, conversationHistory);
  if (searchQuery === "none") {
    const result = await generateAndReturn(query, "", queryType, conversationHistory);
    return { ...result, memoryState: updatedMemory };
  }

  // 7. EXTRACT HARD FILTERS
  const filters = await extractHardFilters(query, conversationHistory, updatedMemory);

  // 8. CHECK HISTORY FOR EXPERT REFERENCES
  const resolvedExperts = await resolveExpertsFromHistory(query, conversationHistory);
  let results;
  let historyExpertIds = null;

  if (resolvedExperts !== "none") {
    const rawIds = resolvedExperts.split(",").map((e) => e.trim()).filter(Boolean);
    const realIds = await resolveRealExpertIds(rawIds);
    historyExpertIds = realIds;
    results = await fetchExpertChunksByIds(realIds, null);
  } else {
    const lastExperts = await extractLastMentionedExperts(conversationHistory);
    if (lastExperts !== "none") {
      const rawIds = lastExperts.split(",").map((e) => e.trim()).filter(Boolean);
      const realIds = await resolveRealExpertIds(rawIds);
      historyExpertIds = realIds;
      results = await fetchExpertChunksByIds(realIds, null);
    } else {
      // 9. RETRIEVAL STRATEGY
      const strategy = await planRetrievalStrategy(queryType, false, filters);
      // console.log(`  Retrieval strategy: ${strategy}`);

      if (strategy === "hybrid_search") {
        // Combine semantic + filter results
        const [semanticResults, filterData] = await Promise.all([
          fetchSemantic(searchQuery),
          Object.values(filters).some((v) => v) ? fetchMultiFilter(filters) : Promise.resolve([]),
        ]);
        const filterIds = new Set(filterData.map((d) => d.expert_id));
        const semanticValid = semanticResults.filter(
          (r) => (r.chunk_type ?? r.metadata?.chunk_type) !== "system_error"
        );
        // Prefer experts in both; fall back to semantic
        const hybridPriority = semanticValid.filter((r) => filterIds.has(r.expert_id));
        results = hybridPriority.length ? [...hybridPriority, ...filterData] : semanticValid;
      } else if (strategy === "hard_filter_search") {
        const filterData = await fetchMultiFilter(filters);
        results = filterData.length ? filterData : await fetchSemantic(searchQuery);
      } else if (queryType === "specific_expert" || queryType === "reviews" || queryType === "capabilities") {
        results = await fetchExpertByName(searchQuery);
      } else {
        results = await fetchSemantic(searchQuery);
      }
    }
  }

  // 10. FILTER SYSTEM ERRORS
  const validResults = results.filter(
    (r) => (r.chunk_type ?? r.metadata?.chunk_type) !== "system_error"
  );

  // 11. SUGGESTIONS FALLBACK
  if (!validResults.length) {
    if (historyExpertIds?.length) {
      const allChunks = await fetchExpertChunksByIds(historyExpertIds, null);
      if (allChunks.length) {
        const grouped = groupResultsByExpert(allChunks);
        const context = buildContext(grouped);
        const result = await generateAndReturn(query, context, queryType, conversationHistory);
        return { ...result, memoryState: updatedMemory };
      }
    }
    const suggestions = await fetchSuggestions();
    if (!suggestions.length) {
      const result = await generateAndReturn(query, "", queryType, conversationHistory);
      return { ...result, memoryState: updatedMemory };
    }
    const grouped = groupResultsByExpert(suggestions);
    const context = buildContext(grouped, true);
    const result = await generateAndReturn(query, context, queryType, conversationHistory);
    return { ...result, memoryState: updatedMemory };
  }

  // 12. RERANK (for recommendation/follow_up with multiple experts)
  let groupedResults = groupResultsByExpert(validResults);
  const expertCount = Object.keys(groupedResults).length;

  if (["recommendation", "follow_up"].includes(queryType) && expertCount > 1) {
    const rankingData = await rerankExperts(query, groupedResults, updatedMemory);
    if (rankingData) {
      groupedResults = applyRerankingToContext(groupedResults, rankingData);
    }
  }

  // 13. GENERATE ANSWER
  const context = buildContext(groupedResults);
  const result = await generateAndReturn(query, context, queryType, conversationHistory);
  return { ...result, memoryState: updatedMemory };
}