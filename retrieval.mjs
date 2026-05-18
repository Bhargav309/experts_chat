import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

import {
  DOMAIN_MAP,
  MASTER_RULES,
  SCENARIO_PROMPTS,
  CLASSIFIER_PROMPT,
  PERSONAL_INTRO_PROMPT,
  MEMORY_RESOLVER_PROMPT,
  CLARIFICATION_PROMPT,
  HARD_FILTER_PROMPT,
  SEMANTIC_EXPANSION_PROMPT,
  RERANK_PROMPT,
  HALLUCINATION_GUARD_PROMPT,
  LANGUAGE_EXPANSION_PROMPT,
  SEARCH_QUERY_RESOLVER_PROMPT,
  HISTORY_EXPERT_RESOLVER_PROMPT,
  EXPERT_NAME_EXTRACTOR_PROMPT,
  HARD_FILTER_DETECTION_PROMPT,
  NO_MATCH_RESPONSE_PROMPT,
  FILTERED_AGGREGATION_PROMPT,
} from "./prompts.with-rules.mjs";

// ---------- CLIENTS ----------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const deepseek = new OpenAI({
  baseURL: "https://api.deepseek.com",
  apiKey: process.env.DEEPSEEK_API_KEY,
});
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

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
async function classifyQuery(query, conversationHistory = []) {
  const trimmedHistory = conversationHistory.slice(-6);

  const completion = await deepseek.chat.completions.create({
    model: "deepseek-chat",
    messages: [
      { role: "system", content: CLASSIFIER_PROMPT },
      ...trimmedHistory,
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
      { role: "system", content: MEMORY_RESOLVER_PROMPT(memoryJson) },
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
      last_expert_ids: [],
      last_query_type: "",
      last_user_query: "",
    };
  }
}

// 3. CLARIFICATION DETECTOR
async function detectClarification(query, conversationHistory, memoryState) {
  const completion = await deepseek.chat.completions.create({
    model: "deepseek-chat",
    messages: [
      { role: "system", content: CLARIFICATION_PROMPT(memoryState) },
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
      { role: "system", content: HARD_FILTER_PROMPT(memoryState) },
      ...conversationHistory,
      { role: "user", content: query },
    ],
  });
  try {
    const text = completion.choices[0].message.content.trim();
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
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
      { role: "system", content: SEMANTIC_EXPANSION_PROMPT },
      { role: "user", content: query },
    ],
  });
  return completion.choices[0].message.content.trim();
}

