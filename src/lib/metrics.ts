import type { VisibilityWeights } from "../db/schema.js";

export const DEFAULT_WEIGHTS: VisibilityWeights = {
  brandMentionRate: 0.25,
  citationRate: 0.15,
  positionScore: 0.2,
  shareOfVoice: 0.2,
  sentiment: 0.15,
  brandAndUrlRate: 0.05,
};

export interface ExtractedCompetitor {
  name: string;
  url: string | null;
  position: number;
  sentiment: "positive" | "neutral" | "negative";
  sentimentScore: number;
  citationUrl: string | null;
}

export interface ExtractedPrompt {
  promptIndex: number;
  promptText: string;
  responseText: string;
  responseLengthChars: number;
  brandFound: boolean;
  brandCount: number;
  brandPosition: number | null;
  urlFound: boolean;
  urlCount: number;
  brandAndUrlCoOccurrence: boolean;
  maxBrandsInResponse: number;
  sentiment: "positive" | "neutral" | "negative";
  sentimentScore: number;
  citationUrls: string[];
  competitors: ExtractedCompetitor[];
  latencyMs: number;
  tokensInput: number;
  tokensOutput: number;
}

export interface TopCompetitor {
  name: string;
  url: string | null;
  mention_count: number;
  avg_position: number | null;
  share_of_voice: number;
  net_sentiment: number;
}

export interface CitationOpportunity {
  domain: string;
  count: number;
}

