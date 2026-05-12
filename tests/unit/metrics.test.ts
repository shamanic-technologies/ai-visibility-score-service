import { describe, it, expect } from "vitest";
import { aggregate, DEFAULT_WEIGHTS, type ExtractedPrompt } from "../../src/lib/metrics.js";

function p(overrides: Partial<ExtractedPrompt>, idx = 0): ExtractedPrompt {
  return {
    promptIndex: idx,
    promptText: "q",
    responseText: "ans",
    responseLengthChars: 100,
    brandFound: false,
    brandCount: 0,
    brandPosition: null,
    urlFound: false,
    urlCount: 0,
    brandAndUrlCoOccurrence: false,
    maxBrandsInResponse: 0,
    sentiment: "neutral",
    sentimentScore: 0,
    citationUrls: [],
    competitors: [],
    latencyMs: 100,
    tokensInput: 50,
    tokensOutput: 50,
    ...overrides,
  };
}

describe("aggregate metrics — handcrafted 3-prompt fixture", () => {
  // Target brand "Acme" / domain "acme.com"
  // Prompt 0: brand found at position 1 of 3, positive, cites acme.com + b.com, 1 competitor
  // Prompt 1: brand NOT found, 2 competitors, cites c.com, c.com
  // Prompt 2: brand found at position 2 of 4, negative, cites acme.com only, 3 competitors
  const prompts: ExtractedPrompt[] = [
    p(
      {
        responseLengthChars: 200,
        brandFound: true,
        brandCount: 2,
        brandPosition: 1,
        urlFound: true,
        urlCount: 1,
        brandAndUrlCoOccurrence: true,
        maxBrandsInResponse: 3,
        sentiment: "positive",
        sentimentScore: 0.8,
        citationUrls: ["https://acme.com/x", "https://b.com/y"],
        competitors: [
          { name: "B", url: "https://b.com", position: 2, sentiment: "neutral", sentimentScore: 0, citationUrl: "https://b.com/y" },
          { name: "C", url: null, position: 3, sentiment: "neutral", sentimentScore: 0, citationUrl: null },
        ],
      },
      0,
    ),
    p(
      {
        responseLengthChars: 100,
        brandFound: false,
        maxBrandsInResponse: 2,
        citationUrls: ["https://c.com/a", "https://c.com/b"],
        competitors: [
          { name: "B", url: null, position: 1, sentiment: "positive", sentimentScore: 0.5, citationUrl: null },
          { name: "D", url: null, position: 2, sentiment: "neutral", sentimentScore: 0, citationUrl: null },
        ],
      },
      1,
    ),
    p(
      {
        responseLengthChars: 300,
        brandFound: true,
        brandCount: 1,
        brandPosition: 2,
        urlFound: true,
        urlCount: 1,
        brandAndUrlCoOccurrence: true,
        maxBrandsInResponse: 4,
        sentiment: "negative",
        sentimentScore: -0.6,
        citationUrls: ["https://www.acme.com/y"],
        competitors: [
          { name: "B", url: null, position: 1, sentiment: "negative", sentimentScore: -0.3, citationUrl: null },
          { name: "E", url: null, position: 3, sentiment: "neutral", sentimentScore: 0, citationUrl: null },
          { name: "F", url: null, position: 4, sentiment: "neutral", sentimentScore: 0, citationUrl: null },
        ],
      },
      2,
    ),
  ];

  const m = aggregate(prompts, "acme.com", DEFAULT_WEIGHTS);

  it("brand mention count + rate", () => {
    expect(m.brand_mention_count).toBe(2);
    expect(m.brand_mention_rate).toBeCloseTo(2 / 3);
  });

  it("url mention count + rate", () => {
    expect(m.url_mention_count).toBe(2);
    expect(m.url_mention_rate).toBeCloseTo(2 / 3);
  });

  it("brand+url co-occurrence count + rate", () => {
    expect(m.brand_and_url_count).toBe(2);
    expect(m.brand_and_url_rate).toBeCloseTo(2 / 3);
  });

  it("avg position over found prompts", () => {
    expect(m.avg_position).toBeCloseTo(1.5);
  });

  it("position score = mean of (max - pos + 1)/max over found", () => {
    // (3-1+1)/3 = 1.0; (4-2+1)/4 = 0.75 → mean = 0.875
    expect(m.position_score).toBeCloseTo(0.875);
  });

  it("share of voice = brand / (brand + competitor mentions)", () => {
    // brand 2 / (2 + 7 competitor entries) = 2/9
    expect(m.share_of_voice).toBeCloseTo(2 / 9);
  });

  it("citation count + rate match target domain across responses", () => {
    // acme.com cited in p0 + p2 (www.acme.com) = 2
    expect(m.citation_count).toBe(2);
    expect(m.citation_rate).toBeCloseTo(2 / 3);
  });

  it("citation share of voice = brand_citations / total_citations", () => {
    // total = 5 (acme, b, c, c, acme), brand = 2 → 2/5
    expect(m.citation_share_of_voice).toBeCloseTo(2 / 5);
  });

  it("citation opportunities lists non-target domains by descending count", () => {
    expect(m.citation_opportunities).toEqual([
      { domain: "c.com", count: 2 },
      { domain: "b.com", count: 1 },
    ]);
  });

  it("sentiment counts on brand-found prompts only", () => {
    expect(m.positive_count).toBe(1);
    expect(m.neutral_count).toBe(0);
    expect(m.negative_count).toBe(1);
  });

  it("net sentiment = (pos - neg) / brand_mention_count", () => {
    expect(m.net_sentiment).toBeCloseTo(0);
  });

  it("avg sentiment score over found prompts", () => {
    expect(m.avg_sentiment_score).toBeCloseTo((0.8 + -0.6) / 2);
  });

  it("response length splits", () => {
    expect(m.avg_response_length).toBe(Math.round((200 + 100 + 300) / 3));
    expect(m.response_length_when_brand_found).toBe(Math.round((200 + 300) / 2));
    expect(m.response_length_when_brand_not_found).toBe(100);
  });

  it("distinct competitor count across all prompts", () => {
    // B, C, D, E, F = 5
    expect(m.distinct_competitors_count).toBe(5);
  });

  it("top competitors ordered by mention count", () => {
    expect(m.top_competitors[0].name).toBe("b");
    expect(m.top_competitors[0].mention_count).toBe(3);
  });

  it("visibility_score formula matches spec (decimal 0–1 scale)", () => {
    // br=2/3, cit=2/3, pos=0.875, sov=2/9, sent=(0+1)/2=0.5, brAndUrl=2/3
    const expected =
      0.25 * (2 / 3) +
      0.15 * (2 / 3) +
      0.2 * 0.875 +
      0.2 * (2 / 9) +
      0.15 * 0.5 +
      0.05 * (2 / 3);
    expect(m.visibility_score).toBeCloseTo(expected);
    expect(m.visibility_score).toBeGreaterThanOrEqual(0);
    expect(m.visibility_score).toBeLessThanOrEqual(1);
  });
});