// 6. RETRIEVAL STRATEGY PLANNER
function planRetrievalStrategy(queryType, hasHistoryExperts, filters) {
  const hasFilters = filters && Object.values(filters).some(
    (v) => Array.isArray(v) ? v.length > 0 : !!v
  );

  if (queryType === "follow_up" && hasHistoryExperts) return "expert_followup_search";
  if (queryType === "specific_expert" || queryType === "reviews" || queryType === "capabilities") {
    return hasHistoryExperts ? "expert_followup_search" : "semantic_search";
  }
  if (queryType === "aggregation" || queryType === "list_all") {
    return hasFilters ? "hard_filter_search" : "plain_aggregation";
  }
  if (queryType === "location") return "hard_filter_search";
  if (hasFilters && hasHistoryExperts) return "expert_followup_search";
  if (hasFilters) return "hard_filter_search";
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
      { role: "system", content: RERANK_PROMPT(query, memoryState) },
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

// 8. HALLUCINATION GUARD
async function applyHallucinationGuard(response, context) {
  if (response.length < 200) return response;

  const completion = await deepseek.chat.completions.create({
    model: "deepseek-chat",
    messages: [
      { role: "system", content: HALLUCINATION_GUARD_PROMPT(context) },
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
      { role: "system", content: LANGUAGE_EXPANSION_PROMPT },
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
      { role: "system", content: SEARCH_QUERY_RESOLVER_PROMPT },
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
      { role: "system", content: HISTORY_EXPERT_RESOLVER_PROMPT },
      ...conversationHistory,
      { role: "user", content: query },
    ],
  });
  return completion.choices[0].message.content.trim().toLowerCase();
}

async function extractExpertName(query) {
  const completion = await deepseek.chat.completions.create({
    model: "deepseek-chat",
    messages: [
      { role: "system", content: EXPERT_NAME_EXTRACTOR_PROMPT },
      { role: "user", content: query },
    ],
  });
  return completion.choices[0].message.content.trim();
}

async function isHardFilterQuery(query) {
  const completion = await deepseek.chat.completions.create({
    model: "deepseek-chat",
    messages: [
      { role: "system", content: HARD_FILTER_DETECTION_PROMPT },
      { role: "user", content: query },
    ],
  });
  return completion.choices[0].message.content.trim().toLowerCase() === "yes";
}

async function generateNoMatchResponse(query, conversationHistory) {
  const completion = await deepseek.chat.completions.create({
    model: "deepseek-chat",
    messages: [
      { role: "system", content: NO_MATCH_RESPONSE_PROMPT },
      ...conversationHistory,
      { role: "user", content: query },
    ],
  });
  return completion.choices[0].message.content.trim();
}

async function isFilteredAggregation(query) {
  const completion = await deepseek.chat.completions.create({
    model: "deepseek-chat",
    messages: [
      { role: "system", content: FILTERED_AGGREGATION_PROMPT },
      { role: "user", content: query },
    ],
  });
  return completion.choices[0].message.content.trim().toLowerCase() === "filtered";
}

async function isPersonalIntroduction(query) {
  const completion = await deepseek.chat.completions.create({
    model: "deepseek-chat",
    messages: [
      { role: "system", content: PERSONAL_INTRO_PROMPT },
      { role: "user", content: query },
    ],
  });
  return completion.choices[0].message.content.trim().toLowerCase() === "yes";
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

const COUNTRY_NORMALIZATION = {
  "us": "united states",
  "usa": "united states",
  "uk": "united kingdom",
  "uae": "united arab emirates",
  "ksa": "saudi arabia",
  "u.s.": "united states",
  "u.s.a.": "united states",
  "u.k.": "united kingdom",
};

function normalizeFilters(filters = {}) {
  const normalizeCountry = (v) => {
    const lower = v.toLowerCase().trim();
    return COUNTRY_NORMALIZATION[lower] || lower;
  };

  return {
    country: Array.isArray(filters.country)
      ? filters.country.map(normalizeCountry)
      : filters.country
        ? filters.country.split(/,|\s+or\s+/i).map(normalizeCountry)
        : [],

    supported_countries: Array.isArray(filters.supported_countries)
      ? filters.supported_countries.map(normalizeCountry)
      : filters.supported_countries
        ? filters.supported_countries.split(/,|\s+or\s+/i).map(normalizeCountry)
        : [],

    languages: Array.isArray(filters.languages)
      ? filters.languages.map(v => v.toLowerCase().trim())
      : filters.languages
        ? filters.languages.split(/,|\s+or\s+/i).map(v => v.toLowerCase().trim())
        : [],

    services: Array.isArray(filters.services)
      ? filters.services.map(v => v.toLowerCase().trim())
      : filters.services
        ? filters.services.split(/,|\s+or\s+/i).map(v => v.toLowerCase().trim())
        : [],

    industries: Array.isArray(filters.industries)
      ? filters.industries.map(v => v.toLowerCase().trim())
      : filters.industries
        ? filters.industries.split(/,|\s+or\s+/i).map(v => v.toLowerCase().trim())
        : [],
  };
}

function escapeRegex(str = "") {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function fetchMultiFilter(filters) {
  const { data, error } = await supabase
    .from("expert_knowledge")
    .select("content, metadata, expert_id, chunk_type")
    .eq("chunk_type", "location_contact");

  if (error || !data?.length) {
    console.error("fetchMultiFilter error:", error);
    return [];
  }

  const matchedExpertIds = [];

  for (const row of data) {
    const content = (row.content || "").toLowerCase();

    const basedInMatch = content.match(/is based in ([^.]+)\./);
    const basedInText = basedInMatch ? basedInMatch[1] : "";

    const supportsMatch = content.match(/supports clients in:\s*([^.]+)/);
    const supportsText = supportsMatch ? supportsMatch[1] : "";

    const countryPass =
      !filters.country.length ||
      filters.country.some(c =>
        new RegExp(`\\b${escapeRegex(c)}\\b`, "i").test(basedInText)
      );

    const supportedCountryPass =
      !filters.supported_countries?.length ||
      filters.supported_countries.some(c => {
        const regex = new RegExp(`\\b${escapeRegex(c)}\\b`, "i");
        return regex.test(supportsText) || regex.test(basedInText);
      });

    const languagePass =
      !filters.languages.length ||
      filters.languages.some(l =>
        new RegExp(`\\b${escapeRegex(l)}\\b`, "i").test(content)
      );

    if (countryPass && supportedCountryPass && languagePass) {
      matchedExpertIds.push(row.expert_id);
    }
  }

  let finalExpertIds = matchedExpertIds;

  if (filters.services?.length || filters.industries?.length) {
    const { data: capData } = await supabase
      .from("expert_knowledge")
      .select("content, expert_id")
      .in("expert_id", matchedExpertIds)
      .in("chunk_type", ["capabilities", "primary_service", "overview"]);

    const capsByExpert = {};
    for (const row of (capData || [])) {
      if (!capsByExpert[row.expert_id]) capsByExpert[row.expert_id] = "";
      capsByExpert[row.expert_id] += " " + (row.content || "").toLowerCase();
    }

    finalExpertIds = matchedExpertIds.filter(id => {
      const text = capsByExpert[id] || "";
      const servicePass =
        !filters.services.length ||
        filters.services.some(s =>
          new RegExp(`\\b${escapeRegex(s)}\\b`, "i").test(text)
        );
      const industryPass =
        !filters.industries.length ||
        filters.industries.some(i =>
          new RegExp(`\\b${escapeRegex(i)}\\b`, "i").test(text)
        );
      return servicePass && industryPass;
    });
  }

  console.log("FILTER DEBUG", { filters, matchedExperts: finalExpertIds });

  if (!finalExpertIds.length) return [];

  return await fetchExpertChunksByIds(finalExpertIds, null);
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
    if (!data?.length) return [];

    const expertIds = [...new Set(data.map((r) => r.expert_id).filter(Boolean))];
    const { data: fullChunks, error: fullError } = await supabase
      .from("expert_knowledge")
      .select("content, metadata, expert_id, chunk_type")
      .in("expert_id", expertIds);

    if (fullError || !fullChunks?.length) return data;
    return fullChunks;
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

function applyRerankingToContext(groupedResults, rankingData, maxExperts = 5) {
  if (!rankingData?.length) return groupedResults;

  const rankMap = {};
  rankingData.forEach((r, i) => {
    rankMap[normalizeExpertId(r.expert_id)] = { rank: i, data: r };
  });

  const reordered = {};
  const allIds = Object.keys(groupedResults);

  const sorted = allIds.sort((a, b) => {
    const ra = rankMap[a]?.rank ?? 99;
    const rb = rankMap[b]?.rank ?? 99;
    return ra - rb;
  }).slice(0, maxExperts);

  const filterMatchedIds = allIds.filter((id) => rankMap[id] === undefined);
  const finalIds = [...new Set([...sorted, ...filterMatchedIds])].slice(0, maxExperts);

  for (const id of finalIds) {
    reordered[id] = groupedResults[id];
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

async function generateAndReturn(query, context, queryType, conversationHistory, isFilterDriven = false) {
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
        content: MASTER_RULES ? `${systemPrompt}\n\n${MASTER_RULES}` : systemPrompt,
      },
      ...updatedHistory,
    ],
  });

  let answer = completion.choices[0].message.content;

  if (context && !isFilterDriven && ["recommendation", "capabilities", "specific_expert", "follow_up"].includes(queryType)) {
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

function applyDeterministicMemoryRules(query, previousMemory, newMemory) {
  const lower = query.toLowerCase();
  const replacementWords = ["instead", "maybe", "only", "rather", "replace"];
  const isReplacement = replacementWords.some(word => lower.includes(word));
  if (!isReplacement) return newMemory;

  if (/(english|hindi|telugu|tamil|kannada|malayalam)/i.test(query)) {
    newMemory.hard_constraints.languages = newMemory?.hard_constraints?.languages || [];
  }
  if (/(india|usa|uk|canada|australia)/i.test(query)) {
    newMemory.hard_constraints.country = newMemory?.hard_constraints?.country || [];
  }
  return newMemory;
}

function isLikelyFollowUp(query, memoryState) {
  if (!memoryState) return false;
  const hasActiveExperts = memoryState.last_expert_ids?.length > 0;
  const hasConstraints = Object.values(memoryState.hard_constraints || {}).some(arr => arr?.length);
  const shortQuery = query.trim().split(/\s+/).length <= 8;
  const refinementWords = [
    "only", "maybe", "instead", "english", "hindi", "telugu",
    "cheaper", "better", "reviews", "pricing", "location", "india"
  ];
  const looksLikeRefinement = refinementWords.some(word => query.toLowerCase().includes(word));
  return shortQuery && (hasActiveExperts || hasConstraints) && looksLikeRefinement;
}

export async function processQuery(query, conversationHistory = [], memoryState = null) {

  conversationHistory = trimHistory(conversationHistory);

  // 0. PERSONAL INTRO GUARD
  if (await isPersonalIntroduction(query)) {
    const extractedName = await extractExpertName(query);
    const userName = extractedName && extractedName !== "unknown" ? extractedName : "there";
    const result = await generateAndReturn(
      `The user just said hello and told me their name is ${userName}. Greet them warmly by name.`,
      "",
      "smalltalk",
      conversationHistory
    );
    return { ...result, memoryState };
  }

  // 1. CLASSIFY INTENT
  let queryType = await classifyQuery(query, conversationHistory);

  // 2. MEMORY RESOLVER
  let updatedMemory = await resolveMemoryState(query, conversationHistory, memoryState);
  updatedMemory = applyDeterministicMemoryRules(query, memoryState, updatedMemory);

  // 3. FOLLOW-UP OVERRIDE USING MEMORY
  const hasConstraints = Object.values(updatedMemory?.hard_constraints || {}).some(arr => arr?.length);
  const shortQuery = query.trim().split(/\s+/).length <= 8;
  const refinementWords = [
    "only", "maybe", "instead", "english", "hindi", "telugu",
    "cheaper", "better", "reviews", "pricing", "location", "india"
  ];
  const looksLikeRefinement = refinementWords.some(word => query.toLowerCase().includes(word));
  if (queryType === "smalltalk" && hasConstraints && shortQuery && looksLikeRefinement) {
    console.log("FOLLOW-UP OVERRIDE ACTIVATED");
    queryType = "follow_up";
  }

  // 4. SMALL TALK — short circuit
  if (queryType === "smalltalk") {
    const result = await generateAndReturn(query, "", "smalltalk", conversationHistory);
    return { ...result, memoryState: updatedMemory };
  }

  // 5. CLARIFICATION DETECTOR
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

  // 6. AGGREGATION PATH
  if (queryType === "aggregation" || queryType === "list_all") {
    const filtered = queryType === "list_all" ? false : await isFilteredAggregation(query);

    if (filtered) {
      const rawFilters = await extractHardFilters(query, conversationHistory, updatedMemory);
      const filters = normalizeFilters(rawFilters);
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
        const allChunks = await fetchExpertChunksByIds(originalExpertIds, ["location_contact", "overview"]);
        const locationContext = allChunks.map((c) => `${c.expert_id}: ${c.content}`).join("\n");
        const contextMsg = `There are ${originalExpertIds.length} experts matching: ${originalExpertIds.join(", ")}\n\nEXPERT DETAILS:\n${locationContext}`;
        const result = await generateAndReturn(query, contextMsg, "aggregation", conversationHistory, true);
        return { ...result, memoryState: updatedMemory };
      } else {
        const noMatchAnswer = await generateNoMatchResponse(query, conversationHistory);
        return {
          answer: noMatchAnswer,
          updatedHistory: [
            ...conversationHistory,
            { role: "user", content: query },
            { role: "assistant", content: noMatchAnswer },
          ],
          memoryState: updatedMemory,
        };
      }
    }

    const data = await fetchAggregation();
    const contextMsg = `There are ${data.length} experts available: ${data.map((d) => d.expert_id).join(", ")}`;
    const result = await generateAndReturn(query, contextMsg, "aggregation", conversationHistory, false);
    return { ...result, memoryState: updatedMemory };
  }

  // 7. RESOLVE SEARCH INTENT
  const searchQuery = await resolveSearchQuery(query, conversationHistory);
  if (searchQuery === "none") {
    const result = await generateAndReturn(query, "", queryType, conversationHistory, false);
    return { ...result, memoryState: updatedMemory };
  }

  // 8. EXTRACT HARD FILTERS
  const rawFilters = await extractHardFilters(query, conversationHistory, updatedMemory);
  const filters = normalizeFilters(rawFilters);

  // 9. CHECK HISTORY FOR EXPERT REFERENCES
  const resolvedExperts = await resolveExpertsFromHistory(query, conversationHistory);
  let results;
  let historyExpertIds = null;
  let filterData = [];
  let hybridPriority = [];

  if (resolvedExperts !== "none") {
    const rawIds = resolvedExperts.split(",").map((e) => e.trim()).filter(Boolean);
    const realIds = await resolveRealExpertIds(rawIds);
    historyExpertIds = realIds;
    results = await fetchExpertChunksByIds(realIds, null);
  } else {
    const strategy = await planRetrievalStrategy(queryType, false, filters);
    console.log(`Retrieval strategy: ${strategy}`);

    if (strategy === "hybrid_search") {
      const [semanticResults, fetchedFilterData] = await Promise.all([
        fetchSemantic(searchQuery),
        Object.values(filters).some((v) => v?.length)
          ? fetchMultiFilter({
              country: filters.country,
              supported_countries: [],
              languages: filters.languages.filter((l) => l !== "english"),
              services: [],
              industries: [],
            })
          : Promise.resolve([]),
      ]);

      filterData = fetchedFilterData;
      const filterIds = new Set(filterData.map((d) => d.expert_id));
      const semanticValid = semanticResults.filter(
        (r) => (r.chunk_type ?? r.metadata?.chunk_type) !== "system_error"
      );
      hybridPriority = semanticValid.filter((r) => filterIds.has(r.expert_id));

      if (hybridPriority.length) {
        results = [...hybridPriority, ...filterData];
      } else if (filterData.length) {
        results = filterData;
      } else {
        results = semanticValid;
      }

    } else if (strategy === "hard_filter_search") {
      filterData = await fetchMultiFilter(filters);
      results = filterData.length ? filterData : [];
    } else if (
      queryType === "specific_expert" ||
      queryType === "reviews" ||
      queryType === "capabilities"
    ) {
      results = await fetchExpertByName(searchQuery);
    } else {
      results = await fetchSemantic(searchQuery);
    }
  }

  // 10. FILTER SYSTEM ERRORS
  const validResults = results.filter(
    (r) => (r.chunk_type ?? r.metadata?.chunk_type) !== "system_error"
  );

  // 11. NO-MATCH HANDLING
  if (!validResults.length) {
    if (historyExpertIds?.length) {
      const allChunks = await fetchExpertChunksByIds(historyExpertIds, null);
      if (allChunks.length) {
        const grouped = groupResultsByExpert(allChunks);
        const context = buildContext(grouped);
        const result = await generateAndReturn(query, context, queryType, conversationHistory, false);
        return { ...result, memoryState: updatedMemory };
      }
    }
    const hardFilter = await isHardFilterQuery(query);
    if (hardFilter) {
      const noMatchAnswer = await generateNoMatchResponse(query, conversationHistory);
      return {
        answer: noMatchAnswer,
        updatedHistory: [
          ...conversationHistory,
          { role: "user", content: query },
          { role: "assistant", content: noMatchAnswer },
        ],
        memoryState: updatedMemory,
      };
    }
    const suggestions = await fetchSuggestions();
    if (!suggestions.length) {
      const result = await generateAndReturn(query, "", queryType, conversationHistory, false);
      return { ...result, memoryState: updatedMemory };
    }
    const grouped = groupResultsByExpert(suggestions);
    const context = buildContext(grouped, true);
    const result = await generateAndReturn(query, context, queryType, conversationHistory, false);
    return { ...result, memoryState: updatedMemory };
  }

  // 12. RERANK
  let groupedResults = groupResultsByExpert(validResults);
  const expertCount = Object.keys(groupedResults).length;

  const isFilterDriven = filterData.length > 0 && hybridPriority.length === 0;

  if (!isFilterDriven && ["recommendation", "follow_up"].includes(queryType) && expertCount > 1) {
    const rankingData = await rerankExperts(query, groupedResults, updatedMemory);
    if (rankingData) {
      groupedResults = applyRerankingToContext(groupedResults, rankingData);
    }
  }

  // 13. GENERATE ANSWER
  const context = buildContext(groupedResults);
  const matchedExpertIds = Object.keys(groupedResults);
  const pinnedQuery = isFilterDriven
    ? `${query}\n\nIMPORTANT: Only recommend these experts: ${matchedExpertIds.join(", ")}. Do not suggest any others.`
    : query;

  const result = await generateAndReturn(pinnedQuery, context, queryType, conversationHistory, isFilterDriven);
  updatedMemory.last_expert_ids = matchedExpertIds;
  updatedMemory.last_query_type = queryType;
  updatedMemory.last_user_query = query;
  return {
    ...result,
    memoryState: updatedMemory,
  };
}