export interface AggregateMetrics {
  brand_mention_count: number;
  brand_mention_rate: number;
  url_mention_count: number;
  url_mention_rate: number;
  brand_and_url_count: number;
  brand_and_url_rate: number;
  avg_position: number | null;
  position_score: number | null;
  share_of_voice: number;
  weighted_share_of_voice: number;
  citation_count: number;
  citation_rate: number;
  citation_share_of_voice: number;
  citation_opportunities: CitationOpportunity[];
  positive_count: number;
  neutral_count: number;
  negative_count: number;
  net_sentiment: number;
  avg_sentiment_score: number | null;
  avg_response_length: number;
  response_length_when_brand_found: number | null;
  response_length_when_brand_not_found: number | null;
  distinct_competitors_count: number;
  top_competitors: TopCompetitor[];
  visibility_score: number;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function safeRate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

/** Extract registered/eTLD-like host from a URL. Returns lowercase host without leading "www.". */
export function urlHost(url: string): string | null {
  try {
    const u = new URL(url);
    return u.host.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

export function aggregate(
  prompts: ExtractedPrompt[],
  targetDomain: string,
  weights: VisibilityWeights,
): AggregateMetrics {
  const N = prompts.length;
  const targetHost = targetDomain.replace(/^https?:\/\//i, "").replace(/^www\./i, "").toLowerCase();

  const brandFoundPrompts = prompts.filter((p) => p.brandFound);
  const brand_mention_count = brandFoundPrompts.length;
  const brand_mention_rate = safeRate(brand_mention_count, N);

  const urlFoundPrompts = prompts.filter((p) => p.urlFound);
  const url_mention_count = urlFoundPrompts.length;
  const url_mention_rate = safeRate(url_mention_count, N);

  const brand_and_url_count = prompts.filter((p) => p.brandAndUrlCoOccurrence).length;
  const brand_and_url_rate = safeRate(brand_and_url_count, N);

  const brandPositions = brandFoundPrompts
    .map((p) => p.brandPosition)
    .filter((x): x is number => x !== null);
  const avg_position = mean(brandPositions);

  const positionContributions = brandFoundPrompts
    .filter((p) => p.brandPosition !== null && p.maxBrandsInResponse > 0)
    .map((p) => (p.maxBrandsInResponse - p.brandPosition! + 1) / p.maxBrandsInResponse);
  const position_score = positionContributions.length === 0 ? null : mean(positionContributions);

  const totalCompetitorMentions = prompts.reduce((sum, p) => sum + p.competitors.length, 0);
  const totalAllMentions = brand_mention_count + totalCompetitorMentions;
  const share_of_voice = safeRate(brand_mention_count, totalAllMentions);

  let weightedTarget = 0;
  let weightedAll = 0;
  for (const p of prompts) {
    if (p.brandFound && p.brandPosition !== null) {
      weightedTarget += 1 / p.brandPosition;
      weightedAll += 1 / p.brandPosition;
    }
    for (const c of p.competitors) {
      if (c.position > 0) weightedAll += 1 / c.position;
    }
  }
  const weighted_share_of_voice = safeRate(weightedTarget, weightedAll);

  let brand_citation_count = 0;
  let total_citations = 0;
  const competitorDomainCitations = new Map<string, number>();
  for (const p of prompts) {
    for (const url of p.citationUrls) {
      total_citations++;
      const host = urlHost(url);
      if (!host) continue;
      if (host === targetHost || host.endsWith(`.${targetHost}`)) {
        brand_citation_count++;
      } else {
        competitorDomainCitations.set(host, (competitorDomainCitations.get(host) ?? 0) + 1);
      }
    }
  }
  const citation_count = brand_citation_count;
  const citation_rate = safeRate(citation_count, N);
  const citation_share_of_voice = safeRate(citation_count, total_citations);
  const citation_opportunities: CitationOpportunity[] = [...competitorDomainCitations.entries()]
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count);

  const positive_count = brandFoundPrompts.filter((p) => p.sentiment === "positive").length;
  const negative_count = brandFoundPrompts.filter((p) => p.sentiment === "negative").length;
  const neutral_count = brandFoundPrompts.filter((p) => p.sentiment === "neutral").length;
  const net_sentiment = safeRate(positive_count - negative_count, brand_mention_count);
  const avg_sentiment_score = mean(brandFoundPrompts.map((p) => p.sentimentScore));

  const avg_response_length =
    N === 0 ? 0 : Math.round(prompts.reduce((sum, p) => sum + p.responseLengthChars, 0) / N);
  const foundLengths = brandFoundPrompts.map((p) => p.responseLengthChars);
  const notFoundLengths = prompts.filter((p) => !p.brandFound).map((p) => p.responseLengthChars);
  const response_length_when_brand_found =
    foundLengths.length === 0 ? null : Math.round(mean(foundLengths)!);
  const response_length_when_brand_not_found =
    notFoundLengths.length === 0 ? null : Math.round(mean(notFoundLengths)!);

  const competitorAgg = new Map<
    string,
    {
      url: string | null;
      count: number;
      positions: number[];
      positive: number;
      negative: number;
    }
  >();
  for (const p of prompts) {
    for (const c of p.competitors) {
      const key = c.name.trim().toLowerCase();
      const cur = competitorAgg.get(key) ?? {
        url: null,
        count: 0,
        positions: [],
        positive: 0,
        negative: 0,
      };
      cur.count++;
      if (c.url && !cur.url) cur.url = c.url;
      if (c.position > 0) cur.positions.push(c.position);
      if (c.sentiment === "positive") cur.positive++;
      if (c.sentiment === "negative") cur.negative++;
      competitorAgg.set(key, cur);
    }
  }

  const distinct_competitors_count = competitorAgg.size;
  const top_competitors: TopCompetitor[] = [...competitorAgg.entries()]
    .map(([name, v]) => ({
      name,
      url: v.url,
      mention_count: v.count,
      avg_position: mean(v.positions),
      share_of_voice: safeRate(v.count, totalAllMentions),
      net_sentiment: safeRate(v.positive - v.negative, v.count),
    }))
    .sort((a, b) => b.mention_count - a.mention_count)
    .slice(0, 10);

  const sentimentNormalized = (net_sentiment + 1) / 2;
  const positionScoreForFormula = position_score ?? 0;
  const raw =
    100 *
    (weights.brandMentionRate * brand_mention_rate +
      weights.citationRate * citation_rate +
      weights.positionScore * positionScoreForFormula +
      weights.shareOfVoice * share_of_voice +
      weights.sentiment * sentimentNormalized +
      weights.brandAndUrlRate * brand_and_url_rate);
  const visibility_score = Math.max(0, Math.min(100, raw));

  return {
    brand_mention_count,
    brand_mention_rate,
    url_mention_count,
    url_mention_rate,
    brand_and_url_count,
    brand_and_url_rate,
    avg_position,
    position_score,
    share_of_voice,
    weighted_share_of_voice,
    citation_count,
    citation_rate,
    citation_share_of_voice,
    citation_opportunities,
    positive_count,
    neutral_count,
    negative_count,
    net_sentiment,
    avg_sentiment_score,
    avg_response_length,
    response_length_when_brand_found,
    response_length_when_brand_not_found,
    distinct_competitors_count,
    top_competitors,
    visibility_score,
  };
}