describe("edge cases", () => {
  it("share_of_voice returns 0 (not NaN) when total_mentions = 0", () => {
    const m = aggregate([p({ brandFound: false, competitors: [] })], "acme.com", DEFAULT_WEIGHTS);
    expect(m.share_of_voice).toBe(0);
    expect(Number.isNaN(m.share_of_voice)).toBe(false);
  });

  it("position_score returns null when brand never found", () => {
    const m = aggregate([p({ brandFound: false }), p({ brandFound: false })], "acme.com", DEFAULT_WEIGHTS);
    expect(m.position_score).toBeNull();
  });

  it("avg_position returns null when brand never found", () => {
    const m = aggregate([p({ brandFound: false })], "acme.com", DEFAULT_WEIGHTS);
    expect(m.avg_position).toBeNull();
  });

  it("visibility_score clamped to [0, 1] even with extreme weights", () => {
    const huge = {
      brandMentionRate: 99,
      citationRate: 99,
      positionScore: 99,
      shareOfVoice: 99,
      sentiment: 99,
      brandAndUrlRate: 99,
    };
    const m = aggregate(
      [
        p({
          brandFound: true,
          brandPosition: 1,
          maxBrandsInResponse: 1,
          urlFound: true,
          brandAndUrlCoOccurrence: true,
          sentiment: "positive",
          citationUrls: ["https://acme.com/"],
        }),
      ],
      "acme.com",
      huge,
    );
    expect(m.visibility_score).toBe(1);
  });

  it("visibility_score is in [0, 1] for default weights regardless of input", () => {
    const inputs: ExtractedPrompt[][] = [
      [p({})],
      [p({ brandFound: true, brandPosition: 1, maxBrandsInResponse: 1, sentiment: "positive" })],
      [p({ brandFound: true, brandPosition: 1, maxBrandsInResponse: 1, sentiment: "negative" })],
    ];
    for (const ps of inputs) {
      const m = aggregate(ps, "acme.com", DEFAULT_WEIGHTS);
      expect(m.visibility_score).toBeGreaterThanOrEqual(0);
      expect(m.visibility_score).toBeLessThanOrEqual(1);
    }
  });

  it("citation_share_of_voice returns 0 when no citations", () => {
    const m = aggregate([p({})], "acme.com", DEFAULT_WEIGHTS);
    expect(m.citation_share_of_voice).toBe(0);
  });

  it("redistributes positionScore weight when position_score is null (brand found, position unknown)", () => {
    // Brand found but brandPosition always null → position_score is null
    const ps = [
      p({ brandFound: true, brandCount: 1, brandPosition: null, maxBrandsInResponse: 3, sentiment: "positive", sentimentScore: 0.5 }),
    ];
    const m = aggregate(ps, "acme.com", DEFAULT_WEIGHTS);
    expect(m.position_score).toBeNull();
    // Without redistribution, score would lose 20% of potential
    // With redistribution, the 0.20 weight is spread to other components
    // brand_mention_rate = 1.0, other metrics compute normally
    // Score should be higher than if positionScore weight was wasted at 0
    const wastedScore = 0.25 * 1.0 + 0.15 * 0 + 0.20 * 0 + 0.20 * 1.0 + 0.15 * 1.0 + 0.05 * 0;
    expect(m.visibility_score).toBeGreaterThan(wastedScore);
  });
});
