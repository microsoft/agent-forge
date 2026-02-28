/**
 * Domain Registry — extensible domain detection, naming, and slug generation.
 * Extracted from scaffold.ts to decouple domain knowledge from file generation.
 */
import type { Domain } from "../types.js";

// ─── Domain Detection Patterns ───

export const DOMAIN_PATTERNS: Array<{
  category: Domain["category"];
  slug: string;
  title: string;
  keywords: RegExp;
  techExtractor: RegExp;
  applyToGlob: string;
}> = [
  {
    category: "frontend",
    slug: "frontend",
    title: "Frontend",
    keywords: /\b(react(?:js)?|vue(?:\.?js)?|angular|svelte|next\.?js|nuxt|frontend|front[- ]end|tailwind(?:css)?|css[- ]?modules|ui|ux|web ?app|solidjs|astro|remix|vite)\b/i,
    techExtractor: /\b(react(?:js)?|vue(?:\.?js)?|angular|svelte|next\.?js|nuxt|tailwind(?:css)?|sass|scss|css[- ]?modules|shadcn|radix|chakra|material[- ]?ui|vite|remix|astro)\b/gi,
    applyToGlob: "**/*.{ts,tsx,js,jsx,css,scss}",
  },
  {
    category: "backend",
    slug: "backend",
    title: "Backend",
    keywords: /\b(express|fastify|nest\.?js|koa|hapi|django|flask|fastapi|rails|spring|backend|back[- ]end|api|server|rest|graphql|node\.?js|nodejs|dotnet|\.net|gin|echo|fiber|laravel|php)\b/i,
    techExtractor: /\b(express|fastify|nest\.?js|koa|hapi|django|flask|fastapi|rails|spring(?:boot)?|node\.?js|nodejs|dotnet|\.net|gin|echo|fiber|laravel|php|prisma|drizzle|sequelize|typeorm|mongoose|graphql|rest|grpc)\b/gi,
    applyToGlob: "**/*.{ts,js,py,java,go,rb,php}",
  },
  {
    category: "ai",
    slug: "ai",
    title: "AI",
    keywords: /\b(ai|ml|machine[- ]?learning|langchain|llm|openai|anthropic|gpt|claude|llama|hugging[- ]?face|transformer|rag|vector|embedding|agent|crew\.?ai|autogen|semantic[- ]?kernel|lang[- ]?graph)\b/i,
    techExtractor: /\b(langchain|openai|anthropic|llama|hugging[- ]?face|tensorflow|pytorch|scikit[- ]?learn|transformers|crew\.?ai|autogen|semantic[- ]?kernel|lang[- ]?graph|pinecone|chroma|weaviate|qdrant|faiss|rag)\b/gi,
    applyToGlob: "**/*.{py,ts,js,ipynb}",
  },
];

// ─── Business Domain Patterns ───

export const BUSINESS_DOMAIN_PATTERNS: Array<{ pattern: RegExp; term: string }> = [
  { pattern: /\be[- ]?commerce\b/i, term: "ecommerce" },
  { pattern: /\bonline[- ]?shop(?:ping)?\b/i, term: "ecommerce" },
  { pattern: /\bmarketplace\b/i, term: "marketplace" },
  { pattern: /\bhealthcare\b/i, term: "healthcare" },
  { pattern: /\bfintech\b/i, term: "fintech" },
  { pattern: /\bblog(?:ging)?\b/i, term: "blog" },
  { pattern: /\bcms\b/i, term: "cms" },
  { pattern: /\bchat(?:bot)?\b/i, term: "chat" },
  { pattern: /\bdashboard\b/i, term: "dashboard" },
  { pattern: /\banalytics\b/i, term: "analytics" },
  { pattern: /\binventory\b/i, term: "inventory" },
  { pattern: /\bcrm\b/i, term: "crm" },
  { pattern: /\berp\b/i, term: "erp" },
  { pattern: /\bsaas\b/i, term: "saas" },
  { pattern: /\bsocial[- ]?media\b/i, term: "social" },
  { pattern: /\biot\b/i, term: "iot" },
  { pattern: /\bedtech\b/i, term: "edtech" },
  { pattern: /\bpayment\b/i, term: "payment" },
  { pattern: /\bbooking\b/i, term: "booking" },
  { pattern: /\bscheduling\b/i, term: "scheduling" },
  { pattern: /\btask[- ]?manag/i, term: "taskmanager" },
  { pattern: /\bportfolio\b/i, term: "portfolio" },
];

// ─── Stop Words ───

export const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "with", "using", "for", "of", "to", "in",
  "on", "at", "by", "from", "as", "is", "it", "its", "that", "this",
  "be", "are", "was", "were", "been", "being", "have", "has", "had",
  "do", "does", "did", "will", "would", "shall", "should", "may",
  "can", "could", "might", "must", "need", "also", "just", "very",
  "application", "app", "project", "based", "platform", "system",
  "backend", "frontend", "front", "end", "back", "server", "client",
  "net", "python", "java", "ruby", "php", "go", "rust",
  "ai", "ml", "llm", "llms", "gpt", "multiagent",
  "connect", "drive", "driven", "supported", "suppported", "wil",
  "build", "create", "make", "manage", "run", "running", "use",
  "implement", "service", "services",
  "framework", "workflow", "library", "tool", "tools",
]);

