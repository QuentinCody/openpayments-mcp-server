import { describe, expect, it } from "vitest";
import { decodeXmlEntities, parseJats, toPassages } from "./jats";

const FIXTURE = `<?xml version="1.0"?>
<article>
  <front>
    <article-meta>
      <title-group>
        <article-title>Rilotumumab in MET&#x2010;positive gastric cancer</article-title>
      </title-group>
      <abstract>
        <sec>
          <title>Background</title>
          <p>MET overexpression predicts response to <italic>rilotumumab</italic>.</p>
        </sec>
        <sec>
          <title>Results</title>
          <p>Median overall survival was 8.8 months (95% CI 7.7&#8211;10.2).</p>
        </sec>
      </abstract>
    </article-meta>
  </front>
  <body>
    <sec sec-type="methods">
      <title>Methods</title>
      <p>We recruited adults aged &gt;=18 years with unresectable disease<xref ref-type="bibr" rid="b1">1</xref>.</p>
      <sec>
        <title>Eligibility</title>
        <p>ECOG performance status of 0 or 1, MET-positive tumours.</p>
      </sec>
    </sec>
    <sec sec-type="results">
      <title>Results</title>
      <p>Survival was shorter in the rilotumumab group than the placebo group.</p>
      <table-wrap id="t1">
        <label>Table 1</label>
        <caption><p>Overall survival by arm</p></caption>
        <table>
          <thead><tr><th>Arm</th><th>Median OS (months)</th></tr></thead>
          <tbody>
            <tr><td>Rilotumumab</td><td>8.8</td></tr>
            <tr><td>Placebo</td><td>10.7</td></tr>
          </tbody>
        </table>
      </table-wrap>
    </sec>
  </body>
</article>`;

describe("decodeXmlEntities", () => {
  it("decodes named, decimal, and hex entities", () => {
    expect(decodeXmlEntities("a &amp; b &#8211; c &#x2010; d")).toBe("a & b – c ‐ d");
  });

  it("leaves unknown entities intact", () => {
    expect(decodeXmlEntities("&bogus;")).toBe("&bogus;");
  });
});

describe("parseJats", () => {
  const doc = parseJats(FIXTURE);

  it("extracts the article title", () => {
    expect(doc.articleTitle).toBe("Rilotumumab in MET‐positive gastric cancer");
  });

  it("extracts abstract sections with titles", () => {
    expect(doc.abstract).toHaveLength(2);
    expect(doc.abstract[0].path).toEqual(["Background"]);
    expect(doc.abstract[0].paragraphs[0]).toContain("rilotumumab");
    expect(doc.abstract[1].paragraphs[0]).toContain("8.8 months (95% CI 7.7–10.2)");
  });

  it("extracts nested body sections with the full title chain and sec-type", () => {
    const eligibility = doc.body.find((s) => s.path.includes("Eligibility"));
    expect(eligibility?.path).toEqual(["Methods", "Eligibility"]);
    expect(eligibility?.secType).toBe("methods");
    expect(eligibility?.paragraphs[0]).toContain("ECOG performance status");
  });

  it("drops xref content but keeps surrounding text", () => {
    const methods = doc.body.find((s) => s.path.join() === "Methods");
    expect(methods?.paragraphs[0]).toBe(
      "We recruited adults aged >=18 years with unresectable disease.",
    );
  });

  it("linearizes tables to tab-delimited rows with caption", () => {
    expect(doc.tables).toHaveLength(1);
    const t = doc.tables[0];
    expect(t.caption).toContain("Overall survival by arm");
    expect(t.rows).toContain("Arm\tMedian OS (months)");
    expect(t.rows).toContain("Rilotumumab\t8.8");
    expect(t.path).toEqual(["Results"]);
  });

  it("does not throw on malformed nesting", () => {
    expect(() => parseJats("<body><sec><p>text</sec></p></body>")).not.toThrow();
  });
});

describe("toPassages", () => {
  it("emits abstract, body, and table passages with section paths", () => {
    const passages = toPassages(parseJats(FIXTURE));
    const kinds = new Set(passages.map((p) => p.kind));
    expect(kinds).toEqual(new Set(["abstract", "body", "table"]));
    const table = passages.find((p) => p.kind === "table");
    expect(table?.text).toContain("Rilotumumab\t8.8");
    const body = passages.find((p) => p.path.join("/") === "Methods/Eligibility");
    expect(body?.text).toContain("MET-positive tumours");
  });

  it("chunks long sections with overlap and increasing offsets", () => {
    const long = `<article><body><sec><title>Long</title><p>${"word ".repeat(600)}</p></sec></body></article>`;
    const passages = toPassages(parseJats(long), { size: 1000, overlap: 100 });
    expect(passages.length).toBeGreaterThan(1);
    for (let i = 1; i < passages.length; i++) {
      expect(passages[i].start).toBeGreaterThan(passages[i - 1].start);
    }
    // Overlap: the tail of chunk 0 appears at the head of chunk 1.
    expect(passages[1].text.startsWith(passages[0].text.slice(-100))).toBe(true);
  });
});
