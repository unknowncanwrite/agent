/* Multi-agent orchestration: fast router -> specialist agents */
import { complete, chainFor } from "./models.js";

/** Cheap heuristic classification — zero latency, catches the obvious cases. */
export function heuristic(text) {
  const t = (text || "").toLowerCase().trim();
  const words = t.split(/\s+/).length;

  if (/^(hi|hey|hello|yo|thanks|thank you|ok|okay|cool|nice|got it|bye)\b/.test(t) && words < 6
      && !/\b(world|in (python|js|javascript|node|bash|go|rust|c\+\+|java))\b/.test(t))
    return { route: "chat", why: "greeting", confidence: 0.97 };

  const osHit = /\b(open|launch|close|quit|click|type|cursor|mouse|screenshot|screen|clipboard|volume|shutdown|restart|lock|desktop|folder|downloads|install|scroll|window)\b/.test(t);
  const buildHit = /\b(build|create|make|write|implement|generate|refactor|fix|debug|add|develop|code|script|app|website|component|test)\b/.test(t);
  const askHit = /^(what|who|when|where|why|how|explain|tell me|describe|does|is|are|can)\b/.test(t);

  // asking ABOUT this machine needs tools even though it is phrased as a question
  const machineHit =
    /\b(my|this) (os|pc|computer|machine|system|cpu|ram|disk|drive|workspace|folder|directory|home)\b/.test(t) ||
    /\b(disk|ram|memory|cpu|storage|space)\b.*\b(left|free|usage|used|available|count|much|many)\b/.test(t) ||
    /\b(how much|how many)\b.*\b(disk|ram|memory|space|cpu|cores?|storage)\b/.test(t) ||
    /\b(kernel|uptime|hostname|running processes|which shells|env vars?)\b/.test(t) ||
    /\bis\s+\w+\s+installed\b/.test(t) ||                       // "is python installed"
    /\b(node|python|git|npm|docker|java|go|rust)\s+version\b/.test(t) ||  // "node version"
    /\bwhat('?s| is| os)\b.*\b(os|system|platform|machine)\b/.test(t) ||
    /\bwhat'?s? in my\b/.test(t) ||                                // "whats in my workspace"
    /\b(show|list)\b.*\b(files?|folder|directory|processes|home)\b/.test(t);
  if (machineHit) return { route: "agent", why: "inspect this machine", confidence: 0.92 };

  // creative writing uses "write" but needs no tools
  if (/\b(haiku|poem|joke|story|limerick|song|rap|essay|tagline|slogan)\b/.test(t) && words < 30)
    return { route: "chat", why: "creative writing", confidence: 0.9 };

  // Bare artefact nouns: humans type "fizzbuzz" or "snake game", not "please create...".
  // If the message names a buildable thing, it is a build request.
  const artefact = /\b(app|game|script|tool|server|api|website|site|page|dashboard|bot|cli|generator|tracker|timer|clock|calculator|converter|parser|scraper|readme|dockerfile|gitignore|makefile|config|csv|json|yaml|xlsx|docx|pptx|pdf|chart|graph|test|tests|snake|tetris|pong|todo|fizzbuzz)\b/.test(t)
    || /\bhello world\b/.test(t)
    || /\b(track|manage|organi[sz]e|monitor|remind)\b.*\b(expense|task|note|habit|budget|time|file)/.test(t);
  if (artefact && words <= 12) return { route: "agent", why: "artefact request", confidence: 0.9 };

  // Output formats and common action verbs that humans type without "create"
  if (/\b(excel|xlsx|spreadsheet|word doc|docx|powerpoint|pptx|slides?|pdf|zip|screenshot)\b/.test(t) ||
      /\b(git|npm|pip|docker|commit|repo|repository|branch|clone|push|pull)\b/.test(t) ||
      /^(search|google|look ?up|find|fetch|download|scrape|browse)\b/.test(t) ||
      /\b(print|output|display|calculate|compute|generate|analy[sz]e|chart|plot|convert|rename|scaffold)\b/.test(t))
    return { route: "agent", why: "action verb", confidence: 0.9 };

  // Compute/lookup that must actually be executed, not answered from memory
  if (/\b(md5|sha|hash|uuid|random|timestamp|factorial|fibonacci|average|reverse|sort|convert|encode|decode|count)\b/.test(t)
      || /\bsum\b.*\b\d+\b|\b\d+\s*(to|through|\.\.)\s*\d+\b/.test(t)
      && words <= 14) return { route: "agent", why: "compute it", confidence: 0.88 };

  // memory/self actions are tool calls, not chat
  if (/^(remember|forget|note that|keep in mind|save that)\b/.test(t) ||
      /\b(what do you (know|remember)) about me\b/.test(t))
    return { route: "agent", why: "memory action", confidence: 0.93 };

  // "i need / give me / i want" + anything = do it
  if (/^(i need|i want|give me|get me|show me|make me|build me|can you (make|build|create|write))\b/.test(t))
    return { route: "agent", why: "user request for output", confidence: 0.9 };

  // explicit run/execute verbs always mean the agent
  if (/\b(run|execute|launch it|start (the |a )?(server|script)|npm |pip |git |curl |bash |powershell)\b/.test(t))
    return { route: "agent", why: "explicit execution", confidence: 0.93 };

  if (osHit && !buildHit) return { route: "agent", why: "OS/desktop action", confidence: 0.9 };
  if (buildHit) return { route: "agent", why: "build/code task", confidence: 0.88 };
  if (askHit && !buildHit && !osHit && words < 40)
    return { route: "chat", why: "informational question", confidence: 0.8 };

  return null;   // ambiguous -> ask the fast model
}

/**
 * Decide how to handle a message.
 *  chat  = answer directly (streamed, no tools)
 *  agent = full autonomous loop with tools
 * Also picks the complexity tier so we can choose a model.
 */
export async function route(text, { freeOnly = true, signal, forceAgent = false } = {}) {
  if (forceAgent) return { route: "agent", tier: "deep", why: "agent mode on", confidence: 1, ms: 0 };

  const t0 = Date.now();
  const h = heuristic(text);
  if (h && h.confidence >= 0.88) {
    return { ...h, tier: h.route === "chat" ? "light" : "deep", ms: Date.now() - t0, by: "heuristic" };
  }

  try {
    const chain = await chainFor("fast", null, freeOnly);
    const { res, model } = await complete({
      temperature: 0,
      max_tokens: 60,
      messages: [
        { role: "system", content:
          "Classify the user's message for an AI assistant that can chat OR autonomously use tools " +
          "(files, shell, browser, desktop control).\n" +
          'Reply ONLY with JSON: {"route":"chat"|"agent","tier":"light"|"deep","why":"<5 words"}\n' +
          "route=chat: questions, explanations, conversation — no tools needed.\n" +
          "route=agent: anything requiring files, commands, the internet, or controlling the computer.\n" +
          "tier=light: simple/short. tier=deep: multi-step, complex reasoning, or heavy building." },
        { role: "user", content: String(text).slice(0, 1500) },
      ],
    }, { chain, signal });

    const raw = res.choices?.[0]?.message?.content || "";
    const m = raw.match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : {};
    return {
      route: j.route === "agent" ? "agent" : "chat",
      tier: j.tier === "deep" ? "deep" : "light",
      why: (j.why || "classified").slice(0, 40),
      confidence: 0.85, by: model, ms: Date.now() - t0,
    };
  } catch {
    return h
      ? { ...h, tier: "deep", ms: Date.now() - t0, by: "heuristic-fallback" }
      : { route: "agent", tier: "deep", why: "router failed, defaulting to agent", confidence: 0.4, ms: Date.now() - t0 };
  }
}

/** Model role for a routing decision. */
export function roleFor(decision) {
  if (decision.route === "chat") return decision.tier === "light" ? "fast" : "main";
  return decision.tier === "deep" ? "plan" : "code";
}