// ─── Framework Priority Map ───

export const FRAMEWORK_PRIORITY: Record<string, string> = {
  // Frontend
  "react": "reactjs", "reactjs": "reactjs",
  "next.js": "nextjs", "nextjs": "nextjs",
  "vue": "vue", "vuejs": "vue",
  "angular": "angular",
  "svelte": "svelte",
  "nuxt": "nuxt",
  "remix": "remix",
  "astro": "astro",
  // Backend
  "fastapi": "fastapi",
  "express": "express",
  "nestjs": "nestjs", "nest.js": "nestjs",
  "django": "django",
  "flask": "flask",
  "rails": "rails",
  "spring": "spring", "springboot": "spring",
  "laravel": "laravel",
  ".net": "dotnet", "dotnet": "dotnet",
  "gin": "gin",
  "fiber": "fiber",
  "koa": "koa",
  "hapi": "hapi",
  "fastify": "fastify",
  // AI
  "langchain": "langchain",
  "langgraph": "langgraph", "lang-graph": "langgraph",
  "crewai": "crewai", "crew.ai": "crewai",
  "autogen": "autogen",
  "semantic-kernel": "semantic-kernel",
};

// ─── Functions ───

/**
 * Decompose a description into detected domains.
 * Returns at least one domain ("general" fallback).
 */
export function decomposeDomains(description: string): Domain[] {
  const domains: Domain[] = [];

  for (const pattern of DOMAIN_PATTERNS) {
    if (pattern.keywords.test(description)) {
      const matches = description.match(pattern.techExtractor) ?? [];
      const techStack = [...new Set(matches.map((m) => m.toLowerCase()))];
      domains.push({
        slug: pattern.slug,
        title: pattern.title,
        category: pattern.category,
        techStack,
        applyToGlob: pattern.applyToGlob,
      });
    }
  }

  if (domains.length === 0) {
    domains.push({
      slug: "general",
      title: slugToTitle(deriveProjectName(description)),
      category: "general",
      techStack: [],
      applyToGlob: "**/*",
    });
  }

  return domains;
}

/**
 * Derive an agent file name from the domain's detected tech stack.
 * Uses the primary framework name as the agent slug.
 */
export function deriveDomainAgentName(domain: Domain): string {
  for (const tech of domain.techStack) {
    const normalized = tech.toLowerCase();
    if (FRAMEWORK_PRIORITY[normalized]) {
      return FRAMEWORK_PRIORITY[normalized];
    }
  }
  return domain.slug;
}

/**
 * Derive a short, meaningful project name from a verbose description.
 * Prioritizes business domain terms over generic architecture/tech terms.
 */
export function deriveProjectName(description: string): string {
  // Step 1: Extract business domain terms
  const domainTerms: string[] = [];
  const seenDomains = new Set<string>();
  for (const { pattern, term } of BUSINESS_DOMAIN_PATTERNS) {
    if (pattern.test(description) && !seenDomains.has(term)) {
      seenDomains.add(term);
      domainTerms.push(term);
    }
  }

  // Step 2: Normalize and extract remaining meaningful words
  let normalized = description.toLowerCase().replace(/full[- ]?stack/gi, "fullstack");
  normalized = normalized.replace(/e[- ]commerce/gi, "ecommerce");
  normalized = normalized.replace(/multi[- ]agent(?:ic)?/gi, "multiagent");

  const words = normalized
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/[\s-]+/)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w));

  const seen = new Set<string>(seenDomains);
  const techTerms: string[] = [];
  for (const word of words) {
    const key = word
      .replace(/^reactjs$/, "react")
      .replace(/^nodejs$/, "node")
      .replace(/^tailwindcss$/, "tailwind")
      .replace(/^vuejs$/, "vue")
      .replace(/^nextjs$/, "next");
    if (!seen.has(key)) {
      seen.add(key);
      techTerms.push(key);
    }
  }

  // Step 3: Combine — domain terms first, then fill with tech terms
  const maxTerms = 3;
  const maxTech = Math.max(1, maxTerms - domainTerms.length);
  const combined = [...domainTerms, ...techTerms.slice(0, maxTech)];

  const slug = combined.join("-").replace(/-$/, "");
  return slug || toKebabCase(description);
}

/**
 * Merge multiple applyTo globs into one combined glob.
 */
export function mergeGlobs(globs: string[]): string {
  const extensions = new Set<string>();
  for (const glob of globs) {
    const match = glob.match(/\*\*\/\*\.\{?([^}]+)\}?$/);
    if (match) {
      for (const ext of match[1].split(",")) {
        extensions.add(ext.trim());
      }
    }
  }
  if (extensions.size === 0) return "**/*";
  const sorted = [...extensions].sort();
  return sorted.length === 1 ? `**/*.${sorted[0]}` : `**/*.{${sorted.join(",")}}`;
}

export function slugToTitle(slug: string): string {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function toKebabCase(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}
